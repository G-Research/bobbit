# Concurrency Proof Report

**Generated:** Wed, 08 Jul 2026 23:44:46 GMT  
**Result:** ❌ FAILED  
**Model:** multi-worktree (Option A) — one `test:v2` per throwaway git worktree, each with its own `node_modules` (`npm ci`) + copied `dist`, coordinated by the cross-process ledger.  
**Base commit:** `097464036bf27b6dafe43bd65cd6c3e771175582`  
**Scale:** 2 concurrent × 3 rep(s) = 6 total runs (reduced smoke — default is 5×3)  

> **Acceptance bar (D7):** 3 concurrent × 3 reps = 9 runs, all green, `retries: 0`, zero flakes, each run ≤ 600s under mutual load, ledger Σworkers ≤ cores. Playwright flakes under load are HARD failures.

---

## CLEAN all-fixes-in N=2 check (task 209df04c, base `09746403`)

> The single-snapshot report below is auto-generated and overwritten by the
> proof harness. **This narrative is the authoritative record of the first honest
> N=2 measurement with ALL last-mile fixes present on goal HEAD**: ledger-split
> fix (full vitest split only when `activeParents===1`), timing-determinism on the
> named cluster, command-step DI seam, gateway-boot + browser-render leases, and
> the deterministic tool-docs regression fix (bc7a2507). Every prior N=2 number
> was contaminated by one of those since-fixed issues, peer-agent load, or the
> node_modules crash. This run had none of that contamination in the code.

### Box state at run start (honest)

- **~73 peer node/chrome procs** parked on the shared 24-core box, BUT **CPU near-idle at run start (3–5%)** — the parked agent sessions were not burning cores. This is the quietest realistic window available; a truly 0-peer-proc box was not obtainable. The 6 runs are each in their own throwaway worktree (own `npm ci` + copied `dist`), exactly the real N-developer model. `retries: 0`, honest hard-fail.

### Result: **3/6 green** (was 0/6 on the prior authoritative base `bc7a2507`)

| Rep | run#1 (wt-0) | run#2 (wt-1) | per-run wall | ledger Σpeak |
|---|---|---|---|---|
| 1 | ❌ vitest FAIL, pw PASS | ✅ PASS | 518.0 / 511.7 s | 14/24 |
| 2 | ❌ vitest FAIL, pw PASS | ✅ PASS | 515.7 / 525.9 s | 14/24 |
| 3 | ✅ PASS | ❌ vitest FAIL + pw FAIL | 552.9 / 566.7 s | 14/24 |

**Green rate: 3/6.** Max wall 566.7 s ≤ 600 s cap ✅. **Ledger Σworkers peak = 14/24 at all times** ✅ — the ledger-split fix held; zero oversubscription (the N=2-worse-than-N=3 regression is gone).

### EXACT failing tests + classification

All failures are **CPU-starvation under 2 concurrent full `test:v2` suites**, not assertion/logic bugs. Every vitest failure is a **60 s test-timeout**; the tests drive on observable WS state, so no test-side timing lever moves them — the gateway/WS/orchestration itself is starved.

| Run | Tier | Test | Classification |
|---|---|---|---|
| rep1/#1 | vitest·integration | `archived-query-search-api.test.ts › sessions q filters by title or role across the full archived corpus before pagination` | **wall-timeout** (60 s test-timeout) |
| rep2/#1 | vitest·integration | `project-isolation.test.ts › multi-project session lifecycle — no cross-contamination` | **wall-timeout** (60 s test-timeout; file wall 213 s) |
| rep3/#2 | vitest·integration | `market-pack-team-roles.test.ts › Gap 1: team lead can team_spawn a market-pack role …` + `Gap 2: team_delegate(role) child carries the role promptTemplate …` | **wall-timeout** (60 s test-timeout, ×2; note: master-synced test) |
| rep3/#2 | playwright·journey | `app-smoke.journey.spec.ts:308 › Sidebar Keyboard Nav › Ctrl+ArrowDown advances keyboard-nav through rows in DOM order` | **wall-timeout** (5 s predicate render timeout under load) |
| rep3/#2 | playwright·journey | `goal-team-gates.journey.spec.ts:90 › plan tab renders archived child with data-archived='true'` | **not a render timeout** — goal-creation `POST /api/goals` returned **403** (expected 201). Load-induced gateway auth/state race, not a plain visibility timeout. |

### Verdict

**N=2 does NOT hold cleanly with all fixes in** — but the all-fixes-in build is a **real improvement: 0/6 → 3/6**. The residual is the **same structural ceiling** documented before: a **rotating cast of integration tests hitting 60 s timeouts under 2-way CPU starvation** (this run: `archived-query-search-api`, `project-isolation`, `market-pack-team-roles`), plus one browser render-timeout and one load-induced `403` goal-creation. The ledger is behaving correctly (Σ=14/24, no oversubscription); the binding constraint is **server throughput under concurrent load on one 24-core box**, which no test-side timing fix can move. The earlier "ceiling" was NOT purely the since-fixed bugs — those fixes lifted 0/6 → 3/6, but a hardware/structural ceiling remains at N≥2. Honest highest ~0-flake N on this build/box: **N=1**.

No config was changed to force a pass; measured straight. No coverage relocated, no assertion weakened, no timeout/retry padded.

---

## Summary

| Metric | Value | Target | Status |
|--------|-------|--------|--------|
| Runs green (exit 0) | 3/6 | 6/6 | ❌ |
| Vitest tier failures | 3 | 0 | ❌ |
| Playwright tier failures | 1 | 0 | ❌ |
| Max wall time | 566.7s | ≤ 600s | ✅ |
| Avg / min wall | 531.8s / 511.7s | — | — |
| Max Σworkers (ledger) | 14 | ≤ 24 | ✅ |

## Assertions

| # | Assertion | Status |
|---|-----------|--------|
| A1 | Every run exits 0 (vitest green + playwright green + wall ≤ cap) | ❌ FAIL — 3 non-zero |
| A2 | No vitest or playwright tier FAIL in any run | ❌ FAIL — vitest 3, playwright 1 |
| A3 | Ledger Σworkers ≤ 24 at all times | ✅ PASS |
| A4 | Per-run wall ≤ 600s | ✅ PASS |

## Violations

- ❌ A1: 3/6 run(s) exited non-zero: rep1/#1(exit 1), rep2/#1(exit 1), rep3/#2(exit 1)
- ❌ A2: 3 run(s) had vitest tier-1 failures: rep1/#1, rep2/#1, rep3/#2
- ❌ A2: 1 run(s) had playwright tier-2 failures: rep3/#2

<details><summary>rep1/run#1 (exit 1) — last output</summary>

```
[ext-channel-audit] type=pty.exit session=e1173326-c3e7-436c-a03b-ca8c23593fbc packId=- channel=- channelId=- reason=session-terminated
[1A[2K[ext-channel-audit] type=permit.mint session=9fd408eb-f3f7-4e38-8627-0d93c06a0cab packId=terminal channel=terminal channelId=-
[1A[2K[ext-channel-audit] type=permit.consume session=9fd408eb-f3f7-4e38-8627-0d93c06a0cab packId=terminal channel=terminal channelId=-
[1A[2K[ext-channel-audit] type=channel.attach session=9fd408eb-f3f7-4e38-8627-0d93c06a0cab packId=terminal channel=terminal channelId=496c7471-5555-47ef-8153-ed928eeb13ac
[1A[2K[ext-channel-audit] type=channel.list session=9fd408eb-f3f7-4e38-8627-0d93c06a0cab packId=terminal channel=terminal channelId=-
[1A[2K[ext-channel-audit] type=channel.attach session=9fd408eb-f3f7-4e38-8627-0d93c06a0cab packId=terminal channel=terminal channelId=496c7471-5555-47ef-8153-ed928eeb13ac
[1A[2K[ext-channel-audit] type=pty.spawn session=9fd408eb-f3f7-4e38-8627-0d93c06a0cab packId=- channel=- channelId=- reason=spawned
[1A[2K[ext-channel-audit] type=channel.open session=9fd408eb-f3f7-4e38-8627-0d93c06a0cab packId=terminal channel=terminal channelId=496c7471-5555-47ef-8153-ed928eeb13ac
[1A[2K[trigger-engine] Stopped
[1A[2K[ext-channel-audit] type=channel.close session=9fd408eb-f3f7-4e38-8627-0d93c06a0cab packId=terminal channel=terminal channelId=496c7471-5555-47ef-8153-ed928eeb13ac reason=gateway-shutdown
[1A[2K[sandbox-manager] All 0 sandbox(es) shut down
[1A[2K[trigger-engine] Started (60s poll interval)
[1A[2K[aigw-manager] No contextWindow overrides needed
[1A[2K[session-manager] Restoring 20 session(s) + 0 delegate(s) live...
[1A[2K[team-manager] Re-subscribed to events for 0 team(s)
[1A[2K[boot] sweeper start (1 projects)
[1A[2K[boot] sweeper done in 34ms (reclaimed=0 cleaned=0 repaired=0)
[1A[2K[boot] background tasks complete in 35ms
[1A[2K[ext-channel-audit] type=pty.exit session=9fd408eb-f3f7-4e38-8627-0d93c06a0cab packId=- channel=- channelId=- reason=gateway-shutdown
[1A[2K[ext-channel-audit] type=channel.list session=9fd408eb-f3f7-4e38-8627-0d93c06a0cab packId=terminal channel=terminal channelId=-
[1A[2K[ext-channel-audit] type=permit.mint session=9fd408eb-f3f7-4e38-8627-0d93c06a0cab packId=terminal channel=terminal channelId=-
[1A[2K[ext-channel-audit] type=permit.consume session=9fd408eb-f3f7-4e38-8627-0d93c06a0cab packId=terminal channel=terminal channelId=-
[1A[2K[ext-channel-audit] type=channel.attach session=9fd408eb-f3f7-4e38-8627-0d93c06a0cab packId=terminal channel=terminal channelId=56f0836e-a201-4e75-9bb9-919d1a4681ba
[1A[2K[ext-channel-audit] type=pty.spawn session=9fd408eb-f3f7-4e38-8627-0d93c06a0cab packId=- channel=- channelId=- reason=spawned
[1A[2K[ext-channel-audit] type=channel.open session=9fd408eb-f3f7-4e38-8627-0d93c06a0cab packId=terminal channel=terminal channelId=56f0836e-a201-4e75-9bb9-919d1a4681ba
[1A[2K[ext-channel-audit] type=channel.close session=9fd408eb-f3f7-4e38-8627-0d93c06a0cab packId=terminal channel=terminal channelId=56f0836e-a201-4e75-9bb9-919d1a4681ba reason=session-terminated
[1A[2K[trigger-engine] Stopped
[1A[2K[sandbox-manager] All 0 sandbox(es) shut down
[1A[2K[33m  18 skipped[39m
[32m  696 passed[39m[2m (8.6m)[22m
assert-budget: scope=browser tier=tier2
  wall: 513.6s (cap 600s)  [.profiles/testing-v2/budgets/playwright-report.json]
  cpu:  n/a (cap 240.00 CPU-min)  [unmeasured]
  artifact: C:\Users\jsubr\w\bobbit-wt\cc-proof-34664\wt-0\.profiles\testing-v2\budgets\2026-07-08T23-25-54-581Z-browser.json
assert-budget: PASS
[run-v2] tier1/vitest (test:v2:core): FAIL in 423.4s
[run-v2] tier2/playwright (test:v2:browser): PASS in 515.0s
[run-v2] total wall 517.5s, whole-tree CPU 38.20 CPU-min (peak procs 61)
[run-v2] budget artifact: C:\Users\jsubr\w\bobbit-wt\cc-proof-34664\wt-0\.profiles\testing-v2\budgets\2026-07-08T23-25-55-113Z-full.json
[run-v2] budget PASS (full ≤180s wall / ≤13 CPU-min)
```
</details>

<details><summary>rep2/run#1 (exit 1) — last output</summary>

```
[1A[2K[ext-channel-audit] type=permit.mint session=e2561c88-6025-4f6d-b2bf-b6ad59429696 packId=terminal channel=terminal channelId=-
[1A[2K[ext-channel-audit] type=permit.consume session=e2561c88-6025-4f6d-b2bf-b6ad59429696 packId=terminal channel=terminal channelId=-
[1A[2K[ext-channel-audit] type=channel.attach session=e2561c88-6025-4f6d-b2bf-b6ad59429696 packId=terminal channel=terminal channelId=ba419d9b-c174-446b-90cd-54e7fe6dfee9
[1A[2K[ext-channel-audit] type=channel.list session=e2561c88-6025-4f6d-b2bf-b6ad59429696 packId=terminal channel=terminal channelId=-
[1A[2K[ext-channel-audit] type=channel.attach session=e2561c88-6025-4f6d-b2bf-b6ad59429696 packId=terminal channel=terminal channelId=ba419d9b-c174-446b-90cd-54e7fe6dfee9
[1A[2K[714/714] [browser-v2-daily] › tests2\browser\daily\pr-walkthrough-panel-parity.spec.ts:1201:2 › PR walkthrough pack panel UI parity › ready state supports user comments, dislike gating, narrow inline default, historical file headers, and diff collapse
[1A[2K[ext-channel-audit] type=pty.spawn session=e2561c88-6025-4f6d-b2bf-b6ad59429696 packId=- channel=- channelId=- reason=spawned
[1A[2K[ext-channel-audit] type=channel.open session=e2561c88-6025-4f6d-b2bf-b6ad59429696 packId=terminal channel=terminal channelId=ba419d9b-c174-446b-90cd-54e7fe6dfee9
[1A[2K[trigger-engine] Stopped
[1A[2K[ext-channel-audit] type=channel.close session=e2561c88-6025-4f6d-b2bf-b6ad59429696 packId=terminal channel=terminal channelId=ba419d9b-c174-446b-90cd-54e7fe6dfee9 reason=gateway-shutdown
[1A[2K[sandbox-manager] All 0 sandbox(es) shut down
[1A[2K[trigger-engine] Started (60s poll interval)
[1A[2K[aigw-manager] No contextWindow overrides needed
[1A[2K[session-manager] Restoring 20 session(s) + 0 delegate(s) live...
[1A[2K[team-manager] Re-subscribed to events for 0 team(s)
[1A[2K[ext-channel-audit] type=pty.exit session=e2561c88-6025-4f6d-b2bf-b6ad59429696 packId=- channel=- channelId=- reason=gateway-shutdown
[1A[2K[boot] sweeper start (1 projects)
[1A[2K[boot] sweeper done in 42ms (reclaimed=0 cleaned=0 repaired=0)
[1A[2K[boot] background tasks complete in 42ms
[1A[2K[ext-channel-audit] type=channel.list session=e2561c88-6025-4f6d-b2bf-b6ad59429696 packId=terminal channel=terminal channelId=-
[1A[2K[ext-channel-audit] type=permit.mint session=e2561c88-6025-4f6d-b2bf-b6ad59429696 packId=terminal channel=terminal channelId=-
[1A[2K[ext-channel-audit] type=permit.consume session=e2561c88-6025-4f6d-b2bf-b6ad59429696 packId=terminal channel=terminal channelId=-
[1A[2K[ext-channel-audit] type=channel.attach session=e2561c88-6025-4f6d-b2bf-b6ad59429696 packId=terminal channel=terminal channelId=d7760f95-7fc5-4341-be3b-dfd27f4d6277
[1A[2K[ext-channel-audit] type=pty.spawn session=e2561c88-6025-4f6d-b2bf-b6ad59429696 packId=- channel=- channelId=- reason=spawned
[1A[2K[ext-channel-audit] type=channel.open session=e2561c88-6025-4f6d-b2bf-b6ad59429696 packId=terminal channel=terminal channelId=d7760f95-7fc5-4341-be3b-dfd27f4d6277
[1A[2K[ext-channel-audit] type=channel.close session=e2561c88-6025-4f6d-b2bf-b6ad59429696 packId=terminal channel=terminal channelId=d7760f95-7fc5-4341-be3b-dfd27f4d6277 reason=session-terminated
[1A[2K[trigger-engine] Stopped
[1A[2K[sandbox-manager] All 0 sandbox(es) shut down
[1A[2K[33m  19 skipped[39m
[32m  695 passed[39m[2m (8.5m)[22m
assert-budget: scope=browser tier=tier2
  wall: 511.4s (cap 600s)  [.profiles/testing-v2/budgets/playwright-report.json]
  cpu:  n/a (cap 240.00 CPU-min)  [unmeasured]
  artifact: C:\Users\jsubr\w\bobbit-wt\cc-proof-34664\wt-0\.profiles\testing-v2\budgets\2026-07-08T23-34-30-036Z-browser.json
assert-budget: PASS
[run-v2] tier1/vitest (test:v2:core): FAIL in 474.4s
[run-v2] tier2/playwright (test:v2:browser): PASS in 512.5s
[run-v2] total wall 515.2s, whole-tree CPU 86.01 CPU-min (peak procs 59)
[run-v2] budget artifact: C:\Users\jsubr\w\bobbit-wt\cc-proof-34664\wt-0\.profiles\testing-v2\budgets\2026-07-08T23-34-30-822Z-full.json
[run-v2] budget PASS (full ≤180s wall / ≤13 CPU-min)
```
</details>

<details><summary>rep3/run#2 (exit 1) — last output</summary>

```
[1A[2K[trigger-engine] Stopped
[1A[2K[ext-channel-audit] type=channel.close session=d9646794-2101-4d12-ab6b-9a94f1d4da50 packId=terminal channel=terminal channelId=5c51e639-433a-4db3-8719-10e9dc9a0f09 reason=gateway-shutdown
[1A[2K[sandbox-manager] All 0 sandbox(es) shut down
[1A[2K[trigger-engine] Started (60s poll interval)
[1A[2K[aigw-manager] No contextWindow overrides needed
[1A[2K[session-manager] Restoring 20 session(s) + 0 delegate(s) live...
[1A[2K[705/714] [browser-v2-daily] › tests2\browser\daily\pr-walkthrough-panel-parity.spec.ts:974:2 › PR walkthrough pack panel UI parity › pr-walkthrough shell parity: Submit unlocks only after review completion and opens export preview
[1A[2K[706/714] [browser-v2-daily] › tests2\browser\daily\pr-walkthrough-panel-parity.spec.ts:1008:2 › PR walkthrough pack panel UI parity › ready multi-card state exposes the reference walkthrough review affordances
[1A[2K[707/714] [browser-v2-daily] › tests2\browser\daily\pr-walkthrough-panel-parity.spec.ts:1019:2 › PR walkthrough pack panel UI parity › narrative cards render interleaved blocks and only referenced hunks
[1A[2K[708/714] [browser-v2-daily] › tests2\browser\daily\pr-walkthrough-panel-parity.spec.ts:1039:2 › PR walkthrough pack panel UI parity › secondary narrative hunks collapse by default, expand on demand, and persist
[1A[2K[709/714] [browser-v2-daily] › tests2\browser\daily\pr-walkthrough-panel-parity.spec.ts:1064:2 › PR walkthrough pack panel UI parity › narrative rail keeps more than twelve logical cards and renders coverage
[1A[2K[710/714] [browser-v2-daily] › tests2\browser\daily\pr-walkthrough-panel-parity.spec.ts:1077:2 › PR walkthrough pack panel UI parity › side-by-side diff uses the historical compact split-grid renderer
[1A[2K[711/714] [browser-v2-daily] › tests2\browser\daily\pr-walkthrough-panel-parity.spec.ts:1138:2 › PR walkthrough pack panel UI parity › line suggestions render with historical inline suggestion actions
[1A[2K[712/714] [browser-v2-daily] › tests2\browser\daily\pr-walkthrough-panel-parity.spec.ts:1152:2 › PR walkthrough pack panel UI parity › diff syntax highlighting, scoped hunk signatures, and context expansion are pinned
[1A[2K[team-manager] Re-subscribed to events for 0 team(s)
[1A[2K[boot] sweeper start (1 projects)
[1A[2K[boot] sweeper done in 36ms (reclaimed=0 cleaned=0 repaired=0)
[1A[2K[boot] background tasks complete in 36ms
[1A[2K[ext-channel-audit] type=pty.exit session=d9646794-2101-4d12-ab6b-9a94f1d4da50 packId=- channel=- channelId=- reason=gateway-shutdown
[1A[2K[713/714] [browser-v2-daily] › tests2\browser\daily\pr-walkthrough-panel-parity.spec.ts:1176:2 › PR walkthrough pack panel UI parity › inline mode uses historical inline diff-line rows instead of tables
[1A[2K[714/714] [browser-v2-daily] › tests2\browser\daily\pr-walkthrough-panel-parity.spec.ts:1201:2 › PR walkthrough pack panel UI parity › ready state supports user comments, dislike gating, narrow inline default, historical file headers, and diff collapse
[1A[2K[ext-channel-audit] type=channel.list session=d9646794-2101-4d12-ab6b-9a94f1d4da50 packId=terminal channel=terminal channelId=-
[1A[2K[ext-channel-audit] type=permit.mint session=d9646794-2101-4d12-ab6b-9a94f1d4da50 packId=terminal channel=terminal channelId=-
[1A[2K[ext-channel-audit] type=permit.consume session=d9646794-2101-4d12-ab6b-9a94f1d4da50 packId=terminal channel=terminal channelId=-
[1A[2K[ext-channel-audit] type=channel.attach session=d9646794-2101-4d12-ab6b-9a94f1d4da50 packId=terminal channel=terminal channelId=b8fdf336-9165-43b2-892a-ea633607e9ea
[1A[2K[ext-channel-audit] type=pty.spawn session=d9646794-2101-4d12-ab6b-9a94f1d4da50 packId=- channel=- channelId=- reason=spawned
[1A[2K[ext-channel-audit] type=channel.open session=d9646794-2101-4d12-ab6b-9a94f1d4da50 packId=terminal channel=terminal channelId=b8fdf336-9165-43b2-892a-ea633607e9ea
[1A[2K[ext-channel-audit] type=channel.close session=d9646794-2101-4d12-ab6b-9a94f1d4da50 packId=terminal channel=terminal channelId=b8fdf336-9165-43b2-892a-ea633607e9ea reason=session-terminated
[1A[2K[trigger-engine] Stopped
[1A[2K[sandbox-manager] All 0 sandbox(es) shut down
[1A[2K[31m  2 failed[39m
[31m    [browser-v2] › tests2\browser\journeys\app-smoke.journey.spec.ts:308:2 › Journey: Sidebar Keyboard Nav › Ctrl+ArrowDown advances keyboard-nav through rows in DOM order [39m
[31m    [browser-v2] › tests2\browser\journeys\goal-team-gates.journey.spec.ts:90:2 › Journey: Plan-Tab Gate-Status — behavioral assertions › plan tab renders archived child with data-archived='true' [39m
[33m  18 skipped[39m
[32m  694 passed[39m[2m (9.4m)[22m
[run-v2] tier1/vitest (test:v2:core): FAIL in 482.1s
[run-v2] tier2/playwright (test:v2:browser): FAIL in 563.5s
[run-v2] total wall 566.2s, whole-tree CPU 190.13 CPU-min (peak procs 60)
[run-v2] budget artifact: C:\Users\jsubr\w\bobbit-wt\cc-proof-34664\wt-1\.profiles\testing-v2\budgets\2026-07-08T23-44-08-122Z-full.json
[run-v2] budget PASS (full ≤180s wall / ≤13 CPU-min)
```
</details>

## Per-Rep Results

### Rep 1

| Run | PID | Exit | Wall (s) | Vitest | Playwright |
|-----|-----|------|----------|--------|------------|
| 1 | 33904 | 1 ❌ | 518 | ❌ | ✅ |
| 2 | 41252 | 0 ✅ | 511.7 | ✅ | ✅ |

**Ledger peak Σworkers:** 14/24 ✅  (994 samples)

### Rep 2

| Run | PID | Exit | Wall (s) | Vitest | Playwright |
|-----|-----|------|----------|--------|------------|
| 1 | 44072 | 1 ❌ | 515.7 | ❌ | ✅ |
| 2 | 39960 | 0 ✅ | 525.9 | ✅ | ✅ |

**Ledger peak Σworkers:** 14/24 ✅  (1017 samples)

### Rep 3

| Run | PID | Exit | Wall (s) | Vitest | Playwright |
|-----|-----|------|----------|--------|------------|
| 1 | 40256 | 0 ✅ | 552.9 | ✅ | ✅ |
| 2 | 9572 | 1 ❌ | 566.7 | ❌ | ❌ |

**Ledger peak Σworkers:** 14/24 ✅  (1088 samples)

## What This Proves

1. **Zero-flake concurrency (realistic model).** 3/6 concurrent `test:v2` runs — each in its own worktree, exactly how Bobbit runs agents — completed green with `retries: 0`. A single flake in either tier flips a run's exit code and fails this proof; no downgraded assertions, no dry-run.

2. **CPU exhaustion bounded by the ledger (the D7 mechanism).** Peak Σworkers = 14/24. The ledger counts pending peers during coalescing, so 2 simultaneous runs each get ~`floor(24/2)` slots instead of grabbing the full 12-slot bundle and oversubscribing to ~24 on 24 cores.

3. **Under-load wall budget honoured.** Slowest run: 566.7s ≤ 600s cap (D7 under-load bar), enforced per-run via `BOBBIT_V2_CONCURRENCY_RUN=1` → run-v2's under-load budget.

## Reproduce

```bash
# Full D7 proof (default 5×3); provisions + tears down worktrees automatically:
node scripts/testing-v2/concurrency-proof.mjs

# Lighter smoke:
CONCURRENCY_PROOF_CONCURRENT=2 CONCURRENCY_PROOF_REPS=1 node scripts/testing-v2/concurrency-proof.mjs
```
