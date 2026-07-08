# Concurrency Proof — global browser-render lease + quiet-box N-curve

**Generated:** 2026-07-08 (real quiet-box measurements; NO dry-run, NO placeholders).
**Base commit:** `12df82b6` (goal HEAD incl. gateway-boot lease + **working** browser-render lease + orphan fix).
**Box:** 24-core AMD Ryzen AI 9 HX 370, Windows, Node 24. Idle baseline **~4–12 % CPU** (30 idle peer-agent processes; the OLED screensaver's earlier apparent load was test-teardown tail, not steady contention — the box is genuinely quiet). `retries: 0`. Wall **decoupled from flakes** for measurement via `BOBBIT_V2_PERRUN_WALL_MS=1800000` so a run's exit reflects TEST outcome, not the (large) queuing wall — wall is recorded separately.
**Harness:** `scripts/testing-v2/concurrency-proof.mjs` for N=3; per-run manual capture (3 throwaway worktrees, each own `npm ci`+`dist`, shared cross-process ledger) for N=2/N=3 detail.

> **This supersedes the pre-`12df82b6` "authored summary".** Re-running the proof
> harness overwrites this file with its single-snapshot format.

---

## Headline

1. **The global browser-render lease is BUILT, WORKING, and verified.** A second
   cross-process lease pool (`browser`, cap in `tests2/budget-caps.json`, default
   4) caps the TOTAL number of Chromium browser workers rendering the app at once
   across ALL concurrent `test:v2`/e2e runs — analogous to the gateway-boot lease.
   During a 3-way run the pool was **pinned at exactly 4/4 for the whole browser
   tier** (sampled continuously; never exceeded 4), with 2 of the 6 requested
   workers correctly waiting. Cross-tier + cross-process interop is pinned by
   `tests2/core/ledger-lease-bridge-interop.test.ts`.

2. **It fixed a silent, pre-existing bug.** The lease import *never fired* before
   this work: importing `scripts/testing-v2/ledger.mjs` from a Playwright-
   transformed file throws "exports is not defined in ES module scope" (Playwright
   mistransforms a `.mjs` outside its test root toward CJS), which the fail-open
   `catch` swallowed. **The prior agent's gateway-boot lease in the browser tier
   was silently dead for the same reason.** Both now load via a Playwright-ESM-safe
   co-located client, `tests/e2e/ledger-lease-bridge.mjs`, that speaks the same
   on-disk protocol as the ledger.

3. **With the lease working, the browser tier is fixed at 3-way** (playwright
   **3/3 PASS** where it previously flaked), **but `test:v2` is NOT ~0-flake at
   N ≥ 2.** The residual is **tier-1 vitest**, which the browser lease cannot
   touch: a rotating cast of timing-sensitive integration tests starved by CPU
   under N-way load. **Flagged per the goal owner's instruction: the browser lease
   alone cannot crack ~0-flake at 3.**

---

## Authoritative N-curve (quiet box, retries:0, wall decoupled)

| N | green (both tiers) | playwright | vitest | per-run wall | browser lease peak | Σworkers |
|---|---|---|---|---|---|---|
| **1** (single `test:v2`) | ~near-clean | 604 pass / 1 flake¹ | pass | ~300 s | n/a (2≤cap) | — |
| **2** (×2 reps = 4 runs) | **0/4** | **0/4** (rotating UI timing flakes²) | 2/4³ | ~507 s | 4/4 | ~20/24 |
| **3** (×1 clean rep = 3 runs) | **0/3** | **3/3 PASS** ✅ | **0/3** (rotating tier-1 timing flakes⁴) | ~740–786 s | 4/4 (verified held) | 15/24 |

¹ Single-run flake = `session-actions › canonical labels` (a load-sensitive render
  assertion; passes 2/2 in isolation). Even N=1 is not *perfectly* clean under the
  peer-agent baseline.
² N=2 playwright rotating cast: `app-smoke ▸ Ctrl+ArrowDown keyboard-nav`,
  `goal-team-gates ▸ archived child`, `verification-dedup`, `proposal-panel-
  streaming ▸ PPS-04 follow-tail`. All are render-/WS-timing assertions (e.g.
  `data-nav-id` rows = 0 → sidebar not yet populated when evaluated).
³ One N=2 run (`n2-r2-0`) suffered a **full v2-integration collapse** (~all 150
  files failed), not individual flakes — a resource-exhaustion cascade (see §"Why
  N=2 is worse than N=3").
⁴ N=3 vitest rotating cast: `verification-command-restart-lifecycle` (2/3 runs,
  ~28–30 s, near the 30 s test timeout), `project-reorder-api`, `multi-repo-goal`
  (real-git, ~24 s). Different tests each run — the classic CPU-starvation
  signature, not one deterministic failure.

**Highest cleanly ~0-flake N (this box, this build): N=1 for the browser tier is
effectively solved; but no N ≥ 2 is ~0-flake because of tier-1 vitest.** The honest
"bar" the goal owner asked for is therefore gated by tier-1, not the browser lease.

4-way / 5-way were **not run**: 3-way already fails the ~0-flake bar on tier-1, and
higher N is strictly worse (more CPU starvation) — running them would only reconfirm
the tier-1 ceiling at greater cost.

---

## Why the browser lease is necessary but not sufficient

- **Browser dimension — SOLVED.** Capping concurrent Chromium to 4 (from 6 at
  3-way) gave playwright 3/3 at N=3. The lever works exactly as designed.
- **Tier-1 vitest dimension — UNTOUCHED.** Each concurrent `test:v2` boots many
  in-process gateways for its v2-integration tests; those tests are timing-
  sensitive (real timers, real git, restart/verification lifecycles) and, under
  N-way CPU saturation, miss their timeouts. The browser lease frees GPU/render
  pressure, not the CPU that starves these. Fixing them needs a **different**
  lever (the goal's clock DI seam → drive on observable state instead of
  wall-clock; and/or de-flaking the real-git/real-spawn integration cluster) —
  out of scope for a browser-render lease.

### Why N=2 is *worse* than N=3 (a real, actionable ledger finding)

Counter-intuitively N=2 flaked harder than N=3. Root cause is the ledger's
`splitBundle`: at **N=2 each run's grant = `floor(24/2)=12 = MAX_BUNDLE`**, which
takes the **uncontended split (8 vitest + 2 playwright)** intended for a *single*
run. Two runs → **16 vitest workers + 4 browsers** → CPU oversubscription that
both starves browser render (→ pw timing flakes) and, in one run, collapsed the
whole v2-integration project. At **N=3** grant = `floor(24/3)=8` → the *contended*
split (3 vitest + 2 playwright) → **9 vitest workers total** → render survives →
pw passes. `splitBundle(grant)` cannot distinguish "1 run @ grant 12" from "N=2
each @ grant 12" from `grant` alone. **Recommendation (separate change): use the
full-vitest uncontended split only when `activeParents === 1`.** Not fixed here to
avoid destabilising the parked headroom tuning.

### Wall cost of the hard cap

cap-4 with 6 requested workers at N=3 head-of-line-blocks (worker-scoped lease held
for a worker's whole life), roughly doubling browser-tier wall and pushing per-run
wall to **~740–786 s** (vs ~300 s isolated). This is the accepted "reliability >
speed" trade — but it is steep, and a finer (per-test) lease would pipeline better
at the cost of charging queue-wait against the 60 s test timeout (rejected here as
it would create *new* false-timeout flakes).

---

## What was delivered (this task)

- `scripts/testing-v2/ledger.mjs`: `browser` lease pool + `acquireBrowserRenderLease`,
  per-pool max-hold (browser 30 min vs gateway-boot 3 min), cap from
  `tests2/budget-caps.json` (+ `BOBBIT_V2_MAX_BROWSER` override). `--selftest` extended.
- `tests2/budget-caps.json`: committed caps (`gateway-boot` 4, `browser` 4).
- `tests/e2e/ledger-lease-bridge.mjs`: Playwright-ESM-safe lease client (fixes the
  silent-fail import bug for BOTH leases).
- `tests/e2e/gateway-harness.ts`: worker-scoped `browserRenderLease` fixture
  (v2-only gate, acquired before gateway boot, own large timeout so the wait is
  NOT charged to the 60 s test timeout).
- `playwright-v2.config.ts`: `BOBBIT_V2_BROWSER_LEASE=1`.
- `tests2/core/ledger-lease-bridge-interop.test.ts`: pins bridge↔ledger protocol.
- `scripts/testing-v2/assert-budget.mjs`: `BOBBIT_V2_PERRUN_WALL_MS` override to
  decouple flake vs wall during measurement (committed bar unchanged).

## Recommendation to the goal owner

The browser-render lever is done and correct. To reach ~0-flake at N ≥ 2 the
binding work is now **tier-1 vitest**: (a) the clock DI seam for the timing-
sensitive integration cluster, and (b) the `splitBundle` `activeParents===1`
fix so N=2 stops over-allocating vitest. Set the concurrency bar accordingly —
on this build the honest ~0-flake ceiling is tier-1-bound, not browser-bound.

## Reproduce

```bash
# 3-way, flake signal decoupled from wall (author's measurement mode):
BOBBIT_V2_TOTAL_CORES=24 CONCURRENCY_PROOF_CONCURRENT=3 CONCURRENCY_PROOF_REPS=3 \
  CONCURRENCY_PROOF_WALL_S=1800 BOBBIT_V2_PERRUN_WALL_MS=1800000 \
  node scripts/testing-v2/concurrency-proof.mjs
# confirm the browser cap holds during a run:
watch -n1 'node scripts/testing-v2/ledger.mjs --status | grep leases:'   # browser ≤ 4
```
