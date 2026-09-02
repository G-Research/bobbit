# Preserve user worktrees

## Status

**Current, implemented policy.** This document is the canonical authority for boot worktree discovery, Maintenance cleanup eligibility, pool restart adoption, and graceful pool shutdown. It supersedes conflicting worktree-ownership and pool-restart guidance in older design artifacts.

Related lifecycle details remain in [Async background cleanup](async-background-cleanup.md) and [Remove session worktree & branch renaming](remove-session-worktree-rename.md), but neither branch naming nor asynchronous discovery expands the authority defined here.

## Ownership boundary

Bobbit may mutate a discovered worktree only when an existing durable record proves its exact repository, worktree path, and non-empty branch. Branch naming, root placement, directory shape, and Git discovery are diagnostic hints only.

Host team workers persist those coordinates in the initial session record. Archived-session Maintenance cleanup immediately revalidates the exact repository/path/branch identity before mutation. Incomplete or mismatched records fail closed and the worktree remains non-actionable.

A live `WorktreePool` owns entries it created and still holds in its private ready array. It also writes that exact ownership to server-global `state/worktree-pools.json` so a later gateway may revalidate and re-adopt ready entries. `registerExternalEntry()` is a non-persisting test seam: shape-only input can never manufacture durable authority.

A claim removes the entry from the durable pool record before any branch or directory mutation. Ownership then transfers to the session or goal record. A drain removes the durable record before destructive cleanup. These orderings prefer an unowned diagnostic leftover over stale authority after a crash.

## Boot diagnostics and pool adoption

The boot sweeper remains diagnostic-only. It may inspect Git worktrees and durable records, but it never adopts, repairs, cleans, or deletes a discovered worktree.

Pool initialization is a separate, narrow consumer of the pool's own strict v1 record. An entry is adopted only when all applicable checks pass:

- the recorded project repository exactly matches the current normalized repository path;
- its branch is a pool branch and each worktree path is non-empty;
- a single-repository entry is reported by that repository's `git worktree list` at the exact normalized path and branch;
- a multi-repository entry has unique members in current component order, with each recorded repository matching the current component repository and each worktree at the expected path beneath the recorded container;
- every member repository's own `git worktree list` reports that exact member path and branch; and
- no non-archived persisted session or runtime session references the container, a member, or a descendant cwd.

Multi-repository adoption is all-or-nothing. A malformed or future-version file, partial project record, duplicate member, Git-list failure, mismatch, or live reference authorizes no adoption. Rejected records are removed from the next published pool record, while every referenced path and branch is left untouched. An unrecorded pool-shaped worktree is never adopted.

Exact archived-session identities remain expected-retention diagnostics, not pool authority. Explicit Maintenance cleanup keeps its existing preview, eligibility, sharing guards, and immediate revalidation.

## Pool lifecycle

### Creation and claim

After worktree creation and setup succeeds, `WorktreePool` adds the ready entry and publishes its complete identity. Coalesced writes use an atomic temporary-file rename within the configured gateway state directory. Graceful shutdown flushes the writer so the last fill or claim cannot remain only in memory.

Before a claim mutates Git, the entry leaves the ready array and the record is republished without it. A crash in this window may leave an unrecorded worktree, but a later process cannot hand it out based on shape.

### Graceful gateway shutdown

`createGateway().shutdown()` is memoized: concurrent signal handlers, API callers, tests, and late callers all observe one teardown promise and one outcome. The CLI's first signal starts graceful shutdown; the next signal exits immediately rather than starting competing teardown.

After new work is fenced and boot initialization settles, the gateway:

1. snapshots the live per-project pools;
2. starts a bounded `stop()` on every pool, joining fill, freshen, claim, and claim-failure cleanup work;
3. flushes `state/worktree-pools.json`; and
4. continues the remaining teardown without draining ready entries.

Each stop and the record flush has a 15-second bound. Failures are logged and isolated. Successfully recorded ready entries remain on disk for revalidation at the next start; claimed session and goal worktrees survive under their own records.

### Explicit project deletion

Project deletion remains destructive. `SessionManager.removeWorktreePool(projectId)` awaits `WorktreePool.drain()`, removes the live pool, and forgets the project record. `drain()` first stops mutation-capable work, revokes record authority, then cleans only entries held by that pool. Single- and multi-repository drain and claim-failure cleanup force `skipRemotePush: true`.

A crash, forced exit, failed stop, failed record write, or rejected adoption can leave worktrees behind. That is the safe failure mode: without current exact authority they remain **Needs attention** diagnostics and Bobbit neither repairs nor deletes them automatically.

## Focused verification

Canonical coverage pins:

1. strict v1 parsing, same-directory atomic persistence, flush/reload, and no process-cwd record artifact;
2. exact single- and all-member multi-repository Git validation;
3. live persisted/runtime worktree, component, container, and cwd exclusion;
4. rejection of shape-only, stale, malformed, duplicate, moved, or mismatched entries without mutation;
5. durable removal before claim and drain transitions;
6. graceful stop plus flush without drain, and explicit project deletion drain plus forget; and
7. concurrent and late shutdown callers sharing one teardown outcome.

Run the focused worktree/shutdown suites, `npm run test:layout`, and `npm run check`; full workflow verification remains authoritative for broader regression coverage.
