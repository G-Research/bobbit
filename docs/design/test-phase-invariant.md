# Design: Test Suite Phase Invariant

## Problem & big-picture context

Bobbit runs tests through **workflow gates**, not a hand-typed `npm test`. The
`implementation` gate of every workflow runs four command steps against the goal
branch: `build`, `check`, `unit`, `e2e` (commands defined per-component in
`.bobbit/config/project.yaml`). Whatever those `unit:` / `e2e:` commands execute
*is* the test suite as far as the project is concerned — anything they don't run
is invisible to every goal.

Today a large fraction of tests are **orphaned** — executed by no gate:

- The entire fast node-logic suite (`tests/*.test.ts`, 341 files / ~3.4k tests)
  runs in **zero** gates. The `unit:` command is
  `npx playwright test --config tests/playwright.config.ts` which only runs the
  browser `*.spec.ts` fixtures. `npm run test:unit` *also* chains the node
  runner, but the gate never invokes npm — hence the naming collision that cost
  a recent goal-lead ~6 minutes.
- `tests/fullstack/session-lifecycle.spec.ts` — ignored by the unit config, not
  under `tests/e2e`, so no gate.
- `tests/e2e/mcp-integration.spec.ts` and `tests/e2e/ui/session-lifecycle-ui.spec.ts`
  — present in the e2e config but dropped by the gate's
  `--grep-invert 'mcp-integration|session-lifecycle-ui'`.
- `tests/compaction.spec.ts` — real-LLM, misfiled in `tests/` root.

This let pre-existing failures slip onto `master`.

## Goal: one invariant

**Every test except `tests/manual-integration/**` runs in exactly one of the
`unit` or `e2e` workflow phases.** Taxonomy:

- **unit** — fast (<1min target), no real LLM → `unit` gate. Two runners: node
  `tests/*.test.ts` + browser `tests/playwright.config.ts` `*.spec.ts` fixtures.
- **e2e** — all remaining non-LLM integration (<5min target) → `e2e` gate.
- **manual-integration** — real LLM / Docker → exempt from gates.

A guard test pins the invariant permanently.

## Baseline findings (already verified on this branch)

The branch is cut from a recent `master` (incl. `a372e343 Fix two pre-existing
unit-test failures from #714`). Measured on this worktree:

| Suite | Command | Result | Wall time |
|---|---|---|---|
| node logic | `npx tsx --test 'tests/*.test.ts'` | 3377 pass / 0 fail / 14 skip | ~58s |
| browser fixtures | `playwright test --config tests/playwright.config.ts` | 1338 pass / 2 skip | ~77s |

**The 5 pre-existing failures named in the goal spec are already green** —
`nested-goal-routes-findings.test.ts` (19 pass) and `agents-md-budget.test.ts`
both pass. The 14 node skips are all legitimate environment guards
(symlink-not-permitted on Windows, pi-ai model availability), not hidden
failures. So sequencing step 1 ("fix failing node tests first") is satisfied;
remaining risk is failures **newly surfaced** by wiring orphaned suites into the
gates (mcp-integration, session-lifecycle-ui, fullstack) — verified during
implementation.

### Windows command-length constraint (load-bearing)

`tests/*.test.ts` expands to 341 paths. Under Git Bash the glob pre-expands and
blows Windows' ~32k command-line limit ("The command line is too long"). Under
`npm run test:unit`, npm spawns the script via cmd.exe (its `script-shell`),
which passes `tests/*.test.ts` **literally** to the node test runner, which globs
internally. **Therefore the `unit:` gate command must be `npm run test:unit`, not
an inlined glob.** The verification harness runs gate commands via Git Bash, but
`npm run …` is short and npm re-shells the inner script safely.

## Required changes

### 1. `unit:` gate runs both fast runners

`.bobbit/config/project.yaml`:

```yaml
unit: npm run test:unit
```

(was `npx playwright test --config tests/playwright.config.ts --reporter=line`.)
`npm run test:unit` already chains node + browser fixtures.

**Performance.** Combined wall time ≈ 58s + 77s ≈ **135s** sequential — over the
<1min target. Mitigations, applied and measured by the coder:

- The node runner is the cheaper win. Run it with explicit concurrency
  (`--test-concurrency=<cpus>` / confirm node spawns file-level parallel
  workers) to cut the ~58s. The browser fixtures already run at 50% workers.
- Document the final measured wall time in `docs/testing-strategy.md`. The <1min
  target is aspirational; the hard requirements are (a) both runners execute in
  the gate, (b) genuine parallelism is applied, (c) the number is documented.
  Browser fixtures alone are ~77s, so a sub-60s combined wall time is unlikely
  on this hardware — document honestly rather than hiding tests to hit a number.

### 2. `e2e:` gate covers all non-LLM integration

`.bobbit/config/project.yaml`:

```yaml
e2e: npx playwright test --config playwright-e2e.config.ts --reporter=line
```

Drop `--grep-invert 'mcp-integration|session-lifecycle-ui'`. Both already sit in
the e2e config's `browser` project `testMatch` and use `gateway-harness.js` (mock
MCP / mock agent — no real LLM); the grep-invert only filtered them out by title.

**Fold `tests/fullstack/**`.** `tests/fullstack/session-lifecycle.spec.ts` is a
near-duplicate of `tests/e2e/ui/session-lifecycle-ui.spec.ts` — both are "real UI
in a real browser, mock agent backend". The difference is only the harness:
fullstack uses the config-level `webServer` in `playwright-fullstack.config.ts`;
session-lifecycle-ui uses `gateway-harness.js` with `E2E_SERVE_UI`. The e2e
config uses the globalSetup + per-worker harness model, **not** a config-level
`webServer`, so fullstack cannot be added as-is.

Coder evaluates and picks the cleaner of:
- **(a) If genuinely redundant** with session-lifecycle-ui: delete
  `tests/fullstack/`, `playwright-fullstack.config.ts`, and the `test:fullstack`
  script. Un-inverting session-lifecycle-ui already covers the journey.
- **(b) If it has unique coverage**: port it to `gateway-harness.js`
  (`E2E_SERVE_UI`) under `tests/e2e/ui/`, then delete the fullstack config +
  `tests/fullstack/` dir + `fullstack-setup`/`fullstack-teardown`.

Either way the fullstack config is deleted and the spec's coverage lands in the
e2e gate. The guard test will confirm no orphan remains.

### 3. Relocate the real-LLM test

Move `tests/compaction.spec.ts` → `tests/manual-integration/compaction.spec.ts`.
Remove its `compaction.spec.ts` entry from `tests/playwright.config.ts`
`testIgnore`. It currently boots an isolated gateway+vite via the config-level
`webServer` of `tests/playwright-e2e.config.ts` (port 3097). The manual config
(`playwright-manual.config.ts`) has no config-level `webServer` and its specs
self-manage their servers. Coder converts compaction's server bootstrap from
Playwright `webServer` to in-spec `test.beforeAll`/`afterAll` (the
manual-integration convention) so it runs under `npm run test:manual`, then
deletes `tests/playwright-e2e.config.ts` and the now-dead `test:e2e:real` script
(or repoints it at the manual config). manual-integration is gate-exempt, so the
hard requirement is only that the file lives there and is not orphaned-but-claimed.

### 4. Collapse redundant Playwright configs

Target end state: **3 gate-relevant configs** — `tests/playwright.config.ts`
(unit fixtures), `playwright-e2e.config.ts` (canonical e2e),
`playwright-manual.config.ts` (manual). Delete the rest, re-expressing any still-
wanted selection as flags/scripts on a canonical config:

| Delete | Was | Re-express as |
|---|---|---|
| `playwright-e2e-smoke.config.ts` | `grep:/@smoke/` + api/browser projects | `test:e2e:smoke` → `… --config playwright-e2e.config.ts --grep @smoke` |
| `playwright-e2e-standard.config.ts` | slow-test-excluded gate subset | dead — the e2e gate now runs the full config; drop the `test:e2e:standard` script (or keep as a `--grep-invert` of slow patterns if a fast lane is still wanted) |
| `playwright-e2e-coverage.config.ts` | own mock-agent webServer + `NODE_V8_COVERAGE` | `test:coverage` → `NODE_V8_COVERAGE=… npx playwright test --config playwright-e2e.config.ts --project api` then `c8 report`. The `api` project runs the gateway **in-process**, so V8 coverage on the worker captures server coverage directly. |
| `tests/playwright-real.config.ts` | manual, hits already-running dev server | redundant with manual lane — delete + drop refs |
| `tests/playwright-workflow.config.ts` | manual, hits running dev server (`workflow-status`, `delegate-ui`, `delegate-reconnect`) | manual helper — delete + drop refs. Confirm these 3 specs are covered elsewhere or fold into manual. |
| `tests/playwright-e2e.config.ts` | real-LLM compaction webServer | deleted via change #3 |

Update `package.json` scripts that reference deleted configs (`test:e2e:real`,
`test:e2e:smoke`, `test:e2e:standard`, `test:fullstack`, `test:coverage`,
`test`). `scripts/run-playwright-e2e.mjs` references only the canonical config —
no change. No `.github/workflows` exist (Bobbit gates its own CI), so no CI
edits.

### 5. Guard test — pin the invariant

New fast node test `tests/test-phase-invariant.test.ts` (a `.test.ts` so it runs
in the unit node runner). It enumerates every `tests/**/*.{test,spec}.ts` and
asserts:

1. **Exactly-one-phase coverage.** Each file is matched by exactly one of:
   - unit node runner: `tests/*.test.ts` (top-level only),
   - unit browser fixtures: `tests/playwright.config.ts` `testMatch`/`testIgnore`
     (top-level `tests/*.spec.ts` minus `e2e/`, `fullstack/`, `manual-integration/`,
     `lsp/`),
   - e2e config: `playwright-e2e.config.ts` projects' `testDir`/`testMatch`/
     `testIgnore` (incl. the docker-only specs that the e2e config ignores but
     `playwright-manual.config.ts`'s `docker-e2e` project runs — those count as
     covered by manual),
   - `tests/manual-integration/**` (exempt bucket).
   A file matched by **zero** phases (orphan) **or two** phases (double-claimed)
   fails the test, naming the file and the offending phases.
2. **No `tests/lsp/**`** node:test specs are claimed by Playwright (they're node
   runner specs the unit Playwright config deliberately ignores). Treat `lsp/` as
   node-runner unit coverage or assert it's explicitly ignored — pin whichever
   matches the runtime so it can't silently drift.
3. **Runner-convention purity.** No `*.test.ts` imports `@playwright/test`
   (would mean a node file wrongly written as a Playwright spec), and no
   `*.spec.ts` imports `node:test` (the node runner convention). This keeps the
   two-runner split from drifting.

Implementation approach: derive the glob/ignore lists by **reading the configs**
where feasible (or a single shared constant the configs and the guard both
import) so the guard tracks config edits rather than hard-coding a snapshot. At
minimum, centralize the phase-membership predicate so future config changes have
one obvious place to update, and the guard's failure message tells the next agent
exactly which bucket to add a new test to.

The guard must itself be matched by the unit node runner (it is a top-level
`tests/*.test.ts`) — i.e. it covers itself.

## Sequencing

1. Node failures already green (verified) — no fix needed; re-confirm during impl.
2. Rewire `unit:`/`e2e:` gate commands; relocate compaction; collapse configs;
   update scripts.
3. Run the **full e2e config** (un-inverted + folded fullstack) in the e2e
   harness and confirm green before finalizing. A baseline run of the
   un-inverted config is in flight; any pre-existing e2e failures it surfaces are
   in-scope to fix (product or test, whichever is wrong) — never re-orphan.
4. Add + run the guard test; confirm it passes for the final layout and fails on
   a synthetic orphan.
5. Measure + document unit and e2e wall times.

## Acceptance criteria

- No test outside `tests/manual-integration/` is unexecuted by `unit` or `e2e`.
- `npm run check` clean.
- Full `unit` and `e2e` gate phases pass on the goal branch — zero failing, zero
  hidden/skipped-to-hide-failure, zero orphan.
- Guard test fails on any introduced orphan or double-claim.
- `unit` parallelism applied + wall time documented; `e2e` under ~5min.
- `docs/testing-strategy.md` + `docs/testing-coverage.md` describe the 3 buckets
  and the guard; AGENTS.md test guidance reconciled.
- No product behavior change — test-infra only.

## Files touched

- `.bobbit/config/project.yaml` — `unit:` and `e2e:` commands.
- `package.json` — scripts referencing deleted configs; possibly `test:unit`
  (node concurrency flags).
- `tests/playwright.config.ts` — remove `compaction.spec.ts` from `testIgnore`.
- `playwright-e2e.config.ts` — possibly a folded fullstack project / no change if
  fullstack migrates to gateway-harness specs.
- `playwright-manual.config.ts` — host the relocated compaction (self-managed
  server) if not in-spec.
- **Move**: `tests/compaction.spec.ts` → `tests/manual-integration/`.
- **Migrate/delete**: `tests/fullstack/session-lifecycle.spec.ts` (+ setup/teardown).
- **Delete**: `playwright-e2e-smoke.config.ts`, `playwright-e2e-standard.config.ts`,
  `playwright-e2e-coverage.config.ts`, `playwright-fullstack.config.ts`,
  `tests/playwright-real.config.ts`, `tests/playwright-workflow.config.ts`,
  `tests/playwright-e2e.config.ts`.
- **New**: `tests/test-phase-invariant.test.ts` (guard).
- `docs/testing-strategy.md`, `docs/testing-coverage.md`, `docs/compaction.md`,
  `docs/coverage.md`, `AGENTS.md` — doc reconciliation.

## E2E test plan (for this test-infra goal)

This goal is test-infrastructure: its "feature" is the gate wiring + guard.
There is no new product UI/API, so no new browser E2E journey is added. The
*verification of this goal* is itself running the suites:

- **Unit phase** (`npm run test:unit`) — node + browser fixtures both green,
  including the new guard test.
- **E2E phase** (`npx playwright test --config playwright-e2e.config.ts`) — full
  un-inverted suite + folded fullstack coverage, green, under ~5min.
- **Guard negative test** — temporarily add a throwaway orphan spec and confirm
  the guard fails; remove it. (Done manually by the coder during impl; the
  committed guard covers the steady state.)
- **manual-integration** — `tests/manual-integration/compaction.spec.ts` is
  collectible by `playwright-manual.config.ts` (not run in gates; smoke-checked
  by the coder that it at least loads).
