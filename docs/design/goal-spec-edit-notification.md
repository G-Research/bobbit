# Goal-spec edit notification

When a user (or another agent) edits a goal's `spec` mid-flight via `PUT /api/goals/:id`, the team-lead session that's currently driving the goal must learn about the edit — otherwise it keeps executing against the stale spec it received in its system prompt at startup.

This doc covers the full notification pipeline: the WS broadcast, the steered prompt to the team-lead, the throttling rule, the UI pill, and the canonical re-read tool. It is the long-form companion to the one-line entries in `AGENTS.md` and the diagnostic in `docs/debugging.md`.

## Why a notification at all

The goal `spec` is injected into the team-lead's system prompt exactly **once**, at session startup. A mid-flight edit changes the on-disk record but the running agent process never re-reads it. Without a nudge:

- The team-lead acts on stale acceptance criteria.
- Reviewers verify against criteria the user has already revised.
- The user's edit silently has zero effect until the next time the agent boots.

The notification flow ensures the team-lead receives both an explicit nudge ("the spec changed — re-read it") **and** a canonical re-read tool (`view_goal_spec`) so the live system prompt is no longer the source of truth.

## Pipeline

### 1. REST handler

`PUT /api/goals/:id` in `src/server/server.ts`:

1. Captures `prevSpec` before delegating to `goalManager.updateGoal(...)`.
2. After the update, when `typeof body.spec === "string" && body.spec !== prevSpec`:
   - Broadcasts a typed `goal_spec_changed` WebSocket event to all clients.
   - Calls `teamManager.notifyTeamLeadOfSpecChange(goalId, prevLen, newLen)`.

The handler is a **no-op** when `body.spec` is absent or identical to the previous value. This mirrors `goal-store.update()`'s existing R-007 behaviour (no-op identical updates) and avoids spurious nudges from PATCH-style edits that don't touch the spec.

### 2. WS broadcast — `goal_spec_changed`

Payload shape:

```ts
{
  type: "goal_spec_changed",
  goalId: string,
  prevSpecHash: string,   // 16-char sha256 hex prefix
  newSpecHash: string,    // 16-char sha256 hex prefix
  prevLen: number,
  newLen: number,
  ts: number,
}
```

The full body is **deliberately not included** — the client re-fetches via the existing goal-detail endpoint if it needs the new text. Two reasons:

- Goal specs can be large; re-broadcasting the full body to every connected client wastes bandwidth.
- Diff visualisation lives in the dashboard, not in WS event consumers.

### 3. Team-lead steer — `notifyTeamLeadOfSpecChange`

Defined in `TeamManager`. Resolves the active team-lead session for the goal and dispatches a steered prompt referencing the `view_goal_spec` tool by name. Dispatch shape mirrors `notifyTeamLeadOfTaskCompletion`:

- **Streaming team-lead** → `deliverLiveSteer(...)` (interrupts mid-turn).
- **Idle team-lead** → `enqueuePrompt(..., { isSteered: true })` (queued for next dispatch).

Worker / reviewer / QA sessions are **intentionally not notified**. They read task specs, not goal specs — task specs are a separate object and have their own update path.

### 4. Throttle

A per-goal `lastSpecNudgeTs: Map<goalId, number>` enforces a minimum gap between consecutive nudges (`SPEC_NUDGE_THROTTLE_MS`, on the order of tens of seconds). Rationale: a user iterating on the spec via repeated PUTs should not generate one steer per character. The throttle skip path emits a `[team-manager] Skipping spec-edit nudge for goal <id> (throttled, last <ms>ms ago)` log line so the suppression is observable.

### 5. Dashboard pill — `spec-edited-pill`

`src/app/goal-dashboard.ts::notifyGoalSpecEditedForDashboard(goalId, ts)` records each `goal_spec_changed` event in `recentSpecEdits` for `SPEC_PILL_WINDOW_MS` (about a minute). The dashboard header renders a pill with `data-testid="spec-edited-pill"` that links to the spec tab. The pill auto-clears after the window elapses.

### 6. Canonical re-read tool — `view_goal_spec`

`defaults/tools/proposals/view_goal_spec.yaml`. The agent's recovery path: when it receives the steered notification, it calls `view_goal_spec` to fetch the current `goal.spec` from the gateway. The system prompt is **not** refreshed — the tool result becomes the new source of truth for the rest of the turn.

## Diagnostic chain — when an edit is silently dropped

If a user edits the spec but the team-lead behaves as if nothing changed, walk the chain top-down:

1. **Was the WS event emitted?** Check the `broadcastToAll` call in the `PUT /api/goals/:id` handler (`src/server/server.ts`). Gated on `typeof body.spec === "string" && body.spec !== prevSpec`. Identical text → no event by design.
2. **Did `notifyTeamLeadOfSpecChange` fire?** Look for `[team-manager] Notified team lead of spec change` in the gateway log. Missing means either no live team-lead session, the session was terminated, or the throttle window suppressed the call (look for the `Skipping spec-edit nudge … throttled` line).
3. **Did the agent receive the queued prompt?** `enqueuePrompt(..., { isSteered: true })` paths through the existing prompt queue — same dispatch shape as auto-nudges. Inspect the session's `promptQueue` snapshot in the WS state.
4. **Is the UI pill missing?** Check the `case "goal_spec_changed"` branch in `src/app/remote-agent.ts` and `notifyGoalSpecEditedForDashboard` in `src/app/goal-dashboard.ts`.

## When to mirror this pattern

If you add a new tool that mutates goal state out-of-band of the team-lead's awareness — anything where the agent's in-memory view of the world goes stale — follow the same pattern:

1. Broadcast a typed WS event with hash-prefixes, not full bodies.
2. Call a `TeamManager.notifyTeamLeadOf<Thing>` helper that dispatches via `deliverLiveSteer` / `enqueuePrompt({ isSteered: true })`.
3. Add a per-goal throttle map keyed on the relevant scope.
4. Reference a canonical re-read tool by name in the steer body so the agent has a recovery path.

## Tests

- `tests/team-manager-spec-nudge.test.ts` — unit-tests the throttle, dispatch shape, no-op skip, and worker-session-non-notification rules.
- `tests/e2e/api-goals-spec-edit-broadcast.spec.ts` — end-to-end WS broadcast on real goal edits, plus barrier-tested no-op cases.
