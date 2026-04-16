# E2E Test Architecture: The Tier 2 Migration

## POC results (completed)

Built `tests/contract/fixtures/gateway.ts` — a per-test in-process gateway factory — and converted 3 tests from `gates-api-heavy.spec.ts` / `gate-resign-cancel.spec.ts`.

### Measured cost per test
- Fresh gateway setup: **~35ms** (imports cached across tests in process)
- Gateway shutdown: **~60ms**
- HTTP startup (when used): **~170ms**
- Goal creation: **~40ms**
- Verification command (`echo ok`): **~2000ms** ← the real bottleneck for gate tests

### Per-test baseline
| Test type | Tier 3 (today) | Tier 2 (new) | Savings |
|-----------|----------------|--------------|---------|
| Pure API (no agent, no verification) | ~500ms | **~200ms** | 60% |
| Agent session (sends prompt) | ~1500ms | **~400ms** | 73% |
| Command verification (subprocess) | ~2500ms | **~2300ms** | 8% |

### What the POC confirmed
1. Per-test fresh gateway is viable and doesn't leak resources
2. `await using` pattern cleans up deterministically
3. Tests are independent — no shared state between tests
4. Imports cache across tests in the same process (so first test pays 1s, rest pay 0)

### What the POC revealed as a harder problem
- **Command verification (real subprocess)** still takes 2s per test on Windows
- This is a Windows subprocess startup cost, not an architecture issue
- For the ~9 test files that use command verification, per-test cost stays ~2s
- For the other ~60 files (pure API + session tests), per-test cost drops to ~200-400ms

## Projected suite time

Using the POC measurements:

### Assumption: 620 tests total (current)
- 100 tests involve command verification (~2s each) → **200s**
- 200 tests involve mock agent sessions (~400ms each) → **80s**
- 320 tests are pure REST/WS logic (~200ms each) → **64s**

**Sequential: 344s. With 8 parallel processes: 43s wall.**

vs. today's ~240s wall with 6 Playwright workers.

### Assumption after optimization:
If we switch the subprocess-based verification steps to use a mock shell (in-process command execution for `echo ok` style commands in `test-fast` workflow), the 200s of command verification drops to ~20s. That gives:

**Sequential: 164s. With 8 parallel processes: 20s wall.**

## The migration plan

### Step 1 (2-3 days): Build the `tests/contract/` foundation
- ✅ `createTestGateway()` fixture (done in POC)
- Add helpers: `createGoal()`, `signalGate()`, `waitForGateStatus()` using fetch
- Add WS helper for tests that need event assertions
- Add `agent session` helper that creates a session and sends a prompt

### Step 2 (3-5 days): Convert pure API tests
Per-file mechanical migration:
- Read current Playwright spec
- Rewrite as `node:test` contract test using fixture
- Delete the Playwright spec
- Verify equivalent coverage with `git diff`

Target: `tests/e2e/*.spec.ts` files that only use `in-process-harness` (no browser).

~50 files, ~400 tests.

### Step 3 (2 days): Convert session+WS tests
The 34 files that use sessions and WS events. Same pattern, with the mock agent helper.

### Step 4 (1 day): Keep the UI tests as Tier 3
The ~30 files under `tests/e2e/ui/` that use a real browser. These stay as Playwright tests with spawned gateway. They test the UI→gateway contract — that's what Tier 3 is for.

### Step 5 (1 day): Optimize command verification
For `test-fast` workflow's `echo ok` steps, add an in-process command runner that skips the subprocess. Real verification tests (gates using actual shell commands) stay as Tier 3.

### Step 6 (1 day): Update `npm run test:unit` and `npm run test:e2e`
- `test:unit` now includes `tests/contract/` → fast, ~30s total
- `test:e2e` runs only `tests/e2e/` → the heavy browser tier, ~60s total
- Combined: **<90s**

## Risks and mitigations

### Risk: In-process gateway differs from production gateway
**Mitigation**: Tier 3 (browser tests) still hit real HTTP/WS. If something only fails over the network, Tier 3 catches it.

### Risk: We lose coverage of HTTP layer edge cases
**Mitigation**: Keep 5-10 dedicated Tier 3 tests for auth, rate limiting, content negotiation.

### Risk: Test isolation breaks if gateway leaks state
**Mitigation**: Each test uses a fresh temp dir. Module-level state in server.ts is the only concern — we verified the POC runs 3 tests sequentially without contamination.

### Risk: Per-test gateway setup cost adds up
**Mitigation**: Measured at 35ms in POC. 400 tests × 35ms = 14s total setup overhead — acceptable.

## Decision gates

1. ✅ **Is per-test fresh gateway feasible?** Yes, measured 35ms setup + 60ms shutdown.
2. ✅ **Do tests stay isolated?** Yes, POC ran 3 tests sequentially without contamination.
3. **Is the subprocess verification cost acceptable?** For ~100 tests at 2s each = 200s, that's still too much for `test:unit` (<30s target). We need Step 5 (in-process command runner for test-fast) to get under the target.
4. **Can we migrate 400 tests in ~1 week?** The migration is mechanical per-test, estimated 5-10 tests/hour = 40-80 hours = 1-2 weeks of focused work.

## Recommended next step

Finish converting `gates-api-heavy.spec.ts` + `gate-resign-cancel.spec.ts` to Tier 2. Measure real wall time vs today's flaky 5-10min with retries. If it's a clean win, proceed with the full migration.

Alternatively: I can commit this POC, demonstrate the approach, and let you decide the scope (full migration vs. "new tests only go to Tier 2").
