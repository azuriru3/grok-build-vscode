/**
 * Mock-based control-flow test for Orchestrator, no real Anthropic or xAI
 * calls. Validates routing, event emission, and the plan -> issue -> review
 * loop against a fake Fable 5 (stubbed Anthropic client) and a fake
 * GrokSession. Run with: npm run compile && node ./out/test/orchestrator.mock.js
 *
 * This does NOT replace live verification, it proves the orchestrator's own
 * logic is correct in isolation. See src/test/acpClient.smoke.ts for the
 * real-binary test, and re-run a live Orchestrator test once a real
 * ANTHROPIC_API_KEY is available (ask before assuming this mock is sufficient
 * sign-off for production use).
 */
import Anthropic from "@anthropic-ai/sdk";
import { GrokSession, Orchestrator, OrchestratorSessionUpdate } from "../orchestrator";

type FakeResponsePlan = Array<Record<string, unknown>>;

function makeFakeAnthropic(responses: FakeResponsePlan): Anthropic {
  let call = 0;
  const fake = {
    beta: {
      messages: {
        create: async (_params: unknown) => {
          const body = responses[call++];
          if (!body) throw new Error(`makeFakeAnthropic: no scripted response for call #${call}`);
          return {
            stop_reason: "end_turn",
            content: [{ type: "text", text: JSON.stringify(body) }],
          };
        },
      },
    },
  };
  return fake as unknown as Anthropic;
}

function makeFakeGrok(onPrompt: (sessionId: string, text: string) => OrchestratorSessionUpdate[]): GrokSession {
  const listeners = new Set<(evt: OrchestratorSessionUpdate) => void>();
  return {
    async prompt(sessionId, text) {
      const events = onPrompt(sessionId, text);
      for (const evt of events) {
        for (const l of listeners) l(evt);
      }
      return { stopReason: "end_turn" };
    },
    on(_event, listener) {
      listeners.add(listener);
      return this;
    },
    off(_event, listener) {
      listeners.delete(listener);
      return this;
    },
  };
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

async function testTrivialRouting() {
  console.log("[test] trivial routing");
  const anthropic = makeFakeAnthropic([{ complexity: "trivial", reasoning: "single log line" }]);
  const grok = makeFakeGrok(() => [
    { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Added the log line." } } },
  ]);
  const orch = new Orchestrator({ anthropic, grok, sessionId: "s1" });

  const events: string[] = [];
  orch.on("classified", (c) => events.push(`classified:${c.complexity}`));
  orch.on("stepCompleted", (s) => events.push(`stepCompleted:${s.index}:${s.summary}`));
  orch.on("done", (d) => events.push(`done:${d.complexity}:${d.totalSteps}`));

  await orch.handleRequest("add a log line to foo()");

  assert(events[0] === "classified:trivial", `expected classified:trivial, got ${events[0]}`);
  assert(events[1] === "stepCompleted:0:Added the log line.", `got ${events[1]}`);
  assert(events[2] === "done:trivial:1", `got ${events[2]}`);
  console.log("[test] trivial routing PASSED");
}

async function testComplexRoutingWithReplan() {
  console.log("[test] complex routing with replan");
  const anthropic = makeFakeAnthropic([
    { complexity: "complex", reasoning: "multi-file refactor" },
    { subtasks: ["Step A", "Step B"], reasoning: "two steps" },
    { action: "replan", nextSubtasks: ["Step B revised"], notes: "Step A revealed we don't need the original Step B" },
    { action: "done", notes: "all done" },
  ]);
  let promptCount = 0;
  const grok = makeFakeGrok((_sid, text) => {
    promptCount++;
    return [{ sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `did: ${text}` } } }];
  });
  const orch = new Orchestrator({ anthropic, grok, sessionId: "s1" });

  const stepInstructions: string[] = [];
  orch.on("stepStarted", (s) => stepInstructions.push(s.instruction));
  let finalTotalSteps = -1;
  orch.on("done", (d) => (finalTotalSteps = d.totalSteps));

  await orch.handleRequest("refactor the auth module");

  assert(promptCount === 2, `expected 2 grok prompts (Step A, Step B revised), got ${promptCount}`);
  assert(stepInstructions[0] === "Step A", `expected first step 'Step A', got ${stepInstructions[0]}`);
  assert(stepInstructions[1] === "Step B revised", `expected replanned second step, got ${stepInstructions[1]}`);
  assert(finalTotalSteps === 2, `expected totalSteps 2, got ${finalTotalSteps}`);
  console.log("[test] complex routing with replan PASSED");
}

async function testMaxStepsSafetyCap() {
  console.log("[test] maxSteps safety cap");
  const infiniteSubtasks = Array.from({ length: 50 }, (_, i) => `task ${i}`);
  const anthropic = makeFakeAnthropic([
    { complexity: "complex", reasoning: "long" },
    { subtasks: infiniteSubtasks, reasoning: "many steps" },
    // "continue" scripted repeatedly is unnecessary, reviewStep is only
    // called while subtasks remain, and maxSteps should stop us first.
    ...Array.from({ length: 50 }, () => ({ action: "continue", notes: "keep going" })),
  ]);
  const grok = makeFakeGrok(() => []);
  const orch = new Orchestrator({ anthropic, grok, sessionId: "s1", maxSteps: 3 });

  let totalSteps = -1;
  orch.on("done", (d) => (totalSteps = d.totalSteps));
  await orch.handleRequest("do a huge amount of work");

  assert(totalSteps === 3, `expected maxSteps to cap at 3, got ${totalSteps}`);
  console.log("[test] maxSteps safety cap PASSED");
}

async function main() {
  await testTrivialRouting();
  await testComplexRoutingWithReplan();
  await testMaxStepsSafetyCap();
  console.log("\nAll orchestrator control-flow tests passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
