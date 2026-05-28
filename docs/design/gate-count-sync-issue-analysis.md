# Gate Count Sync — Issue Analysis

## Scope audited

Surfaces requested:

- Sidebar goal rows and badges
- Chat header goal status widget pill/popover
- Goal dashboard pipeline and gate list
- Goal status pages/surfaces that render gate counts

Searches covered `docs/`, `tests/`, and `src/` for `gateStatusCache`, `refreshGateStatusForGoal`, `gate_signal_received`, `gate_status_changed`, `gate_reset`, `gate_verification_*`, human sign-off, and dashboard/widget/sidebar rendering paths.

## Mechanical reproduction scenarios

These are the user-visible stale-count flows the fix and tests should reproduce before implementation and prove fixed afterward.

### Scenario A: running verification count diverges

1. Create or open a workflow goal with at least two gates and a session attached to the goal.
2. Open three surfaces at once: the sidebar goal row, the chat header `<goal-status-widget>` pill/popover, and the goal dashboard pipeline/list.
3. Signal the first pending gate so the server emits `gate_signal_received`, then `gate_verification_started`, `gate_verification_phase_started`, and `gate_verification_step_started`.
4. Expected current truth while verification is running: `passed=0`, `total=N`, `verifying=true`, `verifyingCount=1`.
5. Failure symptom: dashboard live verification rows update immediately, but sidebar/widget badge can remain at `0/N` without the running colour/count because the shared cache does not refresh on every active verification event.
6. After `gate_verification_complete` and `gate_status_changed`, all surfaces should converge to `1/N` passed with no running indicator.

### Scenario B: human sign-off pulse/count remains stale after resolution

1. Use a workflow gate with a `human-signoff` verification step and signal it.
2. Wait for `gate_verification_awaiting_human`; expected truth is `awaitingSignoffCount=1`, `awaitingHumanSignoff=true`, and the widget pulse plus sidebar attention state are visible.
3. Approve or reject the sign-off through the review pane, which POSTs `/api/goals/:goalId/gates/:gateId/signoff`.
4. The server resumes the harness, clears `awaitingHuman`, and emits `gate_verification_step_complete`, then eventually `gate_verification_complete` / `gate_status_changed`.
5. Failure symptom: widget local `_awaitingSignoffs` or dashboard live rows may update, but sidebar/widget badge can keep `awaitingHumanSignoff=true` until final completion, navigation, or polling because `gate_verification_step_complete` is not a shared-cache invalidation.
6. Expected fixed behavior: the sign-off pulse and shared `awaitingSignoffCount` clear after successful POST and/or the step-complete WS event, before any reload.

### Scenario C: reset invalidates downstream gates inconsistently

1. Start from a goal with gate 1 and at least one downstream dependent gate passed, so all surfaces show e.g. `2/3`.
2. Reset gate 1 from the goal status widget or dashboard.
3. The server broadcasts `gate_status_changed` for affected gates and then `gate_reset` with affected/downstream IDs.
4. Expected truth: selected and downstream gates become pending, active verification/sign-off counts for affected gates clear, and all surfaces show the lower passed count, e.g. `0/3`.
5. Failure symptom: widget popover/dash list may refresh from their local handlers while sidebar/widget pill remains stale because `RemoteAgent` does not explicitly handle `gate_reset`, and dashboard may preserve stale sign-off counters when it writes the shared cache.
6. Expected fixed behavior: `gate_reset` is an authoritative shared-summary invalidation and all surfaces match without reload.

### Scenario D: reload/reconnect rehydrates truth

1. Produce any of the states above: running verification, awaiting human sign-off, completed gate, or post-reset pending downstream gates.
2. Reload the browser or reconnect the viewer/session websocket.
3. Expected fixed behavior: surfaces rehydrate from `/api/goals/:id/gates?view=summary` plus active verification data and agree before user navigation.

## Affected files and symbols

| Area | File | Symbols / paths | Current role |
|---|---|---|---|
| Shared app cache | `src/app/state.ts` | `state.gateStatusCache` | Goal-id keyed summary: `{ passed, total, verifying, verifyingCount, awaitingSignoffCount, awaitingHumanSignoff }`. |
| Shared cache refresh | `src/app/api.ts` | `fetchGoalGatesWithSignoffCount()`, `refreshGateStatusCache()`, `refreshGateStatusForGoal()` | Fetches `/api/goals/:id/gates?view=summary`, derives counts, writes `state.gateStatusCache`, renders app only when values changed. |
| Initial/reload hydration | `src/app/api.ts` | `refreshSessions()` | On initial load or goals generation change, refreshes gate summaries for all workflow goals. |
| Sidebar badge | `src/app/render-helpers.ts` | `renderGoalBadge()`, `renderGateProgressBadge()` | Sidebar falls back from PR badge to gate summary cache. Verifying state displays `passed + verifyingCount` in blue. |
| Sidebar rows | `src/app/render-helpers.ts` | `renderGoalGroup()` | Renders goal row and calls `renderGoalBadge(goal.id)`. |
| Goal status widget host | `src/ui/components/AgentInterface.ts` | `<goal-status-widget>` mount | Mounts widget for sessions with `goalId` or `teamGoalId`. |
| Goal status widget local data | `src/ui/components/GoalStatusWidget.ts` | `_gates`, `_awaitingSignoffs`, `_fetchInitial()`, `_refreshGates()`, `_refreshActive()`, `_handleWsEvent()` | Maintains a separate per-widget gate list and active sign-off list. The pill/dropdown badge still calls shared `renderGateProgressBadge(this.goalId)`. |
| Goal dashboard local data | `src/app/goal-dashboard.ts` | `gates`, `liveVerifications`, `loadDashboardData()`, `applyGateState()`, `refreshGatesFromWsEvent()`, `fetchActiveVerifications()`, `handleLiveVerificationEvent()` | Maintains page-local full gate list and live verification state. Also writes `state.gateStatusCache` from full `/gates`, preserving previous sign-off counters. |
| Dashboard pipeline/list | `src/app/goal-dashboard.ts` | `computeGateDepthLevels()`, `renderGatePipeline()`, `renderWorkflowChecklist()` | Uses page-local `gates`; treats a gate as `running` when any signal has `verification.status === "running"`. |
| Session WS event path | `src/app/remote-agent.ts` | `handleMessage()` cases for gate events | Updates shared gate cache for some events, dispatches verification events for live components. Currently lacks a `gate_reset` case and does not refresh the shared cache on phase/step events. |
| Dashboard viewer WS path | `src/app/goal-dashboard.ts` | `connectDashboardWs()` | Subscribes to goal viewer WS. Refreshes dashboard gates only for `gate_signal_received` and `gate_status_changed`; dispatches all verification events. |
| Verification event bus | `src/app/verification-event-bus.ts` | `dispatchVerificationEvent()` | Dedupe bridge for `gate_verification_*` CustomEvents consumed by dashboard/live verification components. It does not update shared gate summaries. |
| Server gate summary | `src/server/server.ts` | `GET /api/goals/:goalId/gates?view=summary` | Returns slim gates plus goal-wide `awaitingSignoffCount` from active verifications. It does not include running status directly; clients infer it from signal verification fields when present. |
| Server reset endpoint | `src/server/server.ts` | `POST /api/goals/:goalId/gates/:gateId/reset` | Cancels active verifications for selected/downstream gates, resets gate store, broadcasts `gate_status_changed` for affected gates then `gate_reset`. |
| Re-signal reset path | `src/server/server.ts` | `POST /api/goals/:goalId/gates/:gateId/signal` | If re-signaling a passed gate, `cascadeReset()` resets downstream and broadcasts `gate_status_changed` for downstream gates, then records/broadcasts the new signal. |
| Human sign-off | `src/server/server.ts`, `src/server/agent/verification-harness.ts` | `/signoff`, `resolveSignoff()`, `gate_verification_awaiting_human`, step complete/final complete events | Sign-off resolution itself returns HTTP 200 without a direct cache event; follow-up harness events must clear `awaitingSignoffCount` and update pass/fail counts. |
| Pinning / related tests | `tests/e2e/ui/goal-status-widget.spec.ts`, `tests/sidebar-goal-rendering.spec.ts`, `tests/notification-policy.spec.ts`, `tests/e2e/human-signoff.spec.ts`, `tests/gate-signal-step-enumeration.test.ts`, `tests/e2e/gate-signal-progress.spec.ts` | Existing coverage for widget flow, reset, badge rendering, notification policy, sign-off REST, and signal step enumeration. No focused test currently asserts every surface receives the same active verification count/state on each verification phase/step event and after sign-off resolution. |

## Root-cause evidence with source references

- `src/app/state.ts:274` defines `state.gateStatusCache`, the shared summary cache read by sidebar badges, notification policy, and the goal status widget pill.
- `src/app/api.ts:757` fetches `/api/goals/:id/gates?view=summary`; `src/app/api.ts:772` refreshes all workflow goals; `src/app/api.ts:807` refreshes one goal. These helpers derive `passed`, `verifying`, `verifyingCount`, `awaitingSignoffCount`, and `awaitingHumanSignoff` client-side.
- `src/app/api.ts:250` hydrates gate summaries during `refreshSessions()` only on initial load or goal list generation changes, so live correctness depends on WS invalidation between reloads.
- `src/app/render-helpers.ts:675` reads `state.gateStatusCache` in `renderGateProgressBadge()`; `src/app/render-helpers.ts:728` and `src/app/render-helpers.ts:755` make sidebar goal rows fall back to that same badge.
- `src/ui/components/GoalStatusWidget.ts:180` and `src/ui/components/GoalStatusWidget.ts:189` fetch widget-local full gates and active sign-offs, while `src/ui/components/GoalStatusWidget.ts:688` renders the pill count via the shared `renderGateProgressBadge(this.goalId)`. This creates an internal split between popover details and pill count.
- `src/ui/components/GoalStatusWidget.ts:339` handles widget viewer WS events; `src/ui/components/GoalStatusWidget.ts:344` refreshes local data on `gate_reset`, and `src/ui/components/GoalStatusWidget.ts:351` refreshes active state on step start/complete. These handlers do not update the shared cache used by the pill.
- `src/ui/components/GoalStatusWidget.ts:527` POSTs reset and `src/ui/components/GoalStatusWidget.ts:549` refreshes only widget-local gates/active sign-offs afterward.
- `src/app/remote-agent.ts:1510` refreshes the shared cache for `gate_signal_received`; `src/app/remote-agent.ts:1514` refreshes it for `gate_status_changed`; `src/app/remote-agent.ts:1521` refreshes for `gate_verification_started`; `src/app/remote-agent.ts:1532` refreshes for `gate_verification_awaiting_human`; and `src/app/remote-agent.ts:1542` refreshes for `gate_verification_complete`.
- `src/app/remote-agent.ts:1525` through `src/app/remote-agent.ts:1529` dispatch `gate_verification_phase_started`, `gate_verification_step_started`, `gate_verification_step_complete`, and `gate_verification_step_output` to live components but do not refresh the shared cache. `gate_verification_step_output` should stay detail-only, but phase/step started and step complete can affect effective running/sign-off state.
- `src/app/remote-agent.ts` has no `gate_reset` case near the gate-event switch, so shared cache invalidation after reset relies on companion `gate_status_changed` broadcasts and ordering rather than the explicit reset event.
- `src/app/goal-dashboard.ts:184` opens a dashboard viewer WS; `src/app/goal-dashboard.ts:212` refreshes full gates only for `gate_signal_received` and `gate_status_changed`; other verification events go to `dispatchVerificationEvent()`.
- `src/app/goal-dashboard.ts:565` stores dashboard-local gates, then `src/app/goal-dashboard.ts:567` syncs to the shared sidebar cache. `src/app/goal-dashboard.ts:576` through `src/app/goal-dashboard.ts:579` preserve old sign-off counters because bare `/gates` does not include active sign-off aggregates.
- `src/app/goal-dashboard.ts:697` refreshes full gates on `gate_verification_complete`, but dashboard live detail updates for earlier phase/step events do not necessarily update shared summary counts.
- `src/app/review-sources.ts:296` starts human sign-off submission, `src/app/review-sources.ts:304` POSTs `/signoff`, and `src/app/review-sources.ts:319` already refreshes shared gate status after the successful POST. This is good but insufficient alone because other surfaces still need the WS invalidation path and trailing truth refresh.
- `src/server/server.ts:5138` aggregates active verification human sign-offs into the `?view=summary` response consumed by the shared cache.
- `src/server/server.ts:5306` implements explicit reset; `src/server/server.ts:5352` broadcasts `gate_status_changed` for affected gates, then `src/server/server.ts:5355` broadcasts `gate_reset`.
- `src/server/server.ts:5551` cascade-resets downstream gates when re-signaling a passed gate, and `src/server/server.ts:5557` broadcasts downstream `gate_status_changed` events.
- `src/server/server.ts:5694` handles human sign-off resolution. `src/server/agent/verification-harness.ts:799` resolves the parked sign-off promise; `src/server/agent/verification-harness.ts:2247` marks a human step awaiting; `src/server/agent/verification-harness.ts:2259` broadcasts `gate_verification_awaiting_human`; `src/server/agent/verification-harness.ts:2282` clears `awaitingHuman`; and `src/server/agent/verification-harness.ts:2324` broadcasts `gate_verification_step_complete`.

## Current data flow

### Server truth

1. Gate persisted state lives in `GateStore` (`src/server/agent/gate-store.ts`). Stored gate status is `pending`, `passed`, or `failed`.
2. In-flight verification state lives in `VerificationHarness.activeVerifications` and is persisted separately for restart recovery.
3. `GET /api/goals/:goalId/gates` returns enriched gate store state with signal histories.
4. `GET /api/goals/:goalId/gates?view=summary` returns slim gate rows and aggregates `awaitingSignoffCount` from active verifications.
5. `GET /api/goals/:goalId/verifications/active` returns richer live verification state, including awaiting-human steps.

### Sidebar/shared cache

1. `refreshSessions()` hydrates goals/sessions.
2. On initial load or goals generation change, it calls `refreshGateStatusCache(true)`.
3. `refreshGateStatusCache()` and `refreshGateStatusForGoal(goalId)` fetch `?view=summary` and derive:
   - `passed` from gate statuses,
   - `total` from the workflow snapshot on `state.goals`,
   - `verifying` / `verifyingCount` from `signals[].verification.status === "running"`,
   - sign-off counters from `awaitingSignoffCount`.
4. `renderGoalBadge()` and `renderGateProgressBadge()` read only `state.gateStatusCache`.

### Goal status widget

1. `<goal-status-widget>` fetches bare `/gates` into local `_gates` and `/verifications/active` into local `_awaitingSignoffs`.
2. The dropdown gate list renders from local `_gates`.
3. The pill/dropdown progress badge calls `renderGateProgressBadge(this.goalId)`, so its count comes from `state.gateStatusCache`, not `_gates`.
4. The widget has its own viewer WS and refreshes local `_gates` / `_awaitingSignoffs` for several events.
5. The widget does not write `state.gateStatusCache`; it relies on app-level event handling or polling to update the shared badge.

### Dashboard

1. `loadDashboardData()` fetches the goal and bare `/gates` into page-local `gates`.
2. `fetchActiveVerifications()` separately seeds `liveVerifications` from `/verifications/active` for detailed live rows.
3. `applyGateState()` writes page-local `gates` and also writes `state.gateStatusCache` using the bare `/gates` result, preserving previous sign-off counters.
4. The pipeline and gate checklist render from page-local `gates`; they show `running` if a stored signal is `verification.status === "running"`.
5. Dashboard viewer WS refreshes page-local gates on `gate_signal_received` and `gate_status_changed`; verification events update `liveVerifications`, and `gate_verification_complete` also refetches gates.

## Stale-cache root causes

1. **Three client-side gate sources are live at once.**
   - Shared `state.gateStatusCache` powers sidebar and the widget badge.
   - Widget `_gates` / `_awaitingSignoffs` powers the widget popover and sign-off pulse.
   - Dashboard `gates` / `liveVerifications` powers pipeline/list/details.
   These sources refresh through different event handlers and different REST endpoints.

2. **`refreshGateStatusForGoal()` is not the single invalidation path.**
   `RemoteAgent` calls it for `gate_signal_received`, `gate_status_changed`, `gate_verification_started`, `gate_verification_awaiting_human`, and `gate_verification_complete`, but not for `gate_reset`, `gate_verification_phase_started`, `gate_verification_step_started`, or `gate_verification_step_complete`.

3. **Human sign-off resolution has no direct shared-cache invalidation.**
   `/signoff` resolves a deferred verifier and returns `{ resolved: true }`. The shared cache must update from subsequent `gate_verification_step_complete` / `gate_verification_complete` / `gate_status_changed`. The current session WS path does not refresh on `gate_verification_step_complete`, so `awaitingHumanSignoff` can remain true until final completion, a status change, or polling/navigation. This contradicts the intent documented in `docs/design/human-signoff-gates.md`.

4. **`gate_reset` is handled by the widget but not by `RemoteAgent`.**
   The server broadcasts `gate_status_changed` for affected gates before `gate_reset`, so many reset cases eventually refresh via `gate_status_changed`. But the explicit reset event is not wired into the shared cache path, making reset correctness dependent on companion broadcasts and ordering.

5. **Dashboard writes a partial shared cache.**
   `applyGateState()` writes `state.gateStatusCache` from bare `/gates` and preserves old sign-off counters. If the dashboard refresh runs after a sign-off state transition but before the shared summary refresh, it can keep stale `awaitingSignoffCount` while updating passed/verifying counts.

6. **Active verification state is split between persisted signal rows and active verification rows.**
   The dashboard uses both `signals[].verification.status` and `liveVerifications`; sidebar/widget badge uses only the summary-derived cache. A verification phase/step event can visibly update dashboard live details while the sidebar/widget badge remains on the last summary-derived count.

7. **The widget badge and widget popover can disagree internally.**
   The popover `_gates` may refresh on a widget viewer WS event, while the badge reads shared `state.gateStatusCache`. If app-level cache invalidation misses the same event, the popover rows can be current while the pill badge is stale.

8. **No debouncing/in-flight coalescing exists for per-goal gate summary refreshes.**
   Adding every missing event directly to `refreshGateStatusForGoal()` would be correct but may fan out redundant REST calls during step-output-heavy verification unless coalesced. `gate_verification_step_output` should not refresh summary counts.

## Required event invalidations

Use one targeted per-goal summary refresh path for all events that can change any field in `state.gateStatusCache`.

| Event / action | Shared summary fields affected | Required client invalidation |
|---|---|---|
| Initial load / reconnect / reload | all fields | Hydrate from `/api/goals/:id/gates?view=summary` for workflow goals. Existing `refreshSessions()` path mostly covers this. Viewer/dashboard reconnect should also force current-goal summary refresh. |
| `gate_signal_received` | `verifying`, `verifyingCount`; sometimes downstream `passed` count after re-signal reset | Refresh summary for `goalId`. Existing `RemoteAgent` path does this. |
| `gate_verification_started` | `verifying`, `verifyingCount` | Refresh or optimistically mark the specific gate running. Existing path refreshes; keep but debounce. |
| `gate_verification_phase_started` | active/running presentation may begin for newly unblocked phase rows; pass count usually unchanged | Refresh summary if the summary derives running from persisted signal rows; otherwise update companion active-state cache. Do not rely on dashboard-only live state. |
| `gate_verification_step_started` | same as phase started; important when a human-signoff step parks immediately after start | Refresh active summary or companion active-state cache. |
| `gate_verification_awaiting_human` | `awaitingSignoffCount`, `awaitingHumanSignoff` | Refresh summary and active sign-off list. Existing `RemoteAgent` and widget local paths do this; keep and debounce. |
| `gate_verification_step_complete` | `awaitingSignoffCount` may clear for human sign-off; running count can change if last running step in a phase completed; final status may still be running | Refresh summary. This is currently missing in `RemoteAgent` for shared cache. |
| `gate_verification_complete` | `passed`, `verifying`, `verifyingCount`, sign-off counters | Refresh summary and full gate list. Existing paths refresh; keep and debounce. |
| `gate_status_changed` | `passed` count, failed/pending state, sometimes reset consequences | Refresh summary. Existing `RemoteAgent` and dashboard paths handle this. |
| `gate_reset` | selected and downstream `passed`, `verifying`, sign-off counters | Refresh summary for `goalId`; full dashboard/widget gate list should also refresh. Explicitly handle even though status-changed events are also emitted. |
| Human sign-off approve/reject HTTP response | active sign-off count, later gate status | Either the caller should trigger a local summary refresh after successful POST, or the subsequent WS `gate_verification_step_complete` must do so. Prefer both: immediate optimistic/local refresh plus debounced WS truth refresh. |
| Cancel verification | `verifying`, `verifyingCount`, possibly sign-off counters | Treat resulting `gate_verification_complete { status: "cancelled" }` as a summary invalidation and refetch active verifications. |

`gate_verification_step_output` should not refresh gate summaries; it affects only detailed live output.

## Active verification state handling

Current behavior treats active verification as derived data:

- Sidebar/widget badge: `state.gateStatusCache.verifying` and `verifyingCount` are derived from `/gates?view=summary` signal histories.
- Dashboard pipeline/list: derives `running` from page-local full gate signal histories.
- Dashboard detail: uses `liveVerifications` for per-step live rows and output.
- Widget sign-off pulse: uses `_awaitingSignoffs` from `/verifications/active`, but the badge uses the shared cache.

Recommendations:

1. **Keep persisted gate status as pass/fail/pending, but make active state first-class in the client summary.** The summary should represent effective UI state: `passed`, `total`, `verifying`, `verifyingCount`, `awaitingSignoffCount`, and optionally `runningGateIds` / `awaitingSignoffGateIds`.
2. **Derive all count badges from the same summary store.** Dashboard can keep full `gates` for details, but its count/progress should either use the shared summary or update it through the same helper that sidebar/widget use.
3. **Do not count passed gates as verifying.** Current logic excludes passed gates from `verifyingCount`; preserve that so a just-passed gate does not display `(passed+1)/total`.
4. **Treat awaiting-human as an active verification state.** A human-signoff step has no process/session but is legitimately running while parked. Summary refresh must include `/verifications/active`-derived sign-off counts, as the existing `?view=summary` endpoint does.
5. **On reconnect, rehydrate both summary and live details.** `refreshGateStatusForGoal(goalId)` should be called for the current session goal/dashboard goal when a WS reconnects, and dashboard/widget should continue fetching `/verifications/active` for detailed rows.

## Reset and downstream invalidation behavior

Server behavior:

- Explicit reset (`POST /reset`) computes selected gate plus transitive dependents, cancels active verifications for all affected gates, resets non-pending statuses to pending, broadcasts `gate_status_changed` for each affected gate, then broadcasts `gate_reset` with `affectedGateIds`, `changedGateIds`, and `unchangedGateIds`.
- Re-signaling a passed gate calls `cascadeReset()` for downstream dependents and broadcasts `gate_status_changed` for downstream gates before recording/broadcasting the new signal.
- `GateStore.resetGateAndDependents()` preserves signal history, content, metadata, and content version; it only clears current pass/fail state.

Client implications:

1. A reset must invalidate the selected gate and every affected downstream gate in page-local full lists (`GoalStatusWidget._gates`, dashboard `gates`) and in the shared summary cache.
2. If any affected gate had an active verification or awaiting-human step, reset cancellation must clear `verifying`, `verifyingCount`, and `awaitingSignoffCount` without waiting for an 8-second dashboard poll or session poll.
3. Because reset emits both `gate_status_changed` and `gate_reset`, clients should coalesce by `goalId` rather than fetch once per affected gate.
4. The explicit `gate_reset` event should be treated as authoritative invalidation even if a future server change reduces per-gate `gate_status_changed` chatter.

## Implementation recommendations

1. **Create one client-side gate summary refresh module.**
   - Move summary derivation out of `api.ts` into a small module, for example `src/app/gate-status-store.ts`.
   - Export `refreshGateStatusForGoal(goalId, options?)`, `refreshGateStatusCache()`, and a debounced `invalidateGateStatusForGoal(goalId, reason)`.
   - Keep the current `/api/goals/:id/gates?view=summary` endpoint as the authoritative summary fetch.

2. **Debounce and coalesce per goal.**
   - Maintain `pendingByGoal` and `inFlightByGoal` maps.
   - Coalesce all invalidating events within a short window, e.g. 50-150 ms.
   - If another invalidation arrives during an in-flight fetch, schedule one trailing fetch.
   - Never refresh summaries on `gate_verification_step_output`.

3. **Wire all shared-cache event handlers to the same invalidator.**
   - In `RemoteAgent.handleMessage()`: invalidate on `gate_signal_received`, `gate_status_changed`, `gate_reset`, `gate_verification_started`, `gate_verification_phase_started`, `gate_verification_step_started`, `gate_verification_step_complete`, `gate_verification_awaiting_human`, and `gate_verification_complete`.
   - Keep `dispatchVerificationEvent()` for live detail rendering, but do not make it the only side effect.

4. **Make dashboard stop partially owning shared summary writes.**
   - Replace `applyGateState()`'s direct `state.gateStatusCache.set(...)` with a call to the shared derivation helper or shared invalidator.
   - If dashboard needs immediate local rendering, update page-local `gates` first, then schedule shared summary refresh. Do not preserve stale sign-off counters from an old cache entry after events that can change them.

5. **Align widget pill and popover sources.**
   - Option A: widget remains local for popover details but calls the shared invalidator for every event where it refreshes `_gates` or `_awaitingSignoffs`.
   - Option B: widget consumes the shared gate summary directly for the pill and local `_gates` only for row-level details.
   - In both options, after successful `_resetGate()` and sign-off review submission, perform an immediate shared summary invalidation in addition to local refresh.

6. **Expose richer summary if needed.**
   - If deriving `verifyingCount` from slim `?view=summary` gates is fragile, extend the summary response with `verifying`, `verifyingCount`, and optionally `runningGateIds` computed server-side from `GateStore` plus `VerificationHarness.activeVerifications`.
   - This avoids every client reimplementing the same active-state merge.

7. **Add focused coverage after implementation.**
   - Unit coverage for the debounced invalidator/coalescer:
     - Given three invalidating events for the same goal within the debounce window (`gate_signal_received`, `gate_verification_started`, `gate_verification_step_started`), expect one summary fetch and one cache write.
     - Given one invalidation while a fetch is in flight, expect exactly one trailing fetch after the first completes.
     - Given `gate_verification_step_output`, expect no summary fetch.
     - Given invalidations for two different goals, expect independent per-goal fetches.
   - Browser E2E: running verification sync.
     - Start with a workflow goal showing `0/N` in sidebar badge, widget pill, widget popover, dashboard pipeline, and dashboard list.
     - Signal the first gate and wait for `gate_verification_started` / `gate_verification_step_started`.
     - Assert every count surface shows the same effective progress (`0/N` plus one running gate indicator, or the canonical running display chosen by the implementation) before completion.
     - Wait for completion and assert all surfaces show `1/N` and no running indicator.
   - Browser E2E: human sign-off resolution.
     - Signal a gate with one human sign-off step.
     - Assert sidebar/widget/dashboard agree on awaiting sign-off state: widget pulse visible, popover sign-off card visible, and shared count/cache state reflected in the badge/attention UI.
     - Approve the sign-off from the review pane.
     - Assert the widget pulse, popover sign-off card, shared `awaitingHumanSignoff`, and any dashboard live awaiting label clear after POST/`gate_verification_step_complete`, without requiring navigation or reload.
     - Repeat or parameterize rejection so failed sign-off clears awaiting state and surfaces agree on failed/pending counts.
   - Browser E2E: reset/downstream invalidation.
     - Start with at least two passed gates, e.g. `2/3`.
     - Reset the first gate from the widget or dashboard.
     - Assert sidebar badge, widget pill/popover, dashboard pipeline, and dashboard gate list all show the reset selected/downstream gates pending and the same lower passed count (for the example, `0/3`).
   - Browser E2E: reload persistence.
     - After each of running, awaiting-signoff, completed, and reset states, reload the page and assert the surfaces rehydrate from server truth and keep matching.

## Suggested target architecture

```text
server WS/REST events
        │
        ├─ RemoteAgent session WS ─────┐
        ├─ dashboard viewer WS ────────┼─ invalidateGateStatusForGoal(goalId, reason)
        └─ widget viewer WS ───────────┘
                                           │ debounce/coalesce per goal
                                           ▼
                           GET /api/goals/:id/gates?view=summary
                                           │
                                           ▼
                              state.gateStatusCache update
                                           │
             ┌─────────────────────────────┼─────────────────────────────┐
             ▼                             ▼                             ▼
      sidebar badge              goal widget pill badge          dashboard progress/counts

Dashboard `gates` and widget `_gates` may remain local detail caches, but they should no longer be independent authorities for summary counts.
```

## Bottom line

The stale-count bug is not a server truth problem; the server already broadcasts the relevant lifecycle events and exposes enough REST state. The client has multiple independent caches and event handlers. Fix by making per-goal gate summary invalidation a single debounced path and wiring every gate lifecycle event that can affect counts, active/running state, sign-off state, or reset/downstream state into that path.
