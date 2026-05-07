# Goal-spec edit notification flow

When the user edits a goal's `spec` mid-flight (typically through the
dashboard's spec tab), the team-lead must be told so it can re-read the
spec and adjust its plan. The mid-session plumbing has three layers.

## Server: `PUT /api/goals/:id`

In `src/server/server.ts`, the goal-update handler captures `prevSpec` before
calling `goalManager.updateGoal(...)` and — when `typeof body.spec === "string"
&& body.spec !== prevSpec` — does two things:

1. Broadcasts a typed `goal_spec_changed` WebSocket event:
   ```
   { type: "goal_spec_changed",
     goalId,
     prevSpecHash,  // first 16 hex chars of sha256(prevSpec)
     newSpecHash,
     prevLen,
     newLen,
     ts }
   ```
   The full body is intentionally **not** included in the frame — clients
   refetch on demand.
2. Calls `teamManager.notifyTeamLeadOfSpecChange(goalId, prevLen, newLen)`.

Both no-op when `body.spec` is absent or identical to the previous value
— mirrors the `goal-store.update()` no-op skip (R-007 review finding).

Worker / reviewer / QA sessions are intentionally **not** notified — they
read task specs, not goal specs.

## TeamManager: throttled nudge

`notifyTeamLeadOfSpecChange` in `src/server/agent/team-manager.ts` is throttled
to one nudge per `SPEC_NUDGE_THROTTLE_MS = 30_000` via a `Map<goalId, ts>`
named `lastSpecNudgeTs`. The dispatch shape is the same as
`notifyTeamLeadOfTaskCompletion`:

- streaming → `deliverLiveSteer`
- idle → `enqueuePrompt({ isSteered: true })`

The message body explicitly references the `view_goal_spec` tool by name
so the agent has a canonical re-read path. The spec injected into the
system prompt at session startup is **not** refreshed by the WS event —
`view_goal_spec` is the only fresh-read surface.

## UI: header pill

`src/app/goal-dashboard.ts::notifyGoalSpecEditedForDashboard(goalId, ts)`
records the event in a `recentSpecEdits` map for `SPEC_PILL_WINDOW_MS =
60_000` and renders a `data-testid="spec-edited-pill"` in the dashboard
header. Click → spec tab.

`remote-agent.ts` routes the `goal_spec_changed` frame to this dashboard
hook in its `case "goal_spec_changed"` branch.

## Diagnostic chain

Symptom: agent unaware of mid-flight spec changes.

1. Was a `goal_spec_changed` WS frame emitted? Check the `broadcastToAll`
   call in the `PUT /api/goals/:id` handler. The event is gated on
   `typeof body.spec === "string" && body.spec !== prevSpec`.
2. Did `teamManager.notifyTeamLeadOfSpecChange` fire? Look for
   `[team-manager] Notified team lead of spec change` in the log; missing
   means either no team-lead session, terminated session, or the throttle
   window suppressed the call (look for `[team-manager] Skipping
   spec-edit nudge for goal <id> (throttled, last <ms>ms ago)`).
3. Did the agent receive the queued prompt? `enqueuePrompt(..., {
   isSteered: true })` paths through the existing prompt queue — same
   dispatch shape as auto-nudges.
4. UI pill missing? Check `case "goal_spec_changed"` in
   `src/app/remote-agent.ts` and `notifyGoalSpecEditedForDashboard` in
   `src/app/goal-dashboard.ts`; pill auto-clears after
   `SPEC_PILL_WINDOW_MS = 60_000`.

## Tests

- `tests/team-manager-spec-nudge.test.ts` — 6 cases for the throttle
  + dispatch fan-out.
- `tests/e2e/api-goals-spec-edit-broadcast.spec.ts` — positive +
  barrier-tested no-ops.

## Pattern for future tools

Any new tool that mutates goal state out-of-band of the team-lead's
awareness should follow the same nudge pattern: capture pre-mutation
state, run the mutation, broadcast a typed WS event, call a throttled
notify-team-lead helper, expose a UI pill with a finite TTL window.
