import * as vscode from "vscode";
import Anthropic from "@anthropic-ai/sdk";
import { AcpClient, AcpProcessError, AcpRequestError } from "./acpClient";
import { Complexity, Orchestrator } from "./orchestrator";
import { getWebviewHtml } from "./webview/panel";

/** Encapsulates one Grok Build session: the webview panel, the ACP
 * subprocess, and the orchestrator wired to both. One instance per "Grok
 * Build: Start Session" invocation; a second invocation while one is open
 * just reveals the existing panel rather than starting a duplicate process. */
class GrokBuildSession {
  private panel: vscode.WebviewPanel;
  private acp: AcpClient | undefined;
  private orchestrator: Orchestrator | undefined;
  private sessionId: string | undefined;
  private lastRequestText = new Map<string, string>();
  private requestCounter = 0;
  private disposed = false;

  constructor(
    private readonly cwd: string,
    private readonly anthropic: Anthropic,
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
    this.acp.on("processError", (err: AcpProcessError) => {
      this.post({ type: "error", message: describeAcpProcessError(err) });
    });
    this.acp.on("exit", (code, signal) => {
      if (this.disposed) return;
      // Unexpected exit while the panel is still open, surface it and let
      // the user decide whether to restart via a fresh command invocation
      // (kept simple for v1).
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
      this.orchestrator = new Orchestrator({ anthropic: this.anthropic, grok: this.acp, sessionId: this.sessionId });
      this.wireOrchestrator(this.orchestrator);

      if (!init.authMethods.some((m) => m.id === "xai.api_key")) {
        // session/new still succeeded (e.g. a prior `grok login`), but no
        // XAI_API_KEY is set, not fatal, just worth a heads-up since the
        // brief explicitly wants auth problems surfaced, not swallowed.
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

  private wireOrchestrator(orchestrator: Orchestrator): void {
    orchestrator.on("classified", (c) => {
      this.post({ type: "classified", requestId: this.currentRequestId, complexity: c.complexity, reasoning: c.reasoning });
    });
    orchestrator.on("planUpdated", (p) => {
      this.post({ type: "planUpdated", requestId: this.currentRequestId, subtasks: p.subtasks });
    });
    orchestrator.on("stepStarted", (s) => {
      this.post({ type: "stepStarted", requestId: this.currentRequestId, index: s.index, instruction: s.instruction });
    });
    orchestrator.on("stepCompleted", (s) => {
      this.post({
        type: "stepCompleted",
        requestId: this.currentRequestId,
        index: s.index,
        instruction: s.instruction,
        stopReason: s.stopReason,
        summary: s.summary,
      });
    });
    orchestrator.on("done", (d) => {
      this.post({ type: "done", requestId: this.currentRequestId, complexity: d.complexity, totalSteps: d.totalSteps });
    });
  }

  /** Set right before invoking orchestrator.handleRequest so the event
   * listeners above (registered once) know which requestId to tag outgoing
   * messages with. Fine for v1's single-request-at-a-time model, no need
   * for concurrent request handling yet. */
  private currentRequestId = "";

  private async handleWebviewMessage(msg: { type: string; text?: string; requestId?: string }): Promise<void> {
    if (!this.orchestrator) {
      this.post({ type: "error", message: "Grok Build session isn't ready yet." });
      return;
    }

    if (msg.type === "submit" && msg.text) {
      const requestId = String(++this.requestCounter);
      this.lastRequestText.set(requestId, msg.text);
      this.currentRequestId = requestId;
      this.post({ type: "userMessage", requestId, text: msg.text });
      await this.runOrchestrator(msg.text, requestId);
    } else if (msg.type === "escalate" && msg.requestId) {
      const text = this.lastRequestText.get(msg.requestId);
      if (!text) return;
      this.currentRequestId = msg.requestId;
      await this.runOrchestrator(text, msg.requestId, { forceComplexity: "complex" });
    }
  }

  private async runOrchestrator(text: string, requestId: string, opts?: { forceComplexity: Complexity }): Promise<void> {
    try {
      await this.orchestrator!.handleRequest(text, opts);
    } catch (err) {
      this.post({ type: "error", requestId, message: describeOrchestratorError(err) });
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

function describeOrchestratorError(err: unknown): string {
  if (err instanceof AcpRequestError) {
    if (err.isAuthRequired) {
      return "Grok Build isn't authenticated. Run `grok login` or set XAI_API_KEY, then restart the session.";
    }
    if (err.upstreamHttpStatus) {
      return `Grok Build's upstream API returned HTTP ${err.upstreamHttpStatus}: ${err.message}`;
    }
    return `Grok Build error: ${err.message}`;
  }
  if (err instanceof Anthropic.AuthenticationError) {
    return "ANTHROPIC_API_KEY is missing or invalid, Fable 5 orchestration can't run without it.";
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

  const configuredKey = vscode.workspace.getConfiguration("grokBuild").get<string>("anthropicApiKey");
  if (!process.env.ANTHROPIC_API_KEY && !configuredKey) {
    vscode.window.showErrorMessage(
      'ANTHROPIC_API_KEY is not set. Set it in your environment, or set the "grokBuild.anthropicApiKey" setting, then try again.',
    );
    return;
  }
  const anthropic = new Anthropic(configuredKey ? { apiKey: configuredKey } : undefined);

  const session = new GrokBuildSession(workspaceFolder.uri.fsPath, anthropic, () => {
    if (activeSession === session) activeSession = undefined;
  });
  activeSession = session;

  await session.start();
}
