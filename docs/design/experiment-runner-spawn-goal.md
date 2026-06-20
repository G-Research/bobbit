# Experiment runner — the minimal core/host change: `host.agents.spawnGoal`

Status: **design** (coder-0447, goal `goal/experiment-run-bf9e404c`, stacked on
PR #822 `goal/hierarchical-g-f6c39aa2`). This note specifies the *single*
core/host change the experiment-runner market pack needs. Everything else
(panel, routes, store registry, aggregation, dashboards, autoresearch loop)
lives in the pack and reuses surfaces that already exist.

> **Branch note.** This design is written against PR #822 as the base. At the
> time of writing the coder worktree was cut from `master` and does **not** yet
> contain #822; the #822 sources referenced below were read non-destructively
> via `git show goal/hierarchical-g-f6c39aa2:<path>`. All file/line references
> assume the goal branch (which already merged #822). The team lead merges #822
> into the goal branch before this lands.

---

## 1. The gap (why a new capability is required)

PR #822 already shipped everything needed to *describe* a per-arm treatment and
to make it propagate without asymmetry:

- `PersistedGoal.metadata` (arbitrary, namespaced) + defensive migration
  (`goal-store.ts`).
- `goal-metadata.ts::resolveGoalMetadata` / `GoalManager.getEffectiveGoalMetadata`
  — deep-merge ancestors → self, descendant wins, 64-hop cap, immutability clone.
- Core edges read the resolved metadata (providers/bridge via `LifecycleHub`'s
  `goalMetadataResolver`, `bobbit.disabledTools`, `bobbit.promptSectionOrder`).
- The `goalProvisioned` lifecycle hook fires at **every** worktree provisioning
  (cold goal worktree, per-session cold path, pooled worktrees, team member
  worktrees, sandbox worktrees with host coordinates) — the no-asymmetry
  guarantee for filesystem treatments.
- `GoalManager.createGoal(title, cwd, { spec, metadata, inlineRoles,
  parentGoalId, workflowId, resolvedWorkflow, projectId, sandboxed,
  subgoalsAllowed, maxNestingDepth, … })` — already accepts `metadata` and
  `inlineRoles` and stamps nested-goal lineage via `deriveNestingFields`.

What is **missing**: there is no pack-facing way to *launch a run that carries a
distinct per-arm `metadata` + `inlineRoles`*. The only orchestration surface a
pack has is `host.agents` (`server-host-api.ts::ServerHostAgentsApi`), whose six
verbs (`spawn`/`prompt`/`dismiss`/`list`/`read`/`status`) all operate on **team
child *sessions*** in the owner's worktree (`OrchestrationCore`). Those children:

1. cannot create a **goal** (no worktree branch, no team, no gates, no
   verification, no cost rollup of their own); and
2. only ever *inherit* the experiment goal's effective metadata — there is no
   parameter to give an individual child a distinct arm treatment.

So an A/B arm or an autoresearch candidate — each of which must be a goal with
its **own** metadata that then propagates across its whole sub-tree — is
unreachable from a pack today.

**The change:** add one sanctioned host verb, `host.agents.spawnGoal(...)`,
that maps to `GoalManager.createGoal` (+ worktree setup + scheduled team start),
launching each variant/candidate as a **child goal of the experiment goal**
whose metadata = experiment metadata deep-merged with the arm's treatment. This
is the only expected core/host change. A read-only companion verb
(`goalStatus`, §11) is recommended so the pack can poll completion in-process
without coupling to on-disk store formats.

---

## 2. API shape

### 2.1 `ServerHostAgentsApi.spawnGoal` (`src/server/extension-host/server-host-api.ts`)

Add to the existing `ServerHostAgentsApi` interface (it already documents itself
as "orchestration VERBS, not transport"):

```ts
/** Launch a CHILD GOAL of the bound session's effective goal, carrying a
 *  distinct per-arm treatment (metadata + inlineRoles). Returns the new goal
 *  id. The child goal is created via GoalManager.createGoal, its worktree is
 *  provisioned, and its team start is requested through the per-root scheduler
 *  — exactly the lifecycle the spawn-child REST route drives. Throws when the
 *  bound session has no effective goal, when the spawn backend is unavailable,
 *  or when the goal-level nesting/subgoal policy rejects the spawn. */
spawnGoal(opts: {
	/** Goal spec (markdown). Required; non-empty after trim. */
	spec: string;
	/** Visible goal title. Required; non-empty after trim. */
	title: string;
	/** Idempotency key unique within the parent goal (mirrors spawn-child's
	 *  `planId`). A re-call with the same key returns the existing child id. */
	runKey: string;
	/** Per-arm namespaced metadata (the treatment). Deep-merged on top of the
	 *  experiment goal's effective metadata by #822's resolver across the whole
	 *  child sub-tree. Plain object; arrays/scalars replace wholesale. */
	metadata?: Record<string, unknown>;
	/** Per-arm inline roles (frozen onto the child goal at creation). Merged
	 *  with the parent's inlineRoles, child wins per name (spawn-child parity). */
	inlineRoles?: Record<string, import("../agent/role-store.js").Role>;
	/** Workflow selection. `workflowId` looks up the project workflow store;
	 *  `workflow` supplies a full inline snapshot (highest precedence). Absent ⇒
	 *  inherit the parent goal's workflow (stripped of subgoal steps). Resolved
	 *  via the shared resolveChildWorkflow cascade. */
	workflowId?: string;
	workflow?: import("../agent/workflow-store.js").Workflow;
}): Promise<{ goalId: string }>;
```

Design choices:

- **It is the 7th `host.agents` verb, not a new namespace.** It is orchestration
  ("launch a properly-scoped principal"), so it belongs beside `spawn`. The
  capability flag stays `capabilities.agents`. (A pinning test asserts the new
  surface key set — §12.)
- **No `parentGoalId` parameter.** The parent is *always* the bound session's
  effective goal (server-derived, §8). A pack must not be able to target an
  arbitrary goal — that is the same own-session-only stance the other verbs take
  ("there is NO parameter for a foreign/user session").
- **No `projectId`, `sandboxed`, `cwd` parameters.** All inherited from the
  parent goal (§9) — a pack cannot widen scope.
- **`runKey` (idempotency).** A/B fan-out and autoresearch retries both re-call;
  mirrors `spawn-child`'s `planId` → `spawnedFromPlanId` idempotency.

### 2.2 Capability map / mask

No new flag. `spawnGoal` rides `capabilities.agents`. The provider
least-privilege host (`server.ts:1263`, `capabilityMask: { store: true }`)
already denies `agents`, so a provider hook cannot spawn goals — unchanged.
`denyNamespace("agents", …)` already replaces every method with a throwing stub
when masked, so `spawnGoal` is automatically covered (a pinning test asserts the
masked stub throws — §12).

---

## 3. Worker proxy changes (`module-host-bootstrap.ts` + `module-host-worker.ts`)

`host.agents` is proxied from the confined worker to the parent's live host over
the MessagePort. Three additive edits, mechanically identical to how the six
existing verbs are wired:

1. **`module-host-bootstrap.ts::buildHostProxy`** — add to the `agents` proxy:
   ```ts
   spawnGoal: (spawnOpts: unknown) => callHost(["agents", "spawnGoal"], [spawnOpts]),
   ```
2. **`module-host-worker.ts::PROXYABLE.agents`** — add `"spawnGoal"` to the
   allowed-method set:
   ```ts
   agents: new Set(["spawn", "prompt", "dismiss", "list", "read", "status", "spawnGoal"]),
   ```
   (`invokeHostMethod` rejects any `host.<ns>.<method>` not in this set — the
   single sanctioned worker→parent channel. Without this edit the proxied call is
   refused with "not a permitted proxied capability".)
3. **`SerializableCtx.capabilities`** (bootstrap) and the proxy `capabilities`
   object are unchanged — `agents` already flows through; `spawnGoal` is a method
   on an already-exposed namespace.

No change to `invokeHostMethod`'s `path.length !== 2` guard — `["agents",
"spawnGoal"]` is still a 2-tuple.

---

## 4. Server host implementation (`server-host-api.ts`)

`createServerHostApi` already closes over `opts.sessionId` (bound owner) and the
injected `orchestrationCore`/`readChildStatus`. Add one injected dependency and
implement the verb inside the existing `agents` object.

### 4.1 New injected dependency on `CreateServerHostApiOptions`

```ts
/** EXPERIMENT-RUNNER SEAM: create a CHILD GOAL of the owner session's effective
 *  goal, carrying per-arm metadata + inlineRoles. Injected by the gateway
 *  (server.ts) which owns the per-project GoalManager + the team-start
 *  scheduler. Resolves owner → effective goal → project GoalManager, calls
 *  createGoal(metadata, inlineRoles, parentGoalId, workflow…), provisions the
 *  worktree, and requests the team start. Bound to the owner session id; there
 *  is NO parameter for a foreign session or an arbitrary parent goal. Absent in
 *  non-gateway contexts → spawnGoal throws a clear "backend unavailable". */
spawnChildGoal?: (ownerSessionId: string, opts: SpawnChildGoalOpts) => Promise<{ goalId: string }>;
```

with a shared type (exported from `server-host-api.ts` or a small new
`experiment-spawn-goal.ts` — see §13):

```ts
export interface SpawnChildGoalOpts {
	spec: string;
	title: string;
	runKey: string;
	metadata?: Record<string, unknown>;
	inlineRoles?: Record<string, import("../agent/role-store.js").Role>;
	workflowId?: string;
	workflow?: import("../agent/workflow-store.js").Workflow;
}
```

The host stays a thin, dependency-injected shell (the same pattern as
`orchestrationCore`/`readChildStatus`): it does **no** goal/worktree logic
itself — that all lives in the gateway closure (§5) so `server-host-api.ts`
keeps no `GoalManager`/`ProjectContext` import (avoiding a module cycle, exactly
why `orchestrationCore` is typed `unknown` in the options).

### 4.2 The verb body (inside the `agents` object)

```ts
const spawnChildGoal = opts.spawnChildGoal;
// …
spawnGoal: async (goalOpts) => {
	// Recursion belt: reuse A's shared guard. A bound CHILD SESSION (delegate /
	// team / host-agents child) may not spawn goals (no grandchild principals
	// from a sub-agent), surfaced as a capability-specific message.
	try {
		requireCore().assertCanSpawn(ownerSessionId);
	} catch {
		throw new Error("host.agents.spawnGoal is not permitted for a child session");
	}
	if (!spawnChildGoal) throw new Error("host.agents.spawnGoal backend unavailable");
	// Validate shape here (cheap, before crossing into the gateway closure).
	const spec = typeof goalOpts?.spec === "string" ? goalOpts.spec.trim() : "";
	const title = typeof goalOpts?.title === "string" ? goalOpts.title.trim() : "";
	const runKey = typeof goalOpts?.runKey === "string" ? goalOpts.runKey.trim() : "";
	if (!spec) throw new Error("host.agents.spawnGoal: spec is required");
	if (!title) throw new Error("host.agents.spawnGoal: title is required");
	if (!runKey) throw new Error("host.agents.spawnGoal: runKey is required");
	return spawnChildGoal(ownerSessionId, {
		spec, title, runKey,
		metadata: goalOpts.metadata,
		inlineRoles: goalOpts.inlineRoles,
		workflowId: goalOpts.workflowId,
		workflow: goalOpts.workflow,
	});
},
```

`requireCore()` already exists (the other verbs use it). The `assertCanSpawn`
reuse means the recursion policy has a single source of truth shared with
`host.agents.spawn` and the agent-tool spawn path.

---

## 5. Injected dependency — gateway wiring (`server.ts`)

The closure is constructed once and passed to **both** `createServerHostApi`
call sites that build the action/route host (`server.ts:6024`, `server.ts:6401`).
The provider host (`server.ts:1263`) deliberately omits it (provider hooks are
masked off `agents` anyway).

The closure factors out the lifecycle that `nested-goal-routes.ts`'s
`POST /api/goals/:id/spawn-child` already implements, so the two spawn paths
stay in lockstep. Put it in a small new module
`src/server/agent/experiment-spawn-goal.ts` (pure-ish, dependency-injected) and
call it from `server.ts`. Sketch:

```ts
// experiment-spawn-goal.ts
export async function spawnExperimentChildGoal(deps: {
	sessionManager: SessionManager;
	projectContextManager: ProjectContextManager;
	verificationHarness: VerificationHarness;
	getSubgoalNestingPrefs(): SubgoalNestingPrefs;
	broadcastToAll(ev: unknown): void;
}, ownerSessionId: string, opts: SpawnChildGoalOpts): Promise<{ goalId: string }> {
	// 1. Resolve owner → effective goal (the experiment goal).
	const owner = deps.sessionManager.getPersistedSession(ownerSessionId);
	const parentGoalId = owner?.goalId ?? owner?.teamGoalId;
	if (!parentGoalId) throw new SpawnGoalError("NO_EFFECTIVE_GOAL",
		"calling session has no goal to parent the run under");
	const ctx = deps.projectContextManager.getContextForGoal(parentGoalId);
	if (!ctx) throw new SpawnGoalError("PARENT_GOAL_NOT_FOUND", "parent goal project context not found");
	const parent = ctx.goalStore.get(parentGoalId)!;
	if (parent.paused) throw new SpawnGoalError("GOAL_PAUSED", `parent goal ${parentGoalId} is paused`);

	// 2. Idempotency on runKey (mirrors spawn-child planId).
	const siblings = ctx.goalStore.getAll().filter(g => g.parentGoalId === parentGoalId);
	const existing = siblings.find(g => g.spawnedFromPlanId === opts.runKey);
	if (existing) return { goalId: existing.id };

	// 3. Goal-level nesting / subgoal policy (single source of truth).
	const prefs = deps.getSubgoalNestingPrefs();
	const check = checkCanSpawnChild(parent, prefs, (gid) => ctx.goalStore.get(gid));
	if (!check.ok) throw new SpawnGoalError(check.code, "subgoal spawn blocked");

	// 4. Child cwd = ROOT REPO path (+ monorepo offset), never the parent worktree.
	const childCwd = deriveChildRepoCwd(parent); // same logic as spawn-child

	// 5. Workflow cascade (shared helper).
	const { workflow, workflowId } = resolveChildWorkflowOrFallback(parent, opts, ctx.workflowStore);

	// 6. Merge inlineRoles (parent ⊕ arm, arm wins).
	const inlineRoles = mergeInlineRoles(parent.inlineRoles, opts.inlineRoles);

	// 7. Inherited nesting ceilings.
	const childOverrides = inheritedChildOverrides(parent, prefs);

	// 8. Create the child goal WITH the arm metadata.
	const child = await ctx.goalManager.createGoal(opts.title, childCwd, {
		spec: opts.spec,
		workflowId, resolvedWorkflow: workflow,
		projectId: parent.projectId,
		sandboxed: parent.sandboxed,
		parentGoalId,
		metadata: opts.metadata,           // ← the arm treatment (#822 persists it)
		inlineRoles,
		subgoalsAllowed: childOverrides.subgoalsAllowed,
		maxNestingDepth: childOverrides.maxNestingDepth,
	});

	// 9. Stamp idempotency key immediately (no awaits between — stamp-immediately
	//    invariant from spawn-child).
	await ctx.goalManager.updateGoal(child.id, { spawnedFromPlanId: opts.runKey });

	// 10. Init gate states + broadcast + request scheduled team start.
	if (child.workflow) ctx.gateStore.initGatesForGoal(child.id, child.workflow.gates.map(g => g.id));
	deps.broadcastToAll({ type: "goal_created", goalId: child.id, parentGoalId });
	deps.verificationHarness.requestChildStart(child.id); // worktree setup + start, cap-aware
	return { goalId: child.id };
}
```

`server.ts` then wires:

```ts
const spawnChildGoal = (ownerSessionId: string, o: SpawnChildGoalOpts) =>
	spawnExperimentChildGoal({ sessionManager, projectContextManager,
		verificationHarness, getSubgoalNestingPrefs, broadcastToAll: broadcastToAll }, ownerSessionId, o);
// passed into BOTH action/route createServerHostApi(...) calls as `spawnChildGoal`.
```

> **Reuse, don't fork.** Steps 4/5/6/7/8/9/10 are the spawn-child REST handler's
> body (`nested-goal-routes.ts`). The cleanest landing extracts the shared core
> (createGoal-opts mapping + scheduled start) into `experiment-spawn-goal.ts` and
> has the REST handler call it too, but that refactor is optional for this goal
> — the minimum is a new closure that mirrors the handler. Either way the two
> paths must agree on cwd derivation, workflow cascade, inlineRoles merge, and
> the `requestChildStart` scheduler call (so the per-root concurrency cap is
> honoured — critical for A/B fan-out, which deliberately spawns many arms).

---

## 6. `createGoal` option mapping

| `spawnGoal` opt | `createGoal` opt | Notes |
|---|---|---|
| `title` | positional `title` | sanitised into branch by `toBranchName` |
| `spec` | `opts.spec` | required, non-empty |
| `metadata` | `opts.metadata` | persisted iff non-empty plain object (`structuredClone`); the **arm treatment** |
| `inlineRoles` (merged with parent) | `opts.inlineRoles` | frozen via `structuredClone` |
| `workflowId` / `workflow` (cascade) | `opts.workflowId` + `opts.resolvedWorkflow` | see §10 |
| — (server-derived) | `opts.parentGoalId` | owner's effective goal id |
| inherited | `opts.projectId` | `parent.projectId` |
| inherited | `opts.sandboxed` | `parent.sandboxed` |
| inherited ceiling | `opts.subgoalsAllowed` / `opts.maxNestingDepth` | `inheritedChildOverrides(parent, prefs)` |

`divergencePolicy` / `maxConcurrentChildren` are **root-only** in `createGoal`
(stamped only when `parentGoalId === undefined`); a child arm never carries them,
so they are intentionally *not* mapped. `runKey` maps to `spawnedFromPlanId` via
the post-create `updateGoal` (not a `createGoal` arg).

---

## 7. Lifecycle after creation (worktree + team start)

`createGoal` returns immediately with `setupStatus: "preparing"` (worktree not
yet built) — identical to spawn-child. The closure calls
`verificationHarness.requestChildStart(child.id)`, the unified per-root scheduler
entry, which:

- claims/creates the child worktree (`goalManager.setupWorktree` →
  `_provisionGoalWorktree`), which fires `goalProvisioned` for the child goal
  worktree (the first place the arm's filesystem treatment lands);
- starts the team under the per-root concurrency permit (`maxConcurrentChildren`,
  resolved at the root), or parks the arm `state:"blocked"` (capacity) until a
  permit frees.

This is what makes A/B fan-out safe: spawning N arms does **not** start N teams
at once — the scheduler throttles to the cap. The pack does not manage worktrees,
branches, or team start; it only calls `spawnGoal` and polls.

---

## 8. Parent/child scoping & security

- **Parent is server-derived, never caller-supplied.** `parentGoalId =
  owner.goalId ?? owner.teamGoalId` (the same `stampGoalId`/effective-goal
  pattern #822 uses at every edge). A pack cannot pass a goal id, so it cannot
  parent a run under a foreign goal or create a root goal.
- **Project / sandbox inheritance.** `projectId` and `sandboxed` come from the
  parent goal, never from the pack. The child can never run outside the
  experiment goal's project or escape its sandbox — the same hard invariant
  `OrchestrationCore.spawn` enforces for child sessions.
- **No effective-goal ⇒ refuse.** A teamless/assistant session (no `goalId`/
  `teamGoalId`) cannot spawn an experiment run (`NO_EFFECTIVE_GOAL`). Experiments
  are only meaningful inside a goal.
- **`mergeChild` parent-match is preserved downstream.** Because the child
  carries `parentGoalId`, the existing `integrate-child`/`mergeChild`
  `PARENT_MISMATCH` guard already prevents cross-tree merges of arm results.
- **The pack never receives transport.** `spawnGoal` returns only `{ goalId }`;
  no token, no `fetch`, no `GoalManager` reference crosses the worker boundary
  (the closure runs parent-side, like every other host call).

---

## 9. Metadata + `inlineRoles` propagation (the no-asymmetry payoff)

- `createGoal` persists the arm's `metadata` on the child goal (`goal.metadata =
  structuredClone(metadata)`), and `inlineRoles` frozen as a snapshot.
- `resolveGoalMetadata` (#822) deep-merges the **experiment goal's** effective
  metadata (ancestors) with the **arm's** metadata (descendant wins). Every
  session in the arm's sub-tree — its team lead, every `team_spawn` member, every
  `team_delegate` sub-agent, every `llm-review` reviewer, and any nested
  sub-goal — resolves the **same merged `M`**, and `goalProvisioned` fires on
  **every** worktree in that sub-tree. This is exactly the anti-asymmetry
  invariant #822 established; `spawnGoal` inherits it for free.
- **Consequence for requirement 7 (cross-arm consistency):** because metadata is
  resolved live (not snapshotted onto children) and applies uniformly across the
  arm's sub-tree, two arms with different treatments cannot contaminate each
  other. The E2E (§12) asserts a distinct per-arm key reaches a grand-child
  session of each arm.
- **Deep-merge semantics matter to experiment authors.** Arrays/scalars replace
  wholesale; nested objects merge. An arm setting `bobbit.disabledTools: [...]`
  fully replaces the experiment-level list; an arm setting
  `hindsight.memory.enabled: false` flips one sub-key while inheriting the rest.
  This is the documented #822 behaviour — the pack just chooses keys.

---

## 10. Workflow / `workflowId` handling

Reuse `spawn-child-workflow.ts::resolveChildWorkflow` — the shared cascade:

1. `opts.workflow` (full inline snapshot) → `{ workflow, workflowId: workflow.id }`.
2. `opts.workflowId` → store lookup → `{ workflowId }`.
3. parent's snapshot → `structuredClone` + `stripSubgoalStepsForChildInheritance`
   (so the arm does not re-execute the experiment's plan) → `{ workflow }`.
4. `"feature"` from the store.
5. first non-hidden workflow.

Snapshot-bearing tiers (1, 3) pass `resolvedWorkflow`; id-only tiers (2/4/5) pass
`workflowId` and let `createGoal` materialise it. On total failure, fall back to
`parent.workflow` stripped, or `workflowId` / `"feature"` and let `createGoal`
throw `NO_WORKFLOWS_MSG` loudly (never create a gateless arm). This is byte-for-
byte the resolution the spawn-child handler runs, so arm goals and hand-spawned
sub-goals get identical workflow behaviour.

For A/B, the *workflow itself* can be part of the arm bundle (requirement 3: "per-
run config bundle = metadata + inlineRoles + workflow"), so `spawnGoal` accepts
either an id or an inline snapshot.

---

## 11. Polling completion — recommended read companion `goalStatus`

`spawnGoal` returns a `goalId`, but the pack still needs to know when an arm
finishes (to aggregate) and whether it passed verification (the autoresearch
correctness gate). The pack must **not** read `gates.json` / goal-store files
directly (couples it to internal formats and to a sandboxed arm's container
path). Two options:

- **(Recommended) add a read-only companion verb** `goalStatus(goalId)`:
  ```ts
  goalStatus(goalId: string): Promise<{
  	state: string;        // todo | in-progress | blocked | complete | …
  	archived: boolean;
  	gates: Array<{ id: string; status: string }>; // incl. ready-to-merge
  } | null>;
  ```
  Scoped exactly like the other verbs: it resolves only goals whose
  `parentGoalId === ownerSession.effectiveGoalId` (own spawned children) and
  returns `null` otherwise — never a foreign goal. Implemented by a second
  injected closure `readChildGoalStatus(ownerSessionId, goalId)` that reads the
  per-project `goalStore` + `gateStore`. This is still "minimal" — read-only, no
  new persistence, scoped, and it makes the pack's poll loop format-stable.
- **(Fallback) reuse `host.agents.status`/`read`** on the arm's *team-lead
  session*. This is awkward (the pack would have to discover the team-lead
  session id for a goal) and exposes session-level, not goal-level, state — not
  recommended.

This note treats `spawnGoal` as the load-bearing change and `goalStatus` as the
recommended companion. If the team wants the strict "one capability only" stance,
`goalStatus` can be deferred and the pack polls via a thin REST GET from the
pack's *route* (routes can call the gateway) — but the cleaner contract is the
scoped host read verb. **Decision needed** (see §15).

---

## 12. Error behaviour

All errors are thrown `Error`s that the worker proxy marshals back as the
promise rejection the pack awaits (`host-reply` `{ ok: false, error }`):

| Condition | Message / code |
|---|---|
| bound session is a child | `host.agents.spawnGoal is not permitted for a child session` |
| backend not injected (non-gateway) | `host.agents.spawnGoal backend unavailable` |
| missing/blank `spec`/`title`/`runKey` | `host.agents.spawnGoal: <field> is required` |
| owner has no effective goal | `NO_EFFECTIVE_GOAL` |
| parent goal context missing | `PARENT_GOAL_NOT_FOUND` |
| parent goal paused | `GOAL_PAUSED` |
| subgoals disabled for tree | `SUBGOALS_DISABLED` (from `checkCanSpawnChild`) |
| nesting depth exceeded | `NESTING_DEPTH_EXCEEDED` |
| no workflow resolvable | `createGoal` throws `NO_WORKFLOWS_MSG` |
| `metadata`/`inlineRoles` not plain objects | reject before `createGoal` (defensive guard) |

Idempotent re-call with a known `runKey` is **not** an error — it returns the
existing `{ goalId }`. Use a small `SpawnGoalError extends Error { code }` so the
pack can branch on `code` (the masked-namespace stub and the recursion guard
throw plain `Error`s, consistent with the existing `agents` verbs).

---

## 13. Files / functions to change (exact)

Production (all on the goal branch, post-#822):

1. **`src/server/extension-host/server-host-api.ts`**
   - `ServerHostAgentsApi`: add `spawnGoal` (and, if adopted, `goalStatus`).
   - `CreateServerHostApiOptions`: add `spawnChildGoal?` (and `readChildGoalStatus?`).
   - `createServerHostApi`: implement `spawnGoal` in the `agents` object using
     `requireCore().assertCanSpawn` + the injected closure; validate args.
   - Export `SpawnChildGoalOpts` (or import from the new module).
2. **`src/server/extension-host/module-host-bootstrap.ts`**
   - `buildHostProxy`: add `spawnGoal` (and `goalStatus`) to the `agents` proxy.
3. **`src/server/extension-host/module-host-worker.ts`**
   - `PROXYABLE.agents`: add `"spawnGoal"` (and `"goalStatus"`).
4. **`src/server/agent/experiment-spawn-goal.ts`** (new)
   - `spawnExperimentChildGoal(deps, ownerSessionId, opts)` — the gateway closure
     body (§5); `SpawnChildGoalOpts`, `SpawnGoalError`, and small helpers
     (`deriveChildRepoCwd`, `mergeInlineRoles`, `resolveChildWorkflowOrFallback`)
     shared with / extracted from `nested-goal-routes.ts`.
   - Optional: `readChildGoalStatus(deps, ownerSessionId, goalId)` for §11.
5. **`src/server/server.ts`**
   - Build the `spawnChildGoal` (and `readChildGoalStatus`) closures once; pass
     them into the **two** action/route `createServerHostApi(...)` calls
     (`~6024`, `~6401`). Do **not** pass them to the provider host (`~1263`).
6. *(Optional refactor)* **`src/server/agent/nested-goal-routes.ts`** — route the
   spawn-child handler through `experiment-spawn-goal.ts`'s shared core so both
   paths can never drift.

No changes to `goal-manager.ts`, `goal-metadata.ts`, `orchestration-core.ts`, or
the `goalProvisioned` plumbing — they already do exactly what is needed.

---

## 14. Pinning tests to add

**Unit — `tests/host-agents-spawn-goal.test.ts`** (mirror
`tests/host-agents-scope.test.ts`: real `createServerHostApi` over a fake
`OrchestrationCore` view + a fake `spawnChildGoal` closure):

- `surface exposes spawnGoal alongside the six poll verbs` — `Object.keys(
  host.agents).sort()` equals `["dismiss","goalStatus"?,"list","prompt","read",
  "spawn","spawnGoal","status"]` (assert the exact set; pins §2/§3).
- `spawnGoal forwards spec/title/runKey/metadata/inlineRoles/workflow to the
  injected closure verbatim` and returns `{ goalId }`.
- `spawnGoal validates required fields` — blank `spec`/`title`/`runKey` reject.
- `spawnGoal is denied for a bound child session` — owner with `delegateOf` (or a
  `childKind`) → rejects `/not permitted for a child session/` (pins recursion
  reuse of `assertCanSpawn`).
- `spawnGoal throws backend-unavailable when no closure is injected`.
- `masked agents namespace denies spawnGoal` — host built with
  `capabilityMask:{ store:true }` → `host.agents.spawnGoal(...)` throws
  `/not available/` (pins `denyNamespace` coverage of the new verb).

**Unit — `tests/experiment-spawn-goal.test.ts`** (the closure over a fake
project context / GoalManager / scheduler):

- `maps arm metadata + merged inlineRoles + workflow cascade onto createGoal`.
- `parents the run under the owner's effective goal (goalId ?? teamGoalId); never
  caller-supplied`.
- `inherits projectId + sandboxed from the parent goal`.
- `is idempotent on runKey` — second call returns the first child id, no second
  createGoal.
- `refuses NO_EFFECTIVE_GOAL / GOAL_PAUSED / SUBGOALS_DISABLED /
  NESTING_DEPTH_EXCEEDED`.
- `requests a scheduled team start (requestChildStart) exactly once`.

**Unit — `tests/host-agents-proxy-allowlist.test.ts`** (extend existing worker
proxy coverage, or add): `invokeHostMethod` permits `["agents","spawnGoal"]` and
still rejects `["agents","__proto__"]` / unknown methods.

**API E2E — `tests/e2e/host-agents-spawn-goal.spec.ts`** (extend the
`host-agents-exerciser` fixture pack with a `spawnGoalRun` member; drive it
through the real confined worker like `tests/e2e/host-agents.spec.ts`):

- `a fixture handler spawnGoal → child goal is created with distinct arm
  metadata` — assert the child goal exists, `parentGoalId` = the owner's goal,
  and `getEffectiveGoalMetadata(child.id)` contains the arm key deep-merged over
  the experiment metadata.
- `the arm treatment reaches a sub-agent of the arm` (requirement 7 / acceptance
  "verified uniform across each arm's sub-tree") — spawn a delegate/member under
  the arm and assert it resolves the same merged `M` (reuses #822's
  `goal-metadata-hierarchy.spec.ts` assertion style).
- `spawnGoal is idempotent on runKey across two fixture calls`.
- `a child session cannot spawnGoal (no grandchildren)` — bind a host to a
  spawned child session, `spawnGoal` rejects (parity with the existing
  "child cannot host.agents.spawn" E2E).

These use the **mock agent** (canned, no LLM) so the arm goal's team settles in
milliseconds — the spec stays in the e2e phase, never `test:manual`. Because the
change touches goal spawn + worktree provisioning, also run `test:manual` once
(per AGENTS.md: spawn/host changes ⇒ manual integration).

---

## 15. Open questions / decisions for the team lead

1. **`goalStatus` companion verb (§11): in or out?** Recommended in (read-only,
   scoped) so the pack's poll loop is format-stable and works for sandboxed arms.
   If "strictly one capability", defer it and poll from the pack's route via
   REST. *Lean: include it — it is small and removes a fragile fs/format
   coupling.*
2. **Refactor spawn-child onto the shared core (§5/§13.6)?** Strongly preferred
   to prevent drift, but it edits an authz-sensitive handler. Could be a
   follow-up if the lead wants this goal's diff minimal. *Lean: extract the
   non-authz core; keep the REST handler's authz/validation in place and have it
   call the core.*
3. **`runKey` naming.** Reusing `spawnedFromPlanId` for idempotency overloads a
   nested-plan field. It works (it is just a per-parent unique string) but is
   semantically "plan id". Acceptable for v1; flag if a dedicated field is
   wanted later.
</content>
</invoke>
