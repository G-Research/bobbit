# E2E Test Plan: Concrete Path to <120s and Low CPU

## What we've confirmed

### Win 1: Shell cost (committed)
Git Bash `--login` shell spawn on Windows is **3.7 seconds**. Plain bash is 150ms. For verification commands that only use shell builtins (like `echo ok` in `test-fast` workflow), we now skip `--login`.

**Impact**: ~25× faster for command-verification tests that use builtins. Real-world workflows (`npm run test`) still use `--login` because they reference tools that need PATH.

### Win 2: Tier 2 fixture (committed)
`tests/contract/fixtures/gateway.ts` provides a per-test in-process gateway at ~35ms setup + ~60ms shutdown. Pure API tests run at ~200-400ms. Useful going forward.

### Constraint: process-level singletons
Server code has module-level state (`_projectRoot`, prompt dirs, etc.) that prevents multiple gateways in the same Node process. **Per-test isolation requires one process per test**, which is too expensive (~1s import cost per process × 620 tests).

**Implication**: Per-file gateway (current Playwright model) is the practical ceiling for isolation.

## Where the CPU goes

Running `npm run test:e2e` today:
- **6 Playwright workers** (3 API in-process + 3 Browser spawned)
- Each browser worker runs: Playwright worker + spawned gateway + Chromium
- ~30 extra processes at steady state (~15 from browser, ~15 from mock agents)
- **CPU saturates** because each process has real work: page rendering, WS event handling, stdin/stdout parsing

At the machine limit, CPU contention creates the timing-flaky tests (verification takes >15s because the gateway doing the verification can't get CPU).

## The three levers

### Lever A: Reduce subprocess cost (high-impact, low-risk)

1. **Plain shell for simple commands** — DONE. Cut verification command cost 25×.
2. **Mock agent as worker thread** — partially explored, would save ~20-50ms × 600 sessions = 12-30s. Low priority vs other levers.
3. **Skip mock agent for tests that don't need it** — Many tests create a session just to open a WS. If we had a way to open WS without spawning an agent, we'd save 100% of that cost.

### Lever B: Reduce worker count (high-impact, requires refactoring)

Current 6 workers saturate CPU. If we use **fewer, heavier workers** that serve more tests each, we reduce process-spawn overhead and CPU contention.

- Playwright workers = 2 instead of 6
- Each worker handles more tests serially
- Wall time depends on whether savings from less contention outweigh lost parallelism

### Lever C: Reduce test count (low-risk, coverage-tradeoff)

Per the Tier 1/2/3 split in the earlier plan:
- Tier 1 (unit tests via file:// fixtures): **~800 tests, 22s** — already done
- Tier 2 (in-process gateway, Node test runner): **~400 tests target, ~60s** — infrastructure built
- Tier 3 (Playwright browser): **~30 tests, ~60s** — user stories only

Migrating 400 tests from Playwright to Node test runner is where the real win is.

## Concrete next step

Pick one: **Lever B** (reduce workers) or **Lever C** (migrate to Tier 2).

### Lever B: Reduce workers
**Effort**: 1 hour (config change + verify).
**Risk**: Wall time might go UP if we lose too much parallelism.
**Test**: Change `playwright-e2e.config.ts` to `workers: 2` for each project. Run full suite. Measure.

### Lever C: Migrate to Tier 2
**Effort**: 1-2 weeks of mechanical rewriting.
**Risk**: Low — we have the fixture and a working POC.
**Test**: Migrate 50 tests at a time, measuring wall time after each batch.

**My recommendation**: Do Lever B first (1 hour, might be a big win on its own). If it's not enough, start Lever C.

## What Lever B might look like

Instead of 6 workers all spawning heavy browser contexts, run 2 workers that handle all tests:
- 2 Playwright workers × 1 gateway each × 1 Chromium each = 2 gateways + 2 Chromiums
- vs today's 3 gateways + 3 Chromiums + 3 API gateways in-process = 9 running gateways

But with 2 workers serving 620 tests instead of 6, per-worker load doubles. If today each worker finishes in ~4min, with 2 workers it's ~12min.

That doesn't work.

**Actual fix**: reduce the WORK, not just the concurrency. The browser suite has 190 tests. If ~80 of them don't actually need a browser (they test API state via UI selectors), move them to the API project. That gives:

- API: 433 + 80 = 513 tests, 3 workers
- Browser: 110 tests, 3 workers

Each browser worker handles 110/3 = ~37 tests. At ~3s each = 111s per worker. Under 120s target.

## The decision tree

1. Keep Lever A win (committed)
2. Try reducing workers to 2+4 (1 hour). If <120s, DONE.
3. If not, migrate the ~80 API-only tests out of the browser project (1-2 days). If <120s, DONE.
4. If not, proceed with full Tier 2 migration (1-2 weeks).

Start with step 2?
