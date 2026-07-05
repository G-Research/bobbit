# SWARM-W4.6 — pre-code judgment note (orchestrator-worker `mergeChild` change)

Status: **judgment review, no code shipped.** This note exists because
`docs/design/swarm-orchestration-w4.md` §1.2.1 calls its own proposed
`reconcileMode` change "the highest-risk single change in this whole
document" and §6's staged-plan row for wave 4.6 says it "needs an
orchestrator FULL review before merge" and is scheduled "judgment lane,
mandatory" (`docs/design/swarm-orchestration-w4.md:545`). This document *is*
that review. It resolves the five open questions a 4.6 code lane would
otherwise have to improvise, grounded directly in the code as it exists
today (verified file:line below) — not just the design doc's prose. No file
under `src/` is touched by this PR.

## 0. What "today" actually is, verified

- `GoalManager.mergeChild` signature and the SWARM-W0/W1 suppression
  conditional: `src/server/agent/goal-manager.ts:824` (signature),
  `goal-manager.ts:860` — exact text:
  `if (child.swarmGroup && !opts?.forceIntegrateSwarmWinner) {`.
- The structural recursion cap is forced unconditionally on ANY
  `swarmGroup`-tagged goal at creation time, regardless of `reconcileMode`
  (which doesn't exist yet and, per §1 below, never needs to be consulted
  here): `goal-manager.ts:438-442`
  (`if (swarmGroup) { goal.swarmGroup = swarmGroup; goal.subgoalsAllowed =
  false; goal.maxNestingDepth = 0; }`).
- The cap's actual rejection enforcement is `checkCanSpawnChild`
  (`src/server/agent/subgoal-nesting-limit.ts:143-163`), consulted via
  `effectiveSubgoalsAllowed` (`subgoal-nesting-limit.ts:80-88`) — a goal with
  `subgoalsAllowed === false` can never spawn a child, full stop, regardless
  of system prefs.
- `mergeChild`'s three ordinary (non-swarm-winner) call sites, all confirmed
  by direct read:
  - `src/server/agent/nested-goal-routes.ts:1081` (`integrate-child` REST
    route), conflict branch at `nested-goal-routes.ts:1159-1170`.
  - `src/server/agent/verification-harness.ts:6622` (`runSubgoalStep`
    workflow-less-recovery path), `skippedSwarmGroup` branch at
    `verification-harness.ts:6628-6636` (no conflict branch here — a
    complete-but-unmerged child can't be in git conflict).
  - `verification-harness.ts:6934` (`runSubgoalStep` main merge path),
    `skippedSwarmGroup` branch at `verification-harness.ts:6959-6964`,
    conflict branch at `verification-harness.ts:6965-6977`.
  - All three conflict branches are structurally identical: set
    `mergeConflict: true` on the child, broadcast, return failure — **none of
    them calls `notifyChildTerminal`**, and the child is deliberately left
    un-archived "for manual recovery" (comment at
    `verification-harness.ts:6966-6968`).
- `SwarmGroupRecord` (`src/server/agent/swarm-group-store.ts:63-111`) has no
  `reconcileMode` field yet. `SwarmTerminalStatus` is `"done" | "failed" |
  "killed"` (`swarm-group-store.ts:30`) — `"failed"` already exists and is a
  legitimate barrier-converging terminal state today.
- `notifyChildTerminal` (`verification-harness.ts:6201-6212`) →
  `_captureSwarmArtifactIfTagged` (`verification-harness.ts:6221` on,
  no-op-if-untagged check at `verification-harness.ts:6225`:
  `if (!child?.swarmGroup) return;`) — gated purely on the `swarmGroup` tag
  being present, **never** on `reconcileMode`. Barrier convergence
  (`SwarmGroupStore.recordArtifact`, `swarm-group-store.ts:196-231`) fires
  once every id in the persisted `expectedSiblingIds` has *any* artifact,
  and `allFailed` is only true when **none** of the recorded artifacts is
  `"done"` (`swarm-group-store.ts:213`).
- The single-call-site pin for the escape hatch:
  `tests/swarm-w1-confirm-route-gate.test.ts:358-384` asserts the literal
  `forceIntegrateSwarmWinner: true` appears **exactly once** in `src/`, in
  `swarm-routes.ts`'s confirm handler. `tests/swarm-w0-merge-suppression
  .test.ts:54-91` and `tests/swarm-w1-merge-winner.test.ts:53-90` pin the
  suppression conditional's exact behavior with `new GoalManager(goalStore,
  wf)` — a bare 2-arg construction, no third dependency wired.

## 1. Recursion-cap interaction

**Question:** workers tagged `swarmGroup` for barrier/governor tracking
unconditionally inherit the W0 cap (`goal-manager.ts:438-442` checks only
`if (swarmGroup)`, nothing about `reconcileMode`). Should merge-all workers
get the cap suppressed, or get an explicit opt-out field?

**Analysis:** the cap is forced at `createGoal` time, purely off the
`swarmGroup` string being non-empty — `reconcileMode` lives on the
*group record* (`SwarmGroupRecord`, keyed by `swarmGroup` id), not on the
goal itself, so `createGoal` has no way to see it even if it wanted to; a
plumbing change to thread `reconcileMode` into `createGoal` would be a
second, independent change to the one function SWARM-W0 explicitly built as
belt-and-braces ("one missed field is the blast radius",
`goal-manager.ts:430`). More importantly: the master design's own scoping
for orchestrator-worker is a **single-level, non-recursive** decompose —
"an LLM is used only to decompose into disjoint sub-questions... never emit
arbitrary DAGs" (quoted verbatim at `docs/design/swarm-orchestration-w4.md:159`
and again at `:196-198`: "Never for a task with a single coherent solution
path"). A worker that could itself spawn a nested orchestrator-worker group
is exactly the unbounded-recursion shape SWARM-W0's cap exists to prevent,
and nothing in this design's mechanism (§1.2, §1.2.1) needs workers to
recurse — they are leaves by construction, precisely because decompose only
ever emits 3-5 flat shard specs, once, per group.

An opt-out field would also enlarge the choke point unnecessarily: it would
mean `mergeChild`'s conflict/suppression logic and `createGoal`'s cap logic
would BOTH need to consult `reconcileMode`, doubling the surface this
judgment review has to cover, for a capability (worker recursion) nothing
in §1.2/§1.2.1 asks for.

**RULING: no opt-out. Leave `goal-manager.ts:438-442` completely
unmodified — merge-all workers keep the unconditional
`subgoalsAllowed:false`/`maxNestingDepth:0` cap, identically to pick-best
siblings.** This needs zero new pins beyond a single explicit regression
test asserting a `swarmGroup`-tagged goal created with an (unimplemented,
future) `reconcileMode:"merge-all"`-flavored group still comes back with
`subgoalsAllowed === false` — i.e., extend
`tests/swarm-w0-structural-cap.test.ts` with one case that creates the goal
exactly as its existing cases do (the cap logic doesn't take a
`reconcileMode` argument at all, so this is really just re-confirming the
existing pin already covers the merge-all case by construction, not a new
code path).

## 2. Shard-conflict fallback

**Question:** decompose promises disjoint shards but can't guarantee them.
When worker B's auto-merge conflicts against already-merged worker A, what
happens? Options: (a) halt group + human gate, (b) skip B and surface,
(c) retry B rebased.

**Analysis, grounded in what the merge path already does today:** because
§1.2.1 deliberately routes merge-all workers through the **same, unmodified**
`mergeChild` non-swarm-suppressed path every ordinary nested subgoal already
uses, a shard conflict lands in one of the three existing conflict branches
verified in §0 above — and today, for an ordinary child, that branch already
implements almost exactly (a)/(b)'s intersection: it sets `mergeConflict:
true`, refuses to archive the child, and returns a hard failure —
`verification-harness.ts:6640` spells it out verbatim ("manual recovery
required"), `nested-goal-routes.ts:1159-1170` returns the equivalent as an
HTTP 409 with `{conflict: true}`. The one gap: **none of the three conflict
branches calls `notifyChildTerminal`.** For an ordinary (non-swarm) child
that's correct — there's no barrier to converge. For a merge-all worker it's
a real bug-in-waiting: the swarm group's `expectedSiblingIds` barrier
(`swarm-group-store.ts:196-231`) will never see B's id captured, so
`barrierFired` never flips true, and the synthesis role (§1.2 step 3) waits
forever with no visible signal of *why* — silent hang, not a surfaced
failure.

Evaluating the three options against what already exists:
- **(a) halt the whole group** (stop A/C/etc. too) needs a NEW mechanism —
  nothing today can reach into siblings still mid-flight and pause them
  short of a governor kill (`SwarmGovernor.hardKillSwarmNode`, reserved for
  budget/wall-clock/early-kill triggers per §1.3). Repurposing it for "a
  sibling merge-conflicted" conflates two different trigger classes and
  wastes tokens on shards that may have been about to land cleanly.
- **(c) retry B rebased against the new parent HEAD** needs new git
  plumbing beyond `mergeChildBranchLocal` (an automatic rebase + re-attempt
  loop), and is the riskiest option precisely *because* decompose "can't
  guarantee" disjointness: if the shards weren't actually disjoint, a blind
  auto-rebase can silently produce an order-dependent result (B's rebase
  outcome differs depending on exactly when it retries) with no human in
  the loop — worse than surfacing the conflict, and it invents a retry-loop
  termination question (how many rebases before giving up?) this design
  doesn't need to answer if it doesn't take this path.
- **(b) skip B, surface it, let the rest of the group converge** costs
  exactly one small, additive, swarm-gated change: in each of the three
  conflict branches, when `child.swarmGroup` is set, also call
  `notifyChildTerminal(childId, "failed")` — reusing the **already-existing**
  `"failed"` terminal status (`swarm-group-store.ts:30`), which the barrier
  already treats correctly (barrier fires once every expected id has *any*
  artifact; `allFailed` stays `false` as long as at least one other shard
  is `"done"`, `swarm-group-store.ts:213`). B itself stays un-archived with
  `mergeConflict: true`, exactly as today, for a human to resolve later; the
  synthesis role (already human-gated at accept-time per
  `docs/design/swarm-orchestration-w4.md:472`, "confirm the whole shard set
  + synthesis") is the natural place the gap surfaces — its summary must
  name the un-merged shard, and the human's synthesis-accept decision
  effectively becomes the "halt or accept partial" decision, without a new
  gate primitive.

**RULING: (b), skip-and-surface, via one narrowly-scoped addition — call
`notifyChildTerminal(childId, "failed")` inside each of the three existing
conflict branches, gated on `child.swarmGroup` being set (zero behavior
change for ordinary children, since the call is inside an `if (child
.swarmGroup)` guard those never satisfy).** New pins needed: (1) a test per
conflict branch proving a swarm-tagged child's conflict now calls
`notifyChildTerminal(id, "failed")` while a non-swarm child's conflict path
is provably unaffected (assert the mock/spy is NOT called in the non-swarm
case — mirrors the "zero-behavior-change" pin style of
`tests/swarm-w0-merge-suppression.test.ts:77-90`); (2) one barrier-level test
that a group with one `"done"` and one `"failed"` artifact has
`barrierFired: true` and `allFailed: false` (this may already be implicitly
covered by `swarm-group-store.ts`'s own unit tests — verify, don't assume,
before writing a duplicate).

## 3. Decompose contract

**Question:** specify the prompt template shape, the structured output
format (3-5 shard specs), and parser failure handling.

**Grounding:** there is no existing structured-output-schema mechanism in
this codebase to reuse — no `zod` dependency (`grep -n '"zod"'
package.json` → no hit), no `json_schema`/`response_format` convention used
anywhere in `src/server/agent/` (only `image-generation.ts` uses
schema-shaped output, for an unrelated API). The closest existing precedent
for "one cheap, single, tool-free LLM call producing text this code then
parses" is the plan-fan-in synthesis step's own framing one section up
(§1.1 step 2: "a synthesis step... produces ONE merged plan") — same shape,
different content. Decompose should be spawned the same way (`spawnRole`,
`src/server/agent/team-manager.ts:2060`, with a `promptProfile:
"narrow-worker"` role per wave 4.0's already-shipped wiring fix,
`docs/design/swarm-orchestration-w4.md:539`), not as a bespoke raw-completion
call.

**RULING — prompt template:** a single, fixed system/user prompt (no tool
access) instructing the model: "Decompose the following goal into 3 to 5
DISJOINT sub-question shards. Each shard must be independently completable
without needing another shard's output. Do not decompose if the task is not
genuinely parallel — in that case return exactly one shard covering the
whole task. Respond with ONLY a fenced ` ```json ` code block containing an
array of 1-5 objects, no prose before or after." Each shard object:
```json
{ "title": "short imperative title, becomes the child goal's title",
  "spec": "the full sub-question / instructions for this shard's worker",
  "rationale": "one sentence: why this shard is disjoint from the others" }
```
`rationale` is included specifically so a human reviewing the decompose
output at the pre-spawn gate (mirroring plan-fan-in's new pre-build gate,
§4 row 3 of the W4 doc) has the model's own disjointness claim to check
against — since decompose "can't guarantee" disjointness (§1.2 preamble),
the contract should make the model state its assumption rather than hide
it.

**RULING — parser failure handling:** parse with a hand-rolled extractor
(fenced-block regex → `JSON.parse` → shape-check: array, length 1-5, every
element has non-empty string `title`/`spec`/`rationale`, no extra/missing
keys). **Any parse failure — malformed JSON, wrong shape, 0 or >5 shards,
no fenced block at all — aborts before any shard goal is created.** No
partial spawn under any circumstance: the decompose call and the shard-array
validation both happen strictly before the first `createGoal` call for any
worker, so there is no rollback question (nothing was created yet to roll
back). This is a hard requirement, not a preference — a partially-spawned
group would have some children counted in `expectedSiblingIds` and others
not, corrupting the barrier's authoritative-expected-set invariant that
SWARM-W1 explicitly hardened against exactly this class of bug
(`swarm-group-store.ts:79-90`, "the expected-sibling set must be persisted
at group creation... before any sibling can go terminal"). On abort: return
a plain step failure (mirrors every other `runSubgoalStep` failure path
verified in §0 — `{ passed: false, output: "..." }`), no swarm group
created at all (i.e. `SwarmGroupStore.createGroup` must be called strictly
**after** decompose succeeds and shards validate, never before).

## 4. The `reconcileMode` conditional at `mergeChild` — exact diff

**RULING — the diff.** Add the field to `SwarmGroupRecord`
(`swarm-group-store.ts`, alongside the other optional fields around line
92):

```ts
/** SWARM-W4.6: "pick-best" (default, absent = today's behavior byte-for-
 *  byte) suppresses auto-merge for every swarmGroup child (SWARM-W0/W1).
 *  "merge-all" lets swarmGroup children merge exactly like ordinary
 *  non-swarm subgoals, live, as each completes — see mergeChild. */
reconcileMode?: "pick-best" | "merge-all";
```

Add one field + one setter to `GoalManager`
(`goal-manager.ts`, alongside the other `setXResolver` methods, e.g. near
`setBaseRefResolver` at `goal-manager.ts:149-151`) — a setter, not a
constructor parameter, so every existing 2-arg/3-arg `new GoalManager(...)`
call site (both production, `project-context.ts:124`, and every test
constructor verified in §0) needs zero changes:

```ts
private swarmGroupStore?: SwarmGroupStore; // type-only import, no cycle: swarm-group-store.ts imports nothing from goal-manager.ts
setSwarmGroupStore(store: SwarmGroupStore): void {
	this.swarmGroupStore = store;
}
```

Wire it once, in `project-context.ts`, right after `this.goalManager = new
GoalManager(this.goalStore, this.workflowStore)` (`project-context.ts:124`)
— `this.swarmGroupStore` already exists by then, constructed at
`project-context.ts:104`, twenty lines earlier:

```ts
this.goalManager.setSwarmGroupStore(this.swarmGroupStore);
```

And the choke-point conditional itself — **one line changed**, at
`goal-manager.ts:860`:

```diff
- if (child.swarmGroup && !opts?.forceIntegrateSwarmWinner) {
+ if (child.swarmGroup && !opts?.forceIntegrateSwarmWinner
+     && this.swarmGroupStore?.get(child.swarmGroup)?.reconcileMode !== "merge-all") {
```

No change to `mergeChild`'s signature, no new `opts` field — matches the
design doc's own "no new call site, no new escape-hatch flag" constraint
(`docs/design/swarm-orchestration-w4.md:218`) exactly, and keeps the
single-call-site pin for `forceIntegrateSwarmWinner: true`
(`tests/swarm-w1-confirm-route-gate.test.ts:358-384`) completely untouched
— this diff never touches that literal.

**Byte-identical-when-absent pins needed, mirroring the W0/W1 pins exactly:**

1. **Unset store ⇒ unchanged** (mirrors `swarm-w1-merge-winner.test.ts:54-60`):
   a `GoalManager` constructed the old way (`new GoalManager(goalStore, wf)`,
   `setSwarmGroupStore` never called) still returns `skippedSwarmGroup: true`
   for any `swarmGroup` child — `this.swarmGroupStore` stays `undefined`, and
   `undefined?.get(...)` short-circuits to `undefined !== "merge-all"` →
   `true` → suppression still fires. **No existing test file needs editing**
   to prove this — `swarm-w0-merge-suppression.test.ts` and
   `swarm-w1-merge-winner.test.ts` both already construct `GoalManager` this
   way and must keep passing completely unmodified; a broken diff here is a
   docs-only regression: don't fix the test, fix the code (per AGENTS.md).
2. **Store wired, no group record ⇒ unchanged**: `setSwarmGroupStore` called,
   but `swarmGroupStore.get(swarmGroup)` returns `undefined` (group never
   created via `createGroup`) — same short-circuit, suppression still fires.
   New test, mirrors `swarm-w0-merge-suppression.test.ts:55-75`'s shape.
3. **Store wired, record exists, `reconcileMode` absent or `"pick-best"` ⇒
   unchanged**: explicit `"pick-best"` and an all-fields-but-`reconcileMode`
   record both suppress, identically to today. New test.
4. **Store wired, record exists, `reconcileMode: "merge-all"` ⇒ bypasses
   suppression, reaches the real merge path** — same proof technique as
   `swarm-w1-merge-winner.test.ts:70-79` (`GOAL_GIT_UNAVAILABLE` in a no-git
   fixture proves the git path was reached). New test.
5. **Recursion-cap independence**: a `swarmGroup` child created under a
   `"merge-all"` group still has `subgoalsAllowed === false` /
   `maxNestingDepth === 0` (§1's ruling) — extend
   `tests/swarm-w0-structural-cap.test.ts` per §1.
6. **Source pin, mirroring `tests/swarm-w1-confirm-route-gate.test.ts:358-384`**:
   the literal `reconcileMode` is read in exactly one place in
   `goal-manager.ts` (the `mergeChild` conditional) — prevents a second,
   competing check being added elsewhere later without this review process
   catching it.

## 5. Sequencing — ownership and the merge-time review bar

**What must be claimed/announced.** Per §6's own staged-plan note for 4.2
("must be sequenced with the CLF-advancement lane to avoid two lanes
editing `DECISION_POINTS` concurrently", `docs/design/swarm-orchestration
-w4.md:541`), the same discipline applies here, more strictly: **one single
PR must own the entire 4.6 diff** — `swarm-group-store.ts`'s new field,
`goal-manager.ts`'s new setter + the one-line conditional, `project-context
.ts`'s wiring call, and the three conflict-branch `notifyChildTerminal`
additions (§2) — because all of it funnels through the one choke point
`mergeChild` that three independent existing call sites depend on
(`nested-goal-routes.ts:1081`, `verification-harness.ts:6622`,
`verification-harness.ts:6934`). Before this PR opens: grep-announce intent
to touch `goal-manager.ts` (specifically the `mergeChild` function) and
`project-context.ts`'s `GoalManager` construction line, the same way 4.2
was flagged as a collision risk — no other in-flight lane should be editing
either in parallel.

**The full-review bar at merge time.** Not a codex-lane review. Required,
in order:
1. Every pin in §4's list is new and green, AND every existing swarm pinning
   test (`swarm-w0-merge-suppression.test.ts`, `swarm-w0-structural-cap
   .test.ts`, `swarm-w1-merge-winner.test.ts`,
   `swarm-w1-confirm-route-gate.test.ts`) passes **with zero lines of those
   files changed** — a diff to any of those four files is itself a review
   failure per AGENTS.md ("if you break a pinning test, fix the bug, not the
   test"), not something to reconcile by editing expectations.
2. A human (not the implementing lane) re-derives the `goal-manager.ts:860`
   diff from this note's §4 independently and confirms it matches
   byte-for-byte before approving — this is the one line every other
   caller's correctness depends on, and the smallest possible diff is the
   entire point of §1.2.1's design.
3. Confirm §2's `notifyChildTerminal` additions are gated on `child
   .swarmGroup` in all three call sites (not just one) — a partial rollout
   across the three conflict branches would silently reintroduce the
   barrier-hang bug in whichever branch is missed.
4. Only after 1-3 pass does this PR merge — it is explicitly sequenced
   *after* 4.0 (per §6's own dependency row) and should be the **last**
   change to land in this wave, never run in parallel with another
   `goal-manager.ts`-touching lane.

## Cross-reference

- `docs/design/swarm-orchestration-w4.md` §6 staged-plan row for 4.6: this
  note is the judgment review that row requires before any code lane opens
  — see the row's own text, "needs an orchestrator FULL review before
  merge, mirroring how SWARM-W0/W1 themselves treated that function"
  (`docs/design/swarm-orchestration-w4.md:545`).
