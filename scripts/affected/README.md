# Affected + cached test runner (MVP)

Runs only the Vitest tests a change can reach, and skips tests whose dependency
closure is unchanged since their last PASS. Banks the ~5× common-case win from
[`docs/testing-v2/suite-speed-analysis.md`](../../docs/testing-v2/suite-speed-analysis.md)
with zero product change.

## Usage

```bash
npm run test:affected                 # diff vs the remote's primary branch (origin/HEAD), run affected+uncached
node scripts/affected/run.mjs --dry   # print the plan, run nothing
node scripts/affected/run.mjs --base main
node scripts/affected/run.mjs --changed src/ui/components/GitStatusWidget.ts   # simulate
node scripts/affected/run.mjs --all --no-cache   # baseline: everything, cold
```

Flags: `--base <ref>`, `--changed a,b`, `--dry`, `--no-cache`, `--all`.

The result cache lives under `.profiles/test-cache/` (git-ignored). It is keyed by
a runner fingerprint (`vitest` version + `vitest.config.ts` hash) so a runner or
config bump transparently invalidates everything.

## What it does

1. `graph.mjs` builds, per test file, its transitive repo-local source closure via
   a static import scan.
2. `cache.mjs` fingerprints each test = sha over the content of its closure; a hit
   replays the prior PASS.
3. `run.mjs` maps `git diff` → affected tests, drops cache hits, runs the rest
   through Vitest, and records verdicts on success.

Validated end-to-end: cold run of 5 leaf tests 3.7 s → warm re-run 0.4 s (nothing
to run); touching one dependency re-selects exactly that one test.

## The floor this tool exposes (and the decoupling roadmap)

Two dynamic boundaries the static graph cannot see are modelled as **coarse
buckets** (see `graph.mjs`):

- **Server-boot bucket (~192 tests).** Any test that boots the in-process gateway
  depends on the whole `src/server/**` tree, because the harness loads the server
  through an esbuild prebundle. Any server change selects all of them.
- **DOM/UI bucket (~144 tests).** Any happy-dom test loads the web entry bundle, so
  any `src/app/**` or `src/ui/**` change selects all of them.

Consequently most real changes hit a **~14% floor** (~160 tests) that neither
affected-selection nor caching can go below — this is coupling, not tooling. To
break it, production code must be decoupled so **fewer tests boot the whole world**:

1. Extract pure domain logic (gate state machine, workflow DAG, config cascade,
   validation, reducers) into modules tested directly, without a gateway boot.
2. Migrate boot-based integration tests down to those pure unit tests; each
   migration removes one test from the boot bucket.
3. Split the server prebundle per domain so a boot test can be attributed to the
   domain(s) it actually exercises (or add coverage-based dynamic attribution).

## Known MVP limitations

- The server-boot bucket is prefix-based (`src/server/**`). A file **outside**
  `src/server` that the server imports (shared utils) would be under-selected for
  boot tests — make the bucket the real server-entry closure before relying on this
  in CI. Over-selection within `src/server` is safe.
- Non-code edges (config cascade YAML, pack/skill fixtures, workflow templates) are
  not yet modelled; changes to `tests2/harness/**`, `vitest.config.ts`, tsconfig,
  or this tool conservatively **run everything**.
- Browser (`*.spec.ts`) affected files are reported but run via the Playwright tier,
  not here.
