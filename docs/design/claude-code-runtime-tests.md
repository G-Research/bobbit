# Claude Code Runtime — Test Plan

## Scope

This document is the test design for adding a `claude-code` session runtime backed by the local Claude Code CLI structured `stream-json` protocol. It focuses on tests and fixtures only; production implementation details are included only where needed to define observable contracts.

The existing test surface already has useful patterns:

- `tests/rpc-bridge-spawn-args.test.ts` — pure CLI argument builder tests.
- `tests/rpc-bridge-lifecycle.test.ts` — child-process bridge lifecycle with a tiny fake CLI.
- `tests/rpc-bridge-utf8-split.test.ts` — JSONL chunk/UTF-8 decoder tests.
- `tests/e2e/in-process-mock-bridge.mjs` — drop-in `IRpcBridge` fake for E2E sessions.
- `tests/session-store.test.ts` — persisted session metadata round trips.
- `tests/session-manager-restore.test.ts` — source/persistence guards for restore spawn options.
- `tests/models-api.test.ts` and `tests/e2e/models-api.spec.ts` — `/api/models` registry/API coverage.
- `tests/ui-fixtures/model-selector-fixture.spec.ts` — file:// unit-browser coverage for `ModelSelector` behavior.
- `tests/e2e/ui/image-model-selector-lock.spec.ts` and `tests/e2e/ui/session-interactions.spec.ts` — picker/session/reload E2E patterns.

## Fake Claude CLI and JSONL fixtures

Add a reusable fake CLI so unit/API/browser tests never require a real Claude Code install or Anthropic account.

### Files to add

- `tests/fixtures/claude-code/fake-claude-cli.mjs`
- `tests/fixtures/claude-code/streams/basic-text.jsonl`
- `tests/fixtures/claude-code/streams/tool-use.jsonl`
- `tests/fixtures/claude-code/streams/error-result.jsonl`
- `tests/fixtures/claude-code/streams/malformed-and-split.jsonl`

### Fake CLI behavior

`fake-claude-cli.mjs` should support these modes through env vars or args:

- `--version` prints a deterministic version, e.g. `1.2.3-test`.
- Probe/auth mode returns either success or an auth-looking failure based on `FAKE_CLAUDE_AUTH=ok|missing|expired`.
- Runtime mode validates Bobbit passes structured flags:
  - `--print`
  - `--input-format stream-json`
  - `--output-format stream-json`
  - `--verbose`
  - `--replay-user-messages`
- Runtime mode reads stdin JSONL and writes stdout JSONL.
- It should emit one complete line at a time by default, and optionally split lines/UTF-8 bytes when `FAKE_CLAUDE_SPLIT=1` to exercise decoder behavior.
- It should record received stdin into `FAKE_CLAUDE_RECORD_PATH` for assertions about prompt, abort, model, permission mode, effort, and resume commands.

### Fixture event shapes

Use fixture JSONL that mirrors current Claude Code `stream-json` shapes but stays minimal:

```jsonl
{"type":"system","subtype":"init","session_id":"claude-sess-1","model":"sonnet","cwd":"/tmp/project","tools":["Read","Bash"],"permissionMode":"default"}
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Hello"}]}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hi "}]}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"there"}]}}
{"type":"result","subtype":"success","session_id":"claude-sess-1","result":"Hi there","is_error":false,"total_cost_usd":0.001,"usage":{"input_tokens":10,"output_tokens":2}}
```

Tool fixture:

```jsonl
{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"Read","input":{"file_path":"README.md"}}]}}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"# README"}]}}
{"type":"result","subtype":"success","session_id":"claude-sess-1","result":"Done","is_error":false}
```

Error fixture:

```jsonl
{"type":"system","subtype":"init","session_id":"claude-sess-err","model":"opus"}
{"type":"result","subtype":"error_during_execution","session_id":"claude-sess-err","is_error":true,"result":"Claude Code authentication required"}
```

## Unit tests: parser and event translation

### Final unit coverage

The implementation split the original parser, bridge, status/model, and session setup assertions across:

- `tests/claude-code-jsonl-parser.test.ts`
- `tests/claude-code-bridge-translation.test.ts`
- `tests/claude-code-bridge-lifecycle.test.ts`
- `tests/claude-code-status-models.test.ts`
- `tests/session-runtime-selection.test.ts`
- `tests/session-setup-claude-code-preexisting.test.ts`
- `tests/session-manager-claude-restart.test.ts`

### Parser tests

`tests/claude-code-jsonl-parser.test.ts` should drive the parser directly, equivalent to `tests/rpc-bridge-utf8-split.test.ts`:

- Parses multiple complete JSONL lines.
- Buffers incomplete trailing fragments until newline.
- Skips blank/non-JSON diagnostic lines without failing the stream.
- Reassembles multibyte UTF-8 split across chunks.
- Emits a structured parse warning/error event for malformed JSON only if the implementation intentionally surfaces it; otherwise assert malformed lines are ignored consistently.

### Event translation tests

`tests/claude-code-bridge-translation.test.ts` should translate fixture events into Bobbit-compatible events.

Required assertions:

- `system/init` persists or exposes the Claude Code session id separately from the Bobbit session id.
- `user` replay becomes a Bobbit user `message_end`-style event with text content.
- assistant text chunks become assistant streaming/update events and terminate with an assistant end event on `result`.
- multiple assistant text messages coalesce or stream in order without duplicate final text.
- `tool_use` maps to a Bobbit-renderable tool start/use event with `id`, `name`, and `input`.
- `tool_result` maps to a matching tool result event with `tool_use_id` and content.
- `result.subtype=success` marks the turn idle/done and carries usage/cost when present.
- `result.is_error=true` maps to session error/end state with the result text visible.
- Unknown Claude event types do not crash translation; they should be ignored or forwarded as diagnostic events.

### Bridge lifecycle tests

`tests/claude-code-bridge-lifecycle.test.ts` should mirror `tests/rpc-bridge-lifecycle.test.ts` with the fake CLI:

- Spawns fake CLI with exact structured flags.
- Sends prompts over stdin as JSONL, not argv or terminal text.
- Rejects a pending prompt exactly once when fake CLI exits mid-turn.
- `stop()` is idempotent after child exit.
- `abort()` sends the expected structured interrupt/abort request or kills the child, depending on MVP behavior; assert the documented behavior exactly.
- `resume` passes the previous Claude Code session id when the implementation supports it; otherwise assert the MVP explicitly does not attempt resume and records that limitation.

### Runtime config/status tests

The planned standalone `tests/claude-code-runtime-config.test.ts` was superseded by final coverage in `tests/claude-code-status-models.test.ts`, `tests/session-runtime-selection.test.ts`, `tests/session-setup-claude-code-preexisting.test.ts`, and the Claude Code runtime API suites. Together they cover:

- Default executable path is `claude`.
- Default visible alias is `local-claude-opus-4-8`; visible model rows are `local-claude-opus-4-8` and `local-claude-sonnet-4-6`.
- CLI model forwarding strips only the `local-` prefix, so the fake CLI should see `claude-opus-4-8` / `claude-sonnet-4-6`.
- Permission mode accepts only `default`, `acceptEdits`, and `bypassPermissions` as saved/configured values; normal fresh editable sessions default to `acceptEdits`, explicit `default` is preserved, and read-only sessions force CLI `plan` mode.
- `bypassPermissions` is rejected unless the explicit enable flag/preference is set.
- Claude credentials are never added to Docker sandbox credential mounts by default. If implemented as a source guard, keep it narrow and explicit, similar to `tests/spawn-env.test.ts`.

## API/session tests

### Files to add or update

- `tests/e2e/claude-code-runtime-api.spec.ts`
- `tests/e2e/claude-code-status-api.spec.ts`
- `tests/e2e/claude-code-confirmation-localhost.spec.ts`
- `tests/session-runtime-selection.test.ts`
- `tests/session-setup-claude-code-preexisting.test.ts`
- `tests/session-manager-claude-restart.test.ts`
- `tests/claude-code-status-models.test.ts`

### `/api/models` and readiness

Coverage:

- `/api/models` includes local Claude Code models, provider `claude-code`, ids `local-claude-opus-4-8` and `local-claude-sonnet-4-6`, display label indicating local runtime/auth.
- When fake CLI `--version` succeeds and auth probe succeeds, models are `authenticated: true` and `sessionSelectable: true`.
- When `claude` is missing or auth probe fails, models are visible but cleanly unavailable:
  - `authenticated: false` or `sessionSelectable: false` as chosen by implementation.
  - `sessionUnavailableReason` mentions local Claude Code install/auth without saying billing bypass.
- Model registry cache invalidates when `claudeCode.executablePath`, model alias, or auth status preferences change.

### Runtime selection API

`tests/e2e/claude-code-runtime-api.spec.ts` should run against the in-process harness with `FAKE_CLAUDE_PATH`/preference pointing to `fake-claude-cli.mjs`.

Required cases:

- `POST /api/sessions` with model/runtime `claude-code/local-claude-sonnet-4-6` creates a session whose persisted metadata includes:
  - `runtime: "claude-code"` or equivalent runtime discriminator.
  - `modelProvider: "claude-code"`.
  - `modelId: "local-claude-sonnet-4-6"`.
  - `claudeCodeSessionId` only after the fake CLI emits `system/init`.
  - permission mode used for spawn.
- `GET /api/sessions/:id` and `GET /api/sessions` return runtime metadata needed by the UI after reload.
- Prompting the session uses the Claude Code bridge, not the Pi `RpcBridge` path. Assert via fake CLI record file or a server-side test hook.
- Existing Pi sessions still create with no runtime field or with `runtime: "pi"`, and their behavior remains unchanged.
- `set_model` from a Pi-backed session to `claude-code/local-claude-sonnet-4-6` is rejected with a clear restart-required error. Same-runtime Claude Code alias changes are allowed only while idle and resume through the CLI.
- Runtime metadata survives gateway restart: create Claude Code session, wait for fake `system/init`, restart harness, fetch/open session, assert runtime/model/Claude session id persist.

### Session store and restore

Update `tests/session-store.test.ts`:

- Round-trip new persisted fields, likely:
  - `runtime`
  - `claudeCodeSessionId`
  - `claudeCodeModelAlias`
  - `claudeCodePermissionMode`

Update `tests/session-manager-restore.test.ts`:

- Restore chooses the `ClaudeCodeBridge` when persisted runtime is `claude-code`.
- Restore passes persisted Claude Code session id to resume when supported.
- Persisted Claude Code model/provider wins over default session model fallback, mirroring the existing persisted model guard.

## Browser E2E

### Files to add or update

- `tests/e2e/ui/claude-code-ui.spec.ts`
- `tests/ui-fixtures/model-selector-fixture.spec.ts`
- `tests/ui-fixtures/settings-admin-fixture.spec.ts`

### Model selector unit-browser fixture

Update `tests/ui-fixtures/model-selector-fixture.spec.ts` with local fixture models:

- An available `claude-code/local-claude-sonnet-4-6` row renders provider badge text like `Claude Code (local)` or other final label.
- An unavailable row is dimmed/disabled with `data-session-unavailable="true"` and a title mentioning local Claude Code install/auth.
- Auth-disabled copy must not mention API keys as the primary action if the chosen UX is Claude Code account login.
- Selecting an available Claude Code row invokes `onSelect` with `{ provider: "claude-code", id: "local-claude-sonnet-4-6" }`.

### Full browser E2E

`tests/e2e/ui/claude-code-ui.spec.ts` uses `gateway-harness.js`, the fake CLI, and existing helpers from `tests/e2e/ui/ui-helpers.ts`.

Required journeys:

1. **Picker appearance/status**
   - Open a session.
   - Click `[data-testid="footer-model-id"]`.
   - Search `claude code` or `sonnet`.
   - Assert the row appears with a local-runtime provider badge and readiness state.

2. **Unavailable/not-authenticated state**
   - Configure fake CLI auth failure.
   - Open picker.
   - Assert row is disabled/dimmed and tooltip/status text is clear.
   - Clicking does not change footer model or send `set_model`.

3. **Create/select Claude Code session**
   - Configure fake CLI auth success.
   - Create a session directly with `claude-code/local-claude-sonnet-4-6`, or select it before first prompt if the UI supports pre-session runtime selection.
   - Send a message.
   - Assert user echo and assistant fake response render in order, with timestamps visible/hydratable.
   - Assert fake CLI record file contains the structured stdin prompt.

4. **Runtime switch guard**
   - Start with a Pi/mock session.
   - Attempt to pick `claude-code/local-claude-sonnet-4-6`.
   - Assert a restart-required/new-session prompt appears. Do not allow silent in-place runtime switch.

5. **Reload persistence**
   - Open a Claude Code session, wait for idle, reload page.
   - Assert footer still shows `local-claude-sonnet-4-6` and session metadata still identifies local Claude Code runtime.
   - Send another message after reload if restore/resume is available; otherwise assert the documented limitation/status is visible.

## Commands to run

Targeted during development:

```bash
npx tsx --test --test-force-exit tests/claude-code-jsonl-parser.test.ts
npx tsx --test --test-force-exit tests/claude-code-bridge-translation.test.ts
npx tsx --test --test-force-exit tests/claude-code-bridge-lifecycle.test.ts
npx tsx --test --test-force-exit tests/claude-code-status-models.test.ts
npx tsx --test --test-force-exit tests/session-runtime-selection.test.ts tests/session-setup-claude-code-preexisting.test.ts tests/session-manager-claude-restart.test.ts
npx playwright test tests/e2e/claude-code-status-api.spec.ts tests/e2e/claude-code-runtime-api.spec.ts tests/e2e/claude-code-confirmation-localhost.spec.ts
npx playwright test tests/e2e/ui/claude-code-ui.spec.ts
npx playwright test tests/ui-fixtures/model-selector-fixture.spec.ts tests/ui-fixtures/settings-admin-fixture.spec.ts
```

Final verification:

```bash
npm run check
npm run test:unit
npm run test:e2e
```

## Flaky-risk mitigations

- Never call a real `claude` binary in automated tests; always use `fake-claude-cli.mjs` or an injected probe function.
- Avoid fixed sleeps. Wait for explicit events/status via helpers such as `waitForSessionStatus`, Playwright locators, or fake CLI record-file polling with bounded retries.
- Keep the fake CLI stateless per process/session; use temp dirs and per-test record paths.
- Make `/api/models` readiness tests invalidate the model cache after preference changes.
- Use one worker-scoped gateway fixture state carefully: reset Claude Code preferences/auth mode in `afterEach` so model readiness does not leak between tests.
- Test split JSONL/UTF-8 in unit tests, not browser E2E.
- Browser E2E should assert stable `data-testid`/`data-*` attributes, not icon SVG shape or full class strings.
- If restart/resume is not reliable in MVP, make the visible limitation the assertion instead of waiting for a live Claude turn after restart.
