# EP-3 — Scheduled Advisors

**Status:** implementation design. **Scope:** run declared, granted hook modules after every N completed agent turns. Runs are asynchronous advisory observations only; they never alter a prompt, session, goal, configuration, tool permission, queue, or agent state.

## Decision

EP-3 extends the existing schema-2 hook declaration, `PackContributionRegistry`, `LifecycleHub`, `ModuleHost`, session persistence, and Context trace. It adds no second extension loader, scheduler process, timer, cost tracker, or grant path.

A scheduled advisor is a `mode: decide` hook with a valid `schedule.everyNTurns`. It needs the existing exact `decide` grant to execute. This is deliberately stricter than ordinary inert hook metadata: revocation is an immediate kill switch, and no ungranted hook code is imported. A valid result is recorded as `advised`; it is never applied. Observe-mode hooks, unscheduled hooks, and wall-clock-only declarations stay inert.

```text
final agent_end (one logical completed turn)
  -> increment and persist session.scheduledAdvisorTurnCount
  -> existing fire-and-forget LifecycleHub.dispatch("afterTurn", ...)
  -> fire-and-forget LifecycleHub.dispatchScheduledAdvisors(...)
       -> current active declaration + current exact decide grant
       -> one in-flight worker per (sessionId, packId, hookId), otherwise drop
       -> ModuleHost worker, deadline and AbortSignal
       -> current eligibility check again -> safe Context trace outcome
```

The dispatch call is made only after terminal bookkeeping has reached idle and remains un-awaited. Neither worker startup, a slow helper, a failed helper, trace persistence, nor cancellation can delay status broadcast, idle waiters, or queue draining.

## Declaration and handler contract

### `hooks/<listName>.yaml`

Add the optional `schedule` key to the existing strict hook shape in `src/server/agent/pack-contributions.ts`:

```yaml
id: review.nudge
module: ../lib/advisors.mjs
mode: decide
events: [afterTurn]
capabilities: []
schedule:
  everyNTurns: 3
  # wallClockMs: 300000  # accepted typed future field; inert in EP-3
budget:
  timeoutMs: 1500
```

```ts
export interface HookSchedule {
  /** Required for an EP-3 runnable advisor; integer 1..10_000. */
  everyNTurns?: number;
  /** Typed reserved contract only. EP-3 schedules no clock timers. */
  wallClockMs?: number;
}

export interface HookContribution {
  // existing members unchanged
  schedule?: HookSchedule;
}
```

`parseHookSchedule()` is owned by `pack-contributions.ts`, added to `HOOK_TOP_LEVEL_KEYS`, and uses these rules:

- `schedule` must be a mapping with only `everyNTurns` and `wallClockMs`; unknown keys drop that declaration just as today's unknown hook keys do.
- Present values are safe positive integers in `1..10_000`; a missing, fractional, non-finite, duplicate/array, or out-of-range value drops the declaration. `wallClockMs` has the same bounds but creates neither a timeout nor an interval.
- A runnable EP-3 declaration must have `mode: "decide"`, exactly `events: ["afterTurn"]`, and `schedule.everyNTurns`. Invalid combinations are dropped during loading, not deferred to runtime.
- `schedule: { wallClockMs: ... }` without `everyNTurns` remains valid typed metadata but is not selected by EP-3. This is the entire deferred wall-clock contract; no `setTimeout`, `setInterval`, persistence of due timestamps, or catch-up behaviour lands in this slice.

The module exports an `advisors` member keyed by the declared hook id:

```ts
export const advisors = {
  async "review.nudge"(ctx: ScheduledAdvisorCtx): Promise<ScheduledAdvisorResult> {
    return { advisory: { value: "review-needed" } };
  },
};

export interface ScheduledAdvisorCtx {
  readonly sessionId: string;
  readonly projectId?: string;
  readonly goalId?: string;
  readonly roleName?: string;
  readonly cwd: string;
  readonly turn: { readonly index: number };
  readonly config: Readonly<Record<string, unknown>>;
  readonly budget: { readonly maxTokens: number };
  readonly scopeContext?: HookScopeContext;
}
export type ScheduledAdvisorResult =
  | undefined
  | { readonly advisory?: { readonly value?: string } };
```

`value`, when present, must be the existing safe identifier grammar. It is only a trace label. The handler cannot return blocks, prompt text, reasons, messages, a decision proposal, cost, mutations, or an apply callback. `LifecycleHub` owns the strict result validator; malformed output becomes `dropped / Malformed result`. The worker receives no `gateway` secret and no Host API. Thus scheduled advisors cannot use store/session/agent capabilities in EP-3 even when their declaration lists them; those declared capabilities remain grant metadata for later slices.

## Ownership and implementation ledger

| Owner | Required change |
|---|---|
| `src/server/agent/pack-contributions.ts` | Own `HookSchedule`, strict schema parsing, and compatibility-preserving `HookContribution.schedule`. Keep loading/importing inert. |
| `src/server/extension-host/pack-contribution-registry.ts` | Add `listScheduledAdvisorHooks(projectId)` as a filtered projection of already activation-filtered `listHooks()`. It returns only declarations with `everyNTurns`; it does not cache grants. |
| `src/server/agent/extension-grant-policy.ts` | Reuse `resolveExtensionGrant`; add no capability kind. EP-3 calls it with the server-derived `{ packId, hookId }` and `"decide"`. |
| `src/server/server.ts` | Supply `LifecycleHub` an `isScheduledAdvisorAuthorized(projectId, packId, hookId)` closure. It resolves current registry rows and `ProjectConfigStore.getExtensionGrants()` on every launch and completion check. Extend the existing resolver invalidation path to call `lifecycleHub.cancelScheduledAdvisors()` so pack activation, installation/removal, configuration refresh, or grant revocation terminates active helpers immediately. |
| `src/server/agent/lifecycle-hub.ts` | Own `ScheduledAdvisorCtx`, result validation, selection, invocation, one-in-flight state, abort controllers, final authorization fence, trace outcome creation, and `cancelScheduledAdvisors()`. Ordinary provider `dispatch()` stays unchanged. |
| `src/server/extension-host/module-host-worker.ts` and `module-host-bootstrap.ts` | Add export kind `"advisors"` and an optional `AbortSignal` invocation path. An already-aborted request never creates a worker; abort terminates the worker/children, removes listeners, and rejects with a classified cancellation error. No other caller changes behaviour. |
| `src/server/agent/session-store.ts` | Add optional `scheduledAdvisorTurnCount?: number` to `PersistedSession` and `UpdatableSessionFields`; normalize a legacy/malformed value to `0`. |
| `src/server/agent/session-manager.ts` | Hydrate the live counter from persisted state, advance/persist it once at the existing final `agent_end` boundary, and call the two existing/new fire-and-forget post-turn paths in order. It never creates a timer. |
| `src/server/agent/context-trace-store.ts` | Add optional safe `packId` to `TraceOutcomeRow`, require/sanitize it for scheduled-advisor outcomes, and add fixed reasons `Overlapping invocation`, `Cancelled`, and `Disabled or revoked`. `ms` remains the measured execution cost. |
| `src/app/context-trace.ts` and `src/ui/components/ContextTraceInspector.ts` | Extend the existing outcome normalizer/presenter to display the sanitized pack id and hook id with fixed outcome/reason labels. It must not display handler result prose. |

### LifecycleHub algorithm

`dispatchScheduledAdvisors(base)` is `async`, but its caller always prefixes it with `void` and attaches a logging-only catch. It takes the same immutable post-turn coordinates and `turn.index` used by `afterTurn`.

1. Obtain the activation-filtered scheduled declarations from the registry. For each declaration derive `packId` from `packRoot` and require `turn.index % everyNTurns === 0`.
2. Check the authorization closure immediately before launch. It must re-read the project grant store and require the declaration is still active, `mode: decide`, and has the exact `decide` grant. An inactive/ungranted candidate does not import code and emits no advice.
3. Key the in-flight map by `sessionId + NUL + packId + NUL + hookId`. If occupied, append `dropped / Overlapping invocation` with `ms: 0`; do not queue, retry, or retain a pending due turn.
4. Insert an `AbortController`, derive the validated module URL exactly as provider dispatch does, and invoke `ModuleHost` with `exportKind: "advisors"`, `member: hook.id`, hook timeout, and the signal. Measure monotonic elapsed milliseconds in the parent.
5. On resolution, validate only the narrow result above. Re-check authorization and active declaration after awaiting: if it changed, discard the result and append `dropped / Disabled or revoked`; never let an already-returned result escape a revoke.
6. Emit `advised` for valid output, `dropped / Malformed result` for invalid output, `dropped / Timed out` for timeout, `error` for a non-timeout worker error, and `dropped / Cancelled` for abort. Always remove precisely this map entry in `finally`; a late completion cannot remove a later invocation.

`cancelScheduledAdvisors(filter?)` aborts matching controllers and clears no pending work because none exists. Session shutdown/termination calls it with `sessionId` before the existing shutdown dispatch. A global resolver invalidation calls it without a filter. Cancellation is idempotent.

## Turn persistence and resume semantics

`scheduledAdvisorTurnCount` is a session-owned monotonic count, not a transcript count and not the existing test-only `completedTurnCount` field. On creation it is `0`; old rows hydrate as `0`. During the existing final `agent_end` branch (after retryable and duplicate terminal fences), SessionManager increments the live counter and immediately calls `SessionStore.update()` with the new value **before** scheduling advisors. It restores that value into the live session before any new prompt can complete.

A compaction only dispatches `beforeCompact`; it neither increments nor resets this value. An in-place respawn/server restart retains the persisted value and the next final agent turn uses the same modulo calculation. A process that dies while an advisor is running does not re-run the old due turn: workers are process-local and no invocation queue or lease is durable. The next due number is determined solely by the restored counter. This is intentional at-most-once invocation per observed due turn, not delayed catch-up.

Cancelled final turns follow the existing `completedTurnCount` semantics and are counted exactly once; retryable `agent_end` and duplicate/late terminal events count zero times. A due index is therefore fired at most once and only when `index % N === 0`.

## Trace and cost attribution

Scheduled execution consumes worker time, not agent/model tokens. EP-3 does **not** invent a dollar/token estimate or write to `CostTracker`; there is no trustworthy usage source for arbitrary trusted pack code. Its attributable execution cost is the parent-measured `ms`, durably recorded with the server-derived `packId` and `hookId` in the existing Context trace outcome envelope:

```ts
{ kind: "advisory", packId, hookId, event: "afterTurn", outcome: "advised", ms }
```

The trace sanitizer accepts `packId` only under the existing safe identifier grammar, bounds `ms`, drops unsafe values, and never persists the handler's prose/result object. This gives cost and failure attribution to the actual winning pack (not the session or a caller-provided label) while preserving EP-5's metadata-only guarantee.

## Deterministic `tests2` plan

Register all new test files in `tests2/tests-map.json`; use fakes/deferred promises and injected clocks, never sleeps or real intervals.

| Test | Coverage |
|---|---|
| `tests2/core/pack-contributions.test.ts` | Valid every-N parsing; boundaries `1`/`10_000`; malformed/unknown/range/fractional schedule rejection; runnable mode/event constraints; `wallClockMs` metadata accepted but not selected; activation filter still removes scheduled declarations. |
| `tests2/core/scheduled-advisor-lifecycle.test.ts` (new) | Fake registry, authorization closure, trace store, and controllable ModuleHost prove due indexes `N, 2N`; non-due indexes do nothing; same hook ids in different packs do not collide; only one overlap is dropped; failure/timeout/malformed-result isolation lets another pack run; final authorization fence suppresses a revoked result; cancel terminates only matching work and releases its key. Assert no blocks/mutation/apply capability reaches the handler. |
| `tests2/core/session-manager-lifecycle-dispatch.test.ts` | Extend the existing final-boundary fixture: terminal settlement and queue path complete before the scheduler promise settles; retries/duplicate terminal events do not advance the persisted counter; update precedes scheduler dispatch; callback ordering is ordinary `afterTurn` then scheduled advisor; shutdown cancels session work. |
| `tests2/core/session-store.test.ts` (or existing persistence owner) | Round-trip `scheduledAdvisorTurnCount`; absent/corrupt legacy values normalize to zero; restored SessionManager starts at the durable count. Include compaction/respawn-style recreation and prove its next due turn is calculated from the saved count. |
| `tests2/core/extension-host-module-isolation.test.ts` | `advisors` export group dispatch, pre-aborted no-worker behavior, and mid-flight abort terminating a deferred/child-owning worker without changing actions/routes/providers. |
| `tests2/core/context-trace-store.test.ts` and `tests2/dom/context-trace-controller.test.ts` | Safe pack attribution and fixed scheduled outcomes render; unsafe pack ids, prose, and secret-looking result fields do not persist or reach the inspector; duration is bounded. |
| `tests2/browser/e2e/context-trace-inspector.spec.ts` | Fixture scheduled advisor fires on the configured due turn, reload/resume preserves cadence, disabled/revoked state has no new advisory result, and the inspector shows only fixed pack/hook/outcome/duration metadata. |

Focused implementation command:

```bash
npx vitest run tests2/core/pack-contributions.test.ts tests2/core/scheduled-advisor-lifecycle.test.ts tests2/core/session-manager-lifecycle-dispatch.test.ts tests2/core/context-trace-store.test.ts tests2/dom/context-trace-controller.test.ts
```

## Non-goals

No wall-clock or cron timers, catch-up, queue, retry policy, user notifications, prompt injection, tool/config/session mutation, agent spawning, free-form advisory display, financial/token-cost estimation, new capability grants, or second trace/cost store. Those require a later explicit contract.
