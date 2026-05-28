# Gate status synchronization

Gate progress appears in several client surfaces at once: sidebar goal rows, the chat-header goal status widget, and the goal dashboard. These surfaces need to agree while verification is running, after human sign-off decisions, and after reset cascades. Bobbit keeps that agreement by treating the per-goal gate summary cache as the shared count source and invalidating it from every event that can change count or active-state fields.

## Shared summary cache

The shared client cache is `state.gateStatusCache`, keyed by goal id. Each entry stores:

- `passed` and `total`
- `verifying` and `verifyingCount`
- `awaitingSignoffCount`
- `awaitingHumanSignoff`

`refreshGateStatusForGoal(goalId)` performs an immediate refresh for one goal. `invalidateGateStatusForGoal(goalId, reason)` is the live-event path: it debounces per goal, coalesces duplicate invalidations while a fetch is in flight, and schedules a trailing refresh if another invalidation arrives before the current fetch finishes.

The refresh fetches `GET /api/goals/:id/gates?view=summary`, derives the cache entry, and writes only when the value changed. A changed write:

1. updates `state.gateStatusCache`,
2. dispatches `bobbit-gate-status-cache-updated` with the affected goal ids, and
3. renders the app unless the caller batched rendering.

This keeps bursts of verification events from causing broad polling or redundant REST calls while still converging on server truth quickly.

## Event invalidation contract

These WebSocket events are count-changing or active-state-changing and must invalidate the shared summary for their `goalId`:

- `gate_signal_received`
- `gate_status_changed`
- `gate_reset`
- `gate_verification_started`
- `gate_verification_phase_started`
- `gate_verification_step_started`
- `gate_verification_awaiting_human`
- `gate_verification_step_complete`
- `gate_verification_complete`

`gate_verification_step_output` is detail-only. It streams stdout/stderr or other step output to live verification renderers and output modals, but it does not change gate pass counts, running counts, or sign-off counts, so it must not refetch the summary cache.

Human sign-off resolution has two paths to truth:

- the review-pane submitter performs an immediate `refreshGateStatusForGoal()` after a successful `/signoff` POST;
- the follow-up verification events, especially `gate_verification_step_complete` and `gate_verification_complete`, also invalidate the summary through the shared debounced path.

The immediate refresh makes the UI clear pending sign-off state promptly; the WebSocket refresh keeps all other open surfaces consistent with server truth.

## Surface ownership

### Sidebar

Sidebar goal rows do not fetch gate detail themselves. They render `renderGateProgressBadge(goalId)`, which reads `state.gateStatusCache`. The sidebar therefore updates whenever the shared cache changes and the app re-renders.

### Goal status widget

The widget has two data sources with different purposes:

- the pill and popover progress badge use `renderGateProgressBadge(goalId)`, so their count comes from `state.gateStatusCache`, matching the sidebar;
- the popover gate rows and sign-off cards use widget-local `/gates` and `/verifications/active` fetches because they need row-level detail and substituted human-signoff prompts.

The widget refreshes local detail on relevant viewer WebSocket events and also refreshes the shared summary. It listens for `bobbit-gate-status-cache-updated` and re-renders when its `goalId` is included, so cache changes caused by the session socket, dashboard socket, or review pane update the widget pill even if the widget did not initiate the refresh.

### Goal dashboard

The dashboard keeps its own full gate list and live verification map for pipeline rows, expanded signal detail, and live step output. It no longer writes partial entries into `state.gateStatusCache` from the full `/gates` response. Instead, dashboard gate changes schedule the same shared summary invalidator used by the sidebar and widget.

The dashboard viewer WebSocket refreshes full gate detail on `gate_signal_received`, `gate_status_changed`, and `gate_reset`. Verification lifecycle events still go through the verification event bus for live detail rendering, and the count-changing subset also invalidates the shared summary.

## Reset and downstream invalidation

A gate reset can affect the selected gate and every downstream dependent gate. The server broadcasts per-gate status changes and a `gate_reset` envelope with affected ids. Clients treat `gate_reset` as an authoritative summary invalidation even though companion `gate_status_changed` events may also arrive.

On reset:

- the dashboard refetches full gate detail for the current goal;
- the widget refetches local gate rows and active verification/sign-off state;
- the shared summary is invalidated once per goal and coalesced with companion events;
- selected and downstream passed counts, running state, and awaiting-signoff state clear without requiring navigation or reload.

## Reload and reconnect behavior

Initial load and goal-list generation changes call the all-goal summary refresh for workflow goals. Dashboard viewer WebSocket authentication also schedules a current-goal summary refresh. These paths rehydrate from server truth after reload or reconnect instead of relying on stale client cache entries.

## Regression coverage

Pinning coverage lives in both unit/API-style tests and browser E2E:

- `tests/gate-status-cache-invalidation.test.ts` checks that session WebSocket handling invalidates the shared cache for every count-changing gate event, excludes `gate_verification_step_output`, exposes the debounced per-goal invalidator, and prevents the dashboard from writing partial shared-cache entries.
- `tests/e2e/ui/goal-status-widget.spec.ts` covers cross-surface reset synchronization: sidebar badge, widget pill/popover, dashboard counts, dashboard gate rows, widget rows, and reload truth all converge after downstream reset invalidation.

See `docs/design/gate-count-sync-issue-analysis.md` for the pre-fix issue analysis and stale-cache reproduction scenarios that motivated this architecture.
