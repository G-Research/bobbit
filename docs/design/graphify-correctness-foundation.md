# Graphify correctness foundation

**Status:** implementation contract for Phase 0.
**Scope:** an extension-owned, host-only Graphify graph store plus its runner, validation, fixtures, and benchmarks. This is deliberately a correctness substrate, not the later tool, status, settings, scheduling, version-resolution, or prompt-contribution work.

## 1. Decision

Build a small `market-packs/graphify` library around Graphify's extraction, merge, clustering, export, and query primitives. Its durable data is outside every checkout, keyed by `(projectId, componentId)`. A graph is never published in place: a base clone or branch delta is built in a sibling candidate directory, validated against pinned logical scan metadata and a freshly measured corpus manifest, then atomically promoted.

The logical lineage matches Bobbit's nested-goal merge topology:

```text
component primary base ── clone + parent delta ── parent-derived base
                                                └─ clone + child delta ── child graph
```

A parent head advance invalidates its derived base and marks all descendant graphs stale. A stale graph is retained for diagnosis but is never reported as current. Deltas do not cluster. A normal base clusters; a derived base reclusters only when its measured changed-node count exceeds the threshold recorded in its metadata. Otherwise it retains inherited labels marked `base-derived`.

This is the smallest useful slice: it establishes the reusable on-disk model and proves the two corruption traps before later work exposes it through the existing hook/tool/status surfaces.

## 2. Existing primitives and constraints

| Existing code / behavior | Use in this slice | Protecting evidence |
|---|---|---|
| `ProjectContext.stateDir` is project-local; `bobbitStateDir()` is the host headquarters state root | Do **not** put graph files in a worktree, a component checkout, or project-local `.bobbit`. Derive the graph root from host headquarters state. | `src/server/agent/project-context.ts`; `src/server/bobbit-dir.ts` |
| `PackStore` is host-side and pack-namespaced, but is JSON key/value storage with quotas | Reuse its identity/containment model, not its payload storage. Large graph artifacts require a directory store, atomic publication, and files rather than values. | `src/server/extension-host/pack-store.ts` |
| Project components describe repo root and optional subpath; `componentRoot()` is shared path arithmetic | Resolve each component's invocation root using this model. A component is the index boundary; v1 does not create cross-repository edges. | `src/server/skills/worktree-paths.ts`; `src/server/agent/project-config-store.ts` |
| Goal children branch from their parent branch, while root goals start at configured `base_ref` | Build parent-derived bases and child deltas in this order; never compare every child directly with main. | `src/server/agent/goal-manager.ts::_resolveChildBaseBranch`, `_provisionGoalWorktree`; `docs/design/base-ref.md` |
| `goalProvisioned` is delivered to every materialised worktree, host-side, with resolved ancestry metadata | Phase 0 consumes none of it directly. Phase 1 can enqueue a cheap clone through this established hook instead of inventing a lifecycle hook. | `src/server/agent/lifecycle-hub.ts::dispatchGoalProvisioned`; `tests2/core/sandbox-wiring-goal-provisioned.test.ts` |
| Graphify `extract`, `build_from_json`, `build_merge`, `cluster`, `score_all`, `to_json`, and query facilities | Use these maintained primitives; do not write an AST parser, graph merge algorithm, community detector, or graph traversal. `build_merge` replaces changed-file contributions and prunes deleted sources. | installed Graphify `extract.py`, `build.py::build_merge`, `cluster.py`, `export.py` |
| Graphify `__main__._refuse_shared_worktree_mutation` deliberately rejects publishing to a shared primary output from a linked worktree | Never invoke Graphify's CLI publishing/update path. A dedicated Python worker imports the library modules directly and always receives an absolute candidate output directory outside the checkout. | installed Graphify `__main__.py:98-130,3535,3794` |

Graphify's ordinary `graphify-out` default is CWD-relative. Its `GRAPHIFY_OUT` override can be absolute, but its output directory is read at Python import time. The worker must therefore receive `GRAPHIFY_OUT=<candidate absolute directory>` before importing Graphify, and must be launched with a logical component-root argument rather than relying on its CWD.

## 3. Alternatives compared

All options below meet the same acceptance criteria: a per-component graph usable from a linked worktree, no checkout output, correct add/modify/delete/rename handling, chained nested-goal bases, and rejection before corrupt publication.

| Option | Data/control flow | Advantages | Failure modes / test seam | Decision |
|---|---|---|---|---|
| **A. Checkout-local `graphify-out/` and Graphify CLI updates** | Run `graphify update` in each worktree; let Graphify manage the graph beside sources. | Minimal initial code; uses the CLI. | Duplicates an index per worktree, dirties/creates checkout output, and invokes the linked-worktree shared-output guard path. A linked-worktree E2E fails immediately. It cannot model one current base with branch clones. | Rejected. It violates two explicit requirements. |
| **B. One primary-checkout shared graph, branch deltas published into it** | Point worktrees at the primary graph via symlink or shared `GRAPHIFY_OUT`; mutate it for every branch. | Reuses Graphify update behavior and one disk copy. | Graphify deliberately refuses this from linked worktrees. If bypassed, a branch graph can overwrite main. There is no immutable base to validate or clone, so parent/child freshness cannot be represented. | Rejected. It makes currentness ambiguous and relies on the guard we must avoid. |
| **C. Host-only content-addressed base/clone store with Graphify library worker** | Build a base in a host candidate directory; clone it, apply one branch delta with `build_merge`, validate, then promote. | Correct isolation, reusable base copies, explicit lineage/staleness, direct use of Graphify primitives, and no CLI guard path. | Adds a small store/metadata/validator boundary. Unit tests isolate it; real linked-worktree E2E proves paths and guard counter. | **Selected.** Smallest robust model that satisfies all acceptance criteria. |

### Why not reuse `PackStore` as the graph store?

`PackStore` proves server-derived pack namespaces and safe key encoding, but its one-file-per-JSON-value API, quotas, and value semantics are wrong for graph JSON, manifests, reports, and atomic directory replacement. Wrapping a multi-megabyte graph in that API would create an artificial state owner and quota conflict. `GraphIndexStore` copies only the proven containment rule: server-derived identity becomes a path segment after stable hashing; callers cannot supply paths.

### Why not use Graphify's private watcher as the index implementation?

`graphify.watch._rebuild_code` is useful evidence that Graphify handles changed and deleted source contributions, but it is a private CWD/output-oriented convenience routine and scans one broad root. Phase 0 needs a pinned *set* of roots and a candidate-only publication transaction. The worker instead composes public Graphify extraction/build/merge/cluster/export primitives. `build_merge` is the maintained replacement/prune primitive; the pack only supplies source lists and `prune_sources`, rather than reimplementing graph mutation.

## 4. Ownership, paths, and metadata

### 4.1 Host-only store

`GraphIndexStore` receives only server-owned inputs:

```ts
createGraphIndexStore({
  hostStateDir: bobbitStateDir(),
  projectId,
  componentId,
});
```

It derives, never accepts, this root:

```text
<host-state>/graphify-index/v1/<sha256(projectId)>/<sha256(componentId)>/
  snapshots/<snapshotId>/       # immutable, validated payload
    graph.json
    meta.json
    corpus.json
    labels.json                 # optional Graphify labels
  current/
    base.json                    # { snapshotId }
    derived/<goalId>.json        # { snapshotId }
    branches/<goalId>.json       # { snapshotId }
  staging/<operation-id>/        # candidate only; removed on success/failure
  benchmarks/<run-id>.json
```

The human-readable IDs live inside `meta.json`; only a fixed-format SHA-256 digest is used as a directory name. `resolve` + `relative` containment checks run before every read, clone, publish, and deletion. The candidate root must be a sibling of `snapshots/` so a same-filesystem rename is possible. Publication is `write candidate metadata → fsync/close where supported → rename candidate to snapshots/<snapshotId> → atomically replace the small logical current pointer`; readers only follow a validated pointer. A failed worker or validator removes the candidate and leaves the previous pointer untouched. GC may delete only a snapshot unreachable from every current pointer and lineage reference; it never mutates a published snapshot.

This is host-only output even when the component's sources are a host worktree. It never writes `graphify-out`, `.graphify_root`, cache, report, or a temporary artifact below a checkout. Phase 0 makes no graph mount available to Docker; later query routes cross that boundary by existing host RPC.

### 4.2 Logical scan contract

The default configured roots are `src`, `tests2`, and `defaults`; project additions are a validated relative-path list. Roots are resolved beneath the selected component root, canonicalised to sorted POSIX relative paths, deduplicated, and recorded once on the base. Missing roots are recorded as missing, not silently dropped, so a later delta cannot change the effective corpus by creating or removing a configured directory.

```ts
interface ScanContract {
  version: 1;
  componentId: string;
  componentRootKind: "component-root";
  roots: Array<{ path: string; present: boolean }>;
  exclusions: string[];              // Graphify defaults plus pack-owned exclusions
  graphifyOptions: { directed: boolean; docs: "excluded" };
}

interface InvocationAnchor {
  version: 1;
  componentId: string;
  componentRootKind: "component-root";
  rootsDigest: string;               // sha256(canonical ScanContract)
  sourcePathStyle: "component-relative-posix";
  graphifyVersion: string;
}
```

`InvocationAnchor` intentionally has no absolute worktree path: equivalent component roots in different linked worktrees must compare equal. It does pin the root set, component boundary, relative path normalization, Graphify version, and options that determine source identity. The worker receives the actual component root separately, always converts `source_file` to component-relative POSIX form, and returns the anchor it used. It must reject a source that resolves outside the component root (including an escaping symlink).

`corpus.json` is a sorted list of `{ path, contentSha256, tier: "code" }` for exactly the files under the pinned roots that Graphify can extract. A second `allIncludedPaths` list records files Graphify detected but did not structurally extract, so corpus drift is not hidden by a node-count coincidence. The corpus digest is the hash of these canonical lists. Documentation tiering and docs-in-query are later work; Phase 0 intentionally records `docs:"excluded"` rather than creating a second corpus policy.

### 4.3 Snapshot metadata

Every snapshot has one `meta.json`:

```ts
interface SnapshotMeta {
  schemaVersion: 1;
  kind: "base" | "derived-base" | "branch";
  projectId: string;
  componentId: string;
  head: string;                     // exact Git commit used for source read
  parent?: { snapshotId: string; head: string };
  anchor: InvocationAnchor;
  corpusDigest: string;
  sourceFiles: number;
  nodeCount: number;
  edgeCount: number;
  clustering: "full" | "none" | "base-derived";
  labelsSource?: "self" | "base";
  changedNodeCount: number;
  /** Inherited by clones. The base records the benchmark-calibrated value. */
  reclusterThresholdNodes: number;
  thresholdSource: { benchmarkId: string; fixtureRevision: string; sampleCount: number };
  freshness: "current" | "stale" | "invalid";
  staleReason?: "parent-head-advanced" | "base-replaced";
  createdAt: string;
}
```

A snapshot is current only when its own validation succeeded and all ancestors named in `parent` remain current at the recorded head. This is a read rule, not a best-effort status: APIs added later must return an explicit stale/invalid result, not the graph as current.

## 5. Build and validation flow

### 5.1 Base build

1. Resolve component root using Bobbit component coordinates and create a `ScanContract` from defaults plus additions.
2. Enumerate the exact root set and construct the canonical corpus manifest before extraction.
3. Launch the pack-owned Python worker with absolute `GRAPHIFY_OUT=<staging>/graphify-out`, absolute component root, the root list, and the contract JSON. The process does not use `python -m graphify`, `graphify update`, hooks, or a symlink.
4. The worker uses Graphify `extract` on the selected files with `cache_root=componentRoot`, then `build_from_json(..., root=componentRoot)`, `cluster`, `score_all`, and `to_json`. It emits graph counters, canonical source identities, and its observed anchor/corpus payload. It does not invent graph algorithms.
5. Validate the worker result (§5.4). On success, write metadata/corpus and atomically publish as `base`; on failure discard staging.

### 5.2 Clone and branch delta

A branch operation first chooses its direct base:

- a root goal clones the current component base;
- a nested goal clones the current derived base of its direct parent;
- there is no fallback from a missing/stale parent-derived base to main.

The store hard-links immutable files where supported and copies otherwise. The clone is immediately given a new snapshot ID and copied metadata; it is never a mutable alias of its base.

The runner computes Git changes from `baseMeta.head` to target `head`, intersects them with the **pinned** root contract, and classifies added, modified, deleted, and rename old/new paths. It asks Graphify to structurally extract added/modified files and calls `build_merge(newChunks, candidateGraph, prune_sources=deletedOrRenameOldPaths, root=componentRoot)`. Thus a rename is an explicit delete plus add even when Git's rename score changes. A modified file that now yields no extractable Graphify contribution is also passed in `prune_sources`; otherwise `build_merge` would have no replacement `source_file` with which to evict its old symbols. The worker reports that set separately from normal deletes and returns changed-node count from the before/after source contribution sets. The worker exports the graph with no clustering.

The runner does not accept a partial Git diff as proof of corpus identity. It rescans all pinned roots after the delta and validates the result before publication. This is what catches a wrong invocation root whose extracted set is internally consistent but represents the wrong tree.

### 5.3 Derived-base refresh and staleness

When a parent goal head changes:

1. mark its existing derived base stale with `parent-head-advanced`;
2. mark every transitive descendant snapshot stale by pointer/metadata update; do not delete it;
3. rebuild the parent's derived base by cloning its direct base and applying the parent delta at the new head;
4. compare the measured `changedNodeCount` to the inherited `reclusterThresholdNodes`. The base gets this value from a recorded calibration benchmark (fixture revision, sample count, and benchmark ID); clones never silently choose a new threshold;
5. cluster only if `changedNodeCount > reclusterThresholdNodes`; otherwise preserve the direct base's labels and write `clustering:"base-derived", labelsSource:"base"`;
6. validate and publish the new parent-derived base. Child graphs remain stale until individually rebuilt from it.

This deliberately bounds computation by active parent bases and prevents serving a child graph that was derived from an old parent graph. Nesting is already capped by Bobbit; Phase 0 supports the resulting three-link maximum without a generic graph-DAG engine.

### 5.4 Mandatory post-delta validation

Validation runs for base, derived-base, and branch publication after Graphify finishes and before the current pointer changes. Any failure writes an invalid candidate diagnostic and preserves the preceding snapshot.

| Check | Required comparison | Rejects |
|---|---|---|
| Anchor equality | expected cloned `InvocationAnchor` equals worker-observed anchor byte-for-byte after canonical JSON | invocation against a different directory, root set, component, Graphify options/version, or source identity policy |
| Root inventory | expected configured roots (including missing/present state) equals a fresh component-root resolution | dropped `tests2`/`defaults`, accidental broad root, or newly silently omitted configured root |
| Corpus equality | fresh complete corpus manifest equals worker-observed manifest and agrees with the graph's component-relative source-file inventory | corpus drift, outside-root files, and unchanged node counts hiding missed files |
| Delta closure | every changed source is replaced, every delete/rename-old source is absent, every rename-new source is present; all edge endpoints exist | ghost nodes/edges and incomplete add/modify/delete/rename application |
| Graph health | Graphify `validate_extraction`/diagnostic output has no malformed or dangling endpoints; node/edge counts are non-zero when the expected corpus has extractable code | corrupt graph serialization and silent endpoint loss |
| Shrink explanation | any node reduction is attributable to explicit deleted/modified source contributions recorded by the delta | unexplained mass loss, including the observed roughly 91% anchor-collapse trap |

The validator reports a structured reason such as `ANCHOR_MISMATCH`, `ROOT_INVENTORY_MISMATCH`, `CORPUS_DRIFT`, `DELTA_CLOSURE_FAILURE`, or `GRAPH_HEALTH_FAILURE`, plus expected/observed digests and bounded path samples. It never auto-rebuilds with a wider root or relaxes the contract; that would convert a correctness failure into publication.

The known regressions are fixed test fixtures, not percentage heuristics: the anchor fixture must reproduce a loss near 91% and fail `ANCHOR_MISMATCH`/shrink validation; the corpus fixture must reproduce a loss near 63% and fail `CORPUS_DRIFT`. The exact observed fixture counters are asserted to prevent weakening the fixtures while allowing Graphify version updates to be explicitly rebaselined.

## 6. Defect-surface inventory

| Added surface | Owner and bounded contract | Why needed |
|---|---|---|
| `GraphIndexStore` | Pack-local host filesystem owner. Derives all paths from `(hostStateDir, projectId, componentId)` and owns atomic pointer publication/GC only. | Existing `PackStore` cannot safely store graph directories. |
| `ScanContract` / `InvocationAnchor` / `SnapshotMeta` | Versioned JSON owned by the pack. No gateway API and no user setting in Phase 0. | Makes root identity and lineage testable, portable across worktrees, and rejectable. |
| `GraphifyWorkerRunner` | One process boundary. Input is absolute component root, selected roots, external candidate directory, and expected anchor; output is structured counters/manifests. | `GRAPHIFY_OUT` is import-time/CWD-sensitive; one boundary pins it and makes guard avoidance observable. |
| `GraphDeltaCoordinator` | Pack-local orchestration for clone, Git delta classification, validation, parent refresh, and stale propagation. No lifecycle registration yet. | Coordinates state transitions that Graphify itself cannot know from Bobbit goal topology. |
| `GraphValidator` | Pure metadata/corpus/graph validation with typed reject codes. | Mandatory rejection must be independently testable, not buried in worker success handling. |
| Fixtures and benchmark harness | Tests-only source trees, real Git worktree fixture, regression snapshots, JSON benchmark rows. | Proves actual worktree behavior and records required measurements. |

No new extension kind, hook, settings model, grant, decision flow, prompt section, core server endpoint, background scheduler, package dependency, or private copy of extension-platform machinery is added. Phase 1 may call this pack library from existing `goalProvisioned`, tool, route, and configured scheduling surfaces after those surfaces are selected by their owning goals.

## 7. Expected files

| File | Change |
|---|---|
| `market-packs/graphify/pack.yaml` | New dormant pack manifest. It owns the library but contributes no Phase-0 hook/tool/panel/setting surface. |
| `market-packs/graphify/src/index-store.ts` | Host-only keyed path derivation, containment checks, immutable clone, candidate/pointer publication, and stale markers. |
| `market-packs/graphify/src/scan-contract.ts` | Root canonicalisation, component-relative paths, anchor/corpus serialization, and digest helpers. |
| `market-packs/graphify/src/graphify-runner.ts` | Launches the direct-library Python worker with absolute external output and structured request/result protocol. |
| `market-packs/graphify/src/graphify-worker.py` | Imports Graphify library primitives, performs selected-root extraction/base/delta work, emits JSON; never imports or invokes the Graphify CLI entrypoint. |
| `market-packs/graphify/src/graph-index.ts` | Base/derived/branch state machine, Git change classification, Graphify `build_merge` invocation, recluster threshold policy, and stale propagation. |
| `market-packs/graphify/src/graph-validator.ts` | Pure mandatory validation and reject diagnostics. |
| `market-packs/graphify/src/benchmark.ts` | Emits measured JSON rows for base, clone, delta, size, and query operations. |
| `tests2/core/graphify-*.test.ts` | Pure contracts: paths, canonical metadata, clone immutability, root pinning, lineage/staleness, threshold behavior, and validator reject cases. Registered in `tests2/tests-map.json`. |
| `tests2/integration/graphify-*.test.ts` | Worker/store integration: Graphify base and delta operations over add/modify/delete/rename fixtures; benchmark JSON schema and values. Registered in `tests2/tests-map.json`. |
| `tests/e2e/graphify-linked-worktree.spec.ts` | Real temporary Git repository and linked worktree proof: external-only output, direct worker guard counter remains zero, and nested parent/child stale behavior. |
| `tests2/fixtures/graphify-corpus/` | Small stable fixture project containing `src`, `tests2`, `defaults`, project addition, and the anchor/corpus regression fixtures. |
| `scripts/build-market-packs.mjs` | Add the Graphify pack's Node entrypoints only if the pack needs bundling; the Python worker remains a pack asset and is not copied into a checkout. |

The exact test filenames may be consolidated only within these directories; they must retain the listed coverage and `tests2/tests-map.json` registration.

## 8. Test plan and acceptance criteria

### Core and integration

1. A base records the sorted default roots plus additions; reordering additions, changing CWD, or using an equivalent linked-worktree absolute path produces the same logical anchor.
2. A root absent at base creation remains a pinned missing root. Creating it later causes root inventory/corpus validation behavior, not silent widening.
3. The store rejects crafted project/component IDs, snapshot IDs, and stale pointers that would escape the host graph root.
4. Base clone files are never mutable aliases. A rejected delta leaves the former `current.json` target and graph bytes unchanged.
5. Add, modify, delete, and Git rename each produce the expected component-relative graph source inventory. Delete and rename remove nodes and edges from the old path; modification removes symbols no longer present, including a file changed to comments or another form with no extractable contribution.
6. A root-goal delta starts from main base. A child delta starts from its direct parent-derived base. Advancing the parent marks its derived base and its child graph stale; stale snapshots cannot be selected as current.
7. The calibrated threshold is persisted on the base and inherited verbatim. Derived bases below **and equal to** it emit `base-derived` labels; one above it runs Graphify clustering and emits `full` labels.
8. The 91% anchor-collapse fixture fails before publication with an anchor/shrink diagnostic. The 63% corpus-drift fixture fails before publication with `CORPUS_DRIFT`; neither test only asserts a percentage.
9. Corrupt worker JSON, a Graphify non-zero exit, missing graph output, malformed metadata, dangling endpoints, and an interrupted publish each preserve the previous valid graph/current pointer and leave no selectable candidate.

### Real linked-worktree E2E

1. Create a temporary Git repository with the fixture corpus and an actual `git worktree add` linked checkout. Run a base and branch delta from the linked checkout through the pack runner.
2. Assert every graph/cache/report/manifest/staging path is under the temporary host-state directory and no `graphify-out`, `.graphify_root`, or graph artifact exists under either checkout.
3. The worker installs a test-only Python profiler around Graphify calls and returns `graphifyCliGuardCalls`. Assert it is zero; assert the worker command is the pack Python worker, not `graphify` or `python -m graphify`. This proves the linked-worktree guard path was not merely bypassed after executing.
4. Build parent and child worktrees, advance the parent commit, refresh the derived base, and assert the child snapshot is explicitly stale rather than current. Rebuild the child and assert currentness returns only after validation.

The E2E is the Phase-0 user journey: Bobbit creates a linked worktree, the extension-owned index builds a branch graph without modifying the checkout, a parent changes, and the agent-facing currentness state is honest. There is intentionally no browser UI in this slice; browser enablement/status/query is owned by the later runtime/integration goals.

### Benchmark output

The integration fixture writes one JSON row per measurement with machine details, Graphify version, fixture revision, roots digest, node/edge counts, bytes, and `elapsedMs`. It reports median and sample count for:

- base build with the pinned code corpus;
- immutable base clone;
- add/modify/delete/rename delta with no clustering;
- graph store size;
- Graphify query latency against the graph.

The report records the derived-base threshold and whether the sample reclustered or used base-derived labels. It is measured output, not an asserted performance budget; correctness tests do not become timing-flaky. Later docs-tier work will add the required with/without-docs comparison.

## 9. Out of scope

- Graphify install/version resolution, explicit pins, drift warnings, and capability minimums.
- Existing-hook activation, automatic refresh scheduling, after-turn deltas, concurrency queues, user settings, capability grants, decisions, or prompt contributions.
- Agent tools, routes, panels, browser status, query UX, docs-tier querying, multi-component fan-out, or cross-repository edges.
- Docker graph mounts or any private RPC protocol.
- A new extension contribution kind or changes to Extension Host contracts.

Those follow-on goals may consume only the stable pack-local store/index contracts above and existing extension-platform seams.
