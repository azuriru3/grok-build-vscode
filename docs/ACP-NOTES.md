# ACP protocol notes for `grok agent stdio`

Notes from testing `grok` 0.2.101 (linux-x86_64) directly, installed via `curl -fsSL https://x.ai/cli/install.sh | bash`. Everything marked "confirmed" below came from actually running the binary and reading the raw JSON-RPC traffic. Everything marked "documented, not confirmed" comes from the public ACP spec at agentclientprotocol.com and hasn't been checked against what Grok Build actually sends.

## What the public docs get wrong

`docs.x.ai/build/overview` only says ACP integration "exists," with no invocation details. `docs.x.ai/build/modes-and-commands` covers TUI plan mode and always-approve mode, nothing about ACP. `docs.x.ai/build/cli` 404s. The actual command and its flags only show up in `grok agent stdio --help`, not on the docs site. If you're extending this, don't trust the docs site for anything ACP related, go straight to the binary's own help output.

## The installed binary

Real xAI binary, 162MB ELF, `strings` shows internal crate names (`xai_grok_shell`, `xai_worktree_pool`, `xai_grok_instrumentation`), not a stub or a wrapper.

`grok inspect` reads and displays this project's local permission settings and lists other locally-installed coding-agent tools' built-in skills and agents by name. The debug log confirms it loads MCP server configs from other local coding-agent tools' config files on disk. Grok Build has real interop with other coding-agent project config. Worth knowing if you're building on top of this: the extension shouldn't be surprised if Grok Build picks up other tools' local state sitting in the workspace.

`grok agent stdio` help:
```
Usage: grok agent stdio [OPTIONS]
Options:
      --debug                 Enable debug logging
      --debug-file <FILE>     Write debug logs to FILE
  -h, --help                  Print help
      --leader-socket <PATH>  Use a custom leader socket path
```
No flags needed for the basic case, just spawn `grok agent stdio` with cwd set to the workspace root.

## Confirmed: `initialize`

Request sent:
```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{"fs":{"readTextFile":true,"writeTextFile":true}}}}
```

Real response:
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": 1,
    "agentCapabilities": {
      "loadSession": true,
      "promptCapabilities": { "image": false, "audio": false, "embeddedContext": true },
      "mcpCapabilities": { "http": true, "sse": true },
      "sessionCapabilities": {},
      "auth": {},
      "_meta": {
        "x.ai/fs_notify": true,
        "x.ai/hooks": { "blockingEvents": ["pre_tool_use"], "decisions": ["deny"] }
      }
    },
    "authMethods": [
      { "id": "grok.com", "name": "Grok", "description": "Sign in with Grok" }
    ],
    "_meta": {
      "grokShell": true,
      "defaultAuthMethodId": null,
      "x.ai/mcp/sdk": true,
      "x.ai/pluginDirs": true,
      "currentWorkingDirectory": "<cwd>",
      "agentVersion": "0.2.101",
      "agentId": "71a844d8-d66b-5682-a0c5-3f29fd08a5a3",
      "agentInstanceId": "<uuid, changes per process>",
      "hostname": "<host>",
      "modelState": { "currentModelId": "grok-build", "availableModels": [] },
      "mcpServers": [],
      "mcpApps": false,
      "metadata": null,
      "availableCommands": [
        { "name": "compact", "description": "Compress conversation history to save context window", "input": { "hint": "optional context about what to preserve" } },
        { "name": "always-approve", "description": "Toggle always-approve mode (skip all permission prompts)", "input": { "hint": "on|off" } },
        { "name": "context", "description": "Show context window usage and session stats", "input": null },
        { "name": "session-info", "description": "Show session details (model, turns, context usage)", "input": null },
        { "name": "goal", "description": "Set, manage, or check an autonomous goal", "input": { "hint": "<objective> [--budget <tokens>] | status | pause | resume | clear" } }
      ],
      "cancelRewind": true,
      "sessionRecap": true
    }
  }
}
```

Takeaways:
- `protocolVersion` is an integer (`1`), not a semver string.
- Auth is required before `session/new` will succeed. `authMethods[0].id` is `"grok.com"` when nothing else is configured.
- `_meta.modelState.currentModelId` is `"grok-build"` even fully unauthenticated, the model ID doesn't change with auth state.
- `agentId` stayed stable across process restarts in testing. `agentInstanceId` is per process.

## Confirmed: `session/new` without auth

Request:
```json
{"jsonrpc":"2.0","id":3,"method":"session/new","params":{"cwd":"<abs path>","mcpServers":[]}}
```

Real response:
```json
{"jsonrpc":"2.0","id":3,"error":{"code":-32000,"message":"Authentication required","data":"no auth method id provided"}}
```

The client needs to catch this exact error path: JSON-RPC error code `-32000` with message `"Authentication required"`, and surface something like "Grok Build isn't logged in, run `grok login` in a terminal" rather than a generic failure.

## Confirmed: `authenticate` (grok.com)

Request:
```json
{"jsonrpc":"2.0","id":2,"method":"authenticate","params":{"methodId":"grok.com"}}
```

Result: no response at all within a 10 second window, and the following `session/new` still failed with the same "Authentication required" error. This confirms the `grok.com` method drives an interactive browser OAuth flow with no headless completion path. There's no way to complete auth purely by piping JSON-RPC into the agent, so don't try to automate this in the extension itself.

The debug log shows `resolved credentials model=grok-build auth_type=ApiKey` even with zero config present, and the public docs mention `export XAI_API_KEY="xai-..."` as the non-browser path. Confirmed below: if `XAI_API_KEY` is set in the environment before spawning, `session/new` works without ever calling `authenticate`.

## Documented, not confirmed live: agentclientprotocol.com/protocol/v1/

Source pages: `session-setup.md`, `prompt-turn.md`, `authentication.md`, `tool-calls.md`. These have not been fully diffed against Grok Build's real behavior, and given the mismatches already found in the xAI docs site, treat the spec's examples as a starting point rather than ground truth.

### `session/new`
```json
// request
{"cwd": "/home/user/project", "mcpServers": [{"name": "...", "command": "...", "args": [], "env": []}]}
// response
{"sessionId": "sess_abc123def456"}
```

### `session/load` / `session/resume`
Same request shape as `session/new` plus `sessionId`. `session/load` responds `null` after first streaming `session/update` notifications with history. `session/resume` responds `{}`.

### `authenticate`
```json
// request
{"methodId": "grok.com"}   // must match an id from initialize.authMethods
// response on success
{}
```

### `session/prompt`
```json
// request
{"sessionId": "sess_abc123def456", "prompt": [{"type": "text", "text": "..."}]}
// response
{"stopReason": "end_turn"}   // | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled"
```

### `session/update` notifications (server to client, no id)
Envelope:
```json
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"...","update": { /* one of below */ }}}
```

- `plan`: `{"sessionUpdate":"plan","entries":[{"content":"...","priority":"high","status":"pending"}]}`
- `agent_message_chunk`: `{"sessionUpdate":"agent_message_chunk","messageId":"msg_...","content":{"type":"text","text":"..."}}`
- `tool_call`: `{"sessionUpdate":"tool_call","toolCallId":"call_001","title":"...","kind":"read"|"edit"|"delete"|"execute"|"think"|"fetch"|"search"|"move"|"other","status":"pending"|"in_progress"|"completed"|"failed"}`
- `tool_call_update`: `{"sessionUpdate":"tool_call_update","toolCallId":"call_001","status":"completed","content":[{"type":"content","content":{"type":"text","text":"..."}}]}`
  - diff content variant: `{"type":"diff","path":"/abs/path","oldText":"...","newText":"..."}`
  - terminal content variant: `{"type":"terminal","terminalId":"term_xyz789"}`
- `usage_update`: `{"sessionUpdate":"usage_update","used":53000,"size":200000,"cost":{"amount":0.045,"currency":"USD"}}`

### Also seen but not in the public spec
The `_x.ai/mcp/servers_updated` notification was observed live (`{"jsonrpc":"2.0","method":"_x.ai/mcp/servers_updated","params":{"mcpServers":[]}}`), an `x.ai`-namespaced extension not covered by the spec pages above. The client's JSON-RPC dispatcher has to tolerate unknown `method` values without crashing, xAI clearly sends custom notifications alongside the standard ones.

## Confirmed: authenticated run with a real XAI_API_KEY

With a real key set, `session/new` succeeded and `session/prompt` actually reached xAI's backend. It failed with a billing error (`403 permission-denied: Your newly created team doesn't have any credits or licenses yet`), not a protocol error. Everything up through the prompt being dispatched is confirmed working. The part that actually does work (tool calls, file diffs, streaming completion) is still unverified because that test account had no credits. That's a billing action item on whoever owns the xAI account, not a code problem.

### `initialize.authMethods` changes based on ambient auth state

With `XAI_API_KEY` set in the environment before spawning, `initialize`'s `authMethods` includes a second entry not seen unauthenticated:
```json
{"id": "xai.api_key", "name": "xai.api_key", "description": "XAI_API_KEY or api_key/env_key in config.toml"}
```
and `_meta.defaultAuthMethodId` becomes `"xai.api_key"` (it's `null` with no key set). This means the client never needs to call `authenticate` at all when `XAI_API_KEY` is present in the subprocess's environment, `session/new` just works. `authenticate("grok.com")` only matters for the interactive browser login path, which is out of scope for this extension anyway, point users at `XAI_API_KEY` or `grok login` instead.

### `session/new` real success shape (richer than the spec doc)

```json
{
  "sessionId": "019f6855-873d-7332-b00c-b3b58ee81df3",
  "models": { "currentModelId": "grok-build", "availableModels": [] },
  "_meta": {
    "currentWorkingDirectory": "<cwd>",
    "codebaseIndexed": [],
    "isGitRepo": false,
    "gitRoot": null,
    "showNonGitWarning": false,
    "feedbackEnabled": true,
    "x.ai/sessionConfig": { "options": [] },
    "x.ai/sessionDetail": { "sessionId": "...", "kind": "build", "cwd": "...", "currentModelId": "grok-build" }
  }
}
```
The real response is not just `{"sessionId": "..."}` as the spec example shows. Always read `_meta` defensively, don't assume the top-level shape is minimal.

### Full notification sequence for one `session/prompt` call

In order, verbatim `method` names observed (own JSON-RPC IDs omitted, these are all id-less notifications):

1. `_x.ai/mcp/servers_updated`, fires right after `initialize`, before any session exists.
2. `_x.ai/mcp_initialized`, `{sessionId, mcpToolCount, elapsedMs}`, fires after `session/new`.
3. `session/update` twice with `update.sessionUpdate: "available_commands_update"`. Not one of the 5 types listed on agentclientprotocol.com's prompt-turn page, though it IS defined in the spec's `schema/v1/schema.json`, which has 11 `SessionUpdate` variants; the prose docs only show 5 of them. Carries the same `availableCommands` array seen in `initialize`'s `_meta`, plus a `loop` command not present at init time.
4. `_x.ai/queue/changed`, `{sessionId, entries: [{id, version, kind: "prompt", text, position}]}` when a prompt is queued, then `{sessionId, entries: [], runningPromptId}` once it starts running.
5. `session/update` with `update.sessionUpdate: "user_message_chunk"`. Also not in the documented list. Echoes the prompt text back with `_meta: {modelId, promptIndex}`.
6. `_x.ai/session_notification` wrapping `update.sessionUpdate: "session_summary_generated"`, `{session_summary: "<truncated prompt text>"}`.
7. `_x.ai/session_notification` wrapping `update.sessionUpdate: "retry_state"`, `{type: "failed", error_type: "api", message: "<raw upstream error>"}`. This is where the billing error surfaced.
8. `_x.ai/queue/changed`, empty entries, prompt done.
9. `_x.ai/session/prompt_complete`, `{sessionId, promptId, stopReason: "error", agentResult: "<error message>"}`. `"error"` is a `stopReason` value not documented in the public spec's enum (`end_turn` | `max_tokens` | `max_turn_requests` | `refusal` | `cancelled`).
10. `_x.ai/session_notification` wrapping `update.sessionUpdate: "turn_completed"`, snake_case fields (`prompt_id`, `stop_reason`, `agent_result`, inconsistent casing versus the camelCase used everywhere else in the protocol).

Final JSON-RPC response for the `session/prompt` request itself:
```json
{"jsonrpc":"2.0","id":3,"error":{"code":-32603,"message":"Internal error","data":{"message":"API error (status 403 Forbidden): permission-denied: ...","http_status":403}}}
```

### What this means for the client

- Don't build a closed enum of `session/update.update.sessionUpdate` values. The real stream mixes the 5 types shown on the prompt-turn docs page (`plan`, `agent_message_chunk`, `tool_call`, `tool_call_update`, `usage_update`, still unverified live) with schema-defined ones the prose docs omit (`available_commands_update`, `user_message_chunk`; the v1 schema defines 11 variants in total). Correction to an earlier version of these notes: those two are in the public spec's schema, just not on the docs page, so they're spec-conformant rather than vendor deviations. The client renders unknown `sessionUpdate` types as a generic raw JSON log entry instead of dropping or crashing on them, which also covers the schema variants not yet observed live (`agent_thought_chunk`, `current_mode_update`, `config_option_update`, `session_info_update`).
- Don't build a closed dispatch table of JSON-RPC `method` names either. A real session emits at least 5 `_x.ai/*`-namespaced notifications (`mcp/servers_updated`, `mcp_initialized`, `queue/changed`, `session_notification`, `session/prompt_complete`) that have nothing to do with the public ACP spec. Same rule, unknown methods get logged, not thrown.
- `error.data.http_status` and `error.data.message` carry the real upstream xAI API error when a prompt fails server side, as opposed to `error.code: -32000 "Authentication required"` for local auth state errors. The client distinguishes three failure classes: local auth error, billing or upstream API error surfaced via `-32603`, and everything else.
- `_x.ai/session/prompt_complete.stopReason` can be `"error"` in addition to the publicly documented enum, handle it as a terminal, failed state.

## Still open, blocked on account credits, not on protocol understanding

1. The actual `tool_call` to `tool_call_update` sequence and diff shape for a real file write. Everything up to dispatch is confirmed, the work itself never ran because of the billing error. Needs an xAI account with credits or a license to test.
2. Whether `agent_message_chunk` arrives incrementally or as one chunk per turn.
3. Whether `session/cancel` (not yet tested) actually stops a running turn.
4. Whether the 5 documented `session/update` types match reality once a prompt actually succeeds, given `available_commands_update` and `user_message_chunk` already showed the doc list isn't exhaustive.
