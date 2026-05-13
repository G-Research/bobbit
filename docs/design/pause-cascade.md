# Design — Pause Cascade Actually Stops Sessions

Goal: `goal-pause-casc-fd47896d`. Branch: `goal/pause-casc-fd47896d`.

## Background

Today `POST /api/goals/:id/pause {"cascade":true}` only sets `paused:true`
on the descendant goal records and (best-effort) cancels in-flight gate
verifications. It does NOT:

1. Interrupt streaming agent sessions whose `goalId` is in the paused
   subtree. Team-leads, coders, reviewers and `llm-review-*` verifier
   sessions keep talking to the LLM.
2. Block subsequent spawn-path calls. `team_spawn`, `goal_spawn_child`
   and `gate_signal` happily create new sessions on paused goals.
3. Block the boot-time / event-resubscribe respawn supervisor — so even
   when an operator aborts a session manually, the team-manager
   immediately respawns a fresh team-lead. This is the whack-a-mole that
   makes the bug user-visible.

This design wires those three holes shut with a single helper plus
narrow guards at each spawn site, and a one-pass abort sweep in the
`/pause` handler.

## Files to change

| File | Lines | Why |
| --- | --- | --- |
| `src/server/agent/nested-goal-routes.ts` | 685–710 (`/pause` branch) | Add session-abort sweep after the existing `cancelAllVerifications` call. |
| `src/server/agent/nested-goal-routes.ts` | 207–405 (`/spawn-child` branch) | Add `requireGoalNotPaused(parentId)` guard. |
| `src/server/agent/nested-goal-routes.ts` | top-level helpers area (~120) | Define `requireGoalNotPaused(goalId)` once, export, reuse. |
| `src/server/server.ts` | 5377–5410 (`/team/spawn`) | Guard before `teamManager.spawnRole(...)`. |
| `src/server/server.ts` | 4947–5160 (`/gates/:id/signal`) | Guard before signal accept (kills verifier-spawn implicitly). |
| `src/server/agent/team-manager.ts` | 1222 (`_startTeamImpl`) | Guard before `sessionManager.createSession(...)`. |
| `src/server/agent/team-manager.ts` | 910 (`_bootRespawnSessionlessGoals`) | Skip paused goals in the boot-respawn loop. **CRITICAL — fixes whack-a-mole.** |
| `src/server/agent/team-manager.ts` | 1404 (`spawnRole`) | Defense-in-depth guard (called from `/team/spawn` and from extension tools). |
| `src/server/agent/verification-harness.ts` | 1880–1920 (`runLlmReviewViaSession` pre-spawn) | Guard before creating an `llm-review-*` session. |

No changes required in `/resume` — clearing the flag is already the
inverse and the goal spec explicitly forbids auto-restart on resume.

## Anatomy of the existing primitives

**SessionManager exposure** (`src/server/agent/session-manager.ts:469`).
Sessions live in `private sessions = new Map<string, SessionInfo>()`.
There is no public `getAllSessions()` today, but `listSessions()`
(line 3900) returns the slim DTO array including `goalId`. The walk
needs full `SessionInfo` to drive abort, so we add a thin accessor
returning `Array.from(this.sessions.values())` — call it
`getAllSessionsRaw()` (internal-only; new export from session-manager).
Alternative: iterate `listSessions()` and look up by id; cheaper to add
the accessor.

**Canonical abort primitive** (`src/server/server.ts:8047`,
`/api/sessions/:id/abort`). The handler calls
`sessionManager.forceAbort(id)` (`session-manager.ts:5166`), which:

1. Broadcasts `aborting` status.
2. Registers an `agent_end` listener before `rpcClient.abort()` (the
   listener-ordering invariant pinned in the source comment).
3. Falls back to `rpcClient.stop()` + bridge restart on timeout.

`deliverLiveSteer("stop")` is NOT the abort primitive — it just enqueues
a steer message. Use `forceAbort`.

**`cancelAllVerifications`** (`nested-goal-routes.ts:127`, calling
`verification-harness.ts:1132`). This already calls
`sessionManager.terminateSession(step.sessionId)` for every running
reviewer step whose `step.sessionId` is set (lines 1138–1145). Those
sessions ARE the `llm-review-*` ones (created at
`verification-harness.ts:1924`). So in principle B is already covered…
**provided** the verification record exists.

Gap: a server restart or stale-record race can leave an `llm-review-*`
session running while its `activeVerifications` entry has been GC'd.
The session-abort sweep in A catches these because it walks
`sessionManager` rather than `activeVerifications`. So B is fixed
implicitly by A — we just need to confirm and document.

## New helper

Defined once in `nested-goal-routes.ts` (alongside `listDescendantsLocal`)
and re-exported for `team-manager.ts` / `verification-harness.ts` /
`server.ts`:

```ts
// src/server/agent/goal-paused-guard.ts (new module — keeps team-manager
// free of REST-shaped error shapes; server.ts converts to 409 itself)
export class GoalPausedError extends Error {
    readonly code = "GOAL_PAUSED";
    readonly status = 409;
    constructor(public readonly goalId: string) {
        super(`Goal ${goalId} is paused — spawn rejected`);
    }
}

export function requireGoalNotPaused(
    goalId: string,
    lookup: (id: string) => { paused?: boolean } | undefined,
): void {
    const g = lookup(goalId);
    if (g?.paused) throw new GoalPausedError(goalId);
}
```

Each REST handler catches `GoalPausedError` and returns
`{ code: "GOAL_PAUSED", goalId }` with status 409 — mirroring the existing
`GateDependencyError` convention in `/team/spawn` (`server.ts:5405`).

## Call-site changes

### 1. `/pause` handler — abort streaming sessions in subtree

`src/server/agent/nested-goal-routes.ts:687–710`

```ts
const targets: PersistedGoal[] = [goal, ...(cascade ? listDescendantsLocal(id) : [])];
const pausedIds = new Set<string>();
let count = 0;
for (const g of targets) {
    if (g.paused) continue;
    await goalManager.updateGoal(g.id, { paused: true });
    await cancelAllVerifications(g.id);   // existing — also kills llm-review-* sessions
    broadcastToAll({ type: "goal_state_changed", goalId: g.id });
    pausedIds.add(g.id);
    count++;
}

// NEW: best-effort abort of every streaming session in the subtree.
// One bad session must not block the rest — collect errors, log, continue.
for (const s of sessionManager.getAllSessionsRaw()) {
    if (!s.goalId || !pausedIds.has(s.goalId)) continue;
    if (s.status !== "streaming") continue;
    sessionManager.forceAbort(s.id).catch((err) => {
        console.warn(`[pause] forceAbort failed for session=${s.id} goal=${s.goalId}:`, err);
    });
}

json({ paused: count });
```

Requires adding `getAllSessionsRaw(): SessionInfo[]` to SessionManager
(internal accessor — does NOT leak `SessionInfo` to REST clients,
only callers inside `src/server/agent/`).

### 2. `/team/spawn` — guard before `spawnRole`

`src/server/server.ts:5377` (after the existing archived/setupStatus
guards, before the `await readBody`):

```ts
if (spawnGoal?.paused) {
    json({ error: `Goal ${goalId} is paused`, code: "GOAL_PAUSED", goalId }, 409);
    return;
}
```

### 3. `/spawn-child` — guard before child creation

`src/server/agent/nested-goal-routes.ts:213` (right after the
`parent` null-check):

```ts
if (parent.paused) {
    json({ error: `Parent goal ${parentId} is paused`, code: "GOAL_PAUSED", goalId: parentId }, 409);
    return true;
}
```

Idempotency note: the `existing` lookup at line 258 runs AFTER this
guard, which is fine — if the child already exists, the operator hasn't
re-paused since spawn and the guard short-circuits before the existence
check. For strict idempotency (return existing even when paused), move
the existence check above the guard. **Recommend: guard first.**
The whole point of pause is to refuse new work, and a re-call with the
same planId on a paused goal still represents a spawn intent the
operator wants blocked.

### 4. `/gates/:id/signal` — block verifier spawn

`src/server/server.ts:4953` (right after the archived check):

```ts
if (goal.paused) {
    json({ error: `Goal ${goalId} is paused`, code: "GOAL_PAUSED", goalId }, 409);
    return;
}
```

This is the most upstream point — rejecting the signal blocks both the
`llm-review-*` reviewer spawn (`verification-harness.ts:1924`) and the
command/agent-qa step kickoff in the same handler chain.

### 5. `TeamManager._startTeamImpl` — guard team-lead spawn

`src/server/agent/team-manager.ts:1222` (top of method, after the
`this.teams.has(goalId)` check at line 1230):

```ts
if (goal.paused) throw new GoalPausedError(goalId);
```

### 6. `TeamManager.spawnRole` — defense-in-depth

`src/server/agent/team-manager.ts:1404` (after `goalForRole` resolved
at line 1414):

```ts
if (goalForRole?.paused) throw new GoalPausedError(goalId);
```

`/team/spawn` (call site 2) already guards. This extra check covers
in-process callers (team-lead extension calling `team_spawn` MCP tool
bypasses REST and goes straight through TeamManager).

### 7. **CRITICAL** — boot-respawn supervisor

`src/server/agent/team-manager.ts:910`
(`_bootRespawnSessionlessGoals`). Add `paused` to the skip-list:

```ts
for (const goal of ctx.goalStore.getAll()) {
    if (goal.archived) continue;
    if (goal.paused) continue;            // NEW — prevents whack-a-mole
    if (goal.state !== "in-progress") continue;
    if (goal.setupStatus !== "ready") continue;
    if (!goal.team) continue;
    if (this.teams.has(goal.id)) continue;
    // ... existing startTeam(goal.id) call
}
```

This single change is the highest-impact fix in the goal spec — it stops
the respawn loop that re-creates a team-lead within seconds of every
manual abort.

### 8. `runLlmReviewViaSession` — backstop for verifier spawn

`src/server/agent/verification-harness.ts:1898` (top of
`runLlmReviewViaSession`, before `createSession`):

```ts
const g = this.projectContextManager?.getContextForGoal(goalId)?.goalStore.get(goalId);
if (g?.paused) {
    return { passed: false, output: `Aborted: goal ${goalId} is paused`, sessionId: undefined };
}
```

The mainline path is already blocked by call site 4; this prevents a
race where the verifier kicks off between signal-accept and the pause
flag being set on a deeper descendant.

## Resume handler

`src/server/agent/nested-goal-routes.ts:711–736`. Current behaviour:
walks the same descendant set, clears `paused:false`, broadcasts
`goal_state_changed`. **No changes needed** per goal-spec section D.
The team-lead is NOT auto-restarted on resume — the operator restarts
it manually via `team/start` or via the UI button. The boot-respawn
loop now correctly handles resumed goals: once `paused` clears, the
next `resubscribeTeamEvents` (e.g. on server restart) will respawn
sessionless in-progress goals as before.

Cross-cutting note: the dependsOn-on-completion path (owned by Bug 1)
that auto-unpauses dep-blocked children needs to live in that fix; if
it lands first, the resume code here may need a hook for "did this
unpause trigger a restart?" — out of scope for this design.

## Tests

All three are integration tests under `tests/e2e/`. Reuse the
in-process gateway harness (`./in-process-harness.js`).

### `tests/e2e/pause-cascade-aborts-sessions.spec.ts`

Maps to acceptance criterion 1 + 2.

1. `createGoalTree` helper: root R with team mode, child C1 (team
   mode), child C2 (team mode). Start teams for all three. Wait for
   each team-lead to reach `streaming` status (use a stub LLM that
   loops on `sleep` tool, or just check `status === "streaming" |
   "idle"` after `createSession` resolves — depending on harness).
2. `POST /api/goals/{R}/pause { cascade: true }` → expect 200, paused
   count == 3.
3. Poll `GET /api/sessions` every 250ms for up to 10s — assert that
   every session with `goalId ∈ {R, C1, C2}` has `status !== "streaming"`.
4. Wait an additional 30s (or shorter in CI via fake timers / harness
   tick) — assert no new sessions appear in the subtree.
5. `POST /api/goals/{C1}/team/spawn { role: "coder", task: "x" }` →
   expect 409, body `{ code: "GOAL_PAUSED", goalId: C1 }`.
6. `POST /api/goals/{C1}/spawn-child { planId, title, spec }` → expect
   409, same payload.
7. `POST /api/goals/{C1}/gates/{anyGate}/signal { ... }` → expect 409,
   same payload.
8. `POST /api/goals/{R}/resume { cascade: true }` → expect 200,
   resumed == 3. `POST /team/spawn` again succeeds (201).

### `tests/e2e/pause-cancels-verifiers.spec.ts`

Maps to acceptance criterion 4.

1. Create a goal with a workflow that has at least one `llm-review`
   gate step.
2. Signal that gate. Wait until `getActiveVerifications(goalId)` shows
   the step with `status: "running"` and a non-empty
   `step.sessionId` matching `/^llm-review-/`.
3. While verifier streams, pause the goal (no cascade required —
   single goal).
4. Within 5s assert the `llm-review-*` session transitions out of
   `streaming` (either `forceAbort` via the sweep in call site 1, or
   `cancelAllVerifications` via the existing path — either is fine).
5. Assert no replacement reviewer session appears in the next 10s.

### `tests/e2e/pause-blocks-supervisor-respawn.spec.ts`

Maps to acceptance criterion 2 — the highest-blast-radius assertion.

1. Start a team for goal G.
2. Pause cascade.
3. `DELETE /api/sessions/{teamLeadId}` (force-kill the team-lead
   externally — simulates crash).
4. Trigger a `resubscribeTeamEvents` boot pass (the harness must
   expose this — either via a test-only endpoint, or by directly
   calling `teamManager.resubscribeTeamEvents()` from the in-process
   harness reference).
5. Wait 15s. Assert no new team-lead created (poll
   `GET /api/goals/{G}/team`).
6. Resume cascade. `POST /api/goals/{G}/team/start` — assert team-lead
   re-created.

If the harness can't easily trigger `resubscribeTeamEvents`, fold this
test into a real server restart via the e2e gateway-harness pattern —
the boot path runs naturally.

## Acceptance criteria mapping

| Criterion (from goal spec) | Covered by |
| --- | --- |
| 1. Subtree sessions idle within 5s of pause | Call site 1 + test `pause-cascade-aborts-sessions` step 3 |
| 2. No new subtree sessions for 60s after pause | Call site 7 (supervisor) + tests `pause-cascade-aborts-sessions` step 4 and `pause-blocks-supervisor-respawn` |
| 3. `team_spawn` / `spawn-child` / `gate_signal` return 409 | Call sites 2, 3, 4 + test `pause-cascade-aborts-sessions` steps 5–7 |
| 4. `llm-review-*` cancelled with the rest | Existing `cancelAllVerifications` (verification-harness.ts:1132) + Call site 1 backstop + Call site 8 + test `pause-cancels-verifiers` |
| 5. Resume clears flag, no auto-start | No code change (current behaviour) + test `pause-cascade-aborts-sessions` step 8 |
| 6. Three integration tests pass | All three test files above |
| 7. `npm run check` clean, `npm run test:unit` green | Standard pre-commit gate |

## Risks / open questions

- **`getAllSessionsRaw` exposure.** Adding a method that returns
  `SessionInfo[]` widens the SessionManager surface. The alternative is
  to iterate `listSessions()` (DTO) and look up by id for the abort
  call — slower but no API drift. Recommend the accessor with an
  `@internal` JSDoc tag; pinning test in `tests/session-manager.spec.ts`.
- **Idempotency vs. guard ordering in `/spawn-child`.** Choosing
  "guard first" means a duplicate `spawn-child` request on a paused
  goal returns 409 instead of the existing child's id. That is the
  correct semantic — pause means "no new spawn intent" — but reviewers
  should confirm.
- **Resume + dependsOn interaction.** If Bug 1's fix lands after this,
  the resume handler may need to call into the dependency engine to
  re-evaluate which children should unpause. Out of scope here; flagged
  in the resume section.
- **Race: descendant added mid-pause.** A new `spawn-child` racing the
  pause sweep could create a session against a not-yet-paused
  descendant. Mitigated by call site 3 reading `parent.paused` at
  spawn time — if the parent flipped to paused after `listDescendants`
  but before spawn, the guard catches it. The pathological case (root
  paused, descendant spawn races the BFS) is bounded because the
  parent guard chain transitively blocks it.
- **`forceAbort` cost.** Each call may do a 3s graceful wait then a
  process kill + restart. For a large subtree (10+ sessions) the sweep
  runs them in parallel via `.catch(() => {})`, so wall-clock is
  bounded by the slowest, not the sum.
- **Reviewer sessions persisted as zombies.** `_persistActive` writes
  `activeVerifications` to disk. After pause+restart, the entries
  should be absent (call site 1 deletes them via
  `cancelAllVerifications`). Pinning test recommended in
  `tests/verification-harness.spec.ts`.
