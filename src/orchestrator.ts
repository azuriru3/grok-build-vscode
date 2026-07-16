/**
 * Fable 5 orchestrator: classifies each request by complexity, then either
 * delegates once to Grok Build (trivial) or runs a plan -> issue -> review
 * loop against it (complex).
 *
 * Deliberately decoupled from AcpClient: depends only on the minimal
 * GrokSession structural interface below, not on AcpClient's class or any of
 * its internals. No VS Code imports.
 *
 * Model notes (see the bundled claude-api skill for the authoritative
 * version of all of this):
 *  - claude-fable-5 always thinks; we omit `thinking` entirely rather than
 *    setting `{type: "disabled"}` (that combination 400s on this model).
 *  - Every call opts into the server-side refusal-fallback beta by default
 *    (falls back to claude-opus-4-8 on a policy decline) per the skill's
 *    "opt in by default" guidance for claude-fable-5 code.
 *  - A "Fable 5 export-control suspension" note and a
 *    anthropic.com/news/... URL to check on access errors does not correspond
 *    to anything in Anthropic's real model docs as of this writing, treated
 *    as unverified/likely fabricated and NOT implemented as a special case
 *    here. A genuine access error will just surface as a normal API error;
 *    do not add URL-checking logic for it without independently confirming
 *    the claim first.
 */

import Anthropic from "@anthropic-ai/sdk";
import { EventEmitter } from "events";

export type Complexity = "trivial" | "complex";

export interface ClassificationResult {
  complexity: Complexity;
  reasoning: string;
}

export interface SubtaskPlan {
  subtasks: string[];
  reasoning: string;
}

export interface StepReview {
  action: "continue" | "replan" | "done";
  /** Only present when action === "replan". Replaces the remaining subtasks. */
  nextSubtasks?: string[];
  notes: string;
}

/** Minimal shape of a session/update event the orchestrator cares about,
 * matches AcpClient's SessionUpdateEvent structurally without importing it,
 * keeping this module independent of acpClient.ts's internals. */
export interface OrchestratorSessionUpdate {
  sessionId: string;
  update: { sessionUpdate: string } & Record<string, unknown>;
}

/** Everything the orchestrator needs from an ACP client. Deliberately a
 * structural subset, see file header. */
export interface GrokSession {
  prompt(sessionId: string, text: string): Promise<{ stopReason: string }>;
  on(event: "sessionUpdate", listener: (evt: OrchestratorSessionUpdate) => void): unknown;
  off(event: "sessionUpdate", listener: (evt: OrchestratorSessionUpdate) => void): unknown;
}

export interface OrchestratorOptions {
  /** Anthropic API client. Caller constructs this (reads ANTHROPIC_API_KEY
   * from env, or an explicit key), orchestrator.ts doesn't touch env/config
   * directly so it stays testable with a fake client. */
  anthropic: Anthropic;
  grok: GrokSession;
  sessionId: string;
  /** Safety cap on complex-task steps so a misbehaving plan can't loop
   * forever. */
  maxSteps?: number;
}

/** One human-readable line per session/update, used for the UI's
 * "human-readable summary" log and by the orchestrator's own step review
 * prompt to Fable 5 (which needs to see what actually happened, not raw JSON). */
export function summarizeSessionUpdate(update: { sessionUpdate: string } & Record<string, unknown>): string {
  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      const text = (update.content as { text?: string } | undefined)?.text ?? "";
      return text;
    }
    case "user_message_chunk":
      return ""; // echo of our own prompt, not useful in the review summary
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
      return ""; // token accounting, not relevant to the review summary
    case "available_commands_update":
      return ""; // observed live, not relevant to task progress
    default:
      // Unknown sessionUpdate type (open dispatch, per docs/ACP-NOTES.md),
      // surface something rather than silently dropping it.
      return `[${update.sessionUpdate}]`;
  }
}

const FABLE5_MODEL = "claude-fable-5";
const FABLE5_BETAS = ["server-side-fallback-2026-06-01"];
const FABLE5_FALLBACKS = [{ model: "claude-opus-4-8" }];

interface OrchestratorEventMap {
  classified: [ClassificationResult];
  planUpdated: [SubtaskPlan];
  stepStarted: [{ index: number; instruction: string }];
  stepCompleted: [{ index: number; instruction: string; stopReason: string; summary: string }];
  done: [{ complexity: Complexity; totalSteps: number }];
}

export class Orchestrator extends EventEmitter {
  constructor(private readonly opts: OrchestratorOptions) {
    super();
  }

  override emit<K extends keyof OrchestratorEventMap>(event: K, ...args: OrchestratorEventMap[K]): boolean {
    return super.emit(event, ...args);
  }
  override on<K extends keyof OrchestratorEventMap>(event: K, listener: (...args: OrchestratorEventMap[K]) => void): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  /** Entry point: classify, then route. */
  async handleRequest(userRequest: string, opts?: { forceComplexity?: Complexity }): Promise<void> {
    const classification: ClassificationResult = opts?.forceComplexity
      ? { complexity: opts.forceComplexity, reasoning: "Escalated by user override, Fable 5 classification was skipped." }
      : await this.classify(userRequest);
    this.emit("classified", classification);

    if (classification.complexity === "trivial") {
      await this.runTrivial(userRequest);
    } else {
      await this.runComplex(userRequest);
    }
  }

  private async runTrivial(userRequest: string): Promise<void> {
    this.emit("stepStarted", { index: 0, instruction: userRequest });
    const summary = await this.promptGrokAndSummarize(userRequest);
    this.emit("stepCompleted", { index: 0, instruction: userRequest, stopReason: summary.stopReason, summary: summary.text });
    this.emit("done", { complexity: "trivial", totalSteps: 1 });
  }

  private async runComplex(userRequest: string): Promise<void> {
    const maxSteps = this.opts.maxSteps ?? 12;
    let plan = await this.planSubtasks(userRequest);
    this.emit("planUpdated", plan);

    let stepIndex = 0;
    const history: string[] = [`Original request: ${userRequest}`];

    while (plan.subtasks.length > 0 && stepIndex < maxSteps) {
      const instruction = plan.subtasks.shift() as string;
      this.emit("stepStarted", { index: stepIndex, instruction });

      const result = await this.promptGrokAndSummarize(instruction);
      this.emit("stepCompleted", { index: stepIndex, instruction, stopReason: result.stopReason, summary: result.text });
      history.push(`Step ${stepIndex}, instruction: ${instruction}\nStep ${stepIndex}, observed result:\n${result.text || "(no output captured)"}`);
      stepIndex++;

      if (plan.subtasks.length === 0) {
        break; // no more planned subtasks; loop condition ends naturally
      }

      const review = await this.reviewStep(userRequest, history, plan.subtasks);
      if (review.action === "done") {
        break;
      }
      if (review.action === "replan" && review.nextSubtasks) {
        plan = { subtasks: review.nextSubtasks, reasoning: review.notes };
        this.emit("planUpdated", plan);
      }
      // action === "continue" -> keep going with the existing remaining plan
    }

    this.emit("done", { complexity: "complex", totalSteps: stepIndex });
  }

  /** Sends one instruction to Grok Build over the existing ACP session,
   * collecting session/update events emitted during that single prompt call
   * into a human-readable summary (via summarizeSessionUpdate). */
  private async promptGrokAndSummarize(instruction: string): Promise<{ stopReason: string; text: string }> {
    const lines: string[] = [];
    const listener = (evt: OrchestratorSessionUpdate) => {
      const line = summarizeSessionUpdate(evt.update);
      if (line) lines.push(line);
    };
    this.opts.grok.on("sessionUpdate", listener);
    try {
      const result = await this.opts.grok.prompt(this.opts.sessionId, instruction);
      return { stopReason: result.stopReason, text: lines.join("\n") };
    } finally {
      this.opts.grok.off("sessionUpdate", listener);
    }
  }

  private async classify(userRequest: string): Promise<ClassificationResult> {
    return this.callFable5<ClassificationResult>({
      system:
        "You are a routing classifier for a coding agent orchestration system. " +
        "Classify the user's request as either:\n" +
        "- 'trivial': single-file change, narrow scope, low ambiguity (typo fix, small function edit, adding a log line, simple rename).\n" +
        "- 'complex': multi-file, architectural, ambiguous, or requires planning/decomposition (refactors, new features, cross-cutting changes).\n" +
        "When genuinely unsure, prefer 'complex', under-planning a task that turns out to have hidden complexity is worse than a bit of extra review overhead on a task that turns out simple.",
      user: userRequest,
      effort: "low",
      schema: {
        type: "object",
        properties: {
          complexity: { type: "string", enum: ["trivial", "complex"] },
          reasoning: { type: "string" },
        },
        required: ["complexity", "reasoning"],
        additionalProperties: false,
      },
    });
  }

  private async planSubtasks(userRequest: string): Promise<SubtaskPlan> {
    return this.callFable5<SubtaskPlan>({
      system:
        "You are planning a complex coding task that will be executed by a separate coding agent (Grok Build), " +
        "which you instruct one discrete subtask at a time. You never edit files yourself, Grok Build does all " +
        "filesystem work. Break the request into an ordered list of concrete, self-contained instructions. Each " +
        "instruction should be something Grok Build can act on directly without needing the earlier subtasks " +
        "explained again (Grok Build sees the full session history, but be explicit anyway). Keep the list as " +
        "short as the task genuinely requires, don't pad it.",
      user: userRequest,
      effort: "medium",
      schema: {
        type: "object",
        properties: {
          subtasks: { type: "array", items: { type: "string" } },
          reasoning: { type: "string" },
        },
        required: ["subtasks", "reasoning"],
        additionalProperties: false,
      },
    });
  }

  private async reviewStep(originalRequest: string, history: string[], remainingSubtasks: string[]): Promise<StepReview> {
    return this.callFable5<StepReview>({
      system:
        "You are supervising a multi-step coding task being executed by Grok Build, one instruction at a time. " +
        "You've just seen the result of the most recent step. Decide what happens next:\n" +
        "- 'continue': the remaining planned subtasks are still correct as-is.\n" +
        "- 'replan': the remaining subtasks need to change (add, remove, or rewrite them) based on what actually " +
        "happened, e.g. Grok Build did more or less than expected, hit an error, or revealed new information. " +
        "Provide the full replacement list in nextSubtasks (not a diff of the old list).\n" +
        "- 'done': the original request is now fully satisfied and no remaining subtasks are needed, even if the " +
        "plan isn't exhausted.",
      user:
        `Original request: ${originalRequest}\n\n` +
        `History so far:\n${history.join("\n\n")}\n\n` +
        `Remaining planned subtasks: ${JSON.stringify(remainingSubtasks)}`,
      effort: "medium",
      schema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["continue", "replan", "done"] },
          nextSubtasks: { type: "array", items: { type: "string" } },
          notes: { type: "string" },
        },
        required: ["action", "notes"],
        additionalProperties: false,
      },
    });
  }

  private async callFable5<T>(args: {
    system: string;
    user: string;
    effort: "low" | "medium" | "high";
    schema: Record<string, unknown>;
  }): Promise<T> {
    const response = await this.opts.anthropic.beta.messages.create({
      model: FABLE5_MODEL,
      max_tokens: 4096,
      betas: FABLE5_BETAS,
      fallbacks: FABLE5_FALLBACKS,
      output_config: {
        effort: args.effort,
        format: { type: "json_schema", schema: args.schema },
      },
      system: args.system,
      messages: [{ role: "user", content: args.user }],
    } satisfies Anthropic.Beta.Messages.MessageCreateParamsNonStreaming);

    if (response.stop_reason === "refusal") {
      throw new Error(
        `Fable 5 declined this request (category: ${(response as { stop_details?: { category?: string } }).stop_details?.category ?? "unknown"}). ` +
          "This is a content-policy outcome, not a bug, rephrase the request or escalate to complex manually.",
      );
    }

    const textBlock = response.content.find((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === "text");
    if (!textBlock) {
      throw new Error(`Fable 5 response had no text block (stop_reason: ${response.stop_reason})`);
    }
    return JSON.parse(textBlock.text) as T;
  }
}
