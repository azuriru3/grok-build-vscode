/**
 * Unit tests for AcpClient's JSON-RPC framing, dispatch, and error
 * classification. Runs against ./fixtures/fake-grok-agent.js, a scripted
 * stand-in for `grok agent stdio`, so these need no real binary and no xAI
 * credentials. They verify AcpClient parses/routes the wire protocol
 * correctly, not that Grok Build's real traffic still matches the shapes
 * captured in docs/ACP-NOTES.md, that's what acpClient.smoke.ts is for.
 *
 * Run with: npm run compile && npm test
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { AcpClient, AcpProcessError, AcpRequestError } from "../acpClient";

const fakeAgentPath = path.join(__dirname, "fixtures", "fake-grok-agent.js");

function makeClient(scenario: Record<string, unknown> = {}): { client: AcpClient; cwd: string } {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "acp-test-"));
  process.env.FAKE_AGENT_SCENARIO = JSON.stringify(scenario);
  const client = new AcpClient({ cwd, grokBinPath: fakeAgentPath, requestTimeoutMs: 5000 });
  return { client, cwd };
}

const cleanups: Array<() => Promise<void>> = [];
after(async () => {
  await Promise.all(cleanups.map((fn) => fn()));
});

test("initialize + session/new happy path", async () => {
  const { client } = makeClient();
  cleanups.push(() => client.stop());
  client.start();

  const init = await client.initialize();
  assert.equal(init.protocolVersion, 1);
  assert.ok(init.authMethods.some((m) => m.id === "grok.com"));

  const session = await client.newSession();
  assert.equal(session.sessionId, "sess_test123");

  await client.stop();
});

test("session/new auth-required error surfaces as AcpRequestError.isAuthRequired", async () => {
  const { client } = makeClient({ authError: true });
  cleanups.push(() => client.stop());
  client.start();
  await client.initialize();

  await assert.rejects(
    () => client.newSession(),
    (err: unknown) => {
      assert.ok(err instanceof AcpRequestError);
      assert.equal(err.code, -32000);
      assert.equal(err.isAuthRequired, true);
      assert.equal(err.upstreamHttpStatus, undefined);
      return true;
    },
  );

  await client.stop();
});

test("session/prompt billing error surfaces upstreamHttpStatus, not isAuthRequired", async () => {
  const { client } = makeClient({ promptBehavior: "billingError" });
  cleanups.push(() => client.stop());
  client.start();
  await client.initialize();
  const session = await client.newSession();

  await assert.rejects(
    () => client.prompt(session.sessionId, "do something"),
    (err: unknown) => {
      assert.ok(err instanceof AcpRequestError);
      assert.equal(err.code, -32603);
      assert.equal(err.isAuthRequired, false);
      assert.equal(err.upstreamHttpStatus, 403);
      return true;
    },
  );

  await client.stop();
});

test("session/update notifications are routed to the sessionUpdate event", async () => {
  const { client } = makeClient();
  cleanups.push(() => client.stop());
  client.start();
  await client.initialize();
  const session = await client.newSession();

  const updates: unknown[] = [];
  client.on("sessionUpdate", (evt) => updates.push(evt.update));

  await client.prompt(session.sessionId, "do something");

  assert.equal(updates.length, 1);
  assert.deepEqual((updates[0] as { sessionUpdate: string }).sessionUpdate, "tool_call");

  await client.stop();
});

test("unknown JSON-RPC notification methods pass through generically", async () => {
  const { client } = makeClient({ emitUnknownNotification: true });
  cleanups.push(() => client.stop());
  client.start();
  await client.initialize();
  const session = await client.newSession();

  const notifications: string[] = [];
  client.on("notification", (evt) => notifications.push(evt.method));

  await client.prompt(session.sessionId, "do something");

  assert.ok(notifications.includes("_x.ai/mcp/servers_updated"));

  await client.stop();
});

test("non-JSON stdout lines are surfaced as a notification instead of crashing", async () => {
  const { client } = makeClient({ garbageLine: true });
  cleanups.push(() => client.stop());
  client.start();
  await client.initialize();
  const session = await client.newSession();

  const notifications: string[] = [];
  client.on("notification", (evt) => notifications.push(evt.method));

  const result = await client.prompt(session.sessionId, "do something");

  assert.equal(result.stopReason, "end_turn");
  assert.ok(notifications.includes("_process/unparsable_stdout"));

  await client.stop();
});

test("missing binary surfaces AcpProcessError with the install hint", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "acp-test-"));
  const client = new AcpClient({ cwd, grokBinPath: "/definitely/not/a/real/grok/binary/xyz" });

  const processError = await new Promise<AcpProcessError>((resolve) => {
    client.on("processError", resolve);
    client.start();
  });

  assert.match(processError.message, /grok binary not found/);
  assert.match(processError.message, /curl -fsSL https:\/\/x\.ai\/cli\/install\.sh \| bash/);
});

test("cancel() sends session/cancel and resolves", async () => {
  const { client } = makeClient();
  cleanups.push(() => client.stop());
  client.start();
  await client.initialize();
  const session = await client.newSession();

  await client.cancel(session.sessionId);

  await client.stop();
});

test("process exit rejects pending requests", async () => {
  const { client } = makeClient({ promptBehavior: "exitNoResponse" });
  cleanups.push(() => client.stop());
  client.start();
  await client.initialize();
  const session = await client.newSession();

  await assert.rejects(() => client.prompt(session.sessionId, "do something"), AcpProcessError);
});
