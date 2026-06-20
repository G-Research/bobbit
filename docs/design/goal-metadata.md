# Hierarchical goal metadata

Status: **implemented** (`goal/f6c39aa2/*` off `master`). This document is the
as-built reference; it began as a design and has been reconciled with the
shipped code. Where the implementation chose differently from the original
proposal (the `goalProvisioned` hook shipped here rather than in a separate PR;
the legacy per-goal `worktreeSetupCommand` was removed rather than deferred; the
disabled-tools filter covers unrestricted sessions too), the as-built behaviour
is described and the original intent noted.

Key source: `src/server/agent/goal-metadata.ts` (resolver), `goal-store.ts`
(field + migration), `lifecycle-hub.ts` (`goalProvisioned` + provider
filtering), `session-setup.ts` / `session-manager.ts` / `goal-manager.ts` (edge
wiring + hook dispatch), `tool-activation.ts` (tool filter), `system-prompt.ts`
(section order), `src/app/proposal-helpers.ts` + `proposal-panels.ts` (UI
editor). Unit tests: `tests/goal-metadata*.test.ts`; E2E:
`tests/e2e/goal-metadata-hierarchy.spec.ts`, `tests/e2e/ui/goal-metadata.spec.ts`.

## 1. Problem & tenet

We want to run controlled A/B / experiment variations of a goal (Hindsight on/off,
Graphify on/off, tool sets, prompt-section ordering, LSP, …) **without asymmetry
across the goal/agent hierarchy** and with **minimal core surface**.

A global extension lifecycle hook fires identically for every goal, so
differentiation must come from **per-goal data passed to the hook**, not from the
hook. We generalise that: arbitrary, namespaced, hierarchically-inherited
metadata on the goal that feeds **both** extension lifecycle hooks **and** a small
set of core resolution edges.

**Design tenet — minimal code.** One persisted field + one resolver + reads at
existing seams. No bespoke typed override fields. Treatments are **metadata
conventions** interpreted by their owning consumer (an extension, or a core edge).

**Anti-asymmetry invariant (the point of this work).** For any goal with effective
metadata `M`, *every* session in that goal's tree resolves the same `M` and every
edge honours it: the team lead, every `team_spawn` member, every `team_delegate`
sub-agent, every `llm-review` reviewer, and every nested sub-goal. A treatment can
never leak (e.g. a lead with a tool disabled but its sub-agent getting it back).

## 2. Data model

### 2.1 `PersistedGoal.metadata`

`src/server/agent/goal-store.ts` — add to `PersistedGoal`:

```ts
/**
 * Arbitrary, namespaced per-goal metadata. Hierarchically inherited
 * (resolveGoalMetadata walks parentGoalId, descendant wins). Drives extension
 * goal-lifecycle hooks AND core resolution edges (providers, tools, prompt
 * order). Absent ⇒ byte-identical to legacy behaviour at every edge.
 *
 * Convention: dotted, namespaced keys, e.g.
 *   "graphify.enabled": true
 *   "hindsight.memory.enabled": false
 *   "bobbit.disabledTools": ["browser_navigate"]
 *   "bobbit.disabledProviders": ["memory"]
 *   "bobbit.promptSectionOrder": ["Goal", "Tools", "System Prompt", ...]
 */
metadata?: Record<string, unknown>;
```

### 2.2 Migration

In `GoalStore.load()`: **no backfill.** Absent `metadata` stays `undefined`.
Mirror the existing defensive sweep — drop a persisted `metadata` that is not a
plain object (array or primitive), the same way `inlineRoles` is dropped:

```ts
if (g.metadata !== undefined && (typeof g.metadata !== "object" || Array.isArray(g.metadata))) {
    console.warn(`[goal-store] Dropping malformed metadata on goal ${g.id}`);
    delete g.metadata;
}
```

Restart-safe automatically (it is a `PersistedGoal` field written by `save()`).

### 2.3 Persist at creation only

`createGoal` persists `metadata` when it is a non-empty plain object. We do **not**
snapshot a parent's metadata onto a child at creation — inheritance is resolved
live by the resolver (§3) so a parent edit is reflected in all descendants. (This
intentionally differs from `inlineRoles`, which IS snapshotted.)

## 3. Resolver — the single source of truth

New module `src/server/agent/goal-metadata.ts`. Pure, deterministic, no LLM,
mirrors `ProjectAncestorRegistry.getAncestors` (`config-cascade.ts` §field-level).

```ts
export type GoalMetadata = Record<string, unknown>;

export interface GoalMetadataLookup {
    get(id: string): { parentGoalId?: string; metadata?: GoalMetadata } | undefined;
}

/** Deep-merge ancestors → self (descendant overrides). Objects merge
 *  recursively; arrays and scalars REPLACE wholesale. Bounded to 64 hops with a
 *  cycle guard. Returns a fresh object (never a reference into the store). */
export function resolveGoalMetadata(lookup: GoalMetadataLookup, goalId: string | undefined): GoalMetadata;

/** Pure deep-merge helper (exported for unit tests). */
export function deepMergeMetadata(base: GoalMetadata, override: GoalMetadata): GoalMetadata;
```

### 3.1 Algorithm

1. From `goalId`, walk `parentGoalId` into a chain `[self, parent, …, root]`,
   stopping at a missing ref, a cycle (`seen` set), or
   `GOAL_METADATA_WALK_DEPTH_CAP` (64) hops.
2. Reverse to root-first: `[root, …, parent, self]`.
3. Reduce with `deepMergeMetadata`, left→right, starting from `{}`. Each goal's
   own `metadata ?? {}` is merged on top of the accumulated ancestor metadata.
4. `goalId === undefined` or unknown ⇒ return `{}`.

### 3.2 Deep-merge semantics (pinned by unit tests)

`deepMergeMetadata(base, override)` for each key in `override`:

- both `base[k]` and `override[k]` are **plain objects** → recurse.
- otherwise → `override[k]` wins (this includes **arrays replace wholesale** and
  scalar-over-object / object-over-scalar).

Rationale: a child setting `bobbit.disabledTools: ["X"]` fully replaces the
parent's list (predictable for experiments); a child that omits the key inherits
the parent's list unchanged. Nested objects (e.g. `hindsight.memory`) merge so a
child can flip one sub-key without restating the whole object.

**Immutability.** The resolver returns a fresh object whose arrays and nested
objects are deep-cloned (`cloneValue`), never references into the persisted goal
record. This matters because consumers receive the resolved metadata directly —
without the clone, a consumer that sorts or pushes onto a resolved
`bobbit.disabledTools` array would silently corrupt the stored goal. Pinned by
the `deepMergeMetadata` immutability unit tests.

### 3.3 Wiring (no duplicated lookups)

`GoalStore` already satisfies `GoalMetadataLookup` (`get` + `PersistedGoal`).
Expose ONE accessor on `GoalManager`:

```ts
getEffectiveGoalMetadata(goalId: string | undefined): GoalMetadata {
    return resolveGoalMetadata(this.store, goalId);
}
```

Goals are per-project (each `ProjectContext` owns a `GoalStore`). Every other
edge receives a **closure** wired by `server.ts`, never its own store lookup:

- `PipelineContext.resolveGoalMetadata?: (goalId: string | undefined) => GoalMetadata`
  (session-setup edges).
- `LifecycleHub` constructor dep `goalMetadataResolver?: (goalId, projectId?) => GoalMetadata`
  (provider/bridge + goalProvisioned edges).
- `SessionManager` reuses the hub resolver + its own pipeline ctx wiring.

Resolution cost is trivial (≤64 store reads, bounded by the walk-depth cap, in-memory). No caching needed; if a
hot path needs it, memoise on `(goalStore.getGeneration(), goalId)`.

## 4. Effective goal per session

Every edge computes the effective goal id the SAME way (the existing `stampGoalId`
pattern in `session-manager.ts`):

```ts
const effectiveGoalId = session.goalId ?? session.teamGoalId; // or plan.goalId ?? plan.teamGoalId
```

- **team lead**: `goalId` set → resolves the goal's `M`.
- **`team_spawn` member / `team_delegate` sub-agent / `llm-review` reviewer**:
  `teamGoalId` set → resolves the SAME goal's `M`.
- **nested sub-goal**: its own `goalId`, and the resolver walks `parentGoalId`
  into the parent → inherits.

This is the mechanism that guarantees the anti-asymmetry invariant: there is one
effective-goal computation and one resolver, used at every edge.

## 5. Core edge consumers

All three read the resolver for the session's effective goal and apply per
effective-goal. **Project/global config (`pack_activation`, `provider-config:<id>`,
the cascade) is never mutated.**

### 5.1 Providers / bridge (clean Hindsight disable)

Convention: `bobbit.disabledProviders: string[]` — a list of provider ids
(`ProviderContribution.id`, e.g. `"memory"`) to exclude for this goal's subtree.

`LifecycleHub` (`lifecycle-hub.ts`) gains the injected `goalMetadataResolver` and
derives a disabled-provider set inside the methods that enumerate providers:

- `dispatch(hook, base)` — after `registry.listProviders(base.projectId)`, drop
  providers whose `id` is in `disabledProviders` resolved from `base.goalId`. So
  `sessionSetup` (context blocks), `afterTurn`, `sessionShutdown` all skip a
  disabled provider — no network, no retain.
- `hasProvidersForHooks(projectId, hooks, goalId?)` — add the optional `goalId`;
  apply the same drop before the `.some(...)`. When every turn-hook provider is
  disabled for the goal, this returns `false`.

Bridge-install decision (the two identical call sites):

- `session-setup.ts`: `hasProviderBridgeHooks(ctx.lifecycleHub, plan.projectId, plan.goalId ?? plan.teamGoalId)`.
- `session-manager.ts`: `hasProviderBridgeHooks(this.lifecycleHub, projectId, session.goalId ?? session.teamGoalId)`.

`provider-bridge-extension.ts::hasProviderBridgeHooks(hub, projectId, goalId?)`
forwards `goalId` to `hub.hasProvidersForHooks`. Result: a goal with Hindsight
disabled gets **no bridge extension, no per-turn hook calls, no network** across
the whole subtree (lead, members, sub-agents, reviewers, nested goals).

`dispatch` base MUST carry the effective goal id at every call site:
- `session-setup.ts::resolveDynamicContext` `dispatch("sessionSetup", { …, goalId: plan.goalId ?? plan.teamGoalId })`.
- `session-manager.ts` `afterTurn` / `sessionShutdown` dispatches: `goalId: session.goalId ?? session.teamGoalId`.

### 5.2 Tools

Convention: `bobbit.disabledTools: string[]` — flat tool names (e.g.
`"browser_navigate"`, `"team_delegate"`, or an MCP meta-tool name
`"mcp_playwright"`).

Single application point in `session-setup.ts` step 5 (`activateTools`), BEFORE
`computeToolActivationArgs` / `writeMcpProxyExtensions`, so both the role path
and the assistant path are covered (both write `plan.effectiveAllowedTools`):

```ts
const M = ctx.resolveGoalMetadata?.(plan.goalId ?? plan.teamGoalId) ?? {};
const disabled = asStringArray(M["bobbit.disabledTools"]);
if (disabled.length && plan.effectiveAllowedTools) {
    const drop = new Set(disabled.map(s => s.toLowerCase()));
    plan.effectiveAllowedTools = plan.effectiveAllowedTools.filter(t => !drop.has(t.name.toLowerCase()));
}
```

`computeToolActivationArgs` already emits only `--extension` flags for retained
tools, and `writeMcpProxyExtensions` is fed `flatNames` from the filtered list —
so dropping an entry from `effectiveAllowedTools` removes the tool from the spawn
surface entirely. No change to `tool-activation.ts` policy cascade; the metadata
filter is a thin post-filter layered on top so the policy/cache logic is
untouched. (`asStringArray` is a 3-line guard: array-of-strings or `[]`.)

**Unrestricted / all-tools sessions are covered too (hard invariant).** The
original design left the "all tools" case out of scope; the shipped code closes
it. There are two complementary application points:

1. **Allowlist filter** (`applyDisabledToolsFilter` in `session-setup.ts`):
   filters `plan.effectiveAllowedTools` in place **before** the prompt /
   tool-docs / skills catalogue are assembled, so a disabled tool is never even
   advertised. This step preserves the `undefined` (unrestricted) vs `[]`
   (explicit no-tools) distinction — `undefined` stays `undefined` and is never
   widened, `[]` (a session whose entire allowlist was removed by
   `bobbit.disabledTools`) stays `[]` and never collapses back to all tools.
2. **Activation/proxy/guard builders** (`tool-activation.ts`): the disabled set
   is threaded into `computeToolActivationArgs`, `writeMcpProxyExtensions`, and
   `writeToolGuardExtension`, which drop disabled entries in BOTH the allowlist
   branch AND the unrestricted/all-tools branch (built-in file tools, extension
   tools, and MCP meta-tools alike). The guard extension additionally pins a
   disabled tool's policy to `never` for defense in depth.

So a `bobbit.disabledTools` treatment applies even to a role-less / unrestricted
session — not just role-scoped ones. The set is matched case-insensitively
(names lower-cased on both sides). Empty/absent ⇒ byte-identical to today.

### 5.3 Prompt section order

Convention: `bobbit.promptSectionOrder: string[]` — section **labels** in desired
order. Valid labels (existing, from `system-prompt.ts`): `System Prompt`,
`Project AGENTS.md`, `Working Directory`, `Tools`, `Available Skills`, `Goal`,
`Role`, `Goal Nesting`, `Task`, `Workflow Context`, `Dynamic Context`.

`system-prompt.ts`:

- Add `sectionOrder?: string[]` to `PromptParts`.
- Refactor `_assembleSystemPrompt` to build an ordered list of
  `{ label, content }` entries (it already knows each section's identity; just
  attach the label used by `getPromptSections`) and, when `sectionOrder` is
  present, **stable-reorder**: sections whose label appears in `sectionOrder` are
  emitted in that order first; any section not listed keeps its original relative
  order and is appended after. Then `join("\n\n---\n\n")` exactly as today.
- `getPromptSections` applies the identical reorder so the inspector matches.

Wiring: `session-setup.ts` sets `parts.sectionOrder = asStringArray(M["bobbit.promptSectionOrder"])` (undefined when absent).

**Caching caveat (document, do not prevent).** Reordering moves sections across
the stable-prefix / volatile-tail boundary and will change provider prompt-cache
hit rate. That is a legitimate A/B variable; the doc and the metadata key comment
must call it out so experiment authors know they are also varying cache behaviour.

### 5.4 Backward compatibility at every edge

`resolveGoalMetadata` returns `{}` when metadata is absent ⇒ `disabledProviders`
`[]`, `disabledTools` `[]`, `sectionOrder` `undefined`. Each edge is a guarded
no-op in that case, producing **byte-identical** spawn args, prompt bytes, and
provider dispatch to today. Pinned by the no-metadata unit + E2E tests (§8).

## 6. Extension goal-lifecycle hook

### 6.1 Contract

A lifecycle hook kind `goalProvisioned` (shipped in this work; the original plan
assumed a separate maintainer PR). Unlike the context hooks it does NOT return
context blocks — it is a fire-and-forget filesystem-treatment hook.

- Add `"goalProvisioned"` to `LifecycleHook` (`lifecycle-hub.ts`) and to
  `PROVIDER_HOOKS` (`pack-contributions.ts`) so providers may declare it.
- New hub method (kept separate from `dispatch` because the payload shape and
  the "ignore output" semantics differ):

```ts
async dispatchGoalProvisioned(ctx: {
    goalId: string;
    projectId?: string;
    worktreePath: string;   // the branch container just provisioned
    cwd: string;            // worktree cwd incl. subdir offset
    branch?: string;
    metadata: GoalMetadata; // resolved (effective) metadata
}): Promise<void>;
```

It enumerates `listProviders(projectId)` declaring `goalProvisioned`, drops any
provider whose `id` is in the goal's resolved `bobbit.disabledProviders`, invokes
each via `moduleHost.invoke({ exportKind: "providers", member: "goalProvisioned",
ctx })` with the SAME provider-scoped least-privilege host, swallows/logs errors
(non-fatal — a failing hook must never block goal/session start), and ignores any
return value. Per-provider budget/timeout reuse the provider's `budget.timeoutMs`.
`"goalProvisioned"` is declared in `PROVIDER_HOOKS` (`pack-contributions.ts`) so
providers may list it in their YAML `hooks:`.

**Idempotency is mandatory, not advisory.** The same worktree subtree can be
provisioned by several paths, and respawn/restore paths may re-enter dispatch
sites. Providers MUST therefore be idempotent — re-running on an
already-treated worktree must be a cheap no-op and must never error. Authors
achieve this via a shared content-addressed cache
(the "New Era" pattern): e.g. Graphify writes `graphify-out/` keyed by a content
hash, skipping work when the marker already exists. `graphify-out/` is gitignored
and not branch-propagated, which is exactly why the hook must fire on **every**
worktree (§6.2), not once per goal.

### 6.2 Dispatch points — every worktree provisioning in the subtree

The hook must fire wherever a worktree is materialised, so filesystem treatments
land on every agent/sub-goal worktree (not just the goal's first worktree):

1. **Goal worktree** — `goal-manager.ts::_doSetupWorktree` /
   `_dispatchGoalProvisioned`, after `_provisionGoalWorktree` returns and before
   the `setupStatus:"ready"` flip. This single site covers BOTH cold
   `createWorktree` AND the **pool-claim** path, because both return through
   `_provisionGoalWorktree`. Resolves `getEffectiveGoalMetadata(goal.id)`.
2. **Per-session cold-path worktree** — `session-setup.ts`
   (`dispatchGoalProvisionedHook`), after the cold-path worktree is created and
   component setups run. Fires for `team_spawn` members and `team_delegate`
   sub-agents that create their own sub-branch worktree.
3. **Per-session pool/pre-built worktree** — `session-setup.ts`
   `preBuiltWorktreePath` branch. A pooled session worktree skips component
   setup, so the hook must fire here too, else pooled sessions miss the
   treatment.
4. **Team member worktree** — `team-manager.ts` calls
   `sessionManager.dispatchGoalProvisionedForWorktree(...)` for a freshly created
   member worktree (non-sandboxed members).
5. **Sandboxed worktree** — `session-manager.ts` sandbox wiring dispatches with
   HOST coordinates (see §6.3), because team-manager skips its own dispatch for
   sandboxed members and the session-setup provisioning dispatch never runs for
   container worktrees.

Every site resolves the effective goal's metadata (via the injected resolver) and
calls `dispatchGoalProvisioned`. The hub guards internally: it enumerates only
providers that declare `goalProvisioned`, so a zero-provider install does no
work, and a provider disabled for this goal via `bobbit.disabledProviders` is
skipped.

The hook is **never** dispatched once-per-goal only — that would regress
filesystem treatments for sub-agent and sub-goal worktrees. Because several of
these sites can fire for overlapping worktrees (and respawn/restore can re-enter
them), providers must be idempotent (§6.1).

### 6.3 Sandbox (Docker) worktrees — host-path dispatch

The `goalProvisioned` provider runs **host-side**: `dispatchGoalProvisioned`
executes the provider module on the host with `workingDir: ctx.cwd`. For
sandboxed (Docker) sessions the agent's runtime cwd is remapped to a
container-internal worktree (`/workspace-wt/<branch>`) that lives in a Docker
volume and is **not reachable from the host**. If the hook were handed that
container path, the provider's marker write would silently land nowhere (the
hook is non-fatal), so metadata-driven filesystem treatments would never appear
on sandboxed worktrees.

The fix (`session-manager.ts`, sandbox wiring): capture the **host-side**
working directory BEFORE it is remapped into the container, and dispatch
`goalProvisioned` with those host coordinates (`worktreePath`/`cwd` = host
worktree cwd), not the container path. Only the host-side provider dispatch uses
host coordinates; the agent still boots in the container worktree. Restore /
respawn paths arrive with `bridgeOptions.cwd` already pointing at a
container-internal path (`isSandboxContainerPath`), so dispatch is skipped there
— the worktree was provisioned (and the marker written) on first creation, and
providers are idempotent, so re-dispatch is unnecessary.

### 6.4 Relationship to `worktreeSetupCommand` (superseded)

The bespoke per-goal `worktreeSetupCommand` / `worktreeSetupTimeoutMs` surface
(PR #816) is **removed** by this work — metadata + the `goalProvisioned` hook is
its general replacement. See §6.5 below for the exact removal scope. The
project/component setup-command surface (`components[*].worktree_setup_command`)
is a different mechanism and is **unchanged**.

### 6.5 Supersession of per-goal `worktreeSetupCommand` (PR #816)

What was removed:

- `PersistedGoal.worktreeSetupCommand` / `worktreeSetupTimeoutMs`. `GoalStore`
  drops both on load (legacy goals are migrated transparently) — see
  `goal-store.ts`.
- The goal-route parsing and `createGoal` options/persistence for those fields,
  and the per-goal setup-command runner.
- The `propose_goal` schema fields and the goal-creation UI control + state for
  the per-goal command and timeout.

What is **kept** (do not confuse the two):

- `components[*].worktree_setup_command` (project/component setup commands) and
  the project-proposal field that configures them. This is the canonical,
  unchanged mechanism for per-component worktree setup; posting a legacy per-goal
  `worktreeSetupCommand` to the goal route now has no effect and does not persist.

## 7. Creation surfaces

### 7.1 REST goal route — `server.ts`

In the goal-creation handler (the `POST /api/goals` body parse), parse
`body.metadata`:

```ts
let metadata: Record<string, unknown> | undefined;
if (body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
    && Object.keys(body.metadata).length > 0) {
    metadata = body.metadata as Record<string, unknown>;
}
```

Pass `metadata` into `targetGoalManager.createGoal(title, cwd, { …, metadata })`.

### 7.2 `goal-manager.ts::createGoal`

Add `metadata?: Record<string, unknown>` to the opts type and destructure it.
Persist only a non-empty plain object:

```ts
if (metadata && typeof metadata === "object" && !Array.isArray(metadata)
    && Object.keys(metadata).length > 0) {
    goal.metadata = metadata;
}
```

### 7.3 `propose_goal` — schema + draft

- `propose_goal` tool: add optional `metadata` (object) to the input schema.
- Proposal draft frontmatter carries `metadata` (YAML object) — extend the goal
  proposal field set so the draft round-trips it.
- `src/app/proposal-parsers.ts` / proposal-panels initialisation: parse the
  `metadata` object from the proposal and seed the dialog state
  (`_proposalGoalMetadata`).

### 7.4 Metadata value parsing & string preservation (UI editor)

The goal-creation / proposal dialog exposes a simple key/value metadata editor.
Internally it stores ordered `[key, value]` **string** rows for direct `<input>`
round-tripping; the conversion helpers live in `src/app/proposal-helpers.ts` and
are shared by the editor, the submit path, and the proposal-mirror seeding so
every surface converts identically.

- **Rows → object** (`metadataRowsToObject`, at submit): blank keys are dropped;
  each value is JSON-parsed when it parses (numbers, booleans, arrays, objects,
  JSON-quoted strings), otherwise kept as the raw string. Returns `undefined`
  when no usable rows remain, so an empty editor sends **no** `metadata` field
  (empty = no override).
- **Object → rows** (`metadataObjectToRows`, when seeding the editor): each value
  is rendered back to a row string that round-trips losslessly through
  `metadataRowsToObject`.

**JSON-literal-like strings are preserved as strings.** A string value whose text
would itself re-parse as a different JSON type — e.g. `"false"`, `"42"`,
`'["x"]'`, or a whitespace-padded number — is JSON-quoted when rendered into the
editor row (`renderMetadataValue`), so feeding it back through the parser yields
the original *string*, not the boolean/number/array it looks like. A plain string
that already round-trips is shown verbatim; non-strings are `JSON.stringify`-d.
This guarantees the editor never silently coerces a value's type across a
seed → edit → submit cycle. Pinned by the proposal-helpers metadata round-trip
unit tests.

### 7.5 Goal-creation UI dialog

- `src/app/state.ts`: add `previewGoalMetadata?: Record<string, unknown>` (or a
  raw key/value editor model — array of `{ key, value }` rows like the existing
  component config editors).
- `src/app/proposal-panels.ts` `GoalFormConfig`: add a **simple key/value editor**
  (string key → JSON-parsed value; fall back to string when not valid JSON),
  mirroring the `worktreeSetupCommand` control. Empty editor ⇒ no `metadata`
  field forwarded (so empty = no override).
- `src/app/api.ts::createGoal`: add `metadata?: Record<string, unknown>` to opts;
  forward `body.metadata` only when non-empty (mirrors `worktreeSetupCommand`).
- `mirrorGoalSetupFields` / proposal mirror paths (`src/app/session-manager.ts`)
  carry `metadata` through accept so a `propose_goal`-seeded proposal pre-fills
  the editor.

## 8. Test matrix

### 8.1 Unit (node `*.test.ts`, unit phase)

`tests/goal-metadata.test.ts` (new):
- `resolveGoalMetadata` ancestry deep-merge: descendant overrides scalar; child
  array replaces parent array; nested object merges (child flips one sub-key);
  missing parent ref stops cleanly; deep chain (root→A→B→leaf); cycle guard /
  64-hop bound; unknown/`undefined` goalId ⇒ `{}`.
- `deepMergeMetadata` table: object+object recurse, array replace, scalar
  replace, object-over-scalar, scalar-over-object; returns fresh object (input
  not mutated).
- Provider edge filter: given providers `[memory, other]` and
  `bobbit.disabledProviders:["memory"]`, the hub drops `memory` from `dispatch`
  and `hasProvidersForHooks`; absent metadata ⇒ both unchanged.
- Tool edge filter: `effectiveAllowedTools` minus `bobbit.disabledTools`;
  case-insensitive; absent ⇒ identical array.
- `assembleSystemPrompt` honours `sectionOrder` (reordered output) and ignores an
  empty/absent order (byte-identical to baseline); unknown labels are no-ops.

`tests/goal-store.*` (new or extend): migration leaves absent metadata absent;
malformed metadata (array/primitive) dropped on load; round-trips a valid object.

### 8.2 API E2E (`tests/e2e/*.spec.ts`) — anti-asymmetry

One goal with `bobbit.disabledTools:["<X>"]` + `bobbit.disabledProviders:["memory"]`
(Hindsight configured but disabled for this goal):
- team lead, a `team_spawn` member, a `team_delegate` sub-agent, an `llm-review`
  reviewer, and a **nested sub-goal** all lack tool `<X>` and show no Hindsight
  bridge extension / no provider-hook activity.
- a **sibling** goal in the same project WITHOUT metadata still has tool `<X>` and
  Hindsight active (no leakage either direction).
- pool-claimed goal worktrees AND a respawned session still resolve the metadata
  (claim path + respawn path both honour the edges).

### 8.3 Filesystem E2E

A test provider declaring `goalProvisioned` writes a marker file keyed off
`metadata`. Assert the marker exists on the goal worktree, a `team_spawn` member
worktree, AND a nested sub-goal worktree — i.e. every worktree in the subtree,
not just the goal worktree. Assert idempotency (double provisioning ⇒ one marker,
no error).

### 8.4 Browser E2E (`tests/e2e/ui/*.spec.ts`)

Goal-creation dialog: add a metadata key/value row, create the goal, reload, and
assert the value persists (goal detail / inspector reflects it). Empty editor ⇒
no `metadata` on the created goal (no override).

### 8.5 Commands

`npm run check`, `npm run test:unit`, `npm run test:e2e`. Because this touches
worktree provisioning + the extension host, also `npm run test:manual`.

## 9. File-by-file change list

| File | Change |
|---|---|
| `src/server/agent/goal-store.ts` | `PersistedGoal.metadata` field + load-time malformed-drop migration |
| `src/server/agent/goal-metadata.ts` | **new** — `resolveGoalMetadata`, `deepMergeMetadata`, `GoalMetadataLookup` |
| `src/server/agent/goal-manager.ts` | `createGoal` opts `metadata` + persist; `getEffectiveGoalMetadata`; `dispatchGoalProvisioned` at `_doSetupWorktree` (covers pool claim) |
| `src/server/agent/lifecycle-hub.ts` | inject `goalMetadataResolver`; filter `dispatch`/`hasProvidersForHooks` by `bobbit.disabledProviders`; add `goalProvisioned` to `LifecycleHook`; add `dispatchGoalProvisioned` |
| `src/server/agent/pack-contributions.ts` | add `"goalProvisioned"` to `PROVIDER_HOOKS` |
| `src/server/agent/provider-bridge-extension.ts` | `hasProviderBridgeHooks(hub, projectId, goalId?)` forwards goalId |
| `src/server/agent/session-setup.ts` | `PipelineContext.resolveGoalMetadata`; tool filter in `activateTools`; `parts.sectionOrder`; pass effective goalId to `dispatch`/bridge decision; `dispatchGoalProvisioned` at cold-path + pre-built worktree branches |
| `src/server/agent/session-manager.ts` | pass effective goalId to bridge decision + `afterTurn`/`sessionShutdown` dispatch; wire pipeline `resolveGoalMetadata` |
| `src/server/agent/system-prompt.ts` | `PromptParts.sectionOrder`; stable-reorder in `_assembleSystemPrompt` + `getPromptSections` |
| `src/server/server.ts` | parse `body.metadata` in goal route; wire hub `goalMetadataResolver` + pipeline `resolveGoalMetadata` closures per project |
| `defaults/tools/.../propose_goal` schema | optional `metadata` object |
| `src/app/api.ts` | `createGoal` opts `metadata`, forward `body.metadata` |
| `src/app/state.ts` | `previewGoalMetadata` editor model |
| `src/app/proposal-panels.ts` | key/value editor in `GoalFormConfig`; forward at submit |
| `src/app/proposal-parsers.ts` / `src/app/session-manager.ts` | parse + mirror `metadata` through proposal accept |

## 10. Out of scope

- The experiment/research runner (orchestration, outcome+stats reporting,
  registry) — the next goal, which consumes this layer.
- Advanced metadata typing/validation beyond namespaced key/value.
- Graphify/Gemini/Hindsight content itself — only the generic metadata + hook +
  edges.
</content>
</invoke>
