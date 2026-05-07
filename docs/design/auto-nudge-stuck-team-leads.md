# Auto-nudge stuck team-leads when subordinates have completed work

**Goal:** `auto-nudge-6eef577e`. Child of `audit-subg-225e4d3d`.
**Status:** design — no production code yet.

## Motivation — observed stall

During dogfooding of `audit-subg-225e4d3d`, subgoal `df3d8b33` ("Plan tab
shows archived children") stalled for **7+ minutes**:

- Coder session `85e8eda2` went idle (presumably after pushing its branch).
- Team-lead session `f60e32d6` (Simba) was also idle.
- Neither resumed until the user manually `/notify`-pinged the team-lead.

The existing `agent_end → notifyTeamLead` path in
`src/server/agent/team-manager.ts` is supposed to fire on every team-member
idle transition and wake the team-lead. It either didn't fire, fired and was
swallowed, or fired but the wake-up text wasn't actionable enough for the lead
to recover. This design doc roots the cause and adds two safety nets.

## Section 1 — Root-cause analysis

The relevant plumbing in `src/server/agent/team-manager.ts`:

- `notifyTeamLead(goalId, workerSessionId, role, agentId)` (line 1174). Fired
  from a per-worker `rpcClient.onEvent("agent_end")` listener installed in
  two places: (a) inside `spawnRole` immediately after the worker is created
  (~line 1135), and (b) inside `resubscribeTeamEvents()` (~line 427) on
  every server restart, walking the persisted team store.
- `nudgePending` (line 150) — a per-goal boolean guard. Set true when an
  auto-nudge is enqueued; cleared on the team-lead's next `agent_start`
  (line 703 in `subscribeTeamLeadEvents`). This is the existing throttle.
- The `kind: "reviewer"` filter — both at re-subscribe (line 421
  `if (agent.kind === "reviewer" || agent.role === "reviewer") continue`)
  and inside `notifyTeamLead` itself (line 1184 defensive guard). This is
  the historical fix for "Reviewer spuriously nudges team-lead" called out
  in AGENTS.md.
- `lastNotifyTime` (line 168) — 30 s per-worker debounce inside
  `notifyTeamLead`.
- The 10-minute / 5-minute idle-nudge timers (`scheduleWorkersNudge`,
  `startIdleNudgeTimer`). These are the *long-tail* safety net; their
  default `IDLE_NUDGE_DELAY_MS = 600_000` ms means **the workers-nudge
  cannot fire in <10 minutes** even when both lead and worker are fully
  idle. The 7-minute stall is below this threshold by design.

### Failure modes, ranked

**(1) Most likely — notification fired, team-lead acted on it weakly or not
at all.** The current `notifyTeamLead` text is:

```
Agent <id> (<role>) has finished. Tasks: "<title>" (state: <state>)
— <resultSummary>. Check task details and decide next steps.
```

That's enough for an attentive lead, but the lead can rationalise "task is
in-progress, the worker will continue" and do nothing — especially when the
worker is also idle (the message doesn't say so). No code path forces a
follow-up. Evidence: the manual `/notify` ping resolved it instantly and
contained no new information — just *a second* nudge with the same
underlying state. This rules out routing failure (the message clearly
arrived).

**(2) Plausible but secondary — `agent_end` subscription was dropped by a
restart.** `resubscribeTeamEvents()` re-installs worker listeners only for
sessions whose `status !== "terminated"`. If the gateway restarted **between**
the coder's `agent_start` and `agent_end`, the new listener fires for any
subsequent `agent_end` — but if the coder finished mid-restart, the event
itself is ephemeral RPC traffic and may have been lost. There is no replay.
The `kind: "reviewer"` filter is *not* a suspect here — coders are spawned
with `kind: "worker"` (line 1115 in `spawnRole`) and the filter only
excludes reviewer role agents.

**(3) Unlikely — team-lead was archived/restarted between coder start and
finish.** `df3d8b33` was an active subgoal at the time of the stall; if its
team-lead had been archived the goal would have been in `setupStatus !==
ready` or had no `teamLeadSessionId`. The Lesson 4.12 boot-respawn at
`_bootRespawnSessionlessGoals` (line 463) would have re-spawned a fresh
team-lead, which we'd see in the session list. Neither was reported.

### Diagnostic instrumentation

Until we can repro, the design must assume **(1)** is dominant and add a
watchdog that doesn't depend on the immediate `agent_end` path. We should
also add a single log line at every `notifyTeamLead` call site (currently
present at line 1153 — but only on success) so we can correlate
WS-event-arrival timestamps with the team-lead's own `agent_start` /
`agent_end` log if a future stall is reported.

Suggested additions (out of scope for this doc, but cheap):

- Log `[team-manager] notifyTeamLead deferred (debounce)` instead of just
  the existing `[team-manager] Debounced notification for ... ago` so
  grep can scope to the nudge path.
- Stamp `nudgePending` writes with the message that set them, behind a
  debug flag. Already covered by existing console.log lines downstream.

## Section 2 — Watchdog: detect long-idle teams with finished subordinates

The existing 10-minute workers timer is too coarse for the observed
7-minute stall. Add a **60-second sweep** that fills the gap between
"worker `agent_end` fired but the lead didn't act" (Section 1 cause #1)
and the existing 10-minute backoff. The sweep is the second safety net,
not a replacement for `notifyTeamLead`.

### Where it lives

A new private method on `TeamManager`:

```ts
private stuckSweepTimer: ReturnType<typeof setInterval> | null = null;
private static readonly STUCK_SWEEP_INTERVAL_MS = 60_000;
private static readonly STUCK_QUIET_THRESHOLD_MS = 5 * 60_000;
private lastNudgeAtPerGoal = new Map<string, number>();

private startStuckSweep(): void {
    if (this.stuckSweepTimer) return;
    this.stuckSweepTimer = setInterval(
        () => this._stuckSweepTick(),
        TeamManager.STUCK_SWEEP_INTERVAL_MS,
    );
    this.stuckSweepTimer.unref?.(); // never block process exit
}

private stopStuckSweep(): void {
    if (!this.stuckSweepTimer) return;
    clearInterval(this.stuckSweepTimer);
    this.stuckSweepTimer = null;
}

private _stuckSweepTick(): void {
    const now = Date.now();
    for (const [goalId, entry] of this.teams) {
        if (this.shouldSkipNudge(goalId)) continue;        // reuses existing gate
        if (!entry.teamLeadSessionId) continue;
        const lead = this.sessionManager.getSession(entry.teamLeadSessionId);
        if (!lead || lead.status !== "idle") continue;

        const workers = this.getActiveWorkers(goalId);
        if (workers.length === 0) continue;                // no-workers timer owns this case
        const allIdle = workers.every((a) => {
            const s = this.sessionManager.getSession(a.sessionId);
            return s && s.status === "idle";
        });
        if (!allIdle) continue;

        const leadIdleSince = lead.idleSince ?? lead.lastActivityAt ?? now;
        if (now - leadIdleSince < TeamManager.STUCK_QUIET_THRESHOLD_MS) continue;

        const lastNudge = this.lastNudgeAtPerGoal.get(goalId) ?? 0;
        if (now - lastNudge < TeamManager.STUCK_QUIET_THRESHOLD_MS) continue;

        this._fireStuckNudge(goalId, entry, workers, now);
    }
}
```

### Exact nudge text

```
[AUTO-NUDGE] Your team is fully idle and the workflow has stalled.
All N team agent(s) are idle and you have been idle for M minutes.
Check `task_list` and `gate_list` to identify the next action — either
merge a finished branch, mark a task complete, or signal the next gate.
If all gates have passed, call `team_complete`.
```

### Throttle key & integration

- **Throttle key:** `goalId`. Reuses the existing `nudgePending` guard
  (set true in `_fireStuckNudge`, cleared by `subscribeTeamLeadEvents`'s
  `agent_start` handler at line 703). Adds `lastNudgeAtPerGoal[goalId]`
  as a *minimum interval* between consecutive stuck-nudges so even if the
  lead acks-and-returns-to-idle within 5 minutes we don't re-spam. One
  nudge per stuck *episode*, not per sweep tick.
- **Skip conditions** — all delegated to the existing `shouldSkipNudge`
  helper (line 519), which already covers: missing team-lead, lead
  streaming or terminated, in-flight verifications, `nudgePending`,
  archived/complete/shelved goal, **paused goals**, in-flight subgoals
  via `anyInFlightChild`. We get the "don't nudge paused goals or
  non-interactive sessions" requirement free.
- **Lifecycle:** start the sweep at the end of the constructor (after
  `restoreTeams`); stop in a new `dispose()` method so tests can clean
  up. Single timer for the whole `TeamManager` (not per-goal) — the
  sweep cost is `O(activeTeams)` per minute; cheap.
- **Delivery path:** unchanged. `_fireStuckNudge` calls
  `this.sessionManager.enqueuePrompt(leadId, message, { isSteered: true })`
  exactly like the existing 10-minute nudge. The lead is idle by
  precondition, so the streaming branch never runs.
- **Public observability:** none required for v1. The existing
  `[team-manager] Sent ...` log line is sufficient. Add one more:
  `[team-manager] Stuck-team watchdog fired for goal ${goalId} after
  ${minutes}m idle`.

### Why a separate timer (not lowering `IDLE_NUDGE_DELAY_MS`)

Lowering the existing workers-nudge to 5 minutes would change a long-tested
back-off curve and risk over-nagging on legitimately-long-running tasks.
The watchdog is a tighter, separate predicate (lead idle **AND every worker
idle**, not just lead idle), so it can fire earlier without being noisy in
the common case where one worker is still streaming.

## Section 3 — Child-RTM parent-team-lead nudge

**Already exists.** The cross-tree notification is implemented today via
`buildParentReadyNotification` in
`src/server/agent/notify-team-lead-child-passed.ts` and called from
`verification-harness.ts::notifyTeamLead` (~line 1185). It fires on
`ready-to-merge` `passed` *and* `failed`, sends through the
`notifyTeamLeadFn` registered in `src/server/server.ts` (~line 967), and
routes via `enqueuePrompt` / `deliverLiveSteer` on the parent's team-lead.

The current message:

> Subgoal "..." passed ready-to-merge — its branch is ready. Use
> `goal_merge_child` to merge it into your branch, or `goal_archive_child`
> if you no longer need it.

This already matches the goal-spec requirement. **No new code** is needed
for Section 3 — the work is verifying it actually fires under the conditions
of the observed stall and adding regression coverage. Specifically:

1. Confirm via a new test that on a child whose `ready-to-merge` flips to
   `passed`, the parent's team-lead receives exactly one steered prompt.
2. Confirm that if the parent's team-lead is itself idle at the moment of
   the child's RTM transition, `enqueuePrompt` reliably wakes it (not just
   queues without dispatch). This is already the contract of
   `enqueuePrompt({ isSteered: true })` — verify in test by asserting the
   mock SessionManager's `enqueuePrompt` is called with the parent
   team-lead's session id.
3. Confirm the path still fires after a server restart that lands
   mid-verification (i.e. the `notifyTeamLeadFn` registration in `server.ts`
   isn't lost).

If item (2) or (3) reveals a gap, we add a child-RTM observer in the new
watchdog as a defensive fallback: re-checks at each sweep tick whether any
child has `ready-to-merge` passed/failed in the last 60 seconds and the
parent's team-lead hasn't been nudged. Implementation deferred until a
test demonstrates the gap.

## Section 4 — File changes

| File | Rationale |
| ---- | --------- |
| `src/server/agent/team-manager.ts` | Add `startStuckSweep` / `_stuckSweepTick` / `_fireStuckNudge` / `dispose`; new constants; wire `lastNudgeAtPerGoal` map. Audit `notifyTeamLead` log lines so future stalls are diagnosable. |
| `src/server/agent/team-manager-helpers.ts` (existing) | Optionally add a pure `isTeamFullyIdle(entry, sessionLookup)` helper so the sweep predicate is unit-testable without instantiating `TeamManager`. |
| `tests/team-manager-stuck-watchdog.test.ts` | **New.** Mock SessionManager + a single team. Tick sweep at T=0, T=60s, T=5min, T=6min. Assert nudge fires exactly once after 5-minute mark and not before; assert it skips when paused / non-interactive / `nudgePending`. |
| `tests/team-manager-child-rtm-notifies-parent.test.ts` | **New.** Drive a child goal's `ready-to-merge` to `passed` and to `failed` via `verifyGateSignal`; assert `notifyTeamLeadFn` is called with the parent's `goalId` and a message containing `goal_merge_child`. Existing pure-helper coverage in `tests/notify-team-lead-child-passed.test.ts` is unchanged. |
| `AGENTS.md` | Recipe entry under "Auto-nudge contract for team agents and child goals"; debugging keyword index entry "Team-lead idle while coder is idle / workflow stalled" pointing at the watchdog and `notifyTeamLead`. |
| `docs/internals.md` (optional) | One-line cross-reference to the watchdog in the team-manager section, if such a section exists; otherwise skip. |

No changes to `verification-harness.ts`, `goal-manager.ts`, or `server.ts`.

## Section 5 — Acceptance criteria

Restated verbatim from the goal spec, each with a one-line note.

1. **When a team-member coder transitions to idle, the team-lead reliably
   receives an auto-nudge within 5 seconds. No silent drops on bridge
   failures or session restarts.** — covered by the existing
   `notifyTeamLead` path (line 1174); the watchdog is a 5-minute fallback,
   not the primary. Restart resilience already provided by
   `resubscribeTeamEvents`.
2. **When a child goal's `ready-to-merge` passes (or fails), the parent's
   team-lead receives an auto-nudge.** — already wired via
   `buildParentReadyNotification` →
   `verification-harness.notifyTeamLeadFn`. New regression test pins it.
3. **Watchdog sweep detects fully-idle teams with finished subordinates
   after 5 minutes and fires a recovery nudge.** — Section 2 design.
4. **Throttling prevents spam — one nudge per stuck-state, not per sweep
   tick.** — `nudgePending` (set on enqueue, cleared on lead's
   `agent_start`) **plus** `lastNudgeAtPerGoal` (5-minute floor between
   consecutive stuck-nudges).
5. **Existing nudge tests still pass. New tests cover the watchdog and
   child-RTM paths.** — listed in Section 4.
6. **AGENTS.md recipe + debugging entry land alongside the code.** —
   listed in Section 4.
7. **`npm run check` clean. `npm run test:unit` green.** — implementation
   gate, not a design concern.

## Section 6 — Risks and open questions

- **`session.idleSince`** — the watchdog reads `lead.idleSince ??
  lead.lastActivityAt`. We need to confirm the actual field name on
  `SessionInfo`; if neither exists, fall back to tracking a per-goal
  `leadIdleSince` map updated from `subscribeTeamLeadEvents`'s
  `agent_end` handler. Pure-helper test will pin whichever shape we use.
- **Interaction with `_bootRespawnSessionlessGoals` (Lesson 4.12).** A
  freshly-respawned team-lead has `idleSince` near `now`, so the watchdog
  won't fire for 5 minutes — correct behaviour. No change needed.
- **Sweep cost on a large project.** `O(teams)` per minute, each tick is a
  few map reads + a status check. Negligible up to thousands of teams.
- **Should the watchdog also nudge when only *some* workers are idle?** The
  spec says "any team member is idle". The design above requires *all*
  workers idle, which is stricter (matches the `df3d8b33` stall).
  Loosening to "any worker idle for 5+ minutes" risks nagging when one
  worker is finished and another is legitimately streaming. Defer the
  looser variant until a real stall demonstrates it's needed.
- **Confirming Section 1 cause #1 vs #2.** Without logs from the original
  stall, we can't fully rule out a dropped `agent_end`. The watchdog
  covers both causes uniformly, so the choice doesn't change the design
  — but the diagnostic logging suggested in Section 1 is worth landing
  in the same PR so the next stall is easier to root-cause.
- **Section 3 already-implemented status.** If implementation reveals the
  parent-RTM nudge is *not* actually firing (e.g. the
  `setTeamLeadNotifier` registration is lost on restart), we will add
  the defensive re-check in the watchdog as described at the end of
  Section 3 — but only if a test demonstrates the gap.
