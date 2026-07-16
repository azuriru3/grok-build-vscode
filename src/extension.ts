import * as vscode from "vscode";
import { AcpClient, AcpProcessError, AcpRequestError, summarizeSessionUpdate } from "./acpClient";
import { getWebviewHtml } from "./webview/panel";

/** Encapsulates one Grok Build session: the webview panel and the ACP
 * subprocess talking to it. One instance per "Grok Build: Start Session"
 * invocation; a second invocation while one is open just reveals the
 * existing panel rather than starting a duplicate process. */
class GrokBuildSession {
  private panel: vscode.WebviewPanel;
  private acp: AcpClient | undefined;
  private sessionId: string | undefined;
  private requestCounter = 0;
  private disposed = false;

  constructor(
    private readonly cwd: string,
    private readonly onDisposed: () => void,
  ) {
    this.panel = vscode.window.createWebviewPanel("grokBuild", "Grok Build", vscode.ViewColumn.Beside, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    this.panel.webview.html = getWebviewHtml(this.panel.webview);
    this.panel.onDidDispose(() => this.dispose());
    this.panel.webview.onDidReceiveMessage((msg) => this.handleWebviewMessage(msg));
  }

  reveal(): void {
    this.panel.reveal();
  }

  async start(): Promise<void> {
    await this.spawnAndInitialize();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    void this.acp?.stop();
    this.onDisposed();
  }

  private async spawnAndInitialize(): Promise<void> {
    this.acp = new AcpClient({ cwd: this.cwd });

    this.acp.on("rawMessage", (payload) => this.post({ type: "raw", payload }));
    this.acp.on("sessionUpdate", (evt) => {
      const summary = summarizeSessionUpdate(evt.update);
      if (summary) this.post({ type: "agentUpdate", text: summary });
    });
    this.acp.on("processError", (err: AcpProcessError) => {
      this.post({ type: "error", message: describeAcpProcessError(err) });
    });
    this.acp.on("exit", (code, signal) => {
      if (this.disposed) return;
      this.post({
        type: "error",
        message: `Grok Build process exited unexpectedly (code=${code}, signal=${signal}). Run "Grok Build: Start Session" again to restart.`,
      });
    });

    this.acp.start();

    try {
      const init = await this.acp.initialize();
      const session = await this.acp.newSession();
      this.sessionId = session.sessionId;

      if (!init.authMethods.some((m) => m.id === "xai.api_key")) {
        this.post({
          type: "error",
          message:
            "Heads up: XAI_API_KEY isn't set in this environment. If Grok Build isn't logged in either " +
            "(no prior `grok login`), requests will fail with an authentication error.",
        });
      }
    } catch (err) {
      this.post({ type: "error", message: describeStartupError(err) });
    }
  }

  private async handleWebviewMessage(msg: { type: string; text?: string }): Promise<void> {
    if (msg.type !== "submit" || !msg.text) return;
    if (!this.acp || !this.sessionId) {
      this.post({ type: "error", message: "Grok Build session isn't ready yet." });
      return;
    }

    const requestId = String(++this.requestCounter);
    this.post({ type: "userMessage", requestId, text: msg.text });

    try {
      const result = await this.acp.prompt(this.sessionId, msg.text);
      this.post({ type: "done", requestId, stopReason: result.stopReason });
    } catch (err) {
      this.post({ type: "error", requestId, message: describePromptError(err) });
    }
  }

  private post(msg: unknown): void {
    if (!this.disposed) {
      void this.panel.webview.postMessage(msg);
    }
  }
}

function describeAcpProcessError(err: AcpProcessError): string {
  return err.message; // already includes the install command for ENOENT
}

function describeStartupError(err: unknown): string {
  if (err instanceof AcpRequestError && err.isAuthRequired) {
    return (
      "Grok Build isn't authenticated. Either run `grok login` in a terminal (opens a browser), " +
      'or set XAI_API_KEY in this environment and restart the session ("Grok Build: Start Session").'
    );
  }
  if (err instanceof AcpProcessError) {
    return describeAcpProcessError(err);
  }
  return `Failed to start Grok Build session: ${err instanceof Error ? err.message : String(err)}`;
}

function describePromptError(err: unknown): string {
  if (err instanceof AcpRequestError) {
    if (err.isAuthRequired) {
      return "Grok Build isn't authenticated. Run `grok login` or set XAI_API_KEY, then restart the session.";
    }
    if (err.upstreamHttpStatus) {
      return `Grok Build's upstream API returned HTTP ${err.upstreamHttpStatus}: ${err.message}`;
    }
    return `Grok Build error: ${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}

let activeSession: GrokBuildSession | undefined;

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("grokBuild.startSession", () => {
      void startOrRevealSession();
    }),
  );
}

export function deactivate(): void {
  activeSession?.dispose();
  activeSession = undefined;
}

async function startOrRevealSession(): Promise<void> {
  if (activeSession) {
    activeSession.reveal();
    return;
  }

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    vscode.window.showErrorMessage("Grok Build: open a folder or workspace first.");
    return;
  }

  const session = new GrokBuildSession(workspaceFolder.uri.fsPath, () => {
    if (activeSession === session) activeSession = undefined;
  });
  activeSession = session;

  await session.start();
}
