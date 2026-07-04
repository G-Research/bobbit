# SWARM-W0 — guardrail foundation for dynamic swarms

Status: seam-only, no production trigger yet · Wave 0 of the SWARM lane
(`~/Documents/dev/bobbit-fable-refactor/design/swarm-orchestration.md`, §9, §11
Wave 0, §14). Consumed by SWARM-W1 (fixed best-of-N pattern) and later waves.
**Nothing in production creates a `swarmGroup`-tagged goal yet** — every code
path here is exercised only by tests, exactly like CLF-W0.

## What this wave is

Two guardrails that any future dynamic-swarm fan-out (N sibling child goals
under one root) must ride on, landed **before** anything can spawn a tagged
sibling:

1. **A structural recursion cap** on any goal tagged as a swarm worker.
2. **Two of the design's three reconciliation primitives**: the `swarmGroup`
   tag itself + suppressed auto-merge, and a terminal barrier + per-sibling
   artifact capture. (The third primitive, the **reconciler** that consumes
   the barrier, is explicitly out of scope — see "Deliberately not built".)

## 1. The tag: `PersistedGoal.swarmGroup`

`goal-store.ts` — `swarmGroup?: string`. Stamped once, at creation, by
`GoalManager.createGoal` when a caller passes `opts.swarmGroup`; never mutated
afterward. Persisted via `GoalStore`'s existing (non-atomic, but
restart-durable — the whole goal array is rewritten on every mutation) JSON
dump; every other `PersistedGoal` field shares this same discipline, so
`swarmGroup` introduces no new persistence gap.

## 2. The structural recursion cap (design §9)

`GoalManager.createGoal`, immediately after stamping the tag: when
`swarmGroup` is set, it **unconditionally forces `subgoalsAllowed: false` AND
`maxNestingDepth: 0`** on the new goal — overriding any
`subgoalsAllowed`/`maxNestingDepth` the caller also passed. Belt-and-braces:
either field alone is independently sufficient to make the enforcement point,
`checkCanSpawnChild` (`subgoal-nesting-limit.ts`), reject a spawn attempt from
that worker:

- `subgoalsAllowed: false` → `PARENT_SUBGOALS_DISABLED`.
- `maxNestingDepth: 0` → clamped to the system MIN (1) by `clampMaxDepth`, but
  since a goal's own `nestingDepth` is always ≥ 1, `currentDepth + 1 > 1`
  always holds — the effective-0 request still blocks every spawn attempt →
  `NESTING_DEPTH_EXCEEDED`.

**Correction to the parent design doc:** there is no goal-level
`assertCanSpawn` function. `OrchestrationCore.assertCanSpawn`
(`orchestration-core.ts`) is a *different* mechanism guarding session-level
delegate/team-child recursion (`team_delegate`/`team_spawn` verbs, stripped
from every child session's `allowedTools` unconditionally, regardless of any
swarm tag) — unrelated to goal subgoal spawning. `checkCanSpawnChild` is the
real enforcement point for a goal's `goal_spawn_child` capability, and is what
this wave pins.

Pinned in `tests/swarm-w0-structural-cap.test.ts`: both fields block
independently; a real swarm-tagged worker rejects a spawn attempt; a
non-swarm goal's `subgoalsAllowed`/`maxNestingDepth` are byte-identical to
today whether or not other fields are passed.

## 3. Suppressed auto-merge (design §5.1)

`GoalManager.mergeChild` is the **single choke point** every auto-merge caller
already funnels through (REST `integrate-child`, and both
`runSubgoalStep` merge paths in `verification-harness.ts`). At the top of
`mergeChild`, before any branch/worktree check or git operation: if
`child.swarmGroup` is set, return immediately with
`{ merged: false, alreadyMerged: false, conflict: false, skippedSwarmGroup: true }`
— **no git command runs at all**. The sibling's branch is a merge *candidate*
for the (not-yet-built) reconciler, never a disjoint auto-merge target.

All three call sites gained a new `if (outcome.skippedSwarmGroup)` branch,
added *after* their existing `if (outcome.merged || outcome.alreadyMerged)`
block (left completely unmodified) — they still tear down the team, archive
the goal record (a data-layer soft-delete; the git branch itself survives
teardown, since worktree removal drops the working copy, not the ref), and
fire `notifyChildTerminal(childId, "done")` so the barrier below sees the
event. A non-swarm child never reaches the new branch — pinned in
`tests/swarm-w0-merge-suppression.test.ts` by asserting it still throws
`GOAL_GIT_UNAVAILABLE` in the identical no-worktree fixture.

## 4. Terminal barrier + per-sibling artifact capture (design §5.2/§5.3)

Fired off the **existing** `notifyChildTerminal` seam
(`VerificationHarness.notifyChildTerminal`, called today from REST
`integrate-child` and the general goal-archive route in `server.ts`). Its
signature grew a `status: SwarmTerminalStatus = "done"` parameter
(`"done" | "failed" | "killed"`); both existing callers now pass it
explicitly — the archive route derives `"done"` when the goal reached
`state === "complete"` (or was just stamped so via `mergedManually`) and
`"killed"` otherwise (see the note below on the missing `failed` state).

When the terminating child carries `swarmGroup`, `notifyChildTerminal` now
also calls a private `_captureSwarmArtifactIfTagged`, which:

1. Resolves the child's `ProjectContext` and returns immediately if the child
   has no `swarmGroup` — **zero overhead for every non-swarm goal**.
2. Builds a `SwarmArtifact` — reusing `SessionManager.getSessionOutput`
   **verbatim** (no new transcript reader) for the distilled `output`, plus
   `branch`, a best-effort `commitSha` (new `getHeadCommitSha` helper in
   `skills/git.ts`, `git rev-parse HEAD` at the child's worktree — `undefined`
   if unresolvable), the passed-in terminal `status`, and a `verifierScore:
   null` placeholder (no reconciler/verifier exists yet).
3. Enumerates every goal sharing the same `swarmGroup` id via `goalStore`, and
   calls `SwarmGroupStore.recordArtifact(swarmGroup, artifact,
   expectedSiblingIds, rootGoalId)`.

### `SwarmGroupStore` (new — `src/server/agent/swarm-group-store.ts`)

One JSON file per project (`<stateDir>/swarm-groups.json`), one record per
`swarmGroup`, using the **same atomic-json discipline as `team-store.ts`**
(tmp-write → fsync → rename + `.bak.N` rotation) — a genuinely new artifact,
so it gets its own store rather than piggy-backing on `GoalStore` (which does
NOT use atomic-json; see §1). Wired into `ProjectContext` exactly like every
other per-project store (`this.swarmGroupStore = new SwarmGroupStore(this.stateDir)`).

```ts
interface SwarmArtifact {
  goalId: string; sessionId?: string; output: string;
  branch?: string; commitSha?: string;
  status: "done" | "failed" | "killed";
  verifierScore: null; capturedAt: number;
}
interface SwarmGroupRecord {
  swarmGroup: string; rootGoalId?: string;
  artifacts: SwarmArtifact[];
  barrierFired: boolean; allFailed: boolean; updatedAt: number;
}
```

`recordArtifact` is idempotent per `goalId` (a re-capture replaces, never
duplicates) and recomputes `barrierFired` (true once every id in
`expectedSiblingIds` has a captured artifact) and `allFailed` (true only when
the barrier has fired AND no artifact has `status === "done"`). Per the
design's critique fix: **an all-failed group is only ever flagged, never
silently resolved or synthesized** — no reconciler reads this flag yet; that
is SWARM-W1+'s job.

Pinned in `tests/swarm-group-store.test.ts` (round-trip, restart durability,
idempotent re-capture, partial vs. full barrier, `allFailed` semantics) and
`tests/swarm-w0-terminal-barrier.test.ts` (end-to-end through
`notifyChildTerminal`, including the zero-overhead-for-non-swarm pin).

### A known modeling gap: goals have no `failed` state

`PersistedGoal.state` is `"todo" | "in-progress" | "complete" | "shelved" |
"blocked"` — there is no `"failed"`. This wave maps any terminal archival of a
non-complete goal to `"killed"` (operator/system-initiated), not `"failed"`.
Introducing a genuine `failed` state (e.g. a swarm worker whose own
verification gate is exhausted) is left to SWARM-W1+, if/when a reconciler
needs to distinguish "this worker's approach didn't pass" from "this worker
was killed/abandoned."

## Deliberately NOT built this wave

- **No reconciler** (deterministic-verify / judge-quorum / synthesis-role) —
  nothing consumes `barrierFired`/`allFailed` yet.
- **No resource governor**, no per-node token/wall-clock enforcement, no
  hard-kill backstop (design §6).
- **No scheduler-invariant work** (design §7 — acquire-when-runnable, zero
  permits while blocked). Understood, not touched.
- **No UI** (governor strip, graph view).
- **No synthesizer, no classifier `propose` wiring.**
- **Tool-surface exclusion of `goal_spawn_child`** is NOT added: today a
  swarm worker's spawn attempt is rejected at the REST/harness enforcement
  point (`checkCanSpawnChild`), but the verb itself is not removed from what
  the agent's system prompt advertises (that gate is system-wide only, via
  `groupPolicyStore.getSubgoalsEnabled()`, not per-goal). Flagged as a
  possible SWARM-W1+ follow-up, not fixed here to keep this wave's diff
  minimal and scoped to the design's literal "assertCanSpawn rejects" bar.
- **Swarm-candidate branches are not pushed to origin** — a swarm sibling's
  branch survives locally (teardown removes the worktree, not the ref), but a
  worktree/branch GC pass could still reap it before a reconciler looks at it.
  Left as a Wave-1+ concern (design §13 "losing-branch / worktree GC").
