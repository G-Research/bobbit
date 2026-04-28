# tests/e2e — known-skipped tests

## project-bugs.spec.ts

### Bug 2: Subdirectory project worktree CWD offset (skipped)

`goal.cwd` is not remapped into `worktreePath` after async worktree setup
completes. After `setupStatus="ready"`, `readyGoal.cwd` still points at the
originally-passed subdirectory path (e.g. `/tmp/repo/packages/my-app`)
rather than the equivalent path inside the worktree
(`/tmp/repo-wt/goal-…/packages/my-app`).

This is a real production bug in `goal-manager`, not a flaky test. The
test is skipped (`test.skip`) until the cwd-remap is implemented. See
the TODO comment above the skipped test for the intended behaviour.
