# SWARM-W3 — the scheduler-hook gap + per-sibling status transparency

Status: shipped · Wave 3 of the SWARM lane
(`~/Documents/dev/bobbit-fable-refactor/design/swarm-orchestration.md` §11
schedules its OWN "Wave 3" as the `propose{swarm-plan}` classifier validator +
plan-synthesizer pack + orchestrator-worker topology — all of which need
CLF's classifier `propose` seam, which is still harness-only as of this
wave (`fable/d4-clf-w2`: "harness only ... zero classifiers ⇒ every consult
abstains"). Building the actual synthesizer/orchestrator-worker pattern on
top of an unpopulated classifier would mean shipping either dead code or a
scope-creeping CLF slice bundled into a SWARM PR. Per the tracker's own
auto-dispatch note after SWARM-W2 landed — *"SWARM-W3 (scheduler-hook gap +
status surfacing per doc)"* — this wave instead closes the two concrete,
already-buildable gaps SWARM-W2 left explicitly flagged: the straggler-clock
scheduler-hook gap, and swarm status transparency in the UI.

## 1. The scheduler-hook gap — straggler clock anchored to team-start

`docs/design/swarm-orchestration-w2.md`'s "One related gap found but
deliberately NOT fixed this wave": `createBestOfNSwarm` registered EVERY
sibling with `SwarmGovernor` before `requestChildStart`, including ones the
scheduler reports `capacity-blocked` (parked FIFO, not yet actually running).
The straggler wall-clock deadline therefore started ticking at
request/creation time, not at the moment the sibling's team actually starts —
under `fanOut > cap` with a long queue, a capacity-blocked sibling could in
principle be straggler-killed before it ever got a chance to run. The doc
named the exact fix: *"plumbing a 'team actually started' callback from
`ChildTeamScheduler` back into the registration path (today `_startHolding`/
`_startNextEligible` have no such hook)."*

### `ChildTeamScheduler.requestStart(childGoalId, onStart?)`

`child-team-scheduler.ts` gained an optional `onStart` callback, stored in a
new `startCallbacks` map keyed by `childGoalId`. `_startHolding` — the ONE
place `startChildTeam` is actually invoked, whether called synchronously from
`requestStart` (a permit was free) or later from `_startNextEligible`
(dequeued once a permit frees) — looks up and fires the callback immediately
before calling `deps.startChildTeam`. This is the single choke point both
start paths already funnel through, so no new call site was needed.

Deliberately NOT one-shot-consumed on invocation: if a start attempt fails
(sync throw or async reject), the child is released + re-enqueued for a later
retry, and `startCallbacks` is untouched — a later successful retry is itself
a fresh "team actually starting" moment the caller should be told about
again (`SwarmGovernor.registerNode` is idempotent, so re-arming per attempt
is safe; the alternative — consuming the callback on the first, failed,
attempt — would leave the node permanently ungoverned if the retry later
succeeds). The callback IS cleared on a terminal event (`notifyTerminal`) or
a stale/archived queue-drop, so it never leaks or fires for a child that
never actually starts.

### `swarm-best-of-n.ts` — deferred registration

`createBestOfNSwarm`'s per-sibling loop no longer calls
`swarmGovernor.registerNode` unconditionally before `requestChildStart`.
Instead it builds an `armGovernor` closure (the exact same registration call
as before) and passes it as `requestChildStart(goalId, armGovernor)`'s
`onStart` argument. For a sibling that gets a free permit immediately this
fires at (effectively) the same moment as before — negligible difference.
For a capacity-blocked sibling it now fires ONLY once the scheduler actually
drains it into a freed slot: its straggler wall-clock deadline (and
token-budget enforcement, which was always moot before a session exists
anyway) starts from real team-start, not from however long it happened to
wait in the FIFO queue.

Token-budget enforcement is unaffected in substance — there is no
session/turn to check spend against until the team is actually running, so
deferring the WHOLE `registerNode` call (not just the wall-clock half) to
start time changes nothing observable for that half.

### Restart-resume interaction (documented, not changed)

`swarm-restart-resume.ts`'s boot sweep (`reArmSwarmGovernorsOnBoot`,
SWARM-W2) still uses `goal.createdAt` as the elapsed-time proxy for EVERY
still-in-flight sibling, deliberately UNCHANGED by this wave. That proxy is
no longer exactly accurate for a sibling that spent real time
capacity-blocked before restart (its governor node, under this wave's fix,
wasn't registered until team-start, which could be meaningfully later than
`createdAt`) — but the alternative, skipping re-arm for a still-queued
sibling, is strictly worse: `ChildTeamScheduler`'s FIFO queue is in-memory
only and does NOT survive a restart either (a separate, pre-existing,
non-swarm-specific gap — nothing in the codebase re-drives a `state:
'blocked'` child at boot), so a still-queued sibling would otherwise be
silently orphaned forever post-restart: never started (queue is gone), never
governed (skipped), and the barrier would never converge. Keeping the
conservative `createdAt`-based re-arm trades "may straggler-kill a moment
early after a restart that happens to catch a sibling mid-queue" for "the
swarm always converges" — the same priority the design's §6/§7 guarantee
already establishes elsewhere. In the common case (a sibling that got a free
permit immediately) `createdAt` is still an accurate proxy, since
registration now happens synchronously inside the very same
`requestChildStart` call `createBestOfNSwarm` makes right after creating the
goal. See the doc comment on `reArmSwarmGovernorsOnBoot` for the full
reasoning; no code changed here, only documentation.

### Tests

- `tests/swarm-w3-scheduler-hook.test.ts` (new): drives the REAL
  `ChildTeamScheduler` directly, `fanOut(5) > cap(2)` and smaller cases,
  proving `onStart` fires exactly once per sibling, in exactly the order
  `startChildTeam` is actually invoked; never fires for a queued sibling
  merely because `requestStart` was called; never fires for a
  stale/archived queue entry that's dropped before it starts; and is cleared
  (not leaked) by a direct `notifyTerminal` on a still-queued child.
- `tests/swarm-w1-best-of-n.test.ts` — the "registers every sibling with the
  governor BEFORE requesting its start" test (which pinned the OLD, buggy
  ordering as an invariant) is replaced with a test pinning the NEW
  invariant: an immediately-started sibling is registered by the time
  `createBestOfNSwarm` returns; a capacity-blocked sibling is NOT registered
  while merely queued, and becomes registered once its stored `onStart`
  callback is invoked (simulating the scheduler later draining the queue).
  The fake harness's `requestChildStart` now mirrors the real `onStart`
  contract instead of ignoring it.
- All other SWARM-W1/W2 tests (`swarm-w1-governor`, `swarm-w1-scheduler-
  deadlock`, `swarm-w2-governor-restart`, `swarm-w2-restart-resume`,
  `child-team-scheduler`) pass unchanged — this wave's fix is additive at
  the scheduler layer (an optional parameter, default `undefined` behaves
  identically to before it existed) and a pure re-ordering in
  `swarm-best-of-n.ts`.

## 2. Per-sibling status transparency in the UI

The W1 governor strip (`renderSwarmGovernorStrip` in `src/app/goal-
dashboard.ts`) showed only an AGGREGATE `captured/expected candidates
terminal` count, an aggregate token-budget cap, an `ALL FAILED` escalation
banner, and (once verified) the overall outcome + winner pick — never which
INDIVIDUAL candidate was in what state or how it scored. Per the design's
transparency principle (§/tracker: "users see sibling states/budgets/
verifier verdicts — nothing hidden"), this wave adds one row per sibling
under the existing aggregate strip.

### What's rendered

`renderSwarmSiblingRows(swarmGroup, status)`, appended inside each existing
`.swarm-governor-strip`, one row per sibling (`.swarm-governor-sibling`,
`data-sibling-goal-id`, `data-sibling-state`):

- **Title** — the sibling goal's own title (e.g. "... (candidate 2)").
- **State** — `done` / `failed` / `killed` once the barrier has captured a
  terminal artifact for that sibling; otherwise its LIVE goal state
  (`todo` / `in-progress` / `queued (capacity)` for `state: 'blocked'`).
- **Verifier verdict** — `verify: pass (N)` / `verify: fail (N)` once
  `/verify` has run, read per-sibling from `lastVerify.scores` (was already
  computed and returned by the GET route, just never rendered per-candidate
  before this wave).
- **Winner marker** — once `/confirm` has integrated a pick, the winning
  sibling's OWN row (not just an aggregate "integrated: <id>" line) carries
  a `winner` badge.

All of this is data the strip ALREADY had: `dashboardDescendants` (client-
side, already fetched for the Plan tab) supplies live state/title;
`SwarmGroupStatus.artifacts` and `.lastVerify.scores` (both already returned
by `GET /swarm-groups/:swarmGroup`, just not previously surfaced in the
client's `SwarmGroupStatus` interface or template) supply terminal/verdict
detail. Zero new REST endpoints, zero new polling — this is a pure rendering
addition. `SwarmGroupStatus.artifacts` was added to the client-side
TypeScript interface to type what the server already sent.

A goal with no swarm-tagged children still renders nothing extra (unchanged
zero-leakage guarantee from W1) — `renderSwarmSiblingRows` is only reached
inside the existing per-group strip loop.

### Tests

`tests/e2e/ui/swarm-best-of-n.spec.ts`'s existing run→render→reconcile→
reload-persist flow is extended (not duplicated) with per-sibling
assertions at each phase:
- RENDER: both sibling rows visible, `data-sibling-state="done"` for both,
  no verdict/winner badge yet.
- RECONCILE (verify): the WINNER_MARKER-carrying sibling's row shows
  `verify: pass`; the other shows `verify: fail`.
- RECONCILE (confirm): the winning sibling's row (and only that one) shows
  the `winner` badge.
- RELOAD-PERSIST: the winner badge survives a full page reload.
The "zero leakage" test additionally asserts `.swarm-governor-sibling` has
count 0 on a plain (non-swarm) goal's Agents tab.

## Deliberately NOT built this wave

- **No `propose{swarm-plan}` validator/reducer, no plan-synthesizer pack, no
  orchestrator-worker topology** — the master design doc's own "Wave 3" scope
  needs CLF's classifier `propose` seam populated with a real classifier
  (still harness-only/zero-classifiers-registered as of this wave); building
  the synthesizer against an abstaining-by-construction classifier would ship
  either dead code or force an out-of-lane CLF slice into this PR. Left for
  when CLF's classifier work lands for real.
- **No verifier hardening** — audited as a candidate per the tracker's
  priority ordering, but the scheduler-hook gap and status transparency were
  both concrete, already-flagged, buildable gaps with no missing
  dependencies; verifier hardening had no specific flagged gap to close this
  wave (SWARM-W1/W2's verifier semantics — escalate-only, deterministic
  tie-break, distinct non-picking outcomes — were already audited as sound
  in `swarm-orchestration-w2.md`'s "Partial-failure / straggler-kill
  semantics: audited, not re-built" section).
- **No fix for the general "capacity-blocked/`state: 'blocked'` children
  don't survive a gateway restart" gap** — pre-existing, not swarm-specific
  (no boot-time re-drive of blocked children exists anywhere in the
  codebase). Documented as an explicit, deliberate scope boundary in
  `swarm-restart-resume.ts`'s updated doc comment; the restart-resume
  boot-sweep itself is otherwise unchanged from SWARM-W2.
- **No worktree/branch GC for losing candidates** — unchanged carry-forward
  from SWARM-W0/W1/W2.
- **No cross-goal Agents-tab roster aggregation** — still flagged as a
  separate follow-up from SWARM-W1 (`TeamAgent`/`fetchAgents` don't thread
  `swarmGroup`); the per-sibling rows added this wave are goal-state/verdict
  summaries, not full per-sibling agent-session cards.

## Test coverage map

| Guarantee | Test |
|---|---|
| `ChildTeamScheduler.requestStart`'s `onStart` hook fires exactly at actual team-start, never earlier, never for a child that doesn't actually start | `tests/swarm-w3-scheduler-hook.test.ts` |
| `createBestOfNSwarm` defers `SwarmGovernor.registerNode` to actual team-start (immediate vs. capacity-blocked) | `tests/swarm-w1-best-of-n.test.ts` |
| Existing scheduler invariants (fanOut>cap convergence, pause-awareness, start-failure permit safety, live resize) unaffected | `tests/child-team-scheduler.test.ts`, `tests/swarm-w1-scheduler-deadlock.test.ts` |
| Existing governor/restart-resume behavior unaffected | `tests/swarm-w1-governor.test.ts`, `tests/swarm-w2-governor-restart.test.ts`, `tests/swarm-w2-restart-resume.test.ts` |
| Per-sibling state/verdict/winner rows render → reconcile → survive reload; zero leakage on a plain goal | `tests/e2e/ui/swarm-best-of-n.spec.ts` |
