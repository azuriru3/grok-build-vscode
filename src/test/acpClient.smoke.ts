/**
 * Standalone smoke test for AcpClient, no VS Code, no test framework.
 * Run with: npm run compile && node ./out/test/acpClient.smoke.js [workdir]
 *
 * Exercises: start -> initialize -> newSession -> prompt, logging every raw
 * message and every parsed sessionUpdate/notification event so you can see
 * exactly what the real binary sends back.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { AcpClient, AcpRequestError, AcpProcessError } from "../acpClient";

async function main() {
  const workdir = process.argv[2] ?? fs.mkdtempSync(path.join(os.tmpdir(), "acp-smoke-"));
  console.log(`[smoke] workdir: ${workdir}`);

  const client = new AcpClient({ cwd: workdir, requestTimeoutMs: 60_000 });

  client.on("rawMessage", (msg) => {
    console.log("[raw]", JSON.stringify(msg));
  });
  client.on("sessionUpdate", (evt) => {
    console.log("[sessionUpdate]", evt.update.sessionUpdate, JSON.stringify(evt.update).slice(0, 200));
  });
  client.on("notification", (evt) => {
    console.log("[notification]", evt.method);
  });
  client.on("processError", (err: AcpProcessError) => {
    console.error("[processError]", err.message);
  });
  client.on("exit", (code, signal) => {
    console.log(`[exit] code=${code} signal=${signal}`);
  });

  client.start();

  try {
    const init = await client.initialize();
    console.log("[smoke] initialize OK. authMethods:", init.authMethods.map((m) => m.id).join(", "));

    const session = await client.newSession();
    console.log("[smoke] session/new OK. sessionId:", session.sessionId);

    const result = await client.prompt(
      session.sessionId,
      "Create a file named hello.txt in the current directory containing exactly the text: hello from grok build smoke test",
    );
    console.log("[smoke] prompt result:", JSON.stringify(result));

    const wrote = fs.existsSync(path.join(workdir, "hello.txt"));
    console.log(`[smoke] hello.txt written: ${wrote}`);
  } catch (err) {
    if (err instanceof AcpRequestError) {
      console.error(`[smoke] AcpRequestError code=${err.code} message=${err.message} upstreamHttpStatus=${err.upstreamHttpStatus}`);
      if (err.isAuthRequired) {
        console.error("[smoke] -> Grok Build is not authenticated. Run `grok login` in a terminal, or set XAI_API_KEY.");
      }
    } else {
      console.error("[smoke] error:", err);
    }
  } finally {
    await client.stop();
  }
}

main().catch((e) => {
  console.error("[smoke] fatal:", e);
  process.exit(1);
});
