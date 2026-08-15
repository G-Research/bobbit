# Code Intelligence Integration

**Status:** integration design and audit.  
**Authority:** `docs/design/code-intelligence-extension.md`; this document records the current implementation seams and the smallest composition needed to finish the user-facing integration. It does not authorize a new core indexer, lifecycle manager, settings store, process map, REST API, or checkout-local artifact.

## Outcome and boundaries

The optional, default-disabled `code-intelligence` pack presents three independent facts:

| Capability | v1 promise | Never imply |
|---|---|---|
| Structural search | `ast_grep` finds syntax-shaped matches in the active worktree. | Type-aware references, diagnostics, or editing. |
| Component graph | Graph queries provide breadth/relationship leads with component, revision, tier, freshness, and the `v1 has no cross-repo edges` boundary. | A merged multi-repo graph, cross-repository edges, or proof that a cited call site is correct. |
| LSP | Named, read-only language actions are available only for an enabled language, compatible selected-runtime requirements, and an exact ready worktree-instance service. | A host probe proving Docker readiness, AST being an LSP fallback, or a server being started implicitly. |

**Non-negotiable v1 limits**

- One graph per configured component/repository; fan-out remains component-labelled and always says `v1 has no cross-repo edges`.
- Every Graphify candidate, artifact, lock, cache, and metadata record is host-side under the external graph store. Do not write `graphify-out/`, install a hook, or mount graph state into a sandbox.
- Detection, status reads, session orientation, and import presentation are bounded and read-only. They do not install a toolchain, start a server, or enqueue detached work.
- Graph breadth and LSP precision are review leads. Reviewers must `read` cited files and surrounding callers before reporting a finding or approving a change.

## Current implementation inventory

### Pack and live surfaces

| Current artifact | Exact exported seam | Current behavior | Integration gap |
|---|---|---|---|
| `market-packs/code-intelligence/pack.yaml` | schema-2 manifest; `contents.tools: [graph]`, `providers: [indexer]`, routes `status/config/rebuild` | Default-disabled pack contributes graph surfaces only when activated. | It does not declare AST or LSP tool groups, typed enablement, import contribution, or a managed service. |
| `tools/ast/extension.ts::createAstGrepExtension` and `ast-grep-runner.ts::executeAstGrep` | Session-local read-only structural search | Real binary probe/registration and bounded search are implemented; Docker uses image-local `sg`. | Integrate its detected-language facts into the common status/import presentation without changing its execution boundary. |
| `src/graph-query.ts::GraphQueryService` | `affected`, `explain`, `path`, `neighbors`, `query`, `status` | Code tier is default; docs are explicit only for `query`; responses are capped and carry `leadNotice`. | Make the same declared status data, not panel-specific guesses, feed orientation and reviewer guidance. |
| `src/graph-store.ts::GraphStore` | external candidate/clone/publish/read/lease/GC API | Durable host-only snapshots, meta-last publication, containment, slots, descendant staleness, and GC exist. | Runtime must supply real base/derived/branch build publication and lifecycle-owned cleanup/reconcile calls. |
| `src/graph-runtime.ts::GraphRuntime` and `GraphRuntimeFacade` | provider hooks, status/query/config/rebuild facade | `goalProvisioned` and `afterTurn` are no-ops; `sessionSetup` only emits bounded fresh/base-fallback orientation; manual rebuild explicitly returns `GRAPH_REBUILD_UNAVAILABLE_PENDING_EP8`. | Compose only a public service executor after it exists. Do not convert this facade into a queue or process owner. Include stale reason in a bounded orientation/status block when a last-good fallback is usable. |
| `src/routes.ts::routes` and `tools/graph/extension.ts` | allowlisted pack route and six read-only graph tools | Route revalidates requests and caps responses; tool transport has no graph path argument. | Route response must become the graph portion of the consolidated status model; preserve route-only access. |
| `src/panel.ts` and `panels/code-intelligence-status.yaml` | pull-only status/config/rebuild panel | Shows graph freshness, no-cross-repo banner, and EP-8 rebuild unavailability. | Render declared language capability rows and source all labels from route data; no client-side PATH probing or hand-authored state machine. |
| `lib/language-matrix.ts::CODE_INTELLIGENCE_LANGUAGE_MATRIX` | sole language declaration source | Declares evidence, structural grammar, optional LSP server/actions, and host/sandbox requirements. | Add no language switch. Consume it through detection/status only. |
| `lib/language-detection.ts::detectComponentLanguages` | bounded, symlink-safe component detection | Returns evidence and structural/LSP declaration state; LSP starts `disabled`. | Server-side adapter must resolve all configured components from verified worktree coordinates and preserve `truncated`. |
| `lib/capability-status.ts::deriveLanguageCapabilityStatus` | pure capability/status derivation | Requires explicit enablement, selected-runtime compatible probe facts, and exact matching service identity before `ready`. | Bind it to adopted platform settings/probes/service snapshots; do not fabricate readiness from a filename or host probe. |
| `lib/lsp-request-adapter.ts::serializeLspRequest` and `tools/lsp/extension.ts::createLspExtension` | read-only request contract | Validates canonical component-root containment and returns an explicit unavailable result without an injected platform service. | Adopt a public worktree-instance service port; execute actions through it rather than extending the adapter with a process map. |
| `lib/sandbox-requirements.ts::deriveSandboxRequirements` | pure layer declaration | Produces deduplicated named requirements with language attribution. | Feed only a future generic sandbox requirement/build contract. `sandbox-status.ts::buildSandboxImage` currently accepts no such declaration. |

### Correctness foundations already available

- `src/graphify-runner.ts::GraphifyDeltaAdapter` requires an exact version, external candidate root, pinned relative roots, and `noCluster`; it prefers a public capability and feature-probes the one pinned compatibility fallback.
- `src/graphify-harness.ts::{validateHarnessCandidate,GraphifyChainHarness,GraphifyPublicationHarness}` pins anchor/corpus/delta closure, fixed collapse rejection, direct-parent lineage, and preserve-last-good semantics without becoming runtime state.
- `src/graph-version.ts::resolveGraphifyVersion` resolves an exact capability-proven version and reports version drift as stale.
- `tests/e2e/graphify-linked-worktree.spec.ts` proves an external candidate, no checkout artifacts, a rejected checkout-local candidate, and live zero Graphify worktree-guard telemetry. It uses a Graphify-shaped Python fixture, not an installed Graphify package.
- `tests2/integration/language-lsp-worktree.test.ts` proves linked-worktree root identity and rejects a primary-checkout escape. `tests2/integration/language-lsp-docker.test.ts` proves AST-only Go degradation with no LSP state or checkout mutation.

## Existing Bobbit seams to compose

| Requirement | Existing owner and exact function | Integration use |
|---|---|---|
| Activation and pack visibility | `PackManifest`/contribution resolution and project `pack_activation` | The disabled pack remains the only feature switch. No parallel language/index registry. |
| Component identity | `hook-scope-context.ts::resolveConfiguredComponent()` and `resolveHookScopeContext()` | Resolve only server-owned project/component/worktree coordinates; absent or ambiguous scope is labelled unavailable, never guessed. |
| Provisioning | `LifecycleHub.dispatchGoalProvisioned()`; callers `GoalManager._dispatchGoalProvisioned()`, `session-setup.ts::dispatchGoalProvisionedHook()`, and `SessionManager.dispatchGoalProvisionedForWorktree()` | Preserve coverage of cold setup, pool claims, direct team-member worktrees, and nested goals. The provider stays cheap, idempotent, and non-fatal. |
| Ordinary-session context | `LifecycleHub.dispatch()` passes immutable `HookCtx.scopeContext` | Use this for bounded status orientation only. It is not authority to scan sibling components or access an arbitrary graph slot. |
| Prompt budget and provider blocks | `LifecycleHub` block validation/budgeting and `system-prompt.ts::assembleSystemPrompt` | Retain the current max-800-character graph block. A future static prompt contribution may state generic review rules only; it may not inject dynamic detection data. |
| Host route/panel/store mediation | pack `host.callRoute`, `HostApi.store`, `entrypoints/code-intelligence-route.yaml` | Route/panel remains pack-local and allowlisted. No raw gateway fetch, custom REST endpoint, or core UI reducer. |
| Existing project import | `dialogs.ts::createProjectAssistantSession()` and `project-assistant-autoprompt.ts::formatProjectAssistantAutoPrompt()` | Reuse the post-import project context only after the platform exposes a typed import decision event. Do not patch assistant prose or append a Code Intelligence side-channel to the scan payload. |
| Sandbox lifecycle | `sandbox-status.ts::buildSandboxImage()` and existing `ProjectSandbox` worktree paths | Existing builder/mounts remain authoritative. The current function has no image-requirement request, so LSP layer installation is blocked rather than emulated. |
| Cleanup | existing worktree pool, sweeper, inventory, and session cleanup own deletion | A future public service/cleanup adapter receives server-derived removal/reconcile notices; GraphStore GC is a host-state safety net. Do not add Graphify cleanup branches to every worktree remover. |

## Current-versus-goal gap ledger

| Goal requirement | Current state | Minimal remaining work |
|---|---|---|
| Bounded orientation | Graph fresh/base-fallback text is emitted by `GraphRuntime.sessionSetup`; no language summary is wired. | Create one declared, capped `CodeIntelligenceStatus` projection from graph status plus detected capability facts. Use it in the provider; include state/reason, component label, and “verify with read”. |
| Honest status UX | Graph panel is honest but graph-only. LSP status logic exists but has no route/panel integration. | Extend the pack route response and panel with declared graph/language rows. Surface `disabled`, `requires-toolchain`, `starting`, `failed`, `unavailable`, `stale`, and `base-fallback` verbatim; never infer a green state client-side. |
| Reviewer-impact guidance | Graph tools say results are leads; LSP tools give prompt guidelines. No shared reviewer orientation exists. | Add a static, bounded reviewer instruction through the adopted static-prompt contribution: use graph for breadth and LSP for exact navigation; `read` every cited source/caller; stale/base-fallback results may guide discovery but cannot establish current impact. |
| Import-time language experience | Add Project already scans repository/workspace selection, but has no typed detected-language decision callback. | After a root-published platform import decision contract, run bounded per-component detection, show one explicit default-disabled offer, and persist only through platform settings/pack config. Before that, show capability data only in the status surface. |
| Explicit enablement | Pack activation exists; no safe per-language settings collection or service declaration exists. | Wait for typed settings and worktree-instance service declarations. “Enable” must name AST/LSP choices and required runtimes; it must not install them. |
| Actual graph runtime | Store/query/version/validation foundations exist; no Graphify installation/executor/service owner exists. | Service owner performs bounded base/clone/delta/publish using the existing adapter/store contracts. It reports `building`, `fresh`, `stale`, `failed`, or `base-fallback`; hooks submit only service-owned work. |
| LSP operation | Matrix, status, request validation, and tool contracts exist; no live client or service owner exists. | Public service owner keys an instance by project, component, canonical linked-worktree root, and language; validates grants/runtime before every start and post-await publication; owns caps, idle shutdown, and cleanup. |
| Documentation | AST, Graphify Foundation, and LSP guides exist. `docs/language-lsp-intelligence.md` correctly describes the LSP slice as dormant but its broad “pack manifest contributes no runtime, tools, or UI” wording is no longer true because graph surfaces are live when activated. | Correct that wording, add an integration guide/status table, and link the panel, pack activation, graph limitation, LSP blockers, and language support matrix. |
| Browser journey | AST and graph journeys separately cover activation/query/reload/cleanup and status/reload/cleanup. No one journey spans detection, explicit enablement, actual query, honest capability display, reload, and cleanup. | Add one `tests2/browser` journey after platform contracts land; reuse project onboarding and market-pack activation rather than creating a test-only UI. |
| Measurements | Only contract-fixture rows are checked in; `graphify.available` is explicitly false. | Capture real Bobbit linked-worktree measurements with installed/version-recorded Graphify, separately from fixture timing. Never relabel current fixture rows as Graphify benchmarks. |

## Target data and control flow

```text
Add Project completes normally
  → adopted import event obtains verified project/component coordinates
  → bounded detectComponentLanguages(componentRoot) for each configured component
  → deriveLanguageCapabilityStatus(detection, platform settings/probe/service facts)
  → one typed default-disabled decision and settings write
  → declared CodeIntelligenceStatus route/panel/provider projection

session/worktree lifecycle
  → existing scope resolver chooses the active component or safe fan-out
  → GraphStore/GraphMeta gives graph revision, freshness, stale reason, counts, tiers, timings
  → capability status gives language evidence, enablement, selected-runtime requirements, service state
  → bounded provider orientation and tools/panel render the same serializable status

service-owned graph/LSP work (only after public lifecycle adoption)
  → graph: external candidate → existing validation → GraphStore meta-last publish
  → LSP: exact worktree-instance request → platform-owned managed service
  → status changes are visible; no checkout mutation, hidden fallback, or private queue
```

`CodeIntelligenceStatus` is a pack route/tool response shape, not a new core `kind: index`. Its graph portion derives from `GraphMeta`/`GraphQueryResponse`; its language portion derives from `LanguageDetection` plus `deriveLanguageCapabilityStatus`; lifecycle fields come from the adopted service only. It must include: component label, source roots/tiers, graph state/reason/revisions/counts/timings, `noCrossRepoEdges: true`, detection evidence including truncation, structural-search state, LSP state/actions/missing named requirements, runtime (`host` or `sandbox`), and bounded operator guidance. Paths, graph-store roots, process output, secrets, and arbitrary service diagnostics never cross the route.

### Stale and fallback rules

- `fresh` means the exact authorized component/worktree slot is current.
- `base-fallback` is usable only when explicitly labelled with the base revision and reason; it is never displayed as fresh.
- `stale`, `failed`, `building`, missing graph, and unavailable service remain visible states. A stale graph can provide a discovery lead but not a current-impact conclusion.
- A child whose direct parent advances is `stale/parent-advanced`; it may not silently query main. A worktree may read only its server-derived branch slot and direct-parent slot.
- A language is `ready` only with exact project/component/canonical-worktree/language/server/version identity. Host and sandbox probe facts remain separate.

## Import and language documentation plan

The import offer is blocked until an adopted public platform contract supplies: (1) typed per-project settings including a reviewed language collection, (2) a typed import-compatible decision carrying detection facts, and (3) worktree-instance service lifecycle ownership. Do not use `ask_user_choices`, transcript persistence, `project.yaml`, `host.store` JSON strings, `project-assistant.ts`, or a bespoke route as a substitute.

When available, the offer is one per project, defaults to **Keep disabled**, lists every detected component/language and says exactly one of: structural search available; LSP disabled; LSP available actions; or named host/sandbox requirements missing. It starts no server and triggers no install. Reload reads the persisted platform setting and current declared status; pack disable/uninstall stops/reconciles platform-owned services and removes surface visibility, while host-only graph artifacts are retained only for explicit maintenance GC.

User documentation must state the following current matrix facts rather than promise generic “code intelligence”:

| Language group | Structural search | LSP statement |
|---|---|---|
| Bash, CSS, Elixir, Haskell, HCL, HTML, JSON, Kotlin, Lua, Nix, PHP, Ruby, Scala, Solidity, Swift, YAML | Supported through the declared ast-grep grammar. | Structural search only in v1. |
| TypeScript, TSX, JavaScript | Supported. | `typescript-language-server` plus TypeScript/Node requirements; availability is per selected host or sandbox worktree. |
| Python | Supported. | Pyright plus declared Node/runtime requirements; no host-to-sandbox inference. |
| Go | Supported. | `gopls` and Go requirements; absent sandbox layers remain explicitly AST-only. |
| Rust | Supported. | `rust-analyzer` and Rust requirements. |
| Java | Supported. | Eclipse JDT LS and Java requirements. |
| C and C++ | Supported. | `clangd` requirements. |
| C# | Supported. | `csharp-ls` and .NET SDK requirements. |

The docs must also say that a detected extension is evidence only, partial/truncated detection is not absence proof, LSP never falls back to AST, and results from every capability need source verification. The graph guide/panel text must retain the literal `v1 has no cross-repo edges` limitation.

## Minimal delivery order and file ledger

1. **Status composition, pack-local only:** add the serializable status projection and route/panel rendering under `market-packs/code-intelligence/{src,lib}/`; use existing graph/detection/capability adapters. Keep pack build through `scripts/build-market-packs.mjs`.
2. **Orientation and reviewer instruction:** adjust only `src/provider.ts`/`src/graph-runtime.ts` pack sources for bounded declared status and use the adopted static-prompt contribution, not a hand-built `system-prompt.ts` branch.
3. **Platform adoption:** integration owner consumes verified public settings/import/service/image-requirement contracts in their published adapter locations. No current Extension Platform source in this worktree provides `ExtensionSettings`, a managed service runtime, or a typed import decision API, so this step is blocked rather than speculative.
4. **Service composition:** connect the public service executor to `GraphifyDeltaAdapter`, `GraphStore`, `Graphify` validation/version contracts, and `serializeLspRequest`; preserve current lifecycle call sites without adding another dispatch event.
5. **Docs and journey:** update `docs/ast-structural-search.md`, `docs/language-lsp-intelligence.md`, `docs/graphify-correctness-foundation.md`, and add an integration/operator guide only when claims are executable. Add the end-to-end browser journey last.

**Reserved core files:** any adoption must be serialized with the platform owner around `src/server/agent/lifecycle-hub.ts`, `session-setup.ts`, `session-manager.ts`, `goal-manager.ts`, `project-sandbox.ts`, `sandbox-status.ts`, and the platform’s published settings/import/service adapter. This integration must not edit `src/app/dialogs.ts`, `src/app/project-assistant-autoprompt.ts`, `src/server/agent/project-assistant.ts`, or `project-config-store.ts` for Code Intelligence.

## Evidence plan

| Evidence | Existing proof | Required integration proof |
|---|---|---|
| Language and capability truth | core matrix/detection/status/request/sandbox tests; linked-worktree and Docker degradation tests | Status projection preserves truncation, selected runtime, exact service identity, disabled default, and no AST/LSP conflation. |
| Graph correctness | harness/runner/store/query/route tests; real linked-worktree guard fixture | Real service path rejects both fixed `ANCHOR_MISMATCH` (~91% collapse) and `CORPUS_DRIFT` (~63% collapse), publishes no rejected candidate, and proves no checkout-local output or Graphify worktree-guard execution. |
| Chained base | in-memory `GraphifyChainHarness` lineage test | Real primary → parent-derived → child flow; parent advance yields explicit `stale/parent-advanced`, and child recompute uses its direct parent rather than main. |
| Browser | separate AST and graph journeys | One journey: register/import fixture → bounded language detection → explicit disabled/default enablement through platform UI → execute real `ast_grep` query → inspect graph/LSP honest states and no-cross-repo notice → reload → disable/uninstall/cleanup. It must never fake a ready LSP or Graphify result. |
| Docker | AST binary and Go AST-only fixture | Existing sandbox image route only: an absent named layer stays `requires-toolchain`; an adopted declared layer is reported independently and service cleanup terminates its exact worktree instance. |

Run the integrated branch with `npm run check`, `npm run test:unit`, `npm run test:browser`, and Docker/worktree coverage through `npm run test:e2e`. Register new tests under `tests2/` and regenerate/validate `tests2/tests-map.json` as required by the existing test-map tooling.

### Measurement record

Capture measurements from a real Bobbit linked worktree in a documented environment, separately for code-only and code-plus-docs scope:

- base build wall time, external-store bytes/nodes/edges, resolved Graphify version and compatibility identity;
- CoW/reflink clone time and disk delta; branch delta wall time; derived-base recluster threshold and clustered versus `noCluster` delta time;
- query p50/p95 for impact/path/search, including component fan-out; hook/orientation duration and service queue depth;
- validation rejection count/reason; LSP start/idle-stop latency and active instance count when the service exists.

The current `tests2/fixtures/graphify-benchmarks/harness-contract.json` is **not** this evidence: it records `graphify.available: false`, a Python contract fixture, and fixture rows (base 18.561 ms, clone 16.734 ms, no-cluster delta 18.448 ms, size 1.637 ms, query 3.048 ms). Preserve that distinction in the final PR and add new rows/artefacts for an installed Graphify measurement rather than overwriting its unavailable claim.

## Risks and guardrails

| Risk | Guardrail |
|---|---|
| A pending platform dependency leads to an ad-hoc service/settings/import path. | Block the feature; use only root-published public contracts and record their integration reference. |
| A stale or base graph is mistaken for current impact. | State/reason/revision appear before query results; reviewer guidance mandates `read`. |
| Multi-repo fan-out looks like an integrated graph. | Component labels and the literal no-cross-repo warning appear in tools, status, docs, and browser assertions. |
| Graphify dirties a linked checkout or reaches its guard. | External candidate containment, checkout manifest assertions, live guard telemetry, and no hook/mount policy. |
| LSP spills across worktrees or survives cleanup. | Exact instance key, service-owned fencing/caps/idle shutdown/cleanup, and linked-worktree E2E. |
| Detection overclaims a language or hides incomplete scans. | Matrix-only evidence, bounded traversal, `truncated` propagation, and explicit disabled/missing-runtime states. |
| Browser test simulates product behavior with a test-only control path. | Reuse Add Project, Marketplace, pack routes, and the adopted platform decision/settings UI; run a real AST query and cleanup through user-visible controls. |
