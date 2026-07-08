# Concurrency Proof Report — GLOBAL CONCURRENCY BUDGET

**Author:** test-engineer-9069 (session 15565bf7) · task 47507884
**Status:** budget IMPLEMENTED + unit-proven; **authoritative N-way measurement PENDING a quiet box.**
**Base commit:** `ac1a2ff0` (boot lease + Chromium 2-cap + restored render headroom).

> This is an AUTHORED summary (the proof harness overwrites this file with a
> single-run snapshot; the raw 3-way×3 snapshot it produced is preserved in
> `.profiles/testing-v2/concurrency-proof/result.json` + `logs/`). Numbers below
> are labelled with their commit and box condition.

---

## 1. What was built (the global concurrency budget)

The reservation ledger already bounded *steady-state* worker count (Σworkers ≤
cores). It did **not** bound the *transient* CPU bursts when many in-process
gateways boot at once — the diagnosed root cause of the N-way flakes. Two new
levers, both cross-process, both defaulting on:

1. **Gateway-boot lease pool** (`scripts/testing-v2/ledger.mjs` :
   `acquireLease`/`acquireGatewayBootLease`). A filesystem semaphore, cap
   `clamp(floor(cores/6),2,8)` = **4** on the 24-core box (env
   `BOBBIT_V2_MAX_GATEWAY_BOOTS`). Heavy op **acquires → WAITS if saturated →
   releases**. Fail-open after 120 s (never deadlocks a boot); dead-PID +
   max-hold sweep. Wired into **both** boot paths:
   - tier-1 `tests2/harness/gateway.ts` — acquired **before the dynamic
     `src/server` import**, so the ~11 s/fork cold graph transform (the measured
     "worst contention moment", ~130 CPU-s spike at 4-way per
     `gateway-cost-feasibility.md`) is serialised too, not just the runtime boot.
   - tier-2 `tests/e2e/gateway-harness.ts` — acquired before `createGateway` +
     `start()`, gated on `BOBBIT_V2_GATEWAY_BOOT_LEASE` (set **only** by
     `playwright-v2.config.ts`), fail-open. **Legacy e2e is unaffected.**

2. **Chromium cap** (`PLAYWRIGHT_CAP = 2`). Chromium is IO/gateway-bound, not
   CPU-parallel: measured 2 workers ≈ 4-worker throughput; 1 worker doubles wall.
   So target **2** chromium workers/run — bounds total concurrent Chromium to 2×N
   while the ledger's `Σworkers ≤ cores` bounds the rest.

3. **Restored render headroom** (`splitBundle`). Under contention the split
   **under-allocates vitest** so Σworkers leaves ~⅓ of the cores idle for the
   concurrent browser tiers to render into (tier-2 flakes are `toBeVisible`
   render timeouts — see §3). Per-run split: 3-way → **3v+2p (Σ15/24)**, 4-way →
   **2v+2p (Σ16/24)**, 5-way → **1v+2p (Σ15/24)**. Single uncontended run
   (grant≥12) uses the full **8v+2p** for speed.

**Unit-proven** (`node scripts/testing-v2/ledger.mjs --selftest`, deterministic,
no box dependency): lease cap enforcement + wait-then-grant, fail-open, dead-PID
sweep; split anchors; Σworkers ≤ cores under pending-contention. Cross-process
lease cap proven by `--lease-stress` (peak concurrent holders ≤ cap, N children).

---

## 2. Raw 3-way × 3 measurement — CONTAMINATED, pre-headroom-fix (commit `4ec59ec5`)

Ran `CONCURRENCY_PROOF_CONCURRENT=3 REPS=3` on the **shared dev box while ~46
other Bobbit agent processes were live** (CPU observed oscillating 4 %→60 % as
peers worked). This run used the **filled-box split (6v+2p, Σ=24/24)** that
commit `ac1a2ff0` later corrected. Result:

| Metric | Value | Target | Status |
|---|---|---|---|
| Runs green | **0/9** | 9/9 | ❌ |
| Vitest tier failures | 7 runs | 0 | ❌ |
| Playwright tier failures | 7 runs | 0 | ❌ |
| Max Σworkers (ledger) | **24** | ≤ 24 | ✅ |
| Rep 1 / 2 walls | 552–575 s | ≤ 600 | ✅ |
| Rep 3 walls | **648–661 s** | ≤ 600 | ❌ |

**Two independent confounds make this NON-authoritative:**

- **External load.** Rep 3's wall jumped ~90 s (552→661 s) with **no config
  change between reps** — the signature of a peer agent starting heavy work
  mid-proof. On a 24-core box shared with dozens of live agents, a 40-minute
  proof cannot be trusted.
- **Wrong config.** It ran the filled-box split (Σ=24/24). §3 explains why that
  itself regresses browser reliability, and why `ac1a2ff0` reverts it.

**What the run DID prove (config- and load-independent):** the ledger held
**Σworkers ≤ 24 at all times** across 3 simultaneous runs (A3 ✅); the split
granted each run `6v+2p` (`floor(24/3)=8 → splitBundle`); and the gateway-boot
lease coordinated boots across all 3 runs' forks + workers from the one shared
pool (observed `gateway-boot 0/4` between boot waves — never exceeded cap).

The failing tests were a **rotating cast of tier-2 `toBeVisible` render timeouts**
(`tool-manager-mcp-section`, `verification-dedup`, `session-actions`,
`team-operations`, `goal-team-gates`, `proposal-revision-snapshots`) plus a few
tier-1 timing tests — i.e. the KNOWN browser-tier contention set, not a new
break.

---

## 3. The key finding: browser RENDER needs CPU headroom (not just boot serialisation)

The handoff premise was "gate the boots + Chromium and the flakes go away." That
is **half right**. Isolating the variables (all on the shared box, so directional
not absolute):

| Config | Σ @ 3-way | 3-way green | Note |
|---|---|---|---|
| pre-lease (`f31938d1`) 4v+1p | 15/24 | 2/9 | headroom, 1 browser worker |
| my filled-box (`4ec59ec5`) 6v+2p | 24/24 | **0/9** | no headroom → **worse** |
| my headroom fix (`ac1a2ff0`) 3v+2p | 15/24 | *pending quiet box* | headroom + 2 workers + boot lease |

Tier-2 flakes are `expect(locator).toBeVisible()` timeouts: the app must **render
within the test timeout**, which it cannot when N full suites saturate all 24
cores. The gateway-boot lease removes the *boot* spike but not the *sustained*
render contention — that needs idle CPU. Filling all cores (my first cut)
starved render and regressed the green rate; `ac1a2ff0` restores the ~⅓ idle
headroom the pre-lease design had, now combined with 2 browser workers + the
boot lease.

**Honest read:** even the pre-lease headroom config only reached 2/9 at 3-way, so
CPU headroom is necessary but likely **not sufficient** for ~0 flakes at N≥3. The
tier-2 browser render contention is the dominant residual flake driver and is the
same issue LEAD-STATE tracks as "browser-tier de-flake in flight". Whether the
headroom fix + boot lease + 2-cap reaches ~0 flakes, and at what N, **can only be
determined on a quiet box** — see §4.

---

## 4. What remains (needs a coordinated quiet window)

Per the handoff, the concurrency "bar" is now **acceptable wall-at-N with ~0
flakes**, decided by the user. To produce authoritative numbers the box must be
quiet (no competing agents), because a single peer flare invalidates a 40-min
proof (§2). Required runs, commit `ac1a2ff0`, on a quiet box:

```bash
# ping the lead first; confirm the box is quiet, then:
BOBBIT_V2_TOTAL_CORES=24 CONCURRENCY_PROOF_CONCURRENT=3 CONCURRENCY_PROOF_REPS=3 node scripts/testing-v2/concurrency-proof.mjs
BOBBIT_V2_TOTAL_CORES=24 CONCURRENCY_PROOF_CONCURRENT=4 CONCURRENCY_PROOF_REPS=3 node scripts/testing-v2/concurrency-proof.mjs
BOBBIT_V2_TOTAL_CORES=24 CONCURRENCY_PROOF_CONCURRENT=5 CONCURRENCY_PROOF_REPS=3 node scripts/testing-v2/concurrency-proof.mjs   # PING LEAD before this one
```

Record per N: green rate (target ≈0 flakes), per-run wall (rises under load —
accepted), ledger peak Σworkers (≤ cores). If a given N still flakes on a quiet
box, the residual is browser-tier render contention and the honest options are
(a) fewer concurrent runs at that N is the bar, or (b) a deeper tier-2 fix
(shard the browser tier / reduce per-test render cost) tracked as follow-up —
**never** relocate coverage to daily (hard constraint).

Tuning knobs available without code changes: `BOBBIT_V2_MAX_GATEWAY_BOOTS`,
`BOBBIT_V2_PLAYWRIGHT_WORKERS`, `VITEST_MAX_FORKS`.
