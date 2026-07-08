# Efficiency comparison — v2 vs legacy (per-commit + daily)

**Author:** test-engineer-9069 · task 47507884.
**Question (user, strategic):** *"Is v2 genuinely more efficient than legacy —
including the daily lane — on CPU-min/loop, wall, and concurrency headroom? If
not clearly better, say so."*

**Verdict up front (honest):**
- **CPU-min per loop — clear, large v2 win (~10×).** v2 per-commit ≈ **13
  CPU-min** vs legacy ≈ **130 CPU-min**. Even adding the once-a-day daily lane,
  v2 is lower total CPU at any realistic commit rate (§4).
- **Wall for a single loop — clear v2 win (~3–4×).** v2 single run ≈ **5 min**
  vs legacy ≈ **15–20 min**.
- **Concurrency reliability (≈0 flakes at N≥3) — NOT YET PROVEN for v2.** This is
  the one axis where v2 is not demonstrably better than legacy today; it is
  blocked on a quiet-box measurement of the new global budget
  (`concurrency-proof.md` §4). **This is the real finding to weigh before
  switchover.**

Numbers are labelled with their source; where a clean measurement was impossible
on the shared 46-agent box, the value is marked *estimate* / *pending*.

---

## 1. Per-commit single run (the inner loop, run many times/day)

| | Legacy (`test:unit` + e2e + build) | v2 (`test:v2`) | Source |
|---|---|---|---|
| build + check | ~3–4 min / ~10–15 CPU-min | **not needed for tier-1** (vitest imports `src/`); tier-2 needs `dist/ui` only (cache-skippable) | goal baseline table; run-v2 |
| unit / tier-1 | 504 files ~90–212 s / ~20 CPU-min | vitest 812 files/7166 tests **~219 s / part of ~13** | prior proof `f31938d1`; ~246 s with the boot lease added |
| browser-unit / tier-2 | 142 files ~76–177 s / ~15 CPU-min | playwright ~571+ tests **~276–297 s** (runs ∥ tier-1) | prior proof; 2-worker measured ~250 s |
| e2e | 214 API + 184 browser ~620 s / **~83 CPU-min** (`retries:3`) | folded into tier-1 integration + tier-2 journeys | goal baseline |
| **total wall** | **~15–20 min** (phases largely serial) | **~300 s (~5 min)**, tier-1 ∥ tier-2 | run-v2 |
| **total CPU-min** | **~130 CPU-min (>2 CPU-h with retries)** | **~13 CPU-min** | budgets.json / prior proof |

The ~10× CPU win is architectural and independent of this task: vitest
`pool:forks isolate:false` (one reused worker, gateway booted once per fork)
replaces the legacy per-file `tsx --test` spawn+transform tax (~2.5 s/file). The
global-budget work in this task does **not** change the CPU story — it trades a
little single-run **wall** for reliability:

- The gateway-boot lease adds **~+28 s** to a single tier-1 run (246 s vs 219 s)
  by serialising the fork boots through cap-4 even when uncontended. CPU-min is
  unchanged (same work, just less simultaneous).
- Chromium 4→2 workers: neutral-to-faster single-run wall (2 ≈ 4 throughput;
  leaves cores for tier-1).

> Caveat: the process-tree CPU sampler over-counts on a busy box (PID churn +
> sibling misattribution — documented in `budgets.json`). My own single-run
> sample read 22.65 CPU-min with 71 peak procs, inflated by the ~46 concurrent
> agent processes; the ~13 CPU-min figure is the quiet-box number from the prior
> proof and the budgets ceiling. A clean re-measure on a quiet box should confirm
> ~13 CPU-min for the `ac1a2ff0` config.

---

## 2. Per-commit under concurrency (wall-at-N — the queuing cost)

The global budget accepts **higher wall in exchange for ~0 flakes**
(reliability > speed). Authoritative quiet-box numbers are now in
`concurrency-proof.md` (base `12df82b6`; idle baseline ~4–12 %):

| N | playwright | vitest | per-run wall | browser cap held |
|---|---|---|---|---|
| 1 | 604 pass / 1 flake | pass | ~300 s | n/a |
| 2 | 0/4 (UI timing flakes) | 2/4 | ~507 s | 4/4 |
| 3 | **3/3 PASS** | 0/3 (tier-1 timing flakes) | ~740–786 s | 4/4 (verified) |

- **Browser-render lease: WORKING** (verified pinned at 4/4; fixed a silent
  fail-open import bug that had also disabled the browser-tier gateway-boot lease).
  It solves the browser dimension at 3-way (pw 3/3).
- **~0-flake NOT reached at N ≥ 2** — binding constraint is **tier-1 vitest**
  timing-sensitive integration tests under CPU starvation (rotating cast), which
  the browser lease cannot address. N=2 is worse than N=3 due to a `splitBundle`
  over-allocation (16 vitest workers at N=2). See `concurrency-proof.md`.
- Ledger keeps **Σworkers ≤ 24** at every N; gateway-boot + browser leases both
  cap their pools cross-process.

**Legacy concurrency** was capped at ~4 concurrent suites with `retries:3`
(masking flakes). v2 with `retries:0`: the browser tier is de-flaked, but the
honest ~0-flake ceiling is currently **tier-1-bound** — needs the clock DI seam +
the split fix, not more browser work.

---

## 3. Daily lane (tier-3, run ~once/day, NOT per-commit)

v2 moves real-fidelity coverage (real worktree/Docker/spawned-process/real-timer)
to `test:daily`. Legacy had **no separate daily tier** — it ran everything every
commit. So the fair comparison amortises daily across a day's commits.

| | Value | Source |
|---|---|---|
| daily contents | 58 relocate/adapter + ~10 manual-integration + 14 v2 daily specs + 1 full legacy run (until retirement) | LEAD-STATE daily-lane note |
| daily wall | **~25–45 min** (→ ~15–25 min post-legacy-retirement) | LEAD-STATE *estimate* |
| daily concurrency | LOW by design (1–2; real Docker/LLM/ports don't parallelise) | LEAD-STATE |
| daily CPU-min | **~30–60 CPU-min** *(estimate; hard number at the daily-lane gate)* | derived |

Hard daily numbers are owed by the daily-lane gate (build the bundle, time it).
The estimate above is sufficient for the amortisation in §4.

---

## 4. Amortised total-loop verdict

For a developer committing **K times/day**, total CPU-min/day:

| Commits/day K | Legacy = K×130 | v2 = K×13 + ~45 (daily) | v2 advantage |
|---|---|---|---|
| 1 | 130 | ~58 | **2.2×** |
| 5 | 650 | ~110 | **5.9×** |
| 10 | 1300 | ~175 | **7.4×** |

v2 is lower total CPU-min for **any K ≥ 1**, and the advantage grows with commit
rate (per-commit is where the 10× lives; daily is a fixed daily add-on). The
daily lane does **not** erase the win — it costs one ~45-CPU-min run/day against a
per-commit saving of ~117 CPU-min *each commit*.

**Wall:** per-commit v2 is ~3–4× faster (5 min vs 15–20 min). Daily adds a
~25–45 min once-daily run a developer does not wait on inline.

**So: is v2 genuinely more efficient?**
- **CPU-min and single-loop wall: YES, decisively** (≈10× CPU, ≈3–4× wall),
  including the daily lane amortised.
- **Concurrency reliability at N≥2: browser tier SOLVED, tier-1 vitest is now the
  ceiling.** Quiet-box measurement (`concurrency-proof.md`) shows the working
  browser-render lease de-flakes the browser tier at 3-way (pw 3/3), but
  `test:v2` is not ~0-flake at N≥2 because a rotating cast of timing-sensitive
  **tier-1 vitest** integration tests is starved under N-way CPU load — a
  dimension the browser lease cannot address. Honest position: v2 is far more
  efficient per loop, and its browser concurrency is fixed, but its *safe*
  ~0-flake ceiling is currently **tier-1-bound** (needs the clock DI seam + a
  `splitBundle activeParents===1` fix), lower than legacy's nominal 4. The user
  should weigh this before switchover; the remaining work is tier-1, not browser.

## 5. Reproduce

```bash
# per-commit single (quiet box):
BOBBIT_V2_TOTAL_CORES=24 npm run test:v2                    # wall + whole-tree CPU printed by run-v2
# per-N (quiet box; see concurrency-proof.md §4):
CONCURRENCY_PROOF_CONCURRENT=3 CONCURRENCY_PROOF_REPS=3 node scripts/testing-v2/concurrency-proof.mjs
# daily lane (time it for the hard daily CPU-min number):
npm run test:daily
```
