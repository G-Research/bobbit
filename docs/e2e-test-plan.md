# E2E Test Suite: The Real Problem & Plan

## Machine: 24 cores, 63GB RAM

## Current state

| Metric | Value |
|--------|-------|
| Total tests | 621 (433 API + 188 browser) |
| Sequential time | 1,247s (846s useful + 401s retry waste) |
| Wall time (3+3 workers) | ~4 min |
| CPU usage | ~50% of 24 cores = 12 cores for 1 run |
| Flaky tests causing retries | 11 tests, 401s wasted |

## Why it's slow and heavy

### 1. Browser tests are 3× heavier than needed (643s, 188 tests)
Each browser worker spawns: Playwright worker + gateway server + Chromium + mock agents.
**Most browser tests don't need a browser.** They test API-driven state through UI selectors when the same logic is testable via REST/WS.

### 2. Flaky tests waste 32% of runtime (401s)
11 tests retry 1-2 times each. Root causes:
- WS event collision (stale messages matched by `waitFor`)
- Shared in-process state between parallel tests
- Timing-sensitive assertions under CPU contention

### 3. Mock agent spawn overhead (~1s per test)
Every test that creates a session spawns a Node child process for the mock agent. At 600+ tests, that's ~600 process spawns.

### 4. No resource scaling for concurrent runs
6 runs × 6 workers = 36 workers. 36 × (gateway + Chromium + agents) = hundreds of processes, 12+ GB RAM, all 24 cores saturated.

## Target

- **Full test suite in <120s** (unit + e2e combined)
- **6 concurrent runs** fit in 24 cores / 63GB without contention
- **Per-run budget**: 4 cores max, ~4GB RAM max → 2 workers max

### Math
- 120s target - 22s unit tests = **98s for e2e**
- 98s wall × 2 workers = **196s sequential budget**
- Current useful time (minus retries): 846s
- **Need to cut 650s (77%)**

## The plan

### Phase 1: Eliminate all flaky tests (save 401s of retry waste)

The 11 flaky tests all share root cause patterns:

**a) WS event collision** — `waitFor` finds stale messages from earlier in the test. Partially fixed with `waitForNext`, needs completing across all affected tests.

**b) Shared in-process gateway state** — tests running in parallel on the same worker see each other's projects, sessions, and skill caches.

**c) Browser timing** — tests assert visibility before rendering completes.

**Target: 0 retries → 846s useful time instead of 1,247s.**

### Phase 2: Convert ~80 browser tests to in-process (save ~400s)

The 188 browser tests take 643s. Most test API behavior visible through UI but testable via REST/WS:

| Category | Tests | Can convert? |
|----------|-------|-------------|
| Sidebar rendering/state | ~40 | Yes — test via REST API + WS events |
| Settings persistence | ~15 | Yes — test via REST API |
| Goal/workflow CRUD UI | ~25 | Yes — test via REST API |
| Navigation/routing | ~15 | No — needs real hash routing |
| Streaming/draft contracts (CT-01/02/06) | ~34 | No — needs real browser |
| User interaction (click, type) | ~30 | No — needs real browser |
| Tool/proposal UI | ~20 | Partial |

~80 browser tests → in-process API tests. ~3s saved per conversion = **~240s saved**.

### Phase 3: Reduce workers, increase efficiency

After phases 1-2:
- **API project**: ~513 tests (~250s seq), 2 workers → 125s wall
- **Browser project**: ~108 tests (~300s seq), 1 worker → 300s wall

Browser is the bottleneck at 1 worker. But with 1 browser worker per run, 6 concurrent runs = 6 Chromiums (manageable).

### Phase 4: Shared gateway for browser tests

All browser tests share one gateway started in `globalSetup` instead of each worker spawning its own. Eliminates 5-8s startup per worker, reduces process count.

### Projected result

| Phase | Sequential time | Wall (2+1 workers) |
|-------|----------------|-------------------|
| Current | 1,247s | ~240s (4 min) |
| Phase 1 (fix flaky) | 846s | ~170s |
| Phase 2 (convert browser→API) | ~530s | ~120s |
| Phase 3 (rebalance workers) | ~530s | ~110s |
| Phase 4 (shared gateway) | ~500s | ~100s |

### Resource usage per run after all phases

| Resource | Current | After |
|----------|---------|-------|
| Workers | 6 (3+3) | 3 (2+1) |
| Node processes | ~12 | ~5 |
| Chromium instances | 3 | 1 |
| Memory | ~4 GB | ~1.5 GB |
| CPU cores | ~12 | ~4 |

### 6 concurrent runs after all phases

| Resource | Current (6×) | After (6×) |
|----------|-------------|-----------|
| Total processes | ~72 | ~30 |
| Chromium instances | 18 | 6 |
| Memory | ~24 GB | ~9 GB |
| CPU cores needed | 72 (3× over) | 24 (fits exactly) |

## Implementation order

1. **Fix all 11 flaky tests** — biggest ROI, 401s of waste eliminated
2. **Convert ~80 browser tests to in-process** — incremental, per-file
3. **Rebalance workers to 2+1** — config change
4. **Shared browser gateway** — globalSetup change

## What doesn't change

- `npm run test:unit` — 841 tests, 22s
- `npm run test:e2e` — all tests, <120s target
- All CT/PI/SB contract tests stay as browser E2E
- All user story coverage maintained
- Code coverage maintained or improved
