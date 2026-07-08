# Head-to-head: legacy vs v2 — measured wall + CPU cost (task 190c7af5)

**What this is:** a clean, apples-to-apples **cost** measurement (not a
concurrency test) of the whole suite run **both ways, sequentially, back-to-back
on a quiet box**, with CPU scoped to the **suite's own process subtree** (not the
whole machine). It supersedes the partly-estimated figures in
`efficiency-comparison.md` — several of which turn out to have been inflated by a
measurement artifact (see §5).

**Author:** test-engineer-3173. **Base:** goal HEAD `9c58a4e4`. **Box:** 24-core
AMD Ryzen AI 9 HX 370 laptop. **Date:** 2026-07-08.

---

## Headline table

Ratio = legacy ÷ v2 (>1 ⇒ v2 cheaper/faster). CPU is process-subtree CPU-min.

| phase | legacy wall | legacy CPU-min | v2 wall | v2 CPU-min | wall ratio | CPU ratio |
|---|---|---|---|---|---|---|
| unit | 195.3 s | 22.36 | 297.4 s | 24.70 | 0.66× | 0.91× |
| e2e  | 817.8 s | 48.24 | 153.1 s | 5.75 | 5.34× | 8.39× |
| **TOTAL** | **1013.1 s (16.9 min)** | **70.60** | **450.5 s (7.5 min)** | **30.45** | **2.25×** | **2.32×** |

**Pass/fail (this run):**

| phase | legacy | v2 |
|---|---|---|
| unit | 5217 pass / **1 fail** / 16 skip (5234) | 7762 pass / 0 fail / 35 skip (tier-1 7147+27skip; tier-2 615+8skip) |
| e2e | 1571 pass / **8 flaky** (passed on retry) / 23 skip | 168 pass / **1 fail** / 12 skip (A 61p · B 43p · C 64p/1f/12skip) |

> Both suites map to the user's `unit`+`e2e` model:
> **legacy** = `npm run test:unit` then `npm run test:e2e`;
> **v2** = `npm run test:v2` (unit) then the real-fidelity daily tier (e2e) =
> all daily-bucket specs **minus** `manual-integration` **minus** the "1 full
> legacy run" daily step. e2e:v2 was **assembled** (no daily runner exists yet,
> see §4): 14 node relocate specs via `tsx --test` (Group A), 18 Playwright e2e
> relocate specs via the legacy e2e config at `--retries=0` (Group B), and 13
> migrated adapter browser specs via a temp `playwright-v2-daily` config at
> `retries:0` (Group C).

---

## 1. Honest read — up front

- **Whole-suite, v2 wins ~2.3× on both wall and CPU** (16.9 min → 7.5 min;
  70.6 → 30.5 CPU-min). This is a **real, solid win**, driven by vitest
  `pool:forks isolate:false` (one gateway booted per fork, reused) replacing the
  legacy per-file `tsx --test` spawn+transform tax, plus consolidating ~1571
  browser-e2e specs into ~615 journeys.
- **It is NOT the ~10× CPU / ~3–4× wall claimed in `efficiency-comparison.md`.**
  That headline compared an **inflated** legacy baseline (~130 CPU-min, whole-
  machine sampling on a busy box, build included) against an **optimistic** v2
  target (13 CPU-min = the budget ceiling, not a measurement). Measured cleanly
  and subtree-scoped, the honest numbers are legacy **70.6** vs v2 **30.5**
  CPU-min → **2.3×**, and both v2's own `run-v2` sampler and this task's
  independent sampler agree v2 is ~**24.7 CPU-min** for tier-1+tier-2, not 13.
- **Where v2 does NOT win:** the `unit` phase in isolation — v2 is **1.5× slower
  in wall** and ~equal in CPU there — because v2 *folds the API-integration tier
  into tier-1* (see §3). Per-phase rows are apples-to-oranges; **only the TOTAL
  is a fair comparison.**
- **The e2e real-fidelity tier is cheap (5.75 CPU-min) but UNDER-measured and
  not yet green** — no daily runner exists, Docker specs can't run on this box,
  and 2 specs are broken/failing in this environment (§4). A fully-green daily
  lane will cost somewhat more than 5.75 CPU-min.

---

## 2. Method & rigour

- **Sequential, back-to-back, quiet box.** Idle CPU 7–17% before each run. No
  peer test suite ran during measurement (ledger empty; per-run stale-exclusion
  was ~0 CPU-min for every v2 run — see §5 — confirming no peer contamination).
  Peer task `4bb07af1` (tier-1 N-curve) was idle throughout.
- **Subtree-scoped CPU.** A wrapper samples `KernelModeTime+UserModeTime` for
  **only the descendants of the spawned command's PID**, every 500 ms, keyed on
  `(pid, CreationDate)` and **filtered to processes created after the run
  started** (§5). Whole-machine sampling was explicitly avoided — it is what
  inflated the earlier figures.
- **Build excluded from both** (pre-built `dist/` once, not counted).
  `npm run test:e2e` re-runs an incremental `npm run build` inside its wall
  (~seconds); v2 tier-1 needs no build, tier-2 needs `dist/ui` (pre-built). A
  cold build (~3–4 min) would be charged to legacy before *every* e2e run and to
  v2 tier-2 only — it widens v2's edge modestly, not to 10×.
- **Retry asymmetry (important):** legacy ran `retries:3` (its committed policy),
  which **masked 8 e2e flakes** and added their retry wall+CPU to the legacy
  numbers. v2 ran **`retries:0`** everywhere. So legacy's e2e cost is partly
  retry-inflated *and* hides instability the retries paper over.

---

## 3. Why per-phase is apples-to-oranges (read before quoting a row)

v2 does **not** keep the legacy unit/e2e split. It moves the **API-integration
tier** (gateway-per-worker REST tests — in legacy these live in the e2e phase)
**into tier-1**, i.e. into v2's "unit". Consequently:

- **v2 `unit`** runs **7762 tests** (core + happy-dom + integration + 615 browser
  journeys) for 24.7 CPU-min. **legacy `unit`** runs **5234 tests** (node logic +
  browser fixtures, *no* API/integration) for 22.4 CPU-min. v2 unit is slower in
  wall because it absorbs the integration work — but it does **strictly more**.
- **legacy `e2e`** is the entire integration+browser suite (**1602 specs**,
  48 CPU-min). **v2 `e2e`** is only the **real-fidelity remainder** (168 specs,
  5.75 CPU-min) — the bulk of legacy-e2e's coverage moved into v2 tier-1.

⇒ The e2e row's 5–8× ratio is **not** "v2 e2e is 8× cheaper than legacy e2e for
the same work"; it reflects that most e2e work was relocated into unit. **The
TOTAL row (2.25× / 2.32×) is the only fair single-number comparison.**

---

## 4. The e2e real-fidelity tier — real cost + real gaps

This tier had never been cleanly measured; the honest findings:

- **No daily runner exists.** `package.json`'s `test:daily` points at
  `scripts/testing-v2/run-daily.mjs`, which is **absent**. The tier had to be
  assembled by hand from the 45 non-manual-integration daily-bucket entries.
- **Group A (14 node relocate specs — worktree pool/sweeper/sandbox-mount/
  spawn-tree):** 61 pass / 0 fail, 11.1 s, 0.33 CPU-min. Clean.
- **Group B (18 Playwright e2e relocate specs — worktree/MCP/pool/port,
  `retries:0`):** 43 pass / 0 flaky, 67.5 s, 2.62 CPU-min. Clean at retries:0.
- **Group C (13 adapter browser specs, `retries:0`):** 64 pass / **1 fail** /
  12 skip, 74.5 s, 2.8 CPU-min. Gaps:
  - `stories-navigation.spec.ts` — **excluded**, broken import
    (`./spec-framework.js` was never copied into `tests2/browser/daily/`);
    aborts collection.
  - `tail-chat-real-stream.spec.ts` — **fails** (`spawn bash.exe ENOENT`).
  - 12 `terminal-pack` cases **skipped** (bash/terminal-gated).
- **Docker unavailable on this box** → any Docker-backed daily spec
  (`sandbox-recovery`, and all `manual-integration` Docker specs, which are
  correctly excluded) cannot run here. **`sandbox-recovery` passed only its
  non-Docker paths.**

⇒ **5.75 CPU-min is a floor, not the steady-state daily cost.** It excludes
Docker entirely, skips terminal specs, and drops 1 broken + 1 failing spec. Once
the daily runner exists and these are green + Docker is present, expect the
real-fidelity tier to cost more (still small vs legacy e2e's 48 CPU-min, because
it is a genuine subset).

Note also these relocate specs run in their **current (largely legacy) form** —
they have **not** been ported to the v2 DI harness yet — so this is "what the v2
daily lane will contain," measured as it exists today.

---

## 5. The measurement artifact that inflated prior numbers (why trust these)

The CPU sampler shared by `run-v2.mjs` and `scripts/metrics` keys cumulative CPU
**on PID alone**. On Windows, a high-churn suite (legacy spawns ~500 short-lived
per-file `tsx` workers) triggers two failure modes:

1. **PID reuse** — recycled PIDs accumulate phantom CPU across every process that
   held the slot.
2. **Stale-ppid misattribution** — under churn, long-lived heavy processes (the
   **Windows Idle process PID 0**, the dev server at ~10 000 CPU-s, Defender)
   transiently acquire a `ParentProcessId` that collides with a reused PID inside
   the subtree and get counted.

Uncorrected, this sampler read **1938 CPU-min** for the 195 s / 24-core legacy
unit run — **physically impossible** (ceiling ≈ 78 CPU-min). The fix used here:
key on `(pid, CreationDate)` **and exclude any subtree process created before the
run began** (plus PID 0/4). That drops legacy-unit to a credible **22.4 CPU-min**
and legacy-e2e's stale-exclusion counter shows **2018 CPU-min of Idle/misattributed
CPU stripped** from that run alone.

**Cross-check:** for the low-churn v2 fork model the artifact does not bite —
`run-v2`'s own (pid-only) sampler read **24.36 CPU-min** and this task's
corrected sampler read **24.70** on the same run (agreement ⇒ both trustworthy
when churn is low). The sampler was also validated on two controlled workloads
(4-thread burn → 0.3 CPU-min expected/measured; 30-process churn → no
over-count). **Consequence: every legacy CPU figure produced by the pid-only
sampler on a churny suite should be treated as inflated.**

---

## 6. Caveats summary

- Per-phase rows are not comparable (§3); quote the TOTAL.
- Legacy `retries:3` masks 8 e2e flakes and adds retry cost; v2 `retries:0`.
- `npm run test:e2e` is currently **blocked at a pre-flight `no-new-sleeps` lint**
  (the goal added a sleep in `ledger-lease-bridge.mjs` without ratcheting the
  baseline); measured with `BOBBIT_E2E_SKIP_GUARDS=1` so the *tests* run. Fix the
  baseline before switchover.
- Legacy unit's 1 failure (`tests/tool-docs-prompt.test.ts` "returns empty string
  when no tools exist") is an environment/isolation artifact (builtin tool-docs
  present in this fully-built worktree — likely the goal's `defaultBuiltinToolsDir`
  repo-root fallback), not a suite-cost signal, but worth a look.
- e2e:v2 is a floor (§4): no daily runner, no Docker, 2 non-green specs.
- Build excluded from both; a cold build would widen v2's edge modestly.

## 7. Reproduce

```bash
# subtree-scoped wrapper (this task, kept out-of-tree):
#   node measure.mjs <label> <out.json> -- <cmd...>
npm run test:unit                                   # legacy unit
BOBBIT_E2E_SKIP_GUARDS=1 npm run test:e2e           # legacy e2e (bypass sleep lint)
npm run test:v2                                     # v2 unit (tier-1 + tier-2)
# e2e:v2 (assembled; minus manual-integration, minus full-legacy):
npx tsx --test --test-force-exit <14 node relocate daily specs>            # Group A
npm run test:e2e:run -- <18 tests/e2e relocate daily specs> --retries=0    # Group B
npx playwright test --config playwright-v2-daily.config.ts <13 adapter>    # Group C
```
