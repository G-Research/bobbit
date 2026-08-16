# Hindsight memory completion — H-2, H-5, H-6

## Purpose and boundary

This design completes the non-UI memory mechanics in the shipped Hindsight pack. It preserves the durability contracts delivered by #1091 and #1106, and consumes #1099's `HookCtx.scopeContext` as the **only authoritative rich scope input**. It does not add settings UI, a memory panel, agent-facing Hindsight tools, a new capability grant, or a second scope resolver.

The work is deliberately pack-first: the provider persists operational state through its existing pack-scoped `ctx.host.store`; the host remains the only authority for lifecycle dispatch, absolute deadlines, provider identity, project ownership, and capabilities.

## Current state and reconciled reference

The current implementation is the small external/managed runtime pack in:

- `market-packs/hindsight/src/provider.ts` — five ordinary hooks, flat `ProviderCtx` identity fields, immediate retain, simple queue drain, and project-or-all recall.
- `market-packs/hindsight/src/shared.ts` — `EffectiveConfig`, `QueueEntry`, tri-state `readStore`/`loadQueue`, `enqueueRetain`, and config validation.
- `market-packs/hindsight/src/routes.ts` — route recall accepts `projectId` from route context and lets a body/config select `all`.
- `market-packs/hindsight/src/hindsight-client.ts` — bank/namespace request construction and basic retain/recall options.
- `market-packs/hindsight/providers/memory.yaml` — the five ordinary lifecycle hooks and current `recallScope: all` default.

The prior memory-v2 work represented by PR #820 is behavioral reference, not code to restore wholesale. Its useful outcomes were durable per-session batching, bounded overlap, captured bank/namespace on queued retries, a sweep of stranded buffers, outcome digest shaping, and goal-completion deduplication. Its implementation must **not** be copied because it:

1. rebuilt scope from flat `projectId`/`goalId`/`roleName` fields;
2. used `retain-pending:<sessionId>` plus delimiter-style keys susceptible to identity/prefix mistakes;
3. used `Date.now()` and wrote the sweep timestamp before work completed, permitting overlapping/false-complete sweeps;
4. replayed stranded data using the sweeping session's scope/config;
5. used a worker-local `Set` and a `started` marker for `goalCompleted`, neither sufficient across worker/process restarts; and
6. allowed `all` recall without a centrally-authorized `memory.read.all` capability.

#1091 remains authoritative: a failed remote retain is recoverable only after a durable queue append; a compound remote-and-queue failure is visible and must not be reported as success. #1106 remains authoritative: a read error or malformed present record is unknown, never an empty snapshot to overwrite or drain. The new records use `read` and `mutate`, never lossy `get`, whenever a durable decision is made.

## Scope and identity contract

### Scope source

For ordinary hooks, `provider.ts` must read identity only through:

```ts
ctx.scopeContext?.project?.id
ctx.scopeContext?.goal?.id
ctx.scopeContext?.role
```

Flat `ctx.projectId`, `ctx.goalId`, and `ctx.roleName` remain host compatibility fields but are not a Hindsight scope fallback. A missing `scopeContext`, missing project, or missing leaf goal is meaningful: no inferred project tag, no inferred goal tag, and no remote call that would need that identity.

`src/server/agent/hook-scope-context.ts::resolveHookScopeContext` remains the sole resolver. It already resolves only `projects.getOrCreate(input.projectId)`, reads the goal only from that project, creates an immutable snapshot, and never searches by goal id. This slice must not call `ProjectContextManager.getContextForGoal`, scan contexts, or reconstruct scope in the pack.

Goal completion is host-originated rather than an ordinary session event. Its host dispatcher constructs the same kind of immutable `scopeContext` from the already-owned `{ projectId, goalId, cwd, worktreePath, repoPath, repoWorktrees }` with `resolveHookScopeContext`; the provider receives that snapshot and uses the same accessor. Outcome/task/gate data is a separately bounded host snapshot, not an alternative source of project/goal identity.

### Collision-safe identity and prefixes

Introduce one `shared.ts` identity codec for every Hindsight durable key and Hindsight document id. It accepts a versioned named tuple:

```ts
{ projectId, goalId, sessionId, bank, namespace, kind }
```

Each string component is normalized only by rejecting missing/empty values where required, then represented with a length-prefixed UTF-8 encoding (or a SHA-256 digest of that canonical encoding). Never concatenate raw identifiers with `:`, `/`, or a shared textual prefix. The codec exports both:

- an opaque exact key segment for a record; and
- a prefix that ends at a complete encoded component boundary for `store.list`.

The resulting names are versioned, for example `retain-pending/v2/<digest>` and `retain-sweep/v2/<digest>`. A list result is still decoded and compared to the complete canonical identity before use; a prefix match alone is never authorization. This prevents `p/a` from selecting `p/ab`, separator injection, and collisions between identical session ids in different projects/banks/namespaces.

A pending record is a versioned envelope, not just `{ turns, overlap }`:

```ts
{
  version: 2,
  identity: { projectId, goalId?, sessionId, bank, namespace, kind: "pending" },
  scope: { projectId, goalId?, sessionId, role? },
  turns: [{ summary, capturedAt }],
  overlap: string[],
  updatedAt: number
}
```

The `scope` and target bank/namespace are captured when the first turn is durably appended and thereafter immutable. A record whose version, identity, or required provenance is malformed is unavailable/stranded-unknown: it is not replayed under the current session and is not overwritten. Backward-compatible v1 queue entries may retain their existing safe behavior only where their target is unambiguous; legacy pending buffers without original scope and bank/namespace are quarantined (visible diagnostic, no remote replay) rather than guessed.

Queue entries are upgraded to include the same captured target and scope provenance. `drainQueueHead` and `drainQueueAll` construct the client from the entry's `namespace`, ensure the entry's `bank`, and preserve the entry's tags/observation scope. They never substitute the current hook's project, goal, bank, or namespace. A successful remote replay is removed only by a successful durable replacement mutation, retaining #1091/#1106's at-least-once/no-silent-loss behavior.

## H-2: batching, sweep, and stranded replay

### Pending mutation and flush

`afterTurn` derives the narrow scope once, creates a v2 pending identity only when a project and session are available, and appends via `host.store.mutate`. `mutate` is the atomic owner; do not revive the old get/recheck/put pseudo-CAS. The transform preserves every concurrently appended turn and validates the existing envelope before changing it.

A flush is due when the durable primary-turn count reaches `retainEveryNTurns`, or the durable oldest capture time has passed `retainMaxDelayMs`; compaction and shutdown flush their own record regardless of count. It retains one aggregate containing bounded previous overlap plus the primary turns. Only after either:

1. the remote retain succeeds; or
2. remote retain fails and the retry queue append is durably committed,

may a second `mutate` advance that pending record (remove exactly the processed durable prefix and install `nextOverlap`). If neither is true, it stays intact. The advance transform verifies the exact record identity and processed prefix, so an appended suffix cannot be lost and a duplicate retain remains preferable to loss.

The pack receives the existing host-owned lifecycle deadline (`ctx.deadline`) and worker-local signal (`ctx.signal`). It does not create an independent timer or extend the deadline. Every remote call and every durable transition checks the shared absolute deadline before starting and before committing. A deadline/abort therefore leaves the pending record replayable and writes no completion/checkpoint claim.

### Non-overlapping stranded sweep

`sessionSetup` may request recovery, but recovery is not attributed to that session. The sweep operates only on v2 envelopes with complete original scope and target provenance.

Use an injected `now` argument at the shared sweep planner/executor boundary; production passes a host-observed timestamp, tests supply a fake clock. No sweep correctness test depends on wall-clock sleeps or a module-global timer.

The durable sweep control record is scoped to the pack and contains a lease and progress checkpoint:

```ts
{
  version: 2,
  active: { runId, startedAt, deadlineEpochMs } | undefined,
  lastCompletedAt: number | undefined,
  checkpoint: { recordKey, updatedAt } | undefined
}
```

Claim it through `store.mutate`. A new run is due only when `now - lastCompletedAt >= RETAIN_SWEEP_INTERVAL_MS`; it may take over an expired lease only after the prior host deadline. A live lease makes every other setup invocation return immediately, so concurrent workers cannot overlap. The claimed run uses its inherited lifecycle deadline and stops without marking success if it expires or is aborted.

For each sorted candidate, the executor re-reads and validates the envelope, checks its original oldest turn against `max(retainMaxDelayMs * 3, DEFAULT_STRANDED_AFTER_MS)`, and flushes using that envelope's captured target/scope. It writes a candidate checkpoint **only after** the queue/retain outcome has durably advanced the pending record. It writes `lastCompletedAt` and clears `active` only after the whole candidate pass reaches a durable terminal point. A list/read/mutation failure, unknown record, deadline, or aborted operation retains/relinquishes the lease without advancing `lastCompletedAt`; the next due run can retry safely. The checkpoint is an optimization for restart continuation, not proof that an uncommitted remote operation succeeded.

Stranded replay's auto-tags, observation scopes, bank, namespace, document id, and queue fallback all come from the record. The sweeping hook's `scopeContext` and effective config are used only to decide whether the provider is active and to supply endpoint credentials; they never relabel or reroute another record.

## H-5: host goal-completion delivery

### Host lifecycle seam

`TeamManager.completeTeam` in `src/server/agent/team-manager.ts` is the authoritative mutation point: it validates gates, writes `{ state: "complete" }`, then sends the parent notification. Add a narrow injected `goalCompletedDispatcher` alongside the existing `goalProvisionedDispatcher` pattern, and invoke it after the durable complete-state update, before non-essential notification/persistence logging. It must be non-fatal to an already-completed goal: a delivery failure is recorded/safe-logged and never rolls goal state back.

`src/server/server.ts` wires that dispatcher through the existing `ProjectContextManager.setContextConfigurator` seam, as it does for `goalProvisioned`. The dispatcher resolves the owning project context directly from the known completing goal/project, snapshots only bounded goal data (`PersistedGoal` public outcome fields, `taskStore.getByGoalId(goalId)`, and `gateStore.getGatesForGoal(goalId)`), and calls a new `LifecycleHub.dispatchGoalCompleted`.

Add `goalCompleted` to `PROVIDER_HOOKS`, `HOOK_EVENTS`, `HookEvent`, and `LifecycleHook`/provider parsing. It is an explicit host-only event, not an agent route and not a generic HookCtx dispatch. The hub follows `dispatchGoalProvisioned`'s provider selection, runtime resolution, module-worker invocation, host-created deadlines, and fault isolation. Its context includes `scopeContext`, bounded outcome data, `completedAt`, and the provider's normal config/runtime/store host. It does not expose the TeamManager, stores, arbitrary project data, or a goal lookup capability.

`providers/memory.yaml` declares `goalCompleted`; `provider.ts` adds its handler. The outcome document uses a bounded lesson-shaped summary derived from the host snapshot (goal spec/title, bounded task/gate summaries, decision/outcome fields, and bounded artifacts), is tagged `kind:outcome`, and uses the encoded goal identity for its document id. Digest extraction remains fail-open to a simpler bounded outcome representation, but retain/queue durability remains fail-closed.

### Exactly-once semantics

The host, not a provider worker `Set`, owns concurrent coalescing and restart suppression. Reuse `src/server/extension-host/lifecycle-delivery.ts::deliverLifecycleOnce` for every `{ packId, providerId, projectId, goalId, completion revision }` key. The key is canonical/encoded before it reaches the hashed lifecycle marker function; include a stable completion revision (the completed-state timestamp or a host-provided outcome revision), never mutable outcome content.

A duplicate concurrent caller awaits the owner and receives its real failed outcome if it fails; it is not called successful. A restart checks the durable host marker. The marker is committed only after the provider invocation has returned before the shared deadline. For Hindsight, the provider reports success only after either remote outcome retain succeeds or its outcome retry entry is confirmed durable. Thus:

- remote success → durable lifecycle marker, no duplicate on restart;
- remote failure + confirmed durable queue → durable lifecycle marker, later queue replay is allowed;
- remote failure + queue append failure/unknown queue → provider failure, **no** lifecycle marker;
- deadline/abort/marker write failure → **no** durable marker.

This replaces #820's `started`/`retained`/`queued` provider marker protocol. A queued record already carries the complete original scope/bank/namespace and is the durable retry proof; a pre-write `started` record is neither proof of remote success nor proof of queue durability.

## H-6: narrow recall and capability boundary

All provider and route recall starts by resolving `scopeContext.project.id`. Missing scope is fail-closed: return an empty recall result/block, record a safe local diagnostic where appropriate, and make **no Hindsight client or remote call**. A caller cannot cause recall by supplying a project string in a request body.

The normal supported scope is `project`: use an exact `{ project: scope.project.id }` tag filter with strict matching that cannot surface untagged/global or another project's records. Goal-scoped narrowing, if requested internally, adds the authoritative `goal` tag with strict conjunction; a request cannot override project/goal tags. Retain keeps compatible tags but only adds a project/goal tag when the authoritative scope supplied it.

Remove the default and ordinary configuration path for broad `all`: `resolveConfig`, `validateConfigOverrides`, `memory.yaml`, provider `doRecall`, and `routes.recall` reject or ignore it rather than treating it as a benign fallback. `routes.recall` does not accept a body `scope: "all"` escape hatch.

Broad recall may exist only if the central EP-6 capability contract is already implemented and grants `memory.read.all` for this invocation. The implementation must query that central contract at the host boundary and pass a boolean/limited authorization result into the context; it must not add a Hindsight-local config flag, route parameter, pack capability, or private allowlist. If the central contract is absent, unavailable, malformed, or denies the grant, `all` is unavailable and calls fail closed. This goal does not define or implement EP-6.

## File plan

| File | Change |
|---|---|
| `market-packs/hindsight/src/shared.ts` | Add versioned identity codec, scoped v2 pending/queue envelopes, `mutate`-based load/advance helpers, injected-clock sweep control, scoped recall filter, and strict validation/migration quarantine. Preserve tri-state read semantics. |
| `market-packs/hindsight/src/provider.ts` | Consume only `scopeContext` for rich scope; implement batching/flush/sweep with inherited deadline; replay records by captured scope; add bounded `goalCompleted` outcome handler. |
| `market-packs/hindsight/src/routes.ts` | Resolve narrow host scope only; remove body/config broad-scope bypass; do not create a remote client on absent scope. |
| `market-packs/hindsight/src/hindsight-client.ts` | Extend typed retain/recall options only as required for encoded document ids and strict tag matching; retain namespace path encoding. |
| `market-packs/hindsight/providers/memory.yaml` | Declare `goalCompleted`, make project recall the supported default, and remove ordinary `all` configuration. |
| `src/server/agent/pack-contributions.ts` | Admit the explicit host-originated `goalCompleted` provider event. |
| `src/server/agent/lifecycle-hub.ts` | Add typed `GoalCompletedCtx` and `dispatchGoalCompleted`, composed with existing deadline/runtime/store and `deliverLifecycleOnce` logic; do not alter ordinary dispatch scope resolution. |
| `src/server/agent/team-manager.ts` | Add and invoke the narrow completion dispatcher after the durable state transition. |
| `src/server/server.ts` | Wire the dispatcher via project-context configuration and build the bounded owning-context outcome/scope snapshot. |
| `tests2/core/hindsight-provider.test.ts` | Extend existing pack mechanics tests with deterministic fakes. |
| `tests2/core/lifecycle-delivery-foundation.test.ts` and `tests2/core/lifecycle-hub.test.ts` | Pin host completion coalescing, durable marker fence, restart replay, deadlines, and provider event selection. |
| `tests2/integration/hindsight-external.test.ts` | Add host-to-worker scope/privacy and no-cross-project-remote-call coverage. |
| `tests2/tests-map.json` | Register every new v2-native core/integration file; update the existing Hindsight entries if their scopes change. |
| `docs/hindsight-memory.md` and `docs/lifecycle-hub.md` | After implementation, align the public operational contract with this design. No UI documentation is added. |

## Test plan and registration

Add registered `tests2/core/hindsight-memory-completion.test.ts` for pure identity/sweep/record transitions, retaining `hindsight-provider.test.ts` for provider behavior. Register both with `runner: vitest`, `tier: unit`, `project: core`; add focused integration coverage under `tests2/integration/hindsight-memory-completion.test.ts` with its declared execution tier/project in `tests2/tests-map.json`.

Required cases:

1. Prefix and identity races: adversarial project/goal/session ids, same session id in two projects, bank/namespace changes, list prefix near-matches, and restart decoding cannot select the wrong record/document.
2. Sweep: not-due vs due cadence under an injected clock; concurrent setup calls create one lease/run; expired lease takeover; deadline/abort never advances completion; remote success or durable queue success checkpoints only after mutation; failed/unknown durability does not checkpoint; restart continues safely.
3. Stranded privacy: original project/goal/session/role, bank/namespace, tags, and observation scope survive replay; sweeping session scope/config cannot leak into the remote call; malformed/legacy insufficient-provenance data causes no remote call.
4. Goal completion: concurrent calls cause one retain, completed marker suppresses restart replay, confirmed queue counts as successful lifecycle delivery, queue failure/unknown read/deadline has no marker, and bounded outcome content remains within cap.
5. Scope narrowing: project and optional goal filters are strict; missing `scopeContext` is an empty/no-client result; forged flat fields and route body scope cannot broaden; absent EP-6 grant makes `all` unavailable; project A can never issue a remote recall/retain tagged or routed as project B.
6. Regression coverage for #1091/#1106: retain compound failure stays visible, queue read error is not overwritten, and drain removal only follows durable queue mutation.

Run after implementation:

```bash
npm run check
npx vitest run tests2/core/hindsight-provider.test.ts tests2/core/hindsight-memory-completion.test.ts tests2/core/lifecycle-delivery-foundation.test.ts tests2/core/lifecycle-hub.test.ts tests2/integration/hindsight-memory-completion.test.ts
npm run test:unit
```

## Explicit non-goals

- Settings, status, memory, reflect, or admin UI.
- Agent tools, MCP tools, panels, entrypoints, or a broad memory browser.
- Creating EP-6, `memory.read.all`, or any Hindsight-private authorization path.
- Replacing #1091/#1106 store semantics, #1099 scope construction, lifecycle deadline ownership, the generic runtime supervisor, or pack-store ownership.
- Cross-bank fan-out, cross-engine deduplication, or migration that guesses missing stranded-record provenance.
