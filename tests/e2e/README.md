# tests/e2e — E2E test guide

## Test projects

The e2e config (`playwright-e2e.config.ts`) defines three Playwright projects:

- **`api`** — In-process gateway, no browser. Runs API E2E specs. Workers: 4,
  `fullyParallel: true`.
- **`api-realpush`** — Same as `api` but with real `git push --delete`
  (no `BOBBIT_TEST_NO_PUSH=1`). Owns `goal-archive-branch-cleanup`.
- **`browser`** — In-process gateway + Chromium UI. Runs UI specs. Workers: 3,
  `fullyParallel: false`.

The committed config runs `retries: 3` everywhere (top-level) — see
[Retries: deliberate margin for concurrent suites](#retries-deliberate-margin-for-concurrent-suites).

## No quarantine, no skip-for-flake

There is no quarantine project and no `@quarantine` tag — and as of the
flake-hardening effort, no spec carries one. Every flake gets
root-caused and fixed in place. If a test is too flaky to fix
immediately, the right move is to revert the change that introduced it
— not to hide the failure behind a separate project.

Do not add `test.skip("flaky…")`. Do not add `@quarantine` labels or a
per-describe / per-project `retries: N` override. Do not bump a timeout
to make a slow product faster. If you find yourself wanting to do any of
these, file a goal and stop. The top-level `retries: 3` (below) is a
resilience margin for concurrent runs, **not** a licence to leave a
first-attempt flake un-root-caused.

## Retries: deliberate margin for concurrent suites

The committed config runs `retries: 3` everywhere, and this is the
deliberate current policy — **not** temporary debt. The rationale: the
dev laptop must support running up to ~4 e2e suites **concurrently**
(overlapping worktrees / parallel goals). Under that mutual contention a
suite can hit a transient cross-suite race (CPU/FS pressure, a
goal-assistant cold-start timeout) that has nothing to do with a real
bug. `retries: 3` absorbs those transients so one suite's blip doesn't
red-light an otherwise-green concurrent run.

The deterministic-wait hardening (see `docs/testing-strategy.md` →
*Flake hardening*) keeps the **first-attempt** failure rate low, so
retries are a margin, not a crutch. Measured evidence:

- A single retries-free full suite runs ~6.5–7.0 min wall
  (~1270–1279 passed, ~6 skipped).
- **Two** full suites run concurrently at the committed `retries: 3`
  both passed (exit 0): one with 0 failed / 1 flaky-retried, the other
  0 failed / 2 flaky-retried; ~9.5–10.0 min each under mutual
  contention. So under concurrency the suite absorbs ~1–2 transient
  flakes each with 0 hard failures.

Retries are **not** being reduced to 0, and worker counts are **not**
being raised to chase a sub-5-min single-suite time: raising parallelism
would manufacture the very contention this budget avoids and hurt
concurrent-suite robustness. A sub-5-min single-suite wall was therefore
not pursued and is explicitly out of scope under this policy.

## Profiler (`BOBBIT_E2E_PROFILE=1`)

When the next flake cluster appears, before chasing symptoms, get data:

```
BOBBIT_E2E_PROFILE=1 npm run test:e2e
```

The gateway emits a per-worker timing table to stderr every 5s and on
exit. Wrapped call sites today:

- `POST /api/sessions` (whole route)
- `executePlan.resolveConfig` (resolveBridgeOptions/Goal/Tools/Activation/Prompt)
- `executePlan.spawnAgent` and `spawnAgent.rpcStart`
- `executePlan.postSpawn`
- `sessionManager.assemblePrompt`, `resolvePrompt`, `assembleSystemPrompt`,
  `readAllAgentFiles`, `getAllConfigDirectories` (with `existsSync` count)
- `loadToolDefinitions` (tool YAML scan)
- `flexStore._doFlush`

Each row reports `calls`, `p50`, `p95`, `p99`, `max`, `total` over the
worker's lifetime. To wrap a new call site, import
`profile`/`profileAsync`/`recordElapsed` from
`src/server/agent/profiling.ts` and gate with the env var (the helpers
are zero-cost when the flag is unset). Use `bumpCount("label.extra", n)`
for sub-counters like "how many existsSync calls inside this region".

Flush interval can be overridden with `BOBBIT_E2E_PROFILE_FLUSH_MS=ms`.

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
