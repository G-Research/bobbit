# Extension Platform — Implementation Plan (hand-off)

Status: ready for execution, not started. Workstream **EP** in
[fable-program-execution-plan.md](fable-program-execution-plan.md) (program sequencing +
master checklist; its §0-equivalent rules ARE this document's §0).

Companion to [extension-platform.md](extension-platform.md) (the WHAT/WHY — read its §3–§12
before implementing anything). This document is the HOW: a tree of goals, each independently
mergeable and verifiable, written so an implementer agent **that has not seen any other goal**
can execute its goal from this text alone.

> **Anchor baseline:** master @ `6ec8c8f9` (2026-06-10). Line numbers WILL drift — always
> locate by **symbol name** (function/class/field), and treat line numbers as hints. If a
> named symbol does not exist where described, STOP and re-derive from the pattern file cited
> next to it; do not improvise a parallel mechanism.
>
> **Precision policy:** Goals G1–G3 are specified to file/function level. G4–G9 are specified
> to contract level (their substrate is created by G1–G3 and will have evolved); their
> implementers must re-verify every anchor first and follow the stated contracts exactly.

---

## 0. Universal rules — every goal's definition of done

These apply to EVERY sub-goal below. A sub-goal is not done until all of them hold.

1. **Read before editing.** Run `rg "<symbol>" docs/ tests/ src/` for each seam you touch and
   read the hits (AGENTS.md rule). Pinning tests are the invariants — if your change breaks
   one, fix your change, not the test.
2. **Test-first.** Author the goal's listed tests BEFORE the implementation; confirm each is
   RED on the unmodified tree where the spec says so, then flip GREEN. New invariants you
   introduce must each get a pinning test.
3. **Gates:** `npm run check` clean · `npm run test:unit` green · `npm run test:e2e` green
   (run the suites relevant to your change per AGENTS.md: UI-only → unit; server → unit+e2e).
   Real Docker tests go ONLY in `tests/manual-integration/`.
4. **Every user-facing feature needs a browser E2E** (navigation, happy path, persistence
   across reload) — pattern: `tests/e2e/ui/settings.spec.ts`.
5. **No flaky tests.** No `test.skip`/quarantine/retries/timeout bumps. Deterministic fixtures
   only.
6. **Master stays green; minimal change.** Do not refactor neighbouring code, do not touch
   seams owned by other goals (each goal lists its owned files).
7. **Conventions:** LF line endings; lowercase-kebab file names; new server code under
   `src/server/…` mirrors sibling style; packs built like `market-packs/pr-walkthrough`
   (TS in `src/`, built bundles in `lib/`, wired into `scripts/build-market-packs.mjs` and —
   for built-in band packs — `scripts/copy-builtin-packs.mjs` `FIRST_PARTY_PACKS`).
8. **Coordination note:** `src/server/agent/session-manager.ts` and `session-setup.ts` are
   also touched by the comms-stack reliability backlog
   ([comms-stack/04-current-state-and-backlog.md](comms-stack/04-current-state-and-backlog.md)).
   Keep edits confined to the named functions; rebase rather than resolve broad conflicts.

### 0.1 Patterns library (copy these, don't invent)

| Need | Copy from |
|---|---|
| Pack-scoped contribution loader (yaml per file, validation, containment) | `src/server/agent/pack-contributions.ts` (`loadPackContributions`, `PanelContribution`) |
| Executing pack module code with timeout/isolation | `src/server/extension-host/module-host-worker.ts` (`ModuleHost.invoke(InvokeRequest, timeoutMs)`) + `route-dispatcher.ts` (`RouteRegistry.resolve`) |
| Generated pi extension calling the gateway | `src/server/agent/tool-guard-extension.ts` (`generateToolGuardExtension`, invoked from `session-setup.ts::resolveToolActivation`, appended as `--extension` to `plan.bridgeOptions.args`) |
| Prompt section with byte budget | `src/server/agent/system-prompt.ts` (`buildSkillsCatalogSection`, `skillsCatalogBudget`, `getPromptSections`, `persistPromptSections`) |
| Docker execFile discipline | `src/server/agent/project-sandbox.ts` (DOCKER_BIN, MSYS env handling) |
| Idempotent ensure-with-inflight-dedupe supervisor | `src/server/agent/sandbox-manager.ts` |
| Marketplace REST + atomic install | `src/server/agent/marketplace-install.ts` (`installPack`/`uninstallPack`/`updatePack`) |
| Per-entity activation | `src/server/agent/project-config-store.ts` (`DisabledRefs`, `getPackActivation`/`setPackActivation`) + `pack-resolver.ts` `ActivationFilter` |
| API E2E boot | `tests/e2e/e2e-setup.ts` (`base()`, `bobbitDir()`, `gitCwd()`) |
| Marketplace browser E2E | `tests/marketplace-active-project.spec.ts` |
| Exemplar packs | `market-packs/artifacts` (tool+renderer+panel), `market-packs/pr-walkthrough` (routes/panels/entrypoints + built-in band) |

### 0.2 One architectural refinement vs the design doc

`extension-platform.md` §4 sketches the new entity types as `EntityLoader` entities. **The
implementation uses the pack-contributions path instead** (the path panels/entrypoints/routes
already use), because the new types are **pack-scoped** — two packs may each ship a provider
with id `memory` and BOTH must be active; `EntityLoader` name-merging (shadowing by name
across packs) is the wrong semantics. Concretely: providers, hooks, mcp, pi-extensions,
runtimes, and workflow templates are loaded by `pack-contributions.ts`-style loaders into the
`PackContributionRegistry`, keyed `(packId, contributionId)`, with `contents.<type>` lists as
the activation catalogue and `DisabledRefs.<type>` as the per-entity toggles — exactly the
existing entrypoints model. `EntityType` in `pack-types.ts` is NOT extended. Record this in
any code comment that would otherwise cite the design doc's sketch.

---

## 1. Goal map

```
G1  Providers + Lifecycle Hub (P1)
 ├─ G1.1 Manifest schema 2 + activation plumbing            (no deps)
 ├─ G1.2 Lifecycle Hub core + worker dispatch + trace       (after G1.1)
 ├─ G1.3 sessionSetup hook → Dynamic Context prompt section (after G1.2)
 ├─ G1.4 Per-turn hooks: gateway events + provider-bridge   (after G1.3)
 ├─ G1.5 Market UI: provider listing + toggles              (after G1.1; parallel with G1.2-4)
 └─ G1.6 session-memory pack                                (after G1.4)
G2  Hindsight pack, external mode (P2)
 ├─ G2.1 REST client + stub-server harness                  (no deps; parallel with G1)
 ├─ G2.2 Pack core: provider + routes + config + banks      (after G1.4, G2.1)
 └─ G2.3 Tools + panel + entrypoints                        (after G2.2)
G3  Managed runtimes (P3)
 ├─ G3.1 Runtime manifest + secrets/env/ports (pure)        (after G1.1)
 ├─ G3.2 PackRuntimeSupervisor + REST (docker mocked)       (after G3.1)
 └─ G3.3 Wire-up: lifecycle hooks, hindsight managed mode,  (after G3.2, G2.3)
          consent line, manual-integration test
G4  Memory depth (P4): G4.1 beforeCompact ordering · G4.2 memory browser v2 ·
     G4.3 dual-provider dedupe/priority + cost              (after G2.x; G4.* parallel)
G5  MCP as pack content (P5): G5.1 entity+discovery band+UI (after G1.1)
G6  Hooks + pi-extensions (P6):
 ├─ G6.1 hooks entity + command dispatcher + Hub mapping    (after G1.4)
 ├─ G6.2 PreToolUse/PostToolUse via tool-guard generalization (after G6.1)
 └─ G6.3 pi-extensions entity + trust acknowledgment        (after G1.1)
G7  Claude plugin adapter (P7): G7.1 detect+browse · G7.2 convert+skipped report ·
     G7.3 UI + real-marketplace E2E                         (after G5, G6)
G8  Capabilities + selectors (P8):
 ├─ G8.1 Capability registry (provides/requires/call)       (after G1.2)
 ├─ G8.2 Selector decision points + proposals + policy      (after G8.1)
 └─ G8.3 Proposal UI + fixture selector pack                (after G8.2)
G9  Workflow templates + flagship packs (P9):
 ├─ G9.1 workflows entity + instantiation                   (after G1.1)
 ├─ G9.2 model-selector capability pack                     (after G8.1)
 └─ G9.3 multi-model-delivery pack                          (after G9.1, G9.2)
```

**Merge lanes (parallelizable):** Lane A: G1.1→G1.2→G1.3→G1.4→G1.6 · Lane B: G1.5 ·
Lane C: G2.1 (immediately) then G2.2→G2.3 · Lane D: G3.1→G3.2 (after G1.1) ·
Lane E: G5, G6.3, G9.1 (after G1.1). **File-conflict hotspots:** `pack-contributions.ts` +
`pack-contribution-registry.ts` (G1.1, G3.1, G5, G6, G9.1 — serialize merges in goal order);
`session-setup.ts` (G1.3, G1.4, G6.3); `server.ts` route block (most goals — keep each goal's
routes in one contiguous block); `marketplace-install.ts` (G3.3, G7.2).

---

## G1 — Providers + Lifecycle Hub

### G1.1 Manifest schema 2 + provider contribution + activation plumbing

**Outcome.** `pack.yaml` accepts `schema: 2` with six new `contents` keys and
`provides`/`requires`; `providers/<id>.yaml` files load into the contribution registry;
per-provider activation toggles work end-to-end through the existing REST. No runtime behavior
yet (nothing dispatches providers) — independently mergeable because everything added is inert
until G1.2.

**Owned files.** `src/server/agent/pack-manifest.ts`, `pack-types.ts` (types only),
`pack-contributions.ts`, `src/server/extension-host/pack-contribution-registry.ts`,
`project-config-store.ts` (DisabledRefs), the pack-activation REST handlers.

**Context.** `validateManifest` (`pack-manifest.ts:71-138`) currently: requires
`contents.{roles,tools,skills}` arrays, optional `contents.entrypoints` (safe basenames),
**rejects `contents.mcp`** at `:95-97`, ignores unknown top-level keys.
`loadPackContributions(packRoot, manifest)` (`pack-contributions.ts:111`) loads
panels (auto-discovered), entrypoints (filtered by `contents.entrypoints`), routes.
`DisabledRefs` (`project-config-store.ts`) = `{roles?, tools?, skills?, entrypoints?}`;
accessors `getPackActivation`/`setPackActivation` (`:855/:868`).

**Steps.**
1. `pack-types.ts`: add to `PackManifest`:
   `schema?: number` (default 1), `provides?: string[]`, `requires?: string[]`, and
   `contents` gains `providers?/hooks?/mcp?/piExtensions?/runtimes?/workflows?: string[]`
   (YAML keys: `pi-extensions` maps to `piExtensions`). Do NOT touch `EntityType` (§0.2).
2. `pack-manifest.ts::validateManifest`:
   - parse `schema` (must be a positive integer if present; default 1);
   - for each new contents key: if present, must be `string[]` of safe basenames (reuse the
     entrypoints validation helper); default `[]`;
   - `contents.mcp` present **and** `schema >= 2` → accepted; `schema < 2` → keep the existing
     rejection message verbatim;
   - `provides`/`requires`: optional `string[]`, entries match `/^[a-z0-9][a-z0-9-]*$/`;
   - if `schema > 2`: log one warning (`pack.yaml: schema 3 is newer than supported (2)`),
     still load the v2 subset.
3. `pack-contributions.ts`: add `ProviderContribution`
   `{ id, kind: "memory"|"selector"|"generic", module, hooks: string[], runtime?, budget:
   {maxTokens:number, timeoutMs:number}, defaultEnabled: boolean, config?, listName,
   sourceFile, packRoot }` + `loadProviders(packRoot, manifest)` mirroring
   `loadEntrypoints` exactly: only files named in `contents.providers` load
   (`providers/<name>.yaml`); `module` resolved relative to the yaml and containment-checked
   against packRoot (same guard the routes module uses); `hooks` entries must be from
   `["sessionSetup","beforePrompt","afterTurn","beforeCompact","sessionShutdown"]`
   (unknown → load error for THAT provider, pack still loads); budget defaults
   `{maxTokens: 1600, timeoutMs: 1500}` clamped to `maxTokens∈[64,8192]`,
   `timeoutMs∈[100,10000]`. Duplicate provider id within a pack → `PackContributionError`
   (same as panels).
4. `pack-contribution-registry.ts`: index providers like entrypoints (winning-pack collapse,
   activation filtering via `DisabledRefs.providers` ↔ `listName`); add
   `listProviders(projectId): ProviderContribution[]` returning only installed+active+enabled.
5. `project-config-store.ts`: extend `DisabledRefs` with
   `providers?/hooks?/mcp?/piExtensions?/runtimes?/workflows?: string[]`; the pack-activation
   REST catalogue response must include the new types (find the handler via
   `rg "pack-activation" src/server` and extend the catalogue builder symmetrically).
6. Cache invalidation: confirm `invalidateResolverCaches()` already drops
   `packContributionRegistry` (it does — verify, don't re-add).

**Tests (author first).**
- Extend the existing pack-manifest unit test file (find via `rg "validateManifest" tests/`):
  schema-2 manifest with all six keys parses; `contents.mcp` rejected at schema 1 (existing
  test stays green) and accepted at schema 2 (RED before step 2); bad `provides` entry
  rejected; `schema: 3` loads with warning.
- New `tests/pack-providers-loader.test.ts`: fixture pack dir (tmp) with two providers —
  valid one loads with clamped budget; unknown hook name → that provider errored, other loads;
  module outside pack root → error; duplicate id → `PackContributionError`; provider NOT in
  `contents.providers` → not loaded.
- Extend the registry test (find via `rg "PackContributionRegistry" tests/`): disabled ref in
  `DisabledRefs.providers` hides the provider; re-enabling restores it.
- API E2E: `PUT /api/marketplace/pack-activation` round-trips a `providers` disabled ref.

**Acceptance.** All above green; `git grep "EntityType" | grep -i provider` → no hits (the
refinement honored); zero behavior change for v1 packs (run the full existing marketplace
test set).

**Non-goals.** Dispatching providers (G1.2); loaders for hooks/mcp/pi-extensions/runtimes/
workflows (G5/G6/G3/G9 own those — but the *manifest keys* are accepted now).

---

### G1.2 Lifecycle Hub core + worker dispatch + budgets + trace

**Outcome.** A `LifecycleHub` that resolves enabled providers and dispatches a named hook to
each on the Extension Host worker tier with per-provider timeout, collects `ContextBlock[]`,
applies budgets, fences content, and records a trace. Pure server core + fixture-driven tests;
nothing calls it yet from session paths (mergeable independently).

**Owned files (new).** `src/server/agent/context-blocks.ts`,
`src/server/agent/lifecycle-hub.ts`, `src/server/agent/context-trace-store.ts`. **Edited:**
`src/server/extension-host/module-host-worker.ts` (one union member).

**Steps.**
1. `context-blocks.ts`:
   ```ts
   export interface ContextBlock {
     id: string; title: string; providerId: string;
     authority: "memory"|"skill"|"tool"|"workflow"|"role"|"generic";
     content: string; reason: string; priority: number; tokenEstimate: number;
   }
   export function estimateTokens(s: string): number; // ceil(s.length / 4) — same heuristic as PromptSection.tokens
   export function fenceBlock(b: ContextBlock): string;
   // `<context-block id=".." source=".." authority=".." reason="..">\n{content}\n</context-block>`
   // reason/title attribute values: strip newlines + escape double quotes.
   export function applyBudgets(blocks: ContextBlock[], perProviderMax: Map<string,number>,
     globalMax: number): { kept: ContextBlock[]; omitted: {block: ContextBlock; why: string}[] };
   // sort by priority desc then provider order; truncate the first over-budget block's
   // content to fit (append "…[truncated]"), drop the rest; never partially emit a block
   // smaller than 32 tokens — drop instead.
   ```
2. `module-host-worker.ts`: extend `InvokeRequest.exportKind` union with `"providers"`; the
   worker resolves the member on the module's **default export object** for that kind (routes
   use named exports — mirror whichever branch handles member lookup and add the
   default-export branch). No other worker changes.
3. `lifecycle-hub.ts`:
   ```ts
   export type LifecycleHook = "sessionSetup"|"beforePrompt"|"afterTurn"|"beforeCompact"|"sessionShutdown";
   export interface HookCtx { sessionId: string; projectId?: string; scope: "project"|"global";
     cwd: string; goalId?: string; roleName?: string; prompt?: string;
     turn?: { index: number }; budget: { maxTokens: number };
     config: Record<string, unknown>;                  // provider config values
     runtime?: { baseUrl: string; headers: Record<string,string>; status: string };
     gateway: { baseUrl: string; token: string };      // loopback REST for trusted provider code
   }
   export class LifecycleHub {
     constructor(deps: { registry: PackContributionRegistry; moduleHost: ModuleHost;
                         trace: ContextTraceStore; gatewayInfo: () => {baseUrl:string;token:string};
                         globalMaxTokens?: number /* default 4000 */ });
     async dispatch(hook: LifecycleHook, base: Omit<HookCtx,"budget"|"config"|"gateway">):
       Promise<{ blocks: ContextBlock[]; diagnostics: HubDiagnostic[] }>;
   }
   ```
   `dispatch`: resolve providers for `projectId` whose `hooks` include `hook`; for each,
   `ModuleHost.invoke({ exportKind: "providers", member: hook, url: <module file URL>,
   packRoot, ctx-as-arg })` with `timeoutMs = provider.budget.timeoutMs`. Per-provider
   failure/timeout ⇒ diagnostic `{providerId, hook, error|"timeout", ms}`, continue. Validate
   each returned block (shape + string fields + `providerId` forced to the provider's id +
   `tokenEstimate` recomputed host-side); then `applyBudgets`. Record one trace entry per
   dispatch: `{ts, hook, sessionId, providers: [{id, ms, blocks, omitted, error?}]}`.
4. `context-trace-store.ts`: `appendTrace(sessionId, entry)` /
   `readTrace(sessionId, limit?)` over JSONL at
   `<stateDir>/session-context-trace/<sessionId>.jsonl` (atomic append; create dir lazily;
   cap file at 2MB by dropping oldest — simple rewrite).

**Tests (author first).**
- `tests/context-blocks.test.ts`: fencing escapes quotes/newlines in attributes; budget: 3
  blocks/2 fit → third dropped with reason; oversize first block truncated; <32-token
  remainder dropped not truncated; global cap binds before per-provider headroom.
- `tests/lifecycle-hub.test.ts` (node:test, real `ModuleHost`, fixture modules in tmp dir):
  (a) two fixture providers return blocks → merged, budgeted, provenance forced;
  (b) provider that `await new Promise(r=>setTimeout(r, 5000))` with `timeoutMs: 200` →
  diagnostic `timeout`, other provider unaffected, dispatch total time < 1s;
  (c) provider throws → diagnostic, no crash; (d) provider returning malformed blocks →
  blocks dropped with diagnostic; (e) trace file contains the dispatch record.
- `tests/context-trace-store.test.ts`: append/read round-trip; 2MB cap behavior.

**Acceptance.** All green; `ModuleHost` route/action tests untouched and green; no session
code calls the hub yet (grep).

**Non-goals.** Prompt integration (G1.3); endpoints (G1.4); selector hooks (G8).

---

### G1.3 sessionSetup hook → "Dynamic Context" prompt section

**Outcome.** New sessions dispatch `sessionSetup` through the Hub; returned blocks render as a
**Dynamic Context** section in the system prompt and appear in the existing prompt-sections
inspector with provenance. Proven by a deterministic fixture pack.

**Owned files.** `src/server/agent/system-prompt.ts`, `session-setup.ts`,
`session-manager.ts` (construction/injection of the Hub only), `tests/fixtures/packs/provider-demo/`.

**Context.** Pipeline steps run in order `resolveBridgeOptions(:331) → resolveGoalExtensions(:389)
→ resolveTools(:414) → resolvePrompt(:451) → resolveToolActivation(:606)`, driven by
`executePlan` (insertion point ~line 699, before `resolvePrompt`) and `executeWorktreeAsync`
(~line 887). `PromptParts` (`system-prompt.ts:294`), `getPromptSections(:543)`,
`persistPromptSections(:654)` called from `session-manager.ts:1645`.

**Steps.**
1. `system-prompt.ts`: add `dynamicContext?: ContextBlock[]` to `PromptParts`. In
   `getPromptSections` (and the parallel branch in `assembleSystemPrompt` — note both
   call sites of `buildSkillsCatalogSection` at `:471` and `:600`; mirror that duality), when
   `dynamicContext?.length`, append a final section
   `{label: "Dynamic Context", source: "providers", content: blocks.map(fenceBlock).join("\n\n")}`
   AFTER all existing sections (it is the freshest, lowest-authority content; placement
   pinned by test).
2. `session-setup.ts`: new async step `resolveDynamicContext(plan, ctx)` inserted before
   `resolvePrompt` in BOTH `executePlan` and `executeWorktreeAsync`: if `ctx.lifecycleHub` is
   set, `const {blocks} = await ctx.lifecycleHub.dispatch("sessionSetup", {...ids, scope:
   plan.projectId ? "project" : "global", prompt: plan.initialPromptText ?? undefined})`;
   stash on the plan so `resolvePrompt` copies them into `parts.dynamicContext`. Entire step
   wrapped in try/catch → log + proceed (provider failures never block a spawn).
   Add `lifecycleHub?: LifecycleHub` to `PipelineContext`.
3. `session-manager.ts`: construct one `LifecycleHub` at manager init (deps: the existing
   contribution registry + a `ModuleHost` instance + trace store + gateway info from the
   same source the tool guard uses) and pass it through the pipeline context. Keep this the
   ONLY new session-manager edit.
4. Fixture pack `tests/fixtures/packs/provider-demo/`:
   `pack.yaml` (schema 2, `contents.providers: [demo]`), `providers/demo.yaml`
   (hooks: all five; budget 512/1000), `lib/provider.mjs` — deterministic: `sessionSetup`
   returns one block `{id:"demo:setup", title:"Demo", content:"DEMO_SETUP_BLOCK <sessionId>",
   reason:"fixture", priority:10}`; every hook also POSTs `{hook, sessionId}` to
   `ctx.gateway.baseUrl + "/api/ext/route/record"`? — NO: simpler and dependency-free, append
   to a file under `ctx.cwd + "/.provider-demo-log"` (the worker has fs; the test reads the
   file). Loading: verify `buildPackList` supports a `BOBBIT_BUILTIN_PACKS_DIR` override; if
   it does not exist on the current tree, add it (env var consulted where the builtin packs
   dir is resolved; production default unchanged) — that override is this fixture's loader
   and G-wide test seam.

**Tests (author first).**
- Unit `tests/dynamic-context-section.test.ts`: `getPromptSections` with two blocks → last
  section is "Dynamic Context", fenced content, token count populated; absent when no blocks.
- API E2E `tests/e2e/provider-session-setup.spec.ts` (in-process gateway,
  `BOBBIT_BUILTIN_PACKS_DIR` → fixtures): create session → `GET
  /api/sessions/:id/prompt-sections` contains the Dynamic Context section with
  `DEMO_SETUP_BLOCK`; disable the provider via pack-activation → new session has no section;
  fixture log shows exactly one `sessionSetup`.
- Codegen-free; no browser E2E here (inspector UI already renders sections — verify by the
  existing prompt-sections UI spec if one exists; otherwise G1.5 covers UI).

**Acceptance.** Sections appear with provenance; spawn latency without providers unchanged
(no Hub configured ⇒ zero-cost path); failure injection (fixture module throws) still spawns.

**Non-goals.** Per-turn dispatch (G1.4); UI (G1.5).

---

### G1.4 Per-turn hooks: gateway-event hooks + provider-bridge extension + endpoints

**Outcome.** `afterTurn`/`sessionShutdown` fire from the gateway's existing event stream;
`beforePrompt` (per turn) and `beforeCompact` fire via a Bobbit-generated **provider-bridge pi
extension** with blocking semantics; per-turn blocks are traceable via
`GET /api/sessions/:id/context-trace`.

**Owned files (new).** `src/server/agent/provider-bridge-extension.ts`. **Edited:**
`session-setup.ts::resolveToolActivation` (append one more `--extension`), `server.ts`
(4 endpoints), `session-manager.ts` (two event-handler call sites).

**Design decisions an implementer must follow exactly:**
- **Never mutate the user's message text.** Injecting recall into the outgoing prompt text
  would corrupt the transcript echo and re-open the optimistic-reconciliation duplicate class
  (see comms-stack docs). Per-turn injection goes through the **system prompt tail**:
  the bridge handles pi's `before_agent_start`; inspect the event payload type in
  `node_modules/@…/pi-coding-agent/dist/core/extensions/types.d.ts`
  (`BeforeAgentStartEvent` / `BeforeAgentStartEventResult`): if the event exposes the current
  system prompt, return `{ systemPrompt: stripPreviousTail(current) + tail }`; the tail is
  delimited `\n<!-- bobbit:dynamic-context:start -->…<!-- bobbit:dynamic-context:end -->` so
  replacement is idempotent turn-over-turn. If the event does NOT expose the current prompt,
  maintain the full prompt client-side: the gateway endpoint returns
  `{ tail, fullSystemPrompt }` (gateway knows the assembled prompt — it built it) and the
  extension returns the recomposed prompt. Pick whichever the types support; pin with the
  codegen snapshot test.
- **Bridge transport** = the tool-guard pattern verbatim: generated TS reads
  `BOBBIT_GATEWAY_URL` + `BOBBIT_TOKEN`, `fetch` with an AbortController timeout (2500ms
  beforePrompt / 5000ms beforeCompact); on ANY failure return undefined (turn proceeds
  without dynamic context — non-fatal is the platform invariant).

**Steps.**
1. Endpoints (one contiguous block in `server.ts`, bearer-authed like the tool-grant
   endpoints):
   - `POST /api/sessions/:id/provider-hooks/before-prompt` body `{prompt}` →
     `hub.dispatch("beforePrompt", …)` → `{ tail: string, blocks: <meta only> }` (tail = fenced
     blocks joined inside the delimiters; empty string when none).
   - `POST …/before-compact` → dispatch, returns `{}` when all flushes settle (bounded by per-
     provider timeouts).
   - `GET /api/sessions/:id/context-trace?limit=` → trace store read.
   - (afterTurn/shutdown have NO endpoint — gateway-internal, next step.)
2. `session-manager.ts`: in the existing agent-lifecycle event handling, on `turn_end` (or
   `agent_end` when turns aren't granular) fire-and-forget
   `hub.dispatch("afterTurn", {…, turn:{index}})`; on session archive/stop path dispatch
   `sessionShutdown`. Locate by `rg "turn_end|handleAgentLifecycle" src/server/agent/session-manager.ts`
   — add ONLY the dispatch calls.
3. `provider-bridge-extension.ts`: `generateProviderBridgeExtension(sessionId): string |
   undefined` — returns a written tmp file path (mirror `writeToolGuardExtension`'s file
   handling); generated source subscribes `before_agent_start` and `session_before_compact`
   per the design decisions above. Generate ONLY when at least one enabled provider declares
   `beforePrompt` or `beforeCompact` (registry query) — zero overhead otherwise.
4. `session-setup.ts::resolveToolActivation`: after the tool-guard block (`:622-629` pattern),
   call the generator and push `--extension <path>` when defined.

**Tests (author first).**
- `tests/provider-bridge-extension.test.ts`: codegen snapshot (delimiters present; gateway URL
  read; abort timeout present); not generated when no provider wants the hooks.
- API E2E `tests/e2e/provider-turn-hooks.spec.ts` (provider-demo fixture): drive a turn via
  the mock agent → fixture log contains `beforePrompt` then `afterTurn`; `GET
  …/context-trace` lists both dispatches with timing; kill switch — disable provider, next
  turn logs nothing; before-prompt endpoint with a hanging provider responds within budget
  with empty tail (RED until timeout handling correct).
- Idempotent-tail unit: applying the tail twice yields one delimited region.

**Acceptance.** Per-turn injection visible in the mock agent's received system prompt
(in-process mock exposes it — verify via the bridge spy or transcript); a turn with the
provider down completes normally; trace endpoint paginates.

**Non-goals.** Tool-call hooks (G6.2); compaction-content mutation; UI.

---

### G1.5 Market UI: provider listing + activation toggle

**Outcome.** The Marketplace pack-detail UI lists a pack's providers (id, kind, hooks, budget,
origin) with working per-provider enable/disable that takes effect synchronously.

**Owned files.** The marketplace UI module(s) — locate with
`rg -l "pack-activation|packActivation" src/app src/ui` — plus the catalogue REST already
extended in G1.1.

**Steps.** Mirror exactly how entrypoint toggles render and persist today (same component,
new section "Providers"); show `kind` and the hook list as chips; disabled state persists via
the existing `PUT /api/marketplace/pack-activation`.

**Tests.** Browser E2E `tests/e2e/ui/marketplace-providers.spec.ts` (model:
`tests/marketplace-active-project.spec.ts`): provider row visible for the fixture pack; toggle
off → persists across reload → (combined with G1.3's API assertion) new sessions skip it.

**Non-goals.** Provider settings forms (each pack's panel owns its config UI); trace UI.

---

### G1.6 `session-memory` pack

**Outcome.** Built-in, default-on memory: before each turn the agent receives bounded
"Relevant past work" blocks recalled from the project's existing search index; new sessions
recall against the goal/task spec. Zero external dependencies. This is the platform's flagship
litmus.

**Owned files (new).** `market-packs/session-memory/` (pack.yaml schema 2;
`providers/recall.yaml` hooks `[sessionSetup, beforePrompt]`, budget `{1200, 800}`;
`src/provider.ts` → built `lib/provider.mjs`); entries in `scripts/build-market-packs.mjs`
(`PACKS` const, line ~91) and `scripts/copy-builtin-packs.mjs` (`FIRST_PARTY_PACKS`, line 23).

**Provider behavior (spec — implement exactly):**
1. `beforePrompt(ctx)`: skip when `!ctx.prompt` or prompt < 8 chars. Query
   `GET {ctx.gateway.baseUrl}/api/search?q=<first 300 chars of prompt>&projectId=<ctx.projectId>
   &type=all&limit=8` with bearer `ctx.gateway.token`, 600ms fetch timeout.
2. Filter results: drop rows where `sessionId === ctx.sessionId` (never recall the ongoing
   conversation); drop score below a floor (tune with the fixture; start 0.05); keep top K=3.
3. One block per result:
   `{ id: "session-memory:"+result.id, title: "Relevant past work", authority: "memory",
   priority: 5, reason: "BM25 recall for current prompt",
   content: "[<type>] <title> (session <sessionId>, <ISO date>)\n<snippet with <b> tags stripped>" }`.
4. `sessionSetup(ctx)`: same flow keyed on the goal/task spec text when present (the Hub
   passes it as `ctx.prompt` for sessionSetup — G1.3 wired `plan.initialPromptText`; extend
   to goal spec if available on the plan).
5. Config (in `providers/recall.yaml` `config`): `k` (default 3), `minScore`,
   `includeArchived` (default true), `sources` (default all). Read from `ctx.config`.

**Tests (author first).**
- Unit `tests/session-memory-provider.test.ts` (drive the BUILT `lib/provider.mjs` directly
  with a stubbed `fetch` injected via ctx or global): current-session rows filtered; K cap;
  score floor; snippet `<b>` stripping; fetch timeout ⇒ returns `{blocks: []}` (never throws).
- API E2E `tests/e2e/session-memory-recall.spec.ts`: seed project with one session containing
  a distinctive token (drive the mock agent to emit it, let the indexer flush); create a
  second session and send a prompt containing that token; assert the Dynamic Context tail
  delivered to the agent (or the trace) contains a `session-memory:` block referencing the
  first session; toggle the pack off ⇒ no block.
- Browser E2E: rely on G1.5's toggle spec + extend it to assert this pack's row exists
  (it ships in the built-in band, so it's present by default).

**Acceptance.** Recall works on a fresh dev install with no configuration; total added
latency per turn ≤ the 800ms provider budget (pinned by the timeout test); disabling the pack
returns the system to byte-identical prompts (assert via prompt-sections diff in the E2E).

**Non-goals.** Embeddings/semantic ranking; summarization artifacts; cross-project recall;
panel UI.

---

## G2 — Hindsight pack (external-URL mode)

> Implementer note: verify the real Hindsight REST paths against the targeted Hindsight
> release BEFORE coding the client; the contract below is Bobbit's internal client interface —
> the stub mirrors THIS contract, and `hindsight-client` adapts it to upstream paths.
>
> Bank topology is decided: **one shared tag-scoped bank**, tools take `scope:` mapped to
> tag filters (NOT `bank:` switching) — rationale + auto-tag taxonomy in
> [agent-memory.md §3](agent-memory.md). Two upstream checks at this goal: (1) confirm
> tag-filtered recall with strict matching via REST/SDK; (2) confirm **delete-by-tag**
> exists for project offboarding — if absent, record the per-project-bank fallback for
> deletion-sensitive installs in the pack README.

### G2.1 REST client + stub-server harness *(parallel with all of G1)*

**Outcome.** `market-packs/hindsight/src/hindsight-client.ts` (built to
`lib/hindsight-client.mjs`) + an in-process stub server usable by every later test.

**Client contract.**
```ts
export interface HindsightClient {
  health(): Promise<{ok: boolean}>;
  recall(bank: string, query: string, opts?: {maxTokens?: number}): Promise<{memories: {text: string; score?: number; id?: string}[]}>;
  retain(bank: string, content: string, opts?: {tags?: Record<string,string>; sync?: boolean}): Promise<void>;
  reflect(bank: string, prompt: string): Promise<{text: string}>;
  listBanks(): Promise<{banks: string[]}>;
}
export function createClient(cfg: {baseUrl: string; apiKey?: string; timeoutMs?: number}): HindsightClient;
```
Every method: AbortController timeout (default 1500ms), throws typed `HindsightError`
(`kind: "timeout"|"http"|"network"`, status?).

**Stub** `tests/e2e/hindsight-stub.mjs`: `startHindsightStub({port?: 0})` →
`{url, calls: RecordedCall[], setHealthy(bool), seedMemories(bank, mem[]), close()}` —
an `http.createServer` with canned JSON for the five operations, recording every call
(method, path, bank, body) for assertions.

**Tests.** `tests/hindsight-client.test.ts` against the stub: round-trips; timeout ⇒
`HindsightError{kind:"timeout"}` within budget; 500 ⇒ http error; auth header sent when
apiKey set.

### G2.2 Pack core: provider + routes + config + bank scoping

**Outcome.** `market-packs/hindsight/` with provider (`providers/memory.yaml`, hooks: all
five), pack routes (`status, recall, retain, reflect, banks, config`), config persistence in
the pack store, and scope-aware banks — fully working against an external URL.

**Spec highlights (implement exactly; full shapes in extension-platform.md §11):**
- Bank ids: `bobbit-proj-<projectId>` / `bobbit-global`; `beforePrompt` recalls BOTH in
  parallel (`Promise.allSettled`, one shared deadline = provider `timeoutMs`), merges by
  score, caps to budget. `sessionSetup` recalls vs goal/task spec.
- `afterTurn`: build a compact turn summary (user text + final assistant text, capped 2000
  chars) → `retain(projectBank, …, {tags:{sessionId, goalId, roleName}})`, **async**; on error
  push `{content, tags, ts}` onto a retry queue in the pack store (`host.store` from routes /
  `ctx.store` from provider — same packId namespace), retry queue head on every later
  afterTurn; cap queue at 100 (drop oldest, count surfaced via `status` route).
- `beforeCompact`: `retain(…, {sync: true})` of the about-to-be-lost span summary.
- `sessionShutdown`: drain queue best-effort (one pass).
- Config route persists `{mode: "external"|"managed", externalUrl, apiKeyRef, autoRecall,
  autoRetain, recallBudget}` in the pack store keyed per scope; provider reads it via
  `ctx.config` (G1.1 loader merges store-config over yaml defaults — add that merge here if
  G1.1 shipped static config only; keep the merge in the loader, not the provider).
- Dormancy: if neither a healthy runtime (G3) nor `externalUrl` is configured, every hook
  returns immediately (`{blocks: []}`) — the pack is installed-but-dormant.

**Tests.** Unit (bank derivation incl. global fan-out; retain-queue retry incl. cap;
dormancy). API E2E `tests/e2e/hindsight-external.spec.ts` with the stub: configure
externalUrl via the config route → sessionSetup+beforePrompt blocks appear (trace/prompt
sections), turn_end produces a retain with correct bank+tags; `setHealthy(false)` ⇒ session
unaffected + diagnostic recorded + status route reports unhealthy; stub recovers ⇒ queued
retain flushes.

### G2.3 Tools + panel + entrypoints

**Outcome.** `hindsight_recall` / `hindsight_reflect` / `hindsight_retain` agent tools
(tool group `tools/hindsight/`, `provider: {type: bobbit-extension, extension: extension.ts}`
— copy the `defaults/tools/shell/` + tool-guard auth pattern; tools POST the pack's routes),
each accepting `bank: "current"|"global"|"all"`; native panel
(`panels/hindsight-memory.yaml` + built `lib/HindsightPanel.js`) with status card, mode/URL
settings, memory search, recent retains + queue counter; two entrypoints (command palette +
deep link) — copy `market-packs/pr-walkthrough` shapes.

**Tests.** API E2E: `hindsight_recall` invoked by the mock agent round-trips through the
route to the stub with the resolved bank; per-project pack disable ⇒ tools absent from the
session's tool list. Browser E2E `tests/e2e/ui/hindsight-panel.spec.ts`: open panel via
command palette; configure external URL; status flips to connected (stub); search renders
seeded memories; settings persist across reload.

---

## G3 — Managed runtimes

### G3.1 Runtime manifest + secrets/env/ports (pure, no Docker)

**Outcome.** `runtimes/<id>.yaml` parsing/validation (`RuntimeContribution`: compose path
containment-checked, services, healthcheck, ports `host: auto`, volumes, secrets
`generate|prompt`, `startPolicy: on-enable|on-demand`), loaded via the contributions path
(G1.1 pattern, `contents.runtimes`); secret generation (`crypto.randomBytes(24).toString
("base64url")`, stored via `SecretsStore` under `runtime.<pack>.<id>.<NAME>`, idempotent);
`.env` rendering (0600) under `~/.bobbit/state/pack-runtimes/<pack>/`; host-port allocation
(bind `net.Server` to 0, record, persist in a state JSON, re-validate on load). All pure +
unit-tested; nothing executes Docker.

**Tests.** `tests/runtime-manifest.test.ts` (validation incl. compose-path escape rejection);
`tests/runtime-secrets-env.test.ts` (idempotent generation; env file mode 0600; `${secret:X}`
interpolation); `tests/runtime-ports.test.ts` (allocation, persistence, revalidation when the
recorded port is taken).

### G3.2 PackRuntimeSupervisor + REST (Docker mocked)

**Outcome.** `src/server/runtimes/pack-runtime-supervisor.ts`:
`ensureRuntime(packName, id)` (idempotent, in-flight dedupe — copy `sandbox-manager.ts`),
`start/stop/restart/status/logs`; compose invocation
`docker compose -p bobbit-pack-<pack> -f <pack>/<compose> --env-file <env> up -d` via the
`project-sandbox.ts` execFile discipline (DOCKER_BIN, MSYS env); health = poll declared HTTP
path until `startupTimeoutMs`; status machine
`docker-unavailable|stopped|starting|running|unhealthy`. REST: `GET /api/pack-runtimes`,
`POST /api/pack-runtimes/:id/{start|stop|restart}`, `GET /api/pack-runtimes/:id/logs?tail=`.
Docker binary injectable (constructor `execFileImpl`) so all tests mock it.

**Tests.** `tests/pack-runtime-supervisor.test.ts`: mocked exec walks
stopped→starting→running on health 200; health timeout ⇒ unhealthy; missing docker ⇒
docker-unavailable (exec ENOENT); concurrent `ensureRuntime` ⇒ one compose invocation; stop
issues `compose stop` (not down). API E2E for the three REST routes against the mocked
supervisor.

### G3.3 Wire-up: lifecycle, Hindsight managed mode, consent, manual-integration

**Outcome.** Enable-with-runtime = zero-step Hindsight: pack enable (activation) with
`startPolicy: on-enable` starts the runtime **only from an explicit user action** (the enable
click handler — pinned: no auto-start on boot/install); provider `ctx.runtime` injected
(`{baseUrl: http://127.0.0.1:<port>, headers, status}`) and `managed` mode preferred when
healthy; disable ⇒ `compose stop`; `uninstallPack` (pre-delete seam at the function head,
`marketplace-install.ts::uninstallPack`) ⇒ `compose down`, volumes preserved; explicit purge
flag ⇒ `down -v` + state-dir removal. Hindsight pack gains `runtimes/hindsight.yaml` +
`runtime/compose.yaml` (digest-pinned images; default memory-formation model preconfigured
per design §11). Enable card shows the capability summary line for runtimes (images, ports,
volumes) + the memory disclosure (design §8.4). Manual-integration test
(`tests/manual-integration/hindsight-runtime.test.ts`): real compose up → health →
recall/retain round-trip → disable stops → volume survives `updatePack`.

**Tests.** Unit: keep-vs-purge logic; no-auto-start pin (boot with enabled pack + stopped
runtime ⇒ supervisor not invoked). API E2E (mocked docker): enable → start invoked; disable →
stop; uninstall default keeps volumes (no `-v` in argv), purge adds it. Browser E2E: runtime
status card states + logs view (mocked), enable-card disclosure text present.

---

## G4 — Memory depth *(contract level — re-verify anchors; substrate = G1/G2/G3)*

- **G4.1 beforeCompact ordering.** Pin that the bridge's `session_before_compact` POST
  completes (or times out) BEFORE compaction proceeds, and Hindsight's sync retain lands
  before the compacted span is dropped. Test: stub asserts retain arrives before the mock
  agent emits `compaction_end` (ordering assertion via recorded timestamps).
- **G4.2 Memory browser v2.** Panel: list/filter (session/goal tags) /delete memories via new
  pack routes wrapping `listMemories`/`delete`; retain-queue and operations views. Browser
  E2E: browse/filter/delete survives reload.
- **G4.3 Dual-provider compose.** When both memory providers contribute: stable order
  (hindsight priority > session-memory), near-duplicate suppression (normalized-text overlap
  ≥0.8 ⇒ keep higher-priority block), cost line (memory-formation token estimate) in the
  panel. Unit tests on the dedupe; E2E with both enabled asserting one merged Dynamic Context
  section under the global budget.

## G5 — MCP as pack content *(single goal)*

Lift is already manifest-side (G1.1 accepts `contents.mcp` at schema 2). Add: `mcp/<name>.yaml`
loader (`{name, command|url, args?, env?}` → `McpServerConfig`), a **pack band** in
`mcp-manager.ts::discoverServers` (`:125-170`) inserted at the LOWEST priority position
(packs must never shadow user/project MCP configs — priority below "custom directories");
provenance (`originPackName`) carried into the tool-info summaries; uninstall ⇒ configs gone
on next discovery (registry-driven, no persistence). Consent: capability summary line lists
each server's command/URL (G3.3 card machinery; if G3.3 hasn't merged, add the line to the
install response only). Tests: unit (loader + precedence: same server name in user config and
pack ⇒ user wins); API E2E (pack-shipped stdio MCP fixture server reachable via existing
`mcp_<server>` meta-tool; uninstall removes); browser E2E (provenance badge in tools UI).

## G6 — Hooks + pi-extensions

- **G6.1 hooks entity + dispatcher.** `hooks/<id>.yaml`
  (`{event: SessionStart|UserPromptSubmit|Stop|PreCompact|SessionEnd|PreToolUse|PostToolUse,
  command, timeoutMs?, matcher?}`) + Claude-layout `hooks/hooks.json` accepted as an
  alternative source (one listName per file). Command dispatcher: `execFile` with JSON event
  on stdin, capture stdout JSON; map onto the Hub per design §5.5 (SessionStart/
  UserPromptSubmit stdout `additionalContext` → ContextBlock). Non-tool events only in this
  goal. Tests: mapping-table unit; E2E fixture pack hook injects context visible in the tail.
- **G6.2 PreToolUse/PostToolUse.** Generalize the tool-guard long-poll endpoint so hook
  verdicts (`{block, reason}` / input mutation) ride the SAME generated guard extension
  (extend `generateToolGuardExtension` inputs rather than adding a second tool_call
  subscriber). Tests: fixture hook blocks a named tool (E2E); allow-path latency unchanged
  (no hook ⇒ no extra HTTP round-trip — pin by codegen snapshot).
- **G6.3 pi-extensions entity + trust gate.** `pi-extensions/<name>.yaml` → module path;
  appended as `--extension` in `resolveToolActivation` ONLY when the pack has a recorded
  acknowledgment. Trust store: `~/.bobbit/state/pack-trust.json`
  (`{packName, scope, acknowledgedAt, capabilities}`); default-deny; Market UI acknowledgment
  flow + revoke. Hooks (G6.1) consume the same gate. Tests: default-deny pin (un-acked pack
  contributes nothing); ack → extension in spawn args (inspect `plan.bridgeOptions.args` via
  a unit on the pipeline step); browser E2E ack + revoke across reload.

## G7 — Claude plugin adapter

- **G7.1 Detect + browse.** Source sync detects `.claude-plugin/marketplace.json`; source row
  gains `format`; browse lists plugins (name/description/version from each `plugin.json`).
- **G7.2 Convert + skipped report.** `claude-plugin-adapter.ts` invoked inside `installPack`
  between staging copy and `writeMeta`/rename (seam at `marketplace-install.ts:514-529`):
  conversion table per design §9 (`commands/`→skills commands-flat, `skills/`→skills,
  `agents/*.md`→roles, `hooks/hooks.json`→hooks, `.mcp.json`→mcp, `${CLAUDE_PLUGIN_ROOT}`
  rewrite, synthesized `pack.yaml schema: 2`); returns `skipped: [{feature, reason}]`
  embedded in the install response and `.pack-meta.yaml` (`sourceFormat: claude-plugin`).
  Tests: fixture plugin repo → converted pack resolves skills/roles through the normal
  cascade; every unsupported feature in the fixture appears in `skipped`; nothing silently
  dropped (fixture includes a statusline + an unsupported MCP transport).
- **G7.3 UI + real-marketplace E2E.** Source-format badge; skipped report rendered
  post-install; browser E2E installs a pinned-commit public Claude marketplace plugin and its
  slash command appears in the composer.

## G8 — Capabilities + selectors

- **G8.1 Registry.** `provides`/`requires` (already parsed in G1.1) → capability index in the
  contribution registry (a capability implementation = a named pack route or provider member
  declared `capability: <name>` in its yaml); `ctx.capabilities.call(name, input)` available
  to providers and pack routes — host resolves by pack precedence, dispatches on the worker
  tier with a 5s default timeout, records to the trace. Install-time check: missing required
  capability ⇒ warning in install response + Market UI hint. Tests: precedence; missing-dep
  warning; call round-trip provider→capability across two fixture packs; timeout isolation.
- **G8.2 Decision points + proposals + policy.** Hub gains `beforeGoalCreate` /
  `beforeSessionSpawn` dispatch points wired into goal-creation and session-spawn paths
  (locate via `rg "createGoal|createSession" src/server` and insert PRE-validation, never
  post). Selector providers (`kind: selector`) receive typed summaries (roles via
  `RoleManager.listRoles`, workflows via `WorkflowManager`, skills catalog, MCP servers,
  models via `model-registry`) and return the `SelectorProposal` shape (design §12) —
  schema-validated; invalid ⇒ dropped + diagnostic. Approval policy module
  (`selector-policy.ts`, pure, fully unit-tested): auto-apply iff pre-session ∧ no tool-grant
  expansion vs the default role ∧ model available ∧ persona patch additive-and-bounded
  (≤1200 chars, append-only) ∧ confidence ≥ 0.75; else `requiresApproval`. Application goes
  through existing stores ONLY (role assignment, workflow selection APIs). Tests: policy
  truth-table unit (every clause has a RED case); E2E fixture selector auto-applies a safe
  role and flags an unsafe one.
- **G8.3 Proposal UI + fixture pack.** Goal-creation UI surfaces the proposal
  (accept/decline, reason shown); decline ⇒ deterministic defaults. Browser E2E both paths.

## G9 — Workflow templates + flagship packs

- **G9.1 workflows entity.** `workflows/<id>.yaml` (same gate schema `workflow-validator`
  validates today) loaded as TEMPLATES into the registry; instantiation API
  (`POST /api/projects/:id/workflows/instantiate {packName, templateId}`) copies through
  `WorkflowManager.createWorkflow` (validation reused; collision ⇒ suffix `-2`); goal-creation
  UI offers templates alongside project workflows. Project.yaml remains the only source of
  truth; goal snapshotting untouched (pin: instantiate → mutate template pack → existing goal
  unchanged). Tests: loader/validation reuse; instantiation E2E; snapshot-immunity pin.
- **G9.2 model-selector pack.** `provides: [model-selector]`; route implementing
  `{task, spec?, candidates, constraints?} → {model, thinkingLevel?, reason}` with a
  deterministic rule table first (cost/capability tiers from `model-registry` data) and an
  optional LLM refinement behind config (strict JSON, timeout, fallback to the table). Tests:
  rule-table unit; capability call E2E.
- **G9.3 multi-model-delivery pack.** Roles (`planner` frontier+xhigh, `implementer` cheap
  precise, `qa`, `reviewer` — each promptTemplate carries the initial-spec handoff stanza),
  workflow template plan→implement→qa→review with a ralph-loop verify step (re-run until
  green, bounded iterations), `requires: [model-selector]`. Tests: instantiation E2E; goal
  snapshot carries per-gate roles with pinned models; selector swap path (capability mocked).

---

## 2. Verification matrix (run per goal; full sweep before each parent-goal close)

| Check | Command |
|---|---|
| Types | `npm run check` |
| Unit phase | `npm run test:unit` |
| E2E phase | `npm run test:e2e` |
| Real Docker (G3.3, G4 managed paths only) | `npm run test:manual` |
| Pack builds | `node scripts/build-market-packs.mjs && node scripts/copy-builtin-packs.mjs` (then re-run e2e) |
| No quarantines added | `rg "test.skip|fixme" tests/ --new-only` vs base |

Parent-goal close-out additionally requires: the phase's acceptance criteria in
[extension-platform.md §13](extension-platform.md) all demonstrably true, and a short
goal-report noting any anchor drift corrected (so later goals inherit fresh anchors).
