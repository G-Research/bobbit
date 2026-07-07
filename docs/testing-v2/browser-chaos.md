# Browser-dimension adversarial evidence (switchover prereq D8)

The node-tier chaos proof (`scripts/testing-v2/chaos.mjs`, `docs/testing-v2/chaos-report.md`)
never touches browser/Playwright code — every one of its mutants targets logic,
store, scheduler, or reducer paths. Aggregate parity (`scripts/testing-v2/parity.mjs`)
only compares per-**area** line/branch coverage, which masks localized drops.

This adds the two missing pieces of evidence for the **184 → ~35 browser-e2e
journey consolidation**:

1. **Per-file coverage delta** — surfaces localized coverage drops the area
   aggregate hides (`scripts/testing-v2/coverage-delta.mjs`).
2. **Browser-dimension mutation comparison** — proves the consolidated journeys
   catch what the retired 184-spec suite caught, mutant by mutant
   (`scripts/testing-v2/browser-chaos.mjs`).

Both are **heavy** and gate the switchover only. Neither is part of `test:v2`.

---

## 1. Per-file coverage delta — `coverage-delta.mjs`

`parity.mjs` asserts `src/app` / `src/ui` / `src/server` **aggregate** coverage
does not regress. A journey consolidation can drop one UI file from 90% → 30%
while the aggregate barely moves. This script reports every file whose line or
branch coverage dropped, sorted by drop size.

```bash
# Baseline mode (default) — consumes an EXISTING coverage-summary.json.
npm run test:v2:coverage-delta

# Produce coverage first (HEAVY ~90s+), then diff vs the committed per-file baseline:
node scripts/testing-v2/coverage-delta.mjs --run

# First run writes tests2/v2-baseline-coverage-per-file.json (commit it to lock thresholds).
# Refresh the baseline deliberately after a legitimate change:
node scripts/testing-v2/coverage-delta.mjs --update-baseline

# A/B mode — compare two coverage-summary.json files directly
# (e.g. legacy-suite coverage vs v2, to answer "did consolidation drop any file?"):
node scripts/testing-v2/coverage-delta.mjs --baseline legacy-summary.json --current v2-summary.json

# CI-style gate: exit 1 if any file dropped.
node scripts/testing-v2/coverage-delta.mjs --fail-on-drop
```

Outputs:
- `.profiles/testing-v2/coverage-delta.json` — machine-readable per-file deltas.
- `.profiles/testing-v2/coverage-delta.md` and a committed mirror at
  `docs/testing-v2/coverage-delta.md`.

Honesty: a git-history check refuses a silently **bar-lowered** committed
baseline (raising the bar is allowed). A file present in the baseline but absent
from current coverage is reported as a **full loss** — a strong signal that the
consolidation dropped its only exercising test.

To answer the consolidation question directly, capture legacy-suite V8 coverage
into one `coverage-summary.json`, capture v2 coverage into another, and run A/B
mode; any file in the "removed" or "drops" list is a localized regression to
close before switchover.

---

## 2. Browser-dimension mutation comparison — `browser-chaos.mjs`

For each mutant in **browser-only** code (`src/ui/**`, `src/app/**` UI paths),
the harness runs BOTH:

- the targeted **legacy** browser spec (`tests/e2e/ui/*.spec.ts`, `playwright-e2e.config.ts`), and
- the replacement **v2 journey** (`tests2/browser/journeys/*.journey.spec.ts`, `playwright-v2.config.ts`),

and records caught / missed with test-name attribution.

**Corpus:** `tests2/chaos/browser-mutants.json` (17 entries: 1 null-integrity
mutant + 16 content mutants across plan-tab, goal/role proposals, panel tabs,
notification/unseen dot, dashboard mutation card, goal-status widget, delegate
renderer, sidebar search, session actions, draft persistence, and add-project).
Each entry pins its `expectedLegacyCatchers` (the retired spec that covered it)
and `expectedV2Catchers` (the replacement journey), so the comparison is a true
mutant-by-mutant substitution proof, not an aggregate.

```bash
# Full campaign (HEAVY — see cost note). Gates the switchover only.
npm run test:v2:browser-chaos -- --all

# Targeted dev runs:
node scripts/testing-v2/browser-chaos.mjs --ids BR01,BR02
node scripts/testing-v2/browser-chaos.mjs --dry-run       # list, don't run
node scripts/testing-v2/browser-chaos.mjs --regen-report  # rebuild MD from JSON

# Resume an interrupted campaign (e.g. after a server restart): reuse the
# conclusive results already streamed to the JSON report, run only the rest.
node scripts/testing-v2/browser-chaos.mjs --all --resume
```

Note on the toolchain: browser tests build against `dist`, so the runner needs a
COMPLETE `node_modules` (playwright + typescript + vite + `@earendil-works/pi-ai`
+ its provider SDKs, sentinel `@anthropic-ai/sdk`). It auto-selects the fullest
same-goal worktree's `node_modules` via a read-only junction; the primary repo /
goal-branch installs are often partially pruned on Windows and are skipped. Build
tools are invoked by their JS entry points (not `npm`/`.bin`) to avoid the
Windows junction `.bin` PATH flake.

Outputs:
- `.profiles/chaos/browser-comparison-report.json` — full per-mutant matrix (streamed after each mutant).
- `.profiles/chaos/browser-comparison-report.md` and a committed mirror at
  `docs/testing-v2/browser-chaos-report.md`.

### Acceptance

- **Every legacy-caught mutant is also journey-caught.** A
  legacy-caught-but-journey-**missed** mutant is a REAL hole in the consolidated
  journey — **fix it by strengthening the journey's assertions** (never delete or
  weaken the mutant), then re-run that mutant.
- **V2 kill ≥ legacy overall and per area.**
- **Null-mutant integrity:** a no-op patch must NOT be "caught" by either suite
  (guards against a broken harness reporting false kills). This is the only hard
  exit-1 condition.
- Mutants missed by BOTH suites are coverage gaps needing a new test or a tracked
  justification.

### Honest result coding

| Result | Meaning |
|--------|---------|
| `caught` | The Playwright JSON report names a FAILING test in the targeted spec. |
| `missed` | The targeted spec ran and reported no failures (bug not detected). |
| `invalid` | The mutation did not compile / its required `dist` target failed to build. |
| `error` | The run crashed before tests ran (global-setup / gateway / report absent), or a bare non-zero exit named no failing test. |

A bare non-zero exit with no attributed failing test is an **error**, never a kill.

### How it works (and why it is heavy)

Browser tests run against **built `dist`** (`dist/server` + `dist/ui`), not `src`.
So each mutant must rebuild the affected dist target before its Playwright runs:

1. One ephemeral `git worktree add --detach` is created for the whole campaign,
   with the primary repo's `node_modules` linked in as a junction.
2. An initial full `npm run build` produces a clean `dist`.
3. Per mutant: apply the search/replace → rebuild only the affected target(s)
   (`build:ui` for `src/ui`/`src/app`, `build:server` for `src/server`) → run the
   legacy spec → run the v2 journey → `git checkout -- <file>` → clean-tree
   assertion. A previously-mutated target is rebuilt from clean source before the
   next mutant, so `dist` never carries a stale mutation.

Cost: a UI mutant ≈ one `vite build` + two Playwright specs (gateway boot + a few
tests each). Budget minutes-per-mutant; run the full campaign only when the
machine is free.

### Junction-safe teardown (mandatory — do NOT regress)

The worktree's `node_modules` is a Windows **junction** into the shared tree.
`unlinkNodeModulesJunction` unlinks the reparse point **non-recursively BEFORE**
any recursive delete, so neither `git worktree remove --force` nor `fs.rmSync`
can descend THROUGH the junction and wipe the shared `node_modules`. A fail-loud
guard refuses to delete a worktree whose junction target resolves INSIDE the
removal path. This mirrors the `chaos.mjs` fix — see
[`node-modules-corruption-rca.md`](node-modules-corruption-rca.md). Do not
reintroduce delete-through-junction.

### Extending the corpus

Add entries to `tests2/chaos/browser-mutants.json`:

```json
{
  "id": "BR17",
  "area": "<feature>",
  "file": "src/app/<file>.ts",
  "target": "ui",
  "operator": "inverted-boolean | off-by-one | dropped-render | ...",
  "search": "<unique exact source substring>",
  "replace": "<mutated substring>",
  "description": "What breaks and which journey assertion must fail.",
  "expectedLegacyCatchers": ["tests/e2e/ui/<spec>.spec.ts"],
  "expectedV2Catchers": ["tests2/browser/journeys/<journey>.journey.spec.ts"]
}
```

`search` must occur **exactly once** in `file` (verify with a grep). Prefer
mutations that break a DOM attribute, rendered text, or a behavioural gate the
journey already asserts on — otherwise the mutant lands in the both-missed bucket.
