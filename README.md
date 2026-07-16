# Grok Build for VS Code

Runs xAI's Grok Build coding agent inside VS Code over the Agent Client Protocol (ACP), with a routing layer in front that decides how much supervision each request needs before handing it off. Small requests go straight to Grok Build. Bigger or messier requests get broken into steps first, and each step gets checked before the next one starts.

See `docs/ACP-NOTES.md` for protocol notes: real captured traffic, what the public docs get wrong, and what still needs testing.

## Prerequisites

1. **Grok Build**, installed and logged in:
   ```
   curl -fsSL https://x.ai/cli/install.sh | bash
   ```
   Then either run `grok login` (opens a browser, this is the only supported login path, there's no headless way to finish it) or set `XAI_API_KEY` in your environment. Your xAI account also needs credits or a license. A brand new team with none of that will get a 403 on every prompt. That's not a bug here, the error message links straight to `console.x.ai` to add credits.
2. `ANTHROPIC_API_KEY` set in your environment (or the `grokBuild.anthropicApiKey` VS Code setting, though the env var is preferred since `settings.json` isn't a secrets store).
3. Node.js 18+, then `npm install` in this folder.

## Running in dev mode

```
npm install
npm run compile        # or: npm run watch
```
Open this folder in VS Code and press F5 (Run Extension). In the Extension Development Host window, open a folder or workspace and run "Grok Build: Start Session" from the Command Palette.

Type a request into the panel that opens. It gets classified first, and you'll see a "Trivial to Grok Build" or "Complex, planning N steps" badge, with an escalate button on trivial results if you think the classifier got it wrong.

## How the routing works

Every request gets classified first as:
- **Trivial**: single file, narrow scope, low ambiguity. Gets sent to Grok Build in one shot, and the result is relayed back without further review.
- **Complex**: multi-file, architectural, or ambiguous. The task gets broken into an ordered list of subtasks. Each one is sent to Grok Build over ACP, the result (tool calls, diffs, agent messages) is summarized from the session update stream, and that summary is reviewed before deciding whether to keep going with the existing plan, replace the remaining steps, or stop early because the request is already done. Capped at a configurable max step count so a bad plan can't loop forever.

Grok Build is the only thing that ever touches the filesystem. The routing layer only plans and issues instructions over ACP, it never calls a file-editing API directly.

### Module layout

- `src/acpClient.ts`: ACP client for `grok agent stdio`. No VS Code dependency. Handles JSON-RPC framing over stdio, process lifecycle (spawn, graceful stop, missing-binary detection), and typed errors that separate local auth failures from upstream xAI API errors. Both the JSON-RPC method namespace and the `session/update` event types are treated as open rather than a fixed list, because live testing showed xAI sends notification types that aren't in the public ACP spec at all.
- `src/orchestrator.ts`: classification and the plan/issue/review loop. Depends only on a small structural interface for talking to Grok Build, not on the ACP client class directly, so it can be tested against a mock without spawning a real process.
- `src/webview/panel.ts`: plain HTML, CSS, and JS. No framework. The UI is a message log, a text box, and two buttons, that doesn't need one.
- `src/extension.ts`: wires all of it together. Registers the start command, manages the webview panel and subprocess lifecycle, and turns internal errors into readable messages for the three failure cases that actually happen (Grok Build not installed, Grok Build not logged in, `ANTHROPIC_API_KEY` missing).

## Current limitations

- No in-app auth management for either xAI or Anthropic. Both are environment or config based. The extension points at `grok login`, `XAI_API_KEY`, or `ANTHROPIC_API_KEY` when something's missing, nothing fancier.
- No persistence. Session state lives in memory and resets on reload or window close.
- No Neovim support.
- No marketplace packaging.
- The manual override is a single escalate-to-complex button, not a full routing picker.
- A real prompt that actually reaches the point of making tool calls (file writes, diffs) hasn't been observed yet in testing, every attempt so far hit a billing wall on the test account before Grok Build could do real work. The tool call event handling in `acpClient.ts` and `orchestrator.ts` is built from the public ACP spec but not confirmed against what Grok Build actually sends, and the spec already turned out to be incomplete in a couple of places. Worth re-checking once an account with credits is available.
- The trivial versus complex boundary is a judgment call from a system prompt, not a tuned or evaluated heuristic. Expect to adjust the wording once it misclassifies something in practice.

## License

MIT, see `LICENSE`.
