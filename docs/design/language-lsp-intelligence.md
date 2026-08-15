# Language LSP Intelligence

**Status:** implementation design. **Owner:** Language LSP Intelligence child.  
**Parent authority:** `docs/design/code-intelligence-extension.md` at design-authority commit `85189bfdc`.
**Platform source reviewed:** `goal/extension-plat-03a877d8`; this document proposes no cherry-pick and no private replacement for an Extension Platform surface.

## 1. Outcome and non-negotiable boundaries

Ship a disabled-by-default `market-packs/code-intelligence` language capability slice. It reports structural-search and LSP facts independently, detects declared languages per component, and gives agents honest read-only LSP actions only after all of the following are true:

1. the operator enabled that language and LSP explicitly;
2. its matrix-declared runtime is present in the relevant host or sandbox image;
3. the public Extension Platform settings, decision, static-prompt, grant, and managed-service contracts listed in §3 have been adopted and verified; and
4. the platform-owned service owner accepts the worktree-scoped start request.

The pack must never call an unavailable LSP an “AST capability,” claim that ast-grep provides references or diagnostics, install a compiler silently, or run a detached process/module-level process map.

| Capability | Truthful v1 statement |
|---|---|
| Structural search | Pattern matching is available only for a matrix-declared ast-grep grammar. It is not type-aware and does not provide definitions, references, hover, or diagnostics. |
| LSP | Definitions, references, hover, document symbols, workspace symbols, and diagnostics are available only for an enabled language whose server successfully started at this linked worktree component root. |
| Runtime install | A named toolchain/image layer is required when the matrix says so. Pending, unavailable, failed, and version-mismatched layers remain visible as LSP unavailable. |

**Out of scope:** rename/code actions/edits, an LSP for every detected extension, a private `project.yaml` key, direct mutation of project import UI or `project-assistant.ts`, a raw REST API, a new grant string, a Docker mount, a process daemon, and an assumption that host and Docker toolchains match.

## 2. Existing seams to compose now

| Need | Exact public/current seam | Use and limit |
|---|---|---|
| Pack resolution | `src/server/agent/pack-types.ts`, `pack-contributions.ts`, `pack-contribution-registry.ts`, `ProjectConfigStore` `pack_activation` | Schema-2 pack activation remains the first eligibility ceiling. Do not create a language registry. |
| Component/worktree identity | `src/server/agent/hook-scope-context.ts::resolveConfiguredComponent()` and `LifecycleHub` `HookScopeContext.component` | Resolve only server-owned component coordinates. If absent or ambiguous, return a labelled unavailable result; never guess a sibling component. |
| Worktree lifecycle signal | `src/server/agent/lifecycle-hub.ts::GoalProvisionedCtx` and `LifecycleHub.dispatchGoalProvisioned()` | This can orient/detect cheaply. It must not launch a server or enqueue a private worker. |
| Pack persistence and UI | `HostApi.store`, `host.callRoute`, pack `routes`, panels, and tool actions as documented in `docs/extension-host-authoring.md` | Pack-local read-only status/config routes only. No raw fetch and no core endpoint. |
| Generic sandbox build | `src/server/agent/sandbox-status.ts::buildSandboxImage(imageName, dockerContextRoot?, commandRunner?)` | Existing build has no arbitrary package/layer request parameter. It remains the sole image builder; LSP merely declares a requirement until a general sandbox declaration/build-request contract accepts it. |
| Existing sandbox identity | `src/server/agent/project-sandbox.ts`, `docker-args.ts`, and `/workspace-wt/<branch>/<repo>` mapping in `hook-scope-context.ts` | The LSP root is the selected linked worktree component path, never `/workspace`, primary checkout, or a branch container. Existing mounts remain unchanged. |
| Prompt assembly | `src/server/agent/system-prompt.ts::assembleSystemPrompt` | Only the EP-13 static contribution path may add a system-prompt section. No dynamic detection text is appended privately. |

`GoalProvisionedCtx` carries `{ goalId, projectId?, worktreePath, cwd, branch?, metadata }`; ordinary lifecycle calls carry the immutable advisory `scopeContext`. Treat both as server-owned input and preserve their non-fatal behavior.

## 3. Platform-contract blockers and Pearl-verified adoption evidence

Pearl verified stable oracle `80b9e1affed8603552d575e90045de2c40265da0` and the canonical EP series in §3.2; the parent independently verified that all 22 revised EP SHAs are ancestors of that oracle. **Waiting is mandatory:** packet branches are blocked/preparing and unstable. Apply no EP commits. The current EP worktree is dirty/staged and forbidden as an adoption source.

After completion, use only root-published integration PR references—not packet branches or individual EP SHAs—to establish platform availability. The required sequence is current `origin/main` → EP-6 → EP-7 → EP-11 + EP-13 → EP-8 → LSP, but no step begins until its completed root-published integration PR proves the relevant public contract.

The superseded historical evidence must not be used: `561085371`, `c82dac854`, `6219ccd`, `97254c916`, `66c10c90`, and `f173ed516` are not ancestors of oracle `80b9e1affed8603552d575e90045de2c40265da0`; `f173ed516` is downstream/non-platform and remains forbidden from adoption. No partial historical row is a substitute for a completed root-published integration PR.

### 3.1 Required public contracts, pending stable integration proof

The following identifies required ownership and target contracts only; it does not assert that an unstable packet branch exposes a usable public contract.

| Platform concern | Required public contract | Language-LSP composition |
|---|---|---|
| Project settings (EP-7) | `src/server/agent/extension-settings-schema.ts::{ExtensionSettingsTargetRef,ExtensionSettingsSchema,normalizeExtensionSettingsSchema}`; `GET /api/projects/:projectId/extension-settings`; revisioned `PATCH /api/projects/:projectId/extension-settings/:packId/:kind/:id` | Declare a typed, per-project **runtime** target. Use the platform CAS revision and redacted projection; never persist `code_intelligence` in project YAML or a custom settings endpoint. |
| Exact grants (EP-6) | `src/server/agent/extension-grant-policy.ts::createExtensionCapabilityGrantResolver()` with server-derived `{ kind: "pack", packId }` and closed `"service.manage"` | The platform service consumer re-checks `service.manage` before every start/reconcile and after every await before publishing usable. LSP does not create `lsp.manage` or cache an allow. |
| Decisions (EP-11) | `src/shared/extension-host/decision-request-contract.ts`; `src/server/agent/decision-request-manager.ts`; active `mode: decide` hook with exact `decide` grant | Reuse only a typed, durable decision request for an operator offer when the platform supplies an import-compatible hook/event. Do not synthesize `ask_user_choices`, a transcript row, or an agent wake. A current lifecycle decision is asynchronous and cannot be used as a synchronous import callback. |
| Static prompt (EP-13) | `system-prompts/<name>.yaml` listed in `contents.system-prompts`, `SystemPromptSectionContribution`, static section integration in `system-prompt.ts` | A literal, bounded “language intelligence is optional; inspect status before relying on it” section may be proposed through the static contribution approval/grant path. It contains no detected-language results and must not be an enablement offer. |
| Managed service lifecycle (EP-8) | `src/server/extension-host/service-extension-runtime.ts::{ServiceExtensionRuntimeManager,ServiceExtensionRuntimeDeps,ServiceExtensionRuntime}`; active declarative runtimes and `ServiceExtensionAuthorizationResolver` | The eventual core-owned worktree LSP consumer owns live instances. It must compose this lifecycle family or a reviewed additive extension of it; the pack submits a declared request and never owns a process table. The referenced contract is currently dormant: no gateway consumer calls `reconcile()`. |

Canonical platform owners are fixed as follows; LSP contributes data, configuration, and implementation only, never a substitute platform surface:

- **EP-7:** settings schema, store, secret-store, and paired runtime read.
- **EP-6:** grants policy and audit.
- **EP-11:** decision hook, manager, store, trusted operation, and Ask/Inbox/Proposal integration.
- **EP-13:** prompt overrides, diff, audit, config, and assembly.
- **EP-8:** service contract, registry, runtime, and host API.

The service contract currently keys processes by `{ projectId, packId, serviceId }`, while LSP requires `{ projectId, component, worktree identity, languageId }`. Therefore the LSP child **must not** pretend that a single declared service is already sufficient. The implementation dependency is a reviewed, public additive worktree-instance extension of the service contract (or a platform-provided equivalent) that retains the same grant/fence/stop ownership. Until a stable root-published integration PR proves it, only the bounded read-only adapters in §7 ship.

The following three platform-contract gaps remain explicit and block implementation beyond those adapters until a stable root-published integration PR proves their public contract:

1. A reviewed typed collection/per-worktree service declaration in extension settings; the primitive-only EP-7 shape cannot store language selection safely.
2. An import-compatible EP-11 `mode: decide` event carrying detected-language payload for the explicit operator offer.
3. A public EP-8 worktree-instance service lifecycle that preserves grant checks, fencing, ownership, caps, and cleanup.

No private settings key, decision flow, import UI hook, prompt injection, sandbox build path, or process lifecycle fallback may substitute for any blocker.

Likewise, no reviewed import lifecycle currently invokes a `mode: decide` hook with detected-language payload. Detection may run as a bounded query after import, but automatic import offer/decision integration is deferred until that explicit platform event exists. It must not be smuggled through `src/app/dialogs.ts` or `src/server/agent/project-assistant.ts`.

### 3.2 Pearl-verified canonical series — reference only; do not apply

These SHAs establish ancestry evidence only. They are not adoption instructions; use only a completed root-published integration PR reference after it proves the public contract.

| Order | Series | Pearl-verified canonical commits | Application status |
|---:|---|---|---|
| 0 | Stable oracle / current base | `80b9e1affed8603552d575e90045de2c40265da0` | Reference only; use the completed root-published PR's clean `origin/main` handoff, never the dirty/staged EP worktree. |
| 1 | EP-6 | `48b40fc7344457562bc8544198b42bbbad44e082` *(merge commit)*, `f40d25e54453974d2aadf409831dfe492ce22950` | Do not apply; await completed root-published integration PR proof. |
| 2 | EP-7 | `628d209fe564f168008143aa188975b50af0e485` *(merge commit)*, `5f525cebf3e2f59426895b383fa4e06401d228fc`, `b607e2362a4f59ec6d7c2e950e9f9ca55200b68a`, `0d196aaf36ac0a8bacc725aede99e8151475cdc2`, `e3bba70b7ba25960f8d034b5806af86563ae3d17` | Do not apply; await completed root-published integration PR proof. |
| 3 | EP-11 | `dd177ab2971bf568d9aff11a91a898ef0b292c7a` *(merge commit)*, `0fadd85a50faf9c2161822265f2d0ca5186c5240`, `dc44122ce1912aabf6a699da327e64b606cc9e86`, `b3cccec23c7f5175dbce5e56e2459e431529d13d` | Do not apply; await completed root-published integration PR proof with EP-13. |
| 3 | EP-13 | `0763554eda4a2af8d86bda75752e571019cf412a` *(merge commit)*, `79bc883cc9d7c324ab777b1ffce7b5c208a0cbd0`, `131fe91798ba404cd8462bcb7ecf7bc864494825`, `d4f29e2b26b12790f78cb71d4426a77a4d793613`, `ff61887a83a689874537c62a96c4230ccff4ce61`, `cf1ef9849c1c3392334c3fb9fb2f0c4828abe34c`, `5067c3f0c3e1739819a90c7749f336f5e19ee6f2` | Do not apply; await completed root-published integration PR proof with EP-11. |
| 4 | EP-8 | `3edba87eb4208f227fd5ca9c6dbc81c3e80ac648`, `03e44688e57eca7560846360cc8c3a09dd72a4a1`, `ea0f3255ba64ca05ceb4f5e2ed0ed47c12c26f55`, `41898dc7ee173a1386209c100937d291ae570a6f` | Do not apply; await completed root-published integration PR proof. |
| 5 | LSP | This language-LSP work follows only after EP-8. | Data/config/implementation only; no platform substitute. |

`48b40fc`, `628d209`, `dd177ab`, and `0763554` are merge commits. This is ancestry evidence only: never blind-cherry-pick or replay them; use only the completed root-published integration PR reference.

### 3.3 Pending PR evidence ledger

This is a record template, not evidence of application. Keep it in the final integration PR description and update it only after a completed root-published integration PR proves the relevant public contract and closes the applicable §3.1 gap.

| Canonical series | Completed root-published integration PR | Public contract and applicable gap proven | LSP consumer enabled |
|---|---|---|---|
| EP-6 | Pending | Pending | `service.manage` fence |
| EP-7 | Pending | Pending | Settings only |
| EP-11 + EP-13 | Pending | Pending | Durable offer and static truthful guidance |
| EP-8 | Pending | Pending | Core-owned lifecycle only after worktree-instance extension |
| LSP | Pending | Pending | Pack-local data/config/implementation only |

## 4. Pack layout and data-only language matrix

```text
market-packs/code-intelligence/
  pack.yaml
  tools/ast/ast_grep.yaml
  tools/lsp/lsp_definition.yaml
  tools/lsp/lsp_references.yaml
  tools/lsp/lsp_hover.yaml
  tools/lsp/lsp_symbols.yaml
  tools/lsp/lsp_diagnostics.yaml
  tools/lsp/lsp_status.yaml
  panels/code-intelligence-status.yaml
  lib/routes.mjs
  lib/language-matrix.mjs
  lib/detect.mjs
  lib/capability-status.mjs
  lib/lsp-request-adapter.mjs
  lib/sandbox-requirements.mjs
  src/…                              # bundled through scripts/build-market-packs.mjs
```

No language-specific `if` statements belong in tool handlers, detection UI, service lifecycle, or sandbox logic. Adding a language changes a single matrix entry and fixtures.

```ts
type LspAction = "definition" | "references" | "hover" | "documentSymbols" |
  "workspaceSymbols" | "diagnostics";

type VersionConstraint = { range: string; reason: string };
type ToolchainRequirement = {
  id: string;                         // e.g. "node", "typescript-language-server"
  label: string;                      // visible named requirement
  version?: VersionConstraint;
  executable?: string;                // probe only; never a shell fragment
  installHint: string;                // visible operator guidance
};

type SandboxLayerRequirement = ToolchainRequirement & {
  layerId: string;                    // general build-contract identifier, not Dockerfile text
};

type LanguageMatrixEntry = {
  id: string;                         // stable pack-local id, e.g. "typescript"
  label: string;
  evidence: {
    globs: readonly string[];
    rootMarkers: readonly string[];   // evidence only, never proof LSP can start
    minimumFiles: number;
  };
  structuralSearch: {
    state: "supported" | "unsupported";
    astGrepGrammar?: string;          // required only when supported
  };
  lsp?: {
    server: {
      id: string;
      command: string;
      args: readonly string[];        // declarative argv tokens only
      version?: VersionConstraint;
    };
    rootMarkers: readonly string[];
    actions: readonly LspAction[];
    host: readonly ToolchainRequirement[];
    sandbox: readonly SandboxLayerRequirement[];
  };
};

type LanguageDetection = {
  component: string;
  languageId: string;
  evidence: { fileCount: number; matchedGlobs: string[]; rootMarkers: string[] };
  structuralSearch: "available" | "unsupported";
  lsp: "disabled" | "ready" | "requires-toolchain" | "unsupported";
  missing: readonly ToolchainRequirement[];
};
```

The initial entries are TypeScript/JavaScript, Python, Go, Rust, Java, C/C++, and C#. An entry may be structural-search-only. It may also have no ast grammar but an LSP declaration. That asymmetry is intentional and always visible.

`detect(componentRoot)` scans only bounded, configured/tracked component files and root markers. It never launches a server, runs package installation, or treats a filename as proof that a toolchain exists. The returned object is serializable and is the only input to status, the later offer, prompt wording, and sandbox requirement derivation.

## 5. Settings, enablement, detection, and offer

### Configuration shape

A valid runtime settings target must also satisfy the closed managed-service declaration schema. The present contract has no per-worktree LSP service declaration, so this child declares **no runtime YAML and no settings field yet**. After the platform supplies its reviewed worktree-instance service contribution, that contribution owns a typed project target with these desired fields: `enabled` (boolean, default false), `maxInstances` (1–8, default 4), and `idleShutdownMs` (30,000–900,000, default 300,000).

Per-language selections require a reviewed collection representation in the extension-settings contract. The current primitive-only EP-7 schema cannot safely encode an open-ended `languages` map. Until the platform provides that type, the feature remains disabled rather than storing selection state in `host.store`, serializing JSON into a string setting, or adding a private project field. The eventual platform field must be a server-resolved matrix list or reviewed collection—not client-defined language keys.

### Import behavior

1. Project import finishes normally.
2. A bounded detection adapter resolves every configured component and produces `LanguageDetection[]`.
3. Until an explicit platform import hook/event is available, the detection result appears only in the pack status/config surface; automatic enablement offer is unavailable and labelled as such.
4. Once the platform supplies that event, submit one EP-11 decision request with a safe default of **Keep disabled**. The request lists, per language: structural-only; LSP actions available now; or the exact missing named toolchain/image layer. It does not install anything.
5. A valid choice updates only platform settings/pack configuration through its approved path. It starts no LSP itself. The static prompt contribution supplies only generic operating guidance, not mutable detection content.

The offer must distinguish, for example:

> TypeScript: structural search available. Definitions, references, hover, symbols, and diagnostics start after `typescript-language-server` is available for this worktree.

> Go: structural search available. LSP needs the Go toolchain in this project’s sandbox image.

## 6. LSP protocol and lifecycle design

### Dependency choice

Add pinned production dependencies `vscode-jsonrpc` and `vscode-languageserver-protocol` from the Microsoft-maintained VS Code language-server ecosystem. Use `StreamMessageReader`, `StreamMessageWriter`, and `createMessageConnection` for JSON-RPC framing and the maintained LSP request/notification types. Do **not** hand-roll Content-Length framing or use `vscode-languageclient`, which is coupled to VS Code extension APIs rather than a headless Bobbit service.

Pin exact compatible versions in `package.json`/lockfile, expose them only from the core service adapter, and use a small `LspProtocolClient` wrapper with these methods:

```ts
interface LspProtocolClient {
  initialize(params: InitializeParams): Promise<InitializeResult>;
  definition(params: DefinitionParams): Promise<Definition | DefinitionLink[] | null>;
  references(params: ReferenceParams): Promise<Location[] | null>;
  hover(params: HoverParams): Promise<Hover | null>;
  documentSymbols(params: DocumentSymbolParams): Promise<DocumentSymbol[] | SymbolInformation[] | null>;
  workspaceSymbols(params: WorkspaceSymbolParams): Promise<SymbolInformation[] | WorkspaceSymbol[] | null>;
  diagnostics(uri: string): Promise<PublishDiagnosticsParams | null>;
  shutdown(): Promise<void>;
  dispose(): Promise<void>;
}
```

Diagnostics are server-published notifications cached only by the platform service instance; `lsp_diagnostics` returns the last document version’s diagnostic set plus timestamp/state, never invents a clean result when no notification arrived.

### Platform-owned instance identity

The required service instance key is:

```ts
type LspInstanceKey = {
  projectId: string;
  component: { name: string; repo: string; relativePath?: string };
  worktreePath: string;       // canonical linked-worktree component root
  languageId: string;
};
```

The proposed public service request contains that key, matrix server declaration, configured `maxInstances`, and `idleShutdownMs`. The future service owner—not the pack—must enforce:

- a global cap of **8** and a configurable project cap (default **4**), with FIFO bounded pending starts;
- one initialization at a time per key; concurrent requests share it;
- shutdown `shutdown`/`exit`, stream close, and process/container termination after no lease/request for `idleShutdownMs` (default five minutes);
- cleanup on worktree removal, project disable/uninstall, service reconciliation, gateway shutdown, failed initialization, and a new component root identity;
- fresh `service.manage` authorization before start and every awaited publication boundary; revocation stops/reconciles the affected instance;
- root URI and `workspaceFolders` exactly at the linked worktree component root; no primary-worktree reuse;
- structured statuses: `disabled`, `requires-toolchain`, `starting`, `ready`, `idle-shutdown`, `failed`, `stopped`, with sanitized reason codes.

This is intentionally **not** a `Map` in `lib/lsp-manager`, a child from a tool route, or a `BgProcessManager` use. Before the worktree-instance service extension lands, `lsp-request-adapter` validates and serializes a request but returns `service-unavailable`; it starts nothing.

### Action contract and degradation

Every tool accepts `{ component?, path, position }` or its action-specific query, resolves its path below the selected worktree component root, acquires only a `ready` matching instance, and returns:

```ts
type LspResult<T> = {
  capability: "lsp";
  action: LspAction;
  component: string;
  languageId?: string;
  status: "ready" | "disabled" | "requires-toolchain" | "starting" | "unavailable" | "failed";
  result?: T;
  reason?: string;             // bounded, operator-actionable; never stdout/stderr/secrets
};
```

A missing runtime returns `requires-toolchain` with the matrix requirement; an unsupported language returns `unavailable`; an initialization failure returns `failed` with the server name and sanitized reason. No tool falls back to ast-grep while retaining an LSP action label. `lsp_status` exposes detection, explicit enablement, runtime probe, instance status, root, and limited start/last-use timestamps.

## 7. Sandbox requirement adapter

`lib/sandbox-requirements.mjs` is immediately implementable and pure:

```ts
function deriveSandboxRequirements(
  detected: readonly LanguageDetection[],
  enabledLanguageIds: readonly string[],
): readonly SandboxLayerRequirement[];
```

It deduplicates only matrix-declared `layerId`s, retains the language/reason attribution, and produces no shell, Dockerfile fragment, mount, or build invocation. The existing `buildSandboxImage()` remains untouched until a public generic image-requirement contract accepts this object. When that contract is adopted, it must combine requirements into the ordinary project image build, expose build pending/failure in status, label resulting image compatibility, and retain the existing mounts exactly.

Host mode probes declared executable/version requirements using a bounded, argument-vector command runner owned by the service adapter. Docker mode probes inside the selected existing sandbox context after image readiness. A host success never implies Docker success, and vice versa.

## 8. Ownership and delivery partition

| Owner | Exclusive files/concern | Must not edit |
|---|---|---|
| AST Structural Search | `market-packs/code-intelligence/tools/ast/**`; matrix structural entries | LSP protocol/lifecycle/service files |
| Language LSP Intelligence | Matrix LSP fields, `tools/lsp/**`, detection/status/request/sandbox-requirement adapters, pack LSP fixtures and design | Graph files, private core process/lifecycle code, project assistant/import UI |
| Extension Platform/integration owner | EP adoption, public worktree-instance service extension, settings/import decision/prompt wiring, generic sandbox build declaration | Language-specific matrix branches |
| Code Intel Integration | Serialized final service composition, lifecycle/worktree cleanup bridge and import event consumption after platform support | Rewriting LSP protocol or AST semantics |

Immediate child changes are pack-local and bounded adapters only. Core files such as `src/server/server.ts`, `src/server/agent/session-setup.ts`, `project-sandbox.ts`, `sandbox-status.ts`, lifecycle hub, and import UI are reserved for the owning platform/integration task after adoption.

## 9. Test Suite v2 plan

Register every new test in `tests2/tests-map.json`; no tests belong under legacy `tests/`.

| Tier | Location and proof |
|---|---|
| Core | `tests2/core/language-lsp-matrix.test.ts`: matrix validation, language evidence, AST/LSP asymmetry, required runtime/version, duplicate layer normalization. `lsp-request-adapter.test.ts`: canonical component/worktree root, URI containment, status reasons, no start on unsupported/missing/runtime-disabled state. `sandbox-requirements.test.ts`: pure host-vs-sandbox requirements, no command fragments. |
| Integration | `tests2/integration/language-lsp-worktree.test.ts`: create a genuine linked worktree/component, detect it, ensure request root is the linked component and not primary, then cleanup causes an adapter stop request when the public service seam exists. `language-lsp-service.test.ts` is gated on the adopted service contract and proves one instance per worktree/component/language, cap queueing, idleness, failure, revocation fence, and no leak. |
| Docker E2E | `tests2/integration`/E2E owner fixture: build through the existing project sandbox image path, verify an absent named layer yields structural-only status, then verify the declared installed layer starts in `/workspace-wt/...` and cleanup terminates it. Do not test by adding an LSP-specific mount or direct `docker exec` lifecycle. |
| Browser | `tests2/browser/e2e/language-lsp-intelligence.spec.ts`: import/detection surface shows per-language facts; operator sees an explicit disabled default and exact toolchain wording; enable/query shows definition/reference status; missing toolchain remains honestly unavailable; reload preserves status; disabling/removing the pack cleans up. The auto-offer segment is marked pending until the public import event/EP-11 bridge is adopted, then replaces—not duplicates—the status flow. |

The integrated branch runs `npm run check`, `npm run test:unit`, and `npm run test:browser`; real linked-worktree/Docker coverage runs `npm run test:e2e`.

## 10. Acceptance checklist

- [ ] Adding a language is one matrix entry plus fixture evidence.
- [ ] AST and LSP status are independently visible and never conflated.
- [ ] Detection scans only component evidence and never launches/install tools.
- [ ] An LSP request uses a real linked-worktree component root.
- [ ] Missing host or sandbox toolchain produces exact structural-only degradation.
- [ ] No private settings, decision, grant, prompt, import, sandbox-build, or process lifecycle surface was added.
- [ ] The eventual service owner enforces caps, lease-aware idle shutdown, cleanup, and fresh `service.manage` fences.
- [ ] Every adopted EP SHA has clean-base/test/PR evidence in §3.3.
- [ ] Browser, real-worktree, and Docker journeys prove detection, honest offer/status, reload, and cleanup.
