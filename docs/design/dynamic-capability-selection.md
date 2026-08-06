# EP-10 — Dynamic Capability Selection

**Status:** design record. **Depends on:** EP-6 exact decide grants and EP-9's adopted skill/MCP composition. **Scope:** session-start selection of existing skills and MCP meta-tools. It does not create assets, change installation/adoption, change role or group policy, or add `selectTools`.

## Decision

Run two bounded selector stages while creating a session:

1. `selectSkills` resolves first and produces the session's optional slash-skill set.
2. `selectMcp` resolves second, after the skill set is fixed, and produces the session's optional MCP meta-tool set.

Each stage accepts only active, installed, policy-permitted candidates constructed by core. A hook can narrow the optional surface; it cannot name a new asset, reactivate a disabled asset, override an existing denial, or broaden `computeEffectiveAllowedTools()`. The resulting sets are immutable session state and are persisted before spawn. Restore, respawn, and prompt reconstruction reuse the snapshot rather than rerunning selectors.

The chosen integration point is the existing session setup pipeline, not a new resolver or runtime:

```text
resolveGoalExtensions
  → resolveDynamicCapabilities (selectSkills, then selectMcp)
  → resolveTools / resolvePrompt / resolveToolActivation
  → existing skill resolution and MCP proxy activation
```

`resolveDynamicCapabilities()` must run before `resolveTools()` because MCP activation consumes its final filtered tool list, and before `resolvePrompt()` because the skills catalogue consumes its final filtered skill list. The existing `resolveDynamicContext()` lifecycle dispatch remains unchanged; it is too late in the current pipeline (`resolveTools → resolveDynamicContext → resolvePrompt → resolveToolActivation`) to select startup capabilities.

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
```

A selector is eligible only when its declared hook is active in `PackContributionRegistry.list(projectId)`, has `mode: "decide"`, declares the relevant entry in `selectors`, declares `sessionSetup`, and passes `resolveExtensionGrant(..., "decide")` immediately before invocation. The same active-registry and fresh-grant fence is repeated after the module returns. Thus an inactive, shadowed, ungranted, or revoked selector is never imported, and a late proposal cannot apply after revocation.

`CapabilityProposal` is strictly validated in a new pure `dynamic-capability-contract.ts`:

- exact keys only: `add`, optional `omit`, `reason`, and `confidence`;
- `add`/`omit` are arrays of 1–128 safe identifiers, de-duplicated in lexical order; overlap resolves to `omit`;
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

The selected MCP ids are then an additional filter on that `EffectiveTool[]` result. They are passed unchanged into the existing `writeMcpProxyExtensions()` and `computeToolActivationArgs()` path. `mcp_describe` remains available only when at least one selected MCP meta-tool survives its existing policy check. Selector output never calls `McpManager.connectServer()`, changes `selectedOperations`, writes a role policy, or inserts a non-MCP tool into the effective tool list.

### Fallback and deterministic winner

Core capabilities remain mandatory. Optional dynamic capabilities start empty: a valid winner's admitted `add` ids form the optional set; `omit` removes only ids in that optional set. It cannot remove core tools, the `activate_skill` tool itself, mandatory prompt sections, or an already hard-denied item. With no eligible or valid proposal, the optional set is empty. This is the intentional context reduction relative to today's always-on skills catalogue and MCP proxy surface.

Each stage evaluates eligible hooks independently. For a stage, reduce valid proposals deterministically by:

1. higher `confidence`;
2. higher active project `pack_order` precedence from the registry's stable low-to-high list;
3. lexical `packId`, then lexical `hookId`.

Only the winning proposal changes that stage's optional set. All losing proposals are recorded as superseded. Promise completion order, object insertion order, clock time, and selector reason text are not inputs. `selectMcp` receives the persisted-in-memory result of `selectSkills`, not an independently recomputed list, and does not begin until every skill selector has settled or been isolated.

## State, persistence, and cache contracts

Add a normalized additive field to both live `SessionInfo` and `PersistedSession` in `session-manager.ts` / `session-store.ts`:

```ts
interface DynamicCapabilitySelection {
  version: 1;
  queryFingerprint: string;       // SHA-256 of the bounded query, never query prose
  skills: readonly string[];      // sorted selected optional skill ids
  mcp: readonly string[];         // sorted selected optional MCP meta-tool ids
  skillsFingerprint: string;      // SHA-256 of the sorted eligible skill ids
  mcpFingerprint: string;         // SHA-256 of the sorted policy-permitted MCP ids
  selectionFingerprint: string;   // SHA-256 of canonical version + all fields above
}
```

Persist this field in the same pre-spawn session-store write that persists the setup plan, and retain it in `persistSessionMetadata()`. Validate all ids/fingerprints on read; malformed legacy data normalizes to `undefined`, which means the compatibility path with no optional dynamic capabilities. Do not persist candidate descriptions, skill content/path, MCP config, hook reason, selector output body, or credentials.

The snapshot is write-once. A session restore, force-abort respawn, prompt-section reconstruction, tool activation rebuild, and `/activate-skill` request must use it. They must not rerun a hook merely because a TTL cache expired, pack configuration changed, or a server reconnects. A currently missing snapshot id fails closed at the runtime fence described above; it must not cause a new selection.

The following cache boundaries are mandatory:

| Owner | Required key/input |
|---|---|
| `discoverSlashSkills()` | Remains global discovery only. Apply selection after discovery; do not add `sessionId` to `_cache`. |
| `PromptParts` / prompt-section persistence | `selectionFingerprint` and the selected skills list, so a restored session cannot receive another session's catalogue. |
| MCP proxy/generated activation artifacts | Final filtered `EffectiveTool[]` names plus `selectionFingerprint`; no artifact generated for an all-MCP session may be reused by a narrowed one. |
| Any dynamic selector memoization | Project id, session id, `queryFingerprint`, candidate fingerprint, active-hook/grant revision, selector stage, and selection-contract version. Memoization is optional; persisted session state is authoritative. |

Grant revocation and asset/config invalidation must clear only derived selector eligibility/memoization caches through the existing `invalidateResolverCaches()` path. They do not rewrite an existing session snapshot. Each use still rechecks the relevant active/policy ceiling.

## Observability and failure isolation

Extend `ContextTraceStore` additively with a sanitized dynamic-capability outcome projection. It records one row per eligible selector and one core stage-summary row:

```ts
interface TraceCapabilitySelectionRow extends TraceOutcomeRow {
  kind: "audit";
  capability: "skills" | "mcp";
  selectionFingerprint: string;
  requestedAddCount: number;
  admittedAddCount: number;
  omittedCount: number;
  droppedUnknownOrForbiddenCount: number;
}
```

The trace permits only fixed states/reasons (`applied`, `superseded`, `denied`, `dropped`, `error`; `Grant required`, `Unavailable value`, `Malformed result`, `Timed out`, and a new fixed `Unknown or forbidden id`). It records hook identity, stage, duration, counts, and the opaque selection fingerprint—not query text, proposal reason, candidate lists, paths, content, transport values, or an individual denied id. Extend the Context inspector's existing activity projection to label the two stages and expose counts/fingerprint for reproducibility.

Emit a structured server metric/log per stage with `sessionId`, project-safe ids, candidate count, selected count, selector count, elapsed milliseconds, and context bytes saved. `contextBytesSaved` is computed as the UTF-8 byte size of the baseline all-eligible skills catalogue/tool-doc sections minus the selected rendered sections, clamped at zero. It is an observation, not a selection input. Aggregate this metric beside existing prompt/context observability to demonstrate reduction against always-on loading.

Failures are isolated at the smallest safe boundary:

- a registry/grant lookup, one module timeout/throw, malformed proposal, trace append, or one unavailable skill/MCP asset cannot fail session creation or suppress another selector;
- stage two runs after stage one has settled even if every skill selector failed; it receives the safe empty skills fallback;
- a trace/metric observer failure is swallowed after best-effort logging and never changes persisted selection;
- a persistence failure before spawn fails session setup rather than spawning an unreproducible dynamically-configured session.

## File-level implementation plan

| Artifact | Change |
|---|---|
| `src/server/agent/pack-contributions.ts` | Parse/validate optional `selectors` metadata while retaining schema 2 and all existing hook fields. |
| `src/server/agent/dynamic-capability-contract.ts` | Add pure proposal validation, candidate normalization, deterministic reduction, snapshot normalization/fingerprinting, and session-local filter helpers. |
| `src/server/agent/dynamic-capability-selector.ts` | Add the bounded two-stage runner using `PackContributionRegistry`, `ModuleHost`, fresh `resolveExtensionGrant()` fences, and existing trace owner. |
| `src/server/agent/session-setup.ts` | Add `resolveDynamicCapabilities(plan, ctx)` between `resolveGoalExtensions` and `resolveTools`; carry the immutable selection on `SessionSetupPlan`. |
| `src/server/agent/session-store.ts`, `session-manager.ts` | Persist/recover the normalized snapshot; use it for catalogue, prompt rebuild, and respawn paths. |
| `src/server/skills/resolve-skill-expansions.ts`, `slash-skills.ts` | Accept an optional session-local allowed-name filter after ordinary discovery; do not change discovery precedence/cache ownership. |
| `src/server/server.ts` | Enforce the same persisted skill filter in the activation endpoint; wire selector dependencies beside the existing lifecycle/decision wiring. |
| `src/server/agent/tool-activation.ts` | Accept only the already-filtered `EffectiveTool[]`; preserve `computeEffectiveAllowedTools()` as the policy ceiling and update generated-artifact cache inputs. |
| `src/server/agent/context-trace-store.ts` and Context UI projection | Add sanitized dynamic rows and stage/count display. |

No new REST mutation route, pack installer, adoption record, permission engine, generic selector runtime, or dynamic tool-selection surface is introduced.

## Verification plan

Add registered `tests2/` coverage for:

1. **Order and reproducibility:** skill selectors complete before MCP selectors start; MCP sees the chosen skills; same query/candidates/hooks yields byte-identical snapshot and proxy/catalogue output despite reversed promise completion order; restart/respawn uses the persisted snapshot without invoking selectors.
2. **Ceilings:** inactive, shadowed, ungranted, revoked, unknown, disabled, adopted-but-disabled, and role/group `never` candidates are absent or dropped; a selector cannot add a YAML tool, raw MCP server, disabled skill, or an operation excluded by the adopted-MCP allow-list. `computeEffectiveAllowedTools()` never gains an entry.
3. **Determinism:** confidence, pack precedence, and stable ids break ties as specified; duplicate/overlapping add/omit arrays normalize deterministically; only optional selections are omitted.
4. **Cache keys:** a narrowed session cannot reuse an always-on prompt/proxy artifact; a slash discovery cache result is not mutated by a second session; config/grant invalidation cannot rerun or rewrite an existing selection.
5. **Failure isolation:** timeout, throw, missing selector export, malformed output, unavailable asset, trace observer failure, and one selector failure leave safe fallback state and allow independent hooks/stage two/session creation to continue. Pre-spawn snapshot persistence failure prevents spawn.
6. **Observability and reduction:** Context contains only sanitized stage metadata; no query/reason/content/path/transport secret appears; baseline-versus-selected byte accounting is correct and non-negative.
7. **Browser journey:** create a session with fixture selectors, verify only selected optional skills/MCP meta-tools are advertised and callable, reload/restore for the same surface, and verify a forbidden selector id never appears.

Focused commands after implementation:

```bash
npm run check
npx vitest run tests2/core/dynamic-capability-contract.test.ts tests2/core/dynamic-capability-selector.test.ts tests2/integration/dynamic-capability-selection.test.ts
npm run test:unit
npm run test:browser
```
