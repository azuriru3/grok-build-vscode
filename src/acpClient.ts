/**
 * ACP client for `grok agent stdio`.
 *
 * Shapes here come from docs/ACP-NOTES.md, a mix of live-captured traffic
 * (initialize, session/new, session/prompt including a real billing-error
 * response) and the public spec at agentclientprotocol.com for the parts
 * that were never exercised live (a successful tool_call/diff sequence).
 *
 * Confirmed live: xAI's implementation sends `session/update.sessionUpdate`
 * values the spec's prose docs omit but its v1 schema defines
 * (`available_commands_update`, `user_message_chunk`; the schema has 11
 * variants, the prompt-turn docs page lists 5), plus a family of `_x.ai/*`
 * custom notifications. Both namespaces are therefore treated as open,
 * unknown values are surfaced generically rather than dropped or thrown on.
 *
 * No VS Code imports in this file by design, it should be usable/testable
 * standalone.
 */

import { ChildProcessWithoutNullStreams, spawn } from "child_process";
import { EventEmitter } from "events";
import * as readline from "readline";

export interface McpServerConfig {
  name: string;
  command: string;
  args: string[];
  env: string[];
}

export interface AcpClientOptions {
  /** Absolute path to the workspace root; passed as both cwd for the
   * subprocess and the ACP `cwd` param. */
  cwd: string;
  /** Path to the grok binary. Defaults to "grok" (resolved via PATH). */
  grokBinPath?: string;
  /** Per-request timeout in ms. session/prompt can legitimately run for
   * minutes, so this should stay generous, the caller can layer a shorter
   * "connection alive" check separately if needed. */
  requestTimeoutMs?: number;
}

export interface JsonRpcErrorShape {
  code: number;
  message: string;
  data?: unknown;
}

/** Thrown when a JSON-RPC request comes back with an `error` field. */
export class AcpRequestError extends Error {
  code: number;
  data?: unknown;
  constructor(err: JsonRpcErrorShape) {
    super(err.message);
    this.name = "AcpRequestError";
    this.code = err.code;
    this.data = err.data;
  }

  /** Local auth-state error observed live: code -32000, "Authentication required". */
  get isAuthRequired(): boolean {
    return this.code === -32000;
  }

  /** Upstream xAI API error surfaced through a wrapped -32603, observed live
   * for a billing/credits failure. `data` carries `{message, http_status}`
   * when this shape applies, callers should check defensively. */
  get upstreamHttpStatus(): number | undefined {
    if (this.data && typeof this.data === "object" && "http_status" in (this.data as object)) {
      const v = (this.data as { http_status?: unknown }).http_status;
      return typeof v === "number" ? v : undefined;
    }
    return undefined;
  }
}

/** Raised for process-level failures: binary missing, spawn failure, unexpected exit. */
export class AcpProcessError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "AcpProcessError";
  }
}

export interface InitializeResult {
  protocolVersion: number;
  agentCapabilities: Record<string, unknown>;
  authMethods: Array<{ id: string; name: string; description?: string }>;
  _meta?: Record<string, unknown>;
}

export interface NewSessionResult {
  sessionId: string;
  models?: { currentModelId: string; availableModels: unknown[] };
  _meta?: Record<string, unknown>;
}

export interface PromptResult {
  /** Documented enum plus "error", which was observed live via the
   * _x.ai/session/prompt_complete notification (not the direct RPC result,
   * a failed prompt more often surfaces via AcpRequestError instead). */
  stopReason: "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled" | "error" | string;
}

/** A session/update notification, kept as open/passthrough on purpose, see
 * file header. `sessionUpdate` narrows known shapes but unknown ones must
 * still flow through with all their original fields intact. */
export interface SessionUpdateEvent {
  sessionId: string;
  update: { sessionUpdate: string } & Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

/** Any JSON-RPC notification the agent sends that isn't `session/update`.
 * Live traffic showed several `_x.ai/*`-namespaced ones
 * (mcp/servers_updated, mcp_initialized, queue/changed, session_notification,
 * session/prompt_complete) with no public documentation, surfaced generically. */
export interface RawNotificationEvent {
  method: string;
  params: unknown;
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Events emitted:
 *  - "sessionUpdate" (SessionUpdateEvent)
 *  - "notification" (RawNotificationEvent), anything method !== "session/update"
 *  - "rawMessage" (unknown), every parsed JSON-RPC message, in/out, for the
 *    "raw JSON collapsed behind a toggle" UI requirement
 *  - "exit" (code: number | null, signal: string | null)
 *  - "processError" (AcpProcessError)
 */
export class AcpClient extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private readonly requestTimeoutMs: number;
  private stdoutBuffer = "";

  constructor(private readonly opts: AcpClientOptions) {
    super();
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 5 * 60_000;
  }

  /** Spawns `grok agent stdio`. Throws AcpProcessError synchronously-ish
   * (on next tick) if the binary can't be found (ENOENT). */
  start(): void {
    if (this.proc) {
      throw new AcpProcessError("AcpClient.start() called while already running");
    }
    const bin = this.opts.grokBinPath ?? "grok";
    const child = spawn(bin, ["agent", "stdio"], {
      cwd: this.opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc = child;

    child.on("error", (err: NodeJS.ErrnoException) => {
      const wrapped =
        err.code === "ENOENT"
          ? new AcpProcessError(
              "grok binary not found. Install it with: curl -fsSL https://x.ai/cli/install.sh | bash",
              err,
            )
          : new AcpProcessError(`Failed to spawn grok agent stdio: ${err.message}`, err);
      this.emit("processError", wrapped);
    });

    child.on("exit", (code, signal) => {
      this.rejectAllPending(new AcpProcessError(`grok agent stdio exited (code=${code}, signal=${signal})`));
      this.proc = null;
      this.emit("exit", code, signal);
    });

    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (line) => this.handleLine(line));

    child.stderr.on("data", (chunk: Buffer) => {
      // grok's own stderr (process logs, not protocol traffic), surfaced
      // as a notification-shaped event so the UI can log it in the raw pane.
      this.emit("notification", { method: "_process/stderr", params: { text: chunk.toString("utf8") } } satisfies RawNotificationEvent);
    });
  }

  /** Graceful stop: closes stdin, gives the process a moment to exit, then
   * SIGKILLs if it hasn't. Safe to call if already stopped. */
  async stop(graceMs = 3000): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    this.rejectAllPending(new AcpProcessError("AcpClient stopped"));
    await new Promise<void>((resolve) => {
      const onExit = () => resolve();
      proc.once("exit", onExit);
      proc.stdin.end();
      setTimeout(() => {
        if (this.proc === proc) {
          proc.kill("SIGKILL");
        }
        resolve();
      }, graceMs);
    });
  }

  get isRunning(): boolean {
    return this.proc !== null;
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: unknown;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      // Not JSON, likely stray output. Surface it rather than silently drop.
      this.emit("notification", { method: "_process/unparsable_stdout", params: { text: trimmed } } satisfies RawNotificationEvent);
      return;
    }
    this.emit("rawMessage", msg);
    this.dispatch(msg as Record<string, unknown>);
  }

  private dispatch(msg: Record<string, unknown>): void {
    // JSON-RPC response (has "id" and either "result" or "error"), vs.
    // notification (has "method", no "id").
    if ("id" in msg && ("result" in msg || "error" in msg)) {
      const id = msg["id"] as number;
      const pending = this.pending.get(id);
      if (!pending) return; // response to a request we didn't send / already timed out
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if ("error" in msg) {
        pending.reject(new AcpRequestError(msg["error"] as JsonRpcErrorShape));
      } else {
        pending.resolve(msg["result"]);
      }
      return;
    }

    const method = msg["method"] as string | undefined;
    if (!method) return; // malformed, ignore rather than crash

    if (method === "session/update") {
      const params = msg["params"] as SessionUpdateEvent;
      this.emit("sessionUpdate", params);
      return;
    }

    // Every other method, documented or the x.ai-custom ones observed live,
    // flows through generically. Do not maintain a closed switch here.
    this.emit("notification", { method, params: msg["params"] } satisfies RawNotificationEvent);
  }

  private rejectAllPending(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private request<T>(method: string, params: unknown): Promise<T> {
    const proc = this.proc;
    if (!proc) {
      return Promise.reject(new AcpProcessError("AcpClient.request() called before start() or after exit"));
    }
    const id = this.nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };
    this.emit("rawMessage", payload);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AcpProcessError(`Request "${method}" (id=${id}) timed out after ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve: resolve as (r: unknown) => void, reject, timer });
      proc.stdin.write(JSON.stringify(payload) + "\n");
    });
  }

  // --- ACP methods, per docs/ACP-NOTES.md ---

  initialize(): Promise<InitializeResult> {
    return this.request<InitializeResult>("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    });
  }

  /** methodId must be one of InitializeResult.authMethods[].id (observed
   * live: "grok.com", which drives an interactive browser OAuth flow with no
   * headless completion path, do not call this from a headless context and
   * expect it to resolve). */
  authenticate(methodId: string): Promise<Record<string, never>> {
    return this.request("authenticate", { methodId });
  }

  newSession(mcpServers: McpServerConfig[] = []): Promise<NewSessionResult> {
    return this.request<NewSessionResult>("session/new", { cwd: this.opts.cwd, mcpServers });
  }

  /** Text-only prompt (v1 doesn't need image/audio content). */
  prompt(sessionId: string, text: string): Promise<PromptResult> {
    return this.request<PromptResult>("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text }],
    });
  }

  /** Documented in the public spec; NOT exercised live yet (blocked
   * on the same account-credits issue that blocked a successful prompt),
   * verify before relying on this in production. */
  cancel(sessionId: string): Promise<void> {
    return this.request("session/cancel", { sessionId });
  }
}

/** One human-readable line per session/update, for the UI's default view.
 * Raw JSON stays available behind a toggle for anything this doesn't cover.
 * Unknown sessionUpdate types (see file header) fall through to a generic
 * label rather than being dropped. */
export function summarizeSessionUpdate(update: { sessionUpdate: string } & Record<string, unknown>): string {
  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      const text = (update.content as { text?: string } | undefined)?.text ?? "";
      return text;
    }
    case "user_message_chunk":
      return ""; // echo of our own prompt, not useful to show again
    case "plan": {
      const entries = (update.entries as Array<{ content?: string; status?: string }> | undefined) ?? [];
      return "Plan:\n" + entries.map((e) => `  - [${e.status ?? "?"}] ${e.content ?? ""}`).join("\n");
    }
    case "tool_call": {
      const title = (update.title as string | undefined) ?? "(untitled)";
      const kind = (update.kind as string | undefined) ?? "other";
      return `Tool call started (${kind}): ${title}`;
    }
    case "tool_call_update": {
      const status = (update.status as string | undefined) ?? "unknown";
      const content = (update.content as Array<Record<string, unknown>> | undefined) ?? [];
      const diffLines = content
        .filter((c) => c.type === "diff")
        .map((c) => `    diff @ ${c.path as string}`);
      return [`Tool call ${status}`, ...diffLines].join("\n");
    }
    case "usage_update":
      return ""; // token accounting, not useful in the message log
    case "available_commands_update":
      return ""; // seen live, not relevant to task progress
    default:
      return `[${update.sessionUpdate}]`;
  }
}
