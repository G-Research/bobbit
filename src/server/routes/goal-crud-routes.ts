// src/server/routes/goal-crud-routes.ts
//
// STR-01 goals cohort G2a: goal CRUD-core create/read/update routes migrated
// out of handleApiRoute's legacy if/else chain into the core route registry.
// See docs/design/route-registry.md.
//
// Mechanical extraction — handler bodies below preserve the legacy behavior,
// with only handleApiRoute locals destructured from ctx and registry params
// replacing regex captures.

import { createHash } from "node:crypto";
import { authorizeChildrenMutation } from "../auth/children-mutation-authz.js";
import { tryAuth as cookieTryAuth } from "../auth/cookie.js";
import { GoalPausedError, requireAncestorsNotPaused } from "../agent/goal-paused-guard.js";
import { resolveProjectForRequest, validateExecutionCwd } from "../agent/resolve-project.js";
import { readSubgoalNestingPrefs, checkCanSpawnChild, inheritedChildOverrides, clampMaxDepth } from "../agent/subgoal-nesting-limit.js";
import type { PersistedGoal } from "../agent/goal-store.js";
import type { Role } from "../agent/role-store.js";
import type { Workflow } from "../agent/workflow-store.js";
import type { CoreRouteCtx } from "./core-route-ctx.js";
import type { RouteTable } from "./route-table.js";

// POST /api/goals
async function handleGoalsCreate(routeCtx: CoreRouteCtx): Promise<void> {
	const {
		broadcastToAll,
		configCascade,
		cookieStore,
		defaultCwd,
		getGoalAcrossProjects,
		json,
		jsonError,
		preferencesStore,
		projectContextManager,
		projectRegistry,
		readBody,
		req,
		sandboxManager,
		sessionManager,
		teamManager,
		verificationHarness,
		writeCwdValidationError,
		writeProjectResolutionError,
	} = routeCtx;
	const body = await readBody(req);
	const title = body?.title;
	const explicitCwd = typeof body?.cwd === "string" && body.cwd.trim().length > 0
		? body.cwd.trim()
		: undefined;
	let cwd = explicitCwd || defaultCwd;
	const spec = body?.spec || "";
	const workflowId = typeof body?.workflowId === "string" && body.workflowId.trim().length > 0
		? body.workflowId.trim()
		: undefined;
	if (!title || typeof title !== "string") {
		json({ error: "Missing title" }, 400);
		return;
	}
	try {
		const sandboxed = body.sandboxed === true;
		const autoStartTeam = body.autoStartTeam !== false; // default true
		// Per-goal metadata (optional, arbitrary namespaced key/value bag, e.g.
		// `bobbit.disabledTools`, `hindsight.memory.enabled`). Accepted only as a
		// NON-EMPTY plain object; passed verbatim to createGoal where it is
		// persisted and resolved hierarchically down the goal tree. Supersedes the
		// removed per-goal worktree-setup hook (PR #816); legacy
		// `worktreeSetupCommand`/`worktreeSetupTimeoutMs` body fields are now
		// ignored (no parse, no persistence). Component-level
		// `worktree_setup_command` is unaffected.
		let metadata: Record<string, unknown> | undefined;
		{
			const raw = body.metadata;
			if (raw && typeof raw === "object" && !Array.isArray(raw) && Object.keys(raw as object).length > 0) {
				metadata = raw as Record<string, unknown>;
			}
		}
		let enabledOptionalSteps: string[] | undefined;
		if (Array.isArray(body.enabledOptionalSteps) && body.enabledOptionalSteps.every((s: unknown) => typeof s === "string")) {
			enabledOptionalSteps = body.enabledOptionalSteps;
		}
		const resolved = resolveProjectForRequest(projectRegistry, { projectId: body.projectId });
		if (!resolved.ok) { writeProjectResolutionError(resolved); return; }
		const targetProjectId = resolved.projectId;
		if (!explicitCwd) cwd = resolved.project.rootPath;
		const cwdValidation = validateExecutionCwd(projectRegistry, projectContextManager, targetProjectId, cwd, { kind: "user-input" });
		if (!cwdValidation.ok) { writeCwdValidationError(cwdValidation); return; }
		const targetCtx = projectContextManager.getOrCreate(targetProjectId);
		if (!targetCtx) {
			json({ error: "Invalid project" }, 400);
			return;
		}
		// Lazy per-project sandbox init — idempotent, deduped by SandboxManager.
		if (sandboxed && sandboxManager) {
			try {
				await sandboxManager.ensureForProject(targetProjectId);
			} catch (err) {
				jsonError(500, err, { error: `Sandbox init failed: ${(err as Error).message || err}` });
				return;
			}
		}
		const targetGoalManager = targetCtx.goalManager;
		// Handle parentGoalId — depth cap validation (same gate as goal_spawn_child).
		const parentGoalId = (body?.parentGoalId && typeof body.parentGoalId === "string") ? body.parentGoalId.trim() : undefined;
		let resolvedParentGoal: PersistedGoal | undefined;
		if (parentGoalId) {
			// Parent MUST be in the same project context — cross-project hierarchy
			// would corrupt the parentGoalId chain because createGoal only walks
			// its own store. Reject cross-project parents with a clear 422.
			resolvedParentGoal = targetGoalManager.getGoal(parentGoalId);
			if (!resolvedParentGoal) {
				const crossProject = getGoalAcrossProjects(parentGoalId);
				if (crossProject) {
					json({ error: "Parent goal belongs to a different project. Select a parent in the same project.", code: "PARENT_CROSS_PROJECT" }, 422);
				} else {
					json({ error: "Parent goal not found", code: "PARENT_NOT_FOUND" }, 422);
				}
				return;
			}
			// S1 SECURITY: creating a child via `POST /api/goals` with a
			// `parentGoalId` is a Children mutation — it spawns and can
			// auto-start a child team under another goal. It MUST be
			// authorized like the other Children verbs BEFORE anything is
			// created/started; previously this path validated parent
			// existence + nesting + pause then created the child with NO
			// authz, letting any shared-bearer-token holder (incl. a
			// non-team-lead agent) drive child creation under an arbitrary
			// goal and bypass the Children tool policy + per-session secret
			// binding. This is an OPERATOR-class verb: the proposal UI drives
			// it (verified human cookie accepted), otherwise the AUTHENTIC
			// caller (derived server-side from the unforgeable per-session
			// secret, never the public spawning-session header) must match
			// the team-lead of the parent's ROOT goal. See
			// children-mutation-authz.ts.
			{
				const h = req.headers as Record<string, string | string[] | undefined>;
				const readHeader = (n: string): string | undefined => {
					const v = h[n.toLowerCase()];
					const s = Array.isArray(v) ? v[0] : v;
					return typeof s === "string" && s.trim() ? s.trim() : undefined;
				};
				const rootGoalId = resolvedParentGoal.rootGoalId ?? resolvedParentGoal.id;
				const authz = authorizeChildrenMutation({
					mutationClass: "operator",
					isHumanOperator: cookieTryAuth(req, cookieStore!),
					// Derive the AUTHENTIC caller from the per-session secret,
					// never the forgeable public spawning-session header.
					authenticCallerSessionId: sessionManager.sessionSecretStore.resolveSessionIdBySecret(
						readHeader("x-bobbit-session-secret"),
					),
					teamLeadSessionId: teamManager.getTeamState(rootGoalId)?.teamLeadSessionId,
				});
				if (!authz.ok) {
					json({
						error: "Caller session is not the team-lead for this goal",
						code: "NOT_TEAM_LEAD",
						goalId: parentGoalId,
					}, 403);
					return;
				}
			}
			// Pause-cascade (Finding 1): refuse to create/auto-start a child
			// under a paused parent OR any paused ancestor. Mirrors the
			// guarantee `/spawn-child` and the harness `runSubgoalStep` already
			// enforce — `POST /api/goals` with `parentGoalId` previously
			// bypassed it entirely (validated parent existence + nesting, then
			// created + auto-started the child). The walk is cycle-guarded.
			try {
				requireAncestorsNotPaused(
					parentGoalId,
					(id) => targetGoalManager.getGoal(id) ?? getGoalAcrossProjects(id),
				);
			} catch (err) {
				if (err instanceof GoalPausedError) {
					json({ error: err.message, code: err.code, goalId: err.goalId }, 409);
					return;
				}
				throw err;
			}
			const prefs = readSubgoalNestingPrefs((k) => preferencesStore.get(k));
			const nestResult = checkCanSpawnChild(
				resolvedParentGoal,
				prefs,
				(id) => targetGoalManager.getGoal(id) ?? getGoalAcrossProjects(id),
			);
			if (!nestResult.ok) {
				if (nestResult.code === "SUBGOALS_DISABLED") {
					json({ error: "Subgoals are disabled", code: "SUBGOALS_DISABLED" }, 422);
					return;
				}
				if (nestResult.code === "PARENT_SUBGOALS_DISABLED") {
					json({
						error: `Parent goal "${resolvedParentGoal.title}" doesn't allow sub-goals`,
						code: "PARENT_SUBGOALS_DISABLED",
					}, 422);
					return;
				}
				if (nestResult.code === "NESTING_DEPTH_EXCEEDED") {
					json({
						error: `Nesting depth cap reached: ${nestResult.currentDepth} / ${nestResult.maxDepth}`,
						code: "NESTING_DEPTH_EXCEEDED",
						currentDepth: nestResult.currentDepth,
						maxDepth: nestResult.maxDepth,
					}, 422);
					return;
				}
			}
		}
		// Cascade: body.workflow (inline snapshot) -> explicit workflowId lookup -> first store workflow.
		let resolvedWorkflow: Workflow | undefined;
		let resolvedWorkflowId: string | undefined = workflowId;
		const inlineWorkflow = body?.workflow;
		if (inlineWorkflow && typeof inlineWorkflow === "object") {
			resolvedWorkflow = inlineWorkflow as Workflow;
			const inlineWorkflowId = (inlineWorkflow as { id?: string }).id;
			resolvedWorkflowId = (typeof inlineWorkflowId === "string" && inlineWorkflowId.trim().length > 0)
				? inlineWorkflowId.trim()
				: workflowId;
			if (!resolvedWorkflowId) {
				json({ error: "Inline workflow must include an id or workflowId", code: "WORKFLOW_ID_REQUIRED" }, 400);
				return;
			}
		} else {
			// Layer 1: cascade lookup (only when workflowId given).
			if (workflowId) {
				const cascadeWorkflows = configCascade.resolveWorkflows(targetProjectId);
				resolvedWorkflow = cascadeWorkflows.find(r => r.item.id === workflowId)?.item;
				// Layer 1b: cascade miss — fall through to project store directly.
				if (!resolvedWorkflow) {
					resolvedWorkflow = targetCtx.workflowStore.get(workflowId);
				}
			}
			const storedWorkflows = targetCtx.workflowStore.getAll();
			// Layer 2: no explicit id -> first workflow in store order.
			if (!workflowId && !resolvedWorkflow) {
				resolvedWorkflow = storedWorkflows[0];
				resolvedWorkflowId = resolvedWorkflow?.id;
			}
			if (!resolvedWorkflow || !resolvedWorkflowId) {
				if (workflowId) {
					const available = storedWorkflows.map(w => w.id);
					jsonError(400, new Error(`Workflow "${workflowId}" not found`), {
						error: available.length > 0
							? `Workflow "${workflowId}" not found. Available: ${available.join(", ")}`
							: "This project has no workflows configured. Run project setup or generate workflows from Settings -> project tab.",
						code: available.length > 0 ? "WORKFLOW_NOT_FOUND" : "NO_WORKFLOWS",
						workflowId,
						available,
					});
					return;
				}
				jsonError(400, new Error("This project has no workflows configured. Run project setup or generate workflows from Settings -> project tab."), {
					error: "This project has no workflows configured. Run project setup or generate workflows from Settings -> project tab.",
					code: "NO_WORKFLOWS",
					available: [],
				});
				return;
			}
		}
		// Resolve per-goal subgoal-nesting overrides.
		//
		// Two inputs: the parent's effective inherited ceiling (if any) and the
		// explicit body values from the proposal form. Rules:
		//   - System pref is the global ceiling (subgoalsEnabled gate + maxDepth cap).
		//   - For child goals the parent's effective values are also a ceiling.
		//   - Explicit body values can only tighten/disable, never exceed the ceiling.
		// Helpers from subgoal-nesting-limit.ts compute the ceiling so this stays
		// the single source of truth.
		const nestingPrefs = readSubgoalNestingPrefs((k) => preferencesStore.get(k));
		const inheritedNesting = (parentGoalId && resolvedParentGoal)
			? inheritedChildOverrides(
				resolvedParentGoal,
				nestingPrefs,
				(id) => targetGoalManager.getGoal(id) ?? getGoalAcrossProjects(id),
			)
			: undefined;
		const ceilSubgoalsAllowed = inheritedNesting
			? inheritedNesting.subgoalsAllowed
			: nestingPrefs.subgoalsEnabled;
		const ceilMaxNestingDepth = inheritedNesting
			? inheritedNesting.maxNestingDepth
			: nestingPrefs.maxNestingDepth;
		const bodySubgoalsAllowedRaw = body?.subgoalsAllowed;
		const bodyMaxNestingDepthRaw = body?.maxNestingDepth;
		let effSubgoalsAllowed: boolean | undefined = inheritedNesting?.subgoalsAllowed;
		if (typeof bodySubgoalsAllowedRaw === "boolean") {
			// body=false always wins (disable always allowed); body=true only if
			// the ceiling permits it. System/parent OFF blocks the explicit true.
			effSubgoalsAllowed = bodySubgoalsAllowedRaw && ceilSubgoalsAllowed;
		}
		let effMaxNestingDepth: number | undefined = inheritedNesting?.maxNestingDepth;
		if (typeof bodyMaxNestingDepthRaw === "number" && Number.isFinite(bodyMaxNestingDepthRaw)) {
			effMaxNestingDepth = Math.min(clampMaxDepth(bodyMaxNestingDepthRaw), ceilMaxNestingDepth);
		}
		const bodyInlineRoles = (body?.inlineRoles && typeof body.inlineRoles === "object" && !Array.isArray(body.inlineRoles))
			? body.inlineRoles as Record<string, Role>
			: undefined;
		// Root-only orchestration policy. Only honoured for top-level goals
		// (no parentGoalId); children inherit the root's values. Mirrors the
		// validation in PATCH /api/goals/:id/policy.
		const isRootGoalCreate = parentGoalId === undefined;
		let effDivergencePolicy: "strict" | "balanced" | "autonomous" | undefined;
		if (isRootGoalCreate && (body?.divergencePolicy === "strict" || body?.divergencePolicy === "balanced" || body?.divergencePolicy === "autonomous")) {
			effDivergencePolicy = body.divergencePolicy;
		}
		let effMaxConcurrentChildren: number | undefined;
		if (isRootGoalCreate && typeof body?.maxConcurrentChildren === "number" && Number.isFinite(body.maxConcurrentChildren)) {
			const n = Math.floor(body.maxConcurrentChildren);
			if (n >= 1 && n <= 8) effMaxConcurrentChildren = n;
		}
		const explicitWorktree = typeof body?.worktree === "boolean" ? body.worktree : undefined;
		const goal = await targetGoalManager.createGoal(title, cwd, {
			spec,
			workflowId: resolvedWorkflowId,
			workflowStore: targetCtx.workflowStore,
			resolvedWorkflow,
			sandboxed,
			enabledOptionalSteps,
			projectId: targetProjectId,
			parentGoalId,
			inlineRoles: bodyInlineRoles,
			subgoalsAllowed: effSubgoalsAllowed,
			maxNestingDepth: effMaxNestingDepth,
			divergencePolicy: effDivergencePolicy,
			maxConcurrentChildren: effMaxConcurrentChildren,
			metadata,
			worktree: explicitWorktree,
		});
		// Set projectId from the explicit request scope.
		if (targetProjectId) {
			targetGoalManager.updateGoal(goal.id, { projectId: targetProjectId });
			goal.projectId = targetProjectId;
		}
		// Set reattemptOf if provided
		if (body.reattemptOf && typeof body.reattemptOf === "string") {
			targetGoalManager.updateGoal(goal.id, { reattemptOf: body.reattemptOf });
			goal.reattemptOf = body.reattemptOf;
		}
		// Persist autoStartTeam flag
		targetGoalManager.updateGoal(goal.id, { autoStartTeam });
		goal.autoStartTeam = autoStartTeam;
		// Initialize gate states for the workflow
		if (goal.workflow) {
			targetCtx.gateStore.initGatesForGoal(goal.id, goal.workflow.gates.map(g => g.id));
		}
		json(goal, 201);

		// Fire-and-forget async worktree setup (and optionally start team)
		if (goal.autoStartTeam && parentGoalId) {
			// Finding 2 — a child goal auto-start must go through the
			// unified per-root scheduler so the concurrency cap applies to
			// the `POST /api/goals` child path too (previously it started
			// the team with NO permit). At cap the child is parked
			// `state='blocked'` (capacity-blocked) and started later when a
			// permit frees; the scheduler handles setup + broadcasts.
			//
			// Guard is `state !== "blocked"` (NOT `setupStatus ===
			// "preparing"`): a data-only / non-git child is created with
			// `setupStatus === "ready"` (no worktree), so gating on
			// "preparing" silently skipped the start and its team never ran.
			// `requestChildStart` → `_startScheduledChildTeam` handles both
			// "preparing" (setup + start) and "ready" (start-only). A blocked
			// child (deps unmet) is not started here — it starts on unblock.
			if (goal.state !== "blocked") {
				const outcome = verificationHarness.requestChildStart(goal.id);
				if (outcome === "capacity-blocked") {
					targetGoalManager.updateGoal(goal.id, { state: "blocked" });
					broadcastToAll({ type: "goal_state_changed", goalId: goal.id });
				}
			}
		} else if (goal.setupStatus === "preparing") {
			if (goal.autoStartTeam) {
				targetGoalManager.setupWorktreeAndStartTeam(goal.id, () => teamManager.startTeam(goal.id)).then(() => {
					broadcastToAll({ type: "goal_setup_complete", goalId: goal.id });
				}).catch((err) => {
					const g = targetGoalManager.getGoal(goal.id);
					if (g?.setupStatus === "ready") {
						broadcastToAll({ type: "goal_setup_complete", goalId: goal.id });
						console.error("[goal] Auto-start team failed (worktree ready):", err);
					} else {
						broadcastToAll({ type: "goal_setup_error", goalId: goal.id, error: String(err) });
					}
				});
			} else {
				targetGoalManager.setupWorktree(goal.id).then(() => {
					broadcastToAll({ type: "goal_setup_complete", goalId: goal.id });
				}).catch((err) => {
					broadcastToAll({ type: "goal_setup_error", goalId: goal.id, error: String(err) });
				});
			}
		}
	} catch (err) {
		jsonError(400, err);
	}
	return;
}

// GET /api/goals/:id
async function handleGoalGet(routeCtx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { getGoalAcrossProjects, json } = routeCtx;
	const id = params.id;
	const goal = getGoalAcrossProjects(id);
	if (!goal) { json({ error: "Goal not found" }, 404); return; }
	json(goal);
	return;
}

// PUT /api/goals/:id
async function handleGoalPut(routeCtx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const {
		broadcastToAll,
		getGoalAcrossProjects,
		getGoalManagerForGoal,
		json,
		projectContextManager,
		projectRegistry,
		readBody,
		req,
		teamManager,
		writeCwdValidationError,
	} = routeCtx;
	const id = params.id;
	const putGoal = getGoalAcrossProjects(id);
	if (putGoal?.archived) { json({ error: "Goal is archived" }, 409); return; }
	const body = await readBody(req);
	if (!body) { json({ error: "Missing body" }, 400); return; }
	const prevSpec = putGoal?.spec ?? "";
	// The goal id already fixes the project scope; a caller-supplied cwd
	// update must still be constrained to that scope (Headquarters dir for
	// HQ goals, or the normal project root / an owned worktree for normal
	// goals). Reuse the ownership-aware validator used for session/team
	// creation rather than forwarding body.cwd unchecked.
	if (typeof body.cwd === "string" && body.cwd.trim().length > 0) {
		const goalProjectId = putGoal?.projectId
			?? projectContextManager.getContextForGoal(id)?.project.id;
		if (goalProjectId) {
			const cwdValidation = validateExecutionCwd(projectRegistry, projectContextManager, goalProjectId, body.cwd, { kind: "goal", goalId: id });
			if (!cwdValidation.ok) { writeCwdValidationError(cwdValidation); return; }
		}
	}
	const goalMgr = getGoalManagerForGoal(id);
	const ok = await goalMgr.updateGoal(id, {
		title: body.title,
		cwd: body.cwd,
		state: body.state,
		spec: body.spec,
		team: true, // Always-on team mode
		repoPath: body.repoPath,
		branch: body.branch,
		reattemptOf: body.reattemptOf,
	});
	if (!ok) { json({ error: "Goal not found" }, 404); return; }
	// Spec-edit notification: emit goal_spec_changed WS event and nudge the team lead.
	if (typeof body.spec === "string" && body.spec !== prevSpec) {
		const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);
		broadcastToAll({
			type: "goal_spec_changed",
			goalId: id,
			prevSpecHash: hash(prevSpec),
			newSpecHash: hash(body.spec),
			prevLen: prevSpec.length,
			newLen: (body.spec as string).length,
			ts: Date.now(),
		});
		try { teamManager.notifyTeamLeadOfSpecChange(id, prevSpec.length, (body.spec as string).length); }
		catch (err) { console.error(`[api] notifyTeamLeadOfSpecChange failed for ${id}:`, err); }
	}
	json({ ok: true });
	return;
}

export function registerGoalCrudRoutes(table: RouteTable<CoreRouteCtx>): void {
	table.register("POST", "/api/goals", handleGoalsCreate);
	table.register("GET", "/api/goals/:id", handleGoalGet);
	table.register("PUT", "/api/goals/:id", handleGoalPut);
}
