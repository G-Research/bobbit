# tests/e2e — E2E test guide

## Test projects

The e2e config (`playwright-e2e.config.ts`) defines three Playwright projects:

- **`api`** — In-process gateway, no browser. Runs API E2E specs. `retries: 0`.
- **`api-realpush`** — Same as `api` but with real `git push --delete`
  (no `BOBBIT_TEST_NO_PUSH=1`). Owns `goal-archive-branch-cleanup`.
- **`browser`** — In-process gateway + Chromium UI. Runs UI specs. Workers: 3,
  `fullyParallel: false`. `retries: 0`.

## No quarantine, no retries, no skip-for-flake

There is no quarantine project and no `@quarantine` tag. Top-level
`retries: 0` is the hard rule. Every flake gets root-caused and fixed in
place. If a test is too flaky to fix immediately, the right move is to
revert the change that introduced it — not to hide the failure behind a
separate project.

Do not add `test.skip("flaky…")`. Do not add `retries: N` to a describe
block. Do not bump a timeout to make a slow product faster. If you find
yourself wanting to do any of these, file a goal and stop.

## Sleep guard

`tests/e2e/test-utils/no-new-sleeps.mjs` runs in `globalSetup` and rejects
new hardcoded sleeps. The current baseline is `no-new-sleeps.baseline.json`
(5 sleeps across 5 files, all intentional negative-window assertions or
test-fixture latency). Replace inline sleeps with the helpers below.

## Sleep replacement helpers

From `tests/e2e/e2e-setup.ts`:

- `pollUntil(predicate, { timeoutMs, intervalMs, label })` — canonical
  replacement for `await sleep(N); assert(...)`. Polls until truthy.
- `connectWs(sessionId)` → `{ waitFor(pred, ms?), waitForFrom(idx, pred, ms?) }`
  — race-safe WS event waits.
- `waitForGateStatus`, `waitForSessionStatus`, `signalAndWaitForGate` —
  domain-specific event waits.

For browser tests, prefer Playwright auto-retrying assertions:
`expect(locator).toBeVisible()`, `toHaveText()`, `toHaveValue()`. They
retry up to the timeout without explicit sleeps.

## Server-side test hooks

Some flakes need a deterministic signal the production code doesn't expose.
Add a test-only export to the relevant module, gated on intent (no env
flag needed — the export simply isn't called by production code):

- `__setGitStatusFake`, `__getGitStatusInvocationCount`,
  `__resetGitStatusInvocationCount`, `invalidateGitStatusCache`,
  `__forceGitStatusCacheExpiry` (in `src/server/server.ts`) for
  git-status caching tests.
- `window.bobbitState` (in `src/app/state.ts`) — read-only state reference
  for browser-side test diagnostics. Used in failure-diagnostic
  `page.evaluate` blocks to dump actual client state on assertion timeout.

## Known-skipped tests

### project-bugs.spec.ts — Bug 2: Subdirectory project worktree CWD offset

`goal.cwd` is not remapped into `worktreePath` after async worktree setup
completes. After `setupStatus="ready"`, `readyGoal.cwd` still points at the
originally-passed subdirectory path (e.g. `/tmp/repo/packages/my-app`)
rather than the equivalent path inside the worktree
(`/tmp/repo-wt/goal-…/packages/my-app`).

This is a real production bug in `goal-manager`, not a flaky test. The
test is skipped (`test.skip`) until the cwd-remap is implemented. See
the TODO comment above the skipped test for the intended behaviour.
