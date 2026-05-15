# Pause Cascade — Semantics & Implementation

This document describes Bobbit's pause subsystem: the three distinct
concepts it tracks, how they're implemented, and why each decision was
made.

## Background

The `goal.paused` flag was originally the sole mechanism for stopping
work on a goal. Over time it accreted two additional responsibilities:

1. Blocking children with unresolved `dependsOn` deps (scheduler block).
2. Terminating worker sessions (cascade abort).

Mixing these into one flag caused several bugs: operator pauses were
silently cleared by the scheduler; workers were terminated instead of
interrupted; the agent that triggered a pause could abort its own
streaming turn.

The v3 consolidation separates these three concepts using existing
primitives — no new boolean fields were added.

---

## Three concepts, three implementations

### 1. Operator pause — `goal.paused`

`goal.paused = true` means an operator (user or team-lead agent) has
explicitly paused the goal. It is:

- Set **only** by `executePauseForGoals` (called from `POST /pause` and
  the replan-overflow safety circuit).
- Cleared **only** by `POST /resume`.
- **Never read or written by the scheduler.**

This discipline means there is no "auto-resume" path that accidentally
clears an intentional operator pause. The invariant can be verified:

```
rg "paused.*true" src/server/agent/nested-goal-routes.ts
```

Every assignment must trace back to `applyOperatorPause`, which is only
called from `executePauseForGoals`.

### 2. Scheduler block — `goal.state === 'blocked'`

`goal.state = 'blocked'` means the scheduler is withholding this goal
because its `dependsOnPlanIds` reference sibling subgoals that have not
yet merged. It is:

- Set at spawn time when `unresolvedDeps.length > 0` (in
  `nested-goal-routes.ts`, `POST /spawn-child` branch).
- Cleared to `'todo'` by the `integrate-child` path when the last
  blocking sibling merges.
- **Never sets or reads `goal.paused`.**

Using `GoalState` rather than a separate boolean keeps the state machine
explicit and the scheduler ownership clear.

```
// GoalState in goal-store.ts
export type GoalState = "todo" | "in-progress" | "complete" | "shelved" | "blocked";
```

### 3. Worker dormancy — `abortSessionTurn`

When a cascade-pause fires, streaming sessions in the paused subtree
must stop. The previous implementation called `forceAbort`, which
terminated the session entirely (kill + restart fallback). The
replacement is `sessionManager.abortSessionTurn(id)`:

- Broadcasts `aborting` status.
- Calls `rpcClient.abort()` to cancel the current LLM turn.
- **Does not kill or restart the process.** The session record stays
  registered.

This matters for resume: because the session is still registered, the
team-lead can re-prompt workers without having to respawn them from
scratch. The supervisor (`_bootRespawnSessionlessGoals`) already
respects `goal.paused` and will not auto-respawn sessions for paused
goals.

---

## `executePauseForGoals` — single entry point

All pause operations route through one function:

```ts
async function executePauseForGoals(
    targets: PersistedGoal[],
    callerSessionId: string | undefined,
): Promise<number>
```

**What it does:**

1. For each target goal, calls `applyOperatorPause` (sets `paused: true`,
   cancels in-flight verifications, broadcasts `goal_state_changed`).
   Already-paused goals are skipped.
2. Iterates `sessionManager.getAllSessionsRaw()` and calls
   `abortSessionTurn` on every streaming session whose `goalId` is in
   the target set — **excluding the caller's own session** (see below).

`applyOperatorPause` is a package-private helper. No code outside
`executePauseForGoals` calls it. This makes `executePauseForGoals` the
true single write-site for `goal.paused = true`.

### Callers

| Path | How `callerSessionId` is read |
|---|---|
| `POST /api/goals/:id/pause` | `x-bobbit-spawning-session` → `x-bobbit-session-id` request headers |
| Replan-overflow safety circuit (`goal_decide_mutation`) | Same header chain, read from the mutation-decision request |

---

## Caller session exclusion

When a team-lead agent calls `goal_pause`, the MCP tool makes an HTTP
request that carries the agent's session ID in the
`x-bobbit-spawning-session` or `x-bobbit-session-id` header. Without
exclusion, the cascade-abort loop would call `abortSessionTurn` on the
very session executing the pause — killing the turn mid-flight.

The guard is one line inside `executePauseForGoals`:

```ts
if (s.id === callerSessionId) continue; // don't self-abort
```

When `callerSessionId` is `undefined` (e.g. a raw cURL call with no
header), the condition never matches and all streaming sessions in the
subtree are interrupted as intended.

---

## Cascade scope

The cascade walk is performed by `cascadeSubtree` from
`src/server/agent/goal-subtree.ts`, which uses a BFS over the
`parentGoalId` chain. The pause cascade uses top-down order so the
parent's supervisor is paused before its children (preventing respawn
racing). The loop has only one skip condition — already-paused goals are
no-ops — so `'todo'`, `'in-progress'`, `'blocked'`, and `'complete'`
descendants are all covered. See
[docs/design/hierarchical-cascade.md](hierarchical-cascade.md) for the
full walk semantics and walk-order rationale.

---

## Targeted child pause — `childGoalId`

`POST /api/goals/:id/pause` and `POST /api/goals/:id/resume` accept an
optional `childGoalId` parameter. When set, the operation targets that
specific direct child instead of the caller's own goal:

```json
{ "cascade": true, "childGoalId": "child-goal-id" }
```

Constraints:
- `childGoalId` must be a direct child (`parentGoalId === id`);
  non-direct-child returns `403 NOT_DIRECT_CHILD`.
- Archived children return `404`.
- `cascade: true` still descends from the targeted child into its own
  subtree.

The `goal_pause` and `goal_resume` MCP tools expose this parameter so
team-lead agents can target individual children without dropping to raw
REST calls.

---

## Replan-overflow auto-pause

When a goal accumulates more than five post-freeze replans (`replanCount > 5`),
the mutation-decision handler automatically pauses it. This uses
`executePauseForGoals` with `[goalRecord]` (no cascade) and the same
caller-session exclusion as the REST handler, so the triggering agent's
turn is not interrupted.

The auto-pause is sticky — only `POST /resume` clears it — matching the
same semantics as a manual operator pause. This is intentional: the
overflow is a signal that human review is required.

---

## Boot migration

Legacy goal records written before the `'blocked'` state was introduced
may have `paused: true` alongside unresolved `dependsOnPlanIds`. On
boot, `GoalManager` performs a lazy migration:

- `paused: true` + unresolved deps → `state: 'blocked'`, `paused: false`
  (scheduler block, correctly typed).
- `paused: true` + resolved or no deps → no change (operator-paused,
  preserved).

---

## `abortSessionTurn` vs `forceAbort`

| | `abortSessionTurn` | `forceAbort` |
|---|---|---|
| Cancels current LLM turn | Yes | Yes |
| Kills/restarts agent process | No | Yes (after grace period) |
| Session stays registered | Yes | No (archived on completion) |
| Used by | Pause cascade | Manual session abort, error recovery |

Use `abortSessionTurn` when you want to pause work but keep the session
alive for later. Use `forceAbort` when the session must be terminated
(e.g. the user explicitly deletes it, or the bridge has crashed).

---

## Pause/Resume button

The UI Pause button reads `goal.paused` for its label and state. When
the goal itself is not paused but has descendants that are paused or
`'blocked'`, a "N waiting" badge is shown next to the button to make
the cascade vs targeted-pause distinction visible.

---

## Reference

| Symbol | File |
|---|---|
| `GoalState` | `src/server/agent/goal-store.ts` |
| `executePauseForGoals` | `src/server/agent/nested-goal-routes.ts` |
| `applyOperatorPause` | `src/server/agent/nested-goal-routes.ts` |
| `abortSessionTurn` | `src/server/agent/session-manager.ts` |
| `forceAbort` | `src/server/agent/session-manager.ts` |
| `getAllSessionsRaw` | `src/server/agent/session-manager.ts` |
| `walkGoalSubtree` / `cascadeSubtree` | `src/server/agent/goal-subtree.ts` |
| Boot migration | `src/server/agent/goal-manager.ts` |
| Pause/resume unit tests | `tests/pause-blocked-state.test.ts` |
