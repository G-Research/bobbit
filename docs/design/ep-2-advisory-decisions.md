# EP-2 — Advisory extension selections

**Status:** implementation design. **Depends on:** EP-5 Context trace, EP-6 exact `decide` grants, EP-11 decision-hook worker/continuation infrastructure, and additive usage/enforcement commits `50402da048756e05f2da119782f9b3b293a71486` and `eacd5b7b9b644415ba7e15ab6639a33a6d3e5c2b`.

## Decision

Add a narrowly typed, advisory selection return to an existing active `mode: decide` hook. A hook may propose exactly one of: a model, a thinking level, a role, or a workflow. The host builds the available values; extensions can only nominate a value from that snapshot. The host validates, orders, grant-fences, traces, and (where a built-in consumer exists) applies the result.

The first consumer is **thinking level only**. It may accept an authorized post-turn proposal for an unpinned live session, then routes it through the existing runtime tuple/read-back path and `clampThinkingLevel`. Model, role, and workflow proposals are accepted as typed advice and traced, but have no application consumer in this slice. They do not mutate a session, a goal, a role, a workflow, preferences, or configuration.

This is not an EP-11 interactive decision request. It creates no card, deadline, default, memory, proposal draft, continuation, pause, inbox item, agent prompt, or durable decision-request state. It is also not EP-13 static prompt composition or EP-4 per-turn request shaping/tool safety.

## Alternatives considered

### A. Extend the existing dispatcher with an injected consumer (chosen)

At the same external scope—typed `decide()` selections, host availability, exact grants, deterministic reduction, safe trace rows, and post-turn thinking application—widen `DecisionHookModule.decide()` and extend the existing `DecisionHookDispatcher`. It retains the single detached `LifecycleHub` decision branch, then injects `AdvisoryThinkingConsumer` only after the generic reducer has selected a winning thinking candidate. This composes the existing strict contract, bounded worker lifecycle, grant resolver, trace behavior, and verified runtime mutation rather than reproducing them.

The reused seams are protected by `tests2/core/decision-hook-contract.test.ts` (strict envelope validation), `tests2/core/session-manager-lifecycle-dispatch.test.ts` (detached dispatch and the unchanged after-turn usage snapshot), `tests2/integration/extension-capability-grants.test.ts` (grant and revocation fences), and `tests2/integration/hindsight-external.test.ts` (provider/no-hook parity). Existing baseline coverage also protects the dispatcher (`tests2/core/decision-request-manager.test.ts`), lifecycle hub (`tests2/core/lifecycle-hub.test.ts`), exact-grant resolver (`tests2/core/extension-grant-policy.test.ts`), priority reference (`tests2/core/budget-enforcement.test.ts`), canonical thinking/model metadata (`tests2/core/thinking-levels.test.ts`, `tests2/core/model-state-meta-resolver.test.ts`), cascade/model availability (`tests2/core/config-cascade.test.ts`, `tests2/core/models-api.test.ts`), active pack contributions (`tests2/core/pack-contributions.test.ts`), and trace sanitation (`tests2/core/context-trace-store.test.ts`). `runtime-model-selection.ts` currently has no dedicated core test; the ledger therefore adds `tests2/core/runtime-model-selection.test.ts` before extracting its shared verified-thinking mutation helper.

### B. Standalone advisory-selection executor (rejected)

A separate executor could be dispatched alongside `DecisionHookDispatcher` from `LifecycleHub` with its own hook loader/worker pool, availability builder, grant-resolver call sites, and trace adapter. It offers no additional observable behavior at EP-2 scope.

| Dimension | A. Existing dispatcher plus injected consumer | B. Separate executor |
|---|---|---|
| Control/data flow | One detached decision branch: host snapshot → existing workers/grants → reducer → injected thinking consumer. | Two detached branches per event; separate snapshot construction and a second worker path for the same hooks. |
| Changed files | Widen the existing contract/dispatcher and add the pure contract plus one consumer adapter. | Add at least executor, worker wrapper, and trace adapter in addition to equivalent contract/consumer work. |
| Failure modes | One timeout/isolation implementation and the existing exact `resolveExtensionGrant` path; candidates are imported once. | Grant-fence drift between resolvers, divergent timeout/isolation behavior, and double import of a hook module per event. |
| Test seams | Existing EP-11 dispatcher, grant, lifecycle, and Hindsight parity seams remain directly applicable. | Existing dispatcher tests do not cover it; ordering, fences, timeout, isolation, and no-hook tests must be duplicated. |

B loses because it increases defect surface for identical behavior and undermines the single dispatcher path established by EP-11, especially the exact-grant centralization that prevents authorization drift.

### Sub-decisions

**Session-owned pins versus reclassifying the durable tuple.** The durable runtime tuple is also written by role/default/restore paths. Treating it as a pin would falsely turn non-human choices into permanent user precedence. Separate `HumanSelectionPins`, written only after verified user WebSocket selections, preserves the intended provenance boundary.

**Injected consumer versus dispatcher-embedded mutation.** Putting thinking mutation inside the generic dispatcher would couple a reusable reducer to session/Pi/broadcast behavior and force later model, role, or workflow consumers into that shape. The injected consumer contains its own live-session, fresh-grant, clamp, read-back, and failure fence while the dispatcher remains generic.

### Defect-surface inventory

- **`selection` output discriminant and widened hook return API:** introduces a new public value shape; strict union validation and `tests2/core/decision-hook-contract.test.ts` protect compatibility.
- **`HumanSelectionPins` state owner:** introduces durable provenance state; the new `tests2/core/runtime-model-selection.test.ts` pins verified-user-only writes and recovery-path non-writes.
- **Host availability snapshot builder:** introduces a worker-boundary admission snapshot; `tests2/core/advisory-selection-contract.test.ts` pins immutable membership filtering and `tests2/core/decision-hook-dispatcher.test.ts` covers no-hook/no-worker behavior.
- **Deterministic candidate reducer:** introduces priority and supersession branches; `tests2/core/advisory-selection-contract.test.ts` pins stable priority/pack/hook ordering independent of completion timing.
- **`AdvisoryThinkingConsumer` adapter:** introduces the only mutation path; `tests2/core/advisory-thinking-consumer.test.ts` pins the fresh grant, user pin, live-model clamp, and failed-RPC/read-back behavior.
- **`selectionKind`/`selectionValue` trace fields:** introduce a persisted/rendered metadata API; context-trace store and DOM tests pin allow-list, bounds, and redaction.

## Existing baseline and required reuse

| Owner | Existing contract | EP-2 use |
|---|---|---|
| `src/server/agent/lifecycle-hub.ts::LifecycleHub.dispatch()` | Runs providers then invokes `DecisionLifecycleDispatcher` detached from the response path. `HookCtx.usage` already carries the direct terminal `TurnUsageSnapshot` on gateway `afterTurn`. | Keep dispatch detached. Pass the already-created `base.usage` through the decision dispatcher; do not parse events, read `CostTracker`, or add a second terminal listener. |
| `src/server/agent/turn-usage.ts` and `session-manager.ts` | `50402da` normalizes direct final assistant telemetry once, then passes a copied known/unknown snapshot to `afterTurn`. | A selection hook may observe that snapshot only on `afterTurn`; absent telemetry remains `{ telemetry: "unknown" }`. |
| `src/server/agent/decision-hook-contract.ts` and `decision-request-manager.ts::DecisionHookDispatcher` | Strict unknown-field rejection, bounded worker hook invocation, EP-6 launch/continuation grant checks, per-hook failure isolation, and redacted trace outcomes. | Extend this dispatcher and contract; do not create a second loader, worker class, grant resolver, or hook lifecycle. Interactive request/advisory behavior remains byte-for-byte compatible. |
| `src/server/agent/extension-grant-policy.ts` | `resolveExtensionGrant(activeHooks, grants, ref, "decide")` is exact and deny-by-default. | Check immediately before selection hook import and immediately before a selection is accepted/applied. A grant is the sole extension authorization in this slice. |
| `src/server/agent/budget-enforcement.ts` | `eacd5b7` demonstrates server-derived candidates, restrictive application ownership, stable pack-priority ties, and an application-time grant fence. | Reuse its deterministic priority rule, not its budget dispositions or consent meaning. No EP-2 selector imports the budget reducer. |
| `src/server/ws/runtime-model-selection.ts` | `applyRuntimeSessionThinkingSelection()` validates the live tuple, invokes Pi, reads back, persists the verified tuple, broadcasts, and calls `clampThinkingLevel`. | Extract only the common verified thinking mutation seam needed by the advisory consumer. The clamp and read-back remain authoritative. |
| `src/shared/thinking-levels.ts` and `src/server/agent/thinking-level-clamp.ts` | Canonical vocabulary, Pi-catalog/inferred metadata, and upward-first `clampThinkingLevel` semantics. | Never duplicate supported-level logic or replace clamp with selection-set membership. |
| `src/server/agent/config-cascade.ts` and `src/server/agent/model-registry.ts::getAvailableModels()` | Resolve active roles/project-local workflows and session-selectable model metadata. | Build role/workflow/model availability snapshots using the same effective project scope as the session/goal. |
| `src/server/extension-host/pack-contribution-registry.ts` and `pack-list.ts` | Active packs are low-to-high precedence; `pack_order` puts higher priority last. The registry has already collapsed shadowed packs and filtered activation. | Derive a numeric pack priority from this active ordered registry list. Never accept pack priority or identity from extension output. |
| `market-packs/hindsight/src/provider.ts` | Existing configured provider gets `afterTurn` context and retains asynchronously; an unconfigured pack is omitted before bridge injection. | It remains a provider, not an EP-2 selector. Its no-hook/provider lifecycle and retained data must remain unchanged. |

## Typed contract

Add `src/server/agent/advisory-selection-contract.ts`. It owns strict validation and the pure selection reducer; it has no filesystem, worker, session, or HTTP dependency.

```ts
export type AdvisorySelectionKind = "model" | "thinking" | "role" | "workflow";

export type AdvisorySelectionProposal =
  | { kind: "model"; provider: string; modelId: string }
  | { kind: "thinking"; thinkingLevel: string }
  | { kind: "role"; roleName: string }
  | { kind: "workflow"; workflowId: string };

export interface AdvisorySelectionAvailability {
  readonly models: readonly { readonly provider: string; readonly modelId: string }[];
  /** Canonical tokens, not a pack-provided capability assertion. */
  readonly thinkingLevels: readonly string[];
  readonly roles: readonly string[];
  readonly workflows: readonly string[];
}

export interface AdvisorySelectionHookContext extends DecisionHookContext {
  /** Present only for `afterTurn`; exactly the immutable EP-2 usage snapshot. */
  readonly usage?: TurnUsageSnapshot;
  /** Host-derived snapshot; values not listed here cannot be proposed. */
  readonly availableSelections: Readonly<AdvisorySelectionAvailability>;
}

export type DecisionHookOutput =
  | { kind: "request"; request: ExtensionDecisionRequest }
  | { kind: "advisory"; advisory: ExtensionAdvisory }
  | { kind: "selection"; selection: AdvisorySelectionProposal };
```

`DecisionHookModule.decide()` changes only by widening its return type to `DecisionHookOutput | null | undefined`. `onDecision()` remains the EP-11 request-resolution continuation and is never invoked for an advisory selection.

Validation rules:

- The output envelope allows exactly `kind` and `selection`; each variant allows exactly its shown fields. Unknown fields fail closed as `Malformed result`.
- `provider`, `modelId`, `roleName`, and `workflowId` use the established bounded safe identifier grammar. A model is compared as the exact `(provider, modelId)` tuple, never a slash-string supplied by the hook.
- `thinkingLevel` is canonicalized by `isKnownThinkingLevel`; spelling/case/unknown values are dropped. The availability snapshot for thinking is the canonical `THINKING_LEVELS` vocabulary, not a pack assertion about a model.
- A value that is syntactically valid but absent from the host snapshot is dropped with `Unavailable value`. No fallback, nearest model, alternate role, or auto-seeded workflow is attempted.
- `availableSelections` is frozen/defensively copied before it crosses the worker boundary. It contains identifiers only—no model credentials, labels, role prompts, workflow bodies, pack configuration, usage cost, prompt text, or transcript.

A selection proposal deliberately has no free-form reason, score, priority, default, effect, callback, mutation instruction, or extension-selected timeout. Such fields would create a second policy protocol and are rejected.

## Snapshot construction and human pins

Add session-owned human-selection provenance to `PersistedSession`/`SessionInfo` in `src/server/agent/session-store.ts` and `session-manager.ts`:

```ts
interface HumanSelectionPins {
  model?: { provider: string; modelId: string };
  thinkingLevel?: ThinkingLevel;
}
```

Only the existing authenticated user WebSocket branches for `set_model` and `set_thinking_level` write these pins, after their existing runtime read-back succeeds. `set_model` pins its verified model and its verified thinking value; `set_thinking_level` pins only thinking. Role/default/restore/auto-selection, explicit server spawn options, and extension decisions do **not** create or overwrite a human pin. Existing durable tuples remain their current runtime recovery source but are not retroactively reclassified as human choices.

The server builds each hook's snapshot immediately before invocation:

1. `models`: `getAvailableModels(preferencesStore)` filtered to `sessionSelectable !== false`, projected to sorted exact `(provider, id)` pairs.
2. `thinkingLevels`: `THINKING_LEVELS`, sorted in canonical rank order. The actual model-specific supported set is intentionally not treated as the final authority; application must clamp against the live model.
3. `roles`: `configCascade.resolveRoles(projectId)`, names only, sorted lexically.
4. `workflows`: `configCascade.resolveWorkflows(projectId)`, excluding hidden entries as that resolver already does, ids only, sorted lexically.

The origin session must still exist and remain in the same project when a candidate reaches application. A missing/archived/replaced session drops the candidate; a changed model simply causes the final thinking clamp to use the current verified model. The snapshot is an admission boundary, not a cached authorization or an apply target.

A matching `humanSelectionPins.thinkingLevel` means every extension thinking proposal is `denied / User pin`. Future model/role/workflow consumers must apply the analogous per-kind pin rule before mutation. A human pin always wins over extension priority, timing, and quantity; it is never merely a high-priority candidate.

## Dispatcher, ordering, and application

Extend `DecisionHookDispatcher` rather than adding an EP-2 executor.

### Candidate flow

```text
LifecycleHub.dispatch("afterTurn", base with usage)
  -> existing provider trace/write
  -> detached DecisionHookDispatcher.dispatch(..., usage)
     -> active registry hooks, sorted deterministically
     -> fresh exact decide grant before every worker import
     -> bounded decide() calls, each with host availability snapshot
     -> strict request/advisory/selection validation
     -> selection availability filter
     -> fresh exact decide grant before reducer/application
     -> one winning proposal per selection kind
     -> thinking consumer only (afterTurn, unpinned)
     -> existing runtime clamp -> Pi RPC -> read-back -> durable tuple/broadcast
     -> redacted EP-5 outcome rows
```

The dispatcher derives candidates from `PackContributionRegistry.list(projectId)`, not the flattened hook list, so it can attach `priority = packIndex` from the registry's low-to-high active list. Within a pack it sorts hooks by `(hookId, listName)`. Workers may run concurrently, but each result retains this immutable ordinal; result timing never changes selection. Each worker uses its existing normalized `hook.budget.timeoutMs`. `Promise.allSettled`/equivalent collects all results without allowing one throw, timeout, malformed result, or store/trace failure to prevent another candidate from completing.

For each selection kind independently, the reducer chooses the eligible candidate by:

1. higher active pack priority (higher means later in `pack_order`) wins;
2. lexical `packId` wins ties;
3. lexical `hookId` wins remaining ties.

The winning candidate is the only one eligible for a consumer. Other valid candidates of that kind receive `superseded`; candidates of other kinds are independent. The reducer uses server-derived identity and priority exclusively. A shadowed, disabled, removed, malformed, ungranted, or revoked hook cannot win and must not be imported after the fence.

### Thinking-level consumer

Add `src/server/agent/advisory-thinking-consumer.ts` as a small injected adapter, with an interface along these lines:

```ts
export interface AdvisoryThinkingConsumer {
  apply(input: {
    sessionId: string;
    projectId: string;
    requested: ThinkingLevel;
    source: ExtensionHookRef;
  }): Promise<"applied" | "pinned" | "unavailable" | "failed">;
}
```

`server.ts` constructs it with the live `SessionManager`, fresh active-hook/grant lookup, and the existing session broadcast function. It must:

1. re-read the live session and `HumanSelectionPins`; return `pinned` without an RPC if a human thinking pin exists;
2. re-read active declarations and `ProjectConfigStore.getExtensionGrants()`, then call `resolveExtensionGrant(..., "decide")` immediately before mutation; denial is `denied / Grant required`;
3. obtain the exact current runtime provider/model through the existing runtime selection read-back seam;
4. call `clampThinkingLevelForModel(requested, provider, modelId)`. The clamp result—not the extension value and not the availability snapshot—is the only value sent to Pi;
5. use the extracted common mutation/read-back/persist/broadcast helper from `runtime-model-selection.ts`; a failed Pi call/read-back leaves the prior verified tuple and all human pins unchanged;
6. never set `HumanSelectionPins`, never change model/role/workflow, and never enqueue a prompt or restart an agent.

The consumer runs only for a winning `thinking` proposal emitted by `afterTurn`. Requests on other lifecycle events remain valid advisory observations and trace as `advised`, but are not applied. This prevents setup/prompt/compaction/shutdown races and makes no hooks/no proposals a strict runtime no-op. The detached lifecycle branch is never awaited by terminal settlement, idle waiters, or prompt queue processing.

Model, role, and workflow proposals are intentionally terminal advisory rows in this delivery. Their typed availability/reduction contract is shipped now so later consumers cannot invent incompatible shapes or tie behavior. Any future application must add a named core choke point, human-pin semantics, fresh availability and grant recheck, read-back/recovery contract where applicable, and tests; it must not make this advisory surface mutate by accident.

## Trace and compatibility

Extend `TraceDecisionOutcomeRow`/the existing EP-5 allow-list with the fixed `Lower-priority selection` reason and safe selection identifiers:

```ts
selectionKind?: AdvisorySelectionKind;
selectionValue?: string; // model: "provider/modelId", else safe identifier
```

For `thinking`, `selectionValue` records the **effective clamped** token only after success; the proposed token is not recorded when it differs. A model value uses the verified host-format tuple and no label. No row carries usage amounts, cost, model credentials, role prompt, workflow details, pack output prose, failure text, human-pin value, or raw availability snapshot.

Use existing fixed outcomes/reasons, adding only the fixed catalog reason `Lower-priority selection`:

- accepted but no consumer: `advised`;
- applied thinking: `applied`;
- lower-priority valid candidate: `superseded / Lower-priority selection`;
- pin: `denied / User pin`;
- launch/application grant failure: `denied / Grant required`;
- value absent from snapshot: `dropped / Unavailable value`;
- malformed output: `dropped / Malformed result`;
- timeout: `dropped / Timed out`;
- runtime/RPC failure: `error` with no dynamic reason.

The existing Context trace's bounded append and failure swallowing remain authoritative. A no-hook project appends no selection outcome, opens no state, performs no availability query, and makes no runtime RPC. Existing EP-11 request/advisory rows and historical JSONL remain readable when both optional fields are absent.

## Exact implementation ledger

| Path | Change |
|---|---|
| New `src/server/agent/advisory-selection-contract.ts` | Strict proposal/output validation, host availability membership, server-derived candidate identity, deterministic per-kind reducer, and immutable result types. |
| `src/server/agent/decision-hook-contract.ts` | Add only the `selection` discriminant and context type widening. Retain existing request/advisory validation and EP-11 semantics. |
| `src/server/agent/decision-request-manager.ts` | Extend `DecisionHookDispatcher` to receive usage/snapshot dependencies, execute sorted selection candidates with isolation, recheck grants at acceptance, and emit safe outcomes. Do not make `DecisionRequestManager` persist advisory selections. |
| `src/server/agent/lifecycle-hub.ts` | Thread `HookDispatchBase.usage` into the detached decision dispatcher context unchanged. Preserve provider order, provider result behavior, and detached failure swallowing. |
| New `src/server/agent/advisory-thinking-consumer.ts` | Own pin fence, fresh authorization fence, live-model clamp invocation, and typed application result. |
| `src/server/ws/runtime-model-selection.ts` | Extract a non-user internal helper from existing verified thinking mutation; preserve `applyRuntimeSessionThinkingSelection()` as the human WS owner that records a pin. |
| `src/server/agent/session-store.ts`, `session-manager.ts`, `src/server/ws/handler.ts` | Persist/hydrate human model/thinking pins and write them only after user-initiated verified WS selection succeeds. |
| `src/server/server.ts` | Construct the host availability builder and thinking consumer; inject fresh registry/grant/session lookups into the existing dispatcher. No new REST, WebSocket, worker, or UI route. |
| `src/server/agent/context-trace-store.ts`, `src/app/context-trace.ts`, `src/ui/components/ContextTraceInspector.ts` | Add the fixed `Lower-priority selection` reason; allow-list and present fixed safe selection metadata without exposing raw proposal data. |
| `tests2/tests-map.json` | Register every new test below. |

## Test ledger

All tests are deterministic: fake registry/session/RPC/clock/deferred workers; no sleeps or live provider/model network.

| Layer | File | Required assertions |
|---|---|---|
| Core | `tests2/core/advisory-selection-contract.test.ts` | Exact union/unknown-field validation; model tuple, role, workflow, and canonical-thinking availability filtering; immutable output; deterministic ties by priority then pack/hook; no result on empty candidates. |
| Core | `tests2/core/decision-hook-contract.test.ts` (extend) | Request/advisory compatibility plus valid/invalid `selection` discriminant; no default/effect/callback or free-form fields on selections. |
| Core | `tests2/core/advisory-thinking-consumer.test.ts` | Fresh grant fence before mutation; human pin wins without RPC; exact live model is used; supported level passes through; unsupported canonical level uses existing upward-first clamp; RPC/read-back failure preserves the prior tuple and pin. |
| Core | `tests2/core/runtime-model-selection.test.ts` (new) | User `set_model`/`set_thinking_level` records pins only after read-back; automatic/role/default/restore/extension paths never create or overwrite them. |
| Core | `tests2/core/decision-hook-dispatcher.test.ts` (new) | Stable registry ordering despite inverse completion order; per-hook timeout/throw/malformed isolation; absent/revoked grant causes no import; application-time revocation denies; unavailable and pinned values are not applied; no-hooks makes no worker, trace selection row, store write, or RPC. |
| Core | `tests2/core/session-manager-lifecycle-dispatch.test.ts` (extend) | `afterTurn` forwards the exact `50402da` known/unknown usage snapshot to a decision hook while remaining detached from terminal settlement; retry/duplicate/no-hub behavior stays unchanged. |
| Core | `tests2/core/context-trace-store.test.ts` and DOM context trace tests | `Lower-priority selection` and selection fields are allow-listed/bounded; only the effective value persists, and unknown/raw proposal/usage fields never persist or render. |
| Integration | `tests2/integration/extension-capability-grants.test.ts` (extend) | Grant, revoke, activation disable, and pack shadow/priority changes take effect in an already-created project/session without restart; a mid-flight result cannot apply after revocation. |
| Integration | `tests2/integration/hindsight-external.test.ts` (extend) | A configured Hindsight provider with no active decision hooks retains/recalls exactly as before; its `afterTurn` invocation and trace have no selection RPC/outcome. An unconfigured Hindsight pack still creates no provider bridge, decision hook import, or network work. |
| Browser | `tests2/browser/e2e/extension-advisory-thinking.spec.ts` | Fixture granted hook observes `afterTurn.usage`, advises a valid thinking level, and the UI reload shows the verified clamped value. User pins then win after reload; unavailable/revoked proposals do not change it; Context shows fixed safe metadata only. |

Focused command after implementation:

```bash
npx vitest run \
  tests2/core/advisory-selection-contract.test.ts \
  tests2/core/decision-hook-contract.test.ts \
  tests2/core/advisory-thinking-consumer.test.ts \
  tests2/core/decision-hook-dispatcher.test.ts \
  tests2/core/session-manager-lifecycle-dispatch.test.ts \
  tests2/core/context-trace-store.test.ts \
  tests2/integration/extension-capability-grants.test.ts \
  tests2/integration/hindsight-external.test.ts \
  --config vitest.config.ts --retry=0
```

## Scope ledger

| In scope | Explicitly deferred |
|---|---|
| Typed model/thinking/role/workflow advisory proposals; host-owned available sets; exact grant fences; deterministic pack-priority reduction; human-pin precedence; EP-5 outcomes. | Applying model, role, or workflow selections; direct config/goal/workflow mutation; an apply callback or a new capability. |
| Thinking as the first built-in, post-turn consumer; current-model clamp and runtime read-back. | Removing or packaging/migrating the existing core thinking heuristic; that belongs to the separate migration child. |
| Reuse of `50402da` after-turn usage snapshot and `eacd5b7` priority/grant-fence pattern. | New usage/cost ledger, inferred telemetry, budget enforcement, spending policy, or a budget reducer change. |
| Deterministic timeout/failure/no-hook behavior and Hindsight provider parity coverage. | Static prompt contributions (EP-13), per-turn request shaping/tool safety (EP-4), interactive decision UX/EP-11 changes, scheduled-advisor semantics (EP-3), polling, or a new extension worker/transport. |
