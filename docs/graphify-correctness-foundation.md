# Graphify correctness foundation guide

This foundation is the checked-in correctness contract behind Code Intelligence graph integration. It prevents a linked-worktree invocation from publishing a graph built from the wrong checkout or an incomplete corpus. The pack now has an optional status panel and bounded graph-query surfaces, but the foundation is not evidence that installed Graphify executed or that an automatic indexer/service exists.

For activation, status meanings, reviewer guidance, and the explicit `v1 has no cross-repo edges` limitation, see [Code Intelligence](code-intelligence.md). For the ownership boundary and rationale, see the [design contract](design/graphify-correctness-foundation.md). This guide describes the checked-in adapter, fixtures, and evidence developers maintain.

## What the contract pins

The delta adapter accepts an exact resolved Graphify version, an absolute component checkout root, and an absolute candidate directory outside that checkout. It rejects checkout-local candidates, unpinned or hostile paths, symlink escapes, output outside the candidate, and deltas without `noCluster: true` before an executor can run.

The adapter first uses a supported public incremental-delta capability. Without one, it permits only an exact-version, feature-probed compatibility call to `graphify.watch._rebuild_code`; an unavailable or changed private surface fails rather than being guessed. Its result records whether the public or compatibility path ran.

The in-memory harness pins logical metadata and promotion rules:

- Roots are canonical component-relative paths. Fixture roots include `src`, `tests2`, `defaults`, and the explicit `project-addition` root.
- An anchor records the component and Graphify identities as well as sorted roots and their digest. The corpus records tracked files and a digest.
- Validation rejects anchor mismatch, corpus drift, outside-root sources, incomplete or overlapping prune closure, and unaccounted node shrink. A failed candidate cannot replace the accepted fixture state.
- A child derives from its immediate parent-derived base. Advancing a parent makes that snapshot and all descendants stale; stale snapshots are never current.
- Deltas do not cluster. At the supplied measured threshold, derived labels remain `base-derived`; only a changed-node count above it reclusters.

Automatic lifecycle processing and a Graphify installation/service owner remain outside this foundation. Code Intelligence's existing host-side store, declared status route, read-only graph tools, and panel consume the same containment and currentness rules without starting work. A manual rebuild is explicitly unavailable until the platform supplies its lifecycle owner.

## Evidence locations

| Evidence | Location |
|---|---|
| Adapter containment and capability contract | `market-packs/code-intelligence/src/graphify-runner.ts` and its core test |
| In-memory metadata, validation, lineage, and promotion model | `market-packs/code-intelligence/src/graphify-harness.ts` and its core test |
| Add/modify/delete/rename, regressions, and benchmark assertions | `tests2/integration/graphify-harness-integration.test.ts` |
| Corpus and fixed collapse fixtures | `tests2/fixtures/graphify-corpus/` |
| Graphify-shaped compatibility and benchmark fixture | `tests2/fixtures/graphify-contract-fixture/graphify_fixture.py` |
| Checked-in measurement record | `tests2/fixtures/graphify-benchmarks/harness-contract.json` |
| Real linked-worktree and guard-telemetry proof | `tests/e2e/graphify-linked-worktree.spec.ts` |

The Python program is intentionally a contract fixture, not Graphify. The linked-worktree test uses it to prove that the adapter reaches the feature-probed compatibility seam with an external candidate, while its live guard counter remains zero. A deliberately checkout-local candidate takes the fixture guard path and increments that counter, preventing a dead-counter assertion from passing.

## Run the focused evidence

Run the core contracts:

```sh
npx vitest run --config vitest.config.ts --project v2-core \
  tests2/core/graphify-harness.test.ts \
  tests2/core/graphify-runner.test.ts
```

Run the fixture integration:

```sh
npx vitest run --config vitest.config.ts --project v2-integration \
  tests2/integration/graphify-harness-integration.test.ts
```

Run the real linked-worktree proof with the repository E2E wrapper:

```sh
node scripts/run-playwright-e2e.mjs tests/e2e/graphify-linked-worktree.spec.ts
```

The E2E proof requires local `git` and `python3`. It creates and removes a temporary repository, primary checkout, linked checkout, and host-state directory; it does not require installed Graphify.

## Interpret and refresh measurements

The checked-in record separates two facts. This distinction is essential because the current capture does **not** prove Graphify performance:

1. `graphify.available: false` and the `measurement.status: "unavailable"` entry record that `python3 -c 'import graphify'` failed in the environment that captured the file.
2. `contractFixture` and its five rows are real timings from the Python contract fixture. They measure fixture base/clone copies, the injected no-cluster delta, size scan, and TypeScript `export` query scan.

Therefore these rows are reproducible contract-fixture evidence, not Graphify performance or proof that a Graphify package executed. Do not replace the unavailable status with fixture output or describe the row values as Graphify benchmarks.

The companion linked-worktree record measures code-only and code-plus-docs contract-fixture scenarios with base, clone, no-cluster delta, query p50/p95, graph size, and a zero worktree-guard count. See [Code Intelligence](code-intelligence.md#graph-storage-and-graphify-availability) for the recorded values and interpretation.

To emit a fresh fixture measurement for review, run:

```sh
python3 tests2/fixtures/graphify-contract-fixture/graphify_fixture.py benchmark \
  tests2/fixtures/graphify-corpus
```

It writes JSON to standard output and does not modify the checked-in record. When intentionally updating that record, preserve its availability result separately from the contract-fixture output, retain the fixture revision and root digest, and explain the measurement environment. The rows are observations for later tuning, not pass/fail budgets.

## Extending the contract

When changing roots, path validation, adapter compatibility, or fixture behavior:

1. Keep candidates and generated artifacts outside every checkout, including through symlinks and aliases.
2. Preserve explicit add, modify, delete, and both rename sides in delta closure; deleted paths may not exist on disk, but sources in a produced graph must resolve inside their pinned roots.
3. Add or update a fixed regression fixture when a previously accepted corrupted graph is found. Do not turn the approximately 91% anchor collapse or approximately 63% corpus drift into a permissive percentage threshold.
4. Keep Graphify unavailability honest. A future real adapter run should add distinct evidence; it must not relabel the contract fixture as installed Graphify.
5. Run the focused suites above, including the linked-worktree proof when changing runner containment or guard behavior.

The runtime that eventually consumes this contract must validate before publication and retain the last known-good graph on failure.
