# Summary

This is the CC-841 reconciliation note for upstream PR #841, "Add Claude Code local runtime", against `aj-current`.

Verification caveat: the required GitHub reads could not be completed in this environment. Both attempts to run `gh pr view 841 --repo G-Research/bobbit --json title,state,body,files` failed with `error connecting to api.github.com`; because of the read-only/one-retry instruction, no `gh pr diff` sample could be fetched. The exact upstream PR state, body, and file list are therefore unverified here. The reconciliation below uses the verified `aj-current` inventory plus local Git provenance from the Claude Code runtime lineage, especially commits such as `bc2f2970 Add Claude Code stream bridge`, `c8c1e1cb Add Claude Code session runtime persistence`, `4c5fb6c7 Add Claude Code picker settings UI`, `8ec34f3b Fix Claude Code readiness review gaps`, `7df997e2 Allow Claude Code alias switching`, `01489efb Harden Claude Code preference confirmations`, `7e8a5766 Hydrate Claude Code snapshots from transcript`, and `b54c57b7 Fix Claude Code attach snapshot hydration`.

AJ's framing for this lane should be kept explicit: this is lower priority, and the hope is not to need this runtime long-term. It is still worth preserving as a showcase integration across UI, sub-agents/workflow expectations, runtime switching, hooks, and local host-runtime safety.

# PR #841 Overview (state, scope, file list)

State: unverified. `gh pr view` could not reach GitHub after one retry, so the PR may be open, merged, closed, or changed since local history was fetched.

Scope, inferred from title and local Claude Code runtime lineage: PR #841 appears to add a host-local Claude Code session runtime that starts the user's `claude` CLI, speaks Claude Code's structured stream JSON protocol, exposes synthetic `claude-code/*` model rows, stores runtime metadata on sessions, surfaces settings/status controls, and adds tests around fake Claude CLI fixtures.

Verified local historical file set that likely overlaps #841:

- `src/server/agent/claude-code-bridge.ts`
- `src/server/agent/claude-code-stream.ts`
- `src/server/agent/claude-code-config.ts`
- `src/server/agent/claude-code-status.ts`
- `src/server/agent/session-runtime.ts`
- `src/server/agent/session-store.ts`
- `src/server/agent/session-manager.ts`
- `src/server/agent/session-setup.ts`
- `src/server/agent/model-registry.ts`
- `src/server/agent/rpc-bridge.ts`
- `src/server/server.ts`
- `src/server/ws/handler.ts`
- `src/server/auth/oauth.ts`
- `src/app/session-manager.ts`
- `src/app/settings-page.ts`
- `src/ui/components/AgentInterface.ts`
- `src/ui/dialogs/ModelSelector.ts`
- `docs/claude-code-runtime.md`
- `docs/features.md`
- `docs/websocket-protocol.md`
- `tests/claude-code-jsonl-parser.test.ts`
- `tests/claude-code-bridge-translation.test.ts`
- `tests/claude-code-bridge-lifecycle.test.ts`
- `tests/claude-code-status-models.test.ts`
- `tests/session-runtime-selection.test.ts`
- `tests/session-store.test.ts`
- `tests/session-setup-claude-code-preexisting.test.ts`
- `tests/e2e/claude-code-status-api.spec.ts`
- `tests/e2e/claude-code-runtime-api.spec.ts`
- `tests/e2e/claude-code-confirmation-auth.spec.ts`
- `tests/e2e/claude-code-confirmation-localhost.spec.ts`
- `tests/e2e/ui/claude-code-ui.spec.ts`
- `tests/fixtures/claude-code/fake-claude-cli.mjs`
- `tests/fixtures/claude-code/streams/*.jsonl`

# aj-current Existing Claude Code Surface (inventory with file paths)

`aj-current` already has a first-class Claude Code runtime surface.

- `src/server/agent/claude-code-bridge.ts`: `ClaudeCodeBridge` starts the local `claude` process with `--print`, `--input-format stream-json`, `--output-format stream-json`, `--verbose`, `--replay-user-messages`, optional `--model`, `--append-system-prompt`, `--permission-mode`, `--effort`, and `--resume`. It rejects sandbox/container execution, sanitizes env through `buildClaudeCodeSanitizedEnv()`, maps read-only sessions to `plan`, and supports idle alias switching via restart/resume.
- `src/server/agent/claude-code-stream.ts`: parses Claude Code JSONL, captures `session_id` into `claudeCodeSessionId`, translates stream events into Bobbit `message_*`, tool, usage, timing, and state events, and normalizes supported `ask_user_choices`.
- `src/server/agent/claude-code-config.ts`: owns preferences (`claudeCode.executablePath`, `.defaultModel`, `.permissionMode`, `.allowBypassPermissions`), model aliases (`local-claude-opus-4-8`, `local-claude-sonnet-4-6`), executable validation/resolution, sanitized env construction, and sensitive preference confirmation classification.
- `src/server/agent/claude-code-status.ts`: provides `getClaudeCodeStatus()`, `probeClaudeCodeStatus()`, a 5s cache, `--version` probing, model alias metadata, and explicit auth-unknown behavior because there is no documented safe authenticated no-op probe.
- `src/server/agent/session-runtime.ts`: is the runtime dispatch seam. `resolveSessionRuntime()`, `runtimeFromModelString()`, `hydrateRuntimeOptions()`, `assertRuntimeSwitchAllowed()`, `assertRuntimeAllowedForSession()`, and `createSessionBridge()` route `claude-code` sessions to a lazy-loaded `ClaudeCodeBridge` and keep legacy sessions on Pi.
- `src/server/agent/session-store.ts`: persists `runtime`, `modelProvider`, `modelId`, `claudeCodeSessionId`, `claudeCodeExecutable`, `claudeCodePermissionMode`, and `claudeCodeModelAlias`.
- `src/server/agent/session-manager.ts`: extracts Claude Code session ids, persists Claude Code transcript fallback rows under `claude-code-transcripts`, hydrates snapshots through `hydrateClaudeCodeSnapshotMessages()`, preserves runtime metadata for respawn/continue/fork paths, and reads persisted Claude Code messages when no Pi `agentSessionFile` exists.
- `src/server/ws/handler.ts`: on WebSocket attach, sends a Claude Code-specific initial `messages` snapshot by calling `sessionManager.hydrateClaudeCodeSnapshotMessages()` so local-runtime sessions hydrate after reload/restart even if the live bridge is empty.
- `src/server/server.ts`: exposes `/api/claude-code/status`, `/api/claude-code/status/refresh`, sensitive preference confirmation at `/api/preferences/claude-code/confirmation`, preference normalization/confirmation checks in `PUT /api/preferences`, and `/api/models` synthetic Claude Code rows through `getAvailableModels()`.
- `src/server/agent/model-registry.ts`: emits synthetic `claude-code` models with `api: "claude-code-runtime"`, `runtime: "claude-code"`, `localRuntime: true`, `runtimeLabel: "Claude Code (local)"`, `sessionSelectable`, and unavailable reasons.
- `src/server/auth/oauth.ts`: Anthropic OAuth remains wired for the existing Bobbit/Pi provider auth surface. It is adjacent, not the runtime auth mechanism; Claude Code runtime uses the local CLI's own login.
- `src/app/settings-page.ts`: restores the Settings -> Models Claude Code section, status loading, refresh/status copy, executable/default model/permission/bypass controls, and operator confirmation flow for sensitive host-runtime preferences.
- `src/app/session-manager.ts`: hydrates `AgentInterface` with `sessionRuntime`, `runtimeLabel`, `claudeCodeSessionId`, and `claudeCodeModelAlias` from session list/detail payloads.
- `src/ui/dialogs/ModelSelector.ts`: treats `claude-code` rows as local runtime models, labels them "Claude Code (local)", avoids normal token/cost copy, and shows runtime-specific explanatory text.
- `src/ui/components/AgentInterface.ts`: displays runtime metadata in the footer and the Claude Code capability notice, including local runtime limitations and docs link.
- `docs/claude-code-runtime.md`, `docs/features.md`, `docs/websocket-protocol.md`: document runtime semantics, status/settings, resume, alias switching, read-only `plan`, transcript hydration, and runtime switch rejection.

# Reconciliation

Because the actual PR #841 file list could not be fetched, the table uses the locally verified likely #841 files. Re-run the `gh pr view`/`gh pr diff` commands before implementation and replace any inferred rows with exact upstream rows.

| File | #841 Role | aj-current Counterpart | Disposition | Notes |
| --- | --- | --- | --- | --- |
| `src/server/agent/claude-code-bridge.ts` | Core local CLI bridge and process lifecycle | Same file | MERGE-CAREFULLY | aj-current already has bridge args, env sanitization, read-only `plan`, `--resume`, `--effort`, stderr diagnostics, abort, and alias restart/resume. Take only missing translator/lifecycle fixes from #841; do not replace wholesale. |
| `src/server/agent/claude-code-stream.ts` | JSONL parser and stream translator | Same file | MERGE-CAREFULLY | Current translator includes usage/timing and supported Ask User Question normalization. Preserve placeholder/error normalization and timestamp/hydration assumptions. |
| `src/server/agent/claude-code-config.ts` | Preferences, aliases, executable/env validation | Same file | MERGE-CAREFULLY | Current security posture is stricter: host executable is user/admin preference only, project config cannot control executable, bypass requires opt-in. Do not regress confirmation-gated sensitive keys. |
| `src/server/agent/claude-code-status.ts` | CLI readiness probe | Same file | MERGE-CAREFULLY | Current route intentionally treats auth as unknown after `--version` success. Take only better error parsing if #841 has it. |
| `src/server/agent/session-runtime.ts` | Runtime dispatch seam | Same file | CONFLICTS-WITH | This is the current single seam for Pi vs Claude Code. Any #841 direct `RpcBridge` construction must be refactored through `createSessionBridge()` / `hydrateRuntimeOptions()`. |
| `src/server/agent/session-store.ts` | Persist runtime metadata | Same file | MERGE-CAREFULLY | Current store already persists Claude Code metadata. Ensure #841 does not drop recent side-panel/worktree/store fields while editing `PersistedSession` / `UpdatableSessionFields`. |
| `src/server/agent/session-manager.ts` | Creation, restore, respawn, transcript handling | Same file | CONFLICTS-WITH | Current branch has restored transcript fallback and `hydrateClaudeCodeSnapshotMessages()`. Avoid any #841 restore path that assumes Pi `switch_session` or requires `agentSessionFile` for Claude Code. |
| `src/server/agent/session-setup.ts` | Creation/setup integration | Same file | MERGE-CAREFULLY | Preserve current runtime forwarding and sandbox/read-only decisions. Claude Code remains host-only. |
| `src/server/agent/model-registry.ts` | Synthetic model rows | Same file | MERGE-CAREFULLY | Keep synthetic rows visible even in AI Gateway exclusive mode. Preserve `sessionSelectable` and unavailable reason semantics. |
| `src/server/agent/rpc-bridge.ts` | Shared bridge interface extensions | Same file | MERGE-CAREFULLY | Only take interface additions required by the current lazy bridge. Avoid making Pi-only commands mandatory for Claude Code. |
| `src/server/server.ts` | REST routes, preferences, models, sessions | Same file | CONFLICTS-WITH | Recent route restorations are critical: `/api/claude-code/status`, `/api/claude-code/status/refresh`, and `/api/preferences/claude-code/confirmation` must remain. Do not drop operator-cookie restrictions or model cache invalidation. |
| `src/server/ws/handler.ts` | WebSocket attach/snapshot behavior | Same file | CONFLICTS-WITH | Current attach path pushes hydrated messages for Claude Code sessions. Any #841 attach behavior that relies on Pi session file snapshots is superseded. |
| `src/server/auth/oauth.ts` | Anthropic OAuth surface | Same file | SKIP | Claude Code runtime should not depend on Bobbit Anthropic OAuth. It uses the user's local Claude Code login through the CLI. Keep existing OAuth provider work unless #841 contains unrelated fixes. |
| `src/app/settings-page.ts` | Settings UI for status/preferences | Same file | CONFLICTS-WITH | The current settings surface was recently restored and includes confirmation error surfacing. Preserve `data-testid='claude-code-section'` behavior pinned by UI E2E. |
| `src/app/session-manager.ts` | Client session metadata hydration | Same file | MERGE-CAREFULLY | Keep runtime metadata propagation into `AgentInterface`; this pins reload/footer correctness. |
| `src/ui/dialogs/ModelSelector.ts` | Runtime model picker rows | Same file | MERGE-CAREFULLY | Preserve no-silent-runtime-switch UX: Pi -> Claude Code selection creates a new session, same-runtime alias switches can stay in-session while idle. |
| `src/ui/components/AgentInterface.ts` | Footer runtime display and capability notice | Same file | MERGE-CAREFULLY | Keep capability notice and runtime footer metadata; do not regress usage hydration restored by recent follow-ups. |
| `docs/claude-code-runtime.md` | Runtime reference docs | Same file | MERGE-CAREFULLY | Current docs are more complete on hydration/status/settings/security. Use #841 docs only for gaps. |
| `docs/features.md` | Feature summary | Same file | MERGE-CAREFULLY | Preserve notes about transcript fallback, pending ask widgets, timing, and local runtime ownership. |
| `docs/websocket-protocol.md` | Runtime switch semantics | Same file | MERGE-CAREFULLY | Preserve explicit `RUNTIME_SWITCH_REQUIRES_NEW_SESSION` semantics. |
| `tests/claude-code-jsonl-parser.test.ts` | Parser unit coverage | Same file | TAKE | Add upstream cases if missing. Low conflict if translator expectations stay current. |
| `tests/claude-code-bridge-translation.test.ts` | Stream translation coverage | Same file | MERGE-CAREFULLY | Add fixtures only if they preserve current ask/timing/error behavior. |
| `tests/claude-code-bridge-lifecycle.test.ts` | Bridge process lifecycle | Same file | MERGE-CAREFULLY | Current tests pin args, resume token validation, alias switching, effort, and abort. Add missing process cases; do not relax assertions. |
| `tests/claude-code-status-models.test.ts` | Status/config/model registry units | Same file | MERGE-CAREFULLY | Preserve security assertions for executable validation, trusted PATH, env sanitization, and project config boundaries. |
| `tests/session-runtime-selection.test.ts` | Runtime seam unit coverage | Same file | TAKE | Keep or extend. This is the key low-cost guard for runtime dispatch. |
| `tests/session-store.test.ts` | Persisted metadata coverage | Same file | MERGE-CAREFULLY | Add #841 metadata cases if absent, but do not disturb existing broad session-store invariants. |
| `tests/session-setup-claude-code-preexisting.test.ts` | Setup/preexisting transcript behavior | Same file | MERGE-CAREFULLY | Ensure it aligns with current transcript fallback and no Pi replay for Claude Code. |
| `tests/e2e/claude-code-status-api.spec.ts` | Status/model/preference API E2E | Same file | MERGE-CAREFULLY | Current spec pins missing CLI, refresh cache, project-scoped config ignored for executable, and confirmation security. Do not weaken. |
| `tests/e2e/claude-code-runtime-api.spec.ts` | Session API/runtime E2E | Same file | MERGE-CAREFULLY | Current spec pins create, persisted metadata, hydrated preferences, bypass opt-in, and same-session alias switch. |
| `tests/e2e/claude-code-confirmation-auth.spec.ts` | Auth-mode confirmation E2E | Same file | TAKE | Keep as a regression guard for operator elevation/confirmation. |
| `tests/e2e/claude-code-confirmation-localhost.spec.ts` | Localhost confirmation E2E | Same file | TAKE | Keep as a regression guard for localhost operator bootstrap. |
| `tests/e2e/ui/claude-code-ui.spec.ts` | Browser E2E | Same file | CONFLICTS-WITH | Current spec pins model picker new-session flow, runtime metadata reload, and settings controls. Any #841 UI should be reconciled against these user-visible behaviors. |
| `tests/fixtures/claude-code/fake-claude-cli.mjs` | Fake CLI test harness | Same file | TAKE | Take upstream fixture improvements if they support current flags (`--permission-mode`, `--model`, `--resume`, `--effort`). |
| `tests/fixtures/claude-code/streams/*.jsonl` | Stream fixtures | Same files | TAKE | Additive fixtures are safe if expected translator behavior remains current. |

# Conflicts Deep-Dive (the hydration/status/settings surface and runtime dispatch seam specifically)

Hydration/status/settings are the highest-risk area because recent `aj-current` work specifically restored behavior that earlier integration merges had dropped.

Hydration: `src/server/agent/session-manager.ts::persistClaudeCodeMessageToTranscript()` writes Claude Code `message_end` rows to a Bobbit-owned transcript fallback when the session is `claude-code`. `getPersistedSessionMessages(..., { claudeCodeOnly: true })` reads that fallback with timestamps and narrow Ask User Question repair. `hydrateClaudeCodeSnapshotMessages()` prefers persisted Claude Code history when the live bridge snapshot is empty or shorter. `src/server/ws/handler.ts` calls this on attach and sends a `messages` snapshot for Claude Code sessions. This must survive any #841 merge because Claude Code does not always have a Pi `agentSessionFile`, and after gateway restart the lazy bridge may not have the historical in-memory transcript.

Status/settings: `src/server/server.ts` currently owns three restored surfaces: `GET /api/claude-code/status`, `POST /api/claude-code/status/refresh`, and `POST /api/preferences/claude-code/confirmation`. `PUT /api/preferences` detects `claudeCode.*` changes, requires operator confirmation for sensitive executable/bypass mutations, normalizes the patch, invalidates Claude Code status/model caches, and broadcasts preferences. `src/app/settings-page.ts` depends on those routes for the Settings -> Models Claude Code section. This surface is pinned by `tests/e2e/claude-code-status-api.spec.ts`, `tests/e2e/claude-code-confirmation-auth.spec.ts`, `tests/e2e/claude-code-confirmation-localhost.spec.ts`, and `tests/e2e/ui/claude-code-ui.spec.ts`.

Runtime dispatch seam: `src/server/agent/session-runtime.ts` is now the single place that maps `claude-code/<alias>` and `modelProvider: "claude-code"` into `runtime: "claude-code"`, hydrates runtime options from defaults, rejects Pi/Claude Code in-session runtime switches, rejects sandboxed Claude Code sessions, and lazy-loads `ClaudeCodeBridge`. Any #841 code that directly imports `ClaudeCodeBridge` from session creation paths, or that treats Claude Code as merely another API provider in the Pi `RpcBridge`, conflicts with this seam. Preserve `RuntimeSwitchError` and `RUNTIME_SWITCH_REQUIRES_NEW_SESSION`.

# Implementation Plan (ordered phases)

1. Re-fetch #841 metadata and diff when GitHub is reachable: run `gh pr view 841 --repo G-Research/bobbit --json title,state,body,files` and sample `gh pr diff 841 --repo G-Research/bobbit | head -c 200000`. Replace the inferred table above with the exact upstream file list before editing code.
2. Classify #841 changes against current tests before touching source. Mark each hunk as additive fixture/test, bridge/translator improvement, stale duplicate, or conflict with hydration/status/settings/runtime seam.
3. Phase 1 slice: take only additive tests/fixtures and low-conflict bridge/stream parser fixes that do not alter REST routes, settings UI, session restore, or runtime dispatch. This extracts value while minimizing regression risk.
4. Phase 2: reconcile bridge/config/status improvements. Apply hunk-by-hunk into `claude-code-bridge.ts`, `claude-code-stream.ts`, `claude-code-config.ts`, and `claude-code-status.ts`, preserving current env sanitization, permission defaults, `plan` mapping, `--resume`, `--effort`, and auth-unknown status semantics.
5. Phase 3: reconcile session lifecycle only through `session-runtime.ts` and current `SessionManager` hooks. Do not add parallel Claude Code construction paths. Preserve transcript fallback and WebSocket attach hydration.
6. Phase 4: reconcile UI only after server behavior is stable. Preserve settings tests ids, confirmation flow, local runtime model picker copy, new-session runtime switch dialog, footer runtime metadata, and capability notice.
7. Phase 5: docs update. Update `docs/claude-code-runtime.md`, `docs/features.md`, and `docs/websocket-protocol.md` only for behavior that actually remains after reconciliation.
8. Phase 6: run the focused unit/API/browser suites listed below, then `npm run check`. If server/session lifecycle code changes, run `npm run test:e2e`; if restart/session lifecycle changed materially, schedule `npm run test:manual` as the gate-exempt real-agent path.

# Test Strategy (existing specs that pin current behavior)

Existing tests to preserve and run during reconciliation:

- `tests/claude-code-jsonl-parser.test.ts`: JSONL parser robustness.
- `tests/claude-code-bridge-translation.test.ts`: stream translation, session id capture, tool/usage/timing normalization.
- `tests/claude-code-bridge-lifecycle.test.ts`: bridge args, prompt lifecycle, abort, resume token validation, alias switching, effort mapping.
- `tests/claude-code-status-models.test.ts`: executable validation, sanitized env, readiness status, synthetic model rows, unavailable reasons.
- `tests/session-runtime-selection.test.ts`: runtime selection, model alias parsing, runtime switch rejection, sandbox rejection, hydrated options.
- `tests/session-store.test.ts`: Claude Code runtime metadata disk round-trip.
- `tests/session-setup-claude-code-preexisting.test.ts`: setup behavior for preexisting Claude Code sessions.
- `tests/ws-claude-snapshot-hydration.test.ts`: WebSocket attach snapshot hydration for Claude Code.
- `tests/session-manager-claude-restart.test.ts`: restart/transcript hydration and resume behavior from local provenance.
- `tests/e2e/claude-code-status-api.spec.ts`: status/model APIs, cache refresh, project config boundary, sensitive preference protection.
- `tests/e2e/claude-code-runtime-api.spec.ts`: session creation, hydrated preferences, persisted runtime metadata, alias restart/resume.
- `tests/e2e/claude-code-confirmation-auth.spec.ts`: auth-mode operator confirmation path.
- `tests/e2e/claude-code-confirmation-localhost.spec.ts`: localhost operator bootstrap/confirmation path.
- `tests/e2e/ui/claude-code-ui.spec.ts`: model picker runtime switch UX, runtime metadata surviving reload, settings status/controls.
- `tests/ui-fixtures/model-selector-fixture.spec.ts` and `tests/ui-fixtures/settings-admin-fixture.spec.ts`: lower-level UI fixture coverage for model/settings affordances.

Minimum focused command set for a docs-to-code reconciliation branch:

```bash
npm run test:unit -- tests/claude-code-jsonl-parser.test.ts tests/claude-code-bridge-translation.test.ts tests/claude-code-bridge-lifecycle.test.ts tests/claude-code-status-models.test.ts tests/session-runtime-selection.test.ts tests/session-store.test.ts tests/session-setup-claude-code-preexisting.test.ts tests/ws-claude-snapshot-hydration.test.ts tests/session-manager-claude-restart.test.ts
npm run test:e2e -- tests/e2e/claude-code-status-api.spec.ts tests/e2e/claude-code-runtime-api.spec.ts tests/e2e/claude-code-confirmation-auth.spec.ts tests/e2e/claude-code-confirmation-localhost.spec.ts tests/e2e/ui/claude-code-ui.spec.ts
npm run check
```

# Risk Register

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Upstream #841 file list/diff was not verified here | Disposition table may miss or misclassify files | Re-run `gh pr view`/`gh pr diff` before implementation; treat this doc as a local-inventory reconciliation until then. |
| Dropping restored `/api/claude-code/status` or refresh routes | Settings/model picker regress to runtime 404s | Keep `tests/e2e/claude-code-status-api.spec.ts` in the required gate and avoid broad `server.ts` conflict resolution. |
| Dropping operator confirmation restrictions | Host executable/bypass settings become writable from bearer/query/session-bound traffic | Preserve `isHumanOperatorRequest()`, confirmation binding, and confirmation E2Es. |
| Replacing transcript fallback hydration | Claude Code sessions appear empty after reload/restart or pending ask widgets become unanswerable | Preserve `persistClaudeCodeMessageToTranscript()`, `hydrateClaudeCodeSnapshotMessages()`, and WebSocket attach snapshot flow. |
| Bypassing `session-runtime.ts` | Pi/Claude Code runtime switching becomes inconsistent or silently mutates running sessions | Route all creation/restore/respawn through `resolveSessionRuntime()` and `createSessionBridge()`. |
| Treating Claude Code as an API-backed Anthropic provider | Wrong auth semantics, wrong model billing/cost assumptions, confusing UI | Keep synthetic `api: "claude-code-runtime"` rows and local runtime copy. |
| Weakening sandbox boundary | Local CLI or credentials could be exposed inside Bobbit Docker sandbox paths | Preserve `assertRuntimeAllowedForSession()` and `ClaudeCodeBridge.start()` sandbox/container rejection. |
| Overwriting settings UI with older #841 copy | Recent restored status/error/confirmation UX regresses | Reconcile hunk-by-hunk against `tests/e2e/ui/claude-code-ui.spec.ts`. |
| Model alias semantics drift | CLI receives wrong `--model`, restored sessions show stale alias | Preserve `local-*` display aliases and `toClaudeCodeCliModelAlias()` behavior. |
| Long-term priority mismatch | Time spent polishing a runtime AJ hopes not to need | Limit phase 1 to additive tests/fixtures and clear bridge fixes; defer broader UX/lifecycle churn unless needed for showcase value. |
