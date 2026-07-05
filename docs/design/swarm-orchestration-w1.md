# SWARM-W1 — the fixed best-of-N pattern

Status: hand-wired, no synthesizer/classifier/graph-UI · Wave 1 of the SWARM
lane (`~/Documents/dev/bobbit-fable-refactor/design/swarm-orchestration.md`,
§4/§5/§6/§7/§8/§9, §11 Wave 1, §14 items 1–5). Rides on the merged SWARM-W0
guardrails (`docs/design/swarm-orchestration-w0.md`) — structural recursion
cap, `swarmGroup` tag, suppressed auto-merge, terminal barrier + artifact
capture. This wave makes the guardrails **load-bearing**: it is the first
code path that actually creates a `swarmGroup`-tagged goal in production.

## What shipped

**One fixed pattern, hand-wired on the existing team machinery**: N
same-prompt sibling child goals → terminal barrier (SWARM-W0) →
**deterministic** verifier (a shell command — never a self-grading LLM) →
pick the best passing candidate → **human-gated** confirmation → real git
integration of the winner only. No synthesizer, no classifier `propose`
wiring, no graph UI — exactly the design's "v1 = a single FIXED pattern"
scope (§2).

### 1. Orchestration entry point — `swarm-best-of-n.ts`

`createBestOfNSwarm(deps, opts)`: creates N sibling goals under a parent via
the existing `GoalManager.createGoal(..., { swarmGroup })` (which already
forces the SWARM-W0 structural cap on every sibling), then:

1. **Persists the expected-sibling-id set BEFORE starting any sibling**
   (`SwarmGroupStore.createGroup`) — the SWARM-W0 carry-forward fix (see
   MUST-FIX #4 below).
2. **Registers every sibling with the hard governor BEFORE requesting its
   start** (MUST-FIX #1/#3).
3. Routes every start through `VerificationHarness.requestChildStart` — the
   SAME per-root scheduler every other child-spawn path uses. Never spawns a
   bespoke "join" entity (MUST-FIX #2).

Best-of-N siblings share **the exact same `spec`** (the defining property of
this pattern vs. orchestrator-worker); only `suggestedRole` may vary per
sibling.

### 2. Deterministic verifier — `swarm-verifier.ts`

`verifyBestOfNGroup(group, resolveCwd, verifyCommand)` runs `verifyCommand`
(via `spawnTracked` — the same process-tree-safe primitive
`verification-harness.ts`'s own `runCommandStep` uses; no new child-process
handling invented) in each `done` candidate's worktree. Exit code 0 = pass; an
optional `SCORE: <n>` stdout line breaks ties among passing candidates
(deterministic — earliest `capturedAt` is the final tie-break, never random).
**Never invents a winner**: `not-ready` (barrier hasn't fired), `all-failed`
(SWARM-W0's escalate-only flag — no command even runs), and
`no-passing-candidate` are all distinct non-picking outcomes.

### 3. Human-gate + real integration — `swarm-routes.ts`

REST surface, goal-scoped (mirrors `nested-goal-routes.ts`'s convention — no
new cross-project swarm-group index needed):

```
POST /api/goals/:id/swarm/best-of-n          — fan out N siblings (ORCHESTRATION-class, team-lead only)
GET  /api/goals/:id/swarm-groups/:swarmGroup — status (persists across reload)
POST /api/goals/:id/swarm-groups/:swarmGroup/verify   — run the verifier (OPERATOR-class)
POST /api/goals/:id/swarm-groups/:swarmGroup/confirm  — human-gated integrate (OPERATOR-class)
```

The human-gate (design §9 "Human-gate every non-solo plan; user-originated
only") is real, not a UI stub: `/verify` mints a one-shot
`operator-confirmation` token (the SAME primitive the Claude Code
host-preferences confirmation flow already uses —
`src/server/auth/operator-confirmation.ts`, reused verbatim) bound to
`{swarmGroup, winnerGoalId}`, **only** when `authorizeChildrenMutation`
classified the caller as `"human-cookie"`. A team-lead-credentialed
(agent-originated) verify call gets the scores back but **no token** —
structurally, the orchestrating agent cannot mint-and-consume its own
confirmation. `/confirm` requires both a verified human/UI cookie AND that
exact one-shot token — pinned in `tests/e2e/api-swarm-best-of-n.spec.ts`.

Integration reuses `GoalManager.mergeChild` — the SAME choke point SWARM-W0's
suppression already guards — via one new escape hatch:
`mergeChild(parentId, winnerId, { forceIntegrateSwarmWinner: true })`, settable
**only** from the confirm route after token consumption. Every other caller
(the default) still gets the unconditional SWARM-W0 skip — zero behavior
change, pinned in `tests/swarm-w1-merge-winner.test.ts` alongside the
untouched `tests/swarm-w0-merge-suppression.test.ts`. Losing siblings are
archived (soft-deleted) WITHOUT merging — their branches survive, unmerged
candidates, per design §5.3.

### 4. UI — governor strip on the existing Agents tab

`src/app/goal-dashboard.ts`'s `renderAgentsTab()` gained a strip, rendered
**only** when the current goal's direct children carry a `swarmGroup` (derived
client-side from the already-fetched `dashboardDescendants` — no new
cross-goal query). Shows expected/captured terminal count, the token-budget
cap, an `ALL FAILED` escalation banner, Run-verifier / Confirm buttons, and
the integrated marker. A plain goal's Agents tab is **byte-identical** to
before this change (pinned:
`tests/e2e/ui/swarm-best-of-n.spec.ts`'s "zero leakage" test). No graph view,
per design §2/§8.

## MUST-FIX items (SWARM-W1 tracker row) — evidence

1. **Hard per-node `tokenBudget` at the RPC/turn boundary + hard-kill at
   ceiling×margin.** `src/server/agent/swarm-governor.ts`'s `SwarmGovernor`
   is checked from `SessionManager.trackCostFromEvent` — the ONE place a
   turn's cumulative usage becomes known (every `message_end` frame), not a
   spawn-boundary gate. Below `tokenBudget`: `abort-turn` (aborts the
   in-flight `RpcBridge` turn via `session.rpcClient.abort()`, non-fatal —
   the sibling can still reach a terminal state and be captured). At/above
   `tokenBudget × hardKillMarginMultiplier` (default 1.5): `hard-kill` —
   `VerificationHarness.hardKillSwarmNode` calls
   `SessionManager.terminateSession` (the existing SIGTERM→3s→SIGKILL
   backstop) then fires `notifyChildTerminal(goalId, "killed")` so the
   barrier still sees the event. Pinned:
   `tests/swarm-w1-governor.test.ts` (pure logic, injectable clock).
2. **Permits only for RUNNABLE nodes; a join/barrier holds ZERO permits;
   `fanOut > cap` + join deadlock pin.** Structurally true by construction —
   the barrier (`SwarmGroupStore.recordArtifact`, called synchronously
   inside `notifyChildTerminal`) is **never itself a scheduled/spawned
   entity**, so it can never contend for a permit. `createBestOfNSwarm`
   requests every sibling's start through the EXISTING
   `ChildTeamScheduler.requestStart` (acquire-when-runnable; a
   capacity-blocked sibling is FIFO-queued holding zero permits — see
   `_startNextEligible`'s paused-skip precedent, reused for the queued
   state). Pinned: `tests/swarm-w1-scheduler-deadlock.test.ts` drives the
   real `ChildTeamScheduler` with `fanOut(5) > cap(2)` and asserts full
   convergence (every sibling starts and terminates, the barrier-equivalent
   counter fires exactly once per sibling, zero deadlock).
3. **Straggler wall-clock hard-kill.** `SwarmGovernor.registerNode`'s
   `wallClockMs` arms a timer (injectable `schedule`/`clear` for tests) that
   calls the SAME `hardKillSwarmNode` path on expiry, UNLESS
   `unregisterNode` (called from `notifyChildTerminal`, unconditionally, for
   every goal) has already disarmed it. Pinned:
   `tests/swarm-w1-governor.test.ts`'s straggler describe block (fires once
   at the deadline; does NOT fire if terminal beats the clock; re-registering
   resets the clock).
4. **SWARM-W0 carry-forward: expected-sibling set persisted at group
   creation, not capture-time scan.** `SwarmGroupStore` gained `createGroup`
   (persists `expectedSiblingIds` once, up front) and `recordArtifact` now
   treats a persisted set as AUTHORITATIVE — it ignores its own
   `expectedSiblingIds` parameter once a group has one (legacy/direct callers
   with no pre-created group are unaffected — back-compat fallback,
   preserving every existing SWARM-W0 test byte-for-byte).
   `_captureSwarmArtifactIfTagged` now reads the persisted set first, only
   falling back to a live `goalStore` scan for groups that never went
   through `createGroup`. Pinned:
   `tests/swarm-w1-expected-sibling-persistence.test.ts` (a sibling created
   AFTER two others already went terminal is still correctly counted against
   the pre-created group — the exact race the old capture-time scan got
   wrong).
5. **Governor STRIP on the Agents grid — no swarm internals leak into the
   normal agents view.** See "UI" above; the zero-leakage pin is a real
   assertion (`.swarm-governor-strip` has `toHaveCount(0)` on a plain goal),
   not a visual claim.

## Deliberately NOT built this wave

- **No synthesizer, no classifier `propose` wiring** — topology (best-of-N,
  N, roles) is caller-supplied via the REST body, never LLM-decided. Per
  design, that's SWARM-W3+ (`propose{swarm-plan}`).
- **No graph/topology view** — the governor strip is the only new UI
  surface, per design §2/§8.
- **No cross-goal Agents-tab roster aggregation.** Each swarm sibling is a
  genuinely separate child GOAL with its own team — the strip surfaces
  aggregate swarm STATUS on the parent's Agents tab, but does not inline
  each sibling's individual per-agent session cards into the same grid
  (that needs cross-goal team-roster plumbing `TeamAgent` doesn't have
  today — `swarmGroup` isn't threaded onto the `fetchAgents` projection).
  Flagged as a W2+ follow-up, not required by the tracker row's literal
  "governor strip" ask.
- **No auto-approve-under-budget** — every non-solo plan is human-gated,
  unconditionally (design §6 "bound auto-approve strictly below solo cost,
  or drop it" — this wave drops it entirely rather than tune a threshold).
- **No prompt-cache reuse exploitation across same-prompt siblings** (design
  §13 open question) — siblings run as fully independent child goals/teams
  today; a shared-prefix cache optimization is a cost lever, not a
  correctness requirement, left for a later wave.
- **No worktree/branch GC for losing candidates** — a losing sibling's
  branch survives (worktree teardown only removes the working copy), same
  gap SWARM-W0 already flagged, not closed here.
- **Restart-resume of an in-flight swarm** (a gateway restart mid-fan-out) is
  untested — `SwarmGroupStore`/`GoalStore` are both restart-durable, so the
  STATE survives, but a hard-killed governor timer does not re-arm on
  restart (the `SwarmGovernor` instance is in-memory only). Flagged for
  SWARM-W2 (design's phased plan already schedules "restart-resume in
  `test:manual`" for Wave 2).

## Test coverage map

| Guarantee | Test |
|---|---|
| Token-budget abort/hard-kill + straggler wall-clock | `tests/swarm-w1-governor.test.ts` |
| Expected-sibling-set persisted-at-creation fix | `tests/swarm-w1-expected-sibling-persistence.test.ts` |
| `fanOut > cap` scheduler convergence (deadlock pin) | `tests/swarm-w1-scheduler-deadlock.test.ts` |
| Deterministic verifier (escalate-only, tie-break, timeout) | `tests/swarm-w1-verifier.test.ts` |
| `mergeChild` forced-winner escape hatch (zero-behavior-change default) | `tests/swarm-w1-merge-winner.test.ts` |
| `createBestOfNSwarm` orchestration ordering | `tests/swarm-w1-best-of-n.test.ts` |
| Full REST round trip + real git merge + all-failed escalation | `tests/e2e/api-swarm-best-of-n.spec.ts` |
| Governor strip: run→render→reconcile→reload-persist + zero-leakage | `tests/e2e/ui/swarm-best-of-n.spec.ts` |
