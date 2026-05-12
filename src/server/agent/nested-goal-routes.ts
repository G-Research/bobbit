/**
 * Phase-4 nested-goal REST surface, extracted from server.ts.
 *
 * Backs the team-lead-only `goal_*` tools in `defaults/tools/children/`.
 * Cascade-affecting routes require explicit `cascade` (422 otherwise);
 * the UI is the cascade-policy authority.
 *
 * `tryHandleNestedGoalRoute` returns `true` once it has written a
 * response — caller should return immediately. `false` means "not my
 * route, try the next handler".
 *
 * Mechanical extraction — zero behaviour change vs the inline version.
 */

import type http from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { GoalManager } from "./goal-manager.js";
import type { PersistedGoal } from "./goal-store.js";
import type { ProjectContextManager } from "./project-context-manager.js";
import type { SessionManager } from "./session-manager.js";
import type { TeamManager } from "./team-manager.js";
import type { VerificationHarness } from "./verification-harness.js";
import type { Workflow } from "./workflow-store.js";
import { stripSubgoalStepsForChildInheritance } from "./workflow-store.js";
import { classifyMutation, type ClassifierPlanStep } from "./plan-mutation.js";
import { DEFAULT_MUTATION_TTL_MS, type PendingMutation } from "./plan-mutation-store.js";
import { validateDependsOn, validatePlanDependsOn } from "./depends-on-validation.js";
import { resolveSpawnedBySessionId } from "./spawn-child-spawnedby.js";
import { parseAcceptanceCriteria } from "../../shared/parse-acceptance-criteria.js";
import {
	checkCanSpawnChild,
	inheritedChildOverrides,
	type SubgoalNestingPrefs,
} from "./subgoal-nesting-limit.js";

export interface NestedGoalRouteDeps {
	projectContextManager: ProjectContextManager;
	verificationHarness: VerificationHarness;
	teamManager: TeamManager;
	sessionManager: SessionManager;
	requireSubgoalsEnabled(): boolean;
	getGoalAcrossProjects(goalId: string): PersistedGoal | undefined;
	getGoalManagerForGoal(goalId: string): GoalManager;
	readBody(req: http.IncomingMessage): Promise<any>;
	json(body: unknown, status?: number): void;
	/**
	 * Canonical descriptive-error response — `{ error, stack, ...extra }`
	 * (post `6d422ca6`). Used for caught exceptions so clients receive a
	 * stack trace; structured-validation errors keep using `json(...)`
	 * with their `code` payload.
	 */
	jsonError(status: number, err: unknown, extra?: Record<string, unknown>): void;
	broadcastToAll(event: any): void;
	/** Read the system-scope subgoal nesting prefs (subgoalsEnabled, maxNestingDepth). */
	getSubgoalNestingPrefs(): SubgoalNestingPrefs;
}

/**
 * BFS-walk descendants of a goal via `parentGoalId`. Used by both the
 * Phase-4 cascade routes and the legacy DELETE handler in server.ts —
 * exported so server.ts can call it directly without going through the
 * Phase-4 dispatcher.
 */
export function listDescendants(
	projectContextManager: ProjectContextManager,
	goalId: string,
	opts?: { includeArchived?: boolean },
): PersistedGoal[] {
	const ctx = projectContextManager.getContextForGoal(goalId);
	if (!ctx) return [];
	const all = ctx.goalStore.getAll();
	const includeArchived = opts?.includeArchived ?? false;
	const out: PersistedGoal[] = [];
	const seen = new Set<string>([goalId]);
	const queue: string[] = [goalId];
	while (queue.length > 0) {
		const cur = queue.shift()!;
		for (const g of all) {
			// Walk THROUGH archived descendants when looking for live ones
			// further down the tree (a live grandchild whose parent is
			// archived must still block the cascade=false path) — but only
			// INCLUDE the archived goal in `out` when the caller asked for
			// it (cascade=true needs the full set).
			if (g.parentGoalId === cur && !seen.has(g.id)) {
				seen.add(g.id);
				if (includeArchived || !g.archived) {
					out.push(g);
				}
				queue.push(g.id);
			}
		}
	}
	return out;
}

/**
 * Try to dispatch a nested-goal Phase-4 route. Returns `true` when the
 * route was matched and a response written; `false` when caller should
 * fall through to the next handler.
 */
export async function tryHandleNestedGoalRoute(
	req: http.IncomingMessage,
	url: URL,
	deps: NestedGoalRouteDeps,
): Promise<boolean> {
	const {
		projectContextManager,
		verificationHarness,
		teamManager,
		sessionManager,
		requireSubgoalsEnabled,
		getGoalAcrossProjects,
		getGoalManagerForGoal,
		readBody,
		json,
		jsonError,
		broadcastToAll,
		getSubgoalNestingPrefs,
	} = deps;

	const listDescendantsLocal = (goalId: string, opts?: { includeArchived?: boolean }): PersistedGoal[] =>
		listDescendants(projectContextManager, goalId, opts);

	/** Cancel any in-flight verifications for a goal (best-effort). */
	async function cancelAllVerifications(goalId: string): Promise<void> {
		for (const active of verificationHarness.getActiveVerifications(goalId)) {
			try {
				await verificationHarness.cancelStaleVerifications(goalId, active.gateId);
			} catch (err) {
				console.error(`[api] cancelAllVerifications: error cancelling verification for ${goalId}/${active.gateId}:`, err);
			}
		}
	}

	/**
	 * Apply a (validated) plan replacement to a parent-workflow goal.
	 * Updates the goal's workflow snapshot in place, persists, and
	 * broadcasts a `goal_state_changed` event.
	 */
	async function applyPlanSteps(
		goal: PersistedGoal,
		proposedSteps: ClassifierPlanStep[],
		goalManager: GoalManager,
	): Promise<{ workflow: Workflow }> {
		if (!goal.workflow) {
			throw new Error("applyPlanSteps: goal has no workflow snapshot");
		}
		const executionGate = goal.workflow.gates.find(g => g.id === "execution");
		if (!executionGate) {
			throw new Error("applyPlanSteps: workflow missing execution gate");
		}
		const newVerify = proposedSteps.map((s, idx) => {
			const depsTopLevel = s.dependsOn;
			const depsSubgoal = s.subgoal?.dependsOn;
			const stepDeps = depsTopLevel ?? depsSubgoal;
			return {
				name: s.title ?? s.subgoal?.title ?? `step-${idx}`,
				type: "subgoal" as const,
				phase: s.phase,
				subgoal: {
					planId: s.planId,
					title: s.title ?? s.subgoal?.title ?? "",
					spec: s.spec ?? s.subgoal?.spec ?? "",
					...(s.subgoal?.workflowId !== undefined ? { workflowId: s.subgoal.workflowId } : {}),
					...(s.subgoal?.suggestedRole !== undefined ? { suggestedRole: s.subgoal.suggestedRole } : {}),
					...(stepDeps !== undefined ? { dependsOn: stepDeps } : {}),
				},
			};
		});
		const updatedGate = { ...executionGate, verify: newVerify };
		const workflow: Workflow = {
			...goal.workflow,
			gates: goal.workflow.gates.map(g => g.id === "execution" ? updatedGate : g),
			updatedAt: Date.now(),
		};
		// Persist via store.update so updatedAt and generation tick.
		goalManager.getGoalStore().update(goal.id, { workflow });
		broadcastToAll({ type: "goal_state_changed", goalId: goal.id });
		return { workflow };
	}

	/** Read the current execution.verify[] subgoal-typed steps from a goal. */
	function readPlanSteps(goal: PersistedGoal): ClassifierPlanStep[] {
		const exec = goal.workflow?.gates.find(g => g.id === "execution");
		const verify = exec?.verify ?? [];
		return verify
			.filter(v => v.type === "subgoal" && v.subgoal)
			.map(v => ({
				planId: v.subgoal!.planId,
				title: v.subgoal!.title,
				spec: v.subgoal!.spec,
				phase: v.phase,
				...(v.subgoal!.dependsOn !== undefined ? { dependsOn: v.subgoal!.dependsOn } : {}),
				subgoal: {
					planId: v.subgoal!.planId,
					title: v.subgoal!.title,
					spec: v.subgoal!.spec,
					...(v.subgoal!.workflowId !== undefined ? { workflowId: v.subgoal!.workflowId } : {}),
					...(v.subgoal!.suggestedRole !== undefined ? { suggestedRole: v.subgoal!.suggestedRole } : {}),
					...(v.subgoal!.dependsOn !== undefined ? { dependsOn: v.subgoal!.dependsOn } : {}),
				},
			}));
	}

	// POST /api/goals/:id/spawn-child — idempotent on planId.
	const spawnChildMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/spawn-child$/);
	if (spawnChildMatch && req.method === "POST") {
		if (!requireSubgoalsEnabled()) return true;
		const parentId = spawnChildMatch[1];
		const parent = getGoalAcrossProjects(parentId);
		if (!parent) { json({ error: "Parent goal not found" }, 404); return true; }
		const body = await readBody(req).catch(() => null);
		if (!body) { json({ error: "Missing body" }, 400); return true; }
		const planId = typeof body.planId === "string" ? body.planId.trim() : "";
		const title = typeof body.title === "string" ? body.title.trim() : "";
		const spec = typeof body.spec === "string" ? body.spec : "";
		if (!planId) { json({ error: "planId is required" }, 400); return true; }
		if (!title) { json({ error: "title is required" }, 400); return true; }
		if (!spec) { json({ error: "spec is required" }, 400); return true; }
		// Optional explicit dependsOn (sibling planIds this child depends on).
		let dependsOn: string[] | undefined;
		if (Array.isArray((body as { dependsOn?: unknown }).dependsOn)) {
			dependsOn = ((body as { dependsOn: unknown[] }).dependsOn)
				.filter((d): d is string => typeof d === "string");
		}
		// QA-1: workflowId vs workflow.id alignment. The body's workflowId
		// (or "feature" fallback) is only authoritative when no inline
		// snapshot is in play; final assignment after resolution below.
		const bodyWorkflowId = typeof body.workflowId === "string" ? body.workflowId : undefined;
		const suggestedRole = typeof body.suggestedRole === "string" ? body.suggestedRole : undefined;
		// Caller (children-tools extension) may identify the spawning
		// team-lead session. Resolution is the four-tier cascade in
		// spawn-child-spawnedby.ts; the teamManager fallback fires for raw
		// cURL spawns lacking both header and body field.
		const spawnedByResolution = resolveSpawnedBySessionId({
			body,
			headers: req.headers as Record<string, string | string[] | undefined>,
			parentGoalId: parentId,
			teamManager,
		});
		const spawnedBySessionId = spawnedByResolution.value;

		const ctx = projectContextManager.getContextForGoal(parentId);
		if (!ctx) { json({ error: "Project context not found for parent goal" }, 404); return true; }
		const goalManager = ctx.goalManager;

		// Subgoal nesting-limit gate — single source of truth shared with
		// `runSubgoalStep`. Idempotency check below runs FIRST so that a
		// re-call with the same planId on an already-spawned child still
		// returns the existing id even when the limit would now reject a new
		// spawn. (See subgoal-nesting-limit.ts.)
		const nestingPrefs = getSubgoalNestingPrefs();

		// Idempotency: search for an existing child with this (parentId, planId).
		const siblings = ctx.goalStore.getAll().filter(g => g.parentGoalId === parentId);
		const existing = siblings.find(g => g.spawnedFromPlanId === planId);
		if (existing) {
			json({ id: existing.id, alreadyExists: true });
			return true;
		}

		// No existing child — enforce the nesting limit before spawn.
		const nestingCheck = checkCanSpawnChild(
			parent,
			nestingPrefs,
			(gid) => ctx.goalStore.get(gid),
		);
		if (!nestingCheck.ok) {
			if (nestingCheck.code === "SUBGOALS_DISABLED") {
				json({ error: "Subgoals are disabled for this goal tree", code: "SUBGOALS_DISABLED" }, 403);
				return true;
			}
			json({
				error: `Subgoal spawn blocked: nesting depth limit reached (${nestingCheck.currentDepth}/${nestingCheck.maxDepth})`,
				code: "NESTING_DEPTH_EXCEEDED",
				currentDepth: nestingCheck.currentDepth,
				maxDepth: nestingCheck.maxDepth,
			}, 403);
			return true;
		}

		// Validate dependsOn against existing siblings' planIds. Cross-call
		// cycles are caught proactively by replaying the implied DAG.
		if (dependsOn !== undefined) {
			const knownPlanIds = siblings
				.map(g => g.spawnedFromPlanId)
				.filter((p): p is string => typeof p === "string");
			const v = validateDependsOn({ planId, dependsOn, knownPlanIds });
			if (!v.ok) {
				json({ error: `dependsOn validation failed: ${v.code}`, code: v.code, ...(v.code === "SELF_DEPENDENCY" ? { planId: v.planId } : {}), ...(v.code === "UNKNOWN_PLAN_ID" ? { missing: v.missing } : {}) }, 400);
				return true;
			}
			const graph: { planId: string; dependsOn?: string[] }[] = siblings
				.filter(g => typeof g.spawnedFromPlanId === "string")
				.map(g => ({ planId: g.spawnedFromPlanId!, dependsOn: g.dependsOnPlanIds }));
			graph.push({ planId, dependsOn });
			const cycle = validatePlanDependsOn(graph);
			if (!cycle.ok && cycle.code === "DEPENDS_ON_CYCLE") {
				json({ error: `dependsOn validation failed: DEPENDS_ON_CYCLE`, code: "DEPENDS_ON_CYCLE", path: cycle.path }, 400);
				return true;
			}
		}

		try {
			// Children inherit the ROOT REPO path, not the parent's cwd:
			// a parent-worktree cwd would nest child worktrees and collapse
			// the branching topology. Preserve any monorepo subdir offset.
			let childCwd = parent.cwd;
			if (parent.repoPath) {
				const offset = parent.worktreePath
					? path.relative(parent.worktreePath, parent.cwd)
					: "";
				childCwd = (offset && offset !== "." && !offset.startsWith(".."))
					? path.join(parent.repoPath, offset)
					: parent.repoPath;
			}

			// Inline workflow resolution. Precedence: body.workflow →
			// parent.workflow (deep-cloned via stripSubgoalStepsForChildInheritance
			// so a parent meta-workflow's plan is dropped) → body.workflowId
			// (downstream lookup in goal-manager.createGoal).
			const inlineWorkflowBody = (body as { workflow?: unknown }).workflow;
			let resolvedWorkflowForChild: Workflow | undefined;
			if (inlineWorkflowBody && typeof inlineWorkflowBody === "object") {
				resolvedWorkflowForChild = inlineWorkflowBody as Workflow;
			} else if (parent.workflow) {
				resolvedWorkflowForChild = stripSubgoalStepsForChildInheritance(parent.workflow);
			}
			// QA-1: keep workflowId and workflow.id aligned.
			const workflowId = resolvedWorkflowForChild?.id ?? bodyWorkflowId ?? "feature";

			// Inline roles — merge parent's snapshot with the body's; child
			// overrides parent for same name. Mirrors goal.workflow snapshot.
			const bodyInlineRoles = (body as { inlineRoles?: unknown }).inlineRoles;
			let mergedInlineRoles: Record<string, import("./role-store.js").Role> | undefined;
			const parentInlineRoles = parent.inlineRoles;
			if (parentInlineRoles || (bodyInlineRoles && typeof bodyInlineRoles === "object" && !Array.isArray(bodyInlineRoles))) {
				mergedInlineRoles = {
					...(parentInlineRoles ?? {}),
					...((bodyInlineRoles && typeof bodyInlineRoles === "object" && !Array.isArray(bodyInlineRoles))
						? (bodyInlineRoles as Record<string, import("./role-store.js").Role>)
						: {}),
				};
			}

			// Propagate the parent's EFFECTIVE nesting limits onto the child so
			// descendants cannot loosen what an ancestor has tightened.
			const childOverrides = inheritedChildOverrides(parent, nestingPrefs);
			const child = await goalManager.createGoal(title, childCwd, {
				spec,
				workflowId,
				resolvedWorkflow: resolvedWorkflowForChild,
				projectId: parent.projectId,
				sandboxed: parent.sandboxed,
				parentGoalId: parentId,
				inlineRoles: mergedInlineRoles,
				subgoalsAllowed: childOverrides.subgoalsAllowed,
				maxNestingDepth: childOverrides.maxNestingDepth,
			});
			// stamp-immediately invariant: stamp spawnedFromPlanId IMMEDIATELY
			// — no awaits between. Persist suggestedRole + spawnedBySessionId
			// in the same atomic updateGoal so the sidebar can nest the child.
			await goalManager.updateGoal(child.id, {
				spawnedFromPlanId: planId,
				...(suggestedRole ? { suggestedRole } : {}),
				...(spawnedBySessionId ? { spawnedBySessionId } : {}),
				...(dependsOn !== undefined ? { dependsOnPlanIds: dependsOn } : {}),
			});
			// Initialize gate states for the child's workflow gates.
			// Without this, gate_list / gate_status / etc. see "no gates"
			// even when goal.workflow.gates is populated. The verification
			// harness also relies on these entries.
			if (child.workflow) {
				ctx.gateStore.initGatesForGoal(child.id, child.workflow.gates.map(g => g.id));
			}
			if (spawnedByResolution.tier === 5) {
				// Tier 5: orphan diagnostic. Single warn — never fail spawn.
				console.warn(`[spawn-child] spawnedBySessionId could not be derived for goal=${child.id} parent=${parentId}`);
			}
			broadcastToAll({ type: "goal_created", goalId: child.id, parentGoalId: parentId });
			json({ id: child.id, suggestedRole, spawnedBySessionId }, 201);

			// Trigger worktree setup + team start exactly like POST /api/goals.
			// Without this the child sits in setupStatus="preparing" forever.
			if (child.setupStatus === "preparing") {
				goalManager.setupWorktreeAndStartTeam(child.id, () => teamManager.startTeam(child.id))
					.then(() => {
						broadcastToAll({ type: "goal_setup_complete", goalId: child.id });
					})
					.catch((err) => {
						const g = goalManager.getGoal(child.id);
						if (g?.setupStatus === "ready") {
							broadcastToAll({ type: "goal_setup_complete", goalId: child.id });
							console.error(`[spawn-child] Auto-start team failed for ${child.id} (worktree ready):`, err);
						} else {
							console.error(`[spawn-child] Setup failed for ${child.id}:`, err);
							broadcastToAll({ type: "goal_setup_error", goalId: child.id, error: String(err) });
						}
					});
			}
		} catch (err) {
			// createGoal throws on cycle violations and missing parent.
			jsonError(400, err);
		}
		return true;
	}

	// Shared lookup for GET / PATCH `/api/goals/:id/plan`.
	type PlanContext = NonNullable<ReturnType<typeof projectContextManager.getContextForGoal>>;
	const resolvePlanContext = (id: string): { goal: PersistedGoal; ctx: PlanContext } | null => {
		const g = getGoalAcrossProjects(id);
		if (!g) { json({ error: "Goal not found" }, 404); return null; }
		const c = projectContextManager.getContextForGoal(id);
		if (!c) { json({ error: "Project context not found for goal" }, 404); return null; }
		return { goal: g, ctx: c };
	};

	// PATCH /api/goals/:id/plan — submit a plan or replan; classifier-driven.
	const planPatchMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/plan$/);
	if (planPatchMatch && req.method === "PATCH") {
		if (!requireSubgoalsEnabled()) return true;
		const id = planPatchMatch[1];
		const resolved = resolvePlanContext(id);
		if (!resolved) return true;
		const { goal } = resolved;
		// Plan-propose requires a workflow with an `execution` gate.
		const hasExecutionGate = !!goal.workflow?.gates.some(g => g.id === "execution");
		if (!hasExecutionGate) {
			json({
				error: `Goal's workflow (${goal.workflowId ?? "unknown"}) has no 'execution' gate to hold a subgoal plan. Either re-create the goal with the 'parent' workflow, or call goal_spawn_child directly for each step.`,
				code: "NO_EXECUTION_GATE",
			}, 400);
			return true;
		}
		const body = await readBody(req).catch(() => null);
		if (!body || !Array.isArray(body.proposedSteps)) {
			json({ error: "proposedSteps[] is required" }, 400);
			return true;
		}
		// R-015: validate each proposed step's shape so a malformed item
		// surfaces as a precise 400 rather than a confusing 409 RESTRUCTURE.
		for (let i = 0; i < body.proposedSteps.length; i++) {
			const s = body.proposedSteps[i] as Partial<ClassifierPlanStep> & { subgoal?: { spec?: unknown } } | null;
			if (!s || typeof s !== "object") {
				json({ error: `proposedSteps[${i}] must be an object`, code: "INVALID_PLAN_STEP", index: i }, 400);
				return true;
			}
			if (typeof s.planId !== "string" || s.planId.length === 0) {
				json({ error: `proposedSteps[${i}].planId must be a non-empty string`, code: "INVALID_PLAN_STEP", index: i }, 400);
				return true;
			}
			if (typeof s.title !== "string" || s.title.length === 0) {
				json({ error: `proposedSteps[${i}].title must be a non-empty string`, code: "INVALID_PLAN_STEP", index: i }, 400);
				return true;
			}
			const hasTopSpec = typeof s.spec === "string" && s.spec.length > 0;
			const hasSubgoalSpec = !!s.subgoal && typeof s.subgoal.spec === "string" && (s.subgoal.spec as string).length > 0;
			if (!hasTopSpec && !hasSubgoalSpec) {
				json({ error: `proposedSteps[${i}] must provide either spec or subgoal.spec`, code: "INVALID_PLAN_STEP", index: i }, 400);
				return true;
			}
		}
		const proposedSteps = body.proposedSteps as ClassifierPlanStep[];

		// Validate explicit dependsOn references on the proposed plan.
		const depsValidation = validatePlanDependsOn(
			proposedSteps.map(s => ({
				planId: s.planId,
				dependsOn: s.dependsOn ?? s.subgoal?.dependsOn,
			})),
		);
		if (!depsValidation.ok) {
			const code = depsValidation.code;
			const payload: Record<string, unknown> = { error: `dependsOn validation failed: ${code}`, code };
			if (code === "SELF_DEPENDENCY") payload.planId = depsValidation.planId;
			if (code === "UNKNOWN_PLAN_ID") payload.missing = depsValidation.missing;
			if (code === "DEPENDS_ON_CYCLE") payload.path = depsValidation.path;
			json(payload, 400);
			return true;
		}

		const ctx = resolved.ctx;
		const planMutationStore = ctx.planMutationStore;
		const goalManager = ctx.goalManager;

		// Locate root for criteria source.
		const rootGoalId = goal.rootGoalId ?? goal.id;
		const root = ctx.goalStore.get(rootGoalId) ?? goal;
		const criteria = root.acceptanceCriteria ?? parseAcceptanceCriteria(root.spec ?? "");

		const current = readPlanSteps(goal);
		const verdict = classifyMutation({
			current,
			proposed: proposedSteps,
			rootAcceptanceCriteria: criteria,
			rootSpec: root.spec ?? "",
		});

		const policy = goal.divergencePolicy ?? "balanced";

		// Decision matrix — see docs/nested-goals.md#mutation-classifier.
		// criteria-drop is the only kind that's always 409.
		if (verdict.kind === "criteria-drop") {
			json({
				kind: verdict.kind,
				summary: verdict.summary,
				diff: verdict.diff,
				uncoveredCriteria: verdict.uncoveredCriteria,
				code: "CRITERIA_DROP",
				error: "Plan would leave acceptance criteria uncovered",
			}, 409);
			return true;
		}

		// restructure: 409 unless paused.
		if (verdict.kind === "restructure" && !goal.paused) {
			json({
				kind: verdict.kind,
				summary: verdict.summary,
				diff: verdict.diff,
				code: "RESTRUCTURE_REQUIRES_PAUSE",
				error: "Restructure requires the goal to be paused first",
			}, 409);
			return true;
		}

		// noop: apply directly (no-op effectively).
		if (verdict.kind === "noop") {
			json({ kind: verdict.kind, summary: verdict.summary, applied: true });
			return true;
		}

		// fix-up under balanced/autonomous → apply directly. strict → approval.
		if (verdict.kind === "fix-up" && (policy === "balanced" || policy === "autonomous")) {
			try {
				await applyPlanSteps(goal, proposedSteps, goalManager);
				await goalManager.updateGoal(goal.id, { replanCount: (goal.replanCount ?? 0) + 1 });
				json({ kind: verdict.kind, summary: verdict.summary, applied: true });
			} catch (err) {
				jsonError(500, err);
			}
			return true;
		}

		// expansion always, restructure on paused, fix-up on strict → approval.
		const requestId = randomUUID();
		const now = Date.now();
		const pending: PendingMutation = {
			goalId: goal.id,
			requestId,
			kind: verdict.kind,
			proposedSteps,
			summary: verdict.summary,
			diff: verdict.diff,
			...(verdict.uncoveredCriteria ? { uncoveredCriteria: verdict.uncoveredCriteria } : {}),
			createdAt: now,
			expiresAt: now + DEFAULT_MUTATION_TTL_MS,
		};
		planMutationStore.put(pending);
		broadcastToAll({
			type: "mutation_pending",
			goalId: goal.id,
			requestId,
			kind: verdict.kind,
			summary: verdict.summary,
		});
		json({
			kind: verdict.kind,
			summary: verdict.summary,
			diff: verdict.diff,
			requestId,
			requiresApproval: true,
		});
		return true;
	}

	// GET /api/goals/:id/plan — return the current plan + per-step child projection.
	const planGetMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/plan$/);
	if (planGetMatch && req.method === "GET") {
		if (!requireSubgoalsEnabled()) return true;
		const id = planGetMatch[1];
		const resolved = resolvePlanContext(id);
		if (!resolved) return true;
		const { goal, ctx } = resolved;
		const gateId = url.searchParams.get("gateId") ?? "execution";
		const gate = goal.workflow?.gates.find(g => g.id === gateId);
		const verify = gate?.verify ?? [];
		const steps = verify
			.filter(v => v.type === "subgoal" && v.subgoal)
			.map(v => {
				const sg = v.subgoal!;
				// R-004: route the tier resolution through the harness's
				// canonical implementation so renderer / server / harness
				// agree. The harness covers tiers 1, 1.5, 2, 3, 4, 5.
				const { child } = verificationHarness.resolvePlanStepChild(id, sg.planId, {
					expectedTitle: sg.title,
				});
				return {
					planId: sg.planId,
					title: sg.title,
					spec: sg.spec,
					phase: v.phase,
					...(sg.workflowId !== undefined ? { workflowId: sg.workflowId } : {}),
					...(sg.suggestedRole !== undefined ? { suggestedRole: sg.suggestedRole } : {}),
					...(child ? {
						childGoalId: child.id,
						childState: child.state,
						childArchived: !!child.archived,
					} : {}),
				};
			});
		const gateState = ctx.gateStore.getGate(id, gateId)?.status ?? "pending";
		const frozen = gate?.metadata?.frozen === "true";
		json({
			steps,
			gateState,
			frozen,
			replanCount: goal.replanCount ?? 0,
		});
		return true;
	}

	// POST /api/goals/:id/integrate-child/:childId — local merge + auto-archive.
	const integrateChildMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/integrate-child\/([^/]+)$/);
	if (integrateChildMatch && req.method === "POST") {
		if (!requireSubgoalsEnabled()) return true;
		const parentId = integrateChildMatch[1];
		const childId = integrateChildMatch[2];
		const parent = getGoalAcrossProjects(parentId);
		const child = getGoalAcrossProjects(childId);
		if (!parent) { json({ error: "Parent goal not found" }, 404); return true; }
		if (!child) { json({ error: "Child goal not found" }, 404); return true; }
		// Security: child must declare us as parent.
		if (child.parentGoalId !== parentId) {
			json({ error: `Child ${childId} parentGoalId="${child.parentGoalId}" does not match path parent ${parentId}`, code: "PARENT_MISMATCH" }, 400);
			return true;
		}
		const ctx = projectContextManager.getContextForGoal(parentId);
		if (!ctx) { json({ error: "Project context not found" }, 404); return true; }
		const goalManager = ctx.goalManager;
		// R-005: refuse to merge a child whose ready-to-merge gate has not
		// passed. Override via `body.force === true` for recovery flows.
		const integrateBody = await readBody(req).catch(() => null);
		const force = integrateBody && (integrateBody as { force?: unknown }).force === true;
		if (!force) {
			const rtm = ctx.gateStore.getGate(childId, "ready-to-merge");
			if (!rtm || rtm.status !== "passed") {
				json({
					error: `Child ${childId}'s ready-to-merge gate has not passed (status=${rtm?.status ?? "unset"}). Pass body.force=true to override.`,
					code: "RTM_NOT_PASSED",
					childGoalId: childId,
					rtmStatus: rtm?.status ?? null,
				}, 409);
				return true;
			}
		}
		try {
			const outcome = await goalManager.mergeChild(parentId, childId);
			if (outcome.merged || outcome.alreadyMerged) {
				try { await teamManager.teardownTeam(childId); } catch (err) {
					console.warn(`[api] integrate-child: teardownTeam error (non-fatal):`, err);
				}
				await goalManager.archiveGoalAfterMerge(childId);
				broadcastToAll({ type: "goal_state_changed", goalId: childId });
				broadcastToAll({ type: "goal_state_changed", goalId: parentId });
				json({ merged: true, alreadyMerged: !!outcome.alreadyMerged, pushed: !!outcome.pushed });
				return true;
			}
			if (outcome.conflict) {
				json({ conflict: true, output: outcome.output ?? "" }, 409);
				return true;
			}
			json({ error: "Unexpected merge outcome", output: outcome.output ?? "" }, 500);
		} catch (err) {
			const code = (err as any)?.code;
			if (code === "PARENT_MISMATCH") { jsonError(400, err, { code }); return true; }
			jsonError(500, err);
		}
		return true;
	}

	// POST /api/goals/:id/pause — cascade required.
	const pauseMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/pause$/);
	if (pauseMatch && req.method === "POST") {
		if (!requireSubgoalsEnabled()) return true;
		const id = pauseMatch[1];
		const goal = getGoalAcrossProjects(id);
		if (!goal) { json({ error: "Goal not found" }, 404); return true; }
		const body = await readBody(req).catch(() => null);
		if (!body || typeof body.cascade !== "boolean") {
			json({ error: "cascade (boolean) is required", code: "CASCADE_REQUIRED" }, 422);
			return true;
		}
		const cascade: boolean = body.cascade;
		const goalManager = getGoalManagerForGoal(id);
		const targets: PersistedGoal[] = [goal, ...(cascade ? listDescendantsLocal(id) : [])];
		let count = 0;
		for (const g of targets) {
			// R-039: symmetric with resume's `if (!g.paused) continue;`.
			if (g.paused) continue;
			await goalManager.updateGoal(g.id, { paused: true });
			await cancelAllVerifications(g.id);
			broadcastToAll({ type: "goal_state_changed", goalId: g.id });
			count++;
		}
		json({ paused: count });
		return true;
	}

	// POST /api/goals/:id/resume — cascade required.
	const resumeMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/resume$/);
	if (resumeMatch && req.method === "POST") {
		if (!requireSubgoalsEnabled()) return true;
		const id = resumeMatch[1];
		const goal = getGoalAcrossProjects(id);
		if (!goal) { json({ error: "Goal not found" }, 404); return true; }
		const body = await readBody(req).catch(() => null);
		if (!body || typeof body.cascade !== "boolean") {
			json({ error: "cascade (boolean) is required", code: "CASCADE_REQUIRED" }, 422);
			return true;
		}
		const cascade: boolean = body.cascade;
		const goalManager = getGoalManagerForGoal(id);
		const targets: PersistedGoal[] = [goal, ...(cascade ? listDescendantsLocal(id) : [])];
		let count = 0;
		for (const g of targets) {
			// R-039: symmetric with the pause loop above.
			if (!g.paused) continue;
			await goalManager.updateGoal(g.id, { paused: false });
			broadcastToAll({ type: "goal_state_changed", goalId: g.id });
			count++;
		}
		json({ resumed: count });
		return true;
	}

	// POST /api/goals/:id/mutation/:requestId/decision — approve/reject queued mutation.
	const mutationDecisionMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/mutation\/([^/]+)\/decision$/);
	if (mutationDecisionMatch && req.method === "POST") {
		if (!requireSubgoalsEnabled()) return true;
		const goalId = mutationDecisionMatch[1];
		const requestId = mutationDecisionMatch[2];
		// R-018: requestId is implicitly scoped to goalId via the store key
		// (goalId, requestId) — a cross-goal requestId 404s naturally.
		const goal = getGoalAcrossProjects(goalId);
		if (!goal) { json({ error: "Goal not found" }, 404); return true; }
		const body = await readBody(req).catch(() => null);
		const decision = body?.decision;
		if (decision !== "approve" && decision !== "reject") {
			json({ error: "decision must be 'approve' or 'reject'" }, 400);
			return true;
		}
		const ctx = projectContextManager.getContextForGoal(goalId);
		if (!ctx) { json({ error: "Project context not found" }, 404); return true; }
		const planMutationStore = ctx.planMutationStore;
		const goalManager = ctx.goalManager;
		const pending = planMutationStore.get(goalId, requestId);
		if (!pending) { json({ error: "Mutation request not found", code: "REQUEST_NOT_FOUND" }, 404); return true; }
		if (decision === "reject") {
			planMutationStore.remove(goalId, requestId);
			broadcastToAll({ type: "mutation_decided", goalId, requestId, decision });
			json({ applied: false });
			return true;
		}
		// approve: apply the proposed steps and bump replanCount.
		try {
			await applyPlanSteps(goal, pending.proposedSteps, goalManager);
			const newReplanCount = (goal.replanCount ?? 0) + 1;
			const updates: { replanCount: number; paused?: boolean } = { replanCount: newReplanCount };
			if (newReplanCount > 5 && !goal.paused) updates.paused = true;
			await goalManager.updateGoal(goal.id, updates);
			planMutationStore.remove(goalId, requestId);
			broadcastToAll({ type: "mutation_decided", goalId, requestId, decision, autoPaused: !!updates.paused });
			// Cross-team propagation: when a child goal is auto-paused,
			// notify the PARENT's team-lead — without this the parent sits
			// idle indefinitely after the replan-overflow tripwire fires.
			if (updates.paused) {
				try {
					const { buildParentPausedNotification } = await import("./notify-team-lead-child-passed.js");
					const parentNotify = buildParentPausedNotification(goal, "replan-overflow");
					if (parentNotify) {
						const team = teamManager.getTeamState(parentNotify.parentGoalId);
						if (team?.teamLeadSessionId) {
							const tlSess = sessionManager.getSession(team.teamLeadSessionId);
							if (tlSess && tlSess.status !== "terminated") {
								if (tlSess.status === "streaming") {
									sessionManager.deliverLiveSteer(team.teamLeadSessionId, parentNotify.message).catch(() => {});
								} else {
									sessionManager.enqueuePrompt(team.teamLeadSessionId, parentNotify.message, { isSteered: true }).catch(() => {});
								}
							}
						}
					}
				} catch (err) {
					console.warn("[plan-mutation] Failed to notify parent of auto-pause:", err);
				}
			}
			json({ applied: true, replanCount: newReplanCount, autoPaused: !!updates.paused });
		} catch (err) {
			jsonError(500, err);
		}
		return true;
	}

	// PATCH /api/goals/:id/policy — set divergencePolicy / maxConcurrentChildren.
	const policyMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/policy$/);
	if (policyMatch && req.method === "PATCH") {
		if (!requireSubgoalsEnabled()) return true;
		const id = policyMatch[1];
		const goal = getGoalAcrossProjects(id);
		if (!goal) { json({ error: "Goal not found" }, 404); return true; }
		const body = await readBody(req).catch(() => null);
		if (!body) { json({ error: "Missing body" }, 400); return true; }
		const goalManager = getGoalManagerForGoal(id);
		const updates: { divergencePolicy?: "strict" | "balanced" | "autonomous"; maxConcurrentChildren?: number } = {};
		if (body.divergencePolicy !== undefined) {
			if (body.divergencePolicy !== "strict" && body.divergencePolicy !== "balanced" && body.divergencePolicy !== "autonomous") {
				json({ error: "divergencePolicy must be one of strict|balanced|autonomous" }, 400);
				return true;
			}
			updates.divergencePolicy = body.divergencePolicy;
		}
		if (body.maxConcurrentChildren !== undefined) {
			const n = Number(body.maxConcurrentChildren);
			if (!Number.isFinite(n) || n < 1 || n > 8) {
				json({ error: "maxConcurrentChildren must be a number in [1, 8]" }, 400);
				return true;
			}
			updates.maxConcurrentChildren = n;
		}
		await goalManager.updateGoal(id, updates);
		// R-017: include the new policy values in the broadcast so clients
		// don't need to re-fetch the goal record on every policy change.
		const updatedGoal = getGoalAcrossProjects(id);
		broadcastToAll({
			type: "goal_state_changed",
			goalId: id,
			...(updatedGoal?.divergencePolicy !== undefined ? { divergencePolicy: updatedGoal.divergencePolicy } : {}),
			...(updatedGoal?.maxConcurrentChildren !== undefined ? { maxConcurrentChildren: updatedGoal.maxConcurrentChildren } : {}),
		});
		json({ ok: true });
		return true;
	}

	return false;
}
