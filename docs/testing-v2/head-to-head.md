# Head-to-head: legacy vs v2 — measured wall + CPU cost (task 190c7af5)

> ## ⏩ UPDATE (task 7862db76, test-engineer-6d58, 2026-07-08) — e2e:v2 is now GREEN + proven external-free
>
> The §4 caveats ("e2e:v2 under-measured, not yet green, no runner") are RESOLVED.
> A reusable runner (`scripts/testing-v2/run-e2e-v2.mjs`, `npm run test:e2e:v2`)
> now drives the whole real-fidelity tier from `tests2/tests-map.json`. Read the
> new **§8 (green e2e:v2)**, **§9 (external-service-free proof)**, and **§10 (the
> corrected honest TOTAL)** below.
>
> **§10 result (under peer load, Docker-inclusive, complete+green e2e, subtree
> CPU authoritative):** legacy **73.1 CPU-min** vs v2 **37.4 CPU-min → 1.96× CPU**
> (wall 14.5 m vs 10.3 m, load-caveated; clean-wall reference stays §1's 16.9 vs
> 7.5). The ~2.3×→~1.96× narrowing is precisely the cost of completing the e2e:v2
> tier (Docker + 2 fixed specs; the old 5.75 CPU-min was a floor, now 7.42) — v2
> is still ~2× cheaper on CPU with the tier fully green at retries:0.
>
> Headline so far (defaults caps: node `--test-concurrency=1`, Playwright
> `--workers=2`, groups sequential, `retries:0`):
> **A(node) 61 pass · B(e2e) 43 pass · C(browser) 79 pass / 12 skip → 183 pass /
> 0 fail**, total wall ~212–229 s. Two spec issues from §4 fixed:
> `stories-navigation` (missing `spec-framework`/`story-registry` shims — added)
> and `tail-chat-real-stream` (`spawn bash.exe ENOENT` — a cross-spec cwd-poison,
> root-caused + fixed; see §8). **Docker is now AVAILABLE on this box** (it was
> absent for the §1 run), so `sandbox-recovery` runs its Docker paths here —
> handled symmetrically for both suites in §10.

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
# e2e:v2 — now a single reusable runner (tracks tests-map.json, not a frozen list):
npm run test:e2e:v2                    # build + A(node) → B(e2e) → C(browser), retries:0
node scripts/testing-v2/run-e2e-v2.mjs --group A|B|C   # one group at a time
node scripts/testing-v2/run-e2e-v2.mjs --list          # show classification + exclusions
```

---

## 8. e2e:v2 is GREEN (task 7862db76)

The real-fidelity tier is now a reusable runner —
`scripts/testing-v2/run-e2e-v2.mjs` (`npm run test:e2e:v2`) — that classifies the
`daily`-bucket entries of `tests2/tests-map.json` into three groups, MINUS
`manual-integration` (the real-LLM/agent lane) and MINUS the "one full legacy
run" step. So it tracks the map instead of a hand-assembled snapshot.

| group | what | run via | result | wall | peak procs |
|---|---|---|---|---|---|
| A / node-relocate | 14 specs: real git worktree pool / sweeper / sandbox-mount / spawn-tree | `tsx --test` | **61 pass / 0 fail** | ~34–40 s | 16 |
| B / e2e-relocate | 18 specs: real worktree pool / MCP subprocess / port / restart | `test:e2e:run` `--retries=0` | **43 pass / 0 fail** | ~86–100 s | 27 |
| C / adapter-browser | 13 specs (browser-v2-daily project) | `playwright-v2` `retries:0` | **79 pass / 0 fail / 12 skip** | ~89–91 s | 32 |
| **total** | | sequential | **183 pass / 0 fail / 12 skip** | **~212–229 s** | 34 |

The 12 skips are `terminal-pack` cases (bash/terminal-gated) — a symmetric,
environment-honest skip, not a masked failure.

### Resource caps (why this can't re-crash the box)
A prior heavy e2e:v2 run crashed the server + corrupted `node_modules` (Group A
ran ~CPU-count worktree specs concurrently → an `npm ci` swarm in worktree setup
→ resource exhaustion mid-op → interrupted `npm ci` → gutted `.bin`). The runner
is now capped by default and was monitored throughout this run (process count +
`node_modules/.bin` integrity on both goal + primary worktrees stayed flat):
- **Group A node:test serialised** — `--test-concurrency=1` (override
  `E2E_V2_NODE_CONCURRENCY`); this is the swarm source.
- **Playwright workers bounded to 2** (override `E2E_V2_PW_WORKERS`).
- **Groups run sequentially**; external-free env baked in.

### The two §4 spec issues — fixed (retries:0, no weakening, no relocation)
1. **`stories-navigation.spec.ts`** — aborted collection on a broken
   `./spec-framework.js` import. Fix: the missing `spec-framework.ts` /
   `story-registry.ts` shims were added under `tests2/browser/daily/`
   (re-export from `../fixtures/*`, which shim to `tests/e2e/ui/*`). All
   N-01…N-10 routing cases now run green.
2. **`tail-chat-real-stream.spec.ts`** — `spawn C:/Program Files/Git/bin/bash.exe
   ENOENT`. Root-caused as **cross-spec cwd poisoning**, NOT an environment gap
   (the shell resolves fine; `spawn <shell> ENOENT` on a valid shell path means
   the child's `cwd` doesn't exist). `pr-walkthrough-pack`'s dogfood test calls
   `setupSessionGitRepo` on a UI default-project session whose cwd, absent a
   dedicated worktree, IS the shared harness default project root — so the
   `git init` turns that shared root into a repo. Every later session on the
   worker is then treated as inside-a-repo → the gateway provisions an unexpected
   worktree whose checkout lacks the untracked `.e2e-workspaces` subdir handed
   out as a session cwd → a later `bash_bg` spawn (STREAM_BURST → real `sleep`
   bg-process) runs in a nonexistent cwd → ENOENT. Deterministically reproduced
   (pr-walkthrough → tail-chat, `workers=1`: 7 pass / 1 fail) and fixed by
   un-poisoning in `pr-walkthrough-pack`'s `afterEach` (remove the `.git` we
   created; discriminate dir-vs-file so worktree gitlinks are untouched) → 8/8
   green. This flake existed latently in **legacy too**, masked by `retries:3`;
   the same afterEach fix should be ported to `tests/e2e/ui/pr-walkthrough-pack.spec.ts`.

---

## 9. External-service-free — verified empirically (hard user constraint)

**Requirement:** e2e:v2 makes ZERO external-service calls — no real LLM, no real
GitHub remote, no non-loopback HTTP; real LOCAL ops only + the in-process MOCK
agent bridge (exactly like legacy e2e).

**Enforcement chain (code):**
- **Agent turns → in-process MOCK bridge.** `gateway-harness.ts` registers
  `InProcessMockBridge` via `registerRpcBridgeFactory`, so no turn ever reaches a
  real provider. The runner never sets real credentials.
- **`BOBBIT_TEST_NO_EXTERNAL=1` + `BOBBIT_TEST_NO_REMOTE=1`** (baked into every
  group in `run-e2e-v2.mjs`) →
  - `testNoExternal` ⇒ `aigw-manager.externalNetworkBlockedForTests()` true ⇒
    AIGW discovery + provider fetch are hard-refused for non-local URLs
    (`aigw-manager.ts:867` throws `External AI Gateway discovery is disabled`).
  - `skipNonLocalRemoteGit` ⇒ `skills/git.ts.shouldSkipRemoteGitForTests()` fails
    closed on any non-`file://`/non-local git remote (push/fetch/clone/ls-remote).
  - `skipMcp` default ⇒ no MCP subprocess (specs opt back in only for local MCP).
- Deliberately **not** `BOBBIT_TEST_NO_PUSH`: the realpush specs push to a LOCAL
  BARE repo on disk (a file path, never a network remote) — still external-free.

**Empirical proof — a process-tree egress guard:**
`scripts/testing-v2/fetch-egress-guard.mjs` is preloaded via
`NODE_OPTIONS=--import …` into EVERY node process of the run (the in-process
gateway shares the Playwright worker process; node relocate specs; npm/npx
children; the bg-runner helper). It wraps `globalThis.fetch` and
`node:http`/`node:https` `request`/`get`, and appends any request whose host is
**not** loopback/link-local/RFC1918/CGNAT to `$EGRESS_LOG` (JSONL).

- **Full `test:e2e:v2` run under the guard → the egress log was EMPTY (0
  entries).** No non-loopback HTTP from any group, including npm/git child
  processes. The run stayed green (A 61 / B 43 / C 79-pass-12-skip).
- **Positive control (proves the guard is not silently no-op):** a node process
  preloaded with the same guard that does `fetch('https://api.github.com/')` +
  `https.get('https://registry.npmjs.org/')` + `fetch('http://127.0.0.1:9/')`
  logged the two external hosts and correctly IGNORED the loopback one.
- Corroborating: the B-group logs show `git fetch origin` **failing** on the
  negative-path specs — i.e. the git fence rejecting real remotes, as designed.

**No e2e:v2 spec reaches out.** The `github.com` URLs present in the
pr-walkthrough specs are test DATA used to assert fenced / NO_PR behaviour, never
fetched (confirmed by the empty egress log). Conclusion: e2e:v2 is
external-service-free, enforced structurally (mock bridge + fail-closed
fetch/git) and proven empirically.

**Reproduce the proof:**
```bash
: > .profiles/testing-v2/egress.jsonl
EGRESS_LOG="$PWD/.profiles/testing-v2/egress.jsonl" \
NODE_OPTIONS="--import file://$PWD/scripts/testing-v2/fetch-egress-guard.mjs" \
  node scripts/testing-v2/run-e2e-v2.mjs      # egress.jsonl must stay empty
```

---

## 10. Corrected honest TOTAL — complete + Docker-inclusive + green (task 7862db76)

Re-measured back-to-back, sequentially, with the same subtree-scoped CPU
methodology (§2/§5), via the committed wrapper
`scripts/testing-v2/measure-subtree.mjs` (keys CPU on `(pid, CreationDate)` and
excludes pre-run procs — corrects the §5 over-count). **This run is strictly MORE
complete than §1:** e2e:v2 is now the full green tier (both §4 specs fixed) and
**Docker is available on both sides** (symmetric). It was measured **under peer
load** (~47 peer agent procs, per the user's "measure-under-load" decision), so
**CPU-min is the authoritative metric** (subtree-scoped ⇒ load-robust) and
**wall is reported-but-caveated** (absolute wall inflated by peers; the ratio is
back-to-back same-conditions so still indicative).

### Headline (build-excluded, Docker-inclusive, subtree CPU)

| phase | legacy CPU-min | v2 CPU-min | legacy wall | v2 wall |
|---|---|---|---|---|
| unit | 26.62 | 29.96 | 210.8 s | 392.4 s |
| e2e  | 46.47 | **7.42** | 661.1 s | 224.7 s |
| **TOTAL** | **73.09** | **37.38** | **871.9 s (14.5 m)** | **617.1 s (10.3 m)** |

- **CPU ratio (authoritative): legacy ÷ v2 = 1.96×.** Wall ratio 1.41× (load-caveated).
- **Clean-wall reference (prior quiet-box §1): 16.9 m vs 7.5 m.** Do not quote
  this run's absolute wall as the clean number — see the wall caveat below.

### Pass/fail (this run)

| phase | legacy | v2 |
|---|---|---|
| unit | code 1 = the **1 known** env-artifact fail (`tool-docs-prompt.test.ts` "returns empty string when no tools exist" — the goal's `defaultBuiltinToolsDir` repo-root fallback; confirmed by single-file re-run, NOT a regression) | **7842 pass / 0 fail** / 46 skip (tier-1 7147+27skip · tier-2 695+19skip) |
| e2e | **PASS** (retries:3 absorbing any flakes) | **183 pass / 0 fail** / 12 skip (A 61 · B 43 · C 79+12skip), **retries:0** |

> The v2 `test:v2` command exits 1 under load, but **not** on a test failure — it
> trips run-v2's **wall-budget cap** (`wall 392.1 s > 300 s`); the tiers were run
> directly to confirm 0 test failures. On a quiet box v2 unit was 297 s (within cap).

### How the complete + Docker e2e moved the ~2.3×

The prior §1 TOTAL ratio was **2.32× CPU**. The honest, complete number is **1.96×**.
The narrowing is exactly what completing the tier costs — the earlier figure was a
FLOOR (§4), this is the real number:

1. **e2e:v2 went from an under-measured 5.75 → an honest 7.42 CPU-min** (+29%).
   §1 excluded Docker entirely, skipped 12 terminal cases, and dropped 1 broken +
   1 failing spec. This run runs the Docker paths (`sandbox-recovery`), the fixed
   `stories-navigation` + `tail-chat-real-stream`, all green at retries:0. So v2's
   real per-workflow e2e cost is now counted, not floored.
2. **Peer load lifts BOTH suites' subtree CPU ~proportionally** (legacy unit
   22.36→26.62 ≈ +19%; v2 unit 24.70→29.96 ≈ +21%) — context-switch/cache
   overhead under contention. This roughly cancels in the unit ratio; it is NOT a
   v2-specific penalty.
3. **legacy e2e is ~flat** (48.24→46.47, load-noise).

**Bottom line:** even with the e2e tier now COMPLETE, GREEN at `retries:0`, and
**Docker-inclusive**, v2 is **~2× cheaper on CPU** (73.1 → 37.4 CPU-min) — a real,
solid, honestly-measured win. It is smaller than the earlier 2.3× *specifically
because* the e2e:v2 tier is no longer under-measured. e2e:v2 is proven
external-service-free (§9). The dominant CPU savings remain structural: vitest
`pool:forks isolate:false` (one reused gateway per fork) replacing legacy's
per-file `tsx` spawn+transform tax, and consolidating the browser-e2e specs into
journeys — with the residual real-fidelity remainder (worktree/pool/MCP/Docker)
kept as the cheap 7.4-CPU-min e2e:v2 lane.

### Wall caveat (read before quoting wall)
Absolute wall here is inflated by ~47 peer procs and is NOT the clean number
(§1's 16.9 m / 7.5 m is). Notably v2's fork model is more sensitive to CPU
starvation than legacy's already-slow process-per-file model, so under load v2
unit wall rose past its 300 s budget (392 s). The back-to-back **ratio** (1.41×
wall) is still indicative because both suites ran under the same load, sequentially.

### Reproduce
```bash
node scripts/testing-v2/measure-subtree.mjs legacy-unit out.json -- npm run test:unit
BOBBIT_E2E_SKIP_GUARDS=1 node scripts/testing-v2/measure-subtree.mjs legacy-e2e out.json -- npm run test:e2e
node scripts/testing-v2/measure-subtree.mjs v2-unit   out.json -- npm run test:v2   # exits 1 on wall-budget under load; tiers green
node scripts/testing-v2/measure-subtree.mjs e2e-v2    out.json -- node scripts/testing-v2/run-e2e-v2.mjs
```
