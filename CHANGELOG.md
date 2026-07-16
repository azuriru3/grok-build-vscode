# Changelog

## 0.0.1

Initial release.

- "Grok Build: Start Session" opens a panel, spawns `grok agent stdio`, and talks to it directly over ACP (initialize, session/new, session/prompt).
- Auth and process failures (missing binary, not logged in, upstream billing/API errors) surface as readable messages in the panel instead of crashing or failing silently.
- Stop button cancels an in-flight prompt via `session/cancel`.
- Raw JSON-RPC traffic is available behind a toggle on every log entry.
- Not yet verified: the `tool_call`/`tool_call_update`/diff rendering path. Every live test so far has hit a billing error before Grok Build could make a real tool call, so that part of `acpClient.ts` is built from the public ACP spec but unconfirmed against real traffic. See `docs/ACP-NOTES.md`.
