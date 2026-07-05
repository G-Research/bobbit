# SWARM-W2 — restart-resume for the hard governor

Status: shipped · Wave 2 of the SWARM lane
(`~/Documents/dev/bobbit-fable-refactor/design/swarm-orchestration.md` §11 Wave
2: *"partial-failure semantics + straggler/backstop kills hardened;
restart-resume in `test:manual`"*). Rides on SWARM-W1's fixed best-of-N
pattern (`docs/design/swarm-orchestration-w1.md`) — specifically the gap that
doc flags explicitly under "Deliberately NOT built this wave": *"Restart-resume
of an in-flight swarm ... is untested — `SwarmGroupStore`/`GoalStore` are both
restart-durable, so the STATE survives, but a hard-killed governor timer does
not re-arm on restart (the `SwarmGovernor` instance is in-memory only). Flagged
for SWARM-W2."*

## What this wave closes

`SwarmGovernor` (`swarm-governor.ts`) is a per-process, in-memory `Map`: every
`registerNode` call arms a straggler wall-clock timer and enables
turn-boundary token-budget enforcement for one swarm-sibling goal
(`session-manager.ts`'s `trackCostFromEvent` checks it on every
`message_end`). A gateway restart constructs a **fresh, empty**
`VerificationHarness` (and therefore a fresh, empty `SwarmGovernor`) — nothing
re-populates it from the durable state that DOES survive (`GoalStore`,
`SwarmGroupStore`). Before this wave, a swarm sibling still running when the
gateway restarted lost BOTH its token-budget ceiling AND its straggler
wall-clock deadline for the rest of its life: the design's own convergence
guarantee (§6/§7 "the swarm must always be able to converge") silently did not
hold across a restart.

## 1. Elapsed-time-aware re-arm — `SwarmGovernor.registerNode`

`registerNode` gained an optional 4th parameter, `opts?: { elapsedMs?: number
}`. The straggler timer now schedules for `max(0, wallClockMs - elapsedMs)`
instead of always the full `wallClockMs`. This is the load-bearing subtlety:
a naive re-arm that always grants a fresh full `wallClockMs` budget on every
restart would let repeated restarts extend a straggler's runway indefinitely,
defeating the "always converges" guarantee. A sibling that was ALREADY past
its deadline during the downtime gets a `0ms` schedule — it fires on the next
tick rather than being silently left ungoverned forever. `elapsedMs` defaults
to `0`, so every existing (non-restart) call site is byte-identical in
behavior. Pinned in `tests/swarm-w2-governor-restart.test.ts`.

## 2. The boot sweep — `reArmSwarmGovernorsOnBoot` (new: `swarm-restart-resume.ts`)

Called once from `server.ts`, immediately after `VerificationHarness` is
constructed (the earliest point where `verificationHarness.swarmGovernor`,
`sessionManager`, and a fully `initAll()`'d `projectContextManager` are all
available). For every project context's `SwarmGroupStore.getAll()`:

- Skips a group whose barrier already fired (`barrierFired: true`) — nothing
  left to govern.
- Skips a group with no persisted `config` — only groups created via
  `SwarmGroupStore.createGroup` (SWARM-W1+) carry the per-node budget
  (`tokenBudgetPerNode`/`wallClockMsPerNode`/`hardKillMarginMultiplier`) a
  re-arm needs; legacy/direct-`recordArtifact` callers (this store's own unit
  tests) never had a governor budget in the first place.
- For every `expectedSiblingIds` entry NOT already present in `artifacts`
  (i.e. still non-terminal): resolves the sibling's `PersistedGoal`, skips it
  if it no longer exists or is archived (some other path already resolved it
  without going through the swarm capture seam — not this sweep's job to
  reconcile), and otherwise calls `swarmGovernor.registerNode(goalId, budget,
  onStraggler, { elapsedMs: now() - goal.createdAt })`.

`goal.createdAt` is the best available durable proxy for the sibling's
original `registerNode` time — `createBestOfNSwarm` creates the goal and
registers it with the governor back-to-back, synchronously, in the same call
(see `swarm-best-of-n.ts`). `onStraggler` re-wires to the SAME
`harness.hardKillSwarmNode` path the original registration used, so a
re-armed straggler converges the barrier exactly like a live one would
(`notifyChildTerminal(goalId, "killed")` → `SwarmGroupStore.recordArtifact`).
Best-effort and pure sweep: never mutates goal/session state itself, never
resolves the barrier directly, logs and continues past a single project's
read failure rather than aborting the whole boot.

Pinned in `tests/swarm-w2-restart-resume.test.ts` (unit, real
`GoalStore`/`SwarmGroupStore`, fake harness) covering: only-in-flight-siblings
re-armed, already-barriered groups skipped, config-less (legacy) groups
skipped, gone/archived siblings skipped, `elapsedMs` computed from
`createdAt`, multi-project aggregation.

## 3. Production wiring proof — `tests/e2e/api-swarm-restart-resume.spec.ts`

The design's phased plan asks for "restart-resume in `test:manual`", but
`tests/manual-integration/` is reserved for **real agents + real Docker**
(its own header: *"These tests use real agents (not mocks) and real Docker
containers... manual specs talk to real agents, not the mock-agent
contract"*) — a synthetic mock-agent restart scenario does not belong there,
and a literal spawned-process restart adds real-LLM cost/flakiness risk to
prove a mechanism that has nothing to do with agent behavior. Instead this
wave follows the SAME precedent `orchestrate-restart.spec.ts` already
established for `OrchestrationCore`'s own restart-survival (its header: *"The
in-process E2E harness has no true gateway-reboot primitive... restart
survival is driven at the integration level against the REAL gateway by
invoking the same public methods the boot path runs... NOT a fake"*):

- `server.ts`'s return object and `tests/e2e/in-process-harness.ts`'s
  `GatewayInfo` both now expose `verificationHarness` (mirroring the existing
  `@internal Exposed for in-process E2E tests` convention already used for
  `orchestrationCore`/`projectContextManager`/`preferencesStore`).
- The E2E spec fans out a REAL best-of-N swarm (mock agent, real git
  worktrees — same harness `api-swarm-best-of-n.spec.ts` uses), force-terminals
  one sibling, and deliberately leaves the other running/uncaptured.
- It then simulates "the gateway just restarted" by calling
  `swarmGovernor.unregisterNode(stillRunningSiblingId)` (the faithful
  single-process proxy for "the entire in-memory `SwarmGovernor` instance was
  destroyed and replaced") and re-invokes the EXACT boot-time function,
  `reArmSwarmGovernorsOnBoot(gw.projectContextManager,
  gw.verificationHarness)`, against the live, real gateway state.
- Asserts the re-armed straggler timer fires, hard-kills the sibling, and the
  barrier converges (`barrierFired: true`, the sibling's artifact
  `status: "killed"`) — reproducing, end to end through the real REST/gateway
  layer, the exact regression this wave fixes (pre-fix, that sibling would
  stay uncaptured forever and the barrier would never fire).
- A second test proves an already-fully-barriered group's siblings are never
  re-registered by the sweep.

## Partial-failure / straggler-kill semantics: audited, not re-built

Wave 2's design line also reads "partial-failure semantics ... hardened".
Auditing the existing SWARM-W1 surface (`swarm-verifier.ts`,
`swarm-routes.ts`) found the core partial-failure handling already correct
and unchanged by this wave:

- `verifyBestOfNGroup` only ever verifies `done` artifacts — a mixed
  done/failed/killed barrier never verifies a non-`done` candidate.
- `no-passing-candidate` (some `done`, none pass the verify command) and
  `all-failed` (none `done`) are both distinct, non-picking, human-escalation
  outcomes — never silently resolved.
- `/confirm` archives every non-winner sibling (including any `failed`/
  `killed` ones) without merging, best-effort per loser.

**One related gap found but deliberately NOT fixed this wave** (flagging for
a future pass rather than silently expanding this wave's scope):
`createBestOfNSwarm` calls `swarmGovernor.registerNode` for EVERY sibling
before `requestChildStart`, including ones the scheduler reports
`capacity-blocked` (parked FIFO, not yet actually running). Its wall-clock
straggler clock therefore starts ticking at goal-creation time, not at the
moment the sibling's team actually starts — under `fanOut > cap` with a long
queue, a capacity-blocked sibling could in principle be straggler-killed
before it ever gets to run. Fixing this requires plumbing a "team actually
started" callback from `ChildTeamScheduler` back into the registration path
(today `_startHolding`/`_startNextEligible` have no such hook) — a
distinct, non-trivial change outside this wave's explicit "restart-resume"
scope. Left for SWARM-W2+/a dedicated straggler-timing follow-up.

## Deliberately NOT built this wave

- **No change to token-budget spend durability** — already restart-durable
  before this wave (`CostTracker` persists per-session usage independent of
  the governor's Map; a re-armed node immediately sees the correct
  pre-restart cumulative total on the next `message_end`). This wave only
  closes the REGISTRATION gap, not a spend-accounting gap.
- **No fix for the capacity-blocked-clock-starts-early straggler-timing gap**
  described above.
- **No literal real-process/real-Docker restart test** — see §3 above for why
  that would be scope-mismatched with `tests/manual-integration/`'s
  real-agent-only convention; the in-process integration-level proof (the
  same tier `orchestrate-restart.spec.ts` already uses for
  `OrchestrationCore`) is the faithful equivalent here.
- **No worktree/branch GC for losing candidates** — unchanged carry-forward
  from SWARM-W0/W1.

## Test coverage map

| Guarantee | Test |
|---|---|
| `registerNode`'s `elapsedMs`-aware remaining-budget arithmetic | `tests/swarm-w2-governor-restart.test.ts` |
| `reArmSwarmGovernorsOnBoot` boot-sweep logic (real stores, fake harness) | `tests/swarm-w2-restart-resume.test.ts` |
| Production wiring: real gateway, simulated restart, straggler fires, barrier converges | `tests/e2e/api-swarm-restart-resume.spec.ts` |
| Existing SWARM-W1 partial-failure/escalation behavior (regression check) | `tests/e2e/api-swarm-best-of-n.spec.ts`, `tests/swarm-w1-verifier.test.ts` |
