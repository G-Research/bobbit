# Test Suite Speed & Selectivity — Design Analysis

> Analysis commissioned to answer: *are there fundamental flaws in our test
> approach, can the whole suite run sub-1-minute, can we run many suites at once,
> and can we re-architect so a change only re-tests the relevant sub-parts?*
>
> Short answer: the current design is a well-engineered **ice-cream cone**. It is
> reliable and isolated, but the wall-time floor is structural, not incidental.
> No amount of tuning gets the *whole* suite to <1 min. Sub-1-min is achievable
> **per change** via affected-test selection + result caching, and that requires
> module-boundary re-architecture the codebase does not have yet.

## 1. What we measured (facts, not vibes)

Numbers from `tests-map.json` and `docs/testing-v2/fast-gate-progress.md`
(qualification host: 24 logical CPUs, Windows).

| Layer | Files | Tests | Runner | Wall time | Notes |
|---|---:|---:|---|---:|---|
| unit (`test:unit`) | 890 | ~7,594 | Vitest, **fixed 3-worker cap** | **~270 s** | tier-1 "fast" gate |
| browser (`test:browser`) | 216 | — | Playwright + spawned gateway + mock agent | multi-minute | each journey boots a real server |
| e2e (`test:e2e`) | 63 (`daily`) | — | Groups A–D: git/worktree/Docker/MCP/restart | multi-minute | real-fidelity |
| manual | — | — | real LLM + Docker | ~5 min | gate-exempt |
| **census** | **1,138** | — | — | **>10 min end-to-end** | `npm test` runs the three gates serially |

Unit-tier phase breakdown (green run, summed across 3 workers ≈ 760–810 CPU-s):

| Phase | CPU-s | Share |
|---|---:|---:|
| Tests | ~490 | ~64% |
| Import | ~95 | ~12% |
| Environment | ~85 | ~11% |
| Setup | ~65 | ~8% |
| Transform | ~26 | ~3% |

Per-file budget is **25 s** (hard fail above). Cold, uncached, individual files
have hit **300–550 s** (`gate-inspect` 547 s, `optional-steps` 484 s). Typical
heavy files sit at 15–25 s. Average is ~0.1 s/test, so **a small number of heavy,
gateway-booting files dominate**; the long tail is I/O and process setup, not
assertions.

### The single biggest self-imposed constraint

The unit gate **caps at 3 workers on a 24-core host** — deliberately leaving ~21
cores idle. This is not a mistake: the isolation design (`run-isolation.ts`,
machine-global concurrency ledger) exists specifically so **three whole suites can
run simultaneously** without contending. We are trading ~8× wall-time headroom for
the ability to run 3 copies at once. That trade only makes sense because there is
no result caching and no affected-selection — every run is a cold full run, so the
team parallelizes *runs* instead of *making each run cheap*.

## 2. Fundamental flaws

### F1 — It is an ice-cream cone wearing a pyramid costume

The docs call the 7,594-test tier "unit". It is not. `v2-integration` (203 files)
boots an **in-process gateway per file**: creates dirs, seeds `projects.json` /
`preferences.json` / workflows, loads the server runtime, `createGateway(...)`,
starts an HTTP listener on a real port, registers a default project, seeds
workflows (`tests2/harness/gateway.ts::boot`). Many `v2-core` files do the same or
shell out to git. The classic anti-pattern (industry consensus: Fowler test
pyramid; the "ice-cream cone" is the named failure mode) is *few fast units, many
slow integration/E2E*. That is exactly this suite. The per-test cost is dominated
by **gateway boot + fs + git**, which is why files cost 15–25 s and the floor is
minutes.

*Consequence:* you cannot tune your way to <1 min. The cost is boot fan-out, not
CPU. Vitest's own perf guidance (isolate:false, threads, sharding — all already
applied here) cannot remove a cost that lives in booting servers.

### F2 — Whole-suite-always: no test-impact analysis

Every change runs everything. `test:v2:changed` (`vitest --changed`) exists but is
**not the gate** and only covers files Vitest can reach through its own module
graph — it does not model server→test edges, config→test edges, or pack/skill
fixture edges. There is no source→test dependency map. Industry standard (Nx
`affected`, Bazel, Azure TIA, Symflower) is to run only the tests a diff can reach;
even a naive static import graph yields ~29% average reduction, and graph-accurate
TIA on a well-factored repo routinely runs **1–5%** of tests per PR. Bobbit runs
100% every time.

### F3 — No result caching

Bazel / Nx / Turborepo cache **test results** keyed on a content hash of the
test's inputs (sources + deps + config + env). Unchanged inputs ⇒ the test is not
re-run, its prior PASS is replayed. Bobbit re-executes every test cold on every
run. Combined with F2, this is why 3-way concurrency was built: the team scaled
horizontally because each run is maximally expensive.

### F4 — The app has no module boundaries, so "test a sub-part" is impossible

`src/app/` is ~8,000 lines in 5 files (`render.ts` 2,863, `session-manager.ts`
1,824, `remote-agent.ts` 1,387, `api.ts` 1,365, `state.ts` 557) over a **global
mutable singleton** (`state.ts`). `render.ts` "imports from everything." The server
side routes most behaviour through one `createGateway`. There are no package
boundaries and no dependency graph. **Selective testing is a graph query; there is
no graph to query.** You cannot say "this change only touches gate verification, so
only run gate tests" because gate logic, config cascade, session lifecycle, and
rendering are not separable units — they are reachable only through the gateway or
the render monolith.

### F5 — Per-file fixed cost is re-paid, not amortized

`isolate:false` lets files in one worker share transformed modules, but each
integration file still **re-seeds state and re-boots/registers** its gateway
fixture. The expensive part (boot + project register + workflow seed) is paid
per-file, hundreds of times.

### F6 — Flakiness is masked with `retry: 3`

The gate runs with `retry: 3`; qualification is retry-free but daily developer runs
are not. Retries hide nondeterminism (shared-state leaks — the progress log is a
graveyard of `flow-alpha`/`flow-beta` cross-project bleed, transcript-root
collisions, cached-SHA races). A sub-1-min suite must be *deterministic*, not
*retried*: retries multiply worst-case wall-time and let real races survive.

### F7 — Two-generation debt (`tests/` legacy + `tests2/`)

`tests-map.json` still tracks `legacy-pending: 153` and multiple migration methods
(`adapter`, `codemod`, `port`, `relocate`, `rewrite`). The census (1,138) spans an
in-flight migration. Any rewrite should finish collapsing to one generation, not
add a third.

## 3. Can the whole suite be sub-1-minute? No — and that is the wrong target

Booting real gateways, Docker containers, git worktrees, and MCP subprocesses for
1,138 files cannot complete in 60 s on one machine, at any worker count. The
achievable and *more valuable* targets:

- **Sub-1-min per change** (affected-only + cache): the realistic day-to-day goal.
- **Sub-1-min tier-1 cold** (rebalanced pyramid + full core utilization): plausible
  for a true-unit tier once gateway-boot tests are extracted out of it.
- **Whole suite** stays multi-minute but runs rarely (pre-merge / nightly), sharded
  across cores/machines, and mostly **cache-hits** to near-zero.

Reframe the ask from "make 1,138 files run in 60 s" to "make *the tests a change
needs* run in 60 s, and never run the rest unless their inputs changed."

## 4. The two levers

Wall-time = (tests we run) × (cost per test) ÷ (parallelism). Attack all three.

### Lever A — Run fewer tests (biggest win, needs re-architecture)

1. **Source→test dependency graph.** Build a static import graph
   (`ts-morph`/`madge`) plus explicit manifests for non-code edges (config cascade,
   pack/skill fixtures, workflow YAML). Map a git diff → reachable test files.
2. **Affected-only gate.** Default local/PR command runs affected + a tiny always-on
   smoke set. Full suite only pre-merge / nightly.
3. **Content-hash result cache.** Key = hash(test file + transitive deps + config +
   runner version + env fingerprint). Cache hit ⇒ replay verdict, run nothing.
   Local first (`.profiles/test-cache/`), then shared/remote for CI + dev machines
   (the Turborepo/Nx/Bazel model). This is what actually removes the need for the
   3-way concurrency hack.

### Lever B — Make each test cheaper (rebalance the pyramid)

1. **Extract pure domain logic** out of the gateway/render monoliths so it tests in
   milliseconds with zero boot:
   - gate state machine + workflow DAG dependency resolution,
   - config cascade resolution,
   - proposal/goal-workflow validation,
   - scheduling / autostart decisions,
   - session/draft/queue reducers,
   - transcript sanitization, cost/context math.
   Several of these already have `-decisions.test.ts` seams — expand that pattern
   until the *decision* is a pure function and the gateway test is a thin wiring
   check.
2. **Ports & adapters.** The planned `GatewayClient` interface (Strategy doc,
   Dimension 1) is the UI half; add the symmetric server seam so a "unit" is a
   function over injected ports, not a booted HTTP server. Then a handful of
   contract/wiring smokes replace hundreds of per-file boots.
3. **Shared gateway contract fixture.** Where a real gateway is genuinely needed,
   boot **one** per worker and run many contract assertions against it (already the
   Playwright worker-scoped model — bring it to the Vitest integration tier and stop
   re-seeding per file).

### Lever C — Use the cores

Once caching removes the need to run 3 suites at once, **lift the artificial
3-worker cap** and let the tier-1 (true-unit) run use the whole box. Keep the
isolation contract; drop the concurrency-ledger throttle for the common case.

## 5. Re-architecture for selective testing (the real deliverable)

Selective testing is a property of the **application** architecture, not the test
runner. To make "only test the relevant sub-part" real:

1. **Introduce internal package/module boundaries** with explicit dependency edges.
   Either a workspace tool (Nx/Turborepo give `affected` + caching for free) or, at
   minimum, enforced internal module layers with a generated manifest. Candidate
   domains: `gates`, `workflows`, `config-cascade`, `sessions`, `proposals`,
   `search`, `pr-walkthrough`, `preview`, `ui-shell`, `ui-components`, `mcp`.
2. **Dissolve the global singleton** (`state.ts`) into per-domain owned state with
   explicit inputs/outputs. Global mutable state is why UI has zero unit tests and
   why every UI change needs full-stack E2E.
3. **Thin the gateway** to wiring over domain modules (hexagonal). The gateway test
   surface shrinks to: routing, auth, persistence, wiring — a few dozen tests, not
   hundreds.
4. **Tag tests by domain**; the affected-graph then maps a diff to a domain to its
   test set. `test <domain>` becomes a first-class command.

Payoff: a change to gate verification runs the `gates` unit set (milliseconds) +
one gate wiring smoke — seconds, not minutes. A change to `render.ts` runs
`ui-shell` component tests against a mock `GatewayClient` — no server at all.

## 6. Rewrite? Refactor in place, do not big-bang

A from-scratch rewrite would drop coverage and re-learn every flake RCA already
captured in `fast-gate-progress.md`. Sequence instead:

1. **Graph + cache first** (no product changes): build the dependency graph and
   result cache, ship affected-only as the default local/PR gate. Immediate
   feedback-time win with zero risk to coverage.
2. **Extract domain modules incrementally**, moving gateway-boot integration files
   down to true-unit as each domain gains a pure core. Delete the boot version once
   the wiring smoke + unit set cover it — coverage never regresses.
3. **Finish the `tests/`→`tests2/` collapse** (clear `legacy-pending`), so there is
   one generation.
4. **Retire the 3-worker cap** once caching replaces the concurrency need; lift
   tier-1 to full-core.
5. **Replace `retry: 3` with determinism** as each shared-state owner is fixed.

## 7. Guardrails against regression

- **Pin the pyramid shape**: a test that boots a gateway may not live in the
  true-unit tier (lint/inventory rule, extends the existing spawn guard).
- **Budget the tier**: keep the per-file wall budget; add a *tier-total* cold budget
  so the true-unit tier cannot silently creep back to minutes.
- **Coverage non-regression** before deleting any boot test (the existing
  `metrics:coverage` baselines).
- **Cache correctness**: fingerprint must include env + config + runner version; a
  stale hit is worse than a slow run.

## 8. Recommendation summary

| Ask | Verdict | Path |
|---|---|---|
| Whole suite <1 min | Not achievable on one host, any tuning | Wrong target — reframe to per-change |
| Per-change <1 min | Achievable | Dependency graph + affected-only + result cache (Lever A) |
| Run many at once | Already possible; becomes unnecessary | Result caching removes the need; then use the cores (Lever C) |
| Avoid future regressions | Achievable | Pyramid-shape lint + tier budgets + coverage baselines (§7) |
| Test only relevant sub-parts | Needs app re-architecture | Module boundaries + dissolve global state + hexagonal gateway (§5) |
| Full rewrite | Not recommended | Incremental refactor, graph/cache first (§6) |

The headline: **the flaw is architectural coupling, not test tooling.** The suite
is slow because the app has no seams, so tests must boot the whole world. Add the
graph + cache for an immediate per-change win, then carve domain modules so
"relevant sub-part" testing becomes a graph query.
