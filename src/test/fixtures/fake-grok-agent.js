#!/usr/bin/env node
"use strict";

/**
 * Scripted stand-in for `grok agent stdio`, used only by the unit test
 * suite (see ../acpClient.test.ts). Speaks just enough JSON-RPC-over-stdio
 * to exercise AcpClient's framing, dispatch, and error-classification
 * logic without needing the real xAI binary or credentials.
 *
 * Not a protocol conformance check: it emits the shapes captured in
 * docs/ACP-NOTES.md, it doesn't verify Grok Build still sends them.
 *
 * Behavior is driven by the FAKE_AGENT_SCENARIO env var (JSON), see
 * acpClient.test.ts for the scenario shapes this understands.
 */

const readline = require("readline");

const scenario = JSON.parse(process.env.FAKE_AGENT_SCENARIO || "{}");

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

const rl = readline.createInterface({ input: process.stdin });

rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {},
        authMethods: [{ id: "grok.com", name: "Grok", description: "Sign in with Grok" }],
      },
    });
    return;
  }

  if (msg.method === "session/new") {
    if (scenario.authError) {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32000, message: "Authentication required", data: "no auth method id provided" },
      });
      return;
    }
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: { sessionId: "sess_test123", models: { currentModelId: "grok-build", availableModels: [] } },
    });
    return;
  }

  if (msg.method === "session/cancel") {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
    if (scenario.pendingPromptId !== undefined) {
      send({ jsonrpc: "2.0", id: scenario.pendingPromptId, result: { stopReason: "cancelled" } });
    }
    return;
  }

  if (msg.method === "session/prompt") {
    if (scenario.promptBehavior === "pendingUntilCancel") {
      // Don't respond yet. session/cancel above will resolve this once it
      // arrives, using the id captured here since the test can't know it
      // ahead of time.
      scenario.pendingPromptId = msg.id;
      return;
    }
    if (scenario.emitUnknownNotification) {
      send({ jsonrpc: "2.0", method: "_x.ai/mcp/servers_updated", params: { mcpServers: [] } });
    }
    if (scenario.garbageLine) {
      process.stdout.write("not json at all\n");
    }
    if (scenario.promptBehavior === "exitNoResponse") {
      process.exit(1);
      return;
    }
    if (scenario.promptBehavior === "billingError") {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        error: {
          code: -32603,
          message: "Internal error",
          data: {
            message: "API error (status 403 Forbidden): permission-denied: no credits",
            http_status: 403,
          },
        },
      });
      return;
    }
    // Default: one tool_call session/update, then a successful stopReason.
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: msg.params.sessionId,
        update: { sessionUpdate: "tool_call", toolCallId: "call_1", title: "Read file", kind: "read", status: "pending" },
      },
    });
    send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
    return;
  }
});
