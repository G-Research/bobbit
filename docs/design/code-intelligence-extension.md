# Code Intelligence Extension — Integration Design

**Status:** implementation contract for the Code Intelligence goal.  
**Authority:** the decision rounds 2–3 in `graphify-extension.md` are binding. This document applies them to the current Bobbit contracts; it does not reopen them.

## 1. Outcome and scope ledger

Bobbit gains an optional, per-project `code-intelligence` market pack. It provides three independently truthful capabilities:

| Capability | v1 outcome | Explicitly not claimed |
|---|---|---|
| Structural search | `ast_grep` pattern search over the selected worktree/component | type-aware references, rename, or an edit tool |
| Relationship graph | code/docs-tier graph queries: affected callers, explanation, neighbours, paths, and status | proof of a call site; cross-file edges remain heuristic where Graphify marks them inferred |
| LSP | definitions, references, diagnostics and symbols only where the server *and its runtime* are available | a server for every detected language, or a server that starts in a Docker sandbox without its toolchain |

**In scope**

- Pack-owned language detection and a data-driven AST/LSP capability matrix.
- An import-time, per-project offer that describes each detected language as either structural search only, or structural search plus the named LSP features.
- One graph store per component repo; code/docs tiers in a single corpus; component-labelled query fan-out.
- Host-only Graphify graph storage and RPC queries; worktree-native branch deltas and nested-goal base chaining.
- `ast_grep` running in the agent sandbox when the project uses Docker; LSP image layers through the existing sandbox-image build flow.
- Declared index status data, a status/rebuild surface, and measurements.

**Out of scope**

- `ast_edit`, automatic edits/renames, custom parsers, a merged cross-repo graph, cross-repo edges, an embeddings index, or a new `kind: index` contribution.
- Mounting graph files into containers, copying `graphify-out/` into a checkout, enabling Graphify's linked-worktree git hook, or silently falling back to an unavailable LSP.
- Private import, settings, decision-request, prompt, grant, or service-lifecycle APIs. Those integration surfaces wait for their implemented Extension platform contracts; they are not privately recreated. The current sandbox boundary and lifecycle hooks are already usable on `main`.

## 2. Existing contracts to compose

| Need | Existing contract and exact seam | Required composition |
|---|---|---|
| Pack resolution/activation | `src/server/agent/pack-types.ts::PackManifest`, `pack-contributions.ts`, project `pack_activation` in `project-config-store.ts` | Ship a schema-2 market pack and let PackResolver determine visibility. No parallel extension registry. |
| Executable lifecycle work | `ProviderContribution.kind` includes `generic`; `LifecycleHub.dispatchGoalProvisioned()` in `src/server/agent/lifecycle-hub.ts` invokes enabled provider hooks, non-fatally | The graph worker is a `generic` provider using the documented lifecycle hook list. Do not use `kind: memory`; do not add `kind: index`. |
| Worktree event | `GoalProvisionedCtx { goalId, projectId?, worktreePath, cwd, branch?, metadata }`; dispatched after cold creation and pool claims by `goal-manager.ts` and `session-setup.ts` | Enqueue, never build synchronously. Handler is cheap/idempotent as the hub requires. |
| Ordinary session scope | `HookCtx.scopeContext` in `lifecycle-hub.ts`, built by `hook-scope-context.ts` | Use component coordinates when present; fail closed to a component-labelled base-only result when absent/ambiguous. |
| Pack persistence/routes/panels | `host.store` and pack-owned `host.callRoute`, pack `routes` plus `panels/*.yaml`, described in `docs/design/pack-schema-v1-rationalisation.md` | Persist pack configuration/status in the pack namespace; route UI only through the pack's allowlisted routes. No raw gateway fetch. |
| Multi-repo | `Component { name, repo, relativePath? }`, `ProjectConfigStore.getComponents()`, `createWorktreeSet()` | Resolve a component root using the existing component coordinates. Build/query each repo independently; label fan-out output. |
| Host worktrees | `goal-manager.ts` and `session-setup.ts` pass an actual worktree root and the agent cwd offset | Index the component repo root, not the branch-container cwd and never the primary checkout by accident. |
| Docker worktrees | `ProjectSandbox.createWorktreeSet()` creates `/workspace-wt/<branch>/<repo>`; `docker-args.ts` already mounts `/workspace`, `/workspace-wt`, `/tools:ro`, `/tools-builtin:ro` | Graph work stays host-side and is queried by RPC. `ast-grep` is added to the image/runtime as an in-sandbox binary. LSP toolchains are image layers. |
| Image building | `buildSandboxImage()` in `src/server/agent/sandbox-status.ts`, API wiring in `src/server/server.ts` | Use the existing project image build path and declared image requirements; no graph-specific container/mount manager. |
| Import flow | Add Project creates a `project` assistant session in `src/app/dialogs.ts::createProjectAssistantSession`; its prompt is `src/server/agent/project-assistant.ts` | There is no present language-detection/offer contract. The future offer must consume EP-7 settings UI, EP-11 typed decisions and EP-13 static prompts; do not patch this assistant or UI with a graph-specific side channel. |

The executable provider is the current public hook implementation surface: #1081/#1099 are already on `main`. `contents.hooks` is metadata-only in `pack-contributions.ts`; it must not be treated as an executable replacement for providers until that platform contract changes. The current sandbox boundary is also usable now. The optional scope-vocabulary commits are `2809299f8`, `0852b44c0` (tests), and `0bcaca6b8` (docs); the optional observability commits are `142278f8a`, `22b6146e5`, `50f481e52`, and `15162a639` (docs). They may be adopted only by their verified SHAs, never reimplemented.

### 2.1 Same-scope composition decision

Both alternatives below meet the same requested scope: optional per-project AST/graph/LSP intelligence; real linked-worktree operation; component-labelled multi-repo results; external graph state; Docker-aware runtimes; truthful capability/status UI; and import integration only when the Extension platform provides it. The difference is ownership, not capability.

```text
A. selected — compose public contracts
agent → existing tools → pack extension → pack routes/store
worktree lifecycle → existing generic provider hook → EP-8 service (when implemented)
Docker agent → existing sandbox boundary; graph query stays host RPC
import/settings/prompt → verified EP public contribution contracts only

B. rejected — private core subsystem
agent → new server code-intelligence manager → bespoke REST/WS/routes/store/queue
worktree/session/import/sandbox paths → graph-specific adapters at each call site
Docker agent → graph-specific mounts and image mutation; private prompt/settings UI
```

| Dimension | A — minimal existing-contract composition | B — private core subsystem/adapters | Selection rationale |
|---|---|---|---|
| Data flow | Existing `GoalProvisionedCtx`/`HookCtx.scopeContext` selects a component; pack tools call pack-owned graph/LSP adapters; declared `IndexStatus` returns through allowlisted pack routes. EP-8 owns long-running jobs when it exists. | A new manager must duplicate project/component/worktree lookup, persist job and LSP records, expose its own REST/WS status wire, then translate data for tools/UI/import. | A retains one source for component and lifecycle identity. |
| Control flow | Pack activation filters provider/tools; existing `LifecycleHub` preserves non-fatal dispatch; existing sandbox starts the agent; future EP contracts own service/import decisions. | `server.ts`, `session-setup.ts`, `goal-manager.ts`, `project-sandbox.ts`, and import UI gain code-intelligence branches and lifetime ordering. | A adds no new scheduler, dispatch event, mount authority, or prompt path. |
| Files | Pack-owned `market-packs/code-intelligence/**`, narrow public-adapter calls, and only serialized additive core wiring where an existing contract requires it. | New `src/server/code-intelligence/**`, REST handlers in `server.ts`, client state/reducers/components, a core config schema, custom image/mount and cleanup modules, plus adapters in all worktree paths. | B broadens the most conflict-prone core files and makes the optional feature a core dependency. |
| State owners | Pack store owns user config; external graph store owns graph/meta/cache; the future EP-8 service owns live jobs/LSP process records; existing project/session/worktree stores retain their current ownership. | A new core manager owns duplicate project settings, branch→graph maps, worker queue, process table, cached status, and grants; it risks disagreement with existing stores after restart. | A has three explicit owners with non-overlapping lifetimes; B creates shadow state. |
| Failure modes | Missing pack/version/runtime/EP contract is a visible no-op or labelled base/stale result. Provider errors remain non-fatal; external-store validation preserves last good graph. | New adapter can fail before worktree readiness, leak a worker or mount, get a stale branch mapping, or make import/session setup fail. Every restart/retry path must be newly designed. | A fails at established boundaries and retains today’s behavior when disabled. |
| Test seams | Existing lifecycle-hub, project-sandbox, worktree, pack-route/store, and browser onboarding fixtures pin each boundary. Graph runner and external store have focused fixtures. | Requires a new fake manager/queue/server API and cross-cutting mocks, then repeats worktree/import/sandbox lifecycle coverage to prove adapters agree. | A reuses verified seams and produces smaller, deterministic test fixtures. |
| Defect surface | New code is restricted to language matrix/detection, Graphify adapter/store, tool wrappers, and an EP adapter after its contract exists. | Adds a new core service lifecycle, authorization/config model, UI state model, container integration and duplicate path-resolution policy. | B adds independent state transitions and policy forks without gaining functionality. |

**Decision:** select A. B is rejected not because the feature is unimportant, but because a private system would violate the Extension-platform boundary, duplicate authoritative state and scheduling, and make the disabled case non-byte-identical. If a public contract cannot express an operation, that operation waits; it is not implemented behind a private adapter.

### 2.2 Chosen-design inventory

Every new state owner, API, abstraction, and dependency is listed here. “None” means an existing owner remains sole owner; it is intentional and testable.

| Item | Kind and owner | Lifetime / data | Justification and boundary |
|---|---|---|---|
| `ProjectCodeIntelligenceConfig` | **State:** pack store, keyed by server-derived pack/project identity | User-approved roots, enabled language capabilities, version pin/resolution and limits; survives restart | Per-pack configuration belongs in the existing namespaced store. It must not become a `project.yaml` core field. |
| External component graph directory and `GraphMeta` | **State:** `graph-store` pack module on host filesystem | Disposable base/derived/branch graph files, cache, locks, freshness and validation metadata | Graphify requires a large host-only cache. The store is outside checkouts, has no authority over project/session state, and can be GCed/rebuilt. |
| `GraphifyDeltaAdapter` | **Internal abstraction:** graph runner | One bounded build invocation; compatibility identity is recorded in `GraphMeta` | Isolates Graphify’s temporary pinned private delta call while U1 is absent. A Graph Correctness Foundation signature/behavior test is its compatibility gate; it is not a Bobbit platform API. |
| Language matrix and `detect()` | **Internal abstraction:** pack module | Static language specs; per-request tracked-file detection result | Prevents language-specific branches across AST, LSP, import and image code. It owns no durable project state apart from the user’s configuration. |
| `IndexStatus` and `GraphQueryScope` | **Data API:** pack route/tool response schema | Ephemeral serializable status and explicit code/docs scope | The generic declared-data shape keeps future `kind: index` promotion a migration. It is exposed only through pack allowlisted routes/tools. |
| `graph_*`, `ast_grep`, `lsp` | **Agent APIs:** existing pack tool surface | Read-only request/response; no implicit mutation | Reuses tool grants/activation and gives agents explicit capability boundaries. `ast_edit` is intentionally absent. |
| `[status, config, rebuild]` routes and status panel | **Pack APIs/UI:** existing `host.callRoute` and `panels/*.yaml` | Pack-local route namespace and declarative status rendering | Prevents raw fetch and a core UI/store branch. Manual rebuild remains bounded until EP-8 is implemented. |
| Generic `indexer` provider | **Existing API consumption:** LifecycleHub provider | No durable state; validates/no-ops or submits a service request | Uses #1081/#1099 hooks. It does not introduce an event or new provider kind; automatic jobs remain blocked without EP-8. |
| Graph build/LSP workers | **Future state:** EP-8 service, not this pack | Job/process record, cancellation, idle timeout, queue and cleanup | This entry is deliberately deferred. The pack supplies a declared job request only after a verified EP-8 SHA; no private queue, `BgProcessManager` reuse, or module map is permitted. |
| Import/settings/decision/prompt/grant integration | **Future APIs:** EP-7, EP-11, EP-13, and if needed EP-6 | User decision/grant and static-prompt records are platform-owned | These are external dependencies, not new Code Intelligence state. Integration waits for verified implementation SHAs. |
| Extension sandbox declaration/image requirements | **Existing/future public API consumption:** current sandbox boundary plus parent contract where required | Matrix-derived AST binary/LSP toolchain requirements | Reuses `buildSandboxImage` and normal project image state. It adds no graph mount or graph-specific image manager. |
| Graphify, ast-grep, LSP server binaries/toolchains | **External dependencies** | Resolved Graphify version; matrix-declared binaries/runtime layers | Graphify version is recorded/pinned; ast-grep is self-contained; LSP dependencies are independently declared per language and fail honestly when absent. |

The only persistent new stores are the pack store and the external graph store. The only future live-state owner is EP-8. There is no core code-intelligence registry, project-config schema, worktree mapping, process map, import state, custom grant, mount, or lifecycle event.

## 3. Pack layout and durable data

```text
market-packs/code-intelligence/
  pack.yaml
  providers/indexer.yaml                 # generic lifecycle provider
  tools/ast/{ast_grep.yaml,extension.ts}
  tools/graph/{graph_affected.yaml,graph_explain.yaml,graph_path.yaml,
               graph_neighbors.yaml,graph_query.yaml,graph_status.yaml,extension.ts}
  tools/lsp/{lsp.yaml,extension.ts}
  panels/code-intelligence-status.yaml
  lib/provider.mjs                       # lifecycle enqueue/orientation only
  lib/routes.mjs                         # declared status/config/rebuild routes
  lib/language-matrix.mjs
  lib/detect.mjs
  lib/graph-store.mjs
  lib/graphify-runner.mjs
  lib/lsp-manager.mjs
  src/                                  # TypeScript sources bundled to lib/
```

`pack.yaml` lists tool groups and `providers: [indexer]`; it uses pack-level `routes` for `[status, config, rebuild]`. It is dormant unless explicitly enabled for the project. The provider declaration is:

```yaml
id: indexer
kind: generic
module: ../lib/provider.mjs
hooks: [sessionSetup, afterTurn, goalProvisioned]
budget: { maxTokens: 400, timeoutMs: 1500 }
defaultEnabled: false
```

The timeout limits hook execution, not a background build. Automatic enqueue/worker ownership is blocked on the Extension platform’s implemented EP-8 service-lifecycle contract. Before its verified implementation SHA exists, Graph Extension Runtime exposes only bounded explicit/manual base work and Code Intel Integration is not enabled; a provider must never create an unmanaged detached child to evade that boundary.

### 3.1 Language matrix

`lib/language-matrix.mjs` is the single source of truth. Adding a language is a matrix change, not a new branch in tool code.

```ts
type Capability = "ast" | "lsp";
type RuntimeRequirement = {
  id: string;                         // "go", "rust", "jvm", "llvm", "node"
  installHint: string;
  sandboxImageLayer?: string;         // declared layer identifier, never a shell fragment
};
type LanguageSpec = {
  id: string;                         // "typescript"
  label: string;
  evidence: { globs: string[]; markers?: string[]; minFiles?: number };
  ast: { supported: boolean; grammar: string };
  lsp?: {
    command: string;
    rootMarkers: string[];
    actions: Array<"definition" | "references" | "hover" | "symbols" | "diagnostics">;
    hostRequirements: RuntimeRequirement[];
    sandboxRequirements: RuntimeRequirement[];
  };
};
```

Detection returns only tracked/configured component files and does not run an LSP:

```ts
type DetectedLanguage = {
  languageId: string;
  component: string;
  evidence: { files: number; matchedGlobs: string[]; markers: string[] };
  ast: "available" | "unavailable";
  lsp: "available" | "requires-runtime" | "unsupported";
  missing?: RuntimeRequirement[];
};
```

The import offer reads this result and writes a user-approved `ProjectCodeIntelligenceConfig` to the pack store. A user can opt into individual AST/LSP capabilities; an explicit version pin always wins. The offer must say, for example, “Go: structural search; references/definitions/diagnostics require the Go toolchain in the sandbox image,” rather than claiming LSP generally.

```ts
type ProjectCodeIntelligenceConfig = {
  enabled: boolean;
  scanRootsByComponent: Record<string, string[]>; // default ["src", "tests2", "defaults"] filtered to existing roots
  includeDocsByDefault: false;                    // invariant, never true in v1
  languages: Record<string, { ast: boolean; lsp: boolean }>;
  graphify: { requestedVersion?: string; resolvedVersion?: string; resolvedAt?: string };
  limits: { deltaDebounceMs: number; maxConcurrentBuilds: number; maxBranchGraphs: number; derivedReclusterNodeRatio: number };
};
```

The import offer is blocked on implemented—not design-only—Extension platform surfaces: EP-7 per-project settings UI, EP-11 typed decision requests, and EP-13 static prompt contributions. EP-6 grants and EP-8 service lifecycle are likewise design-only and cannot be consumed or recreated. Until verified implementation SHAs are supplied by that parent, configuration is available only from the pack’s existing status/config panel and allowlisted routes. No coder may add an ad-hoc field to `ProjectConfigStore`, direct edit to `project-assistant.ts`, or custom REST endpoint to bypass that boundary.

### 3.2 Graph store and status schemas

The graph store is host-only, outside every repository:

```text
<host-state>/graphs/<projectId>/<componentKey>/
  base/                 # current primary-base graph
  derived/<goalId>/     # parent-derived base, if a parent branch is active
  branches/<branchKey>/ # CoW clone plus own delta
  locks/ tmp/
```

`componentKey` is a stable escaped/hash key for the configured component `name` plus `repo`; it prevents same-name repositories from colliding. `branchKey` is a hash of project, component, branch and worktree identity, not a raw branch name. This eliminates slash traversal and lets two linked worktrees on the same branch be independently stale if required.

```ts
type GraphMeta = {
  schema: 1;
  component: { name: string; repo: string; relativePath?: string };
  kind: "primary-base" | "derived-base" | "branch";
  anchor: { cwdMode: "component-root-relative"; scanRoots: string[] };
  corpus: { roots: Array<{ path: string; tier: "code" | "docs" }>; trackedOnly: true };
  graphify: { resolvedVersion: string; requiredCapability: "incremental-delta" };
  revisions: { baseRef: string; baseRev: string; headRev: string; parentGoalId?: string; parentHeadRev?: string };
  build: { startedAt: string; completedAt: string; buildMs: number; cloneMs?: number; deltaMs?: number; nodes: number; edges: number; bytes: number; clustered: boolean; labels: "fresh" | "base-derived" };
  state: "fresh" | "building" | "stale" | "failed" | "base-fallback";
  staleReason?: "parent-advanced" | "worktree-dirty" | "base-rebuilt" | "validation-failed" | "version-changed" | "missing-runtime";
  applied: { changedPaths: string[]; dirtyPaths: string[]; deltaNodeCount: number };
};

type IndexStatus = {
  component: string;
  graph?: Pick<GraphMeta, "state" | "staleReason" | "build" | "corpus" | "revisions">;
  languages: DetectedLanguage[];
  noCrossRepoEdges: true;
};
```

This status is declared data: roots, node/edge counts, build time, version, freshness, and reason. The panel and `graph_status` render it generically from the route response. This is the required bridge to a future generic `kind: index`; it must not contain Graphify-specific UI assumptions.

A query takes a deliberately explicit tier selection:

```ts
type GraphQueryScope = { components?: string[]; tiers?: Array<"code" | "docs"> };
// tools default to tiers: ["code"]. `graph_query` exposes includeDocs?: boolean.
```

Every node stores `tier` and `sourceRoot`; graph queries filter nodes and edge traversals by tier. Community computation is per-tier. `graph_query({ includeDocs: true })` joins tiers for “why/documentation” questions and records separate latency; callers/impact stay code-only by default.

## 4. Graph construction invariants

1. **No checkout writes.** Every `GRAPHIFY_OUT`, manifest, cache, lock, temporary file and report is under the external store. Tests prove no `graphify-out/` appears in either primary or linked worktree.
2. **Pinned corpus and anchor.** Effective scan roots begin with `src`, `tests2`, `defaults` plus approved project additions. `base/meta.json` records the exact component-root-relative roots and all deltas replay that invocation. The corpus is tracked-only; generated/ignored files cannot enter it.
3. **Version resolution and delta adapter.** Install resolves the newest compatible Graphify version and records it. A user pin overrides resolution. Graphify has no public delta CLI today: `lib/graphify-runner` therefore defines `GraphifyDeltaAdapter { version, invokeDelta({ cwd, scanRoots, changedPaths, noCluster }): Promise<GraphRunResult> }`. It first uses a future supported CLI capability (U1); until then it may use only a version-pinned, isolated `_rebuild_code` adapter whose module path and signature are contract-tested by Graph Correctness Foundation. The resolver feature-probes the adapter, records its compatibility identity in `GraphMeta`, and fails loudly with the capability and minimum compatible version when it cannot invoke a correct delta. It never silently imports an unpinned private API. Version drift warns and invalidates the base.
4. **Base cadence.** A primary base rebuilds after a merge to the configured primary ref, coalesced by a five-minute floor. The build stages under `tmp/`, validates, atomically publishes graph files, and writes `meta.json` last.
5. **Delta settings.** Deltas use `--no-cluster`; base builds cluster. A derived base reclusters when `deltaNodeCount / base.nodes` reaches `derivedReclusterNodeRatio`, tuned by the correctness spike. Below that threshold its labels are `base-derived`.
6. **Mandatory validation at every chain link.** Before replacing a clone, reject when changed paths fall outside the pinned corpus, node source prefixes disagree with the pinned anchor, or the unaccounted node decrease exceeds the configured safety ratio. Rejecting means preserve the last good clone/base, set `failed` with `validation-failed`, and never serve the candidate as fresh.
7. **Honesty.** Tool output always includes component, revisions, graph state and dirty/stale indication. Results are leads; review guidance requires reading cited code. Fan-out says `noCrossRepoEdges: true` in UI and tool text.

The initial validation thresholds are measured from the authoritative spike, not guessed: the gate must reject the known corpus-drift collapse (−63%) and anchor-mismatch collapse (−91%), including the latter when Graphify's own shrink guard does not fire.

## 5. Worktree and nested-goal flows

### 5.1 Primary and linked worktree

```text
merge to primary → coalesced primary-base build at component repo root
                 → external .../base/meta.json published last

goalProvisioned(worktreePath, cwd, branch)
  → resolve configured component roots using existing component/worktree coordinates
  → select current base, CoW clone it outside checkout
  → git diff baseRev...HEAD with paths relative to that component root
  → background delta using recorded relative roots and paths
  → mandatory validation → atomic branch meta publish

sessionSetup / afterTurn
  → graph_status orientation only if usable
  → debounce dirty/HEAD change by branch and enqueue a replacement delta
```

`goalProvisioned` may run for team members, delegates, nested goals and pool claims. It must not assume a cold worktree nor install Graphify git hooks. Graph Correctness Foundation validates the `GraphifyDeltaAdapter`: a public CLI is preferred when U1 exists; otherwise its isolated, version-pinned `_rebuild_code` compatibility adapter is contract-tested and recorded. An unsupported resolved version reports the explicit capability failure. Automatic detached processing requires a platform-owned service from implemented EP-8; until its verified SHA is available the hook is a no-op and manual/rebuild operations stay bounded. The extension must not create an unmanaged child or private queue.

### 5.2 Nested goals

A goal at depth two has exactly these graph links:

```text
primary main@A
  └─ derived parent goal P@B = clone(primary@A) + delta(A...B)
       └─ child branch C@D = clone(parent P@B) + delta(B...D)
```

The parent-derived base is keyed by parent goal ID and component. It refreshes when the parent head changes (with the same floor). A child delta is always against the immediate parent's revision, never `main`; that keeps its applied set restricted to its own work. When P advances, all dependent child metas become `stale` with `parent-advanced`; queries show that state and use the last good graph only as explicitly stale fallback. Rebuild is lazy on the next request or eagerly queued when capacity permits. The existing goal ancestry in `HookScopeContext.goal.ancestry` supplies the bounded topology; no new ancestry walker is permitted. Today’s depth cap makes the maximum chain three graph links.

### 5.3 Multi-repo fan-out

For an unscoped request, resolve the active component from `scopeContext.component`. If it is absent, execute independently over every component with a usable graph and label each result `[component: api]`. Never merge graph JSON. A “what calls X?” response ends with “v1 has no cross-repo edges”; network/queue/IDL boundaries cannot be inferred as symbol edges. A future `merge-graphs` option is an explicit per-project opt-in for shared IDL/internal-library cases only.

## 6. Sandboxes and LSP lifecycle

| Surface | Execution location | Contract |
|---|---|---|
| Graph build/query | Host extension runtime | Graph results cross to the agent by tool/RPC. No graph mount. |
| `ast_grep` | Agent environment; Docker image for sandboxed projects | Static binary/grammars selected from the matrix. No language toolchain prerequisite. |
| LSP process | One lazy process per `{project, component, worktree, language}` | Root is that exact worktree component; never reuse a primary-checkout server for a linked worktree. |

`lsp-manager` is enabled only after implemented EP-8 supplies its declared service lifecycle. It then starts only when the matrix says the command and all runtime requirements exist in the relevant host/container. The EP-8 service owns idle timeout, cancellation on session/worktree cleanup, global per-project cap and queued starts; requests name a component/worktree. No module-level map or repurposed `BgProcessManager` is an acceptable substitute, because neither is the pending extension-service contract.

For Docker, required matrix `sandboxImageLayer` values are collected into the existing project image build request. The image build/status UI reports pending and missing requirements. If an image lacks Go/Rust/JVM/LLVM/etc., the project remains AST-only for that language and the UI/tool says why. `/tools:ro` and `/tools-builtin:ro` establish the read-only capability-delivery precedent; do not create a graph mount simply because one can be created.

## 7. Child delivery DAG and ownership

```text
AST Structural Search ──> Language LSP Intelligence ─────────┐
                         (verified EP contracts required)      │
                                                               ├──> Code Intel Integration
Graph Correctness Foundation ──> Graph Extension Runtime ─────┘
```

The five spawned goals are the authoritative plan. AST and Graph Correctness can run in parallel. Graph Runtime depends only on Graph Correctness and may use current `main` hooks/sandbox support for manual/bounded work. Language LSP depends on AST and waits for verified implemented EP contracts: EP-8 service lifecycle, EP-7 settings UI, EP-11 typed decisions, EP-13 static prompts, and EP-6 only if its eventual grant contract is required. Code Intel Integration depends on **both** Graph Runtime and Language LSP; it owns the final lifecycle/status/reviewer/import composition, not either subsystem’s internals. Current design-only EP commits must not be cherry-picked. The optional scope/observability commits named in §2 may be adopted only as those exact SHAs and recorded in the PR body. No goal works around a missing parent contract.

| Spawned goal | Deliverable and exclusive ownership | Depends on |
|---|---|---|
| **AST Structural Search** | `market-packs/code-intelligence/tools/ast/**`, AST matrix entries, structural-search fixtures and browser tool journey | None |
| **Graph Correctness Foundation** | Isolated Graphify harness/fixture and `lib/graphify-runner` contract tests, including anchor/corpus/chain validation thresholds; no runtime hook/tool registration | None |
| **Graph Extension Runtime** | `lib/graph-store`, graph tool schemas/extension, routes/status panel, graph metadata/config schemas and bounded manual rebuild | Graph Correctness Foundation |
| **Language LSP Intelligence** | LSP matrix entries/tool contract, LSP service request adapter, image-requirement adapter, settings/decision/prompt integration adapter and LSP journey | AST Structural Search; verified external EP contracts |
| **Code Intel Integration** | `lib/provider`, EP-8 service composition, lifecycle/nested-goal/worktree cleanup wiring, reviewer steering, final status/import integration and cross-slice tests | Graph Extension Runtime; Language LSP Intelligence |

No two goals edit a pack-owned source module. Shared core files are serialized by the integration lead: `src/server/server.ts`, `src/server/agent/lifecycle-hub.ts`, `src/server/agent/session-setup.ts`, `src/server/agent/project-sandbox.ts`, and the extension-platform public adapter once it lands. AST does not touch graph files; Graph Correctness never registers a runtime hook; Graph Runtime does not own lifecycle automation; Language LSP cannot change Graphify metadata; Integration composes public seams without reimplementing either subsystem.

## 8. File-level implementation ledger

| File/path | Owner | Change |
|---|---|---|
| `market-packs/code-intelligence/**` | relevant child above | New pack only; pack build uses `scripts/build-market-packs.mjs` rather than runtime TypeScript loading. |
| `src/server/agent/lifecycle-hub.ts` | Code Intel Integration, serialized | Consume existing provider hooks/scope only. No new event, provider kind, or graph-specific API. |
| `src/server/agent/session-setup.ts`, `goal-manager.ts`, `team-manager.ts` | Code Intel Integration, serialized | Carry existing `goalProvisioned`/scope inputs into the public adapter; preserve non-fatal dispatch. Do not duplicate provisioning. |
| `src/server/agent/worktree-inventory.ts`, `worktree-sweeper.ts`, `orphan-cleanup.ts` | Code Intel Integration, serialized | Notify the public cleanup adapter so external branch graph/LSP records are GC candidates. A reconcile pass is the safety net. |
| `src/server/agent/docker-args.ts`, `sandbox-status.ts`, `project-sandbox.ts` | Language LSP Intelligence after verified parent contract | Consume the extension sandbox declaration to install runtime layers. Keep existing mounts unchanged unless a general read-only artefact declaration requires one. |
| `src/app/dialogs.ts`, `src/server/agent/project-assistant.ts` | Extension platform parent | No Code Intelligence child edits these directly. The future EP-7/EP-11/EP-13 import contribution consumes `detect()` and presents the capability decision after verified implementation SHAs exist. |
| `src/server/agent/project-config-store.ts` | Extension platform parent | No bespoke `code_intelligence` YAML key. Persist through the existing pack store/config route until an implemented generic extension settings schema is published. |

## 9. Tests, measurements, and acceptance evidence

New automated tests live under `tests2/` and are registered in `tests2/tests-map.json`.

| Layer | Required proof |
|---|---|
| Core unit | Matrix evidence and requirements; version resolution/pin/drift/floor error; root normalization; external-store path containment; status/schema/tier defaults; tool output caps and no-cross-repo banner. |
| Graph integration | Tiny tracked fixture repo: add/modify/delete/rename delta; base clone; branch-only symbol appears; deleted symbol disappears; wrong absolute anchor and differing corpus each reject publication; base remains readable after worker failure. |
| Real-worktree integration | Provision a genuine linked worktree through the goal path. Assert the external store is used, no checkout contains `graphify-out`, and the Graphify worktree guard is never reached. Assert a pool claim follows the same path. |
| Nested-goal integration | Primary → parent derived base → child own delta. Advance the parent, prove child status is `stale/parent-advanced`, and prove a recompute uses parent revision rather than main. Run validation at all three links. |
| Lifecycle | `goalProvisioned` returns within 50 ms after enqueue, is idempotent, non-fatal, and disabled-pack provisioning/turn dispatch is byte-identical. Debounce coalesces edits and capacity limits jobs. |
| Sandbox/LSP | `ast_grep` executes in Docker; missing LSP runtime is an honest AST-only result; installed layer starts exactly one server per worktree/component/language and cleanup ends it. Docker image coverage is E2E. |
| Browser | Graph Extension Runtime covers the status/config panel and stale/no-cross-repo labels before parent integration. Code Intel Integration adds the import journey only after verified EP-7/EP-11/EP-13 SHAs: detect languages, user enables a truthful capability set, query structural search/graph status, reload, and clean up. Build on `tests2/browser`/existing project-onboarding journeys, not a duplicate UI harness. |

Run `npm run check`, `npm run test:unit`, and `npm run test:browser` for the integrated branch; run Docker/worktree coverage through `npm run test:e2e`.

Record, per component and corpus tier selection:

- base build wall time, clone wall time, delta wall time, query p50/p95;
- graph bytes, nodes and edges; CoW/reflink disk use where available;
- query latency with code-only and code-plus-docs scope;
- derived-base recluster threshold and measured clustered versus `--no-cluster` delta time;
- validation rejection counts/reasons; queue depth and hook duration;
- active LSP count, start latency, idle shutdown, and image-layer build time.

The starting measured reference is 18 s base build, 0.3 s CoW clone, 3.1 s no-cluster delta, 7.4 s clustered delta and 0.2 s affected query on the scoped repository. The spike must replace these with reproducible fixture and real-worktree measurements; no phase may substitute qualitative claims.

## 10. Rollout, fallback, and rollback

1. Ship AST Structural Search disabled-by-default; it has independent value and no graph/runtime store.
2. Run Graph Correctness Foundation against the real Bobbit linked-worktree fixture. Do not register Graph Extension Runtime until both known traps reject safely.
3. Enable Graph Extension Runtime status/tools for one non-Docker project with a compatible resolved Graphify version; query from a real linked worktree before Code Intel Integration reaches `main`.
4. Enable Code Intel Integration lifecycle top-ups, then reviewer steering, monitoring queue/build/validation metrics.
5. Enable LSP only after both its matrix/image requirements and the Extension platform lead’s verified EP-8 implementation SHA. Enable import/settings/grant/prompt integration only after verified implementation SHAs for EP-7/EP-11/EP-13 (and any needed EP-6 work); do not cherry-pick their current design-only commits.

Disablement removes tools/provider visibility through pack activation and stops future jobs. It never deletes a checkout file because none exist. Rollback cancels workers and LSP instances, marks status unavailable, and retains the external graph cache for diagnosis; a separate Maintenance action may GC it. A failed build, unsupported version, missing runtime, stale parent, or validation rejection degrades to an explicitly labelled last-good/base result or no index—never an apparently current graph.
