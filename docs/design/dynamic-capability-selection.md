# EP-10 — Dynamic Capability Selection

**Status:** design record. **Depends on:** EP-6 exact decide grants and EP-9's adopted skill/MCP composition. **Scope:** session-start selection of existing skills and MCP meta-tools. It does not create assets, change installation/adoption, change role or group policy, or add `selectTools`.

## Decision

Run two bounded selector stages while creating a session:

1. `selectSkills` resolves first and produces the session's optional slash-skill set.
2. `selectMcp` resolves second, after the skill set is fixed, and produces the session's optional MCP meta-tool set.

Each stage accepts only active, installed, policy-permitted candidates constructed by core. A hook can narrow the optional surface; it cannot name a new asset, reactivate a disabled asset, override an existing denial, or broaden `computeEffectiveAllowedTools()`.

A stage becomes authoritative only when a valid, still-authorized selector proposal wins it. An authoritative empty `add` list deliberately removes that stage's optional surface. If neither stage is authoritative—for example, because there are no eligible selectors, a selector fails, or every selector loses its grant—the session keeps the pre-EP-10 unrestricted optional surface and no dynamic snapshot is written. This preserves compatibility while ensuring an explicit selection, including an explicit empty one, is a durable ceiling. A snapshot with either authoritative stage is immutable session state and is persisted before spawn; restore, respawn, and prompt reconstruction reuse it rather than rerunning selectors.

The chosen integration point is the existing session setup pipeline and decision-hook execution path, not a new resolver or runtime:

```text
resolveGoalExtensions
  → resolveDynamicCapabilities (LifecycleHub → DecisionHookDispatcher:
       selectSkills, then selectMcp)
  → resolveTools / resolvePrompt / resolveToolActivation
  → existing skill resolution and MCP proxy activation
```

`resolveDynamicCapabilities()` must run before `resolveTools()` because MCP activation consumes its final filtered tool list, and before `resolvePrompt()` because the skills catalogue consumes its final filtered skill list. The existing `resolveDynamicContext()` lifecycle dispatch remains unchanged; it is too late in the current pipeline (`resolveTools → resolveDynamicContext → resolvePrompt → resolveToolActivation`) to select startup capabilities.

## Alternatives and minimum composition

Both approaches below meet the same contract: ordered `selectSkills` then `selectMcp`, exact active/granted hooks, policy-ceiling candidate lists, deterministic reduction, persisted session replay, Context audit, and isolated failure.

| Approach | Control/data flow | Files and state | Failure/test seam | Decision |
|---|---|---|---|---|
| **A. Extend the existing decision path — selected** | `session-setup.ts::resolveDynamicCapabilities` asks `LifecycleHub`; the hub forwards each stage to its already-bound `DecisionHookDispatcher`, which uses its existing active-registry order, `ModuleHost.invoke`, and pre/post `resolveExtensionGrant()` fences. Core then filters the pre-existing skill/MCP outputs. | One pure contract/fingerprint helper; additive selector metadata, lifecycle forwarding method, session snapshot, and safe trace projection. No second registry, host, grant cache, manager, REST route, or scheduler. The server wiring remains in `src/server.ts`, where the dispatcher is already constructed and bound with `setDecisionDispatcher()`. | Existing `DecisionHookDispatcher` fakes pin invocation order, grants, module failure, and tie reduction; `LifecycleHub` tests pin forwarding; session setup tests pin ordering before tool/prompt creation; `ContextTraceStore` and Context-controller fixtures pin redaction. | **Chosen.** It adds only behavior-specific validation/state while retaining the established authorization and worker isolation owners. |
| **B. Add a standalone `DynamicCapabilitySelector` runtime — rejected** | Session setup directly constructs a new selector that independently enumerates hooks, imports modules, checks grants, reduces proposals, and appends trace rows. | A second executor must hold registry/module-host/grant/trace dependencies and mirror project priority, timeout, revocation, cache invalidation, and diagnostics. Even if it persists the same session snapshot, it is a parallel dispatcher. | It needs duplicate fixtures for every authorization/timeout/order behavior and can diverge from `DecisionHookDispatcher` when EP-6 changes grant rules or lifecycle execution changes. | Rejected: more defect surface without a distinct lifecycle, security boundary, or product capability. |

Approach A is the smallest robust composition. It deliberately reuses `LifecycleHub` only as the existing session-owned forwarding boundary and `DecisionHookDispatcher` only as the existing hook executor; neither gains an asset loader, policy owner, durable store, or generic capability API. The new pure helper remains necessary because the existing decision-selection contract admits model/thinking/role/workflow values, not bounded arrays of capability ids or replay fingerprints.

### Defect-surface inventory

Every addition is constrained to a distinct existing owner:

| Addition | Why it is needed | Owner and containment |
|---|---|---|
| `HookContribution.selectors` parsing branch | Avoid importing every decide hook to probe for optional exports. | `pack-contributions.ts`; schema remains 2 and inactive declarations still never execute. |
| `dynamic-capability-contract.ts` | Validate untrusted add/omit arrays, canonicalize ids, reduce deterministically, and hash a replayable snapshot. | Pure module only; no I/O, cache, dependency, or retained state. |
| `LifecycleHub.selectCapabilities()` / `DecisionLifecycleDispatcher.selectCapabilities()` branch | Reach the pre-existing registry, module host, exact-grant fences, and trace path from session setup. | Existing transient dispatcher reference; no new service, lifecycle loop, or state owner. |
| `SessionSetupPlan.dynamicCapabilities` and persisted `DynamicCapabilitySelection` | Pin the exact selected ids across spawn, restart, rebuild, and respawn. | Existing session plan/session store; write-once normalized data, not a project configuration record. |
| Session-local skill/MCP filtering branch | Apply the pinned optional set after existing discovery/policy resolution. | Existing `computeSkillsCatalog`, `resolveSkillExpansions`, activation endpoint, and tool activation inputs; never mutates global discovery/policy results. |
| Additive trace fields and UI projection | Show safe selection/reduction outcomes and context savings. | `ContextTraceStore` sanitizes durable rows; `src/app/context-trace.ts` independently allow-lists REST data; `ContextTraceInspector.ts` renders only that safe projection. |
| Cache-key input | Prevent an MCP proxy artifact for one selected surface being reused for another. | Existing proxy-artifact cache keys gain `selectionFingerprint`; session prompt reconstruction reads its own persisted filter. No new cache owner. |

There are no new external dependencies, public mutation APIs, REST resources, databases, background workers, permission engines, or generic selector abstractions. In particular, `computeEffectiveAllowedTools()` remains the policy owner and is never modified to accept selector output.

## Hook contract

Keep hook schema version 2. Add optional selector metadata to the existing normalized `HookContribution`; this is metadata on the existing declared hook, not a new loader or a generic dispatcher:

```ts
// src/server/agent/pack-contributions.ts
interface HookContribution {
  // Existing fields unchanged.
  selectors?: readonly ("skills" | "mcp")[];
}

interface CapabilityProposal {
  add: string[];
  omit?: string[];
  reason: string;
  confidence: number;
}

interface CapabilitySelectionContext {
  readonly event: "sessionSetup";
  readonly sessionId: string;
  readonly projectId?: string;
  readonly goalId?: string;
  readonly roleName?: string;
  readonly cwd: string;
  /** Bounded snapshot of the setup query/instructions; never mutable session state. */
  readonly query: string;
  /** Core-built, sorted, identifier-only candidates for this stage. */
  readonly available: readonly string[];
  /** Present only in selectMcp; it is the already-fixed selected skill ids. */
  readonly selectedSkills?: readonly string[];
}

interface CapabilitySelectorModule {
  selectSkills?(ctx: CapabilitySelectionContext): Promise<CapabilityProposal | null | undefined> | CapabilityProposal | null | undefined;
  selectMcp?(ctx: CapabilitySelectionContext): Promise<CapabilityProposal | null | undefined> | CapabilityProposal | null | undefined;
}

export type CapabilitySelectorStage = "skills" | "mcp";
export interface CapabilityStageResult {
  readonly selected: readonly string[];
  /** True only when a valid, still-authorized proposal won this stage. */
  readonly authoritative: boolean;
  readonly outcomes: readonly TraceOutcomeRow[];
}

// Additive to the existing interface in lifecycle-hub.ts; dispatch() is unchanged.
export interface DecisionLifecycleDispatcher {
  selectCapabilities(
    stage: CapabilitySelectorStage,
    context: CapabilitySelectionContext,
  ): Promise<CapabilityStageResult>;
}

// Additive public shape implemented by LifecycleHub. It forwards only to its
// already-bound dispatcher; absence returns the frozen empty result.
interface DynamicCapabilityLifecycleHub {
  selectCapabilities(
    stage: CapabilitySelectorStage,
    context: CapabilitySelectionContext,
  ): Promise<CapabilityStageResult>;
}
```

`DecisionHookDispatcher.selectCapabilities()` owns active-hook enumeration, `ModuleHost.invoke`, the two fresh grant fences, per-hook failure isolation, and production of sanitized outcomes. It calls the pure contract reducer with its server-derived `(packId, hookId, priority)` provenance; it never trusts hook-supplied identity or precedence. `session-setup.ts` owns only ordered invocation and assigning the returned ids to `plan.dynamicCapabilities`.

A selector is eligible only when its declared hook is active in `PackContributionRegistry.list(projectId)`, has `mode: "decide"`, declares the relevant entry in `selectors`, declares `sessionSetup`, and passes `resolveExtensionGrant(..., "decide")` immediately before invocation. The same active-registry and fresh-grant fence is repeated after the module returns. Thus an inactive, shadowed, ungranted, or revoked selector is never imported, and a late proposal cannot apply after revocation.

`CapabilityProposal` is strictly validated in a new pure `dynamic-capability-contract.ts`:

- exact keys only: `add`, optional `omit`, `reason`, and `confidence`;
- `add`/`omit` are arrays of 0–128 safe identifiers, de-duplicated in lexical order; overlap resolves to `omit`. An empty `add` is valid and is authoritative when its valid, still-authorized proposal wins;
- `confidence` is a finite number in `[0, 1]`; `reason` is bounded safe diagnostic text and is never persisted in Context trace or session state;
- malformed output drops that selector's proposal. It never changes the fallback set.

The selector input is a frozen, bounded copy. `query` is the setup instruction text capped at 8 KiB; absent instructions become `""`. Candidate identifiers are sorted before invocation. Core supplies no paths, full skill bodies, MCP transport configuration, credentials, policy details, or mutable plan/session object.

## Candidate ceilings and reduction

### Skill candidates

`SessionManager` builds the candidate list through the existing `discoverSlashSkills()` composition, including its `SkillMarketContext`, pack-activation filtering, adopted-skill entries, and precedence resolution. A skill is selectable only when it is already user-invocable, model-invocable (`disableModelInvocation !== true`), and has a non-empty description—the same current catalogue eligibility rule. Its public slash name is the candidate id, including EP-9's namespaced `adopt-<id>--<name>` form.

The selector does not parse files, scan a new directory, or read a shadowed entry. After selection, the names are applied as a session-local filter *after* `discoverSlashSkills()`, so its global five-second discovery cache is never keyed by a session id or polluted with another session's result. The filter is consumed by:

- `SessionManager.computeSkillsCatalog()` before `PromptParts.skillsCatalog` is assigned;
- `resolveSkillExpansions()` before it expands an optional slash skill; and
- `POST /api/sessions/:id/activate-skill` before it builds an activation result.

A selected skill which has disappeared after restart remains in the snapshot but is unavailable at each of these fences. It is not rediscovered or replaced by a similarly named lower-precedence skill.

### MCP candidates

MCP candidate ids are the existing model-facing meta-tool names (`mcp_<server>` or `mcp_<server>__<sub>`), never a transport name, raw server key, or individual operation. Core first calls the unchanged `computeEffectiveAllowedTools(toolManager, role, groupPolicyStore, mcpManager, scope)` and takes only its MCP entries. This makes the existing role/group/tool policy, adopted-operation allow-list, disabled-tool metadata, and manual-over-marketplace precedence a hard ceiling.

The selected MCP ids are then an additional filter on that `EffectiveTool[]` result. They are passed unchanged into the existing `writeMcpProxyExtensions()` and `computeToolActivationArgs()` path. `mcp_describe` is a YAML-backed discovery tool, not an MCP meta-tool, so it is outside `selectMcp` and retains its ordinary role/group-policy availability. An authoritative-empty MCP selection removes only MCP meta-tools; it does not remove YAML tools, including `mcp_describe`. Selector output never calls `McpManager.connectServer()`, changes `selectedOperations`, writes a role policy, or inserts a non-MCP tool into the effective tool list.

### Fallback and deterministic winner

Core capabilities remain mandatory. When a stage is authoritative, its optional dynamic set starts empty: a valid winner's admitted `add` ids form the set, and `omit` removes only ids in that set. It cannot remove core tools, the `activate_skill` tool itself, mandatory prompt sections, or an already hard-denied item. With no eligible or valid proposal, that stage remains non-authoritative and keeps the legacy surface. Context reduction applies only to authoritative stages.

Each stage evaluates eligible hooks independently. For a stage, reduce valid proposals deterministically by:

1. higher `confidence`;
2. higher active project `pack_order` precedence from the registry's stable low-to-high list;
3. lexical `packId`, then lexical `hookId`.

Only the winning proposal makes that stage authoritative and changes its optional set. A valid winner whose admitted `add` list is empty is still authoritative and deliberately suppresses all optional capabilities in that stage. Failed, denied, malformed, timed-out, or otherwise non-winning stages retain their legacy surface. All losing proposals are recorded as superseded. Promise completion order, object insertion order, clock time, and selector reason text are not inputs. `selectMcp` receives the fixed in-memory result of `selectSkills`, not an independently recomputed list, and does not begin until every skill selector has settled or been isolated.

## State, persistence, and cache contracts

Add a normalized additive field to both live `SessionInfo` and `PersistedSession` in `session-manager.ts` / `session-store.ts`:

```ts
interface DynamicCapabilitySelection {
  version: 1;
  queryFingerprint: string;       // SHA-256 of the bounded query, never query prose
  skillsAuthoritative: boolean;   // whether this stage narrows the skill surface
  skills: readonly string[];      // sorted selected optional skill ids
  mcpAuthoritative: boolean;      // whether this stage narrows the MCP surface
  mcp: readonly string[];         // sorted selected optional MCP meta-tool ids
  skillsFingerprint: string;      // SHA-256 of version + stage + authority + selected ids
  mcpFingerprint: string;         // SHA-256 of version + stage + authority + selected ids
  selectionFingerprint: string;   // SHA-256 of query fingerprint + both stage states
}
```

Persist this field in the same pre-spawn session-store write that persists the setup plan, and retain it in `persistSessionMetadata()`, but only when at least one stage is authoritative. Validate all ids, authority flags, and fingerprints on read; malformed legacy data normalizes to `undefined`, which means the compatible unrestricted path. Do not persist candidate descriptions, skill content/path, MCP config, hook reason, selector output body, or credentials.

The snapshot is write-once. A session restore, force-abort respawn, prompt-section reconstruction, tool activation rebuild, and `/activate-skill` request must use its authoritative stage filters. They must not rerun a hook merely because a TTL cache expired, pack configuration changed, or a server reconnects. A currently missing selected id fails closed at the runtime fence; it must not cause a new selection. A non-authoritative stage in an otherwise-present snapshot continues to use its legacy surface.

The following cache boundaries are mandatory:

| Owner | Required key/input |
|---|---|
| `discoverSlashSkills()` | Remains global discovery only. Apply selection after discovery; do not add `sessionId` to `_cache`. |
| Skill catalogue and slash expansion | The persisted authoritative skills list is applied after ordinary discovery. Prompt reconstruction reads the session snapshot rather than invoking selectors again. |
| MCP proxy/generated activation artifacts | Final filtered `EffectiveTool[]` names plus `selectionFingerprint`; no artifact generated for an all-MCP session may be reused by a narrowed one. |
| Any dynamic selector memoization | Project id, session id, `queryFingerprint`, candidate fingerprint, active-hook/grant revision, selector stage, and selection-contract version. Memoization is optional; persisted session state is authoritative. |

Grant revocation and asset/config invalidation must clear only derived selector eligibility/memoization caches through the existing `invalidateResolverCaches()` path. They do not rewrite an existing session snapshot. Each use still rechecks the relevant active/policy ceiling.

## Observability and failure isolation

Extend `ContextTraceStore` additively with a sanitized dynamic-capability outcome projection. It records a row for each eligible selector plus a core stage-summary row. Rows use the existing decision outcome vocabulary: a winning proposal is `advised`, losing proposals are `superseded`, and grant, malformed-result, timeout, and execution failures use the existing fixed denied/dropped/error states and reasons. The core summary is `applied` only for an authoritative stage and `dropped` otherwise.

The safe projection contains only the fixed stage (`skills` or `mcp`), hook identity, duration, opaque selection fingerprint when a snapshot exists, and aggregate `candidateCount`, `selectedCount`, `selectorCount`, and `contextBytesSaved`. It never contains query text, proposal reason, candidate or selected identifiers, paths, content, transport values, raw output, or credentials. Unknown or forbidden ids are silently excluded by the core candidate ceiling; the trace reports only aggregate counts. `src/app/context-trace.ts` allow-lists these fields and `src/ui/components/ContextTraceInspector.ts` renders fixed labels; the existing REST route is unchanged.

The stage telemetry is best effort and never affects setup. `contextBytesSaved` is a non-negative UTF-8 identifier-list estimate: the bytes of the newline-joined candidate ids minus those of selected ids, or zero for a non-authoritative stage. It demonstrates selection reduction without retaining or rendering candidate content. Aggregate this metric beside existing prompt/context observability to demonstrate reduction against always-on loading.

Failures are isolated at the smallest safe boundary:

- a registry/grant lookup, one module timeout/throw, malformed proposal, trace append, or one unavailable skill/MCP asset cannot fail session creation or suppress another selector;
- stage two runs after stage one has settled even if every skill selector failed; it receives the safe empty skills fallback;
- a failed or non-authoritative stage keeps its legacy surface, while an authoritative sibling stage remains pinned;
- a trace/metric observer failure is swallowed after best-effort logging and never changes persisted selection;
- a persistence failure before spawn fails session setup only when a dynamic snapshot exists, rather than spawning an unreproducible dynamically-configured session.

## File-level implementation plan

| Artifact | Change |
|---|---|
| `src/server/agent/pack-contributions.ts` | Parse/validate optional `selectors` metadata while retaining schema 2 and all existing hook fields. |
| `src/server/agent/dynamic-capability-contract.ts` | Add pure proposal validation, candidate normalization, deterministic reduction, snapshot normalization/fingerprinting, and session-local filter helpers. |
| `src/server/agent/decision-request-manager.ts`, `src/server/agent/lifecycle-hub.ts` | Add a narrowly typed `selectCapabilities()` forwarding branch to the existing `DecisionHookDispatcher` / `LifecycleHub`; reuse its active-registry ordering, `ModuleHost`, fresh grant fences, and trace attachment rather than adding a selector runtime. |
| `src/server/agent/session-setup.ts` | Add `resolveDynamicCapabilities(plan, ctx)` between `resolveGoalExtensions` and `resolveTools`; carry the immutable selection on `SessionSetupPlan`. |
| `src/server/agent/session-store.ts`, `session-manager.ts` | Persist/recover the normalized snapshot; use it for catalogue, prompt rebuild, and respawn paths. |
| `src/server/skills/resolve-skill-expansions.ts`, `slash-skills.ts` | Accept an optional session-local allowed-name filter after ordinary discovery; do not change discovery precedence/cache ownership. |
| `src/server.ts` | Enforce the same persisted skill filter in the activation endpoint; retain selector wiring beside the existing lifecycle/decision wiring. |
| `src/server/agent/tool-activation.ts` | Accept only the already-filtered `EffectiveTool[]`; preserve `computeEffectiveAllowedTools()` as the policy ceiling and update generated-artifact cache inputs. |
| `src/server/agent/context-trace-store.ts`, `src/app/context-trace.ts`, `src/ui/components/ContextTraceInspector.ts` | Add sanitized dynamic rows, client allow-list normalization, and fixed stage/count display. |

No new REST mutation route, pack installer, adoption record, permission engine, generic selector runtime, or dynamic tool-selection surface is introduced.

## Verification plan

Add registered `tests2/` coverage for:

1. **Order and reproducibility:** skill selectors complete before MCP selectors start; MCP sees the chosen skills; same query/candidates/hooks yields byte-identical snapshot and proxy/catalogue output despite reversed promise completion order; restart/respawn uses the persisted snapshot without invoking selectors.
2. **Ceilings:** inactive, shadowed, ungranted, revoked, unknown, disabled, adopted-but-disabled, and role/group `never` candidates are absent or dropped; a selector cannot add a YAML tool, raw MCP server, disabled skill, or an operation excluded by the adopted-MCP allow-list. `computeEffectiveAllowedTools()` never gains an entry.
3. **Determinism:** confidence, pack precedence, and stable ids break ties as specified; duplicate/overlapping add/omit arrays normalize deterministically; only optional selections are omitted.
4. **Cache keys:** a narrowed session cannot reuse an always-on MCP proxy artifact; a slash discovery cache result is not mutated by a second session; config/grant invalidation cannot rerun or rewrite an existing selection.
5. **Failure isolation:** timeout, throw, missing selector export, malformed output, unavailable asset, trace observer failure, and one selector failure leave safe fallback state and allow independent hooks/stage two/session creation to continue. Pre-spawn snapshot persistence failure prevents spawn.
6. **Observability and reduction:** Context contains only sanitized stage metadata; no query/reason/content/path/transport secret appears; baseline-versus-selected byte accounting is correct and non-negative.
7. **Browser journey:** create a session with fixture selectors, verify only selected optional skills/MCP meta-tools are advertised and callable, reload/restore for the same surface, and verify a forbidden selector id never appears.

Focused commands after implementation:

```bash
npm run check
npx vitest run tests2/core/dynamic-capability-contract.test.ts tests2/core/decision-hook-dispatcher.test.ts tests2/integration/dynamic-capability-selection.test.ts
npm run test:unit
npm run test:browser
```
