# Session runtime identity

## Decision

A session has one runtime, derived from its effective `modelProvider`:

```ts
export type SessionRuntime = "pi" | "claude-agent-sdk";

export function runtimeFromProvider(provider?: string): SessionRuntime;
```

Only `modelProvider === "claude-agent-sdk"` derives `"claude-agent-sdk"`; every other provider, including `anthropic`, derives `"pi"`. Runtime is not a request, preference, or picker selector. The persisted `runtime` property is a denormalized, auditable snapshot used where a model tuple is temporarily unavailable; it must be written from the derivation, never accepted as a user choice.

The canonical resolver must be narrowed to make that rule explicit:

```ts
export function resolveSessionRuntime(input: {
  modelProvider?: string;
  initialModel?: string;
  persistedRuntime?: SessionRuntime;
}): SessionRuntime;
```

Resolution order is a provider from `modelProvider`, then the provider segment of `initialModel`, then `persistedRuntime`, then `"pi"`. Thus a legacy record with neither `runtime` nor a model is Pi; a record with `modelProvider: "claude-agent-sdk"` restores as SDK even if the old field is absent; and a contradictory persisted `runtime` cannot override a present model provider. On the next durable write, normalize the snapshot to the derived value. `runtime` remains optional in `PersistedSession` for disk compatibility.

`src/server/agent/session-runtime.ts` already owns `SessionRuntime`, `runtimeFromProvider`, `resolveSessionRuntime`, and `createSessionBridge`. It is the sole runtime selection seam; do not add another union or provider-name test in the UI, protocol, store, or route code.

## Current state and gaps

G2 already added the bridge and partial persistence:

- `PersistedSession.runtime` and `claudeAgentSdkSessionId` are in `src/server/agent/session-store.ts`.
- `persistOnce()` in `src/server/agent/session-setup.ts` writes `runtime`, and `SessionManager.persistSessionMetadata()` stores the observed SDK session id.
- `SessionManager.restoreSession()` creates a bridge with `resolveSessionRuntime({ runtime: ps.runtime, modelProvider: ps.modelProvider })`; `restoreOneSession()` has SDK resume-id validation.
- `SessionInfo.runtime` exists, but list and REST projections omit it.
- `ApiModel` and `ModelSelector` have session-selectability metadata but no runtime metadata/badge.
- `session_status` has no runtime field.
- Pi-only `switch_session` is still used unconditionally by fresh/worktree continue/fork setup in `session-setup.ts`.

The implementation below completes identity presentation and propagation without duplicating bridge, tool, lifecycle, or transcript systems.

## Data flow

### 1. Selection and creation

1. The existing settings/role picker continues to submit only `provider/modelId` through `src/ui/dialogs/ModelSelector.ts`, `src/app/settings-page.ts::openModelPicker`, and `src/app/remote-agent.ts::RemoteAgent.setModel`.
2. `src/server/agent/model-registry.ts::ApiModel` gains a readonly `runtime: SessionRuntime` projection. `assembleModels()` and custom-provider discovery attach it with `runtimeFromProvider(model.provider)`; they do not add a second selectable value.
3. `src/server/agent/session-setup.ts::resolveSdkRuntimeOptions(plan, ctx)` derives `plan.bridgeOptions.runtime` after `resolveBridgeOptions()` has resolved `initialModel`. It must pass both the resolved initial model and any known provider tuple through the canonical resolver, then `persistOnce()` stores that result.
4. `spawnAgent()` and worktree setup retain `SessionInfo.runtime = plan.bridgeOptions.runtime`; `createSessionBridge()` remains the only bridge factory.
5. `SessionManager.persistSessionModel(sessionId, provider, modelId, thinking)` atomically persists `{ modelProvider, modelId, effectiveThinkingLevel, runtime: runtimeFromProvider(provider) }`. This covers initial post-spawn verification and every in-runtime model update. `persistSessionMetadata()` continues to persist only the opaque SDK resume id after `ClaudeAgentSdkBridge.getState()` reports it.

A live `set_model` request may only select a model derived to the session's current runtime. `src/server/ws/runtime-model-selection.ts::applyRuntimeSessionModelSelection()` validates the registry row, derives the requested runtime, and rejects a cross-runtime model mutation before calling `setModel`. The error must say that switching runtime requires a new session; it must not mutate the durable tuple, stop the bridge, or attempt Pi recovery. This preserves the existing Pi/SDK bridge ownership rather than silently starting a different runtime with incompatible history.

### 2. Restore, reload, and archived records

`SessionStore.seedFromArray()` must normalize only safely:

- no `runtime`, no usable model provider => keep the disk row unchanged in memory and treat it as Pi;
- usable `modelProvider` => derive runtime and update the in-memory field when missing or contradictory;
- invalid runtime strings are ignored and resolve as Pi unless the provider derives SDK.

No migration rewrite is required merely to read legacy rows; the next normal `put`/`update` persists a normalized snapshot. This protects old `sessions.json` files and archived records.

Every recreation path must call the same resolver with the persisted tuple:

- `SessionManager.restoreSession()`;
- `SessionManager.addDormantSession()` (currently misses `ps.runtime` and must use the full resolver input);
- `_respawnAgentInPlace` and `forceAbort` replacement construction near `session-manager.ts` lines 10290 and 12736;
- role restart/recovery helpers that construct `SessionBridgeOptions`.

The SDK-specific branch in `restoreOneSession()` remains: it uses `claudeAgentSdkSessionId` and never uses Pi's JSONL switch command. A missing/invalid SDK resume id stays a dormant, visible SDK session with `restoreError`; it must not be relabelled as Pi.

### 3. Continue and fork

`src/server/server.ts` owns `POST /api/sessions/:id/fork` and `POST /api/sessions/:id/continue`. Both currently inherit only `resolveServerInitialModelTuple()` and then invoke the Pi JSONL clone/switch flow. Make runtime behavior explicit at the route boundary, before clone work:

| Source runtime | Continue | Fork |
|---|---|---|
| Pi | Existing clone, sidecars, and `switch_session` flow; pass `initialModel` so the destination derives Pi. | Existing clone, sidecars, worktree behavior, and `switch_session` flow; pass `initialModel` so the destination derives Pi. |
| Claude Agent SDK | Create a fresh Bobbit session using the source tuple plus `claudeAgentSdkSessionId` as SDK `resume`; do not copy a Pi `.jsonl`, tool-content, or author sidecar. Persist the new session's derived SDK runtime and its observed resume id. | Return `422` with stable code `RUNTIME_FORK_UNSUPPORTED` and a message that SDK conversation branching is unavailable. Do not copy a Pi transcript or create a destination session. |

A true independent SDK fork requires an SDK-supported fork primitive and is deferred. Treating `resume` as a fork would create two Bobbit identities for one remote SDK conversation and is forbidden.

To keep creation plumbing bounded, extend `SessionManager.createSession()` options and `SessionSetupPlan` with an internal `claudeAgentSdkSessionId?: string`, copied only by the SDK continue path. `resolveSdkRuntimeOptions()` derives runtime from `initialModel`; it does not take a caller-controlled runtime. Both `executePlan()`/`spawnAgent()` and the worktree executor skip the `preExistingAgentSessionFile` rehydration block when runtime is SDK. The existing Pi clone paths otherwise remain unchanged.

### 4. REST, audit, and status protocol

All public session projections must visibly carry a runtime:

- Add `runtime: SessionRuntime` plus persisted `modelProvider`/`modelId` to `SessionManager.listSessions()` and `listArchivedSessions()`. These are the source of `GET /api/sessions`, including the archive/BFS enrichment in `src/server/server.ts`.
- Add `runtime` to the single-session REST response around `server.ts` line 7460, selecting the live derived value with persisted fallback.
- Extend `src/app/state.ts::GatewaySession` with `runtime`, `modelProvider`, `modelId`, and `modelAvailable?: boolean`.
- `GET /api/sessions` asynchronously obtains the existing `getAvailableModels(preferencesStore)` catalog once per response and stamps `modelAvailable` by `findSessionSelectableModel`. Missing catalog/provider data never changes persisted runtime; it produces an unavailable presentation only.

Extend the existing `ServerMessage` member in `src/server/ws/protocol.ts`:

```ts
{ type: "session_status"; status: ...; statusVersion: number;
  runtime: SessionRuntime; streamingStartedAt?: number; archivedAt?: number }
```

`src/server/agent/session-status.ts::BroadcastableSession` and `broadcastStatus()`, `SessionManager._emitStatusHeartbeat()`, and all direct attach/resync sends in `src/server/ws/handler.ts` must include the session's derived runtime. Archived attach derives from the persisted model before sending. `src/app/remote-agent.ts` accepts the optional/new runtime without altering its status-version dedupe, and `src/app/api.ts::updateLocalSessionStatus()` updates the active `GatewaySession` runtime at the same time. Status frames are not a second authority: they only project the canonical server derivation.

### 5. Visible presentation

Use one display helper in `src/shared` or `src/app` (for example `runtimeLabel(runtime)`), mapping `pi` to `Pi` and `claude-agent-sdk` to `Claude Agent SDK`. Do not infer it from display text in templates.

- `src/ui/dialogs/ModelSelector.ts` shows a compact runtime badge beside the existing provider badge for every row. The badge comes from `ApiModel.runtime`; it does not make a model unavailable. Existing `sessionSelectable === false` behavior remains distinct.
- `src/app/render-helpers.ts::renderSessionRow()` and `renderArchivedSessionRow()` show the same runtime badge/icon with an accessible title. Because both consume `GatewaySession`, live, archived, goal, delegate, and audit/sidebar rows share the value.
- On a session whose saved provider/model is absent from the current registry, render the known persisted runtime badge plus `Model unavailable` (with provider/model in the tooltip). Do not silently show a Pi badge, substitute a default model, or hide the archived row. The picker still renders a missing-auth model as it does today; `modelAvailable === false` is specifically the persisted-session/audit state.
- Settings and role picker values remain provider/model strings. There is no runtime dropdown, no persisted runtime preference, and no client-side override.

## File plan

| File | Required change |
|---|---|
| `src/server/agent/session-runtime.ts` | Make provider/model derivation authoritative; retain only persisted fallback for legacy rows; export a small display-safe helper if it is server-safe. |
| `src/server/agent/session-store.ts` | Validate/normalize legacy runtime fields in `seedFromArray`; keep `runtime` optional and updateable. |
| `src/server/agent/session-setup.ts` | Derive once after initial model resolution; persist it; support internal SDK continue resume id; guard Pi transcript rehydration by runtime. |
| `src/server/agent/session-manager.ts` | Use full resolver at all restore/dormant/respawn sites; atomically persist derived runtime with the verified tuple; project runtime/model to live and archive list methods. |
| `src/server/ws/runtime-model-selection.ts` | Reject cross-runtime live model selection before mutation/recovery. |
| `src/server/agent/model-registry.ts` | Add read-only derived runtime to `ApiModel` emissions. |
| `src/server/server.ts` | Enrich session audit lists with availability; return runtime in single-session response; branch SDK continue/fork before Pi clone logic. |
| `src/server/ws/protocol.ts`, `src/server/agent/session-status.ts`, `src/server/ws/handler.ts` | Add runtime to status frames, transition/heartbeat, attach, archived attach, and resync. |
| `src/app/state.ts`, `src/app/api.ts`, `src/app/remote-agent.ts` | Type and apply runtime/model availability projections without breaking status-version semantics. |
| `src/ui/dialogs/ModelSelector.ts`, `src/app/render-helpers.ts` | Render runtime badge and provider-unavailable audit state. |

## Verification plan

### Core/integration

1. Extend `tests2/core/session-store.test.ts` with disk rows lacking `runtime`: no tuple resolves Pi; `claude-agent-sdk` provider derives SDK; conflicting old runtime is corrected without losing archival data.
2. Extend or replace `tests2/integration/claude-agent-sdk-runtime-persistence.test.ts` to pin resolver precedence, creation persistence, dormant/restore construction, `persistSessionModel()` runtime update, and unchanged Anthropic/Pi behavior.
3. Extend `tests2/core/server-model-tuple-inheritance.test.ts` or add a focused server-route contract test: Pi fork/continue retain the current JSONL route, SDK continue passes only SDK resume metadata, and SDK fork returns `422/RUNTIME_FORK_UNSUPPORTED` without filesystem copies.
4. Add a focused protocol/session-status unit test for transition, attach/resync, heartbeat, and archived status runtime fields; confirm an old client can ignore the additive field.
5. Add a focused `runtime-model-selection` test: Pi→SDK and SDK→Pi `set_model` reject before `setModel`, persistence, bridge stop, or replacement recovery.

### Browser/DOM

1. Extend `tests2/dom/ui-fixtures/model-selector-fixture.test.ts`: Pi and SDK model rows carry the correct runtime badge; SDK remains selectable when authenticated; `sessionSelectable:false` remains disabled independently.
2. Add `tests2/browser/session-runtime-identity.spec.ts`: create/select an SDK provider model in a supported non-sandbox fixture, assert live sidebar/session audit and archived row badges, reload and reconnect status projection, and assert a missing-provider archived fixture remains visibly SDK plus `Model unavailable`.
3. Add the new Playwright test as a `v2Native` entry in `tests2/tests-map.json` with `{ runner: "playwright", tier: "browser", project: "browser" }`. Existing modified tests retain their current map ownership; do not add duplicate legacy entries.

Run `npm run check`, the focused Vitest files, then `npm run test:browser` (or the registered focused browser command).

## Scope ledger

### Must deliver

- Provider/model-derived runtime with Pi default for legacy missing fields.
- Durable live and archived runtime projection, reload/restore correctness, and runtime-bearing status frames.
- Runtime badges in the model picker and session/archive audit surfaces.
- Clear persisted-session provider/model-unavailable presentation.
- Pi-vs-SDK continue/fork behavior above, including explicit SDK fork refusal.
- Focused core/integration/DOM/browser coverage and `tests2/tests-map.json` registration.

### Bounded

- Reuse `PersistedSession`, `SessionStore`, model registry, bridge factory, status owner, and existing Pi clone paths.
- Store only the existing opaque `claudeAgentSdkSessionId`; no transcript copy for SDK.
- Reject live cross-runtime model switching rather than replacing bridge/history in place.
- No change to existing Pi defaults or to Anthropic's Pi runtime mapping.

### Deferred

- Independent Claude Agent SDK conversation fork when the SDK supplies a safe branch primitive.
- Cross-runtime migration of a live session, transcript conversion, or transcript import/export.
- SDK lifecycle/bridge/tool/permission/transcript implementation, model catalog provisioning, or a runtime settings selector.
- New provider credential flows beyond the existing model-registry availability data.
