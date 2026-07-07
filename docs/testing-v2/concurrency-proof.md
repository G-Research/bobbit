# Concurrency Proof Report

**Status:** ⏳ MECHANISM COMPLETE — awaiting a chaos-free window for the real 5×3 run.

> This file is regenerated automatically by `node scripts/testing-v2/concurrency-proof.mjs`.
> The previous contents were a **dry-run placeholder** (fabricated 60 s / "PASS" rows) and have
> been removed. The real 5×3 proof must run on a machine with the chaos campaign paused (5
> concurrent `test:v2` runs saturate all 24 cores; overlapping chaos would inject the very
> contention flakes the proof exists to rule out). Once run, this file carries the real
> per-run wall times, ledger peaks, and a hard PASS/FAIL verdict.

## What has been fixed (committed)

### 1. Ledger genuinely caps Σworkers ≤ cores (the D7 mechanism)

The root cause of under-load flakes was CPU exhaustion, not tight timeouts. Previously the
coalescing window only *slept* — it did not register that peers were starting — so the first
run to grab the lock saw itself alone and took the full 12-slot bundle (vitest 8 + playwright
4). Five simultaneous runs therefore oversubscribed to ~60 worker slots on 24 cores → thermal
throttle → timeout flakes.

`scripts/testing-v2/ledger.mjs` now registers a **pending marker** before the coalescing
window and counts pending peers (not just committed reservations) when computing each run's
fair share. Measured with a 5-process simulation (`BOBBIT_V2_TOTAL_CORES=24`):

| Concurrent runs | Per-run grant (vitest + playwright) | Peak Σworkers |
|-----------------|-------------------------------------|---------------|
| 1 | 8 + 4 = 12 | 12 / 24 |
| 2 | 8 + 4 = 12 | 24 / 24 |
| 3 | 6 + 2 = 8  | 24 / 24 |
| 5 | 2 + 2 = 4  | **20 / 24** |

Before the fix, all five runs grabbed 12 each (Σ ≈ 60). The **"+3 forced-grant overshoot"** is
also gone: `splitBundle` now preserves its input sum for every grant in [2, 12] (old bug:
`splitBundle(2)` returned vitest 2 + playwright 1 = 3), and the reservation path never
allocates more than the free cores. Verified by `node scripts/testing-v2/ledger.mjs --selftest`
(includes a new pending-contention assertion).

### 2. Honest proof harness (no dry-run, no downgraded assertions)

`scripts/testing-v2/concurrency-proof.mjs` was rewritten:

- **Default scale is the full D7 spec: 5 concurrent × 3 reps.** No `--dry-run`, no fabricated
  rows.
- Each run is spawned with `BOBBIT_V2_CONCURRENCY_RUN=1`, which switches `run-v2`'s budget to
  the under-load per-run cap (600 s wall) via `assert-budget`. So a run's **exit code is the
  honest signal**: `exit 0 ⟺ vitest green AND playwright green AND wall ≤ 600 s`.
- **A1** (every run exits 0), **A2** (no vitest/playwright tier FAIL — playwright flakes under
  load are HARD failures), **A3** (ledger Σworkers ≤ cores), **A4** (per-run wall ≤ cap) are
  all hard-fail assertions. The proof exits non-zero on any violation.
- Failed runs get their last ~40 output lines embedded in this report for triage.

### 3. Honest budgets (`tests2/budgets.json`)

Per D7, **wall is the hard gate; CPU-min is observability only** — the process-tree sampler
provably over-counts on a shared box (an isolated `test:v2` measured 121 CPU-min > the physical
ceiling of 24 cores × 251 s = 120 CPU-min, because the sampler misattributes churned/foreign
PIDs). Under N-way load each run's sampler additionally sees its siblings' descendants, so CPU
gating is disabled under load. Measured (under concurrent chaos load, i.e. an upper bound):

- Isolated `test:v2` full run: **251 s wall** (< 300 s D7 isolated cap) ✅
- Tier-1 vitest (8 forks): **160 s**, 803 files / **7081 tests green**, exit 0 ✅
- Tier-2 playwright: 537/538 green; the 1 failure passes in isolation (contention flake).

## How to run the real proof (chaos paused)

```bash
# 1. Ensure dist is built and deps installed (once):
npm install && npm run build

# 2. Full D7 proof (default 5×3) — regenerates this file with real numbers:
node scripts/testing-v2/concurrency-proof.mjs
```

Expected wall: ~25–45 min (3 reps of 5 concurrent runs).
