# Preserve user worktrees

## Status

Selected design for the amended **Preserve User Worktrees** goal.

## Problem

Bobbit previously treated worktree branch and directory naming as ownership proof. Boot sweeping, Maintenance cleanup, and pool startup reclaim could therefore repair, remove, or adopt a manually created worktree merely because it looked Bobbit-related.

The fail-closed correction removes shape-based mutation and adoption. That exposes a separate orderly-restart lifecycle issue: gateway shutdown intentionally left ready pool entries on disk because the next process reclaimed them. Once startup reclaim is disabled, each successful restart would otherwise leave the old ready pool unreachable and create another target-sized pool.

## Ownership boundary

Bobbit may mutate a discovered worktree only when an existing durable record proves its exact repository, worktree path, and non-empty branch. Branch naming, root placement, and Git discovery are diagnostic hints only.

A live `WorktreePool` has one additional, narrow source of authority: entries still held in that instance's private `pool` array. Those entries were created and tracked by the current process. A successful `claim()` removes its entry from the array before it becomes a session or goal worktree, so claimed worktrees are outside shutdown-drain authority.

No filesystem scan, Git worktree discovery, branch-prefix test, or prior-process pool entry may populate the shutdown drain set.

## Selected design: graceful current-instance drain

Use the existing pool lifecycle rather than adding durable ownership state.

### Pool cleanup policy

`src/server/agent/worktree-pool.ts::WorktreePool.drain()` retains its existing flow:

1. Call `stop()` and await all tracked fill, freshen, claim, and failure-cleanup operations.
2. Snapshot and remove only entries currently present in the private pool.
3. Clean entries with the existing bounded concurrency.
4. For multi-repository entries, keep components of one set sequential while allowing bounded concurrency between sets.
5. Isolate cleanup failure per entry or component.

Every drain cleanup derives a policy from the configured remote policy with `skipRemotePush: true`. Pool branches are created local-only, so draining them must perform no remote URL probe, push, or deletion.

This policy also applies to explicit project-removal drains; a ready pool branch is never intentionally published.

### Gateway shutdown order

In `src/server/server.ts::createGateway().shutdown()`:

1. Stop accepting new connections and stop schedulers as today.
2. Await boot background initialization so no pool is added after the snapshot.
3. Snapshot `sessionManager.getAllWorktreePools()`.
4. Call `stop()` on every snapshotted pool before the first drain starts. Use all-settled handling and log failures.
5. Drain each pool through a bounded, failure-isolated phase. A stop or drain failure for one project must not prevent later pools or remaining gateway teardown.
6. Complete session-manager and project-context shutdown in the existing order, with pool cleanup finished before project contexts close.

Stopping every pool first provides a tree-wide lifecycle fence. Calling `drain()` afterward is safe and idempotent because it repeats `stop()` before snapshotting its private entries.

### Failure semantics

This is deliberately best effort:

- A successful graceful shutdown removes current-instance ready entries and prevents normal restart accumulation.
- A claimed entry is absent from the private pool and survives as its session or goal worktree.
- A cleanup failure may leak the affected ready entry; it must not broaden ownership or block unrelated cleanup.
- A hard crash, `SIGKILL`, forced timeout, or interrupted drain may leave pool-shaped worktrees.
- A later process does not adopt, repair, or delete those leftovers by shape. They remain ownership-unverified diagnostics.

Repeated *successful* graceful restarts therefore do not accrue another unreachable target-sized set from the preceding instance. Crash cleanup is not guaranteed.

## Other fail-closed changes

The graceful drain composes with the original correction:

- `src/server/agent/worktree-sweeper.ts` scans and reports discovered orphans without repair, cleanup, or branch deletion.
- `src/server/agent/worktree-inventory.ts` classifies unproven Git worktrees as non-actionable `needs-attention` diagnostics.
- Archived-session cleanup requires an exact repository/path/non-empty-branch record and immediately revalidates the originally selected triple.
- `src/server/agent/worktree-pool.ts::initialize()` does not discover or adopt pool entries by branch/path/root shape.

Primary worktrees, live session/goal/team/staff records, delegates and shared paths, container paths, multi-repository component paths, and current-instance fill/claim/freshen behavior retain their existing protections.

## Rejected alternative: durable pool manifest

A durable manifest could preserve warm ready pools across restarts, but a safe implementation is not merely a list of paths. Paths can be deleted and reused.

A fail-closed manifest would require:

- versioned per-entry records containing project plus exact repository/path/branch triples for every component;
- atomic create-if-absent publication after worktree creation and setup;
- atomic consumption before claim or drain mutation;
- strict parsing, corruption handling, and exact Git revalidation at startup and immediately before mutation;
- all-or-nothing multi-repository records;
- create, adopt, claim, failure-cleanup, and drain transitions;
- protection against concurrent processes resurrecting a consumed record;
- explicit handling for every crash window.

That design preserves warm restarts and can recover some crash leftovers, but adds a durable state owner and several authorization transitions. Graceful draining reuses existing, tested runtime ownership and lifecycle barriers, adds no persistence or adoption authority, and is the smaller correction for the requested happy path.

A manifest remains viable as a separate goal if warm restart reuse becomes a requirement.

## Implementation surface

Production changes remain limited to:

- `src/server/agent/worktree-sweeper.ts`
- `src/server/agent/worktree-inventory.ts`
- `src/server/agent/worktree-pool.ts`
- `src/server/server.ts`, only for the shutdown pool phase and obsolete explanation

No new API, UI, durable state, provenance marker, locking framework, or manual deletion flow is introduced.

## Focused verification

Add registered v2 coverage proving:

1. Startup does not adopt or mutate an exact pool-shaped worktree discovered from Git/filesystem shape alone.
2. Same-instance fill and claim continue to work.
3. `drain()` cleans only entries still held by that instance; a claimed entry is excluded.
4. Single- and multi-repository drain cleanup always receives `skipRemotePush: true`.
5. All pools are stopped before the first gateway-shutdown cleanup.
6. One pool's stop/drain failure does not prevent later drains or subsequent shutdown phases.
7. Bounded cleanup and existing explicit project-removal drain behavior are preserved.

Run the focused worktree suite and `npm run check`; full workflow verification remains authoritative for broader regression coverage.
