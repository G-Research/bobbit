# Claude Code local runtime

Bobbit can run a session through the user's local Claude Code CLI instead of the standard Pi-backed session runtime. This is a runtime switch, not another API-backed model provider: Bobbit starts `claude` on the gateway host, talks to its structured `stream-json` stdin/stdout protocol, and relies on the user's existing Claude Code installation and login.

Use this mode when you want Bobbit's session UI, tools, tasks, and persistence around Claude Code's local runtime. Do not describe it as a billing workaround. Usage is governed by the user's Claude Code account, quota, and Anthropic/Claude Code terms.

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

- `--model <alias>` for non-`default` aliases such as `sonnet` or `opus`.
- `--append-system-prompt <text>` with Bobbit's assembled system prompt.
- `--permission-mode acceptEdits|bypassPermissions` for explicit non-default permission modes.
- `--resume <claudeCodeSessionId>` when Bobbit has a previous Claude Code session id.

Claude Code stdout is parsed as JSONL. Bobbit translates Claude Code events into the same live event stream the UI already understands:

| Claude Code event | Bobbit behavior |
|---|---|
| `system` / `init` | Starts the runtime, captures `claudeCodeSessionId`, and records model alias metadata. |
| `user` text replay | Emits a user `message_end`. |
| `assistant` text | Streams assistant `message_update` snapshots. |
| `tool_use` | Emits tool-start style events and includes tool calls in assistant content where renderable. |
| `tool_result` | Emits matching tool-result/end events. |
| `result` | Ends the assistant turn and emits `agent_end`; errors surface as visible assistant errors. |
| non-JSON stdout diagnostics | Kept as diagnostics instead of crashing the session. |

The parser has size limits for JSONL lines, diagnostic lines, per-event content, assistant text, and stored message count so a malformed CLI stream cannot exhaust the gateway process.

## Picker and readiness behavior

`GET /api/models` always emits synthetic Claude Code model rows for the local runtime aliases:

- `claude-code/default`
- `claude-code/sonnet`
- `claude-code/opus`

Picker rows are deliberately labeled as local runtime rows:

- Name: `Claude Code Sonnet`, `Claude Code Opus`, etc.
- Provider/runtime label: `Claude Code (local)`.
- Badge: `Local runtime`.
- Detail text: `Claude Code account`.
- Tooltip when available: `Runs through your local Claude Code CLI and existing Claude Code login.`

Readiness comes from `GET /api/claude-code/status`; `POST /api/claude-code/status/refresh` clears the short status/model cache and re-probes.

The probe resolves the configured executable and runs `--version` with a sanitized environment. Claude Code does not expose a documented safe authenticated no-op probe, so the normal successful state is:

- CLI available.
- `ready: true`.
- `authenticationStatus: "unknown"`.
- Settings text: `CLI available; auth checked at session start`.

If the executable is missing, invalid, not runnable, times out, or reports a login/auth failure, Claude Code rows remain visible but are disabled with a reason-specific badge such as `CLI missing`, `Login required`, or `Probe failed`.

## Configuration

Settings → Models contains a **Claude Code (local)** section. These preferences are saved with the existing preferences API.

| Preference key | Default | Meaning |
|---|---|---|
| `claudeCode.executablePath` | `claude` | Command name on trusted `PATH` or an absolute executable path. Relative paths such as `./claude` are rejected. |
| `claudeCode.defaultModel` | `sonnet` | Default model alias when a Claude Code session is created without a specific `claude-code/<alias>` model. Built-in choices are `default`, `sonnet`, and `opus`; short custom model tokens are accepted. |
| `claudeCode.permissionMode` | `default` | Claude Code permission mode: `default`, `acceptEdits`, or `bypassPermissions`. |
| `claudeCode.allowBypassPermissions` | `false` | Explicit user/admin opt-in required before `bypassPermissions` can be saved or used. |

Project config may provide `claudeCodeDefaultModel` and `claudeCodePermissionMode` for sessions in that project. It cannot choose the host executable or enable bypass mode. If a project requests `bypassPermissions` and the user/admin has not enabled `claudeCode.allowBypassPermissions`, Bobbit downgrades the mode to `default`.

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

`claudeCodeSessionId` is the Claude Code CLI session id. It is separate from Bobbit's session id and is captured from Claude Code stream events.

### No silent runtime switching

Bobbit does not silently convert a running session between Pi and Claude Code.

- Picking a Claude Code row from an existing Pi session opens a confirmation dialog and creates a new top-level Claude Code session from the same working directory.
- Picking a Pi/API-backed model from a Claude Code session follows the same new-session pattern.
- If the UI misses the guard, the bridge/server rejects the runtime-mismatched `set_model` request.
- Changing a Claude Code model alias in-place also requires a new Claude Code session.

This keeps each session tied to the runtime that owns its process, transcript, and resume semantics.

### Continue, fork, restart, and resume

Claude Code resume uses Claude Code's own session id and `--resume`; it does not use Pi's `switch_session` transcript command.

- Restart/restore passes the persisted `claudeCodeSessionId` back to the bridge when available.
- Continue and fork preserve the Claude Code runtime metadata and pass the source `claudeCodeSessionId` into the new session.
- Continue/fork from a Bobbit transcript is not supported for Claude Code unless a Claude Code session id is available.
- Sessions with `runtime: "claude-code"` and a valid `claudeCodeSessionId` can be restored even if they do not have a Pi `agentSessionFile`.

MVP limitations:

- Host-only: Claude Code sessions cannot run in Bobbit Docker sandboxes.
- Live steer is not supported.
- Thinking-level changes are not supported.
- Compaction is not supported.
- In-place alias changes are not supported.
- Auth failures may only appear when the first Claude Code session starts because the readiness probe intentionally avoids an undocumented auth no-op.

Abort terminates the current Claude Code process, emits a visible aborted turn, and allows the next prompt to start a new Claude Code process using the latest known resume id.

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
