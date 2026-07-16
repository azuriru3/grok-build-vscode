import assert from "node:assert/strict";
import { test } from "node:test";
import { summarizeSessionUpdate } from "../acpClient";

test("agent_message_chunk returns the chunk's text", () => {
  const line = summarizeSessionUpdate({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "hello there" },
  });
  assert.equal(line, "hello there");
});

test("user_message_chunk is suppressed (echo of our own prompt)", () => {
  const line = summarizeSessionUpdate({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "hi" } });
  assert.equal(line, "");
});

test("plan formats each entry with its status", () => {
  const line = summarizeSessionUpdate({
    sessionUpdate: "plan",
    entries: [
      { content: "read the file", status: "completed" },
      { content: "write the fix", status: "pending" },
    ],
  });
  assert.equal(line, "Plan:\n  - [completed] read the file\n  - [pending] write the fix");
});

test("tool_call includes kind and title", () => {
  const line = summarizeSessionUpdate({
    sessionUpdate: "tool_call",
    toolCallId: "call_1",
    title: "Edit src/foo.ts",
    kind: "edit",
    status: "pending",
  });
  assert.equal(line, "Tool call started (edit): Edit src/foo.ts");
});

test("tool_call defaults kind/title when missing", () => {
  const line = summarizeSessionUpdate({ sessionUpdate: "tool_call" });
  assert.equal(line, "Tool call started (other): (untitled)");
});

test("tool_call_update includes status and any diff paths", () => {
  const line = summarizeSessionUpdate({
    sessionUpdate: "tool_call_update",
    toolCallId: "call_1",
    status: "completed",
    content: [{ type: "diff", path: "/abs/path/foo.ts" }],
  });
  assert.equal(line, "Tool call completed\n    diff @ /abs/path/foo.ts");
});

test("tool_call_update with no diff content omits diff lines", () => {
  const line = summarizeSessionUpdate({ sessionUpdate: "tool_call_update", status: "failed" });
  assert.equal(line, "Tool call failed");
});

test("usage_update and available_commands_update are suppressed", () => {
  assert.equal(summarizeSessionUpdate({ sessionUpdate: "usage_update", used: 100, size: 200 }), "");
  assert.equal(summarizeSessionUpdate({ sessionUpdate: "available_commands_update", availableCommands: [] }), "");
});

test("unknown sessionUpdate types fall through to a generic label instead of being dropped", () => {
  const line = summarizeSessionUpdate({ sessionUpdate: "retry_state", type: "failed" });
  assert.equal(line, "[retry_state]");
});
