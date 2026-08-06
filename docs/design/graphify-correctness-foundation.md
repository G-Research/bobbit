# Graphify correctness foundation

**Status:** implementation contract for Phase 0.
**Authority:** [`code-intelligence-extension.md`](code-intelligence-extension.md) at canonical commit `85189bfdc`. This document defines the executable correctness gate consumed by Graph Extension Runtime; it does not redefine that runtime.

## 1. Purpose and ownership

Graphify's normal output is checkout-relative, while Bobbit commonly indexes linked worktrees and nested goal branches. A wrong invocation directory or corpus can therefore produce a valid-looking but severely incomplete graph. Phase 0 makes those failures detectable *before* a later runtime can publish a graph.

The deliverable is deliberately small:

- a version/capability-gated `GraphifyDeltaAdapter` contract;
- canonical anchor, corpus, validation, and nested-lineage metadata exercised by an isolated harness and fixtures;
- fixture-only candidate → clone → delta → validate → promote semantics, including measured benchmark rows; and
- real linked-worktree proof that the intended runner path leaves checkouts untouched and does not call Graphify's linked-worktree guard.

It is **not** a production index. Graph Extension Runtime exclusively owns `lib/graph-store`, production graph metadata/configuration, external-store publication and GC, bounded manual rebuild, graph tools, routes, status panel, and runtime process wiring. Code Intel Integration exclusively owns lifecycle hooks, queues/service composition, automatic refresh, worktree cleanup, and final status/import composition. This slice registers no hook, provider, tool, route, panel, setting, prompt, grant, queue, server endpoint, Docker mount, or extension-platform substitute.

| Concern | Phase 0 owner | Later owner |
|---|---|---|
| Delta capability/compatibility contract | Graph Correctness Foundation | Graph Extension Runtime invokes it |
| Anchor, corpus, validation, chain, and threshold fixtures | Graph Correctness Foundation | Graph Extension Runtime applies the contracts to persisted graphs |
| Candidate/clone/validate/promote proof | Graph Correctness Foundation, isolated fixture harness only | Graph Extension Runtime's `lib/graph-store` publishes real graph state |
| Hooks, queue, tools, routes, panel, and cleanup | None | Graph Extension Runtime or Code Intel Integration, as above |

This split prevents a test harness from quietly becoming a second graph store or scheduler with different currentness rules.

## 2. Alternatives compared

All options are judged against the same requirements: external candidate containment, pinned roots/anchor/corpus, correct add/modify/delete/rename deltas, chained parent/child staleness, and a linked-worktree proof.

| Option | Data flow | Advantages | Failure mode / test seam | Decision |
|---|---|---|---|---|
| Checkout-local `graphify-out/` through Graphify CLI update | Each worktree writes its own CWD-relative output. | Small initial implementation. | Dirties a checkout, duplicates indexes, and reaches Graphify's linked-worktree mutation guard. | Rejected. |
| Shared primary output mutated by branch updates | A linked worktree points at a primary graph. | One graph directory. | A branch can contaminate main; Graphify rejects the shared-worktree path; no immutable base exists for validation. | Rejected. |
| Private Bobbit graph manager | New server store, queue, routes, and worktree adapters own all updates. | Can hide Graphify details. | Duplicates existing component/lifecycle ownership and creates a second source of branch state. | Rejected. |
| **Isolated correctness harness plus adapter contract** | Fixtures build candidates outside a checkout, validate canonical metadata, and model promotion/currentness. Runtime later consumes the tested contract. | Pins the corruption blockers without claiming production lifecycle or storage. | Focused core/integration and linked-worktree fixtures; handoff is the adapter and metadata contract. | **Selected.** |

The selected option uses Graphify/library capabilities rather than custom parsing, graph merging, clustering, or traversal. It intentionally leaves production storage to the sibling that owns its lifecycle and publication policy.

## 3. Contract boundary and files

The pack remains dormant in this slice: its manifest contains no contributions. The following are the exact Phase-0 files and APIs.

| File | Phase-0 responsibility | Explicit non-responsibility |
|---|---|---|
| `market-packs/code-intelligence/src/graphify-runner.ts` | Defines and tests `GraphifyDeltaAdapter`, request/result normalization, public-capability preference, and pinned compatibility fallback. | It does not resolve/install Graphify, start a worker, write a graph, or schedule work. |
| `market-packs/code-intelligence/lib/graphify-runner.mjs` | Built pack asset corresponding to the adapter contract. | It does not implement a graph runtime. |
| `market-packs/code-intelligence/src/graphify-harness.ts` | Pure, in-memory anchor/corpus/candidate validation and nested-chain model for fixture use. | It has no filesystem, process, hook, tool, or runtime registration authority. |
| `tests2/core/graphify-harness.test.ts` and `tests2/core/graphify-runner.test.ts` | Deterministic contract and compatibility tests. | No production-storage coverage. |
| `tests2/integration/graphify-harness-integration.test.ts` and `tests2/fixtures/graphify-corpus/` | Fixture delta, regression, lineage, and checked-in benchmark evidence. | No route/browser/lifecycle behavior. |
| `tests/e2e/graphify-linked-worktree.spec.ts` and `tests2/fixtures/graphify-contract-fixture/` | Real linked-worktree containment and live guard-telemetry proof through a Graphify-shaped contract fixture. | It does not execute installed Graphify or add runtime behavior. |

Graph Extension Runtime may consume these interfaces but must keep its real graph directory and `GraphMeta` in `lib/graph-store`. It must not use `GraphifyChainHarness` as runtime state.

### 3.1 Delta adapter API

```ts
interface GraphifyDeltaRequest {
  cwd: string;             // absolute component root
  candidateRoot: string;   // absolute directory outside that checkout
  scanRoots: string[];     // non-empty component-relative paths
  changedPaths: string[];  // component-relative paths under a pinned root
  noCluster: boolean;      // must be true
}

type CompatibilityIdentity = {
  kind: "public" | "compatibility";
  id: string;
  resolvedVersion: string;
  modulePath?: string;
  signature?: string[];
};

interface GraphRunResult {
  graphPath: string;
  nodes: number;
  edges: number;
  sourcePaths: string[];
  compatibility: CompatibilityIdentity;
}

class GraphifyDeltaAdapter {
  constructor(version: string, execution: GraphifyDeltaExecution,
              compatibility: readonly CompatibilitySpec[]);
  invokeDelta(request: GraphifyDeltaRequest): Promise<GraphRunResult>;
}
```

The caller supplies an **exact resolved** Graphify version, never a range. The adapter validates absolute `cwd` and external `candidateRoot`, component-relative roots/changes, physical containment through symlinks or aliases, and `noCluster: true`; it sorts and deduplicates returned source paths. A runtime records the returned compatibility identity with its own metadata so operators can see whether it used a public capability or temporary compatibility path.

### 3.2 Feature-probed compatibility fallback

Graphify currently has no guaranteed public delta CLI. The adapter therefore follows this order:

1. Feature-probe a supported public incremental-delta capability (U1). If present, use it and never inspect a private module.
2. Otherwise, allow only a compatibility entry for the exact resolved version.
3. Probe the expected module path, callable, and required parameter names before invocation.
4. Invoke the compatibility path only after that probe succeeds; otherwise throw `GraphifyCapabilityError(version, "incremental-delta", detail)`.

The sole permitted temporary compatibility identity is `graphify.watch._rebuild_code`. Its `CompatibilitySpec` names the exact version, `modulePath: "graphify.watch"`, `callable: "_rebuild_code"`, and the required observed signature. No loose version, guessed signature, silent private import, or fallback after a failed probe is valid. The contract test is the compatibility gate; Graph Extension Runtime chooses the actual process boundary and records the identity it receives.

## 4. Correctness metadata and data flow

Phase 0 models metadata, not a durable production schema. Its canonical logical values are portable across linked worktrees:

```ts
interface HarnessAnchor {
  version: 1;
  cwdMode: "component-root-relative";
  componentId: string;
  graphifyVersion: string;
  rootsDigest: string;
  scanRoots: string[]; // canonical, sorted, deduplicated
}

interface HarnessCorpusFile {
  path: string;       // component-relative POSIX path
  sha256: string;
  tracked: true;
}
interface HarnessCorpus { files: HarnessCorpusFile[]; digest: string }

interface HarnessSnapshot {
  id: string;
  kind: "base" | "derived-base" | "branch";
  head: string;
  parentId?: string;
  graph: { sourcePaths: string[]; nodes: number; edges: number };
  state: "fresh" | "stale";
  staleReason?: "parent-advanced";
}
```

`createHarnessAnchor()` normalizes roots to component-relative POSIX paths, sorts and deduplicates them, and digests the result with the component and Graphify identities. `createHarnessCorpus()` normalizes and sorts tracked file records, then digests canonical JSON. Absolute paths, `..`, empty segments, and outside-root source paths are invalid. Because an anchor contains no checkout-specific absolute path, the same component in two linked worktrees has the same logical invocation identity.

The fixture flow is:

```text
pinned roots + expected anchor/corpus
  → isolated external candidate
  → clone immutable fixture base
  → no-cluster add/modify/delete/rename delta
  → observe anchor/corpus/source inventory
  → validate
  → fixture-only promote marker, or retain prior candidate/current fixture state
```

All fixture candidates, manifests, temporary output, cache, and benchmark reports live under a temporary host-state root, never beneath the primary or linked checkout. This proves containment without creating a production graph-store format. The future runtime must retain this transaction ordering: build outside the checkout, validate before publishing, and preserve the last known-good graph after a failure.

### 4.1 Pinned corpus and delta closure

The effective roots start with `src`, `tests2`, and `defaults`, plus explicit project additions. The fixture corpus is tracked-only and has a complete list/digest, not merely node counts. A delta classifies add, modify, delete, and both old/new sides of a rename. A changed source must appear in the resulting source inventory or be named as pruned; this prevents a changed-to-empty file or a renamed-away source from leaving stale symbols.

Deltas never cluster. A normal base is clustered; a derived base reclusters only when its measured changed-node count exceeds the persisted, benchmark-calibrated threshold. At or below the threshold it retains inherited labels marked `base-derived`. The harness pins the rule and metadata handoff; Graph Extension Runtime owns persistence and actual clustering.

### 4.2 Mandatory validation and failure handling

`validateHarnessCandidate()` is a pure pre-promotion gate. It returns one or more of:

| Failure | Reject condition | Required outcome |
|---|---|---|
| `ANCHOR_MISMATCH` | Expected and observed canonical anchors differ. | Do not promote. |
| `CORPUS_DRIFT` | Complete corpus digests differ. | Do not promote. |
| `OUTSIDE_PINNED_ROOT` | A graph source is outside a pinned root. | Do not promote. |
| `DELTA_CLOSURE_FAILURE` | A changed path is neither present nor explicitly pruned. | Do not promote. |
| `UNEXPLAINED_SHRINK` | Node reduction exceeds the recorded, explicit prune allowance. | Do not promote. |

A validator failure is never repaired by widening roots, changing CWD, relaxing a threshold, or silently rebuilding from main. The fixture preserves the prior accepted candidate; the production runtime later maps the same result to its own `validation-failed`/last-good state.

The known traps are fixed regression fixtures, not percentage heuristics: one retains the approximately 91% anchor-collapse shape and must yield `ANCHOR_MISMATCH` plus shrink evidence; the other retains the approximately 63% corpus-drift shape and must yield `CORPUS_DRIFT`, even if the graph itself is internally consistent. Fixture counters make future Graphify rebaselining explicit.

## 5. Nested-goal chain contract

A depth-two goal must follow this lineage:

```text
primary main@A
  └─ parent-derived P@B = clone(main@A) + delta(A...B)
       └─ child C@D = clone(P@B) + delta(B...D)
```

`GraphifyChainHarness` models only this bounded topology. A root branch derives from the primary base; a child derives from its immediate parent-derived snapshot, never directly from main. A missing or stale direct base is an error, not permission to fall back to main.

When a parent advances, its prior derived snapshot and every descendant become `stale` with `parent-advanced`. `current()` returns no stale snapshot. A replacement parent can be derived from its direct base, but each child remains stale until recreated from that replacement parent. This gives Graph Extension Runtime an unambiguous staleness contract without adding a runtime ancestry walker, queue, or store here.

## 6. Linked-worktree and guard proof

The real-worktree fixture creates a temporary repository and an actual `git worktree add` checkout. It exercises the runner/harness contract from the linked checkout while candidates remain in a separate temporary host-state directory.

Required assertions:

1. Neither checkout receives `graphify-out/`, `.graphify_root`, cache, report, manifest, staging directory, or another graph artifact.
2. Every candidate and adapter report path is contained by the temporary host-state root.
3. The invocation uses `GraphifyDeltaAdapter` and the Graphify-shaped contract fixture rather than a `graphify` CLI; the fixture's live linked-worktree guard counter remains zero. A deliberately checkout-local candidate must instead trigger that guard and increment its counter.
4. A source symlink that escapes the linked checkout is rejected before it can be accepted as a graph source.

The guard counter matters: merely avoiding a thrown error would not prove the unsafe guard path was never entered. Parent/child staleness is covered by the in-memory harness and its integration fixture, not by this linked-worktree test.

## 7. Tests and measurements

| Layer | Required evidence |
|---|---|
| Core adapter | Exact-version requirement; public capability wins; fallback module/callable/signature is feature-probed; incompatible or unpinned versions fail before invocation; absolute/component-relative/no-cluster request checks. |
| Core harness | Root/corpus canonicalization; containment rejection; immutable candidate/previous-state preservation; add/modify/delete/rename closure; threshold boundary; direct-parent lineage and stale selection. |
| Integration fixture | Candidate/clone/delta/validate/promote sequence; both fixed collapse regressions reject before promotion; source inventory removes deleted and rename-old paths; chained stale behavior. |
| Linked-worktree integration | Actual linked checkout, external-only artifacts, a live zero-guard assertion, a deliberately triggered guard, and physical source-containment rejection. |
| Measurement | Checked-in JSON rows for contract-fixture base, clone, no-cluster delta, size, and query operations with elapsed time; fixture revision, root digest, graph counts, and the recorded Graphify-availability result remain distinct. |

The checked-in measurement records that importing installed Graphify was unavailable in its capture environment. Its contract-fixture rows are observed fixture output, not Graphify performance or performance pass/fail budgets. They establish reproducible evidence for later runtime tuning. Graph Extension Runtime adds production status/manual-rebuild coverage; Code Intel Integration adds lifecycle, queue, cleanup, and browser coverage.

## 8. User-spec traceability

| User requirement | Phase-0 proof | Follow-on owner |
|---|---|---|
| Host-only, worktree-safe indexing | External fixture candidates and no-checkout-artifact assertions. | Graph Extension Runtime production store. |
| Pinned `src`, `tests2`, `defaults`, additions, anchor, and corpus | Canonical anchor/corpus and validation failures. | Graph Extension Runtime configuration/metadata. |
| Add/modify/delete/rename correctness | Delta-closure and source-inventory tests. | Graph Extension Runtime worker/store integration. |
| Base clone, validation before publication, preserve last good result | Fixture transaction contract and reject-before-promote tests. | Graph Extension Runtime publication. |
| Nested base → parent → child and parent staleness | `GraphifyChainHarness` direct-parent/stale tests. | Graph Extension Runtime refresh. |
| No clustering on deltas; calibrated derived threshold | Adapter `noCluster` invariant and threshold fixture metadata. | Graph Extension Runtime clustering. |
| Never use Graphify linked-worktree guard | Real linked-worktree profiler/counter assertion. | Graph Extension Runtime runner invocation. |
| 91% anchor and 63% corpus regressions | Fixed fixtures with typed rejection. | Graph Extension Runtime must retain them. |
| Base/clone/delta/size/query benchmarks | Fixture JSON measurements. | Runtime records production measurements. |

## 9. Explicit exclusions and handoff

Do not expand this slice into `lib/graph-store`, a runtime `GraphMeta` schema, Graphify installation/version resolution, automatic work, manual rebuild UI, graph query/status tools, routes, panel, user settings, lifecycle registration, service queues, LSP, Docker behavior, cross-repository fan-out, docs tiers, or browser flows. Those features have different state and lifecycle owners.

The handoff is intentionally narrow: Graph Extension Runtime consumes the adapter's exact-version feature-probed result and applies the harness's anchor/corpus/validation/lineage semantics when it owns real graph publication. It must retain the regression and linked-worktree proof before exposing any graph as current.
