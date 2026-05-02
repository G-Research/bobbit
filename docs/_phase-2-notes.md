# Nested Goals — Phase 2 implementation notes

This document records the design decisions made in Phase 2 of the
nested-goals feature so Phase 3+ implementers (and the AGENTS.md collator
in Phase 8) have a single reference. Phase 1 notes live in
`docs/_phase-1-notes.md`.

## Branch topology (from SUBGOALS-SPEC §3.2, copied here verbatim)

```
master ─────●──────────────────────────────●──────►
             \                              /
              ●─ goal/root ──●──●──●───────●  (PR: root → master)
                              \  \  /
                               ●──●  goal/child  (local merge into root, NO PR)
                                  \
                                   ●  goal/grandchild  (local merge into child)
```

Invariants enforced in Phase 2 code:

- A child's branch is created off **the current parent branch HEAD** at
  spawn time (not off `origin/master`, not off the root). Subsequent
  siblings spawned later see their predecessors' commits.
- A child's `ready-to-merge` triggers a **local** merge into the parent.
  No remote PR is raised. Phase 3's `runSubgoalStep` calls
  `goalManager.mergeChild()` and then `archiveGoalAfterMerge()`.
- After a clean local merge, push the parent branch to origin (gated by
  `shouldSkipRemotePush()`). This is **not** a PR-raising push — it just
  makes the post-merge tip available to CI and to siblings spawned later.
- Only the **root** goal (`parentGoalId == null`) raises a PR to
  `master`. The team-lead's system-prompt stanza in Phase 6 enforces
  this — child team-leads NEVER call `gh pr create`.

## `mergeChildBranchLocal` contract — DO NOT auto-resolve conflicts

`src/server/skills/git.ts::mergeChildBranchLocal(parentBranch,
childBranch, parentCwd) → Promise<MergeChildResult>`:

- Verifies `parentCwd` is checked out on `parentBranch` (mismatch
  throws — guards against merging into the wrong tree).
- Best-effort `git fetch origin <child>` so a sibling's pushed branch
  shows up; fetch failure is non-fatal because sibling branches may be
  local-only.
- Runs `git merge --no-ff <child> -m "Merge child goal branch …"`.
- Returns one of:
  - `{ merged: true, alreadyMerged: false, conflict: false }` —
    produced a true merge commit (--no-ff guarantees 2 parents).
  - `{ merged: false, alreadyMerged: true, conflict: false }` — output
    matched `Already up[- ]to[- ]date`; no commit.
  - `{ merged: false, alreadyMerged: false, conflict: true }` — exit
    code != 0 AND `git status --porcelain` reported unmerged paths
    (`UU `, `AU `, etc.). Runs `git merge --abort` so the parent
    worktree is left clean.
- A non-conflict failure (e.g. unknown ref) **throws** — true config
  bugs surface, not silent.

**Anti-pattern (SUBGOALS-SPEC §9 #8):** never auto-resolve merge
conflicts. The implementation aborts on conflict so the parent worktree
returns to a known-clean state, and the caller is expected to surface
the failure to the user / team-lead.

## `archiveGoalAfterMerge` order (state=complete BEFORE archive)

`GoalManager.archiveGoalAfterMerge(childId)` performs three steps in
this exact order:

1. `store.update(childId, { state: "complete" })` — stamp state FIRST
   so the archived snapshot has `state=complete` on disk.
2. `archiveGoal(childId)` — flips `archived: true`, sets `archivedAt`.
3. Logs success and returns.

**Why the order matters (Lesson 4.2):** the harness short-circuits on
`archived && state === "complete"` to mark a subgoal step success
terminal. If archive flips first, a server crash between steps 1 and 2
leaves a record with `archived=true && state="in-progress"`. The
harness then takes the rescue path (re-spawn or fallthrough) and may
produce a duplicate child. The order in this method ensures that even
if step 2 is interrupted, step 1 has already persisted the
success-terminal state, and the harness will short-circuit on the next
read.

The method is **idempotent** — a second invocation finds the row
already complete and archived and silently returns. This makes it safe
for retry on partial failures.

The method does NOT call `teamManager.teardownTeam()` itself. Phase 3's
`runSubgoalStep` is responsible for invoking teardown after this
returns.

## Worktree pool skipped for children — explain why

The worktree pool (`worktree-pool.ts::claim()`) pre-builds worktrees
off `master` / the project's primary branch. A child goal spawned via
`runSubgoalStep` MUST start from the parent's branch HEAD so siblings
spawned later see prior siblings' commits (SUBGOALS-SPEC §3.2). If a
child claimed from the pool, its worktree would be missing the
parent's commits — breaking the invariant.

Implementation: `_doSetupWorktree` consults `_resolveChildBaseBranch`
first; when that returns a non-undefined string (the child case), the
pool resolver is short-circuited to `null` and we fall through to a
fresh `createWorktree(repoPath, branch, { startPoint: parent.branch
})`.

Top-level (root) goals continue to use the pool and behave exactly as
before. The change is observable only on `parentGoalId !== undefined`.

## Sandbox: `parent.branch` as baseBranch is the only requirement

Original SUBGOALS-SPEC §3.4 said reject sandboxed nested goals with
HTTP 400. **The user has reversed this — sandbox MUST work.**

Investigation result (verified by `tests/sandbox-create-child-worktree.test.ts`):

- `ProjectSandbox.createWorktree(name, branch, baseBranch?)` already
  accepts a `baseBranch` parameter (line 187 of
  `src/server/agent/project-sandbox.ts`) and threads it into
  `git worktree add -b <child> <wt-path> <baseBranch>` issued via
  `_dockerExec`.
- Sandboxed worktrees share `/workspace/.git`, so the parent goal's
  branch ref IS visible to child worktree creation IF the parent's
  commits exist locally — which they will, because the parent's worktree
  shares the same `.git` directory.
- The existing post-commit hook in `ProjectSandbox._installPostCommitHook`
  (line 757) pushes to origin on every commit, so siblings spawned
  later see the latest parent tip via `origin/<parent-branch>` even if
  they're created in a different container session.

What Phase 3 needs to ensure for sandbox:

1. When the harness creates a child goal's worktree, it ALWAYS passes
   `baseBranch: parent.branch` to BOTH the host `createWorktree` AND
   the sandbox `createWorktree` paths. (This is now done in
   `goal-manager.ts::_doSetupWorktree` for the host path; Phase 3 will
   do the same for the sandbox path.)
2. SKIP THE WORKTREE POOL FOR CHILD GOALS — done in Phase 2.
3. After parent's team-lead commits, the post-commit hook pushes to
   origin so siblings spawned later see the latest tip. Already in
   place; no change required.

The sandbox test (`tests/sandbox-create-child-worktree.test.ts`) pins
the wire format so a future refactor can't accidentally regress this.

## Boot-time backfill for legacy archived goals (Lesson 4.2)

`GoalManager.backfillCompleteState(gateStore)` walks every archived
goal whose `state !== "complete"` and whose `ready-to-merge` gate is
`passed`, stamping `state: "complete"`. Per-goal try/catch ensures one
corrupt record can't crash boot (Lesson 4.11 endless-restart guard).

Why deferred to a separate method (vs. running in the constructor):
`GoalManager` does not currently take a `GateStore` reference. Adding
one is invasive (changes every caller). Deferring to an explicit
caller-invoked method keeps Phase 2 scoped — the caller (server boot
sequence) has both stores in hand and can wire them up.

The intended boot integration is one line in `src/server/server.ts`
after both `goalManager` and `gateStore` are constructed:

```ts
goalManager.backfillCompleteState(gateStore);
```

Phase 3+ may extend the method to scan additional gate types if the
v0.2 / v0.3 plan introduces them.

## AGENTS.md "Recipes" + "Debugging" entries to add (Phase 8 will collate)

Phase 8 (Documentation) will add the entries below to `AGENTS.md`.
Recording them here to keep Phase 2 self-contained:

### Recipes

- **Merge a child goal locally into its parent** → `GoalManager.mergeChild(parentId, childId)` wraps `mergeChildBranchLocal` in `src/server/skills/git.ts` and best-effort pushes the parent branch. Cross-tree merges blocked at the manager layer (`PARENT_MISMATCH`). See [docs/_phase-2-notes.md](docs/_phase-2-notes.md).
- **Archive a successfully merged child** → `GoalManager.archiveGoalAfterMerge(childId)` — state=complete BEFORE archive, idempotent. The harness short-circuits on `archived && state === "complete"`.
- **Spawn a child goal off parent's branch** → `GoalManager.createGoal({ parentGoalId, ... })` — auto-derives rootGoalId/mergeTarget (Phase 1) AND uses `parent.branch` as the worktree start point (Phase 2). Pool is skipped for children.

### Debugging

- **Child goal worktree missing parent's commits** — three checks: (1) confirm `child.parentGoalId` is set on the goal record; (2) confirm `parent.branch` is non-empty; (3) confirm `_resolveChildBaseBranch` is being consulted in `_doSetupWorktree` (returns `parent.branch` for children). Pool is bypassed for children — pool fills log shows no claim for this branch. See `tests/goal-manager-create-child-uses-parent-branch.test.ts`.
- **Sandboxed nested goal opens a worktree without parent's commits** — confirm the harness passes `baseBranch: parent.branch` to `ProjectSandbox.createWorktree`. The post-commit hook (`_installPostCommitHook`) pushes parent commits to origin so cross-container child spawns see them. Sandbox test: `tests/sandbox-create-child-worktree.test.ts`.
- **Conflict on `mergeChild` leaves parent worktree dirty** — `mergeChildBranchLocal` runs `git merge --abort` on conflict; if `git status --porcelain` still reports unmerged paths after `mergeChild` returns `{ conflict: true }`, the abort itself failed (broken worktree). See `tests/git-merge-child-branch-local.test.ts`.
- **Legacy archived goal stuck — harness re-spawns instead of short-circuiting** — likely missing `state: "complete"` on the archived record. Run `goalManager.backfillCompleteState(gateStore)` once on boot to flip every archived goal whose `ready-to-merge` is passed. See `tests/goal-manager-backfill-state-complete.test.ts`.
