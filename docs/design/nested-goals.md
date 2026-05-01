> **Historical design document.**  
> This is the pre-implementation design that the nested-goals work was planned against. It is intentionally preserved for context but is **not the live reference**. For current behaviour, API surface, and worked examples see [`docs/nested-goals.md`](../nested-goals.md). Specifics here may have drifted during implementation; cross-check against the user-facing doc when in doubt.

# Nested goals & DAG subgoals — design doc

> **Status:** Approved-by-spec, awaiting implementation.
> **Replaces:** PR #387 (Mission entity). PR #387 stays open as a reference; no cherry-pick.
> **Goal branch:** fresh from `origin/master`.

This document is the executable blueprint for the **Nested goals & DAG subgoals**
goal. It turns the locked spec into concrete file paths, function signatures,
YAML, REST contracts, and per-phase task breakdowns. The 13 architectural
decisions in the goal spec are taken as given — this doc does not relitigate
them.

Index:

1. [Data model](#1-data-model)
2. [`VerifyStep` extension — `subgoal` type](#2-verifystep-extension--subgoal-type)
3. [Branching & merging](#3-branching--merging)
4. [Mutation classifier (`plan-mutation.ts`)](#4-mutation-classifier-plan-mutationts)
5. [Tools — new `Children` group](#5-tools--new-children-group)
6. [`parent.yaml` workflow](#6-parentyaml-workflow)
7. [Custom workflows + roles resolution](#7-custom-workflows--roles-resolution)
8. [REST API additions](#8-rest-api-additions)
9. [WebSocket events](#9-websocket-events)
10. [UI changes](#10-ui-changes)
11. [bobbit-e2e-tests scaffolding](#11-bobbit-e2e-tests-scaffolding)
12. [Per-phase task breakdown](#12-per-phase-task-breakdown)
13. [Risks & open questions](#13-risks--open-questions)

---

## 1. Data model

### 1.1 `PersistedGoal` field additions

Append the following fields to `PersistedGoal` in
[`src/server/agent/goal-store.ts`](../../src/server/agent/goal-store.ts).
**No existing field is renamed or removed.** All new fields are optional —
the store loader applies lazy defaults on read (see §1.4).

```ts
export interface PersistedGoal {
  // ── existing fields unchanged ─────────────────────────────

  // ── nested-goals additions ────────────────────────────────

  /**
   * Parent goal id when this goal is a child of another goal.
   * Undefined for top-level goals (`rootGoalId === id`).
   * Cycles are rejected at creation time by GoalManager.createGoal.
   */
  parentGoalId?: string;

  /**
   * Top-of-tree goal id. Always populated (== id for top-level goals).
   * Cached for fast queries: "find all goals in the tree rooted at X".
   */
  rootGoalId?: string;

  /**
   * Where this goal's branch merges back to.
   * - `"master"` (default for top-level goals) — top-level `ready-to-merge`
   *   raises a PR to the primary branch.
   * - `"parent"` (default for child goals) — `ready-to-merge` triggers a
   *   local merge into the parent's branch via `goal_merge_child`. No PR.
   * Auto-derived from parentGoalId at creation time and not edited
   * afterwards (would imply re-parenting which is out of scope).
   */
  mergeTarget?: "master" | "parent";

  /**
   * Per-goal divergence policy controlling auto-approval of plan mutations.
   * Inherited from parent if unset. Default at root: "strict".
   */
  divergencePolicy?: "strict" | "balanced" | "autonomous";

  /**
   * Maximum number of child goals from this goal that may run in parallel.
   * Inherited from parent if unset. Default 3, hard max 8.
   * Enforced by the verification harness when running phase-parallel
   * `subgoal` verify steps (see §2.4).
   */
  maxConcurrentChildren?: number;

  /**
   * Inline workflow snapshotted on this goal at creation. Overrides
   * workflowId resolution. Used when the user pastes a custom workflow
   * YAML in the New Goal dialog. Resolves before walking the parentGoalId
   * chain (see §7).
   */
  inlineWorkflow?: Workflow;

  /**
   * Inline role definitions snapshotted on this goal. Map keyed by role
   * name (e.g. "coder", "qa-tester"). Scoped to this goal-tree — children
   * can override by defining the same key, otherwise inherit via the
   * walk-up resolver in §7.
   */
  inlineRoles?: Record<string, Role>;

  /**
   * Acceptance criteria parsed from the goal spec markdown (§1.3).
   * Used by the mutation classifier (§4) to detect criteria-drop
   * violations that no policy may override.
   */
  acceptanceCriteria?: string[];

  /**
   * Number of post-freeze plan mutations applied to this goal.
   * Bumped on every successful goal_plan_propose / goal_spawn_child
   * after the goal-plan gate has been signalled. When > 5 the goal
   * auto-pauses for human review (§4.3).
   */
  replanCount?: number;

  /**
   * Whether this goal is paused. While paused, the verification harness
   * skips verify-step ticks for any signal whose goal is paused, and
   * goal_spawn_child / goal_plan_propose under "strict" policy require
   * paused === true to apply restructure mutations.
   */
  paused?: boolean;
}
```

**TypeScript imports.** `Role` lives in
[`src/server/agent/role-store.ts`](../../src/server/agent/role-store.ts);
`Workflow` already imported from `./workflow-store.js`.

### 1.2 `GoalStore` secondary indexes

`GoalStore` currently keys goals by id only (the `goals: Map<string, PersistedGoal>`
field). Add two in-memory indexes, populated lazily on every `load()` and
maintained in `put()` / `update()` / `archive()` / `remove()`:

```ts
class GoalStore {
  // existing
  private goals: Map<string, PersistedGoal> = new Map();

  // additions
  private childrenByParent = new Map<string, Set<string>>(); // parentId → Set<childId>
  private byRoot = new Map<string, Set<string>>();           // rootId   → Set<descendantId> (incl. root itself)

  // ── new public API ────────────────────────────────────────

  /** All immediate children of `parentId`, sorted by createdAt ASC. */
  getChildren(parentId: string): PersistedGoal[];

  /** All descendants (transitive) of `rootId`, including the root itself. */
  getDescendants(rootId: string): PersistedGoal[];

  /** Walk parentGoalId chain from goalId, returning ancestors root-first. */
  getAncestors(goalId: string): PersistedGoal[];

  /** True if `descendantId` is in the subtree of `ancestorId`. O(depth). */
  isDescendantOf(descendantId: string, ancestorId: string): boolean;
}
```

Index maintenance is centralised in three private helpers:

```ts
private indexInsert(g: PersistedGoal): void;   // called at end of put()
private indexRemove(g: PersistedGoal): void;   // called at end of remove()
private indexUpdate(prev: PersistedGoal | undefined, next: PersistedGoal): void;
```

Index rebuilds happen on `load()` after the JSON parse, before any consumer
sees the store. **Archived goals stay in the indexes** (the live/archived
filter is applied at read time, same as today).

### 1.3 Acceptance-criteria parsing

`acceptanceCriteria` is a derived field. **Goal-manager parses it once at goal
creation** and again whenever the goal's `spec` is updated, then writes the
result back via `update()`. The parser lives in a new helper
`src/server/agent/acceptance-criteria.ts`:

```ts
/**
 * Parse the `## Acceptance criteria` (or `## Acceptance Criteria`) section of
 * a goal spec into a flat list of criterion strings.
 *
 * Recognised section header (case-insensitive, optional trailing colon):
 *   ^##\s+Acceptance criteria:?\s*$
 *
 * Within the section, each list item (`- `, `* `, `1. `, `1) `) becomes one
 * criterion. Sub-bullets are flattened by joining their text into the parent
 * with `\n  ` separators so the substring-match check (§4.2) still works.
 * Numbered lists are flattened the same way.
 *
 * Non-list lines inside the section (paragraphs, headings) are ignored.
 *
 * Returns [] if the section header is missing.
 */
export function parseAcceptanceCriteria(spec: string): string[];
```

Trim/normalise rules:
- Strip leading list-marker (`- `, `* `, `\d+\.\s+`).
- Trim outer whitespace.
- Replace runs of internal whitespace with single spaces.
- Empty results dropped.

### 1.4 Migration story (zero schema break)

`GoalStore.load()` already tolerates partial records (see existing migrations
for `swarm → team`, `skipArtifactRequirements → skipGateRequirements`). Add
**lazy defaults** in the same loop, applied on read:

```ts
// In GoalStore.load() inside the for-loop:
if (g.parentGoalId === undefined) {
  // top-level goal — rootGoalId == id
  if (!g.rootGoalId) g.rootGoalId = g.id;
  if (!g.mergeTarget) g.mergeTarget = "master";
}
// children inherit divergencePolicy / maxConcurrentChildren from parent;
// don't materialise the inheritance to disk — readers must call the
// inheritance walk in §1.5.
```

Existing single goals load with `parentGoalId === undefined`, `rootGoalId === id`,
`mergeTarget === "master"`, no policy fields. Behaviour is exactly as today.

### 1.5 Inheritance walk for `divergencePolicy`; root-only `maxConcurrentChildren`

`GoalManager` exposes two read-only resolvers used everywhere the
relevant per-goal field is consulted (mutation classifier, harness phase
scheduling, UI rendering):

```ts
class GoalManager {
  /**
   * Resolve effective divergence policy by walking up parentGoalId chain.
   * If no ancestor specifies one, returns "strict".
   */
  resolveDivergencePolicy(goalId: string): "strict" | "balanced" | "autonomous";

  /**
   * Resolve the **root** goal's concurrency cap for a given goal-tree.
   *
   * Only the root of the tree (parentGoalId == null) carries an effective
   * `maxConcurrentChildren`. Sub-goal values for `maxConcurrentChildren`
   * are accepted on disk for forward compatibility but are **inert** in
   * v1 — the harness honours one cap per tree. Default 3, clamped to
   * [1, 8].
   *
   * Walks `rootGoalId` to fetch the root, then reads its
   * `maxConcurrentChildren`. Does **not** walk the parent chain.
   */
  resolveRootMaxConcurrentChildren(rootGoalId: string): number;
}
```

These are the **only** sanctioned readers. UI and tools must never read the
raw fields directly — always go through the manager so the root-only
semantics apply uniformly. (Rationale: the spec calls out
`maxConcurrentChildren` as a **per-goal** field "inheriting from parent if
unset" — in v1 that inheritance collapses to "the root wins". The
alternative — a per-parent semaphore key `(rootGoalId, parentGoalId)` —
would let mid-tree caps shape parallelism, but adds bookkeeping for a
case nobody asked for. v2 may revisit if real plans surface the need.)

---

## 2. `VerifyStep` extension — `subgoal` type

### 2.1 Schema additions

Extend `VerifyStep` in
[`src/server/agent/workflow-store.ts`](../../src/server/agent/workflow-store.ts):

```ts
export interface VerifyStep {
  // existing fields unchanged
  name: string;
  type: "command" | "llm-review" | "agent-qa" | "subgoal";  // ← add "subgoal"
  run?: string;
  prompt?: string;
  expect?: "success" | "failure";
  timeout?: number;
  phase?: number;
  optional?: boolean;
  label?: string;
  role?: string;
  description?: string;
  component?: string;
  command?: string;

  // ── nested-goals addition ─────────────────────────────────

  /**
   * Subgoal step parameters. Required when `type === "subgoal"`. Populated
   * on disk in the goal's snapshotted workflow under `gate.verify[]`.
   */
  subgoal?: SubgoalStepParams;
}

export interface SubgoalStepParams {
  /** Title for the spawned child goal (max 200 chars). */
  title: string;

  /** Markdown spec for the child goal. */
  spec: string;

  /**
   * Workflow id to spawn the child against. Resolved through the cascade
   * (§7). Default "feature".
   */
  workflowId?: string;

  /** Optional inline workflow override for the child. Snapshotted onto the
   *  child goal as `inlineWorkflow`. */
  inlineWorkflow?: Workflow;

  /** Optional suggested role label, surfaced in the dashboard. */
  suggestedRole?: string;

  /** Optional list of optional-step names to enable on the child. */
  enabledOptionalSteps?: string[];

  /**
   * Stable plan-node id, used for idempotent re-spawn. Generated by
   * goal_plan_propose. Stays stable across replans even if the step's
   * other fields change.
   */
  planId: string;
}
```

### 2.2 Normalisation/serialisation

`workflow-store.ts::normalizeStep` and `serializeStep` need three additions:

- `normalizeStep`: when `r.type === "subgoal"`, copy `r.subgoal` (object)
  into the returned step. Validate at runtime that `subgoal.planId` and
  `subgoal.title` are non-empty strings; on failure, log and skip the step.
- `serializeStep`: emit the `subgoal` field when present.
- The seeded-workflow type
  [`SeededVerifyStep`](../../src/server/state-migration/seed-default-workflows.ts)
  also adds `"subgoal"` to its `type` union and a `subgoal?: SubgoalStepParams`
  field — required for `parent.yaml` (§6) which is built via that helper.

### 2.3 Verification-harness integration

In [`src/server/agent/verification-harness.ts`](../../src/server/agent/verification-harness.ts),
the per-step branch ladder lives inside `verifyGateSignal()` around the
`if (step.type === "command") { … } else if (step.type === "agent-qa") { … } else { /* llm-review */ }`
block (currently at ~line 1330). Add a new branch:

```ts
} else if (step.type === "subgoal") {
  await this.subgoalSemaphore.acquire(); // see §2.4 — keyed by parent goal
  try {
    result = await this.runSubgoalStep(step, signal, builtinVars);
  } finally {
    this.subgoalSemaphore.release();
  }
}
```

`runSubgoalStep` is a new private method on `VerificationHarness`:

```ts
/**
 * Spawn (or reuse) a child goal for a subgoal verify step, then wait until
 * its `ready-to-merge` gate passes AND the local merge into the parent
 * branch succeeds. On any failure (child failed, merge conflict, timeout)
 * returns passed=false with diagnostic output.
 *
 * Idempotent on (signal.goalId, step.subgoal.planId): the spawned childGoalId
 * is recorded on the GateSignal's verification step (see §2.5).
 */
private async runSubgoalStep(
  step: VerifyStep,
  signal: GateSignal,
  builtinVars: Record<string, string>,
): Promise<{ passed: boolean; output: string; childGoalId?: string }>;
```

Internally:

1. **Idempotency check.** Look up the active verification record (§2.5)
   for this `(signalId, stepIndex)`. If `childGoalId` already set, skip
   spawn and rebind to the existing child. If the child is `complete` and
   `mergeTarget==="parent"`, attempt local merge again (idempotent — `git
   merge` against an already-merged branch is a no-op).
2. **Spawn.** Call `goalManager.createGoal(title, parent.cwd, {
   spec, workflowId, parentGoalId: signal.goalId, baseBranch: parent.branch,
   inlineWorkflow, projectId: parent.projectId, divergencePolicy:
   inheritFromParent, maxConcurrentChildren: inheritFromParent,
   enabledOptionalSteps })`. Persist `childGoalId` back onto the active
   verification record (and ultimately into the `GateSignal.verification.steps[i]`
   so it survives restart).
3. **Auto-start team.** Call `teamManager.startTeam(childGoalId)` — children
   always auto-start; the spec assumes the user explicitly approved the plan
   so each child gates itself through its own workflow.
4. **Wait loop.** Poll the child goal's `ready-to-merge` gate every 2s
   (cheap — already in-memory). Abort early if the parent verification is
   `cancelled` (cascade-cancel: terminate the child team and archive the
   child).
5. **Merge.** When child's `ready-to-merge` passes, call
   `goalManager.mergeChild(parentGoalId, childGoalId)` (§3.3). On success,
   step passes. On conflict, step fails with the diagnostic output and a
   structured `mergeConflict: true` flag in the artifact.

### 2.4 Phase-parallelism + concurrency cap

Phase-parallelism is already handled by `verifyGateSignal` (the existing
`Promise.all(phaseSteps.map(...))` block at ~line 1268). To enforce
`maxConcurrentChildren`, add a **per-goal-tree semaphore** keyed by
`rootGoalId`:

```ts
class VerificationHarness {
  // existing semaphores
  private commandSemaphore = new Semaphore(4);
  private reviewSemaphore  = new Semaphore(6);

  // ── addition ──────────────────────────────────────────────
  /** Keyed by rootGoalId. Created lazily; size = goal.maxConcurrentChildren. */
  private subgoalSemaphores = new Map<string, Semaphore>();

  private getSubgoalSemaphore(rootGoalId: string, cap: number): Semaphore {
    const existing = this.subgoalSemaphores.get(rootGoalId);
    if (existing && existing.capacity === cap) return existing;
    const sem = new Semaphore(cap);
    this.subgoalSemaphores.set(rootGoalId, sem);
    return sem;
  }
}
```

`Semaphore` lives in
[`src/server/agent/semaphore.ts`](../../src/server/agent/semaphore.ts) and
already exposes `available` / `acquire()` / `release()`. Add a `capacity`
getter returning the constructor argument.

The harness step branch resolves the cap via
`goalManager.resolveRootMaxConcurrentChildren(parent.rootGoalId!)` (§1.5)
and acquires before spawning. **The semaphore key is `rootGoalId`** —
exactly one cap per goal-tree, which matches §1.5's root-only semantics.
A sub-goal that sets `maxConcurrentChildren` does not get its own
semaphore in v1; its value is silently ignored by the harness. Document
that behaviour in the field's JSDoc on `PersistedGoal`.

**Important:** the semaphore must wrap **the wait loop**, not just the
spawn — concurrency is bounded by *running children*, not by *spawn
rate*.

### 2.5 Idempotency record

`GateSignalStep` in
[`src/server/agent/gate-store.ts`](../../src/server/agent/gate-store.ts)
gains a `subgoal` field:

```ts
export interface GateSignalStep {
  // existing fields unchanged
  name: string;
  type: "command" | "llm-review" | "agent-qa" | "subgoal";  // ← add
  passed: boolean;
  skipped?: boolean;
  output: string;
  duration_ms: number;
  expect?: "success" | "failure";
  artifact?: { content: string; contentType: string; metadata?: Record<string, string>; };

  // ── nested-goals addition ─────────────────────────────────
  /** When type === "subgoal": child goal id and planId for idempotency. */
  subgoal?: {
    planId: string;
    childGoalId: string;
    childMergedAt?: number;
    childMergeConflict?: boolean;
  };
}
```

`ActiveVerification` in `verification-harness.ts` gains a parallel
`subgoal?: { planId; childGoalId; }` shape on its step entries so the same
data is visible during in-flight verifications and survives `_persistActive()`
through to `resumeInterruptedVerifications()`.

---

## 3. Branching & merging

### 3.0 Subgoal worktree / branch topology — invariant

This subsection states the topology unambiguously. The rules below are
non-negotiable invariants that the implementation in §§3.1–3.4 enforces;
any divergence is a bug.

1. **Each subgoal gets its own git worktree.** Sandboxed and host-side
   alike. There is no shared-worktree mode.
2. **A subgoal's branch is created off the parent goal's branch HEAD at
   spawn time** — *not* off `origin/master` and *not* off the root's
   branch. `createWorktree(..., { startPoint: parent.branch })` (§3.1).
   For a top-level goal, the start point is `origin/<primary>` as today.
3. **A subgoal's `ready-to-merge` gate triggers a local merge into the
   parent's branch** (§3.3). No remote PR is raised for children. No
   push to `master` from a child.
4. **This is recursive.** A grandchild branches from its child-parent's
   branch HEAD and merges back into it on `ready-to-merge`. The child
   then merges into its own parent. Etc., up the tree.
5. **Only the root goal (`parentGoalId == null`) raises a PR to
   `master`.** This is the one and only PR for the whole tree, raised
   by the root's `ready-to-merge` gate as today.
6. **Sibling subgoals branch off the parent's tip at the moment they
   spawn.** Once any sibling merges into the parent, subsequently-spawned
   siblings naturally branch from the advanced tip — they observe the
   already-merged sibling's commits. (The verification harness re-reads
   `parent.branch` HEAD on each `runSubgoalStep` invocation; the worktree
   pool is bypassed for child goals — see §3.1.)

ASCII topology diagram (also reproduced in `docs/nested-goals.md` so
end-users see it without opening the design doc):

```
master ─────────●─────────────────────────────────●─────►
                 \                                /
                  ●─ goal/root ────●─────●───────●─ (PR: root → master)
                                    \    \     /
                                     \    \   / local merge into goal/root
                                      \    \ /
                                       ●────●─ goal/v0-1 (child of root)
                                        \
                                         \ local merge into goal/v0-1
                                          \
                                           ●─ goal/sim-1 (grandchild)
```

Reading the diagram:
- `master` carries one merge commit when the root's PR lands.
- `goal/root` is the root goal's branch. It branches off `master` and
  is the only branch that pushes a PR back to `master`.
- `goal/v0-1` (a child) branches off `goal/root` and merges back into
  `goal/root` locally on its own `ready-to-merge`.
- `goal/sim-1` (a grandchild) branches off `goal/v0-1` and merges back
  into `goal/v0-1` locally on its own `ready-to-merge`. The child then
  later merges its (now-advanced) tip into `goal/root`.

The **only** branch that ever talks to `origin/master` is the root.

### 3.1 baseBranch in createGoal

In
[`src/server/agent/goal-manager.ts`](../../src/server/agent/goal-manager.ts)
the worktree creation path passes a `baseBranch`/`startPoint` to
[`createWorktree(repoPath, branch, { startPoint })`](../../src/server/skills/git.ts)
at line 175. **Today `createGoal` does not pass `startPoint`** — worktrees
default to the remote primary branch. We add an opt-in:

```ts
async createGoal(title: string, cwd: string, opts?: {
  spec?: string;
  workflowId?: string;
  workflowStore?: WorkflowStore;
  resolvedWorkflow?: Workflow;
  sandboxed?: boolean;
  enabledOptionalSteps?: string[];
  projectId?: string;

  // ── nested-goals additions ────────────────────────────────
  parentGoalId?: string;        // parent in the goal tree
  inlineWorkflow?: Workflow;
  inlineRoles?: Record<string, Role>;
  divergencePolicy?: "strict" | "balanced" | "autonomous";
  maxConcurrentChildren?: number;
  /** Override base branch for the worktree (defaults to remote primary
   *  for top-level goals; to parent.branch for child goals). */
  baseBranch?: string;
}): Promise<PersistedGoal>;
```

Logic additions, in order:

1. **Resolve parent.** When `parentGoalId` set, look up the parent goal.
   Reject with `Error("Parent goal not found")` on miss. Reject if
   `parent.archived` is true.
2. **Cycle check.** Walk the parent's `parentGoalId` chain — if any
   ancestor's id matches the to-be-created id (which is fresh — so this is
   only a defensive read), or any ancestor's `parentGoalId` resolves to a
   missing record, fail loudly. Cycles are mathematically impossible at
   creation since the new id has no children yet, but defend against
   corrupt state.
3. **Single-project tree (Decision #12).** Reject if `projectId` differs
   from `parent.projectId`.
4. **Root + merge-target derivation.**
   ```ts
   goal.parentGoalId = opts.parentGoalId;
   goal.rootGoalId   = parent.rootGoalId ?? parent.id; // top-level parent's root == itself
   goal.mergeTarget  = "parent";
   ```
   For top-level: `rootGoalId = goal.id`, `mergeTarget = "master"`.
5. **Base branch.** Default to `parent.branch` for children; allow override
   via `opts.baseBranch`. Pass through to `createWorktree(..., { startPoint })`
   in `_doSetupWorktree()` (currently called without `startPoint`). The
   pool-claim path already creates branches from primary — for children we
   must **bypass the pool** because pool worktrees branch from primary, not
   from the parent. Add a guard:
   ```ts
   if (goal.parentGoalId) {
     // Children always create fresh worktrees off parent.branch.
     // Pool claims branch off primary and would lose parent's commits.
   } else {
     // Existing pool-first path.
   }
   ```
6. **Acceptance-criteria parse.** Call `parseAcceptanceCriteria(spec)` (§1.3)
   and store on `goal.acceptanceCriteria`.

**Schema additions touched in this task.** `PersistedGoal` (§1.1) is the
big one. In addition, Phase 3 task 3.4 (parent.yaml) extends
`WorkflowGate` with one new optional field:

```ts
interface WorkflowGate {
  // existing fields unchanged — `manual?: boolean` stays as-is
  /** Self-documenting prose rendered in the dashboard's gate detail
   *  panel (§14.4). Optional; null/undefined renders no extra prose. */
  description?: string;
}
```

The `manual?: boolean` field is **pre-existing**; we reuse it for the
`goal-plan` gate. No other `WorkflowGate` changes are required.

### 3.2 `mergeTarget` propagation in verification baselines

[`src/server/agent/verification-logic.ts`](../../src/server/agent/verification-logic.ts)::`substituteVars`
expands `{{master}}` from `builtinVars.master`. Today this is computed by
`verifyGateSignal()` via `detectPrimaryBranch(cwd)`. For child goals we want:

- Reviewer prompts and command steps that diff against "the goal's merge
  base" — for a child that's `parent.branch`, for a top-level it's
  `origin/<primary>`.

Two new template variables:

| Variable | Top-level | Child |
|---|---|---|
| `{{master}}` | `origin/<primary>` (existing) | `origin/<primary>` (unchanged — for "what's on the trunk") |
| `{{rootGoalBranch}}` | same as `{{branch}}` | `origin/<root.branch>` |
| `{{mergeBase}}` | `origin/<primary>` | `origin/<parent.branch>` |

Implementation: `verifyGateSignal()` extends `builtinVars` with both
fields. Source data come from the goal record:

```ts
const goal = pcm.getContextForGoal(signal.goalId)?.goalStore.get(signal.goalId);
const isChild = !!goal?.parentGoalId;
let mergeBase = `origin/${primaryBranch ?? "master"}`;
let rootGoalBranch = goalBranch;
if (isChild && goal.parentGoalId) {
  const parent = goalStore.get(goal.parentGoalId);
  if (parent?.branch) mergeBase = `origin/${parent.branch}`;
  const root = goal.rootGoalId ? goalStore.get(goal.rootGoalId) : undefined;
  if (root?.branch) rootGoalBranch = root.branch;
}
builtinVars.mergeBase = mergeBase;
builtinVars.rootGoalBranch = rootGoalBranch ?? "HEAD";
```

The `buildReviewPrompt()` function (verification-harness.ts ~line 254)
currently hard-codes `git diff origin/${master}...HEAD` in three places.
**Replace `master` with `mergeBase`** for the diff/log forms; keep the
literal `master` line in the "Signal Context" preamble where it represents
"the trunk". The `Baseline:` line uses `mergeBase`.

### 3.3 `goal_merge_child` — local merge, no remote PR

New helper exported from
[`src/server/skills/git.ts`](../../src/server/skills/git.ts):

```ts
/**
 * Locally merge the child branch into the parent branch.
 *
 * - cwd MUST be the parent goal's worktree (where parent.branch is checked out).
 * - `git merge --no-ff origin/${childBranch}` — fast-forwards forbidden so the
 *   merge commit always exists (used as an audit trail).
 * - On conflict: leaves the worktree in conflicted state, runs
 *   `git merge --abort`, and returns { merged: false, conflict: true }.
 * - On clean merge: pushes parent.branch to origin (gated by shouldSkipRemotePush()).
 * - Never raises a PR — that's only done by the top-level goal's ready-to-merge.
 */
export async function mergeChildBranchLocal(
  parentWorktreePath: string,
  parentBranch: string,
  childBranch: string,
): Promise<{ merged: boolean; conflict: boolean; commitSha?: string; output: string }>;
```

`GoalManager.mergeChild(parentId, childId)` lives in `goal-manager.ts` and
wraps the helper, plus marking the child goal `state = "complete"` and
notifying the team-lead.

**Push semantics — clarification.** The spec wording "no remote push" for
child goals refers specifically to **no PR-raising push of the child
branch** (children never `gh pr create` against `master`). The **parent
branch** is still pushed to `origin` after a clean merge — gated by
`shouldSkipRemotePush()` exactly like every other push in the codebase —
so CI, replication, and downstream subgoal verifications can fetch the
post-merge tip. Without that push, sibling subgoals spawned at the next
phase would branch off a stale local tip.

### 3.4 Children skip PR-raising at `ready-to-merge`

The built-in workflows' `ready-to-merge` gate runs three commands:

```yaml
- name: Branch pushed to remote
- name: Master merged into branch
- name: PR raised
```

We do **not** modify the seeded workflows. Instead, the verification
template-var substitution (§3.2) plus a **gate-runtime branch on `mergeTarget`**
in `verifyGateSignal()` allows the harness to short-circuit child
`ready-to-merge`:

```ts
// verification-harness.ts, near the top of verifyGateSignal()
const goalForGate = pcm.getContextForGoal(signal.goalId)?.goalStore.get(signal.goalId);
if (signal.gateId === "ready-to-merge" && goalForGate?.mergeTarget === "parent") {
  // Children: no remote PR. The local merge is performed by the parent's
  // subgoal verify-step harness loop (§2.3), not by the child's own gate.
  // Mark the gate passed without running its verify[] steps.
  this.resolveGateStore(signal.goalId).updateSignalVerification(signal.id, {
    status: "passed", steps: [{ name: "Child ready-to-merge", type: "command",
      passed: true, output: "Child goal — merge handled by parent.", duration_ms: 0 }],
  });
  this.resolveGateStore(signal.goalId).updateGateStatus(signal.goalId, signal.gateId, "passed");
  // …broadcast events…
  return;
}
```

This keeps `ready-to-merge` semantically equivalent (the gate passes) without
duplicating push/PR logic. Top-level goals retain existing behaviour.

---

## 4. Mutation classifier (`plan-mutation.ts`)

New module:
[`src/server/agent/plan-mutation.ts`](../../src/server/agent/plan-mutation.ts).

### 4.1 Public signature

```ts
export type MutationClass =
  | "fix-up"        // additive leaf, no dep changes
  | "expansion"     // additive new branches / new deps
  | "restructure"   // removed nodes / changed deps
  | "criteria-drop" // an acceptance criterion would no longer be covered
  | "noop";         // identical to before

export interface MutationDiff {
  cls: MutationClass;
  /** Acceptance criteria from rootGoal.acceptanceCriteria that are no
   *  longer covered after the mutation. Empty unless cls === "criteria-drop". */
  droppedCriteria: string[];
  /** Subgoal step names added (new planId on the after side). */
  addedNodes: string[];
  /** Subgoal step names removed (planId present in before, absent in after). */
  removedNodes: string[];
  /** True when any node's phase or workflow id changed. */
  changedDeps: boolean;
  /** Human-readable summary used in the UI banner and 409 error body. */
  summary: string;
}

/**
 * Classify a plan mutation by structural shape and acceptance-criteria
 * adherence.
 *
 * Inputs:
 * - before: the previous verify[] of the gate (after freeze). Pass [] for
 *           pre-freeze proposals (always classifies as "expansion").
 * - after:  the proposed verify[]. Subgoal steps are matched by planId
 *           (stable across replans).
 * - rootGoal: the top-of-tree goal — provides acceptanceCriteria.
 *
 * Algorithm:
 *   1. Build addedNodes / removedNodes by planId set diff.
 *   2. Detect changedDeps: any node whose `phase` differs in before vs after.
 *   3. Classify shape:
 *        - removedNodes.length > 0 → "restructure"
 *        - changedDeps             → "restructure"
 *        - addedNodes.length === 0 → "noop"
 *        - addedNodes.length > 0 && phase increases (new top-level branch)
 *                                  → "expansion"
 *        - addedNodes.length > 0 (only new leaves at existing phases)
 *                                  → "fix-up"
 *   4. Adherence: for each criterion in rootGoal.acceptanceCriteria, check
 *      if its substring is present in *any* of:
 *        - the union of `subgoal.spec` across all subgoal steps in `after`
 *        - the gate's quality criteria (gate.metadata.criteria, if any)
 *        - the rootGoal.spec (always present — base coverage)
 *      Substring match is case-insensitive after whitespace collapse.
 *      If any criterion is uncovered → cls = "criteria-drop", populate
 *      droppedCriteria.
 */
export function classifyMutation(
  before: VerifyStep[],
  after: VerifyStep[],
  rootGoal: PersistedGoal,
): MutationDiff;
```

### 4.2 Adherence implementation detail

```ts
function normaliseText(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

function criterionCovered(criterion: string, after: VerifyStep[], rootSpec: string): boolean {
  const needle = normaliseText(criterion);
  if (needle.length < 8) return true; // too short to anchor — treat as covered
  const haystack =
    normaliseText(rootSpec) + "\n" +
    after.filter(s => s.type === "subgoal" && s.subgoal)
         .map(s => normaliseText(s.subgoal!.spec))
         .join("\n");
  return haystack.includes(needle);
}
```

Rationale: the rootGoal's spec always appears in the haystack so a criterion
that the user wrote is covered as long as nothing actively *contradicts* it.
The subgoal specs add coverage for "is this criterion addressed by some
specific child". This is intentionally lenient — the goal of the check is
to catch a team-lead who replaces "Build agent-memory v0.1 schema" with
something completely off-topic, not to police prose drift.

**Note on the word "hashed".** The spec's mutation-classifier section
mentioned acceptance criteria being "hashed for adherence checks". That
phrasing is loose — the actual mechanism implemented here is **not**
cryptographic hashing. It is whitespace-normalised (`/\s+/g → " "`),
case-insensitive **substring matching** of each criterion against the
union of root-goal spec and remaining subgoal specs. Hashing wouldn't
help: an exact-match hash would fail the moment the team-lead
paraphrases a criterion in a subgoal spec, even if coverage is
preserved. Substring matching with normalisation is the right balance
between "criterion text appears verbatim somewhere" and "noise tolerated".

### 4.3 Decision matrix

This matrix is the **binding** policy table — it implements Decision #6
of the goal spec verbatim. Note in particular that **expansion always
prompts the user under every policy** (including `autonomous`); the only
class that ever auto-approves is `fix-up`.

| classifier output | `divergencePolicy: strict` | `balanced` | `autonomous` |
|---|---|---|---|
| `noop`           | allow | allow | allow |
| `fix-up`         | prompt user | **auto-approve** | **auto-approve** |
| `expansion`      | prompt user | prompt user | prompt user (with WS notification) |
| `restructure`    | reject 409 unless `goal.paused`, then prompt user | prompt user | prompt user |
| `criteria-drop`  | reject 409 (no policy override) | reject 409 (no policy override) | reject 409 (no policy override) |

Notes on individual cells:

- **`fix-up`** — adding a leaf subgoal under an in-progress branch with
  no dep changes. Auto-approves under `balanced` and `autonomous`;
  prompts under `strict`.
- **`expansion`** — adding a new top-level branch or new dependencies.
  **Always prompts the user** regardless of policy. Under `autonomous`
  the prompt still goes through the dashboard banner (§10.5), but the
  server **also** broadcasts a `goal_mutation_pending` WS notification
  so an autonomous-mode operator sees the prompt without having to be
  on the dashboard tab. Decision #6 explicitly nominated `ask_user_choices`
  here; §10.5 documents why we substitute a banner with equivalent UX.
- **`restructure`** — removing nodes or changing existing dependencies.
  **Always prompts the user.** Under `strict`, the goal must first be
  paused (`goal_pause`) — if it isn't, the server returns 409 with
  reason `restructure-requires-pause` and no prompt is queued.
- **`criteria-drop`** — a mutation that would leave one of the root
  goal's acceptance criteria uncovered. **Always rejected with 409, no
  policy override.** This is the one rule no escalation flow can
  unblock; the team-lead must restructure the proposal so coverage is
  preserved or escalate to the user to amend the root spec.

`replanCount > 5` → server unconditionally returns 409 with reason
`replan-cap`; UI offers "Pause goal" button which sets `paused = true` and
allows one further mutation, after which the cap blocks again.

### 4.4 Where the classifier is called

| Call site | File | Behaviour on each class |
|---|---|---|
| `goal_spawn_child` tool | `defaults/tools/children/extension.ts` | Calls `POST /api/goals/:id/spawn-child` which classifies. |
| `goal_plan_propose` tool | `defaults/tools/children/extension.ts` | Calls `PATCH /api/goals/:id/plan` which classifies. |
| `PATCH /api/goals/:id/plan` | `src/server/server.ts` | Server-side classifier; returns 409 on reject; broadcasts `goal_mutation_pending` on prompt-required outcomes. |
| `POST /api/goals/:id/spawn-child` | `src/server/server.ts` | Same, treating the spawned child as "addedNodes:[planId]". |

Reject responses follow the §8 schema (409 with structured body).

---

## 5. Tools — new `Children` group

Lives at `defaults/tools/children/`. Files:

```
defaults/tools/children/
  extension.ts                # registers all six tools via pi.registerTool()
  goal_spawn_child.yaml
  goal_plan_propose.yaml
  goal_plan_status.yaml
  goal_merge_child.yaml
  goal_pause.yaml
  goal_resume.yaml
```

Tool-group policy default in
[`defaults/tool-group-policies.yaml`](../../defaults/tool-group-policies.yaml):

```yaml
Children:
  default: never
  team-lead: allow         # team-leads of any goal may spawn children/replan
  architect: never
  coder: never
  reviewer: never
  qa-tester: never
```

Per-role overrides happen at project scope through the existing cascade.

### 5.1 `goal_spawn_child`

```yaml
# goal_spawn_child.yaml
name: goal_spawn_child
group: Children
description: Spawn a child goal under the current goal, branching off the
  current goal's branch HEAD. Subject to divergence policy and mutation
  classification when the goal-plan gate is already frozen.
parameters:
  type: object
  required: [title, spec]
  properties:
    title:    { type: string, maxLength: 200 }
    spec:     { type: string }
    workflowId:        { type: string }
    inlineWorkflow:    { type: object, description: "Inline workflow YAML object — overrides workflowId." }
    suggestedRole:     { type: string }
    enabledOptionalSteps: { type: array, items: { type: string } }
    planId:            { type: string, description: "Optional stable id; server generates if omitted." }
```

**REST call (extension):**

```http
POST /api/goals/:parentId/spawn-child
Body: { title, spec, workflowId?, inlineWorkflow?, suggestedRole?, enabledOptionalSteps?, planId? }
Response 201: { childGoalId, planId, alreadySpawned: false }
Response 200: { childGoalId, planId, alreadySpawned: true }
Response 409: { error, classification, droppedCriteria, addedNodes, removedNodes, summary, requiresApproval?: boolean }
```

When `requiresApproval === true` is returned (prompt path), the caller's
team-lead also receives a `goal_mutation_pending` WS event (§9). The tool
extension surfaces the 409 body verbatim to the model so the team-lead can
explain it to the user.

### 5.2 `goal_plan_propose`

```yaml
name: goal_plan_propose
group: Children
description: Replace the verify[] of a named gate (default "execution") with
  the proposed list of steps (typically subgoal steps). Pre-freeze: applies
  immediately. Post-freeze: requires replanReason and is subject to
  classification + divergence policy.
parameters:
  type: object
  required: [planSteps]
  properties:
    planSteps:    { type: array, items: { $ref: "#/definitions/VerifyStep" } }
    gateId:       { type: string, default: "execution" }
    replanReason: { type: string, description: "Required when goal-plan gate has passed." }
```

REST: `PATCH /api/goals/:id/plan`. Same response shape as 5.1.

### 5.3 `goal_plan_status`

```yaml
name: goal_plan_status
group: Children
description: Return the current plan (verify[] of the named gate) plus
  per-node child-goal state. Cheap to call; use this before proposing a
  mutation to ensure you are working from the latest snapshot.
parameters:
  type: object
  properties:
    gateId: { type: string, default: "execution" }
```

**REST endpoint (new — separate from `?include=tree`):**

```http
GET /api/goals/:id/plan?gateId=execution
```

Response 200:

```ts
{
  gateId: string;
  frozen: boolean;          // true once goal-plan gate has been signalled
  replanCount: number;
  planSteps: Array<{
    planId: string;
    title: string;
    spec: string;             // full spec — caller may truncate
    workflowId?: string;
    suggestedRole?: string;
    phase: number;            // 0 if unset
    /** Inferred from phase ordering: every step at phase < this.phase
     *  is a logical dep. Materialised so the tool consumer doesn't have
     *  to recompute. Empty array when phase === minPhase. */
    dependsOnPlanIds: string[];
    /** Live child-goal state, joined from the goal store. */
    child?: {
      goalId: string;
      state: "todo" | "in-progress" | "complete" | "shelved";
      branch?: string;
      lastVerificationVerdict?: "passed" | "failed" | "running";
    };
  }>;
}
```

`?include=tree` on `/api/goals/:id` is the **broader** projection (all
descendants + per-goal gate states); `/plan` is the **narrow** projection
the tool returns. §8 lists both endpoints.

### 5.4 `goal_merge_child`

```yaml
name: goal_merge_child
group: Children
description: Locally merge a completed child goal's branch into the current
  goal's branch. Fails on conflict — never auto-resolves; on conflict, the
  team-lead must escalate to the user via ask_user_choices.
parameters:
  type: object
  required: [childGoalId]
  properties:
    childGoalId: { type: string }
```

REST: `POST /api/goals/:parentId/integrate-child/:childGoalId`.

### 5.5 `goal_pause` / `goal_resume`

```yaml
name: goal_pause
group: Children
description: Suspend verification-harness ticks for this goal-tree.
  Required by the strict policy before applying restructure mutations.
parameters: { type: object, properties: {} }
```

```yaml
name: goal_resume
group: Children
description: Resume verification-harness ticks for this goal-tree.
parameters: { type: object, properties: {} }
```

REST: `POST /api/goals/:id/pause` and `POST /api/goals/:id/resume`. Both
flip `goal.paused` and broadcast `goal_paused` / `goal_resumed`.

### 5.6 Extension TS shape

`defaults/tools/children/extension.ts` mirrors
[`defaults/tools/skills/extension.ts`](../../defaults/tools/skills/extension.ts).
Each tool calls a REST endpoint via `fetch(${baseUrl}/api/...)` using the
gateway URL/token resolver from `defaults/tools/_shared/gateway.ts`. Tools
must include the **goal id** of the calling agent — read from
`process.env.BOBBIT_GOAL_ID` which the server already populates for goal
team-leads (verified in `team-manager.ts::startTeam`).

---

## 6. `parent.yaml` workflow

Add a fifth canonical workflow alongside `general` / `feature` / `bug-fix` /
`quick-fix` in
[`src/server/state-migration/seed-default-workflows.ts`](../../src/server/state-migration/seed-default-workflows.ts).
The workflow is **a builtin template** — discoverable in the New Goal
dialog's workflow picker (§10.4). It works as-is for any user creating a
parent goal; other workflows can also embed `subgoal` verify steps on any
gate they like.

**File-location note.** The goal spec named `defaults/workflows/parent.yaml`,
but the existing canonical workflows (`general` / `feature` / `bug-fix` /
`quick-fix`) are **code-seeded** from `seed-default-workflows.ts` rather
than shipped as YAML on disk — see the file's header comment (the on-disk
`defaults/workflows/*.yaml` fallbacks were deleted in the multi-repo
migration). We follow that pattern. Functionally equivalent: a user
inspecting the workflow sees the same shape; the cascade resolves it the
same way; project-level inline overrides still win.

**`WorkflowGate.description`.** §6 below introduces self-documenting
gate-level prose (§14.4). The current `WorkflowGate` interface in
[`src/server/agent/workflow-store.ts`](../../src/server/agent/workflow-store.ts)
already has `manual?: boolean` (used by the `goal-plan` gate). It does
**not** have `description?: string` today — that's a **new** optional
field added by Phase 3 task 3.4 (alongside the seed-workflow change).
The `manual` flag is pre-existing; no schema change there.

Inside `buildDefaultWorkflows(componentName)`, append:

```ts
const parent: SeededWorkflow = {
  id: "parent",
  name: "Parent Goal",
  description: "Goal that orchestrates child subgoals via a planning gate. " +
    "Approve a plan; children spawn in parallel up to maxConcurrentChildren.",
  gates: [
    {
      id: "charter",
      name: "Charter",
      content: true,
      inject_downstream: true,
      verify: [
        { name: "Charter review", type: "llm-review", role: "architect", prompt: CHARTER_PROMPT },
      ],
    },
    {
      id: "plan-review",
      name: "Plan Review",
      depends_on: ["charter"],
      content: true,
      inject_downstream: true,
      verify: [
        { name: "DAG correctness", type: "llm-review", role: "architect", prompt: PLAN_REVIEW_DAG_PROMPT },
        { name: "Spec completeness", type: "llm-review", role: "spec-auditor", prompt: PLAN_REVIEW_COMPLETENESS_PROMPT, phase: 1 },
      ],
    },
    {
      id: "goal-plan",
      name: "Plan Approval",
      depends_on: ["plan-review"],
      manual: true,           // human-only signal — no LLM verify steps
    },
    {
      id: "execution",
      name: "Execution",
      depends_on: ["goal-plan"],
      // verify[] is empty at creation; populated by goal_plan_propose calls
      // and frozen once goal-plan is signalled. Each entry is a `subgoal`
      // step. Multiple entries with the same `phase` run in parallel,
      // bounded by goal.maxConcurrentChildren.
      verify: [],
    },
    {
      id: "integration",
      name: "Integration",
      depends_on: ["execution"],
      verify: [
        { name: "Build", type: "command", component: c, command: "build", timeout: 600 },
        { name: "Type check", type: "command", phase: 1, component: c, command: "check" },
        { name: "Unit tests", type: "command", phase: 1, component: c, command: "unit" },
        { name: "E2E tests", type: "command", phase: 1, timeout: 900, component: c, command: "e2e" },
        { name: "Code quality review", type: "llm-review", role: "code-reviewer", phase: 2, prompt: CODE_REVIEW_PROMPT },
      ],
    },
    readyToMergeGate(),  // depends_on: ["documentation"] in the helper —
                         //  see note below; we tweak depends_on for parent.
  ],
};
// The shared readyToMergeGate() helper hardcodes depends_on:["documentation"].
// Parent has no documentation gate — patch the gate inline:
parent.gates[parent.gates.length - 1] = {
  ...parent.gates[parent.gates.length - 1],
  depends_on: ["integration"],
};
```

`CHARTER_PROMPT`, `PLAN_REVIEW_DAG_PROMPT`, `PLAN_REVIEW_COMPLETENESS_PROMPT`
are new module-scope `const`s defined alongside `DOC_PROMPT` /
`DESIGN_REVIEW_PROMPT` etc. in the same file. Outline:

```ts
const CHARTER_PROMPT = `Review the charter for goal {{branch}}.

The goal spec is:
{{goal_spec}}

A charter must:
1. State the user-visible outcome in plain English.
2. List 3-7 acceptance criteria that are independently verifiable.
3. Identify the natural decomposition into 2-8 child goals (subtasks).
4. Flag any acceptance criterion that cannot be assigned to exactly one child.

PASS only when all four checks hold.`;

const PLAN_REVIEW_DAG_PROMPT = `Inspect the proposed plan ({{branch}} execution.verify[]).

Verify:
1. Every node has a non-empty title and spec.
2. The phase numbers form a valid DAG (no cycles by construction — they are
   layer numbers).
3. No two siblings at the same phase share a planId.
4. workflowId values resolve through the cascade (call out unknowns).

PASS only when all four checks hold.`;

const PLAN_REVIEW_COMPLETENESS_PROMPT = `Compare the plan against the
acceptance criteria from the charter.

For each criterion, identify which planned subgoal addresses it. Flag any
criterion left uncovered. PASS when every criterion is covered.`;
```

### 6.1 The `goal-plan` freeze

Gate `goal-plan` has `manual: true` — it has no `verify[]`. Signalling it
via `gate_signal` triggers a server-side **freeze hook**:

In `server.ts` inside `POST /api/goals/:goalId/gates/:gateId/signal`,
after calling the existing signal-acceptance logic, if
`gateId === "goal-plan"` AND signal is accepted, snapshot the current
`execution.verify[]` and stamp `goal.workflow.gates[execution].metadata =
{ frozen: "true", frozenAt: String(Date.now()) }`. Subsequent
`goal_plan_propose` / `goal_spawn_child` calls inspect this metadata to
gate post-freeze classification.

The freeze flag lives on the goal's snapshotted workflow (already mutable
per goal) — not on the canonical `parent.yaml` builtin.

### 6.2 Runtime mutation of an in-flight gate — option (b), append-and-continue

When `goal_plan_propose` (or a `goal_spawn_child` that triggers a
classifier-approved plan amendment) mutates the `verify[]` of a gate
that is **currently running**, the harness must decide between three
options:

- **(a) Restart the gate from scratch** — discard in-flight verify-step
  state. *Rejected.* In-flight reviewer / QA sessions are expensive
  (5–15 min each, real LLM tokens, real container starts). Throwing
  that work away on every plan tweak would make legitimate fix-ups
  punitively costly.
- **(b) Append the new step(s) and let in-flight steps complete first.**
  ✅ **Chosen default.**
- **(c) Reject the mutation with 409** — caller must wait until the
  gate resolves. *Rejected.* Makes the team-lead's job harder during
  legitimate fix-up additions and forces awkward
  "wait-then-retry" loops mid-flight.

**Rationale for (b):** preserves in-flight progress, integrates cleanly
with the existing phase scheduler (each phase already runs all its
steps in parallel and waits for the slowest before starting the next),
and only requires the harness to recompute the active phase set on each
mutation. It also matches the natural mental model of the team-lead
("I'll add another subgoal — the existing ones keep going").

**Concrete behaviour (the contract Phase 3 task 3.2 implements):**

1. **Default `phase` for an appended step.** If the caller does **not**
   set `phase` on the new step, the harness assigns it
   `max(currentPhases) + 1` so the appended step lands strictly after
   all in-flight work. The caller may set an explicit `phase` to
   override this — but a `phase` value `≤ active phase` is silently
   bumped to `activePhase + 1` (the harness never inserts a step into a
   phase that has already started).
2. **Gate start-time is preserved**, not reset. The
   `gate_verification_started` event broadcast on the original signal
   keeps its `startedAt`. The harness emits a new
   `gate_verification_step_appended` event (additive — see §9 below)
   carrying the new step's index so dashboards re-render the verify
   list. Overall verdict (pass / fail) defers until every step
   completes.
3. **Idempotency.** The mutation request carries a `planId` (or
   set-of-`planId`s for multi-step proposals). If the team-lead retries
   a `goal_plan_propose` with the same `planId(s)`, the harness's
   active-verification record (§2.5) is the source of truth: any step
   whose `subgoal.planId` is already present is skipped on the retry.
   The classifier (§4) already handles `planId` uniqueness; the
   in-flight-mutation path additionally consults the **active
   verification record's** existing planIds, not just the persisted
   gate-signal record, so a retry mid-flight doesn't double-spawn.
4. **Frozen + paused gates are unaffected.** A mutation arriving while
   the gate is paused (because the goal is paused) is buffered — see
   §10.5 banner mechanism — and applied on resume. A mutation arriving
   while the gate has resolved (passed or failed) re-signals the gate
   normally; that's not a "runtime mutation" and falls outside §6.2.
5. **Cascade-cancel still wins.** If the parent verification is
   cancelled while an appended subgoal step is mid-spawn, the cancel
   tears down the spawned child (per §2.3). Append-and-continue does
   not weaken cancellation semantics.

This subsection is normative for Phase 3 task 3.2 (`runSubgoalStep`
+ phase-set recomputation). Add a new WS event
`gate_verification_step_appended` (§9 lists it) and an additional
`active.steps[]` push in `verifyGateSignal()` keyed off the post-mutation
phase scheduler tick.

---

## 7. Custom workflows + roles resolution

Two new modules with **identical algorithm shape**:

- [`src/server/agent/workflow-resolution.ts`](../../src/server/agent/workflow-resolution.ts)
- [`src/server/agent/role-resolution.ts`](../../src/server/agent/role-resolution.ts)

### 7.1 Workflow resolver

```ts
import type { Workflow } from "./workflow-store.js";
import type { GoalManager } from "./goal-manager.js";
import type { ConfigCascade } from "./config-cascade.js";

/**
 * Resolve the Workflow for a goal, walking inline overrides up the
 * parentGoalId chain before falling back to the project/server/builtin
 * cascade.
 *
 * Order:
 *   1. goal.inlineWorkflow                       (own inline override)
 *   2. ancestor.inlineWorkflow (root → leaf walk) (parent-tree override)
 *   3. ConfigCascade.resolveWorkflows(projectId)  (project → server → builtin)
 *
 * Returns the snapshot already on the goal as the authoritative source for
 * verify-step execution; the resolver is used by the team-manager when
 * spawning child sessions and by gate-renderers that need the live
 * workflow definition (e.g. the Plan tab when goal-plan has been signalled
 * and the snapshot is the source of truth).
 */
export function resolveWorkflowForGoal(
  goalManager: GoalManager,
  cascade: ConfigCascade,
  goalId: string,
  workflowId?: string,
): Workflow | undefined;
```

Key design constraint: **once a goal is created, its `goal.workflow` snapshot
is the source of truth** for runtime verification. The resolver is for
*new* sessions and *new* child goals — it must not retroactively rewrite
running goals' workflows. Callers:

| Caller | File | What changes |
|---|---|---|
| `GoalManager.createGoal` (child path) | `goal-manager.ts` | When `parentGoalId` set and `inlineWorkflow` not provided, walk parent chain for a parent's inline workflow whose `id` matches `opts.workflowId`. Otherwise call `cascade.resolveWorkflows(projectId)`. |
| `team-manager.ts::startTeam` | When picking step prompts for spawned sub-agents (already reads `goal.workflow`) — no change; but the **reviewer/QA spawn path** in `verification-harness.ts` calls `roleStore.get(role)` directly. Switch that to `resolveRoleForGoal`. |
| New Goal dialog "Inline workflow" textarea | `src/app/dialogs.ts` | Submits `inlineWorkflow` body; server validates with `workflow-validator.ts`. |

### 7.2 Role resolver

```ts
import type { Role } from "./role-store.js";

export function resolveRoleForGoal(
  goalManager: GoalManager,
  cascade: ConfigCascade,
  goalId: string,
  roleName: string,
): Role | undefined;
```

Resolution order, identical shape to workflows:

1. `goal.inlineRoles?.[roleName]`
2. Ancestor walk: each ancestor's `inlineRoles?.[roleName]`
3. `cascade.resolveRoles(projectId)` (already implemented)

Switch points (search-and-replace `roleStore.get(roleName)` to
`resolveRoleForGoal(...)` at the following call sites):

- `verification-harness.ts::resolveRoleForGoal` (already exists as a
  private cascade-aware method — extend it to consult goal/ancestor inline
  roles when a `goalId` is provided).
- `team-manager.ts::spawnAgent` — currently uses `roleStore` for role
  lookup; switch.
- `system-prompt.ts::assembleSystemPrompt` — receives a Role; the *caller*
  is responsible for the lookup, so no in-file change here.

---

## 8. REST API additions

| Method | Path | Body | Response | Auth / project resolution |
|---|---|---|---|---|
| POST | `/api/goals` | `{ title, cwd, spec, workflowId?, sandboxed?, projectId?, parentGoalId?, inlineWorkflow?, inlineRoles?, divergencePolicy?, maxConcurrentChildren?, baseBranch? }` | `201 { goal }` (existing shape extended) | Bearer; `projectId` required (or `cwd` resolves to a project) |
| GET | `/api/goals/:id` (extended) | — | `200 { goal, workflow?, gates? }` (existing) | Bearer |
| GET | `/api/goals/:id?include=tree` | — | `200 { goal, descendants: PersistedGoal[], gatesByGoal: Record<string, GateState[]> }` | Bearer |
| GET | `/api/goals/:id/plan?gateId=execution` | — | `200 { gateId, frozen, replanCount, planSteps: [...] }` (see §5.3) | Bearer |
| PATCH | `/api/goals/:id/plan` | `{ planSteps: VerifyStep[], gateId?: string, replanReason?: string, expectedReplanCount?: number }` | `200 { plan, replanCount }`, `409` (mutation-rejected or stale-plan; see body schemas below) | Bearer + same project as goal |
| POST | `/api/goals/:id/spawn-child` | `{ title, spec, workflowId?, inlineWorkflow?, suggestedRole?, enabledOptionalSteps?, planId? }` | `201 { childGoalId, planId }`, `200 { childGoalId, planId, alreadySpawned: true }`, `409` (same body shape as PATCH /plan) | Bearer; idempotent on `planId` |
| POST | `/api/goals/:id/integrate-child/:childGoalId` | — | `200 { merged: true, commitSha }`, `409 { merged: false, conflict: true, output }` | Bearer; both goals same project |
| POST | `/api/goals/:id/mutation/:requestId/decision` | `{ decision: "approve" \| "reject" }` | `200 { resolved: true, applied?: { plan?: VerifyStep[], childGoalId?: string } }`, `404 { error: "unknown-or-stale-request" }` | Bearer + same project as goal |
| POST | `/api/goals/:id/pause` | — | `200 { paused: true }` | Bearer |
| POST | `/api/goals/:id/resume` | — | `200 { paused: false }` | Bearer |
| DELETE | `/api/goals/:id?recursive=1` (extended) | — | `200 { archived: [...goalIds] }` | Bearer |

**409 body schemas (multiple variants on PATCH /plan and POST /spawn-child):**

*1. Mutation-rejection — divergence policy or criteria-drop:*

```json
{
  "error": "Mutation rejected by divergence policy",
  "classification": "restructure",
  "droppedCriteria": [],
  "addedNodes": ["plan-step-id-1"],
  "removedNodes": ["plan-step-id-2"],
  "changedDeps": true,
  "summary": "Removing 'Build agent client' breaks dep graph; pause goal first.",
  "requiresApproval": false,
  "policy": "strict"
}
```

*2. Optimistic-concurrency mismatch — `expectedReplanCount` does not
match server state (e.g. team-lead and dashboard both edit
simultaneously):*

```json
{
  "error": "stale-plan",
  "currentReplanCount": 3
}
```

Clients (UI and tool extension) must re-fetch the plan via `GET
/api/goals/:id/plan?gateId=…` and retry with the new
`expectedReplanCount` if they still want to apply their change.

*3. Replan-cap exhausted (>5 post-freeze mutations):*

```json
{ "error": "replan-cap", "replanCount": 6 }
```

When `requiresApproval === true` (variant 1, prompt-required outcomes),
the server **also broadcasts** `goal_mutation_pending` (§9) so the
dashboard renders the banner. The tool extension returns the 409 body as
the tool error to the model so the team-lead can explain the rejection.

**404 body schema** (POST /mutation/:requestId/decision only):

```json
{ "error": "unknown-or-stale-request" }
```

Returned when the named `requestId` has expired (>15 min unresolved), is
already resolved, or never existed. Caller fetches the active plan and
proceeds without retrying the decision.

**`?include=tree` semantics:**

- `descendants` is a flat array of all goals where `rootGoalId === id`,
  sorted by `(parentGoalId nulls-first, createdAt ASC)`. Ordering is
  documented because the UI relies on it for stable rendering.
- `gatesByGoal` keys by `goalId` and includes signal summaries (no full
  bodies — drilling into a gate uses the existing `?view=summary` /
  `gate_inspect` path).

**`DELETE ?recursive=1`:**

Default behaviour (no flag) is unchanged — archives only the named goal.
With `recursive=1`, the server walks `getDescendants(rootGoalId)` and
archives each, returning `{ archived: [...ids] }`. Children of an archived
parent without `recursive=1` continue to operate; this is intentional so a
parent goal can be cleanly retired while leaving in-flight child work
alone.

---

## 9. WebSocket events

All events broadcast via `broadcastFn(goalId, …)` reach connected clients
viewing **either** the named goal **or** any ancestor in the tree. The
server fans out by walking `goal.rootGoalId` and pushing to clients on
the root id too, so the sidebar and dashboard stay in sync without polling.

| Event | Payload | Trigger |
|---|---|---|
| `goal_plan_proposed` | `{ goalId, gateId, planSteps: VerifyStep[], replanCount }` | Successful PATCH /plan or goal_plan_propose |
| `goal_plan_frozen` | `{ goalId, gateId, frozenAt }` | gate_signal of `goal-plan` accepted |
| `goal_child_spawned` | `{ parentGoalId, childGoalId, planId, branch, baseBranch }` | POST /spawn-child accepted (or harness subgoal step) |
| `goal_paused` | `{ goalId, by: "user" \| "auto-replan-cap" }` | POST /pause or replanCount > 5 |
| `goal_resumed` | `{ goalId }` | POST /resume |
| `goal_mutation_pending` | `{ goalId, classification, summary, droppedCriteria, addedNodes, removedNodes, requestId }` | Any prompt-required outcome from the classifier |
| `goal_mutation_resolved` | `{ goalId, requestId, decision: "approve" \| "reject" }` | User responds to the dashboard banner |
| `goal_merge_complete` | `{ parentGoalId, childGoalId, commitSha }` | Successful local merge |
| `goal_merge_conflict` | `{ parentGoalId, childGoalId, output }` | Local merge raised conflict |
| `gate_verification_step_appended` | `{ goalId, gateId, signalId, stepIndex, stepName, phase, planId? }` | In-flight gate received an appended verify step (§6.2 append-and-continue) |

Existing `goal_state_changed` / `gate_*` events fire as today.

---

## 10. UI changes

### 10.1 Sidebar — recursive child rendering

The recursion lives in
[`src/app/render-helpers.ts::renderGoalGroup`](../../src/app/render-helpers.ts).
Currently the function pulls all sessions matching the goal then picks a
team-lead and renders children indented underneath. Extend it as follows:

```ts
// Pseudocode for the addition; full diff in Phase 1 task 1.5
export function renderGoalGroup(goal: Goal, depth = 0) {
  // existing rendering …

  // After agents, render child goals recursively up to MAX_GOAL_DEPTH.
  const MAX_GOAL_DEPTH = 5;
  const childGoals = state.goals.filter(g => g.parentGoalId === goal.id && !g.archived);
  if (childGoals.length > 0) {
    if (depth >= MAX_GOAL_DEPTH) {
      const totalDescendants = countDescendants(goal.id); // helper in render-helpers
      return html`<button class="show-more-children" @click=${() => openGoalDashboard(goal.id)}>
        Show ${totalDescendants} more child goals…
      </button>`;
    }
    childGoals.sort((a, b) => a.createdAt - b.createdAt);
    const completed = childGoals.filter(c => c.state === "complete").length;
    const badge = `${completed}/${childGoals.length}`;
    // render badge next to the parent's title (replace existing badge logic
    // when goal has children)
    // then:
    return html`
      ${existingGoalRow}
      ${isExpanded ? html`<div style="padding-left:${INDENT}px;">
        ${childGoals.map(c => renderGoalGroup(c, depth + 1))}
      </div>` : ""}
    `;
  }
}
```

Goals with children get the count badge `n/m` (complete/total) replacing
the existing `renderGoalBadge(goal.id)` placement.

`state.goals` already exists in `src/app/state.ts`. The existing
`getSidebarData()` returns `liveGoals` — extend it to include all
descendants, and let the recursive renderer filter by `parentGoalId` on
each level.

### 10.2 Goal-dashboard `Plan` tab — DAG SVG

`dashboardTab` union in
[`src/app/goal-dashboard.ts`](../../src/app/goal-dashboard.ts) (line 152)
extends to `"spec" | "tasks" | "agents" | "commits" | "gates" | "plan" | "children"`.
The Plan tab is shown **only** when the goal's workflow contains a
`goal-plan` gate.

**Layout strategy: topological columns by phase (Sugiyama-light).**

Justification (under 5 lines): Plans are layered by `phase` already — phase
is the user-visible authoring primitive. Render columns left-to-right, one
per phase number. Within a column, stack nodes vertically sorted by
`name`. Edges drawn as orthogonal connectors between adjacent columns when
a downstream phase has any node — no per-node dep edges needed since phases
are the dep boundary. Hand-rolled SVG, no library; <30 nodes typical.

```ts
function renderPlanTab(): TemplateResult {
  const goal = state.activeGoal;
  const exec = goal?.workflow?.gates.find(g => g.id === "execution");
  if (!exec || !exec.verify || exec.verify.length === 0) {
    return html`<div class="tab-empty">No plan yet — team-lead will propose one.</div>`;
  }
  const subgoals = exec.verify.filter(s => s.type === "subgoal");
  const phases = groupBy(subgoals, s => s.phase ?? 0);
  const phaseList = [...phases.keys()].sort((a, b) => a - b);

  // SVG dimensions
  const COL_W = 260, ROW_H = 90, PAD = 24;
  const maxRows = Math.max(...phaseList.map(p => phases.get(p)!.length));
  const W = phaseList.length * COL_W + PAD * 2;
  const H = maxRows * ROW_H + PAD * 2 + 40; // +40 for column headers

  return html`<div class="plan-tab">
    <svg width="${W}" height="${H}" class="plan-svg">
      ${phaseList.map((phase, colIdx) => svg`
        <g transform="translate(${PAD + colIdx * COL_W}, ${PAD})">
          <text class="phase-label" x="${COL_W / 2}" y="14" text-anchor="middle">Phase ${phase}</text>
          ${phases.get(phase)!.map((step, rowIdx) => renderPlanNode(step, rowIdx, ROW_H, COL_W))}
        </g>
        ${colIdx < phaseList.length - 1 ? svg`
          <!-- column separator edges from each row to the next col -->
        ` : ""}
      `)}
    </svg>
    ${selectedNodeCard}
  </div>`;
}
```

Each plan node card shows: `title`, truncated `spec` (3 lines), `workflowId`,
`suggestedRole`, current `state` (resolved by joining the active descendants
list against `step.subgoal.planId` → child goal id). State drives a colour
class (`pending` / `running` / `passed` / `failed`).

**Edit mode** is enabled when:

- `goal-plan` gate has not been signalled (still pending), OR
- `goal.paused === true`.

In edit mode each node card has inline-edit handles for title/spec/workflow/phase.
Saving calls `PATCH /api/goals/:id/plan` with the updated `verify[]`. Adding
a node generates a fresh `planId` (`crypto.randomUUID()`).

### 10.3 `Children` tab card list

```ts
function renderChildrenTab(): TemplateResult {
  const goal = state.activeGoal!;
  const children = state.goals.filter(g => g.parentGoalId === goal.id && !g.archived);
  if (children.length === 0) return html`<div class="tab-empty">No children yet.</div>`;
  return html`<div class="children-tab">
    ${children.map(c => html`
      <div class="child-card" @click=${() => setHashRoute("goal-dashboard", c.id)}>
        <div class="child-title">${c.title}</div>
        <div class="child-meta">
          <span>${c.workflowId ?? "general"}</span>
          <span>·</span>
          <span class="child-state ${c.state}">${c.state}</span>
          <span>·</span>
          <span>${state.gatewaySessions.filter(s => s.goalId === c.id).length} agents</span>
        </div>
        <div class="child-last-gate">${lastVerificationVerdict(c.id)}</div>
      </div>
    `)}
  </div>`;
}
```

Child goal dashboards add a "← back to parent" breadcrumb when
`activeGoal.parentGoalId` is set. The breadcrumb renders the chain of
ancestors (root → … → parent), each clickable.

### 10.4 New Goal dialog "Advanced" disclosure

In [`src/app/dialogs.ts`](../../src/app/dialogs.ts), the `New Goal` dialog
gains an "Advanced" `<details>` section (collapsed by default) at the bottom
of the form, containing:

- **Divergence policy** — radio: strict (default) / balanced / autonomous.
- **Max concurrent children** — slider 1-8, default 3.
- **Inline workflow YAML** — `<textarea rows=10>` with placeholder showing
  the canonical schema. On submit, the client validates locally with a
  light parser; the server runs the full `workflow-validator.ts` and
  returns 400 with diagnostics on failure.
- **Inline roles YAML** — `<textarea rows=8>`; map of `name → roleYaml`.
  Same validation pattern.

When the dialog is opened from a goal-dashboard "Add child goal" button:
- `parentGoalId` is pre-filled (hidden).
- The project picker is locked to the parent's project.
- Workflow picker default is `feature` (parent's children typically aren't
  themselves parent goals; the user can opt-in).

### 10.5 Pending-mutation banner

When the client receives a `goal_mutation_pending` event for the active
goal, the dashboard renders a banner above the tab bar:

```html
<div class="mutation-banner">
  <strong>Plan mutation pending:</strong> {{summary}}
  <button @click=${() => approveMutation(requestId)}>Approve</button>
  <button @click=${() => rejectMutation(requestId)}>Reject</button>
  <details><summary>Details</summary>
    <ul>
      <li>Classification: {{classification}}</li>
      <li>Added: {{addedNodes.join(", ")}}</li>
      <li>Removed: {{removedNodes.join(", ")}}</li>
      <li>Dropped criteria: {{droppedCriteria.join(", ") || "none"}}</li>
    </ul>
  </details>
</div>
```

Approve/Reject call `POST /api/goals/:id/mutation/:requestId/decision` with
`{ decision: "approve" | "reject" }`, which the server uses to apply the
buffered mutation. (The mutation is buffered server-side keyed by
`requestId` in a per-goal `pendingMutations` Map on `GoalManager`.)

The banner is implemented as a dashboard-level component; `ask_user_choices`
is **not** used here because the agent is not the actor — the user is
responding directly.

**Mechanism note (Decision #6 acknowledgement).** The goal spec named
`ask_user_choices` as the prompt mechanism for divergence-policy
escalations. `ask_user_choices` is an **agent-→user** prompt — it ends
the calling agent's turn and posts an inline widget tied to that
agent's chat. Plan mutations are different: the trigger is a server
classifier decision, broadcast as a WS event to **every** client viewing
the goal (and its ancestors). The actor is the user, not an agent. A
dashboard-level banner driven by `goal_mutation_pending` is the right
shape — the UX outcome is equivalent (structured choice → REST decision
endpoint), but the wiring matches the actual data flow. The decision
endpoint applies the buffered mutation server-side and broadcasts
`goal_mutation_resolved` so the team-lead can resume.

The button handlers post to the REST endpoint and broadcast
`goal_mutation_resolved` so the team-lead can resume.

---

## 11. bobbit-e2e-tests scaffolding

The sibling project lives at `/Users/aj/Documents/dev/bobbit-e2e-tests/`
and is **already registered as a Bobbit project** (provisional, no files
yet). This goal seeds it.

### 11.1 `project.yaml`

```yaml
name: bobbit-e2e-tests
description: Cross-process behavioural / UI E2E tests against a built bobbit gateway.

# Used by the test fixture to spin up an isolated gateway under test.
qa_start_command: npm run start:bobbit-under-test
test_e2e_command: npm run test:e2e
typecheck_command: npm run check
worktree_setup_command: npm ci --prefer-offline --no-audit --no-fund

components:
  - name: bobbit-e2e-tests
    repo: "."
    worktree_setup_command: npm ci --prefer-offline --no-audit --no-fund
    commands:
      build: npm run build
      check: npm run check
      e2e: npm run test:e2e

workflows:
  feature: { ...inline copy of seed-default-workflows::feature targeting component bobbit-e2e-tests... }
  general: { ...inline copy... }
```

### 11.2 `package.json`

```json
{
  "name": "bobbit-e2e-tests",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "check": "tsc --noEmit",
    "test:e2e": "playwright test",
    "start:bobbit-under-test": "tsx scripts/start-bobbit.ts"
  },
  "devDependencies": {
    "@playwright/test": "^1.46.0",
    "@types/node": "^20.0.0",
    "tsx": "^4.0.0",
    "typescript": "^5.4.0"
  }
}
```

### 11.3 `scripts/start-bobbit.ts`

```ts
/**
 * Boot a fresh bobbit gateway against an isolated state dir, suitable for use
 * as Playwright's webServer. The env var BOBBIT_STATE_DIR overrides
 * .bobbit/state so the test run does not pollute the developer's project.
 */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const stateDir = mkdtempSync(path.join(tmpdir(), "bobbit-e2e-"));
process.env.BOBBIT_DIR = stateDir;
process.env.BOBBIT_TEST_NO_PUSH = "1";

const bobbitPath = process.env.BOBBIT_PATH
  ?? path.join(__dirname, "../../bobbit-suubro/dist/server/server.js");

const child = spawn("node", [bobbitPath], {
  stdio: "inherit",
  env: { ...process.env, BOBBIT_PORT: process.env.BOBBIT_PORT ?? "4321" },
});

process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
child.on("exit", code => process.exit(code ?? 0));
```

### 11.4 `playwright.config.ts`

```ts
import { defineConfig } from "@playwright/test";

const PORT = Number(process.env.BOBBIT_PORT ?? 4321);

export default defineConfig({
  testDir: "./tests",
  timeout: 60_000,
  webServer: {
    command: "npm run start:bobbit-under-test",
    url: `http://localhost:${PORT}/api/health`,
    timeout: 60_000,
    reuseExistingServer: !process.env.CI,
  },
  use: {
    baseURL: `http://localhost:${PORT}`,
    extraHTTPHeaders: {
      Authorization: `Bearer ${process.env.BOBBIT_TOKEN ?? "dev"}`,
    },
    ignoreHTTPSErrors: true,
  },
  reporter: [["list"], ["html", { open: "never" }]],
});
```

### 11.5 `helpers/bobbit-fixture.ts`

```ts
import { test as base } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

interface BobbitFixture {
  baseURL: string;
  token: string;
  projectId: string;
  api(path: string, init?: RequestInit): Promise<Response>;
}

export const test = base.extend<{ bobbit: BobbitFixture }>({
  bobbit: async ({ baseURL, request }, use) => {
    const stateDir = process.env.BOBBIT_DIR!;
    const token = readFileSync(path.join(stateDir, "token"), "utf-8").trim();

    // Ensure a default project is registered.
    const url = baseURL!.replace(/\/$/, "");
    const projectsResp = await fetch(`${url}/api/projects`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const projects = await projectsResp.json();
    let projectId = projects.projects?.[0]?.id;
    if (!projectId) {
      const created = await fetch(`${url}/api/projects`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "default", root_path: process.cwd() }),
      });
      const proj = await created.json();
      projectId = proj.project.id;
    }

    await use({
      baseURL: url,
      token,
      projectId,
      api: (p, init) => fetch(`${url}${p}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          ...(init?.headers ?? {}),
        },
      }),
    });
  },
});

export { expect } from "@playwright/test";
```

### 11.6 Example test `tests/nested-goals/create-parent-goal.spec.ts`

```ts
import { test, expect } from "../../helpers/bobbit-fixture";

test("create parent goal via REST and verify charter gate runs", async ({ bobbit, page }) => {
  // Create parent goal
  const resp = await bobbit.api("/api/goals", {
    method: "POST",
    body: JSON.stringify({
      title: "Build agent-memory v0.1",
      cwd: process.cwd(),
      spec: "## Acceptance criteria\n- Build foo\n- Build bar\n",
      workflowId: "parent",
      projectId: bobbit.projectId,
      divergencePolicy: "strict",
      maxConcurrentChildren: 3,
    }),
  });
  expect(resp.status).toBe(201);
  const { goal } = await resp.json();
  expect(goal.id).toBeTruthy();
  expect(goal.workflowId).toBe("parent");

  // Open dashboard in browser
  await page.goto(`/#/goal/${goal.id}`);
  await expect(page.locator(".tab-bar")).toBeVisible();
  await expect(page.locator('.tab[title="Plan"]')).toBeVisible();
});
```

---

## 13. Risks & open questions

### 13.1 Open questions from the spec — answers

| # | Spec question | Decision for v1 |
|---|---|---|
| 1 | `goal_merge_child` conflict — escalate or auto-spawn `bug-fix` subgoal? | **Escalate.** The team-lead receives the conflict output via the tool result, must call `ask_user_choices` to ask the user how to proceed (resume after manual resolution / abort the child / spawn a follow-up). Auto-spawning a `bug-fix` subgoal is too magical — easy to thrash. Phase 2 task 2.3 wires escalation only; auto-spawn deferred. |
| 2 | DAG SVG: hand-rolled or library? | **Hand-rolled** (§10.2). Plans are <30 nodes typical, layered by phase. Adding a graph library doubles client bundle size for one tab. Revisit if real plans exceed that. |
| 3 | Child verification baseline diff — parent branch base or `origin/<primary>`? | **Parent branch base.** §3.2 introduces `{{mergeBase}}` resolving to `origin/<parent.branch>` for children. "What did this child add" semantics, matching the merge-into-parent direction. `{{master}}` retained for "what's on the trunk" prose. |
| 4 | Acceptance-criteria parsing: regex or structured field? | **Regex on `## Acceptance criteria`** (§1.3). Lightweight; doesn't change the goal-spec authoring UX. Future enhancement: a structured editor in the New Goal dialog that emits canonical markdown. |

### 13.2 Newly-discovered risks (not in the spec)

- **Pool/child interaction.** The worktree pool branches off `origin/<primary>`.
  Naïvely claiming a pool worktree for a child goal would lose the parent's
  commits. Mitigation: child goals always bypass the pool (§3.1). Cost:
  child worktree creation is ~5–10s slower than top-level. Acceptable —
  parents are rare relative to top-level goals.

- **Sandbox + child branches.** `ProjectSandbox` creates worktrees inside
  the container at `/workspace-wt/<branch>` from the project's primary
  branch (verified in `verification-harness.ts` ~line 1390). For
  sandboxed child goals, the container-internal worktree won't have the
  parent's commits unless the project sandbox is taught to branch off
  `parent.branch`. **Risk:** sandboxed children initially regress to
  branching off primary inside the container. **Mitigation:** Phase 2 task
  2.2 includes a sandbox-aware branch-from-parent path. If the work is
  too large for Phase 2, defer with a hard error: sandboxed parent goals
  with sandboxed children fail at child-creation with
  `{ error: "sandboxed nested goals require sandbox bump — see #N" }`.
  Tracked as an explicit gap.

- **Cross-restart subgoal step recovery.** `runSubgoalStep` (§2.3) holds
  state in-process while polling the child's `ready-to-merge`. After a
  server restart, `resumeInterruptedVerifications` (existing) re-enters
  the harness for the *parent* signal. The subgoal step's status was
  persisted with `childGoalId`; resume must rebind to the existing child
  rather than spawning anew. Phase 3 task 3.2 explicitly tests the
  restart-rebind path.

- **WS broadcast fan-out.** Broadcasting to every ancestor in the tree
  (§9) is fine for typical depths (≤5) but explodes if a tree grows
  pathologically wide. Cap: clients connected to a goal subscribe via
  rootGoalId once, server broadcasts on the rootGoalId channel only, and
  individual goal updates are filtered client-side. This is the same
  pattern the existing `goal_state_changed` event uses; no new
  infrastructure.

- **Plan-tab editing race.** The dashboard Edit-mode in §10.2 patches the
  plan via `PATCH /api/goals/:id/plan` while the team-lead may also be
  proposing changes via `goal_plan_propose`. Server-side
  `pendingMutations` map is keyed by `requestId`, but two concurrent
  approvals could compose. Mitigation: PATCH /plan accepts an optional
  `expectedReplanCount` — server returns 409 if the goal's current
  `replanCount` differs. The UI passes the value it last saw; on 409 it
  re-fetches and re-renders.

- **Acceptance-criteria parsing fragility.** `## Acceptance criteria`
  may appear under variant headers (`## Success criteria`, `## Goals`,
  `## Done when`). v1 parses only the canonical header. **Mitigation
  for the assistant:** the goal-assistant (§14.3) is taught to coerce
  user-pasted specs into the canonical structure. v2 may add fuzzy
  header matching, gated by user feedback.

- **Multi-repo nested goals.** The components / multi-repo system clones
  one worktree per component on the goal's branch. Children inherit the
  parent's worktree set (multiple repos at `parent.branch`) when
  branching off. Untested in v1 — flagged here. Plan: phase-2 e2e
  exercises multi-repo with a single repo only; multi-repo nested goals
  get an explicit bug-fix task in v0.2 if they break.

---

## 14. Agent awareness — prompt-level integration

This section consolidates the requirements that span across §5
(tools), §6 (`parent.yaml`), §10 (dialog), §11 (worked example), and
the system prompt. Earlier sections reference back here for the exact
text and splice points.

### 14.1 Three system-prompt stanzas

All three stanzas are emitted from
[`src/server/agent/system-prompt.ts`](../../src/server/agent/system-prompt.ts).
The splice point is the goal-spec block in `_assembleSystemPrompt`
(currently around line 308 — the `{ let effectiveGoalSpec = parts.goalSpec || ""; … }`
block). After computing `effectiveGoalSpec` and before the
`sections.push(header + "\n\n" + effectiveGoalSpec.trim())` line, append
a new step that resolves and prepends the appropriate nesting stanza.

`PromptParts` (interface at line 165) gains five optional fields:

```ts
export interface PromptParts {
  // ── existing ───────────────────────────────────────────
  goalTitle?: string;
  goalSpec?: string;
  rolePrompt?: string;
  // ...

  // ── nesting additions ──────────────────────────────────
  /** When set, this session belongs to a goal that is the root of a tree
   *  (parentGoalId == null). Triggers the top-level team-lead stanza. */
  isTopLevelTeamLead?: boolean;

  /** When set, this session belongs to a child goal. Triggers the child
   *  team-lead stanza. */
  parentGoal?: { id: string; title: string; branch: string; specExcerpt: string; rootTitle: string };

  /** Effective divergence policy for this goal (resolved through
   *  inheritance walk in §1.5). Used by mid-goal nesting stanza. */
  divergencePolicy?: "strict" | "balanced" | "autonomous";

  /** Effective concurrency cap. */
  maxConcurrentChildren?: number;

  /** True only for team-lead role sessions; controls whether mid-goal
   *  nesting stanza is emitted at all (other roles never spawn children). */
  isTeamLead?: boolean;
}
```

Caller wiring lives in
[`src/server/agent/team-manager.ts`](../../src/server/agent/team-manager.ts)::`startTeam`,
which already builds the `PromptParts` for the team-lead session. Resolve
the new fields from the goal record (consulting `goalManager.resolveDivergencePolicy`
for child sessions and `resolveRootMaxConcurrentChildren` for the cap; the
cap is read from the root only — see §1.5).

#### 14.1.1 Top-level team-lead stanza

Emitted when `parts.isTeamLead && parts.isTopLevelTeamLead`. Splice into
the goal section as a markdown block headed `## Goal Decomposition`:

```markdown
## Goal Decomposition

This is a **top-level goal** — its branch will eventually merge to
`master` via a PR raised by your `ready-to-merge` gate.

If this goal is large enough that one team can't reasonably ship it
without losing context, you have two ways to decompose it:

1. **Ad-hoc:** call `goal_spawn_child` at any point to break a piece off.
   The spawned child branches off your branch HEAD, runs its own workflow
   (default `feature`), and merges its branch back into yours when its
   `ready-to-merge` gate passes. You stay in charge of integration.

2. **Planned:** if your workflow is `parent` (or you switch to it via
   `goal_plan_propose`), you have a structured planning loop:
   - Signal **charter** with the user-visible outcome and acceptance
     criteria.
   - Signal **plan-review** with the proposed DAG of subgoals.
   - The user signals **goal-plan** to approve and freeze the plan.
   - The harness automatically spawns the planned children at the right
     phases, up to your concurrency cap (currently {{maxConcurrentChildren}}).

**Heuristic — when to decompose.** Strongly prefer the planned approach
when any of the following hold:
- The spec exceeds ~5,000 characters.
- The spec mentions versions, milestones, or phases (`v0.1`, `phase 2`,
  `milestone 3`).
- The spec has 5+ acceptance criteria covering distinct deliverables.
- Multiple components or repos are touched.

**Worked example.** A spec like the agent-memory v0.1→v1.0 brief is a
multi-version delivery program. The right decomposition is:
- Charter: "Ship agent-memory v0.1 through v1.0 with semantic recall."
- Plan:
  - `v0.1 — schema + persistence` (phase 1)
  - `v0.2 — recall API` (phase 2, depends on v0.1)
  - `v0.3 — semantic similarity` (phase 2, depends on v0.1, parallel with v0.2)
  - `v1.0 — production hardening` (phase 3, depends on v0.2 + v0.3)
- Each child uses the `feature` workflow.
- Children run in parallel where their phases match.

**Divergence policy: {{divergencePolicy}}.** Determines whether you can
mutate the plan after `goal-plan` has been signalled. See the mid-goal
stanza below.
```

(`{{maxConcurrentChildren}}` and `{{divergencePolicy}}` are interpolated
at prompt-assembly time — they're plain string substitutions in the
system-prompt.ts code, not template variables.)

#### 14.1.2 Child team-lead stanza

Emitted when `parts.parentGoal` is set, **before** the goal-spec block (so
the model reads the parenting context first). Markdown block headed
`## You Are A Child Goal`:

```markdown
## You Are A Child Goal

This goal is part of a larger goal tree.

- **Parent goal:** _{{parentGoal.title}}_ (branch `{{parentGoal.branch}}`)
- **Root goal:** _{{parentGoal.rootTitle}}_

**Branching and merging — read this carefully:**

- Your branch was created off `{{parentGoal.branch}}`. Its commits
  layer on top of the parent's, not on top of `master`.
- When your `ready-to-merge` gate passes, the parent goal's verification
  harness automatically performs a **local** `git merge --no-ff` of your
  branch into `{{parentGoal.branch}}`. **You do not raise a PR.** The
  parent (or the root team-lead, transitively) handles the eventual PR
  to `master`.
- Do **not** run `gh pr create`, `gh pr merge`, or any command that
  pushes to `master`. The `ready-to-merge` gate's "PR raised" verify
  step is short-circuited for child goals — passing it requires only
  that your branch is on origin and has no conflicts with the parent.

**Adherence:**

The parent's acceptance criteria are sacred. Your spec is a slice of
those criteria — never drop a criterion the parent assigned to you,
and never add a criterion that contradicts the parent's spec. If your
in-progress work surfaces a real reason to revise the parent's plan,
**stop**, surface the issue to the parent's team-lead via a normal
human-readable comment, and let the parent decide.

**Parent spec excerpt (for context):**

> {{parentGoal.specExcerpt}}

(Excerpt is the first 800 characters of the parent's spec. Read the
full spec via `bash`/`read` against the parent's worktree if you need
more.)
```

`parentGoal.specExcerpt` is the first 800 chars of `parent.spec`
(verbatim, no smart trimming — the model handles partial sentences
fine). `rootTitle` resolves through `goal.rootGoalId`.

#### 14.1.3 Mid-goal nesting stanza

Emitted when `parts.isTeamLead === true` (every team-lead, regardless of
top-level / child status, regardless of workflow). Markdown block headed
`## Mid-Goal Decomposition`:

```markdown
## Mid-Goal Decomposition

You have **three** decomposition primitives. Pick the right one.

- **`task_create`** — single tracked deliverable, no agent required (or
  a single agent picks it up later). The most common choice.
- **`team_spawn`** — spin up a coder + tester (or any role pair) within
  *this* goal's review cycle. Use when the work is one cohesive change
  set being collaborated on by multiple roles.
- **`goal_spawn_child`** — spawn a **child goal** with its own
  worktree, branch, workflow, and full review cycle. Use only when ALL
  three of the following hold: (1) the work has its own design intent
  (a meaningful unit a reviewer would want to see in isolation),
  (2) it is independently reviewable (its own design-doc / impl /
  review cycle makes sense), and (3) it merges meaningfully on its own
  (the parent branch is sensible with this subgoal merged but its
  siblings still pending).

**Default: keep the decomposition you would have used before nested
goals existed.** Only reach for `goal_spawn_child` when the parent goal
is genuinely a coordination layer over independently shippable units.
In close-call situations, prefer `team_spawn` or `task_create` — over-using
subgoals adds review overhead without paying for itself. Trust your
judgment; don't push toward subgoals when you're not sure.

When you do call `goal_spawn_child`, valid triggers include:

- You discover a sub-deliverable that's large enough to deserve its own
  design-doc → implementation → review cycle (and the three
  conditions above hold).
- A blocking bug needs a focused investigation that shouldn't pollute
  this goal's branch with experiments.
- You want parallel work on independent slices that can each merge
  meaningfully into the parent before the others finish.

**Divergence policy: `{{divergencePolicy}}`** controls when mutations
are allowed after the `goal-plan` gate (if any) has been signalled:

- **`strict`** — Post-freeze mutations are rejected unless you first
  pause the goal (`goal_pause`). Even then, the user must explicitly
  approve via the dashboard banner. Default. Use it when shipping
  predictability matters more than agility.
- **`balanced`** — Adding leaf children at existing phases ("fix-up"
  mutations) auto-approves. Adding new top-level branches or new
  dependencies ("expansion") prompts the user. Removing or reordering
  nodes ("restructure") prompts the user.
- **`autonomous`** — Only "fix-up" auto-approves. **Expansion still
  prompts the user under autonomous** — the difference from `balanced`
  is only that the prompt is accompanied by a WebSocket notification so
  an autonomous-mode operator sees it without watching the dashboard.
  Restructure prompts. (The spec is explicit: every policy prompts on
  expansion. Do not assume autonomous lets you skip user approval for
  new branches.)

**Critical rule — `criteria-drop` is always rejected.** A mutation that
would leave one of the root goal's acceptance criteria uncovered
returns 409 with `classification: "criteria-drop"` regardless of policy.
Do not retry the same mutation; either restructure your proposal so the
dropped criterion is covered by a remaining or new subgoal, or stop and
surface the conflict to the user — the criterion may need to be
explicitly amended on the root goal first.

**`replanCount` cap.** After 5 post-freeze mutations the goal
auto-pauses. If you hit this cap, stop proposing changes and ask the
user to pause / amend the root spec / un-pause.

**The plan is in service of the spec.** Never drop or contradict an
acceptance criterion to make a mutation classifiable as fix-up.

**Restate acceptance criteria verbatim in subgoal specs.** When you draft
a subgoal's `spec` field, **copy the exact wording** of every root-goal
acceptance criterion that subgoal is responsible for — at least once, in
the spec body. Paraphrasing is risky: the adherence checker (see the
mid-goal stanza on `criteria-drop`) does whitespace-normalised,
case-insensitive **substring matching** against the union of the root
spec and the remaining subgoal specs, not semantic similarity. A
paraphrase that drops or rewords a key noun phrase from the criterion
can register as `criteria-drop` even when the work plainly covers it.
The cheapest way to stay on the safe side is to quote the criterion
verbatim somewhere in the spec — even just under a `## Covers` heading.
```

#### 14.1.4 Splice order

In `_assembleSystemPrompt`, the new code (replacing the existing
goal-section block) is:

```ts
{
  let effectiveGoalSpec = parts.goalSpec || "";
  if (parts.rolePrompt?.trim()) {
    effectiveGoalSpec = (effectiveGoalSpec ? effectiveGoalSpec + "\n\n---\n\n" : "") + parts.rolePrompt.trim();
  }

  // 3a. Child stanza appears BEFORE the spec so the model reads context first.
  if (parts.parentGoal) {
    sections.push(buildChildTeamLeadStanza(parts.parentGoal));
  }

  if (effectiveGoalSpec.trim()) {
    const header = parts.goalTitle
      ? `# Goal\n\n**${parts.goalTitle}** (Status: ${parts.goalState || "unknown"})`
      : "# Goal";
    sections.push(header + "\n\n" + effectiveGoalSpec.trim());
  }

  // 3b. Top-level decomposition stanza appears AFTER the spec so the
  //     "if your goal is large enough" heuristic has the spec to reason about.
  if (parts.isTeamLead && parts.isTopLevelTeamLead) {
    sections.push(buildTopLevelTeamLeadStanza({
      maxConcurrentChildren: parts.maxConcurrentChildren ?? 3,
      divergencePolicy: parts.divergencePolicy ?? "strict",
    }));
  }

  // 3c. Mid-goal stanza appears for every team-lead.
  if (parts.isTeamLead) {
    sections.push(buildMidGoalNestingStanza({
      divergencePolicy: parts.divergencePolicy ?? "strict",
    }));
  }
}
```

The three `build*Stanza` helpers are pure string-builders defined in the
same file alongside `buildSkillsCatalogSection` (so they're testable in
isolation). They are exported for unit tests.

#### 14.1.5 Decomposition decision rule (woven into the mid-goal stanza)

Subgoals are a **third** decomposition primitive alongside the
pre-existing `team_spawn` and `task_create`. The mid-goal stanza body
above (§14.1.3) carries the user-visible decision rule as one paragraph
in the section that already discusses task / agent decomposition — not
a separate top-level block. The canonical wording:

> **Use a `subgoal` verify step (or `goal_spawn_child`) when ALL of the
> following hold:**
> 1. The work has its own design intent (a meaningful unit a reviewer
>    would want to see in isolation).
> 2. It is independently reviewable (its own design-doc / implementation
>    / review cycle makes sense).
> 3. It merges meaningfully on its own (the parent branch is sensible
>    with this subgoal merged but its siblings still pending).
>
> **Use `team_spawn`** when the work is within one cohesive review
> cycle (e.g. a coder + a tester collaborating on the same change set).
>
> **Use `task_create`** when the work is a single tracked deliverable
> that doesn't need its own agent.
>
> **Default:** keep the decomposition you would have used before nested
> goals existed. Only reach for subgoals when the parent goal is
> genuinely a coordination layer over independently shippable units.
> Trust the team-lead's judgment — don't push toward subgoals in
> close-call situations.

This rule lives **in code** at the splice point in
`src/server/agent/system-prompt.ts::buildMidGoalNestingStanza` so every
team-lead sees it on every spawn. The doc-writer reproduces the same
rule in `docs/nested-goals.md` (Phase 7 task 7.1) under a heading
`## When to use a subgoal vs team_spawn vs task_create`, with one
worked example per primitive (in-flight reviewer collaboration → team_spawn;
single tracked TODO → task_create; independently shippable v0.1 → subgoal).

### 14.2 New-Goal dialog multi-phase suggestion

Detailed in §10.4 (Advanced disclosure) and §12 task 4.4. The heuristic
predicate lives in `src/app/dialog-helpers.ts`:

```ts
/**
 * Returns true if a goal spec looks like a multi-phase / multi-version
 * delivery program for which the `parent` workflow is the better default.
 *
 * Three independent signals — any one is sufficient:
 *   - spec.length > 5000
 *   - /v0\.\d|v\d\.\d|phase\s*\d|milestone/i.test(spec)
 *   - parseAcceptanceCriteria(spec).length >= 5
 */
export function looksLikeMultiPhaseSpec(spec: string): boolean;
```

Banner UX: non-blocking, dismissible per-project, **does not auto-select**
`parent` workflow. Two buttons: `[Use Parent Goal]` (sets the workflow
picker + opens the Advanced disclosure with sane defaults) and `[Keep
current]` (dismisses). Sample copy is in §10.4 task 4.4.

### 14.3 Goal-assistant heuristic

The conversational goal-creation assistant
(`src/server/agent/goal-assistant.ts`, exporting
`GOAL_ASSISTANT_PROMPT`) is taught the same heuristic. Append to the
existing prompt body, after the introduction paragraph and before any
existing "How to create a goal" section:

```markdown
## Multi-phase work — recommend the `parent` workflow

Some specs describe a multi-version delivery program rather than a
single feature. Recognise these by:

- Mentions of versions (v0.1, v0.2, …) or numbered phases / milestones.
- Length over ~5,000 characters.
- Five or more acceptance criteria covering distinct deliverables.
- Multiple components, repos, or surfaces (API + UI + migration).

When you detect this shape, **before calling `propose_goal`**, raise it
with the user:

> "This looks like a multi-phase delivery — agent-memory v0.1 → v1.0,
> for example, would naturally split into per-version subgoals. Would
> you like me to set this up with the **Parent Goal** workflow? It adds
> a planning gate where you approve a DAG of child goals before any
> coding starts, then runs them in parallel up to your concurrency
> cap."

If the user says yes, set `workflow: "parent"` on the proposal and
include in the spec a `## Acceptance criteria` section enumerating the
top-level deliverables. The team-lead will then propose the per-phase
plan in its `charter` and `plan-review` gates.

If the user prefers a single goal, proceed with `feature` (or whichever
workflow they pick) — but mention that they can still call
`goal_spawn_child` mid-flight if the work explodes in scope.
```

The assistant's `propose_goal` tool already accepts a `workflow`
parameter, so no tool-schema change is needed.

### 14.4 `parent.yaml` self-documenting description + gate criteria

§6 specifies the workflow shape; this subsection nails down the
**self-documenting prose** that lives inside the workflow itself, so a
model reading the workflow definition cold understands the orchestration
intent without external docs.

`description` field (3–5 sentences):

```yaml
description: |
  Orchestrates a goal that decomposes into child subgoals. The team-lead
  drafts a charter (user-visible outcome + acceptance criteria), proposes
  a DAG of child goals at "plan-review", and waits for the user to
  approve the plan via the `goal-plan` gate. Once approved, the
  execution gate's verify[] freezes; the verification harness then
  spawns the planned children in parallel up to maxConcurrentChildren,
  each branching off this goal's branch and merging back when their own
  `ready-to-merge` gate passes. The parent's `ready-to-merge` raises
  the single PR to master once all children have merged. Use this
  workflow for multi-version deliveries, multi-component features, or
  any work that benefits from explicit phase planning.
```

Per-gate `description` / quality criteria (added as gate-level
`description` strings — `WorkflowGate` doesn't have a description today;
add an optional `description?: string` field to `WorkflowGate` and
render it in the dashboard's gate detail panel). Bodies:

- **charter:** "Define the user-visible outcome in plain English, list
  3–7 acceptance criteria that are independently verifiable, and identify
  the natural decomposition into child goals. The plan-review gate will
  read this charter as upstream context — be explicit about scope so the
  reviewer can flag missing coverage."

- **plan-review:** "Submit the proposed plan as a list of `subgoal`
  verify steps on the execution gate (call `goal_plan_propose`).
  LLM reviewers check: every node has a non-empty title and spec; phase
  numbers form a valid layered DAG; every charter acceptance criterion is
  assigned to at least one child; workflow ids resolve. The review is
  advisory — the user's `goal-plan` signal is the authoritative
  approval."

- **goal-plan:** "Manual gate. Signalling this gate freezes the
  execution gate's verify[] — post-freeze plan mutations are subject to
  the goal's divergence policy and the plan-mutation classifier. The
  user signals this gate from the dashboard's Plan tab once they're
  satisfied with the proposed DAG."

- **execution:** "The plan runs here. Each `subgoal` verify step spawns
  a child goal at the appropriate phase, branched off this goal's
  branch. Phase parallelism is bounded by `maxConcurrentChildren`. A
  child step passes when its `ready-to-merge` gate passes AND the local
  merge into this goal's branch succeeds without conflict. Merge
  conflicts surface back to the team-lead, who escalates to the user."

- **integration:** "Run typecheck/build/tests on this goal's branch
  after all children have merged. Catches integration issues that
  per-child verification couldn't see."

- **ready-to-merge:** "Top-level goals raise a PR to master from this
  branch. Child goals (mergeTarget == 'parent') short-circuit this gate
  — the parent's harness performs the local merge instead. Either way,
  this gate signals the goal is done."

### 14.5 Worked example outline (for `docs/nested-goals.md`, Phase 7)

Phase-7 task 7.1 produces `docs/nested-goals.md`. That file MUST include
a worked walkthrough, sketched here for the doc-writer to flesh out:

> **Walkthrough — agent-memory v0.1→v1.0**
>
> 1. **User pastes** the contents of `agent-memory/SPEC.md` into the
>    goal-creation assistant. The spec is ~12,000 chars, mentions v0.1,
>    v0.2, v1.0, and lists 11 acceptance criteria.
> 2. **Assistant detects multi-phase shape** (heuristic in §14.3) and
>    suggests the `parent` workflow. User accepts.
> 3. **Goal created** with workflow `parent`, divergencePolicy `balanced`,
>    maxConcurrentChildren 3.
> 4. **Team-lead receives stanzas** (top-level + mid-goal). Reads the
>    spec, drafts charter:
>    - Outcome: "Ship agent-memory from v0.1 schema-only through v1.0
>      production hardening."
>    - Acceptance criteria: 11 items, grouped by version.
>    - Decomposition: 4 child goals (v0.1, v0.2, v0.3, v1.0).
>    Signals `charter`. LLM reviewer passes.
> 5. **Team-lead proposes plan** via `goal_plan_propose`:
>    ```
>    [{ planId: …, phase: 1, subgoal: { title: "v0.1 — schema + persistence", workflowId: "feature", spec: "<sliced spec>", … } },
>     { planId: …, phase: 2, subgoal: { title: "v0.2 — recall API", workflowId: "feature", spec: …, … } },
>     { planId: …, phase: 2, subgoal: { title: "v0.3 — semantic similarity", workflowId: "feature", spec: …, … } },
>     { planId: …, phase: 3, subgoal: { title: "v1.0 — production hardening", workflowId: "feature", spec: …, … } }]
>    ```
>    Signals `plan-review`. LLM reviewers pass.
> 6. **User reviews the Plan tab**, sees a 3-column DAG (phase 1 / 2 / 3),
>    expands each card, edits the v0.3 spec slightly, clicks "Approve plan"
>    → signals `goal-plan`. Execution gate freezes.
> 7. **Harness spawns v0.1 child.** Phase 1 has one node so concurrency
>    cap of 3 isn't binding. v0.1 child branches off
>    `goal/agent-memo-…` → its own branch `goal/v0-1-….` Child team-lead
>    receives the child stanza ("you are part of agent-memory; merges
>    into parent, no PR to master"). Runs `feature` workflow to
>    completion.
> 8. **v0.1 merges into parent.** Local merge succeeds. v0.1's
>    `ready-to-merge` short-circuited — no PR raised.
> 9. **Harness spawns v0.2 and v0.3 in parallel** (phase 2, two nodes
>    ≤ cap 3). Both branch off the **post-merge** parent tip — they see
>    v0.1's commits.
> 10. **v0.3 child decomposes itself** (recursive nesting). Its
>     team-lead notices semantic similarity has 4 sub-deliverables and
>     calls `goal_spawn_child` for each. Now we have a 3-level tree:
>     root → v0.3 → similarity-subgoal-{1,2,3,4}. Grandchildren merge
>     into v0.3, v0.3 merges into root.
> 11. **v0.2 finishes**, merges into root. v0.3 finishes (after its
>     grandchildren), merges into root.
> 12. **Phase 3 spawns v1.0**, which has v0.2+v0.3 as deps (encoded as
>     phase ordering). v1.0 finishes, merges into root.
> 13. **Integration gate** runs build / typecheck / tests on root branch
>     — catches one cross-version bug. Team-lead opens a fix-up
>     `goal_spawn_child` (auto-approved under `balanced`, fix-up class).
> 14. **Ready-to-merge** raises **one** PR from root → master.

Doc-writer should include:
- A goal-tree ASCII diagram.
- The branch-chain diagram showing how each child's branch advances the
  parent tip on merge.
- The sequence of WS events the user sees in the dashboard.

### 14.6 Manual smoke-test acceptance (Phase 7 task 7.6)

The runbook described in task 7.6 of §12 verifies the five behavioural
checks below. Each check has a concrete observation criterion:

| # | Check | Observation criterion |
|---|---|---|
| a | goal-assistant suggests `parent` workflow | The assistant message preceding the `propose_goal` tool call contains the substring "Parent Goal" or "parent workflow" and explicitly mentions the multi-phase shape. |
| b | spawned team-lead's system prompt contains both nesting stanzas | Inspect `<stateDir>/session-prompts/<sessionId>.md`; assert both `## Goal Decomposition` (top-level stanza heading) and `## Mid-Goal Decomposition` (mid-goal stanza heading) are present. |
| c | team-lead proposes a multi-version plan within its first 3 turns | The first `goal_plan_propose` tool call from the team-lead session occurs at turn ≤ 3 and contains ≥ 3 subgoal steps with version-y titles (`v\d\.\d` regex match in step title). |
| d | child team-leads receive the child stanza | For at least one spawned child, inspect its session-prompt file; assert `## You Are A Child Goal` heading present. |
| e | recursive nesting works | At least one grandchild (depth-2 descendant) exists in `state.goals` with the correct `parentGoalId`/`rootGoalId` chain. |

The runbook records pass/fail per check in a markdown table that gets
copy-pasted into the merge PR description.

### 14.7 Tool-group policy defaults — explicit

(Cross-references §5.) Defaults shipped in
`defaults/tool-group-policies.yaml`:

```yaml
Children:
  default: never           # any role not listed below
  team-lead: allow         # team-leads of any goal may use the entire group
```

Per-tool guidance copy in YAML descriptions (mirrors the prompt stanzas
so a model reading the tool definition cold knows when to use it):

- `goal_spawn_child`:
  > "Spawn a child goal under the current goal. The child branches off
  > your branch HEAD and merges back when its `ready-to-merge` passes —
  > you keep ownership of integration. Use this when a sub-task is
  > large enough to deserve its own workflow + verification cycle
  > (typically 200+ LoC, multiple files, or a discrete deliverable).
  > Subject to your goal's divergence policy when the `goal-plan` gate
  > has already been signalled — see the Mid-Goal Decomposition section
  > of your system prompt."

- `goal_plan_propose`:
  > "Replace the verify[] of a named gate (default `execution`) with
  > the proposed list of subgoal steps. This is how you author a
  > planned decomposition for a `parent`-workflow goal. Pre-freeze
  > (before `goal-plan` is signalled) the plan is freely editable.
  > Post-freeze, mutations are classified by shape (fix-up / expansion /
  > restructure / criteria-drop) and gated by your divergence policy.
  > A `criteria-drop` mutation — one that would leave a root acceptance
  > criterion uncovered — is rejected unconditionally; do not retry."

- `goal_plan_status`:
  > "Return the current plan and the live state of any spawned children.
  > Cheap to call; use this before proposing a mutation to ensure you're
  > working from the latest snapshot."

- `goal_merge_child`:
  > "Locally merge a completed child's branch into your branch. Called
  > automatically by the harness when a `subgoal` verify step fires —
  > you generally don't call this by hand. Fails on conflict; never
  > auto-resolve. On conflict, escalate to the user via
  > `ask_user_choices`."

- `goal_pause` / `goal_resume`:
  > "Suspend / resume verification-harness ticks for this goal-tree.
  > Required by `strict` policy before applying restructure mutations.
  > Use sparingly — pausing halts all running child verifications."

---

