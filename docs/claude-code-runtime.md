# Claude Code local runtime

Bobbit can run a session through the user's local Claude Code CLI instead of the standard Pi-backed session runtime. This is a runtime switch, not another API-backed model provider: Bobbit starts `claude` on the gateway host, talks to its structured `stream-json` stdin/stdout protocol, and relies on the user's existing Claude Code installation and login.

Use this mode when you want Bobbit's session UI, goal/task context, persistence, and renderers around Claude Code's local runtime. It does not change Claude Code account obligations. Usage is governed by the user's Claude Code account, quota, and Anthropic/Claude Code terms.

## Supported capabilities

The local runtime currently supports:

- **Claude Code-backed chat sessions** — Bobbit sends user prompts to the local CLI over structured stdin and renders the streamed stdout response in the normal chat surface. Claude Code owns inference, authentication, permission prompts, and its internal context handling.
- **Model alias selection** — picker rows use `claude-code/<alias>` ids. The default alias for new Claude Code sessions is `claude-opus-4-8`, with built-in rows for `default`, `sonnet`, and `opus`; short custom aliases may also be forwarded to the CLI.
- **Same-session alias switching** — changing between Claude Code aliases keeps the Bobbit session when the runtime is idle. Bobbit restarts the local `claude` process with the new alias and resumes with the latest known Claude Code session id when available.
- **Transcript persistence and hydration** — Bobbit persists runtime metadata and a Bobbit-owned transcript fallback, so reloads and `read_session` can hydrate Claude Code conversations even when no Pi `agentSessionFile` exists.
- **Structured tool-use display** — Claude Code `tool_use` and `tool_result` stream events are translated into Bobbit tool-call and tool-result messages where their shape can be mapped. Claude Code Ask User Question payloads render as Bobbit `ask_user_choices` when they use the supported structured question/options shape. Shell, git, and other tool outputs are visible when Claude Code emits them as structured tool events.
- **Session status and errors** — readiness, runtime metadata, normal turn completion, CLI exits, malformed stream diagnostics, auth/start failures, and error results surface through Bobbit status/error events instead of failing silently.
- **Stop/abort MVP behavior** — graceful stops terminate the local process, escalating when needed; abort emits a visible aborted turn and lets the next prompt start a fresh CLI process with the latest known resume id.
- **Guarded host preferences** — executable path and permission-bypass settings are saved server-side and require operator confirmation because they affect host-local process execution.
- **Usage display when reported** — token usage is normalized when Claude Code reports usage, and local-runtime cost/usage fields are treated as best-effort rather than authoritative API billing data.

## Runtime shape

Claude Code sessions use runtime id `claude-code` and model provider `claude-code`. The standard runtime remains `pi`; legacy sessions without an explicit runtime are treated as Pi-backed.

The bridge starts Claude Code with structured IO, approximately:

```bash
claude --print \
  --input-format stream-json \
  --output-format stream-json \
  --verbose \
  --replay-user-messages
```

Depending on session metadata and preferences Bobbit may also pass:

- `--model <alias>` for non-`default` aliases such as `claude-opus-4-8`, `sonnet`, or `opus`.
- `--append-system-prompt <text>` with Bobbit's assembled system prompt.
- `--permission-mode acceptEdits|bypassPermissions` for explicit non-default permission modes.
- `--resume <claudeCodeSessionId>` when Bobbit has a previous Claude Code session id.

Claude Code stdout is parsed as JSONL. Bobbit translates Claude Code events into the same live event stream the UI already understands. This is display/coordination only: Bobbit does not execute Claude Code's internal tool calls or substitute its own tool catalog for the CLI's tool catalog.

| Claude Code event | Bobbit behavior |
|---|---|
| `system` / `init` | Starts the runtime, captures `claudeCodeSessionId`, and records model alias metadata. |
| `user` text replay | Emits a user `message_end`. |
| `assistant` text | Streams assistant `message_update` snapshots. |
| `tool_use` | Emits tool-start style events and includes tool calls in assistant content where renderable. Claude Code Ask User Question blocks are normalized to Bobbit `ask_user_choices` when each question uses Bobbit-compatible `question`, optional `header`, optional `multiSelect`, and option labels. |
| `tool_result` | Emits matching tool-result/end events. |
| `result` | Ends the assistant turn and emits `agent_end`; errors surface as visible assistant errors. |
| non-JSON stdout diagnostics | Kept as diagnostics instead of crashing the session. |

The parser has size limits for JSONL lines, diagnostic lines, per-event content, assistant text, and stored message count so a malformed CLI stream cannot exhaust the gateway process.

## Picker and readiness behavior

`GET /api/models` always emits synthetic Claude Code model rows for the local runtime aliases:

- `claude-code/claude-opus-4-8` (default)
- `claude-code/default`
- `claude-code/sonnet`
- `claude-code/opus`

Picker rows are deliberately labeled as local runtime rows:

- Name: `Claude Code Opus 4.8`, `Claude Code Sonnet`, `Claude Code Opus`, etc.
- Provider/runtime label: `Claude Code (local)`.
- Detail text: `Claude Code managed` / `Claude Code account`.
- Tooltip when available: `Runs through your local Claude Code CLI and existing Claude Code login.`

Claude Code owns context-window and output-token behavior for this runtime. Bobbit may keep synthetic fallback metadata in the model registry for compatibility, but the picker does not display numeric context/output limits for Claude Code rows; it shows `Claude Code managed` instead.

Readiness comes from `GET /api/claude-code/status`; `POST /api/claude-code/status/refresh` clears the short status/model cache and re-probes.

The probe resolves the configured executable and runs `--version` with a sanitized environment. Claude Code does not expose a documented safe authenticated no-op probe, so the normal successful state is:

- CLI available.
- `ready: true`.
- `authenticationStatus: "unknown"`.
- Settings text: `CLI available; auth checked at session start`.

If the executable is missing, invalid, not runnable, times out, or reports a login/auth failure, Claude Code rows remain visible but are disabled with a reason-specific badge such as `CLI missing`, `Login required`, or `Probe failed`.

## Configuration

Settings → Models contains a **Claude Code (local)** section. These preferences are saved with the existing preferences API. Host-runtime preferences that affect process execution or permission bypass are sensitive: changing or resetting `claudeCode.executablePath`, enabling `claudeCode.allowBypassPermissions`, or setting `claudeCode.permissionMode` to `bypassPermissions` requires an operator-capable browser cookie and a short-lived confirmation token. Confirmation requests must not carry `Authorization`, query-token, or session-bound headers. Bearer-token or query-token REST traffic receives preview/API cookies only, cannot mint operator confirmations, and cannot self-confirm host-runtime changes. On localhost, the supported operator bootstrap path is a no-auth browser request to `/api/health`, followed by the normal Settings confirmation flow.

| Preference key | Default | Meaning |
|---|---|---|
| `claudeCode.executablePath` | `claude` | Command name on trusted `PATH` or an absolute executable path. Relative paths such as `./claude` are rejected. |
| `claudeCode.defaultModel` | `claude-opus-4-8` | Default model alias when a Claude Code session is created without a specific `claude-code/<alias>` model. Built-in choices are `claude-opus-4-8`, `default`, `sonnet`, and `opus`; short custom model tokens are accepted. |
| `claudeCode.permissionMode` | `default` | Claude Code permission mode: `default`, `acceptEdits`, or `bypassPermissions`. |
| `claudeCode.allowBypassPermissions` | `false` | Explicit user/admin opt-in required before `bypassPermissions` can be saved or used. |

Project config may provide `claudeCodeDefaultModel` and `claudeCodePermissionMode` for sessions in that project. It cannot choose the host executable for readiness probes or sessions, and repository-controlled keys such as `claudeCodeExecutablePath` are ignored for that purpose. Project config also cannot enable bypass mode. If a project requests `bypassPermissions` and the user/admin has not enabled `claudeCode.allowBypassPermissions`, Bobbit downgrades the mode to `default`.

Permission modes are intentionally explicit:

- `default` lets Claude Code ask normally.
- `acceptEdits` accepts edit operations when Claude Code requests them; it still changes local files, so use it only for trusted sessions.
- `bypassPermissions` disables normal Claude Code permission prompts. It is disabled until the separate bypass opt-in is set because it increases local-machine risk.

## Session behavior

### Creating sessions

A Claude Code session can be created by posting a session with either:

```json
{ "runtime": "claude-code", "model": "claude-code/sonnet" }
```

or a model object with provider `claude-code` and an alias id.

Bobbit persists runtime metadata alongside normal session metadata:

- `runtime: "claude-code"`
- `modelProvider: "claude-code"`
- `modelId: <alias>`
- `claudeCodeSessionId`
- `claudeCodeExecutable`
- `claudeCodePermissionMode`
- `claudeCodeModelAlias`

`claudeCodeSessionId` is the Claude Code CLI session id. It is separate from Bobbit's session id and is captured from Claude Code stream events. Bobbit also writes Claude Code `message_end` events to a Bobbit-owned transcript fallback when no Pi `agentSessionFile` exists, so live hydration and `read_session` can still read local-runtime conversations.

### No silent runtime switching

Bobbit does not silently convert a running session between Pi and Claude Code.

- Picking a Claude Code row from an existing Pi session opens a confirmation dialog and creates a new top-level Claude Code session from the same working directory.
- Picking a Pi/API-backed model from a Claude Code session follows the same new-session pattern.
- If the UI misses the guard, the bridge/server rejects the runtime-mismatched `set_model` request.
- Changing between Claude Code aliases keeps the same Bobbit session. Bobbit does not rely on an undocumented in-process model-switch event; when idle, it gracefully stops the current Claude Code process, restarts `claude` with the new `--model <alias>`, and includes `--resume <claudeCodeSessionId>` when one is known.

This keeps each session tied to the runtime that owns its process, transcript, and resume semantics while still allowing safe same-runtime alias changes.

### Continue, fork, restart, and resume

Claude Code resume uses Claude Code's own session id and `--resume`; it does not use Pi's `switch_session` transcript command.

- Restart/restore passes the persisted `claudeCodeSessionId` back to the bridge when available.
- Continue and fork preserve the Claude Code runtime metadata and pass the source `claudeCodeSessionId` into the new session.
- Continue/fork from a Bobbit transcript is not supported for Claude Code unless a Claude Code session id is available.
- Sessions with `runtime: "claude-code"` and a valid `claudeCodeSessionId` can be restored even if they do not have a Pi `agentSessionFile`.

### Stop and abort

`stop()` sends `SIGTERM` to the local Claude Code process and escalates to `SIGKILL` if it does not exit within the grace window. Bobbit uses this for session shutdown and idle model-alias restart/resume.

`abort()` is the MVP turn-cancel path. It emits a visible assistant message saying the Claude Code turn was aborted, emits `agent_end` with stop reason `abort`, sends `SIGTERM` to the current process, and suppresses the expected process-exit error. The next prompt starts a new Claude Code process and includes the latest known resume id when one is available. This is process-level cancellation, not a separate Claude Code structured interrupt command.

## Current gaps and limitations

- **Tool execution is owned by Claude Code** — Bobbit does not execute Claude Code's internal tools, rewrite their inputs, approve their permissions, or replace the CLI tool catalog with Bobbit's tool catalog. Claude Code owns permission prompts and tool availability.
- **Tool rendering is best-effort** — common `tool_use` / `tool_result` shapes render as Bobbit tool events, and Ask User Question-style payloads render interactively as `ask_user_choices` when their questions/options match the supported shape. Other Claude Code tool schemas may not map perfectly to Bobbit renderers; unknown or unusual fields may appear only as generic message content or diagnostics.
- **Claude Code owns runtime limits and catalogs** — auth, account state, model catalog, context limits, permission semantics, and local CLI behavior come from the installed `claude` command, not Bobbit. Bobbit forwards validated aliases but does not verify the upstream model catalog.
- **Reviewer and verification agents stay Pi-backed** — workflow verification, reviewer/runtime agents, and other automation paths remain on the existing Pi runtime unless they are explicitly redesigned to request `claude-code`.
- **Host-only sandbox boundary** — Claude Code sessions cannot run in Bobbit Docker sandboxes in the MVP, and Bobbit does not mount or expose private Claude credentials into sandbox containers by default.
- **Resume depends on the CLI** — restart, restore, continue, fork, and alias switching can pass `--resume <claudeCodeSessionId>` only when Bobbit has a valid Claude Code session id and the local CLI honors it. If Bobbit has messages but no Claude Code session id, operations that would lose Claude Code context fail clearly.
- **Usage and cost are best-effort** — Bobbit normalizes token display when Claude Code reports usage and can surface CLI-reported cost fields, but usage/cost accounting is local-runtime managed and should not be treated as Bobbit API billing data.
- **Unsupported Pi control surfaces** — live steer, thinking-level changes, and compaction are not supported for Claude Code sessions in the MVP. Active streaming turns reject alias switches until the turn finishes.
- **Auth failures may be deferred** — the readiness probe intentionally avoids an undocumented authenticated no-op, so some login/account failures only appear when the first Claude Code session starts.

## Safety and credentials

The integration is host-local by design. Bobbit starts the configured Claude Code executable on the gateway host so the CLI can use the user's normal Claude Code installation and local login state.

Safety rules:

- Bobbit does not mount Claude Code credentials into Docker sandbox containers by default.
- Claude Code runtime sessions are rejected for sandboxed/container sessions in the MVP.
- The bridge uses `spawn`/`execFile` without a shell and rejects relative executable paths.
- The trusted `PATH` excludes the session working directory so a repo-local `claude` cannot shadow the user's real CLI.
- Child-process environment is minimized. Common provider/gateway secret variables are dropped instead of forwarded to the Claude Code process.
- Product copy should say this uses the user's local Claude Code CLI and login, and that users are responsible for complying with Anthropic and Claude Code terms.

## API notes

Relevant REST surfaces:

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/preferences/claude-code/confirmation` | Mints the short-lived operator confirmation token required for sensitive Claude Code preference writes. |
| `GET` | `/api/claude-code/status` | Probe local CLI readiness. Optional `projectId` validates the project context; the executable remains user/admin preference only. |
| `POST` | `/api/claude-code/status/refresh` | Invalidate status/model caches and re-probe. |
| `GET` | `/api/models` | Includes synthetic `claude-code/*` models with `runtime`, `localRuntime`, `runtimeLabel`, `sessionSelectable`, and unavailable reason metadata. |
| `POST` | `/api/sessions` | Accepts `runtime: "claude-code"` and/or `model: "claude-code/<alias>"`. |
| `GET` | `/api/sessions` / `/api/sessions/:id` | Returns runtime and Claude Code metadata so reloads keep the correct footer/runtime state. |

## Test fixtures and validation

Automated tests use a fake Claude CLI and JSONL stream fixtures so CI does not require a real Claude Code install or Anthropic account.

Key fixtures:

- `tests/fixtures/claude-code/fake-claude-cli.mjs` validates structured flags, emits deterministic stream events, records argv/stdin, and can simulate crashes, split UTF-8/JSONL chunks, idle processes, and final output without a trailing newline.
- `tests/fixtures/claude-code/streams/*.jsonl` cover basic text, tool use/results, error results, and malformed/split stream handling.

Focused validation commands:

```bash
npx tsx --test --test-force-exit \
  tests/claude-code-jsonl-parser.test.ts \
  tests/claude-code-bridge-translation.test.ts \
  tests/claude-code-bridge-lifecycle.test.ts \
  tests/claude-code-status-models.test.ts \
  tests/session-setup-claude-code-preexisting.test.ts \
  tests/session-manager-claude-restart.test.ts \
  tests/session-runtime-selection.test.ts

npx playwright test \
  tests/e2e/claude-code-status-api.spec.ts \
  tests/e2e/claude-code-runtime-api.spec.ts \
  tests/e2e/ui/claude-code-ui.spec.ts \
  tests/ui-fixtures/model-selector-fixture.spec.ts \
  tests/ui-fixtures/settings-admin-fixture.spec.ts
```

Before shipping runtime changes, also run:

```bash
npm run check
npm run test:unit
npm run test:e2e
```
