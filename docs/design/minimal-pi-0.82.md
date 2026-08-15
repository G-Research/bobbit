# Minimal Pi 0.82.1 upgrade

> Historical design for the previous runtime line. The selected `0.84.1` contracts live in [Pi runtime compatibility](../pi-runtime-compatibility.md#pi-0841-reliable-turn-compatibility).

**Status:** implementation-ready design based on `origin/master` at `60aa0d4099f58070217e9ef0c8fe7a683d955d30`.

## Decision

Upgrade these three direct dependencies exactly and together:

- `@earendil-works/pi-agent-core@0.82.1`
- `@earendil-works/pi-ai@0.82.1`
- `@earendil-works/pi-coding-agent@0.82.1`

Use Pi's published synchronous catalog as the authority for direct Anthropic and Amazon Bedrock Claude Opus 5 models. Keep Bobbit's existing catalog, picker, WebSocket, `SessionStore`, session setup, RPC bridge, restore/restart, orchestration, team, host, and sandbox mechanisms. Add only the state needed to preserve the verified tuple:

```text
provider + modelId + normalized effectiveThinkingLevel
```

The implementation must not merge, cherry-pick, or replay a prior Pi branch. Earlier branches are evidence only. In particular, do not port their generalized transition coordinator, provider-identity layer, credential isolation, recovery generations, or lifecycle changes.

## Scope and stop conditions

This upgrade does not redesign credentials, login, sandbox token forwarding, generic environment inheritance, raw agent arguments, review/QA lifecycle, transcript recovery, provider policy, or session replacement. Pi `0.82.1` login/provider additions, including Kimi Code, remain unavailable through Bobbit-owned selection surfaces.

A production change is permitted only when it maps to an acceptance item in this document or to a deterministic dependency-only failure recorded during Phase 0. A focused deterministic reproduction showed that the existing restart path can archive a role-less, no-transcript record while retaining its partially mutated live bridge. The approved narrow amendment is fail-closed: after bounded rollback and restart/replacement fail to verify the unchanged durable tuple, synchronously terminate and detach the unsafe live bridge/session through existing `SessionManager` termination/archive behavior, retain the previous durable tuple, and surface an actionable redacted failure. Do not generalize this amendment into a coordinator, generation system, restore planner, recovery framework, or provider-policy module.

`src/server/agent/session-setup.ts`, `src/server/agent/google-code-assist.ts`, `src/server/agent/orchestration-core.ts`, OAuth code, transcript code, generic environment code, and generic raw-argument handling remain unchanged.

## Published-package evidence

The `0.82.1` tarballs were inspected directly from npm, independently of prior branches.

| Package | Published integrity |
|---|---|
| `@earendil-works/pi-agent-core@0.82.1` | `sha512-Z3kloziJIE2dmrisRckZX8zDca/gIv9/YdFAzeoqpHiLV2wsni6bL4hInNSjVKLbqT+4kqLIkph2JQLKvSepjg==` |
| `@earendil-works/pi-ai@0.82.1` | `sha512-3WFYRhEp3lQB3444EhPMBcM7zSaEUE3eJgHOR7s4081NLqbw/FsWilIKWXSua0Gv3sRr7m9xMidR3pPDE7jI/A==` |
| `@earendil-works/pi-coding-agent@0.82.1` | `sha512-zbkAhoIuDPMF3pKuja0ajZabrMWU29FUMV9A/XMXT/XC1yXs5xt6t6t13GogQFsDrDqbFP4DkZQO1w8rWRAzYA==` |

The `pi-ai` export map is unchanged from `0.81.1`; existing browser-safe `api/*`, server `providers/*`, root type, and OAuth boundaries remain valid until a dependency-only canary proves otherwise. Coding-agent `0.82.1` accepts separate `--provider <provider>` and `--model <id>` flags and all thinking tokens through `max`.

The published coding-agent shrinkwrap contains aligned Pi `0.82.1`, `protobufjs@7.6.5`, and `brace-expansion@5.0.7`. The latter is an immutable upstream audit concern discussed below.

## Phase 0 — mandatory dependency-only baseline

No feature or compatibility production hunk may precede this phase.

### Fresh base and exact lock regeneration

1. Confirm the implementation branch starts from current `origin/master` and record both SHAs.
2. Change only the three direct Pi pins in `package.json` to exact `0.82.1`.
3. Preserve `.npmrc`'s `shrinkwrap=false` behavior. Back it up outside the repository with a shell trap or PowerShell `finally`, temporarily move it out of the worktree, and delete the installed old `node_modules/@earendil-works/pi-coding-agent/npm-shrinkwrap.json`.
4. Run `npm install --package-lock=true` from the worktree root.
5. Restore `.npmrc` before any test. Never restore the old `0.81.1` shrinkwrap.
6. Confirm coding-agent's installed shrinkwrap is freshly extracted at `0.82.1`.
7. Run a plain `npm install` with `.npmrc` restored and require no `package.json` or `package-lock.json` change.

Parse, rather than eyeball, this graph:

```bash
npm ls @earendil-works/pi-agent-core @earendil-works/pi-ai @earendil-works/pi-coding-agent @earendil-works/pi-tui brace-expansion protobufjs --all --json
```

The dependency-only tree passes only when npm exits zero, all root and nested Pi occurrences are `0.82.1`, no `0.81.1` or mixed Pi edge remains, coding-agent's published shrinkwrap is present, and the graph has no invalid, missing, stale, or extraneous edge. Do not use `npm audit fix`, `--force`, a Bobbit override, vendoring, or repacking to alter Pi's published graph.

### Dependency-only checks

Run `npm run check` and the existing Pi compatibility canaries before feature work:

```bash
npx vitest run --config vitest.config.ts --project v2-core \
  tests2/core/pi-ai-browser-boundary.test.ts \
  tests2/core/oauth-external-callbacks.test.ts \
  tests2/core/pi-rpc-thinking-levels.test.ts \
  tests2/core/pi-rpc-agent-end-retry.test.ts \
  tests2/core/pi-tool-lifecycle-contract.test.ts \
  tests2/core/compaction-types.test.ts \
  tests2/core/transcript-sanitizer.test.ts \
  tests2/core/google-code-assist-provider-extension.test.ts \
  tests2/core/rpc-bridge-line-buffer-correctness.test.ts
npm run check
```

Also run the existing sandbox missing/stale-version canaries without a production change. `src/server/agent/sandbox-status.ts` becomes editable only if a focused test passes on `origin/master`, fails deterministically on the dependency-only commit, and proves the `0.82.1` bump caused the failure. A pre-existing missing-image or Dockerfile-default issue is class B and is not fixed here.

### Deterministic failure ledger

Record the baseline in `docs/pi-runtime-compatibility.md` before feature work. An empty delta is valid and must be written as “no deterministic dependency-only failures.” For every failure record:

| ID | Dependency-only SHA | Exact command | Stable error signature | Passes on `origin/master`? | Minimal reproduction | Required production boundary |
|---|---|---|---|---|---|---|
| `D1`, … | SHA | command | fixed regex/text | yes | focused command/test | allowed file and reason |

A timeout, network failure, advisory-feed change, or one-off flaky test is not a Pi compatibility delta. Rerun an apparent failure in isolation and compare it with `origin/master`. Every later production hunk must cite either acceptance `A1`–`A10` below or one recorded `D*`; otherwise remove it.

## Authoritative Opus 5 catalog

### Direct Anthropic

Pi publishes this exact tuple and metadata:

```json
{
  "id": "claude-opus-5",
  "name": "Claude Opus 5",
  "api": "anthropic-messages",
  "provider": "anthropic",
  "baseUrl": "https://api.anthropic.com",
  "reasoning": true,
  "input": ["text", "image"],
  "cost": {
    "input": 5,
    "output": 25,
    "cacheRead": 0.5,
    "cacheWrite": 6.25
  },
  "contextWindow": 1000000,
  "maxTokens": 128000,
  "thinkingLevelMap": {
    "xhigh": "xhigh",
    "max": "max"
  },
  "compat": {
    "forceAdaptiveThinking": true,
    "supportsTemperature": false,
    "supportsStrictTools": true
  }
}
```

Bobbit must expose `anthropic/claude-opus-5` through `/api/models` without a duplicate or an `inferMeta()` replacement. `assembleModels()` already copies Pi's API, endpoint, input, cost/cache, thinking map, and compat fields; retain that path. Pi's four cost values are the existing per-million-token input, output, cache-read, and cache-write rates.

### Amazon Bedrock profiles

Pi publishes five supported profiles. All use provider `amazon-bedrock`, API `bedrock-converse-stream`, `reasoning:true`, text and image input, a 1,000,000-token context window, 128,000 max output tokens, and `thinkingLevelMap: { xhigh: "xhigh", max: "max" }`.

| Exact model ID | Exact name | Base URL | Cost `{input, output, cacheRead, cacheWrite}` |
|---|---|---|---|
| `au.anthropic.claude-opus-5` | `Claude Opus 5 (AU)` | `https://bedrock-runtime.us-east-1.amazonaws.com` | `{5, 25, 0.5, 6.25}` |
| `eu.anthropic.claude-opus-5` | `Claude Opus 5 (EU)` | `https://bedrock-runtime.eu-central-1.amazonaws.com` | `{5.5, 27.5, 0.55, 6.875}` |
| `global.anthropic.claude-opus-5` | `Claude Opus 5 (Global)` | `https://bedrock-runtime.us-east-1.amazonaws.com` | `{5, 25, 0.5, 6.25}` |
| `jp.anthropic.claude-opus-5` | `Claude Opus 5 (JP)` | `https://bedrock-runtime.us-east-1.amazonaws.com` | `{5, 25, 0.5, 6.25}` |
| `us.anthropic.claude-opus-5` | `Claude Opus 5 (US)` | `https://bedrock-runtime.us-east-1.amazonaws.com` | `{5, 25, 0.5, 6.25}` |

The Bedrock rows publish no model-level `compat` object; do not invent one. Pi's Bedrock adapter recognizes Opus 5 for adaptive thinking, native `xhigh`, thinking signatures, and prompt caching. Bobbit only preserves Pi's catalog and exact profile ID.

### Supported thinking levels

For each Opus 5 row, the existing `getSupportedThinkingLevels()` rules admit:

```text
off, minimal, low, medium, high, xhigh, max
```

Ordinary levels absent from `thinkingLevelMap` remain supported; `xhigh` and `max` require explicit non-null entries. Existing upward-first clamping remains authoritative. No Opus 5 heuristic belongs in `src/shared/thinking-levels.ts` or `src/server/agent/thinking-level-clamp.ts`.

## Shared ranking

Move the complete rank implementation, not only a constant, to `src/shared/model-ranks.ts`. Export `modelRecencyRank()` and consume it from both `src/server/agent/model-registry.ts` and `src/ui/dialogs/ModelSelector.ts`. Keep the server re-export for existing callers.

The required Claude tiers are:

```text
Claude Fable 5  = 113
Claude Opus 5   = 112
Claude Sonnet 5 = 111
older Opus      <= 110
```

Match direct IDs, Bedrock profile IDs, and provider-prefixed forms by the Claude family token. Cap computed Opus 4.x ranks so future-looking `claude-opus-4-99` cannot overtake Claude 5. Preserve every non-Claude ranking unchanged.

This single function drives picker ordering and server AIGW/default auto-selection, eliminating the current server/UI copies.

## Provider-selection boundary

`kimi-coding` is only the concrete `0.82.1` canary for a Pi provider Bobbit has not adopted. It is not a credential security class.

1. Add exact provider ID `kimi-coding` to the upstream-only built-in filter in `model-registry.ts`. It must be absent from `/api/models` and `/api/pi-ai/providers`.
2. Export a small exact-provider/catalog predicate from `model-registry.ts`; do not create a provider-policy module.
3. Validate Bobbit model preferences (`default.sessionModel`, `default.reviewModel`, and `default.namingModel`), role model writes, runtime `set_model`, team/delegate inputs, and any explicit `initialModel` against the current Bobbit catalog or the exact deferred-provider predicate before Pi sees them.
4. A normal session without an explicit role/default model resolves a current Bobbit-exposed, session-selectable model using existing authenticated-first ordering plus the shared rank, then passes it explicitly to Pi. It must not allow Pi to choose a hidden default.
5. A live explicit `set_model` for a model outside the current selectable catalog fails with the existing actionable unavailable-model response; it must not invoke or accept controlled fallback. Controlled fallback remains permitted only at existing initial-setup call sites that already opt into it. Neither path may silently strip the request and launch on Pi's hidden default.

Filtering is by exact provider identity. Models whose IDs contain `kimi` remain valid under an actual supported provider, including `moonshotai`, `moonshotai-cn`, AIGW, and custom/local providers. A legacy AIGW wire ID such as `aigw/moonshotai/kimi-k3` must continue to work. Exact provider `kimi-coding` remains absent/rejected even if a model ID looks otherwise valid.

Do not add Kimi or OpenRouter login UI, OAuth handlers, credential scrubbing, per-session auth directories, sandbox token policy, raw-argument policy, or generic environment changes.

## Existing architecture to reuse

| Concern | Existing owner | Required narrow change |
|---|---|---|
| Built-in and merged catalog | `model-registry.ts::{assembleModels,getAvailableModels,resolveModelStateMeta}` | Adopt Pi rows; filter deferred exact provider; expose selectable lookup. |
| Picker | `ModelSelector.loadModels()` | Consume shared rank; otherwise unchanged. |
| Thinking metadata | `shared/thinking-levels.ts`, `thinking-level-clamp.ts` | Reuse unchanged. |
| Model mutation verification | `review-model-override.ts::applyModelString` | Call without a persister during a combined request, require exact requested provider/model read-back, and treat any helper-selected fallback as failure. Only existing initial setup may accept controlled fallback. |
| Runtime selection | `ws/runtime-model-selection.ts` | Extend the existing focused helper for one combined bounded operation. |
| Per-session command ordering | `handler.ts`'s existing `SessionCommandSerialiser` | Serialize model/thinking frames with existing session commands; no new queue/coordinator. |
| Durable state | `SessionStore` and `SessionManager.persistSessionModel` | Add normalized effective thinking and write the verified triple together. |
| Spawn planning | Existing `createSession()` inputs and unchanged `session-setup.ts` | Resolve/validate/clamp before passing existing `initialModel` and `initialThinkingLevel`. |
| Host and sandbox argv | `rpc-bridge.ts::buildAgentArgs` | Emit explicit provider, model ID, and thinking. Docker uses the same built list. |
| Restore/restart/fail-closed detach | `restoreSession()`, `restartAgent()`, `_respawnAgentInPlace()`, and existing `SessionManager` termination/archive behavior | Prefer and verify the durable triple; if replacement cannot verify it, synchronously terminate/detach and archive the unsafe session without adding a lifecycle owner. |
| Delegate/host child | Existing `OrchestrationCore` dependencies in `server.ts` | Make thinking resolution durable-first; clamp in existing session creation. |
| Team workers | `TeamManager.spawnRole()` | Role override first, otherwise lead's durable triple. |

## Combined provider/model/effective-thinking selection

### Client and protocol

Extend `ClientMessage`'s existing `set_model` frame additively:

```ts
{ type: "set_model"; provider: string; modelId: string; thinkingLevel?: string }
```

`thinkingLevel` stays optional for reconnecting/older clients. A picker selection always supplies it.

Centralize the duplicated footer/editor picker callbacks in `AgentInterface`. On selection, clamp the current thinking value against the newly selected model's authoritative metadata and call `RemoteAgent.setModel(model, effectiveLevel)` once. `RemoteAgent` optimistically updates both fields and sends one combined frame. It must not send a follow-up `set_thinking_level` for the same pick.

The standalone thinking selector keeps `set_thinking_level`, but its server path gains the same clamp, read-back, persistence, full-state broadcast, and failure reconciliation. This is required because an independently selected thinking level is also part of the durable exact tuple.

Add `set_model` and `set_thinking_level` to the existing per-session `SessionCommandSerialiser` decision in `handler.ts`. That reuse prevents a prompt or later pick from overtaking an in-flight selection; it is not a model-transition coordinator.

### Live success path

`applyRuntimeSessionModelSelection()` owns the bounded request:

1. Capture the previous durable verified triple. Do not modify it yet.
2. Resolve the requested provider/ID in current `getAvailableModels()` and require `sessionSelectable !== false`; reject `kimi-coding` before RPC.
3. Normalize the requested/current thinking token and clamp it against that exact requested catalog row.
4. Call existing `applyModelString()` without `sessionManager`/`sessionId`, so no model-only intermediate state is persisted. Controlled fallback is not a live-selection success condition; only existing initial setup may accept it.
5. Immediately read the actual model after model binding and require its provider and model ID to equal the explicit request. Any different model—including `default.sessionModel` returned by `applyModelString()`—enters the failure path before thinking is applied. Do not clamp against, accept, or persist the unrequested row.
6. Call `setThinkingLevel(effective)` and then `getState()`. Require the final provider/model to still equal the explicit request and thinking to equal the normalized effective level.
7. Only after that exact requested-triple read-back, atomically persist `{modelProvider, modelId, effectiveThinkingLevel}`, update `spawnPinnedModel` and `spawnPinnedThinkingLevel` as live mirrors, update the model-name file, and broadcast one full authoritative `state` frame containing the model metadata and `thinkingLevel`.

No successful result is inferred from RPC command acknowledgment alone, and no live explicit request succeeds as an unrequested fallback tuple.

For an older `set_model` frame without `thinkingLevel`, use the previous durable effective level when present, otherwise the current authoritative state/default, and clamp it against the selected exact model.

### Failure, rollback, and existing recovery

The failure contract is intentionally local to this request. A provider/model read-back that differs from the explicit request is a mutation failure even when `applyModelString()` reports success or names a configured default:

1. Retain the previous durable verified triple. Never persist the requested model, requested thinking, or an unrequested returned fallback after only one mutation succeeds.
2. Read `getState()` and, when complete, broadcast its actual provider/model/thinking as a failure correction so both optimistic client fields are replaced together. This is not a success commit for the returned model.
3. If the request may have mutated Pi, make one bounded attempt to restore the previous durable provider/model and thinking using existing setters, then require exact `getState()` verification. On success broadcast the restored triple; durable state was never changed.
4. If state is incomplete, the bridge is unreachable, either rollback write fails, or rollback cannot be verified exactly, call existing `SessionManager.restartAgent(session.id)`. Do not continue using the partially mutated live bridge while restart/replacement is pending.
5. Read the replacement's authoritative state and require the unchanged durable tuple. On exact verification, broadcast that tuple and then send the request error.
6. If restart/replacement fails, returns no live session, or cannot verify the unchanged durable tuple—including the proved role-less/no-transcript archive case—await existing `SessionManager` termination/archive behavior to terminate and detach the unsafe live bridge/session. Keep the previous durable tuple in the archived record and surface an actionable redacted failure that tells the user to create a fresh session. Never fabricate a recovery state or return while the partially mutated bridge remains live.

The same bounded behavior applies when standalone thinking selection fails. The existing session command FIFO orders later model/thinking/prompt frames behind recovery, and existing session replacement and termination/archive code owns the lifecycle. No selection generation, fingerprint, transition lock, rollback framework, duplicated restore plan, or generalized quarantine subsystem is introduced.

The focused partial-write test must prove an unverifiable mutation invokes `restartAgent()` and cannot continue live. A focused fail-closed case must also reproduce restart/replacement failing to verify the old tuple, then prove that termination/archive is awaited, the unsafe bridge is detached, the previous durable tuple is retained, and the returned failure is actionable and redacted.

## Persistence, reconnect, restore, and spawn

### Durable state

Add only:

```ts
effectiveThinkingLevel?: ThinkingLevel
```

to `PersistedSession`, `UpdatableSessionFields`, and `SessionStore.RECOVERY_CRITICAL_FIELDS`. Keep `modelProvider` and `modelId`. A single `SessionStore.update()` writes the verified triple so the existing synchronous recovery-critical flush makes it durable.

Legacy rows without the new field remain readable. Resolve the existing role/default thinking value, validate it, clamp it against the exact selected model, verify it through Pi, and then persist the normalized effective value.

Initial setup must read back and persist effective thinking even when the same level was already passed at spawn. Do not return early from `tryApplyDefaultThinkingLevel()` before recording a verified value.

### State frames

All live, fallback, archived, preparing, reconnect, and restored frames use the existing metadata resolver and include durable `effectiveThinkingLevel` when live Pi state is unavailable. `RemoteAgent` already replaces optimistic model/thinking from server `state`; keep that authoritative direction.

A failed model or thinking request broadcasts both fields, not a model-only correction. This prevents a reload or error banner from leaving one optimistic half behind.

### Explicit host and sandbox argv

Parse `RpcBridgeOptions.initialModel` at its first slash and make `buildAgentArgs()` emit:

```text
--provider anthropic --model claude-opus-5 --thinking xhigh
--provider amazon-bedrock --model eu.anthropic.claude-opus-5 --thinking max
```

This preserves model IDs containing slashes and dotted Bedrock profile IDs without asking Pi to infer provider identity. Host spawn and Docker `exec` already consume the same built argument list; keep that one path.

Pre-existing generic `options.args` behavior is unchanged. The normal Bobbit-selected path must pass explicit flags and verify read-back; generic raw-argument policy is a separate architecture concern.

Before any host or sandbox spawn, clamp the chosen thinking value against the exact chosen or role-overridden model. Do not resolve thinking against one model and later replace only the model.

### Cold restore and replacement

In `restoreSession()` and existing force-abort/role replacement spawn sites:

1. Prefer the persisted exact provider/model if it is still in the Bobbit-selectable catalog.
2. Prefer persisted `effectiveThinkingLevel`; for a legacy row use existing role/default thinking.
3. Clamp against the exact spawn model before constructing argv.
4. Pass explicit provider/model/thinking through existing `RpcBridgeOptions`.
5. Require post-spawn `getState()` to match before updating durability or broadcasting idle.
6. If the persisted model is unavailable, use the existing actionable unavailable-model path. Only when execution is already in an existing initial-setup call site that explicitly opts into controlled fallback may that setup accept its configured fallback; live `set_model` never may. Never delegate to Pi's hidden default.

A stale persisted `xhigh` on a model that now supports only `high` normalizes to `high` before spawn and becomes durable only after verification. A stale thinking value alone does not cause a model fallback.

### Delegate, host-child, and team inheritance

Keep `OrchestrationCore` unchanged. In its `server.ts` dependency, resolve owner thinking as:

```text
PersistedSession.effectiveThinkingLevel
  ?? live SessionInfo.spawnPinnedThinkingLevel
```

The live mirror is only the narrow pre-persist fallback. `createDelegateSession()` clamps inherited or per-call thinking against its exact inherited or overridden model before handing existing fields to session setup.

For `TeamManager.spawnRole()`, preserve precedence:

```text
worker role model override    > team lead durable model
worker role thinking override > team lead durable effective thinking
existing role/default source  > only when neither source exists
```

Clamp the resulting thinking against the resulting model. Team-lead creation continues to use its role/default path. Do not alter team lifecycle, worktree provisioning, orchestration identity, or tool inheritance.

## File-to-requirement map

Every planned production hunk is within the goal guardrail.

| Production file | Direct requirement |
|---|---|
| `src/shared/model-ranks.ts` | A3 shared Fable > Opus 5 > Sonnet 5 > older Opus ranking. |
| `src/server/agent/model-registry.ts` | A2 Pi-authoritative catalog, A3 shared rank, A7 exact deferred-provider/current-catalog boundary. |
| `src/ui/dialogs/ModelSelector.ts` | A3 shared rank consumption; existing picker remains the UI surface. |
| `src/ui/components/AgentInterface.ts` | A4 one combined model/effective-thinking pick. |
| `src/app/remote-agent.ts` | A4 optimistic combined request and A10 authoritative correction of both fields. |
| `src/server/ws/protocol.ts` | A4 additive combined request field. |
| `src/server/ws/handler.ts` | A4 current-catalog dispatch, existing FIFO reuse, A10 error correction/recovery, reconnect fallback thinking. |
| `src/server/ws/runtime-model-selection.ts` | A4 exact apply/read-back/commit; A10 bounded rollback, existing restart handoff, and the approved fail-closed handoff to existing termination/archive behavior. This is the one existing focused WS helper; add no second module. |
| `src/server/agent/session-store.ts` | A6 durable normalized effective thinking and recovery-critical flush. |
| `src/server/agent/session-manager.ts` | A4 atomic triple persistence and reuse of existing termination/archive behavior for the approved fail-closed case; A5 explicit/clamped spawn; A6 initial, restore, replacement, and delegate continuity; A7 no hidden default. |
| `src/server/agent/rpc-bridge.ts` | A5 exact `--provider`, `--model`, and `--thinking` for host and Docker. |
| `src/server/agent/team-manager.ts` | A6 team-lead tuple inheritance with role precedence. |
| `src/server/server.ts` | A6 durable child-thinking resolver; A7 preference/role/initial-model selection validation. |
| `src/server/agent/sandbox-status.ts` | Conditional `D*` only: edit only after the dependency-only missing/stale-image canary proves a new `0.82.1` failure. Otherwise no diff. |

Supporting non-production changes are the exact pins/lock, focused tests and inventory registration, `docs/pi-runtime-compatibility.md`, this design, and a comment-only `.npmrc` refresh that preserves `shrinkwrap=false` while replacing the stale `0.81.1` protobuf warning with the measured `0.82.1` brace-expansion result. No production change is planned outside this table.

## Focused acceptance coverage

The implementation/test plan is deliberately non-duplicative.

| ID | Acceptance outcome | Focused owner |
|---|---|---|
| **A1** | Every direct/root/nested Pi edge is exactly `0.82.1`; no mixed/stale tree. | Extend `tests/e2e/pi-packed-consumer.spec.ts` and the deterministic shrinkwrap fixture only as version floors require. |
| **A2** | Direct Anthropic plus all five Bedrock tuples match every published field above. | Extend `tests2/core/models-api.test.ts`; one integration API assertion may prove transport. |
| **A3** | All seven Opus 5 levels, `xhigh`/`max` clamping, and shared rank order. | Extend `tests2/core/model-utils.test.ts`, `tests2/core/thinking-levels.test.ts`, and one existing model-selector DOM fixture. |
| **A4** | One combined request reaches the real gateway/in-process mock and returns/persists exact authoritative state. | Extend `tests2/integration/context-bar-reconnect.test.ts` or one equivalently focused existing gateway test. |
| **A5** | Direct host and remapped sandbox argv preserve separate provider, full model ID, and thinking. | Extend `tests2/core/rpc-bridge-spawn-args.test.ts`; use the existing Docker argument seam, not a real Docker matrix. |
| **A6** | Persistence, reconnect, reload, cold restore, delegate/host-child, and team inheritance retain the triple. | Extend existing `session-manager-restore`, `team-delegate`, `host-agents-sandbox-inheritance`, and `team-manager-decisions` coverage only at their owned boundary. |
| **A7** | Custom/local and legacy AIGW Kimi-named IDs still work; exact provider `kimi-coding` is absent/rejected from catalog, preferences, roles, runtime, team, and initial spawn. | Catalog test plus one focused runtime-selection test. No provider substring denylist. |
| **A8** | One registered browser journey performs the complete Opus 5 flow. | Rewrite only the Opus-specific journey in `tests2/browser/journeys/pi-runtime-upgrade.journey.spec.ts`; retain unrelated canaries. |
| **A9** | Existing Pi compatibility canaries remain green, changing only proven version-specific assertions. | Existing browser-import, OAuth, RPC, tool, retry/compaction, transcript, extension, packed-consumer, and binary tests. |
| **A10** | One failure corrects optimistic model and thinking; one unverifiable partial write enters existing recovery, then fail-closes through existing termination/archive behavior if replacement cannot verify durability. | One focused `RemoteAgent` failure test plus focused runtime-helper partial-write and fail-closed injections; do not add a lifecycle/race matrix. |

### Required browser journey

Use the registered real gateway plus deterministic mock bridge in `tests2/browser/journeys/pi-runtime-upgrade.journey.spec.ts`:

1. Create a normal mock-backed session and navigate to it.
2. Open the existing session model picker and select `anthropic/claude-opus-5`.
3. Verify the catalog/state shows 1M context, 128K output, image support, adaptive reasoning metadata, and the full `off` through `max` ladder including `xhigh`.
4. Select `xhigh` through the combined path and wait for exact authoritative provider/model/thinking read-back.
5. Reload the same session route and verify provider `anthropic`, model `claude-opus-5`, effective thinking `xhigh`, and authoritative metadata; no placeholder or older Opus may appear.
6. In `finally`, delete the session and restore any modified preferences.

Do not add a second Opus lifecycle browser test.

### Failure tests

The optimistic correction test must start with a verified old triple, optimistically select a different model/thinking pair, inject a server failure, deliver the authoritative corrective `state`, and assert both client fields equal the server result.

Add this deterministic A10 fallback case: begin with durable verified model `C` at `high`; issue a combined explicit request for model `B` at `xhigh`; configure `applyModelString()` to report/select configured fallback model `A` instead of `B`. Assert that the provider/model mismatch enters failure before `xhigh` is applied, `A` is never accepted or persisted as the live request's success, neither `B/xhigh` nor any `A/<level>` tuple changes durability, and the old durable `C/high` remains. The failure path must publish complete authoritative model-and-thinking correction, attempt the single bounded rollback to `C/high`, and end at verified `C/high`; if rollback cannot be verified, it must invoke `restartAgent()` exactly once and require rehydrated `C/high` from unchanged durability. If restart/replacement cannot verify `C/high`, it must enter the approved fail-closed termination/archive path below. In every branch the client receives an error, never a successful `A` selection.

The partial-write test must make model application succeed, make thinking/final read-back unverifiable, and assert:

- the old durable triple is unchanged;
- no requested partial triple is persisted or broadcast as success;
- the existing `restartAgent()` path is invoked exactly once; and
- the partially mutated bridge is not allowed to continue live.

The approved fail-closed reproduction must then make restart/replacement archive or otherwise fail to return an exactly verified old tuple. It must assert that existing termination/archive behavior is awaited, the unsafe bridge/session is detached, the old durable tuple remains in the archived record, and the client receives an actionable redacted error rather than a recovery state.

## Compatibility canaries

Retain and run at least these current boundaries:

- browser imports: `tests2/core/pi-ai-browser-boundary.test.ts`;
- OAuth: `tests2/core/oauth-external-callbacks.test.ts`, existing Google OAuth/Code Assist tests;
- RPC request/response and line correlation: `pi-rpc-thinking-levels`, `rpc-bridge-line-buffer-correctness`, and bridge lifecycle tests;
- tool lifecycle: `tests2/core/pi-tool-lifecycle-contract.test.ts` and tool-result normalization/extension tests;
- retry and compaction: `pi-rpc-agent-end-retry`, `compaction-types`, and existing compaction UI journey;
- transcript: `transcript-sanitizer` and existing transcript reader/restore coverage;
- extensions: Google Code Assist provider extension plus marketplace/Pi extension canaries;
- binary resolution and published package graph: `tests/e2e/pi-packed-consumer.spec.ts`.

Change only assertions proven version-specific by the Phase 0 delta. New `0.82.1` additive fields/events pass through existing generic handling unless a deterministic canary proves otherwise.

## Edge cases

- `anthropic/claude-opus-5` and every dotted Bedrock profile retain exact provider identity; split only at the first provider/model separator.
- A model ID may contain additional slashes. Separate `--provider` and `--model` prevents Pi from reinterpreting them.
- Current AIGW-exclusive mode may hide direct Anthropic/Bedrock rows; a hidden row is not selectable until the current catalog exposes it again.
- Custom/local models preserve their supplied provider and metadata. An ID containing `kimi` is allowed unless its exact provider is deferred `kimi-coding`.
- Explicit `null` thinking-map entries remain exclusions; missing ordinary entries remain provider defaults; missing `xhigh`/`max` remain unsupported.
- A legacy persisted row without effective thinking is normalized once and remains backward compatible.
- An unavailable live model selection fails actionably without fallback. Only an existing initial-setup call site may use its current opt-in configured fallback; neither path delegates to Pi's hidden default.
- A model succeeds but thinking fails: durability remains old, actual state is read back, bounded rollback is attempted, and unverifiable state restarts through the existing path; if replacement cannot verify the old tuple, the unsafe session is synchronously terminated/detached and archived with the old durable tuple.
- A reconnect during failure consumes authoritative server state; it never trusts the optimistic client snapshot.
- Archived/fallback state without a live bridge uses the durable verified triple.
- Role model and thinking overrides are resolved together and clamped together; a thinking value is never clamped against the model it is about to replace.
- Generic raw CLI arguments, shared auth storage, host/sandbox environment inheritance, and sandbox token forwarding are unchanged and classified separately if audited.

## Security and dependency reporting

Classify findings explicitly:

- **A — branch-introduced and in scope:** a changed Bobbit hunk creates a vulnerability or makes the new selectable Opus 5 path unsafe. Fix before merge.
- **B — pre-existing architecture/policy:** the same issue exists on `origin/master` for existing providers, raw args, shared auth, sandbox tokens, or generic environment inheritance. Record separately; do not broaden this goal.
- **C — immutable upstream Pi packaging:** the exact published Pi `0.82.1` shrinkwrap carries the finding. Report it transparently; do not override, vendor, fork, hide, or weaken audit checks. It remains blocking unless it is the exact accepted-risk exception below.

Run both root and packed-consumer checks:

```bash
npm audit --omit=dev --json
npm run build
npm run audit:packed-consumer
```

Normal compatibility tests remain deterministic and do not assert mutable advisory-feed output. Attach the root and packed audit JSON/exit codes to the final report.

Coding-agent `0.82.1` publishes `brace-expansion@5.0.7` under `minimatch@10.2.5`. The user explicitly accepted the risk of the exact Pi-owned `GHSA-mh99-v99m-4gvg` finding on that exact version and path. Keep it visible as class C in the full non-zero packed-consumer audit and final report, but do not treat it by itself as a merge blocker or release-eligibility blocker. This exception does not make the package audit-clean and does not permit an audit fix, override, vendoring, forking, repacking, suppression, or weakened check. `protobufjs@7.6.5` resolves the prior `0.81.1` protobuf blocker; a root audit that deduplicates differently still does not override packed-consumer evidence.

Compatibility and release eligibility remain separate decisions. This delivery may be release-eligible with only the exact accepted finding above, even though the packed-consumer command exits non-zero. Any additional vulnerability, different version/path/advisory, audit execution failure, or other unaccepted finding remains release-blocking.

## Final verification and scope audit

Run focused tests first, then all required gates:

```bash
npm run check
npm run build
npm run test:unit
npm run test:browser
npm run test:e2e
```

Also retain:

- the parsed development `npm ls ... --all --json` graph;
- the packed-consumer graph, shrinkwrap presence, and `fd`/`rg --version` evidence;
- root and packed-consumer audit JSON/exit codes;
- the dependency-only failure ledger; and
- the browser journey cleanup result.

Before completion:

```bash
git diff --check origin/main...HEAD
git diff --name-only origin/main...HEAD
git diff --stat origin/main...HEAD
```

Review every production hunk against the file map and `A1`–`A10`/`D*`. Remove any unmapped hunk. A production file outside the guardrail requires a dependency-only deterministic reproduction, a written reason the allowed boundaries cannot fix it, and an approved paused-goal amendment before editing.

The final report must state five independent outcomes:

1. **Compatibility status** — exact Pi/catalog/protocol/persistence/spawn/inheritance behavior.
2. **Test status** — focused and full command results, including any environment skip.
3. **Immutable upstream audit status** — exact class C package/path/advisory, packed-consumer evidence, counts, and exit code.
4. **Accepted-risk status** — whether the only non-zero finding is the exact accepted Pi-owned `brace-expansion@5.0.7` path above; never call that result audit-clean.
5. **Release eligibility** — the accepted finding alone does not make eligibility false; any additional or unaccepted vulnerability or audit execution failure does.
