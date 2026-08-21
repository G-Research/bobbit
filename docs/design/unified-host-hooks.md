# Unified Host Hooks

**Status:** implementation design
**Decision:** use a shared TypeBox catalogue, an operation-specific interceptor router, and one post-commit notification dispatcher. Persist only matching staff delivery intents, including each intent's original bounded canonical notification; do not add a durable global notification journal.

## 1. Scope and decisions

Bobbit exposes two hook kinds with deliberately different control flow:

- An **interceptor** participates in one operation before Bobbit commits its result. Bobbit awaits it, validates its typed result, and alone decides what was applied.
- A **notification** describes an immutable fact after Bobbit has committed or published the authoritative change. Consumers cannot delay, alter, compensate, or roll it back.

The minimum composition is:

```text
operation boundary
  -> HostInterceptorRouter (typed, awaited, operation-specific folding)
     -> existing PackContributionRegistry + ModuleHost worker path
     -> legacy LifecycleHub/provider adapter where compatibility requires it
  -> Bobbit applies/persists/publishes the authoritative result
  -> HostNotificationDispatcher.publish(...)
     -> exact-project/session browser fanout (live)
     -> observational hook queue (live)
     -> NotificationDeliveryStore staff intents (durable)
     -> bounded diagnostics
```

`LifecycleHub` remains the compatibility owner for legacy context-block providers. It does not own domain facts, WebSocket routing, or staff durability. Existing `providers/*.yaml`, inert legacy `hooks/*.yaml`, `goal_created`/`goal_archived` staff triggers, and `host.session.subscribe("status" | "message" | "tool_result", ...)` continue unchanged during migration.

The following are explicit decisions:

1. `toolCallCompleted` remains **session-scoped**. The goal's illustrative notification-trigger example with `scope: "project"` is contradictory and is rejected by validation. A staff member in the same project may subscribe to the session-scoped fact because the dispatcher derives and verifies `projectId`; this does not promote the fact to project scope.
2. Browser and observational-module delivery is live and best-effort. Reconnects and sequence gaps cause authoritative refresh, not event replay.
3. Staff delivery uses a small durable subscriber outbox. There is no durable global notification journal and no exactly-once claim.
4. Current `hooks/*.yaml` declarations remain inert. Runtime execution requires the new explicit `kind`; old `mode: observe|decide` is not silently activated.
5. `afterTurn` and `goalProvisioned` remain compatibility-only provider hooks. New consumers observe `turnCompleted`; `goalProvisioned` retains its existing specialized path.
6. Ordinary project imports remain committed if `projectImported` fails. The hook is an awaited post-import initialization boundary, not an authority to rewrite or undo the imported project.
7. Administrative/system scope is reserved but not exposed to ordinary packs.

## 2. One shared runtime/type catalogue

Add `src/shared/extension-host/host-hooks.ts`. It is the only source of notification names, payloads, schemas, filter fields, interceptor request/results, and catalogue metadata. It uses the installed `@sinclair/typebox` package (`Type`, `Static`) and `Value.Check`; it does not maintain parallel hand-written TypeScript and runtime maps.

### 2.1 Public types and helpers

The shared module exports these shapes:

```ts
export type HostHookScope = "session" | "project";
export type HostConsumerKind = "browser" | "module" | "staff" | "diagnostic";

export interface HostNotification<
  N extends HostNotificationName = HostNotificationName,
> {
  readonly id: string;
  readonly scope: HostNotificationScope<N>;
  readonly name: N;
  readonly payloadVersion: number;
  readonly occurredAt: number;
  readonly projectId: string;
  readonly sessionId?: string;
  readonly aggregate: Readonly<{
    kind: HostNotificationAggregateKind<N>;
    id: string;
    revision?: string | number;
  }>;
  readonly correlationId?: string;
  readonly causationId?: string;
  readonly payload: Readonly<HostNotificationPayload<N>>;
}

export type HostNotificationName = keyof typeof HOST_NOTIFICATION_CATALOGUE;
export type SessionNotificationName = /* catalogue entries with session scope */;
export type ProjectNotificationName = /* catalogue entries with project scope */;
export type HostNotificationPayload<N extends HostNotificationName> =
  Static<(typeof HOST_NOTIFICATION_CATALOGUE)[N]["payloadSchema"]>;

export function validateNotificationPayload<N extends HostNotificationName>(
  name: N,
  value: unknown,
): value is HostNotificationPayload<N>;

export function validateNotificationFilter(
  scope: HostHookScope,
  name: HostNotificationName,
  value: unknown,
): { ok: true; filter: Readonly<Record<string, string | number | boolean>> }
   | { ok: false; code: "UNKNOWN_NOTIFICATION" | "INELIGIBLE_CONSUMER" |
       "UNKNOWN_FILTER_FIELD" | "INVALID_FILTER_VALUE" | "FILTER_TOO_LARGE" };
```

Schemas are strict (`additionalProperties: false`) and bounded. Shared constructors reject non-finite numbers, oversized strings/arrays/objects, and unknown keys. `HostNotificationDispatcher`, not extensions, constructs IDs, timestamps, scope, project/session bindings, aggregate data, and correlation fields. It deep-freezes the validated projection before fanout.

Each `HostNotificationDefinition` contains:

```ts
interface HostNotificationDefinition<
  N extends string,
  S extends HostHookScope,
  P extends TSchema,
> {
  readonly name: N;
  readonly scope: S;
  readonly payloadVersion: 1;
  readonly payloadSchema: P;
  readonly boundary: string;
  readonly aggregateKind: string;
  readonly revisionSource: string;
  readonly filterFields: Readonly<Record<string, TSchema>>;
  readonly consumers: ReadonlySet<HostConsumerKind>;
  readonly privacy: "public-metadata" | "project-metadata";
  readonly delivery: Readonly<{
    browser: "live" | "none";
    module: "live" | "none";
    staff: "durable-intent" | "none";
  }>;
}
```

Definitions are keyed by canonical name. Names are globally unique in this first catalogue, and scope remains part of each definition. Tests additionally reject duplicate `(scope,name)` pairs. A later administrative catalogue must use a distinct gated scope and cannot be inferred from a missing project binding.

### 2.2 Notification payloads

All fields below are maxima-bounded scalar metadata. `changedFields`/`changedKeys` are allowlisted, sorted, deduplicated string arrays with a small catalogue-owned maximum.

| Scope/name | Bounded payload | Filterable fields |
|---|---|---|
| session `statusChanged` | `{previousStatus,status,statusVersion}` | `status` |
| session `turnStarted` | `{turnIndex,source}` | `source` |
| session `turnCompleted` | `{turnIndex,outcome,durationMs,hadToolCalls}` where outcome is `succeeded|errored|aborted` | `outcome`, `hadToolCalls` |
| session `messageAppended` | `{messageId,cursor,role,blockKinds}`; no content | `role` |
| session `toolCallStarted` | `{toolCallId,toolName,turnIndex}` | `toolName` |
| session `toolCallCompleted` | `{toolCallId,toolName,status,durationMs,errorStatus?}` | `toolName`, `status`, `errorStatus` |
| project `sessionCreated` | `{sessionId,kind,goalId?}` | `kind` |
| project `sessionArchived` | `{sessionId,reason}` | `reason` |
| project `sessionForked` | `{sourceSessionId,sessionId,cutEntryId?,forkMode}` | `forkMode` |
| project `sessionStatusChanged` | `{sessionId,previousStatus,status,statusVersion}` | `status` |
| project `staffCreated` | `{staffId,state,sessionId?}` | `state` |
| project `staffConfigChanged` | `{staffId,changedFields}` | none in v1 |
| project `staffRetired` | `{staffId}` | none |
| project `staffSessionChanged` | `{staffId,previousSessionId?,sessionId?}` | none |
| project `goalCreated` | `{goalId,parentGoalId?,state}` | `state` |
| project `goalUpdated` | `{goalId,state,changedFields}` | `state` |
| project `goalCompleted` | `{goalId,parentGoalId?}` | none |
| project `goalArchived` | `{goalId}` | none |
| project `taskCreated` | `{taskId,goalId,type,state,parentTaskId?}` | `type`, `state` |
| project `taskUpdated` | `{taskId,goalId,state,changedFields}` | `state` |
| project `taskStateChanged` | `{taskId,goalId,previousState,state}` | `previousState`, `state` |
| project `gateStatusChanged` | `{gateId,goalId,previousStatus,status}` | `status` |
| project `pullRequestStatusChanged` | `{goalId,number?,state,reviewDecision?,mergeability?}` | `state`, `reviewDecision`, `mergeability` |
| project `settingsChanged` | `{target,changedKeys}` | `target` |

`toolCallCompleted` is not accepted with project scope. In particular, the valid form of the illustrative trigger is:

```json
{
  "type": "notification",
  "notification": { "scope": "session", "name": "toolCallCompleted" },
  "filter": { "toolName": "example_tool", "status": "succeeded" }
}
```

The host still requires `notification.projectId === staff.projectId`, so a project staff subscriber cannot receive another project's session fact.

### 2.3 Interceptor definitions

The same module exports `HOST_INTERCEPTOR_CATALOGUE`, conditional request/result types, and strict validators:

```ts
export type HostInterceptorName = keyof typeof HOST_INTERCEPTOR_CATALOGUE;
export type HostInterceptorRequest<N extends HostInterceptorName> =
  Static<(typeof HOST_INTERCEPTOR_CATALOGUE)[N]["requestSchema"]>;
export type HostInterceptorResult<N extends HostInterceptorName> =
  Static<(typeof HOST_INTERCEPTOR_CATALOGUE)[N]["resultSchema"]>;

export function validateInterceptorRequest<N extends HostInterceptorName>(
  name: N, value: unknown,
): value is HostInterceptorRequest<N>;
export function validateInterceptorResult<N extends HostInterceptorName>(
  name: N, value: unknown,
): value is HostInterceptorResult<N>;
```

Every definition owns `requestSchema`, `resultSchema`, `defaultTimeoutMs`, `maxTimeoutMs`, dispatch-wide deadline, allowed failure policies, required grants, audit projector, and cancellation behavior. Requests and results are copied, size-bounded, validated, and frozen at the host boundary.

| Name | Request/result and application | Default failure policy |
|---|---|---|
| `sessionSetup` | bounded session/scope projection -> `{context: ContextContribution[]}`; host validates, fences provenance, and applies existing budgets | fail open; omit timed-out/invalid contribution |
| `beforePrompt` | bounded prompt metadata and capped text already available to trusted legacy providers -> `{context: ContextContribution[]}`; it contributes hidden context and does not rewrite the raw user message | fail open; a timeout cannot block a turn |
| `beforeToolCall` | `{toolCallId,toolName,args}` with capped structured args -> `allow | block(reasonCode) | replaceArgs(args)`; host validates replacement against the tool schema before sequential application | fail open for ordinary contributions; protected policy may declare `failClosed` |
| `afterToolResult` | trusted worker receives a capped structured result -> `allow | replaceResult(result) | syntheticError(code)`; only the host returns/persists the final result | protected contributions default fail closed with a constant synthetic error |
| `beforeCompact` | bounded about-to-be-lost span/summary -> `{context?: ContextContribution[], flush?: "complete"}` | fail open; compaction proceeds on timeout/error |
| `sessionShutdown` | identifiers and bounded reason -> `{flush?: "complete"}` | non-fatal; teardown proceeds at deadline |
| `projectImported` | committed project/component identifiers -> `{initialised?: true}` | non-fatal; import remains committed |

New explicit contributions use these definition-level timing caps (a smaller declared timeout wins):

| Interceptor | Default per contribution | Maximum per contribution | Whole dispatch deadline |
|---|---:|---:|---:|
| `sessionSetup` | 1,500 ms | 3,000 ms | 5,000 ms |
| `beforePrompt` | 500 ms | 1,000 ms | 1,500 ms |
| `beforeToolCall` | 750 ms | 1,500 ms | 2,000 ms |
| `afterToolResult` | 750 ms | 1,500 ms | 2,000 ms |
| `beforeCompact` | 1,500 ms | 3,000 ms | 5,000 ms |
| `sessionShutdown` | 1,000 ms | 2,000 ms | 3,000 ms |
| `projectImported` | 2,000 ms | 5,000 ms | 8,000 ms |

Legacy provider budgets continue to be read from `ProviderContribution.budget`; the compatibility adapter is one ordered router participant and preserves `LifecycleHub`'s validation/budget semantics. The outer operation deadline still cancels late worker work and prevents a legacy timeout from extending the host operation indefinitely.

`projectImported` is wired at the project-create/import owner in `src/server/server.ts`: after `projectRegistry.register`, `ProjectContextManager.getOrCreate`, component/workflow/base-ref publication, optional worktree-pool initialization, and `wireGoalManagerResolvers` have completed, but before the 201 response. Its request contains only the new project ID and configured component coordinates. Failure is recorded after the durable registration/config boundary; it neither removes the project nor changes the response to failure.

Raw tool args/results exist only in the interceptor's trusted worker request. They are excluded from audit rows, diagnostics, canonical notifications (including the bounded notification persisted in matching staff rows), and browser frames. The host records whether a proposal was `received`, `valid`, and `applied`; extension code cannot assert application.

## 3. Contribution normalization and execution

### 3.1 Additive manifest syntax

Extend `src/server/agent/pack-contributions.ts::HookContribution` with an explicit discriminated runtime form while retaining its current inert legacy form:

```yaml
# hooks/policy-tools.yaml
id: policy.tools
module: ../lib/hooks.mjs
kind: interceptor
interceptors: [beforeToolCall, afterToolResult]
failurePolicy: failClosed
capabilities: [store]
budget: { timeoutMs: 1500 }
activation: { requiresConfig: [enabled] }
```

```yaml
# hooks/audit-goals.yaml
id: audit.goals
module: ../lib/hooks.mjs
kind: notification
notifications:
  - { scope: project, name: goalUpdated }
  - { scope: project, name: goalCompleted }
capabilities: [store]
budget: { timeoutMs: 1500 }
activation: { requiresConfig: [enabled] }
```

`loadHooks()` continues parsing old `{events,mode}` declarations as `LegacyInertHookContribution`. They remain listable through `PackContributionRegistry.listHooks()` but are never imported or invoked. This preserves the documented inert contract and avoids executing placeholder modules. New declarations are validated against the shared catalogue at load time.

Add a pure normalizer in `src/server/extension-host/host-hook-contributions.ts`:

```ts
export type RuntimeHookContribution =
  | NormalizedInterceptorContribution
  | NormalizedNotificationContribution
  | NormalizedLegacyProviderContribution;

export function normalizeHookContributions(
  registry: Pick<PackContributionRegistry, "list" | "listHooks" | "listProviders">,
  projectId: string | undefined,
): readonly RuntimeHookContribution[];
```

Legacy providers normalize only for supported compatibility interceptor names and retain `LifecycleHub` application semantics. `afterTurn` and `goalProvisioned` do not become new interceptor definitions. New explicit hook declarations invoke `exportKind: "hooks"`; update `ModuleHost.invoke`, `InvokeRequest`, and `module-host-bootstrap.ts::handleInvoke` to resolve `default.<canonicalName>` exactly as provider members are resolved today.

Order is deterministic:

1. active winning packs in existing `PackContributionRegistry.list(projectId)` low-to-high precedence order;
2. within a pack, legacy provider contributions first for compatibility, then explicit hook files in manifest/list order;
3. within a declaration, names in declaration order.

No free-form numeric priority is introduced. Each normalized row carries the server-derived `packId`, declaration/list identity, source path, effective config, budget, capability grant mask, and activation epoch. Pack-root containment and worker isolation remain in `ModuleHost`.

### 3.2 Interceptor router

Add `src/server/extension-host/host-interceptor-router.ts`:

```ts
export interface HostInterceptorContext {
  readonly projectId?: string;
  readonly sessionId?: string;
  readonly goalId?: string;
  readonly cwd: string;
  readonly correlationId?: string;
  readonly signal: AbortSignal;
}

export interface HostInterceptorDispatchResult<N extends HostInterceptorName> {
  readonly value: HostInterceptorRequest<N>;
  readonly decisions: readonly HostInterceptorAuditDecision[];
}

export class HostInterceptorRouter {
  dispatch<N extends HostInterceptorName>(
    name: N,
    input: HostInterceptorRequest<N>,
    context: HostInterceptorContext,
  ): Promise<HostInterceptorDispatchResult<N>>;
}
```

The router composes `PackContributionRegistry`, `ModuleHost`, `createServerHostApi`, and `LifecycleHub`; it does not replace their activation, containment, worker, provider budgeting, or tracing code.

Dispatch algorithm:

1. Validate and bound the host-owned request before extension selection.
2. Resolve active contributions from the project-scoped winning-pack registry. Capture each declaration identity and activation epoch.
3. Create one host-owned absolute dispatch deadline. For each sequential contribution, invoke with `min(remaining dispatch time, declared timeout, catalogue maxTimeoutMs)`.
4. Merge the operation signal, deadline cancellation, registry invalidation/disable cancellation, session termination, and staff/pack retirement as applicable. `ModuleHost.invoke` accepts the resulting `AbortSignal` and terminates/ignores the worker invocation on abort.
5. Immediately before invocation, re-resolve the winning pack/declaration and capability grant. Skip it if disabled, replaced, unconfigured, or ungranted.
6. Invoke through the existing worker and parent-authorized least-privilege Host API. Context identity is server-derived.
7. Validate the result using the operation's TypeBox schema. Malformed results never reach application.
8. Immediately before application, repeat the winner, activation epoch, disabled-ref, and capability-grant check. Discard a late result whose authority changed while it ran.
9. Apply valid mutations sequentially. `beforeToolCall` replacements are also validated against the registered tool's input schema; `afterToolResult` replacements are checked against its bounded result contract.
10. Apply the definition/contribution failure policy. A protected fail-closed timeout/error yields a constant host synthetic denial/error, never the extension exception.
11. Append a bounded audit/trace row containing time, hook, project/session, pack/contribution identity, duration, outcome code, timeout/cancel flags, and host `applied` decision. Never record request/result bodies, provider error text, stack, paths, prompt text, args, or tool-result data.

One dispatch deadline prevents `number of extensions × timeout` latency. Cancellation cannot retract an already applied earlier result, but it prevents later invocation and late application.

`LifecycleHub.dispatch()` remains available and its tests remain valid. For `sessionSetup`, `beforePrompt`, `beforeCompact`, and `sessionShutdown`, a legacy adapter calls the hub's existing provider loop and folds its validated/budgeted blocks into the router result. Do not move `validateBlock`, `applyBudgets`, `ContextTraceStore`, `goalMetadataResolver`, or `scopeContextResolver` into a second implementation. `hasProviderBridgeHooks()` and generated provider bridge paths continue to work during phased adoption.

### 3.3 Tool lifecycle order

Compose the current generated permission guard and tool wrapper seams (`generateToolGuardExtension`, `generateToolResultErrorBridgeExtension`) rather than observing Pi's `tool_execution_end` after persistence. Permission checks remain first:

```text
role/tool permission guard
-> beforeToolCall router
-> approved or host-schema-valid mutated handler invocation
-> handler completes
-> protected afterToolResult router/policy gate
-> approved/replaced/constant synthetic result returned to Pi
-> Pi persists and publishes the corresponding tool-result message_end
-> toolCallCompleted notification
```

Add a bounded per-session `ToolCallLifecycleTracker` inside `SessionManager` (or its event adapter), keyed by `toolCallId`, holding only tool name, monotonic start time, turn index, and safe terminal outcome. `tool_execution_start` is recorded only after admission. `tool_execution_end` may classify safe outcome but cannot publish completion. The matching accepted, non-replay `message_end` for the tool result is the publication fence. Clear entries on completion, process replacement, turn terminal, archive, and shutdown; cap the map to prevent leaks.

## 4. Notification dispatcher

Add `src/server/extension-host/host-notification-dispatcher.ts`:

```ts
export interface HostNotificationPublication<N extends HostNotificationName> {
  readonly projectId: string;
  readonly sessionId?: HostNotificationScope<N> extends "session" ? string : string | undefined;
  readonly aggregateId: string;
  readonly aggregateRevision?: string | number;
  readonly correlationId?: string;
  readonly causationId?: string;
  readonly payload: HostNotificationPayload<N>;
}

export class HostNotificationDispatcher {
  publish<N extends HostNotificationName>(
    name: N,
    publication: HostNotificationPublication<N>,
  ): HostNotification<N> | undefined;
}
```

`publish` validates the catalogue definition, scope prerequisites, payload, project/session ownership, and aggregate revision; creates a UUID, timestamp, and exact canonical envelope; deep-freezes it; and places that same envelope onto bounded browser, module, and staff-intent queues. It performs no socket send, worker invocation, or disk write inline, and the source never awaits consumer work. Since the originating state is already authoritative, any fanout failure is isolated, emits only a bounded diagnostic code, and never throws back into, delays completion of, or compensates the mutation. A queue-overflow/fanout failure is reported by code and the envelope is dropped for that consumer according to its documented delivery class.

Wire one dispatcher through `ProjectContext`/`ProjectContextManager` using the existing late-wiring pattern used by `setGoalTriggerDispatcher`, while session lifecycle owners receive a narrow publisher callback. There is no process-global event emitter and no client-originated publisher.

### 4.1 Observational module handlers

For each envelope, resolve active `kind: notification` contributions using `PackContributionRegistry.listHooks(envelope.projectId)`. Filter by exact catalogue scope/name and eligible consumer kind. Invoke in the same deterministic order through `ModuleHost` with:

```ts
export default {
  async goalUpdated(ctx: NotificationHookContext, event: HostNotification<"goalUpdated">): Promise<void> {}
}
```

`ctx` contains only server-derived project/pack identity, effective config, cancellation, and granted Host APIs. The frozen canonical event is the only argument. Return values are ignored. The dispatcher rechecks winning pack, activation, disabled ref, and grants before invocation and ignores late settlement after invalidation. Each handler has its declared timeout capped by the catalogue. Errors/timeouts are isolated and recorded by code and attribution only. A handler cannot block the source operation because dispatch begins after publication and runs on a per-project ordered async queue.

Queues preserve publication order within one project; projects may run concurrently. Queue capacity is bounded. On overflow, module deliveries are dropped with a diagnostic and modules recover by reading authoritative snapshots; no unbounded memory or replay journal is introduced.

## 5. Authoritative publication map

A publisher must build an allowlisted payload from captured before/after scalars, never spread a store object. “After commit” below means after the owner's fail-loud persistence/publication barrier. Where an existing callback currently precedes that barrier or a save swallows errors, the implementation must add a strict owner method/callback and publish only from it. Legacy cache invalidation may remain independent.

### 5.1 Session facts

| Notification | Exact owner and boundary | Aggregate/revision |
|---|---|---|
| `statusChanged` | Extend `src/server/agent/session-status.ts::broadcastStatus` with an optional session-owned observer. Publish after `session.status` changes, `statusVersion` increments, and the authoritative legacy frame is queued. Do not publish heartbeats/resync echoes or unchanged status. | `session/<sessionId>`, revision `statusVersion` |
| `turnStarted` | `SessionManager.handleAgentLifecycle()` first canonical current-writer `agent_start`, after persisted `wasStreaming`/`streamingStartedAt` update and streaming status transition. Add/use the session's turn index; duplicate start/replay does not republish. | `turn/<sessionId>:<turnIndex>`, revision `turnIndex` |
| `turnCompleted` | Sole final `agent_end` path after `willRetry !== true`, terminal identity dedupe, `turnTerminalHandled` test/set, outcome classification, persisted streaming marker clear, completed-turn increment, and idle/error status publication. Retry attempts, duplicate terminal frames, restore replay, and late frames cannot reach publication. Error and abort use explicit outcomes. | `turn/<sessionId>:<turnIndex>`, revision completed turn index |
| `messageAppended` | Normal non-restoring `subscribeToEvents`/`message_end` path after `prepareVisibleAgentEvent` and `emitSessionEvent` accept the event into `EventBuffer`. Use the accepted buffer seq/cursor and stable message identity. Do not publish client remapping, snapshots, partial streaming, or restore replay. | `message/<messageId>`, revision accepted event cursor |
| `toolCallStarted` | Pi `tool_execution_start` only after permission plus `beforeToolCall` admission, recorded in the bounded tracker. | `toolCall/<toolCallId>`, revision tool-call identity/start cursor |
| `toolCallCompleted` | Matching non-replay tool-result `message_end` after handler -> protected `afterToolResult` -> final approved/synthetic result -> Pi persistence/publication. Join only safe tracker metadata; never emit at `tool_execution_end`. | `toolCall/<toolCallId>`, revision result message cursor |

The existing `isRetryableAgentEnd`, `turnTerminalHandled`, and `assistantTerminalIdentities` fences remain the single turn-terminal suppression mechanism. A new parallel dedupe owner is prohibited.

`statusChanged` also causes one project `sessionStatusChanged` envelope from the same observer and same `statusVersion`; it is not inferred from WebSocket frames.

### 5.2 Project facts

| Notification | Exact owner and boundary | Aggregate/revision source |
|---|---|---|
| `sessionCreated` | `SessionManager.notifySessionCreated()` after `persistOnce`/`SessionStore` strict initial publication. If the current listener can run before flush, move the listener fence rather than publishing at the route. | `session/<id>`, persisted session `updatedAt` or initial store revision |
| `sessionArchived` | A single helper used by live `_terminateSessionOwned` and dormant `archiveWithCascade`, immediately after `SessionStore.archiveAsync()` succeeds. Repeat archive/purge emits nothing. This closes the dormant path's current termination-listener gap. | `session/<id>`, persisted `archivedAt` |
| `sessionForked` | Successful history-fork branch in `server.ts`, after destination `createSession` and transcript/proposal/sidecar materialization all succeed, immediately before the success response. Failed compensation emits nothing. | destination `session/<id>`, destination persisted revision |
| `sessionStatusChanged` | Same post-transition observer as session `statusChanged`, published once with exact project binding. | `session/<id>`, `statusVersion` |
| `staffCreated` | `StaffManager.createStaff()` after staff record persistence, permanent-session metadata, and `currentSessionId` are durably accepted. Do not publish its provisional early `StaffStore.put`. | `staff/<id>`, persisted `updatedAt` |
| `staffConfigChanged` | Public `StaffManager.updateStaff()` after a fail-loud store commit and a pre/post clone diff. Allowlisted author-controlled fields only; exclude `lastWakeAt`, trigger cursors, outbox state, and migration repairs. | `staff/<id>`, persisted `updatedAt` |
| `staffRetired` | Exact non-retired -> `state:"retired"` durable transition. Cleanup failure cannot retract it. Hard deletion without a retirement transition is not this fact. | `staff/<id>`, persisted `updatedAt`/retirement revision |
| `staffSessionChanged` | Centralize all successful `currentSessionId` writes/clears (create, migration, recovery, replacement) in `StaffManager.commitCurrentSession()`, then publish after fail-loud persistence. | `staff/<id>`, persisted `updatedAt` |
| `goalCreated` | New-ID branch in `GoalStore`, after strict persistence/publication. Keep `onIndexUpdate` and legacy `onGoalCreated` independent; move/add a post-publication notification callback rather than repurposing either. | `goal/<id>`, durable `updatedAt` |
| `goalUpdated` | `GoalStore.update/updateStrict` after successful publication of an actual allowlisted change. Capture pre/post scalars; specialized terminal facts may accompany but do not replace a general changed-field fact. | `goal/<id>`, durable `updatedAt` |
| `goalCompleted` | Exact previous state != `complete` -> `state:"complete"` through `GoalManager.updateGoal`/`GoalStore.updateStrict`, after strict durable publication. Route direct completion sites such as team completion and child completion through this helper. Consumer failure is non-fatal. | `goal/<id>`, stable persisted completion `updatedAt` |
| `goalArchived` | False -> true only, after `GoalStore.archiveStrict()` succeeds. It is distinct from and may follow `goalCompleted`; duplicate archive emits nothing. | `goal/<id>`, persisted archive `updatedAt` |
| `taskCreated` | `TaskManager.createTask()` after `TaskStore.put` strict/fail-loud publication. | `task/<id>`, durable `updatedAt` |
| `taskUpdated` | `TaskManager.updateTask`/`assignTask` after each changed task is published, including an auto-updated parent. Emit allowlisted non-state changed fields; no-op writes emit nothing. | `task/<id>`, durable `updatedAt` |
| `taskStateChanged` | Every real previous -> next state transition through `updateTask`, `assignTask`, `completeTask`, or `transitionTask`, after the affected task is published. An automatic parent transition is a separate task fact. | `task/<id>`, durable `updatedAt` |
| `gateStatusChanged` | Centralize old/new summary comparison in `GateStore` across `updateGateStatus`, `bypassGate`, verification completion, and strict reset/reconcile. Publish after the relevant persistence fence and only if summary status differs. `recordSignal` and current `broadcastGateStatusChanged`/`onStatusChange` alone are not authority. | `gate/<goalId>:<gateId>`, persisted status-change revision; add this small per-gate revision to GateStore because reset has no stable signal ID |
| `pullRequestStatusChanged` | `PrStatusStore.set()` after changing it to atomic, fail-loud persistence; compare only the bounded public status projection and suppress no-ops. Existing `pr_status_changed` remains a cache-bust adapter. | `pullRequest/<goalId>`, provider `updatedAt` when present, otherwise SHA-256 of canonical safe projection |
| `settingsChanged` | `ProjectConfigStore.mutate()` after its temp-file rename commits canonical bytes. Diff pre/post target/key identifiers. Project contexts only; global preferences belong to reserved system scope. | `settings/<projectId>`, SHA-256 of committed canonical project-config bytes |

For entities whose existing `updatedAt` is the revision, mutation helpers must ensure a real transition receives a new monotonic millisecond value (`max(Date.now(), previous + 1)`) before strict persistence. This avoids same-millisecond completion/update collisions without introducing durable revision stores. Gate status is the one exception requiring a tiny persisted per-gate revision because resets may remove the signal that would otherwise identify the state.

## 6. Browser API, routing, gaps, and refresh

### 6.1 Additive Host API

Update `src/shared/extension-host/host-api.ts`:

```ts
export interface HostNotificationSubscriptionApi<N extends HostNotificationName> {
  subscribe<E extends N>(
    name: E,
    handler: (event: HostNotification<E>) => void,
  ): () => void;
  onRefreshRequired(handler: () => void): () => void;
}

export interface HostSessionApi {
  // existing members unchanged
  readonly notifications: HostNotificationSubscriptionApi<SessionNotificationName>;
}

export interface HostProjectApi {
  readonly notifications: HostNotificationSubscriptionApi<ProjectNotificationName>;
}

export interface HostApi {
  // existing members unchanged
  readonly project: HostProjectApi;
}
```

Add feature flags for session/project notifications and bump `HOST_CONTRACT_VERSION` additively; do not bump `HOST_API_VERSION`. `getHostApi` binds session ID and project authority from the already trusted host/surface construction. Pack code never supplies either ID. An unbound host returns inert subscriptions. Every unsubscribe closure has a local active/generation flag, is idempotent, and fences already queued stale callbacks.

Keep `HostSessionApi.subscribe` and `src/app/session-event-bus.ts` byte-compatible. That legacy API deliberately exposes richer `HostMessage`/`ToolCallRecord` shapes from existing raw session frames. Rebuilding it from privacy-bounded notifications would either break consumers or leak bodies, so it remains a separately documented compatibility adapter.

### 6.2 WebSocket routing

Add bounded protocol frames in `src/server/ws/protocol.ts`:

```ts
{ type: "host_notification"; notification: HostNotification;
  stream: { epoch: string; sequence: number } }
{ type: "host_notifications_refresh_required";
  scope: "session" | "project"; epoch: string; sequence: number }
```

The stream epoch/sequence is transport metadata, not semantic envelope state. It is ephemeral per authenticated connection/scope and is not a durable event cursor.

Tag each authenticated UI socket in `ws/handler.ts` with its server-resolved session and persisted/live project binding. A dedicated `HostNotificationSocketRouter` sends:

- a session notification only to sockets bound to that exact session;
- a project notification only to sockets whose server-tagged project exactly equals the envelope project;
- nothing to `__viewer__`, unbound, projectless, foreign-project, or future system-scope sockets.

Do not use `broadcastToProject`: it intentionally includes unscoped viewers and is unsuitable as this security boundary. Client filtering is defense-in-depth only. Surface-token validation proves that a mounted contributed panel belongs to the bound session/pack, but project isolation remains server-owned.

Add `src/app/host-notification-bus.ts`, fed by `RemoteAgent`'s canonical frame handler. It deduplicates bounded recent envelope IDs, verifies monotonically contiguous sequence within the current epoch, routes by name, and generation-fences handlers. The client never accepts a project ID from extension code.

Initial mount, socket re-auth/reconnect, epoch change, explicit refresh-required frame, or sequence gap calls `onRefreshRequired` once through a short coalescer. Mounted panels reread their authoritative REST/Host projection; they do not reconstruct state from missed deltas. Event bursts may debounce/coalesce refreshes because correctness comes from the snapshot. Reload repeats snapshot-first initialization, then resumes live observation. No historical notification replay endpoint is added.

## 7. Notification-based staff triggers

### 7.1 Trigger contract and validation

Extend `src/server/agent/staff-store.ts` additively:

```ts
export interface NotificationTriggerSelector<N extends HostNotificationName = HostNotificationName> {
  scope: HostNotificationScope<N>;
  name: N;
}

export type StaffTrigger = LegacyStaffTrigger | {
  id: string;
  type: "notification";
  notification: NotificationTriggerSelector;
  filter: Readonly<Record<string, string | number | boolean>>;
  enabled: boolean;
  prompt?: string;
  lastFired?: number;
};
```

Preserve `schedule`, `git`, `manual`, `goal_created`, and `goal_archived` types and their current UI/API semantics. `StaffManager.validateTriggers()` resolves the shared catalogue, requires staff eligibility, rejects the contradictory project-scoped `toolCallCompleted`, and validates flat exact-AND filter keys and scalar values against definition-owned schemas. V1 has no regex, JSONPath, expressions, payload bodies, or arbitrary nested keys.

Legacy `GoalTriggerDispatcher` remains active during migration. Do not route legacy `goal_created`/`goal_archived` definitions into notification triggers automatically; that would double wake staff. A later explicit migration can rewrite stored triggers and then disable the compatibility callback under its own goal.

### 7.2 Small durable delivery outbox

Add `src/server/agent/notification-delivery-store.ts` and `notification-staff-dispatcher.ts`. The outbox is per project and stores only matching subscriber delivery state plus the original already-bounded canonical notification needed by that subscriber. It is not a global notification history, replay source, or raw aggregate store.

A row is keyed by deterministic `deliveryId = sha256(staffId + "|" + triggerId + "|" + notification.id)`:

```ts
interface NotificationDeliveryRow {
  deliveryId: string;
  projectId: string; // partition key; must equal notification.projectId
  staffId: string;
  triggerId: string;
  subscriberVersion: string; // hash of enabled selector/filter/prompt config
  notification: HostNotification; // complete validated, bounded catalogue projection
  safeContext?: Record<string, string | number | boolean>; // display-only derivative
  state: "pending" | "leased" | "accepted" | "cancelled" | "failed";
  attempt: number;
  nextAttemptAt: number;
  leaseUntil?: number;
  rootCorrelationId: string; // internal loop-control state
  causationDepth: number; // internal loop-control state
  createdAt: number;
  updatedAt: number;
  diagnosticCode?: string;
}
```

`notification` preserves, losslessly, `id`, `scope`, `name`, `payloadVersion`, `occurredAt`, `projectId`, optional `sessionId`, aggregate kind/ID/revision, optional correlation/causation IDs, and the definition-validated payload. Persisting those fields as individual columns plus a typed payload blob is viable but rejected because it adds omission and schema-migration risk without reducing authority or delivery state. A `safeContext`-only row is invalid because it would give staff a different semantic contract. `safeContext`, when present, is derived from allowlisted fields solely for a host-owned display title; filtering, retry, inbox input, and staff behavior never depend on it.

The bounded staff-intent queue asynchronously matches active, enabled project staff triggers and upserts pending rows without holding up the source operation. Before insertion it verifies the definition, supported `payloadVersion`, complete envelope and payload schema, size limits, and exact `notification.projectId === row.projectId === staff.projectId`; it stores no mutable source object. The unique delivery ID coalesces concurrent duplicate fanout. It is intentionally possible for the source mutation to commit and the subsequent queueing/outbox insert to be lost or fail catastrophically; the source still succeeds and the dispatcher records a bounded diagnostic when possible. This non-transactional window is not described as exactly-once capture.

A project worker/reconciler:

1. scans pending and expired leased rows at boot and after staff/trigger activation changes;
2. claims a bounded lease and creates an abort controller;
3. revalidates the persisted notification against its catalogue definition, supported schema version, size bounds, and project partition, then deep-freezes that exact stored event;
4. rechecks staff existence/active state, trigger enabled state, selector and catalogue-owned filter match against that event, `subscriberVersion`, causation limit, and retirement/disable cancellation;
5. creates only optional display text from `safeContext`, then calls additive `InboxManager.enqueueWithId(deliveryId, ...)` with the exact immutable notification in host-owned inbox/wake metadata and exposed as the staff notification input—never as prompt text;
6. relies on fail-loud `InboxStore.putStrict` so acceptance is idempotent, and marks `accepted` only after the inbox write durably succeeds or proves that the identical deterministic entry with byte-equivalent semantic notification fields already exists;
7. lets existing `InboxNudger` own session wake-up. Inbox acceptance, not agent execution/completion, is notification delivery success.

Restart retry reads and delivers the persisted original notification verbatim; it never reprojects a current mutable aggregate. If the gateway crashes after inbox commit and before outbox acceptance, boot retry uses the same inbox ID and identical notification metadata, then marks the row accepted without a duplicate. Late retries use compare-and-set state/lease generation and cannot move `accepted`, `cancelled`, or permanent `failed` back to pending. Unsupported versions, invalid schemas/sizes, partition mismatch, or changed trigger identity fail closed for that row with bounded diagnostics; they do not reach staff.

Retry only classified transient storage/unavailable errors with capped exponential backoff, bounded attempts, and a final deadline. Invalid trigger/filter/project data is permanent failure. Paused, retired, deleted, or disabled staff/trigger rows are cancelled; cancellation aborts a leased attempt and a final live recheck precedes inbox acceptance. Accepted inbox work is not rolled back by later retirement. The notification input and metadata path is available only to `type:"notification"` triggers; legacy schedule/git/manual/goal triggers cannot access or accidentally consume it.

Correlation/loop protection uses separate internal `rootCorrelationId`/`causationDepth` delivery controls while preserving the canonical envelope's correlation and causation fields unchanged. Internal controls travel in host-owned inbox metadata, never prompt text. Permit at most one delivery for `(rootCorrelationId, staffId, triggerId)` and cap depth. A notification caused by that staff wake cannot recursively redeliver to the same subscriber/root chain. Unknown/missing causation starts a new host-owned root; extensions cannot forge it because the host constructs envelopes.

Guarantees are therefore:

- source commit precedes non-blocking notification publication;
- browser, observational modules, and notification-triggered staff receive the same immutable canonical name/envelope/payload contract within their permitted scope;
- browser/module observation is ordered live per connection/project queue and best-effort;
- a successfully inserted staff intent retains the original canonical event and is restart-recoverable; queueing/insertion never delays or rolls back the source;
- durable inbox acceptance is idempotent and effectively once per delivery identity;
- delivery attempts are at least once; staff execution is never exactly once;
- intermediate facts lost in the source-commit-to-outbox window are not reconstructed from mutable state; authoritative state remains queryable;
- no global journal, historical replay, or legacy-trigger access is introduced.

## 8. Security and privacy bounds

The shared catalogue and payload projectors enforce these invariants:

- no raw prompt/user/assistant/message text or content blocks;
- no tool arguments/input, tool result/output/body, or synthetic result text;
- no setting values, provider keys, sandbox tokens, secrets, credentials, headers, or gateway tokens;
- no provider error text, host exception message, stack trace, or worker output;
- no cwd, worktree, repository, absolute path, or mutable store/session object;
- no arbitrary consumer-supplied project/session/pack identity;
- public error fields are closed enums such as `timeout`, `denied`, `handler_error`, not messages;
- filter fields are catalogue allowlists over bounded scalars only.

Builders accept explicit safe scalars or pre-projected snapshots, not domain objects. The staff outbox persists the complete canonical event only after that projection has passed catalogue schema/version/size validation; the worker revalidates and deep-freezes it before delivery. The same bounded event may appear only in matching project-partitioned notification rows and host-owned inbox/wake metadata, never prompt text, a global journal, or legacy-trigger input. Tests recursively inject forbidden sentinel keys/values and prove they cannot serialize in the envelope, persisted row, or inbox metadata. Browser routing uses exact server-derived bindings. Module Host APIs remain pack- and grant-scoped. Staff matching requires the envelope's project and staff's project to match even for session-scoped facts.

Diagnostics record only timestamp, hook/notification, project/session aggregate identity, pack/contribution/subscriber attribution, duration, outcome code, timeout/cancel/retry counts, and revision. They never include payload bodies or arbitrary exception strings.

## 9. Compatibility and migration

1. Add shared catalogue and normalization without activating old declarations.
2. Keep `LifecycleHub`, provider YAML, provider bridge generator, `afterTurn`, and `goalProvisioned` behavior unchanged. Route compatible new operation entry points through the interceptor router only when the corresponding explicit contribution exists.
3. Add explicit `kind` hook contributions as opt-in. Unsupported names fail installation/load validation; legacy inert names stay inert with bounded diagnostics.
4. Keep legacy session event bus and `host.session.subscribe` unchanged. Add notification namespaces and feature flags alongside it.
5. Add canonical publishers independently of existing legacy WS cache-bust/status frames; remove neither in this goal.
6. Add notification staff triggers without rewriting stored legacy triggers. Keep `GoalTriggerDispatcher`, polling `TriggerEngine`, and manual triggers unchanged.
7. Only after strict publisher tests pass should individual packs adopt the API; pack adoption belongs to separate goals.
8. Bump `HOST_CONTRACT_VERSION` for the additive contracts, not `HOST_API_VERSION`.

## 10. Implementation partitions and files

Each partition is independently reviewable and keeps state ownership narrow. Section 12.1 ties every new runtime state owner/API below to a selected component flow, rejected alternative, failure behavior, exact files, and focused tests; §12.2 separately decides durable global-journal versus subscriber-outbox storage.

### A. Catalogue and contribution runtime

Decision coverage: the pure shared catalogue and contribution-normalization APIs serve all four §12.1 decisions; hook resolution/worker/grant changes are owned by the interceptor-execution and observational-fanout rows, not a new registry or worker runtime.

- Add `src/shared/extension-host/host-hooks.ts`.
- Add `src/server/extension-host/host-hook-contributions.ts`.
- Modify `src/server/agent/pack-contributions.ts` (`HookContribution`, `loadHooks`, strict explicit-kind parsing; retain legacy inert parsing).
- Modify `src/server/extension-host/pack-contribution-registry.ts` to activation/config/grant-filter explicit runtime hooks while keeping `listHooks` compatibility.
- Modify `module-host-worker.ts` and `module-host-bootstrap.ts` with `exportKind:"hooks"` and cancellation.

### B. Interceptors

Decision coverage: §12.1 **Interceptor execution** owns the new coordinator and its ephemeral per-dispatch deadline/fold state.

- Add `src/server/extension-host/host-interceptor-router.ts` and bounded audit types.
- Keep `src/server/agent/lifecycle-hub.ts` as the legacy provider adapter/facade; do not make it publish facts.
- Compose existing `provider-bridge-extension.ts`, `tool-guard-extension.ts`, and `tool-result-error-bridge-extension.ts` seams.
- Wire setup/prompt/compact/shutdown/import and tool operation owners only.

### C. Dispatcher, transport, and browser API

Decision coverage: §12.1 **Post-commit fanout/routing** owns the dispatcher, exact socket route, and bounded server queues; **Browser notification delivery** owns the additive scoped Host APIs and the single generation-fenced client bus.

- Add `src/server/extension-host/host-notification-dispatcher.ts` and `host-notification-socket-router.ts`.
- Add `src/app/host-notification-bus.ts`.
- Modify `ws/protocol.ts`, `ws/handler.ts`, `remote-agent.ts`, and `host-api.ts`.
- Wire through `project-context.ts`/`project-context-manager.ts` using existing late wiring.

### D. Authoritative publishers

Decision coverage: §12.1 **Post-commit fanout/routing** limits domain owners to narrow post-authority callbacks and allowlisted payload builders; owners gain no fanout queues or transport API.

- Session: `session-status.ts`, `session-manager.ts`, and the history-fork success route in `server.ts`.
- Project domains: `goal-store.ts`/`goal-manager.ts`, `task-store.ts`/`task-manager.ts`, `gate-store.ts`/gate status adapter, `staff-store.ts`/`staff-manager.ts`, `pr-status-store.ts`, and `project-config-store.ts`.
- Add only the strict callbacks/revisions required by the boundary table. Preserve search, legacy broadcast, and goal-trigger callbacks independently.

### E. Staff durability

Decision coverage: §12.1 **Notification staff delivery** owns the sole new durable subscriber store/lease worker and the additive idempotent inbox metadata/API; §12.2 rejects broader durable event state.

- Add `notification-delivery-store.ts` and `notification-staff-dispatcher.ts`.
- Extend `staff-store.ts`, `staff-manager.ts`, and staff request/UI validation additively.
- Add `InboxManager.enqueueWithId`/`InboxStore.putStrict`; reuse `InboxNudger`.
- Leave `goal-trigger-dispatcher.ts` and `staff-trigger-engine.ts` compatibility semantics intact.

### F. Documentation and fixtures

Update `docs/extension-host-authoring.md`, `docs/lifecycle-hub.md`, staff trigger/inbox documentation, Host API contract/version reference, WebSocket reference, REST/project snapshot refresh guidance, and marketplace fixture documentation. Register every new Test Suite v2 file in `tests2/tests-map.json`; add no legacy-suite tests.

## 11. Protecting tests and acceptance checks

Section 12.1 maps each component decision to exact protecting tests and focused new test files. The aggregate matrix below covers catalogue and authoritative-domain behavior shared across those component seams; §12.2 lists only the additional tests a rejected global journal would require.

Reuse and extend existing seams rather than replace their tests:

- Contributions/activation: `tests2/core/pack-contributions.test.ts`, `pack-providers-loader.test.ts`.
- Worker isolation/capabilities: `extension-host-module-isolation.test.ts`, `extension-host-module-memory-isolation.test.ts`, `extension-host-no-capability-sandbox-residual.test.ts`, `extension-host-server-host-api.test.ts`.
- Legacy providers/router composition: `lifecycle-hub.test.ts`, `provider-bridge-extension.test.ts`, `session-manager-respawn-provider-bridge.test.ts`.
- Tool wrappers: `tool-guard-extension.test.ts`, `tool-result-error-bridge-extension.test.ts`, `pi-tool-lifecycle-contract.test.ts`.
- Turn suppression/status: `pi-rpc-agent-end-retry.test.ts`, `session-manager-direct-prompt-lifecycle.test.ts`, `session-manager-force-abort-grace.test.ts`, `orphan-tool-result-recovery.test.ts`, `session-manager-status.test.ts`.
- Host binding/legacy adapter: `extension-host-session-event-bus.test.ts`, `extension-host-surface-binding.test.ts`, `extension-host-surface-token.test.ts`.
- Domain durability: `goal-store-sqlite.test.ts`, `goal-task-store-lifecycle.test.ts`, `task-state-machine.test.ts`, `task-generation.test.ts`, `gate-store-logic.test.ts`, `gate-store-sqlite.test.ts`, `project-config-store-durability*.test.ts`, and `tests2/integration/history-fork-api.test.ts`.
- Staff compatibility: `staff-trigger-engine.test.ts`, `goal-trigger-dispatcher.test.ts`, `tests2/integration/staff-goal-triggers.test.ts`, `inbox-manager.test.ts`, and `inbox-store.test.ts`.

Required new v2 coverage:

### Core

- catalogue name/(scope,name) uniqueness, TypeBox payload/request/result/filter validation, version and aggregate revision extraction;
- bounded size/extra-key rejection and forbidden privacy sentinel fuzzing;
- contribution normalization, old declarations inert, provider compatibility, deterministic pack/manifest order;
- absolute deadlines, cancellation, pre-invoke and pre-apply activation/grant rechecks, every interceptor result/failure policy, and bounded audit output;
- post-commit callback ordering for every boundary in §5 and no notification on strict persistence failure;
- exact project/session routing and absent/unbound authority;
- turn retry/duplicate/late/restore suppression and explicit error/abort completion;
- tool permission -> interceptor -> handler -> result policy -> persisted message -> completion order;
- revisions, no-op suppression, fork lineage, goal complete/archive distinction, settings no-values, and payload immutability.

### DOM/Host API

- typed session/project name restriction, server-derived binding, inert unbound host;
- idempotent unsubscribe, remount/generation stale-callback isolation, recent-ID dedupe;
- ordered stream, reconnect/epoch/sequence gap refresh, initial snapshot refresh, burst coalescing;
- unchanged legacy `host.session.subscribe` behavior.

### Integration

- fixture installed explicit interceptor and notification handlers through real registry/worker infrastructure;
- precedence, activation/config/grants, timeout, cancellation, malformed result, protected failure isolation, and exact project context;
- staff filter validation/matching, concurrent duplicate coalescing, transient retry, retirement/disable cancellation, late retry fence, causation loop limit, deterministic inbox acceptance, and restart reconciliation;
- a session `toolCallCompleted` and a project notification each deliver to matching staff with byte-equivalent semantic envelope fields to the dispatcher's canonical event; restart between intent persistence and acceptance preserves `id`, `scope`, `name`, `payloadVersion`, payload, aggregate revision, and correlation/causation fields;
- forbidden privacy sentinels cannot serialize in the persisted delivery row or host-owned inbox/wake metadata, and `safeContext` cannot become semantic notification input;
- unchanged schedule/git/manual/goal trigger suites remain unable to access notification metadata.

### Browser and E2E

- fixture marketplace panel subscribes to session and project facts, observes live changes, refreshes from an authoritative snapshot after reconnect/gap/reload, unsubscribes cleanly, and receives no second-project facts;
- E2E real WS project routing excludes foreign/unbound/viewer sockets;
- gateway restart between staff inbox commit and outbox acceptance reconciles without a duplicate;
- real final-turn and protected tool-result boundaries prove ordering that lower tiers cannot.

Acceptance commands:

```bash
npm run check
npm run test:unit
npm run test:browser
npm run test:e2e
```

Acceptance is complete only when every catalogue entry has exactly one tested authoritative publisher, public payload privacy tests pass, cross-project attempts are silent, existing provider/panel/staff compatibility tests remain green, and all new files are registered in `tests2/tests-map.json`.

## 12. Comparative design and defect surface

### 12.1 Component-level comparative decisions

These decisions justify the non-trivial cross-layer additions independently. Each selected path composes current authority owners and gives its new state an explicit failure contract; the durable-storage choice remains separate in §12.2.

| Decision | Selected data/control flow, new state, and failure behavior | Materially different rejected approach and defect-surface rationale | Exact implementation files and protecting/focused tests |
|---|---|---|---|
| Interceptor execution | `HostInterceptorRouter` validates a typed request, obtains deterministic contributions from `PackContributionRegistry`, invokes them sequentially through `ModuleHost`, folds typed mutations/decisions, and rechecks activation/epoch/grants before invocation and application. `LifecycleHub.dispatch()` remains one legacy-provider adapter and retains context validation/budget/application semantics. The router owns only ephemeral per-dispatch deadline, current folded value, and bounded decision rows—no durable state. Timeout/invalid/revoked work follows the definition's fail-open or protected fail-closed result without late application. | Generalize `LifecycleHub` into the executor for all seven operations. That would add tool mutation, result replacement, import/flush, and differing failure-policy branches to the legacy context-block owner, blur byte-compatible provider behavior, and still require worker/grant resolution. The selected coordinator exists specifically for typed sequential mutation and pre-apply authority checks rather than speculative reuse. | Production: `src/server/extension-host/host-interceptor-router.ts`, `host-hook-contributions.ts`, `module-host-worker.ts`, `module-host-bootstrap.ts`; `src/server/agent/lifecycle-hub.ts`, `pack-contributions.ts`; existing `tests2/core/lifecycle-hub.test.ts`, `provider-bridge-extension.test.ts`, `pack-contributions.test.ts`, `extension-host-module-isolation.test.ts`, `extension-host-module-memory-isolation.test.ts`, `extension-host-no-capability-sandbox-residual.test.ts`, `extension-host-server-host-api.test.ts`; focused `tests2/core/host-interceptor-router.test.ts`. |
| Browser notification delivery | `HostNotificationSocketRouter` sends canonical frames only to exact server-bound sockets; `RemoteAgent` feeds one bounded `host-notification-bus.ts`; scoped `host-api.ts` subscriptions consume it. `session-event-bus.ts` remains the rich byte-compatible legacy adapter. New client state is one generation-fenced bounded recent-ID set plus epoch/sequence state per mounted host; on mount/reconnect/gap/overflow it coalesces refresh and discards delta reconstruction. | Extend `session-event-bus.ts` or synthesize canonical/project facts from existing raw session frames. Those frames lack an exact project-scoped routing model and include rich message/tool bodies; reuse would couple the public privacy contract to raw transport, invite client filtering, and endanger legacy compatibility. | Production: `src/server/ws/protocol.ts`, `handler.ts`, `src/server/extension-host/host-notification-socket-router.ts`, `src/app/remote-agent.ts`, `host-api.ts`, `host-notification-bus.ts`, `session-event-bus.ts`, `src/shared/extension-host/host-api.ts`; existing `tests2/core/extension-host-session-event-bus.test.ts`, `extension-host-surface-binding.test.ts`, `tests2/integration/extension-host-surface-token.test.ts`; focused `tests2/dom/extension-host-notification-bus.test.ts` and browser reconnect/gap/isolation journey. |
| Notification staff delivery | After canonical publication, `notification-staff-dispatcher.ts` matches catalogue selectors/filters and persists a per-project `NotificationDeliveryStore` row containing subscriber lease/identity state and the complete original bounded event. Its worker revalidates/freezes that event and calls `InboxManager.enqueueWithId`; `InboxStore.putStrict` is durable acceptance and `InboxNudger` remains wake owner. This is the sole new durable consumer state. Queue/insert failure never affects the source; transient leased rows retry, invalid/foreign/version-mismatched rows fail closed, and deterministic IDs close the inbox-ACK window. Legacy `GoalTriggerDispatcher`/`TriggerEngine` remain unchanged. | Add selector/filter/causation/lease logic to the legacy goal dispatcher/trigger engine. It mixes non-migrated legacy semantics with canonical notifications, still requires durable identity and the original event for restart, and risks double wakes. A `safeContext`-only row violates the shared contract; individually columnizing the envelope is viable but has greater omission/migration risk; a global journal is disproportionate (§12.2). | Production: `src/server/agent/notification-delivery-store.ts`, `notification-staff-dispatcher.ts`, `staff-store.ts`, `staff-manager.ts`, `inbox-manager.ts`, `inbox-store.ts`, with unchanged `goal-trigger-dispatcher.ts`, `staff-trigger-engine.ts`; existing `tests2/core/staff-trigger-engine.test.ts`, `goal-trigger-dispatcher.test.ts`, `inbox-manager.test.ts`, `inbox-store.test.ts`, `tests2/integration/staff-goal-triggers.test.ts`; focused `tests2/integration/notification-staff-dispatcher.test.ts`, `tests/e2e/notification-staff-restart.spec.ts`. |
| Post-commit fanout/routing | Narrow callbacks from §5 authority owners submit allowlisted scalars after their strict commit/publication fence. One `HostNotificationDispatcher` validates, constructs, and freezes the envelope, then enqueues exact socket, ordered module, matching staff, and bounded diagnostic fanout. It owns bounded live queues only—no durable global event state—and never awaits consumer I/O in the source operation. Queue/send/handler failures are isolated and coded; browser gaps refresh, module delivery may drop, and only matched staff intents become durable. | Let every domain owner send browser/module/staff facts through existing broadcast helpers. That duplicates envelope construction, schema, privacy, ordering, and failure branches at every mutation; tempts unsafe `broadcastToProject`; and prevents one canonical post-commit contract from being tested. | Production: `src/server/extension-host/host-notification-dispatcher.ts`, `host-notification-socket-router.ts`, `src/server/agent/project-context.ts`, `project-context-manager.ts`, and every §5 domain owner file; focused `tests2/core/host-notification-dispatcher.test.ts`, `tests2/integration/host-notification-routing.test.ts`, privacy/post-commit boundary cases in §11, and `tests/e2e/host-notification-routing.spec.ts`. |

### 12.2 Durable storage decision: selected subscriber outbox vs rejected full journal

The component choices above do not imply durable global publication state. The alternative durable-global-journal design adds a notification database, stream heads, retention, aggregate reconciliation, catch-up scheduling, and journal-to-consumer cursors before it can deliver the same user-visible behavior. It improves recovery of a subset of post-commit facts but cannot make the source-store commit and journal insert atomic without either coupling every domain transaction to the journal or allowing notification infrastructure to fail/roll back the source. It therefore still has a commit-to-journal crash window while adding substantial state.

| Surface | Selected: live dispatcher + staff outbox | Rejected: durable global journal | Consequence |
|---|---|---|---|
| Durable state owners | One per-project staff delivery store; each matching row holds subscriber state and its original bounded canonical event; existing inbox remains wake authority | Notification journal, stream-head table, staff-delivery table, retention/quarantine state, reconciler cursors, plus inbox | Selected adds only state required for the one durable consumer. |
| Canonical notification storage | Only a matching staff intent persists its complete validated event until bounded terminal-row compaction; unmatched/browser/module events are not history | Every emitted envelope and aggregate revision is persisted independently of a subscriber | The selected row is necessary to give asynchronous/restarted staff the shared contract. A journal enlarges privacy/retention/migration surface for events no consumer replays. |
| Ordering state | Ephemeral per-connection sequence and per-project module queue | Durable publication sequence, stream heads, per-consumer cursors/leases | Selected provides required live ordering/gap refresh without pretending to be event sourcing. |
| Crash before event persistence | Source remains committed; rare missed live fact/outbox diagnostic; consumers refresh state | Same unless every domain transaction shares journal transaction; reconciler can only infer current/terminal state | Journal cannot reconstruct unknowable intermediate facts, so its stronger guarantee is partial. |
| Crash after staff intent | Pending/expired lease reconciles; deterministic inbox ID closes ACK window | Journal delivery row reconciles similarly | Both meet staff restart needs; global notification rows add no benefit to this path. |
| Browser reconnect | Snapshot refresh, no replay | Design still requires snapshot refresh because deltas may be sensitive/incomplete and client state may be stale | Durable journal is unused for the required browser correctness model. |
| Module restart | Best-effort observation; module reads snapshots | Could replay, but activation/grant/config may differ and replay semantics require durable per-handler cursors | Goal asks observational asynchronous handlers, not historical processors. Replay adds semantic ambiguity. |
| Project isolation | Server-bound live router + project-owned outbox | Same plus journal query authorization and partition correctness | Journal adds another cross-project read boundary. |
| Schema/version handling | Shared catalogue plus version-aware validation of bounded events in matching staff rows; invalid/unsupported rows fail closed or quarantine per-row | Catalogue plus migrations, compatibility readers, and quarantine for every emitted journal event and every consumer cursor | Staff needs bounded version handling either way; a full journal makes all payload versions and historical events a storage migration concern. |
| Retention/deletion | Terminal outbox rows can be compacted after bounded audit TTL | Must coordinate journal TTL with all consumer cursors, unresolved deliveries, project deletion, privacy policy | More cleanup branches and stuck-row modes. |
| Corruption handling | Quarantine/fail one staff row/store; browser/modules unaffected | Journal corruption can block fanout order, replay, staff scanning, and stream heads | Larger blast radius. |
| Backpressure | Bounded live queues may drop and force refresh; outbox is durable only for staff | Durable journal queue can grow without bound unless retention/cursors are correct | Selected failure behavior matches consumer guarantees explicitly. |
| Source coupling | Narrow post-commit callback | Post-commit append at every source plus reconciliation readers for every aggregate | Journal creates a second representation of domain history. |
| Aggregate revisions | Only catalogue-required revision sources; one small gate revision addition | Durable revisions/cursors must be added consistently to all aggregates for reconciliation | Full journal forces more new state and forgotten-writer risk. |
| APIs | Two notification namespaces, explicit hook kind, internal staff rows | Same plus journal read/replay/admin/maintenance APIs even if initially hidden | Hidden operational APIs still require security/testing. |
| Testing | Boundaries, live gaps/refresh, module isolation, byte-equivalent staff event/inbox metadata, privacy sentinels, and staff crash window | All selected tests plus global migrations, journal atomicity, replay order, cursor leases, TTL, compaction, quarantine, reconciliation | Materially larger verification matrix with no acceptance gain. |
| Operational claims | Honest live best-effort + durable staff intent/idempotent acceptance | Tempts exactly-once/event-log claims that cross-store transactions cannot satisfy | Selected contract is smaller and accurate. |

Unavoidable selected additions are limited to:

- one shared TypeBox catalogue;
- one interceptor result-folding router;
- one post-commit live dispatcher and bounded module queue;
- one exact-bound WebSocket route and ephemeral gap counter;
- allowlist payload builders;
- one bounded tool-call correlation map;
- one durable staff delivery outbox/worker;
- one persisted gate status revision where current state has no stable revision;
- additive scoped Host APIs and explicit contribution discriminator.

The selected design intentionally does **not** add a global notification database, replay API, event-sourced projection, arbitrary filter language, client-owned project selector, wildcard/system subscription, second worker runtime, second pack registry, or exactly-once execution claim. These omissions are part of the design, not deferred implementation shortcuts.
