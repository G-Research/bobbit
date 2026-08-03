# Hook Scope Context — EP-2b

**Goal:** expose a bounded, project-safe snapshot of the session's scope to lifecycle providers without changing lifecycle scheduling, provider activation, or any Host API capability.

## Contract

`src/server/agent/lifecycle-hub.ts` gains the following additive provider-context field. It is only populated for ordinary lifecycle dispatches (`sessionSetup`, `beforePrompt`, `afterTurn`, `beforeCompact`, and `sessionShutdown`); `goalProvisioned` keeps its current, separate contract.

```ts
export interface HookScopeAncestryEntry {
	readonly id: string;
	readonly title?: string;
}

export interface HookScopeComponent {
	readonly name: string;
	readonly repo: string;
	readonly relativePath?: string;
}

export interface HookScopeGoal {
	readonly id: string;
	readonly title?: string;
	/** Root-to-leaf, contains this goal as the final entry. */
	readonly ancestry?: readonly HookScopeAncestryEntry[];
	/** ancestry.length when ancestry is complete and contiguous. Root is 1. */
	readonly depth?: number;
	/** Existing ancestry-merged metadata; never a store-owned reference. */
	readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface HookScopeContext {
	readonly project?: { readonly id: string; readonly name?: string };
	readonly goal?: HookScopeGoal;
	readonly role?: string;
	readonly component?: HookScopeComponent;
}

export interface HookCtx {
	// Existing fields unchanged.
	scopeContext?: HookScopeContext;
}
```

All properties are optional, including nested properties. Providers must treat the field as advisory, read-only context: no field authorizes filesystem, session, agent, store, or cross-project access. `ServerHostApi`, pack schema, lifecycle hook names, and Host API version remain unchanged.

`scopeContext` deliberately contains neither absolute paths nor repository contents. Component coordinates are the configured `name`, `repo`, and optional `relativePath` only. `goalId`, `projectId`, `roleName`, `cwd`, and all other existing flat `HookCtx` fields remain unchanged for compatibility.

## Construction and ownership

Add `src/server/agent/hook-scope-context.ts` as the sole builder. It exports:

```ts
export interface HookScopeResolutionInput {
	projectId?: string;
	goalId?: string;
	roleName?: string;
	cwd: string;
	worktreePath?: string;
	repoPath?: string;
	repoWorktrees?: Readonly<Record<string, string>>;
}

export type HookScopeContextResolver = (
	input: Readonly<HookScopeResolutionInput>,
) => HookScopeContext | undefined;

export function resolveHookScopeContext(
	projects: Pick<ProjectContextManager, "getOrCreate">,
	input: Readonly<HookScopeResolutionInput>,
): HookScopeContext | undefined;
```

The builder must:

1. Start with `projects.getOrCreate(input.projectId)` only. It must never call `getContextForGoal`, scan contexts, or use a goal-id fallback. Unknown project, `headquarters`, system/hidden synthetic projects, or missing `projectId` return `undefined` (not an inferred project).
2. Add `project.id` and `project.name` from that returned `ProjectContext`; add `role` from `input.roleName` when present.
3. Resolve `goalId` exclusively with that context's `goalStore`. A missing or archived leaf yields project/role-only context. The builder must not expose a stale foreign goal id.
4. Reuse the one bounded walk in `src/server/agent/goal-metadata.ts`. Refactor its internal walk into an exported lineage helper used by both `resolveGoalMetadata` and scope construction, retaining `GOAL_METADATA_WALK_DEPTH_CAP === 64`, the seen-id cycle guard, and stopping on missing parents. The scope builder stops its visible ancestry at an archived or missing ancestor. It publishes a root-to-leaf array only when the visible lineage is contiguous; otherwise it may publish the contiguous leaf portion but omits `depth` and `metadata`. This prevents representing a broken chain as a complete root ancestry.
5. For a complete live lineage, obtain `metadata` through the existing `ctx.goalManager.getEffectiveGoalMetadata(goalId)`, never by merging metadata in the builder. This preserves the established root-to-leaf deep-merge/descendant-wins behavior and its fresh cloned result. If this call fails or the lineage is partial, omit `metadata`; context construction is best-effort and never throws.
6. Resolve a component only when `cwd` selects exactly one configured component. Use internal session worktree coordinates (`repoWorktrees`, then `worktreePath`, then the project root) to derive candidate component roots. A component matches when `cwd` is equal to or under its configured `{ repo, relativePath }` root; choose the unique deepest match. Equal-depth candidates, a multi-repo branch-container cwd, unavailable worktree coordinates, or any path-normalization failure omit `component`. Do not guess `components[0]`, a repo-only component, or a component merely because a project has one. Return only configured coordinates, never the derived path.
7. Deep-freeze the newly allocated snapshot before returning it, including ancestry arrays/entries and every object/array reachable through metadata. Use a seen-set in the freezer. The metadata resolver already clones persisted values; freezing prevents one provider's in-process mutation from influencing another provider in the same dispatch.

The component rule intentionally handles monorepos: two components may share `repo: "."`; a more-specific `relativePath` wins only when it is uniquely deeper. It avoids silently attributing a generic root session to one of several components.

## Lifecycle Hub data flow

`LifecycleHub` owns the dispatch boundary so construction happens exactly once per event, not once per provider. Add an optional constructor dependency:

```ts
scopeContextResolver?: HookScopeContextResolver;
```

Keep existing callers source-compatible by adding an optional third dispatch argument rather than changing `HookCtx`'s existing base shape:

```ts
export type HookDispatchBase = Omit<HookCtx, "budget" | "config" | "gateway" | "scopeContext">;

async dispatch(
	hook: LifecycleHook,
	base: HookDispatchBase,
	scopeInput?: HookScopeResolutionInput,
): Promise<{ blocks: ContextBlock[]; diagnostics: HubDiagnostic[] }>;
```

At the top of `dispatch`, call the resolver once with `scopeInput ?? base` (the base supplies project/goal/role/cwd but no worktree coordinates). Catch resolver failures, log one non-fatal diagnostic, and continue with `undefined`. Preserve the returned frozen object in a local `const scopeContext`. Every per-provider `hookCtx` receives that exact object reference:

```ts
const hookCtx: HookCtx = {
	...base,
	...(scopeContext ? { scopeContext } : {}),
	config: provider.config ?? {},
	budget: { maxTokens: provider.budget.maxTokens },
	gateway: this.gatewayInfo(),
};
```

`moduleHost.invoke` may structured-clone this object across worker boundaries; the parent must still pass the same immutable snapshot reference to every invocation. Do not recalculate it in the provider loop, in disabled-provider filtering, or within a provider. Existing provider selection, ordering, timeouts, block validation, budgets, trace rows, config, gateway fields, and dispatch count stay exactly as they are.

Wire the resolver once in `src/server/server.ts` when constructing the shared hub:

```ts
scopeContextResolver: input => resolveHookScopeContext(projectContextManager, input),
```

This replaces no metadata resolver. Keep the existing metadata resolver behavior unchanged for EP-1 compatibility; scope construction's project-first lookup is the new strict trust boundary.

## Dispatch call sites

Pass the source coordinates already owned by each lifecycle boundary:

| Boundary | File | Hook | Scope input |
|---|---|---|---|
| Spawn setup | `src/server/agent/session-setup.ts::resolveDynamicContext` | `sessionSetup` | `plan.projectId`, `effectiveGoalId(plan)`, `plan.roleName`, `plan.cwd`, `plan.worktreePath`, `plan.repoPath`, `plan.repoWorktrees` |
| Per-turn prompt | `src/server/server.ts::resolveHookCtx` and `before-prompt` route | `beforePrompt` | Resolve live-or-persisted session once; pass its `worktreePath`, `repoPath`, and `repoWorktrees` alongside the existing base. |
| Pre-compaction | `src/server/server.ts::resolveHookCtx` and `before-compact` route | `beforeCompact` | Same single live-or-persisted source and coordinates as before-prompt. |
| Turn end | `src/server/agent/session-manager.ts::handleAgentLifecycle` | `afterTurn` | `session.projectId`, `session.goalId ?? session.teamGoalId`, `session.role`, `session.cwd`, `session.worktreePath`, `session.repoPath`, and `Object.fromEntries(session.repoWorktrees ?? [])`. |
| Dormant/live archive | `src/server/agent/session-manager.ts::archiveWithCascade` | `sessionShutdown` | Build from the chosen `src` record (live or persisted), including its persisted worktree coordinates. |
| Live termination | `src/server/agent/session-manager.ts::_terminateSessionOwned` | `sessionShutdown` | Same coordinates from the captured live `session`. |

Make `resolveHookCtx` return a small internal pair, e.g. `{ base, scopeInput }`, so each REST endpoint makes one session-source selection and passes the same selected source to both. Keep its HTTP responses, validation, and 404/no-hub semantics byte-for-byte unchanged.

`dispatchGoalProvisioned` does not use this contract in EP-2b: it already has a goal-specific payload and is not a `HookCtx` lifecycle dispatch. Do not alter it or providers' filesystem-treatment behavior.

## Missing-data and safety semantics

- Goal-less normal sessions may expose project/role and an unambiguous component, but no `goal` or metadata.
- Headquarters/system/unknown-project sessions expose no `scopeContext`.
- Missing, archived, cyclic, or capped goal records must not throw, loop, cross project boundaries, or synthesize a root. They yield absent or partial goal data; `depth` and effective metadata are omitted unless the live lineage is complete.
- A missing project context never falls back to the first context that contains the goal id. A goal stored in another project is therefore invisible even if ids collide or a persisted session is corrupt.
- Metadata is read-only input. EP-2b adds no decisions, cadence, grants, mutations, persistence writes, storage writes, recall policy changes, UI, or Hindsight behavior.

## Documentation updates

Update `docs/lifecycle-hub.md`'s `HookCtx` field table and dispatch algorithm with the field contract, root-to-leaf ordering, partial/absent behavior, component ambiguity rule, and privacy boundary. Update the provider `ctx carries` comment in `docs/extension-host-authoring.md` to link to that canonical contract. Do not duplicate a second schema in marketplace docs.

## Test Suite v2 plan

Add `tests2/core/hook-scope-context.test.ts` and register it in `tests2/tests-map.json` as a v2-native core test. Keep existing lifecycle tests unchanged except for additive assertions in `tests2/core/lifecycle-hub.test.ts` where its realistic ModuleHost fixture is useful.

Coverage must pin:

1. Root and nested goals: project id/name, leaf id/title, ancestry `[root, child, leaf]`, `depth === 3`, role, and nested effective metadata (deep merge and descendant override).
2. Bounded lineage: missing parent, archived parent, cycle, and more than `GOAL_METADATA_WALK_DEPTH_CAP` records return quickly with no invented complete ancestry/depth/metadata.
3. Isolation: a session claiming project A and goal B in project B gets only A's project context (and no B goal/metadata); unknown/HQ/system projects and goal-less sessions are absent/partial as specified.
4. Components: unique single-repo match; multi-repo match from `repoWorktrees`; monorepo deepest-relative-path match; equal-depth and branch-container ambiguity omit `component`; no absolute path appears in serialized scope context.
5. Metadata and snapshot immutability: mutating source metadata after resolution cannot mutate the snapshot; every reachable metadata object/array and ancestry structure is frozen; a resolver executes once per `dispatch`; a fake `ModuleHost` observes the same `scopeContext` identity for two providers; a provider-side attempted mutation cannot affect a later provider.
6. Every dispatch boundary: `sessionSetup`, REST `beforePrompt`, REST `beforeCompact`, `afterTurn`, both `sessionShutdown` paths. Verify live versus persisted source coordinates are respected without dispatching extra hooks.
7. Golden compatibility: a provider that does not read `scopeContext` receives the same invocations, provider order, config/budget/gateway/context blocks, trace data, and zero additional calls when the resolver is absent or returns `undefined`.

Commands after implementation:

```bash
npm run check
npx vitest run tests2/core/hook-scope-context.test.ts tests2/core/lifecycle-hub.test.ts tests2/core/goal-metadata.test.ts tests2/core/goal-metadata-edges.test.ts
npm run test:unit
npm run test:browser
npm run test:e2e
```
