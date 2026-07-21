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
	clampMaxDepth,
	effectiveMaxNestingDepth,
	type SubgoalNestingPrefs,
} from "./subgoal-nesting-limit.js";
import { validateSpawnChildSpec } from "./spawn-child-spec-validation.js";
import { walkGoalSubtree, cascadeSubtree } from "./goal-subtree.js";
import { resolveChildWorkflow } from "./spawn-child-workflow.js";
import { authorizeChildrenMutation, type ChildrenMutationClass } from "../auth/children-mutation-authz.js";
import { tryAuth as cookieTryAuth, type CookieStore } from "../auth/cookie.js";
import { HEADQUARTERS_PROJECT_ID } from "./project-registry.js";

export interface NestedGoalRouteDeps {
	projectContextManager: ProjectContextManager;
	verificationHarness: VerificationHarness;
	teamManager: TeamManager;
	sessionManager: SessionManager;
	/**
	 * In-memory signed-cookie verifier used to compute the weak human-operator
	 * signal for S1 authz on the mutating Children endpoints. A verified
	 * `bobbit_session` is accepted as a human/UI signal for operator verbs, but
	 * it is not proof of a human caller (see `children-mutation-authz.ts`).
	 */
	cookieStore: CookieStore;
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

const HEADQUARTERS_NO_WORKTREE_CHILD_MERGE_MESSAGE = "This Headquarters goal runs in the Headquarters directory without a git worktree. Git branch, merge, and PR actions are unavailable.";
const GENERIC_NO_WORKTREE_CHILD_MERGE_MESSAGE = "This goal runs without a git worktree. Git branch, merge, and PR actions are unavailable.";

function goalMergeGitUnavailable(parent: PersistedGoal, child: PersistedGoal): Record<string, unknown> | null {
	const parentRepos = parent.repoWorktrees;
	const childRepos = child.repoWorktrees;
	const hasParentRepos = !!parentRepos && Object.keys(parentRepos).length > 0;
	const matchingRepo = hasParentRepos && childRepos
		? Object.keys(parentRepos).find(repo => !!childRepos[repo])
		: undefined;
	const parentWorktreePath = hasParentRepos
		? (matchingRepo ? parentRepos?.[matchingRepo] : undefined)
		: parent.worktreePath;
	if (parent.branch && child.branch && parentWorktreePath) return null;
	const message = parent.projectId === HEADQUARTERS_PROJECT_ID
		? HEADQUARTERS_NO_WORKTREE_CHILD_MERGE_MESSAGE
		: GENERIC_NO_WORKTREE_CHILD_MERGE_MESSAGE;
	return {
		error: `Child merge is unavailable. ${message}`,
		code: "GOAL_GIT_UNAVAILABLE",
		parentGoalId: parent.id,
		childGoalId: child.id,
		parentBranch: parent.branch ?? null,
		childBranch: child.branch ?? null,
		parentWorktreePath: parentWorktreePath ?? null,
	};
}

/**
 * Sec-2: request-size caps for the plan/spawn endpoints. These bound the
 * memory/CPU a single PATCH /plan or spawn-child body can consume — a huge
 * `proposedSteps[]`, an oversized spec, or a giant inline workflow/roles
 * blob is rejected with a clear 400 BEFORE any classification or persistence
 * work runs. Enforcement is authoritative server-side; the limits are
 * deliberately generous so legitimate plans are never blocked.
 */
export const MAX_PROPOSED_STEPS = 100;
/** Upper bound on a single spec string (sibling of SPEC_TOO_SHORT's MIN). */
export const MAX_SPEC_LENGTH = 20_000;
/** Upper bound on a serialized inline workflow or roles blob. */
export const MAX_INLINE_JSON_BYTES = 256 * 1024;

export type PlanSizeResult =
	| { ok: true }
	| { ok: false; code: string; error: string; limit: number; actual: number };

/** Cap the PATCH /plan body: step count and per-step spec length. */
export function checkPlanRequestSize(proposedSteps: unknown[]): PlanSizeResult {
	if (proposedSteps.length > MAX_PROPOSED_STEPS) {
		return {
			ok: false,
			code: "PLAN_TOO_LARGE",
			error: `proposedSteps[] exceeds the maximum of ${MAX_PROPOSED_STEPS} steps (got ${proposedSteps.length})`,
			limit: MAX_PROPOSED_STEPS,
			actual: proposedSteps.length,
		};
	}
	for (let i = 0; i < proposedSteps.length; i++) {
		const s = proposedSteps[i] as { spec?: unknown; subgoal?: { spec?: unknown } } | null;
		const topSpec = typeof s?.spec === "string" ? s.spec : "";
		const subSpec = typeof s?.subgoal?.spec === "string" ? (s!.subgoal!.spec as string) : "";
		const specLen = Math.max(topSpec.length, subSpec.length);
		if (specLen > MAX_SPEC_LENGTH) {
			return {
				ok: false,
				code: "SPEC_TOO_LONG",
				error: `proposedSteps[${i}] spec exceeds the maximum length of ${MAX_SPEC_LENGTH} characters (got ${specLen})`,
				limit: MAX_SPEC_LENGTH,
				actual: specLen,
			};
		}
	}
	return { ok: true };
}

/** Cap a single spec string (spawn-child path). */
export function checkSpecSize(spec: string): PlanSizeResult {
	if (spec.length > MAX_SPEC_LENGTH) {
		return {
			ok: false,
			code: "SPEC_TOO_LONG",
			error: `spec exceeds the maximum length of ${MAX_SPEC_LENGTH} characters (got ${spec.length})`,
			limit: MAX_SPEC_LENGTH,
			actual: spec.length,
		};
	}
	return { ok: true };
}

/** Cap a serialized inline workflow/roles blob (spawn-child path). */
export function checkInlineJsonSize(value: unknown, kind: "workflow" | "roles"): PlanSizeResult {
	if (value === undefined || value === null) return { ok: true };
	const code = kind === "workflow" ? "WORKFLOW_TOO_LARGE" : "ROLES_TOO_LARGE";
	let bytes: number;
	try {
		bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
	} catch {
		return { ok: false, code, error: `inline ${kind} is not JSON-serializable`, limit: MAX_INLINE_JSON_BYTES, actual: -1 };
	}
	if (bytes > MAX_INLINE_JSON_BYTES) {
		return {
			ok: false,
			code,
			error: `inline ${kind} exceeds the maximum size of ${MAX_INLINE_JSON_BYTES} bytes (got ${bytes})`,
			limit: MAX_INLINE_JSON_BYTES,
			actual: bytes,
		};
	}
	return { ok: true };
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
	// Walk-through-archived semantics live in `walkGoalSubtree` — see
	// `src/server/agent/goal-subtree.ts`. The shared helper is the
	// canonical BFS used by every cascade in the server.
	return walkGoalSubtree(goalId, ctx.goalStore.getAll(), {
		includeRoot: false,
		includeArchived: opts?.includeArchived ?? false,
	});
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
		cookieStore,
	} = deps;

	function readReqHeader(name: string): string | undefined {
		const h = req.headers as Record<string, string | string[] | undefined>;
		const v = h[name.toLowerCase()];
		const s = Array.isArray(v) ? v[0] : v;
		return typeof s === "string" && s.trim() ? s.trim() : undefined;
	}

	/**
	 * Read the PUBLIC caller session id from the spawning-session headers. This
	 * is used ONLY for `spawnedBySessionId` bookkeeping — it is forgeable and is
	 * NEVER trusted for authorization (see `readAuthenticCallerSessionId`).
	 */
	function readCallerSessionId(): string | undefined {
		return readReqHeader("x-bobbit-spawning-session") ?? readReqHeader("x-bobbit-session-id");
	}

	/**
	 * S1: derive the AUTHENTIC caller session id by resolving the per-session
	 * capability secret (`X-Bobbit-Session-Secret`) server-side. Only the owning
	 * session's process holds its own secret, so this cannot be forged by
	 * replaying a public session id. Returns `undefined` for a missing/unknown
	 * secret — which the authz helper treats as deny.
	 */
	function readAuthenticCallerSessionId(): string | undefined {
		return sessionManager.sessionSecretStore.resolveSessionIdBySecret(readReqHeader("x-bobbit-session-secret"));
	}

	/**
	 * S1: server-side authorization for the MUTATING Children endpoints, split
	 * into two classes (blast-radius reduction — see
	 * `src/server/auth/children-mutation-authz.ts`):
	 *
	 *   - `orchestration` (spawn-child, plan PATCH, integrate-child, policy):
	 *     team-lead-only. The signed `bobbit_session` cookie does NOT bypass. A
	 *     shared-admin-token holder can deliberately make an eligible
	 *     browser-shaped request and obtain one from the gateway, so it remains
	 *     a weak human signal. We REQUIRE the AUTHENTIC caller (resolved from
	 *     the per-session secret) to match the authoritative team-lead for
	 *     `goalIdForTeam`.
	 *   - `operator` (pause, resume, mutation decision, archive-child): the
	 *     human-in-the-loop verbs the web UI drives. A verified cookie is
	 *     accepted; otherwise the same authentic team-lead match applies.
	 *
	 * The AUTHENTIC caller is derived from the unforgeable `X-Bobbit-Session-
	 * Secret`, never the public `X-Bobbit-Spawning-Session` header — and is only
	 * compared for equality against the TeamManager's team-lead id. A teamless
	 * goal has no legitimate agent caller (denied for orchestration; operator
	 * still allows the cookie).
	 *
	 * Returns `true` when the request may proceed; otherwise writes a 403 and
	 * returns `false` so the caller should `return true` immediately.
	 */
	function authorizeTeamLeadOrReject(goalIdForTeam: string, mutationClass: ChildrenMutationClass): boolean {
		const result = authorizeChildrenMutation({
			mutationClass,
			isHumanOperator: cookieTryAuth(req, cookieStore),
			authenticCallerSessionId: readAuthenticCallerSessionId(),
			teamLeadSessionId: teamManager.getTeamState(goalIdForTeam)?.teamLeadSessionId,
		});
		if (!result.ok) {
			json({
				error: "Caller session is not the team-lead for this goal",
				code: "NOT_TEAM_LEAD",
				goalId: goalIdForTeam,
			}, 403);
			return false;
		}
		return true;
	}

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
	 * Apply operator-pause semantics to a single goal: set paused=true,
	 * cancel in-flight verifications, broadcast state change.
	 *
	 * THE ONLY CALLER of this function is `executePauseForGoals` below.
	 * All code that needs to pause a goal (REST handler, replan-overflow)
	 * MUST go through `executePauseForGoals`, not call this directly.
	 */
	async function applyOperatorPause(pauseGoalManager: GoalManager, goalId: string): Promise<void> {
		await pauseGoalManager.updateGoal(goalId, { paused: true });
		await cancelAllVerifications(goalId);
		broadcastToAll({ type: "goal_state_changed", goalId });
	}

	/**
	 * Execute a pause operation: pause all listed goals and abort their
	 * streaming sessions (excluding the caller's own session).
	 *
	 * This is the SINGLE ENTRY POINT for goal-pause operations. Both the
	 * REST POST /pause handler and the replan-overflow safety circuit
	 * route through here. `applyOperatorPause` is only called from this
	 * function — no other code touches goal.paused = true.
	 */
	async function executePauseForGoals(
		targets: PersistedGoal[],
		callerSessionId: string | undefined,
	): Promise<number> {
		const pausedIds = new Set<string>(targets.map(g => g.id));
		let count = 0;
		for (const g of targets) {
			if (g.paused) continue;
			await applyOperatorPause(getGoalManagerForGoal(g.id), g.id);
			count++;
		}
		for (const s of sessionManager.getAllSessionsRaw()) {
			if (!s.goalId || !pausedIds.has(s.goalId)) continue;
			if (s.status !== "streaming") continue;
			if (s.id === callerSessionId) continue;
			sessionManager.abortSessionTurn(s.id).catch((err) => {
				console.warn(`[pause] abortSessionTurn failed for session=${s.id} goal=${s.goalId}:`, err);
			});
		}
		return count;
	}

	/**
	 * Gov-1: increment a goal's replanCount and trip the replan-overflow
	 * safety circuit when it crosses the threshold. SINGLE source of truth
	 * shared by BOTH the direct fix-up apply path (balanced/autonomous) and
	 * the approval-applied path so they have identical semantics — previously
	 * the direct path only bumped replanCount and skipped the auto-pause.
	 *
	 * Auto-pause routes through `executePauseForGoals` (the canonical pause
	 * entry point) when `newReplanCount > 5 && !goal.paused`. The goal record
	 * is re-read so the pause cascade sees current state. `callerSessionId`
	 * excludes the triggering agent's own session from the cascade-abort loop.
	 */
	async function applyReplanAndMaybeAutopause(
		goal: PersistedGoal,
		goalManager: GoalManager,
		callerSessionId: string | undefined,
	): Promise<{ newReplanCount: number; autoPaused: boolean }> {
		const newReplanCount = (goal.replanCount ?? 0) + 1;
		await goalManager.updateGoal(goal.id, { replanCount: newReplanCount });
		const autoPaused = newReplanCount > 5 && !goal.paused;
		if (autoPaused) {
			const goalRecord = getGoalAcrossProjects(goal.id);
			if (goalRecord) await executePauseForGoals([goalRecord], callerSessionId);
		}
		return { newReplanCount, autoPaused };
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
			// G2/C1: `goal_plan_propose` sends workflowId/suggestedRole at the
			// TOP level of each step; prefer those, falling back to the nested
			// `subgoal.*` shape. Previously only the nested form was read, so a
			// proposed child's workflow/role override never reached the stored
			// execution plan.
			const stepWorkflowId = s.workflowId ?? s.subgoal?.workflowId;
			const stepRole = s.suggestedRole ?? s.subgoal?.suggestedRole;
			return {
				name: s.title ?? s.subgoal?.title ?? `step-${idx}`,
				type: "subgoal" as const,
				phase: s.phase,
				subgoal: {
					planId: s.planId,
					title: s.title ?? s.subgoal?.title ?? "",
					spec: s.spec ?? s.subgoal?.spec ?? "",
					...(stepWorkflowId !== undefined ? { workflowId: stepWorkflowId } : {}),
					...(stepRole !== undefined ? { suggestedRole: stepRole } : {}),
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
		// Pause-cascade: refuse to spawn a child on a paused parent. The
		// guard runs BEFORE the planId idempotency check below — a re-call
		// with the same planId on a paused parent still represents a spawn
		// intent the operator wants blocked (see docs/design/pause-cascade.md).
		if (parent.paused) {
			json({ error: `Parent goal ${parentId} is paused`, code: "GOAL_PAUSED", goalId: parentId }, 409);
			return true;
		}
		// S1: spawn-child is an ORCHESTRATION verb — team-lead-only, the cookie
		// does NOT bypass.
		if (!authorizeTeamLeadOrReject(parentId, "orchestration")) return true;
		const body = await readBody(req).catch(() => null);
		if (!body) { json({ error: "Missing body" }, 400); return true; }
		const planId = typeof body.planId === "string" ? body.planId.trim() : "";
		const title = typeof body.title === "string" ? body.title.trim() : "";
		const spec = typeof body.spec === "string" ? body.spec : "";
		if (!planId) { json({ error: "planId is required" }, 400); return true; }
		if (!title) { json({ error: "title is required" }, 400); return true; }
		if (!spec) { json({ error: "spec is required" }, 400); return true; }
		const specValidation = validateSpawnChildSpec(spec);
		if (!specValidation.ok) {
			json({
				error: specValidation.error,
				code: specValidation.code,
				...(specValidation.code === "SPEC_TOO_SHORT"
					? { actualLength: specValidation.actualLength, minLength: specValidation.minLength }
					: {}),
			}, 400);
			return true;
		}
		// Sec-2: reject oversized request bodies BEFORE any spawn work runs.
		const specSize = checkSpecSize(spec);
		if (!specSize.ok) { json({ error: specSize.error, code: specSize.code, limit: specSize.limit, actual: specSize.actual }, 400); return true; }
		const wfSize = checkInlineJsonSize((body as { workflow?: unknown }).workflow, "workflow");
		if (!wfSize.ok) { json({ error: wfSize.error, code: wfSize.code, limit: wfSize.limit, actual: wfSize.actual }, 400); return true; }
		const rolesSize = checkInlineJsonSize((body as { inlineRoles?: unknown }).inlineRoles, "roles");
		if (!rolesSize.ok) { json({ error: rolesSize.error, code: rolesSize.code, limit: rolesSize.limit, actual: rolesSize.actual }, 400); return true; }
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
			if (nestingCheck.code === "PARENT_SUBGOALS_DISABLED") {
				json({
					error: `Parent goal "${parent.title}" doesn't allow sub-goals`,
					code: "PARENT_SUBGOALS_DISABLED",
				}, 403);
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

		// dependsOn scheduling enforcement — resolve each declared dep planId
		// to a sibling and check whether it is already merged (state=complete).
		// Children with unresolved deps are stamped state='blocked' (not paused)
		// and skip worktree/team start; integrate-child auto-unblocks them
		// (blocked → todo) when their last dependency merges.
		const unresolvedDeps: string[] = [];
		if (dependsOn && dependsOn.length > 0) {
			for (const depPlanId of dependsOn) {
				const sibling = siblings.find(g => g.spawnedFromPlanId === depPlanId);
				if (!sibling || sibling.state !== "complete") {
					unresolvedDeps.push(depPlanId);
				}
			}
		}
		const blocked = unresolvedDeps.length > 0;

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

			// G2/C1: workflow resolution via the shared `resolveChildWorkflow`
			// cascade so an explicit `workflowId` OVERRIDES an inherited parent
			// snapshot. The previous inline logic preferred `parent.workflow`
			// over `body.workflowId`, silently dropping the caller's override.
			// Cascade tiers (highest first): body.workflow → body.workflowId →
			// parent.workflow (stripped of parent subgoal steps) → "feature" →
			// first non-hidden. Tiers 1+3 return a snapshot (resolvedWorkflow);
			// tiers 2/4/5 return an id only (materialised by createGoal). Keeps
			// workflowId and workflow.id aligned (QA-1).
			const inlineWorkflowBody = (body as { workflow?: Workflow }).workflow;
			let resolvedWorkflowForChild: Workflow | undefined;
			let workflowId: string;
			try {
				const wfResolution = resolveChildWorkflow(
					parent,
					undefined,
					{
						...(inlineWorkflowBody && typeof inlineWorkflowBody === "object" ? { workflow: inlineWorkflowBody } : {}),
						...(bodyWorkflowId !== undefined ? { workflowId: bodyWorkflowId } : {}),
					},
					ctx.workflowStore,
				);
				resolvedWorkflowForChild = wfResolution.workflow;
				workflowId = wfResolution.workflowId;
			} catch {
				// No workflow resolvable anywhere — fall back to the caller's id or
				// "feature" and let createGoal materialise (or fail loudly).
				resolvedWorkflowForChild = parent.workflow
					? stripSubgoalStepsForChildInheritance(parent.workflow)
					: undefined;
				workflowId = resolvedWorkflowForChild?.id ?? bodyWorkflowId ?? "feature";
			}

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
			const childOverrides = inheritedChildOverrides(parent, nestingPrefs, getGoalAcrossProjects);
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
				// dependsOn scheduling: stamp state='blocked' atomically so the
				// child never has a window where it is runnable with unresolved
				// deps. 'blocked' is scheduler-managed; 'paused' is operator-only.
				...(blocked ? { state: "blocked" as const } : {}),
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

			// Finding 2 — route the team start through the unified per-root
			// scheduler so the concurrency cap is enforced on the direct
			// `goal_spawn_child` path too (previously this started the team with
			// NO permit, so cap=1 + several spawn-child calls started multiple
			// teams at once). Blocked (deps-unmet) children skip this entirely —
			// integrate-child auto-unblock requests their start when the final
			// dep merges (also via the scheduler). A capacity-blocked child is
			// parked `state='blocked'` and started later when a permit frees.
			//
			// Guard is `!blocked` (NOT `setupStatus === "preparing"`): a
			// data-only / non-git child is created with `setupStatus === "ready"`
			// (no worktree to prepare), so gating on "preparing" silently skipped
			// the start and its team never ran. The scheduler's
			// `_startScheduledChildTeam` already handles both cases — worktree
			// setup + start for "preparing", start-only for "ready".
			let capacityBlocked = false;
			if (!blocked) {
				const outcome = verificationHarness.requestChildStart(child.id);
				if (outcome === "capacity-blocked") {
					capacityBlocked = true;
					try {
						await goalManager.updateGoal(child.id, { state: "blocked" });
						broadcastToAll({ type: "goal_state_changed", goalId: child.id });
					} catch (err) {
						console.warn(`[spawn-child] failed to stamp capacity-blocked state for ${child.id} (non-fatal):`, err);
					}
				}
			}
			json({
				id: child.id,
				suggestedRole,
				spawnedBySessionId,
				...(blocked ? { blocked: true, pendingDeps: unresolvedDeps } : {}),
				...(capacityBlocked ? { capacityBlocked: true } : {}),
			}, 201);
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
		// S1: plan PATCH is an ORCHESTRATION verb — team-lead-only, the cookie
		// does NOT bypass.
		if (!authorizeTeamLeadOrReject(id, "orchestration")) return true;
		// Plan-propose requires a workflow with an `execution` gate.
		const hasExecutionGate = !!goal.workflow?.gates.some(g => g.id === "execution");
		if (!hasExecutionGate) {
			json({
				error: `Goal's workflow (${goal.workflowId ?? "unknown"}) has no 'execution' gate to hold a subgoal plan. Either re-create the goal with the 'parent' workflow, or call goal_spawn_child directly for each step.`,
				code: "NO_EXECUTION_GATE",
				warning: "degraded-execution: workflow has no execution gate. dependsOn is enforced via dependency-blocking on spawn — children with unmet deps are created in state='blocked' (scheduler-managed, distinct from operator paused) and auto-start when their last dep merges. Consider using the 'parent' workflow for full classifier/freeze flow.",
			}, 400);
			return true;
		}
		const body = await readBody(req).catch(() => null);
		if (!body || !Array.isArray(body.proposedSteps)) {
			json({ error: "proposedSteps[] is required" }, 400);
			return true;
		}
		// Sec-2: cap request size (step count + per-step spec length) BEFORE the
		// per-step shape validation, classification, or persistence runs.
		const planSize = checkPlanRequestSize(body.proposedSteps);
		if (!planSize.ok) {
			json({ error: planSize.error, code: planSize.code, limit: planSize.limit, actual: planSize.actual }, 400);
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
			if (code === "DUPLICATE_PLAN_ID") {
				payload.planId = depsValidation.planId;
				payload.error = `duplicate planId: ${depsValidation.planId}`;
			}
			json(payload, 400);
			return true;
		}

		const ctx = resolved.ctx;
		const planMutationStore = ctx.planMutationStore;
		const goalManager = ctx.goalManager;

		// Pre-freeze (initial authoring): until `goal-plan` is signalled and the
		// execution gate is frozen (`execution.metadata.frozen === "true"`, the
		// same flag GET /plan reports), plan edits are the author drafting the
		// plan — NOT a divergence from a committed plan. So they are applied
		// DIRECTLY, with NO mutation classification, approval gating, or
		// replanCount/auto-pause. Otherwise a normal draft edit (e.g. adding a
		// higher-phase step → `expansion`) would wrongly demand approval and
		// could trip the replan-overflow auto-pause on draft churn. Once frozen,
		// the full classifier + divergence-policy + replanCount flow below runs.
		const executionGate = goal.workflow?.gates.find(g => g.id === "execution");
		const frozen = executionGate?.metadata?.frozen === "true";
		if (!frozen) {
			try {
				await applyPlanSteps(goal, proposedSteps, goalManager);
				json({ applied: true, frozen: false, replanCount: goal.replanCount ?? 0 });
			} catch (err) {
				jsonError(500, err);
			}
			return true;
		}

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
				// Gov-1: bump replanCount AND trip the replan-overflow auto-pause
				// via the SAME shared helper the approval path uses. Previously
				// this direct path only incremented replanCount and silently
				// skipped the `replanCount > 5` auto-pause.
				const { newReplanCount, autoPaused } = await applyReplanAndMaybeAutopause(
					goal, goalManager, readCallerSessionId(),
				);
				json({ kind: verdict.kind, summary: verdict.summary, applied: true, replanCount: newReplanCount, autoPaused });
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
		await planMutationStore.put(pending);
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

	// GET /api/goals/:id/mutations/pending — persisted pending plan-mutation
	// requests for the approval surfaces (in-chat card + dashboard
	// mutation-pending card). Enables restart-safe REHYDRATION: a reload /
	// reconnect re-discovers requests that the live `mutation_pending`
	// broadcast already fired (and missed) while the UI was disconnected.
	//
	// READ-only: gated by the SAME `requireSubgoalsEnabled()` the sibling GET
	// routes (e.g. GET /plan) use — deliberately NO `authorizeTeamLeadOrReject`
	// / mutation-authz path (those guard the mutating verbs). Expired entries
	// (past their 24h TTL) are filtered so a stale request never resurfaces.
	const mutationsPendingMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/mutations\/pending$/);
	if (mutationsPendingMatch && req.method === "GET") {
		if (!requireSubgoalsEnabled()) return true;
		const id = mutationsPendingMatch[1];
		const resolved = resolvePlanContext(id);
		if (!resolved) return true;
		const now = Date.now();
		const pending = (await resolved.ctx.planMutationStore
			.listForGoal(id))
			.filter(m => m.expiresAt > now)
			.map(m => ({
				requestId: m.requestId,
				goalId: m.goalId,
				kind: m.kind,
				summary: m.summary,
				diff: m.diff,
				proposedSteps: m.proposedSteps,
				...(m.uncoveredCriteria ? { uncoveredCriteria: m.uncoveredCriteria } : {}),
				createdAt: m.createdAt,
				expiresAt: m.expiresAt,
			}));
		json({ pending });
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
		// S1: integrate-child is an ORCHESTRATION verb — team-lead-only, the
		// cookie does NOT bypass.
		if (!authorizeTeamLeadOrReject(parentId, "orchestration")) return true;
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
		const gitUnavailable = goalMergeGitUnavailable(parent, child);
		if (gitUnavailable) { json(gitUnavailable, 409); return true; }
		try {
			const outcome = await goalManager.mergeChild(parentId, childId);
			if (outcome.merged || outcome.alreadyMerged) {
				// Durable merge-conflict flag: a successful merge clears any
				// prior conflict on this child (data contract for /descendants).
				if (child.mergeConflict) {
					try {
						await goalManager.updateGoal(childId, { mergeConflict: false });
						broadcastToAll({ type: "goal_state_changed", goalId: childId });
					} catch (err) {
						console.warn(`[integrate-child] failed to clear mergeConflict (non-fatal):`, err);
					}
				}
				try { await teamManager.teardownTeam(childId); } catch (err) {
					console.warn(`[api] integrate-child: teardownTeam error (non-fatal):`, err);
				}
				await goalManager.archiveGoalAfterMerge(childId);
				// Finding 2 — terminal event: release the per-root permit this
				// child held (if it was started under the scheduler) so the next
				// capacity-blocked sibling can start. Best-effort + idempotent
				// (a child that never held a permit is a no-op).
				try { verificationHarness.notifyChildTerminal(childId); } catch (err) {
					console.warn(`[integrate-child] notifyChildTerminal failed (non-fatal):`, err);
				}
				// dependsOn scheduling — auto-unblock any sibling whose deps are
				// now ALL complete after this merge. Best-effort: any throw is
				// caught and logged so the merge itself still returns success.
				try {
					const mergedPlanId = child.spawnedFromPlanId;
					if (mergedPlanId) {
						const allSiblings = ctx.goalStore.getAll()
							.filter(g => g.parentGoalId === parentId && !g.archived && g.id !== childId);
						for (const sib of allSiblings) {
							const deps = sib.dependsOnPlanIds;
							if (!deps || deps.length === 0) continue;
							if (!deps.includes(mergedPlanId)) continue;
							// Re-check ALL deps — multi-dep children only unblock
							// when the LAST dep merges.
							const allResolved = deps.every(depPid => {
								const depSib = ctx.goalStore.getAll().find(g =>
									g.parentGoalId === parentId && g.spawnedFromPlanId === depPid);
								return !!depSib && depSib.state === "complete";
							});
							if (!allResolved) continue;
							if (sib.state !== "blocked") continue;
							// Finding 2 — deps now satisfied: request the sibling's
							// team start through the unified scheduler instead of
							// starting it directly. If a permit is free the scheduler
							// flips state='blocked' → 'todo' and starts the team;
							// otherwise the sibling stays parked capacity-blocked and
							// starts when a permit frees (a single merge that unblocks
							// several dependents no longer starts them all at once).
							verificationHarness.requestChildStart(sib.id);
						}
					}
				} catch (err) {
					console.error(`[integrate-child] auto-unblock scan failed (non-fatal):`, err);
				}
				broadcastToAll({ type: "goal_state_changed", goalId: childId });
				broadcastToAll({ type: "goal_state_changed", goalId: parentId });
				json({
					merged: !!outcome.merged,
					alreadyMerged: !!outcome.alreadyMerged,
					conflict: false,
					output: outcome.output ?? "",
					...(outcome.repos ? { repos: outcome.repos } : {}),
				});
				return true;
			}
			if (outcome.conflict) {
				// Durable merge-conflict flag: persist + broadcast so the Plan
				// tab can render this child's conflict state across reloads.
				try {
					await goalManager.updateGoal(childId, { mergeConflict: true });
					broadcastToAll({ type: "goal_state_changed", goalId: childId });
				} catch (err) {
					console.warn(`[integrate-child] failed to set mergeConflict (non-fatal):`, err);
				}
				json({
					merged: false,
					alreadyMerged: false,
					conflict: true,
					output: outcome.output ?? "",
					...(outcome.repos ? { repos: outcome.repos } : {}),
				}, 409);
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
		const id = pauseMatch[1];
		const goal = getGoalAcrossProjects(id);
		if (!goal) { json({ error: "Goal not found" }, 404); return true; }
		// S1: pause is an OPERATOR verb — the web UI drives it, so a verified
		// human cookie is accepted (else team-lead match).
		if (!authorizeTeamLeadOrReject(id, "operator")) return true;
		const body = await readBody(req).catch(() => null);
		if (!body || typeof body.cascade !== "boolean") {
			json({ error: "cascade (boolean) is required", code: "CASCADE_REQUIRED" }, 422);
			return true;
		}
		const cascade: boolean = body.cascade;
		// Pause cascade order = top-down (parent paused first so its
		// supervisor doesn't respawn workers during child pauses).
		// Optional targeted-child pause (Issue 4): retarget the cascade to a
		// direct child instead of the caller's own goal.
		const childGoalIdRaw: unknown = (body as { childGoalId?: unknown }).childGoalId;
		const childGoalId: string | undefined = typeof childGoalIdRaw === "string" && childGoalIdRaw.trim()
			? childGoalIdRaw.trim() : undefined;
		let targetRoot: PersistedGoal = goal;
		if (childGoalId !== undefined) {
			const childGoal = getGoalAcrossProjects(childGoalId);
			if (!childGoal || childGoal.archived) { json({ error: "Child goal not found" }, 404); return true; }
			if (childGoal.parentGoalId !== id) {
				json({ error: "childGoalId must be a direct child", code: "NOT_DIRECT_CHILD" }, 403);
				return true;
			}
			targetRoot = childGoal;
		}
		// Read caller's session to exclude from cascade-abort (Issue 6).
		const reqHeaders = req.headers as Record<string, string | string[] | undefined>;
		const readHdr = (n: string): string | undefined => {
			const v = reqHeaders[n.toLowerCase()];
			const s = Array.isArray(v) ? v[0] : v;
			return typeof s === "string" && s.trim() ? s.trim() : undefined;
		};
		const callerSessionId = readHdr("x-bobbit-spawning-session") ?? readHdr("x-bobbit-session-id");
		// Walk via the cascade framework's pure walker (top-down order — parent
		// paused first so its supervisor doesn't respawn workers during child
		// pauses), then route through executePauseForGoals which remains the
		// single entry point for goal.paused=true writes (replan-overflow auto-
		// pause uses the same function — see line ~1029).
		const pauseCtx = projectContextManager.getContextForGoal(targetRoot.id);
		const pauseAllGoals = pauseCtx?.goalStore.getAll() ?? [];
		const pauseTargets: PersistedGoal[] = cascade
			? walkGoalSubtree(targetRoot.id, pauseAllGoals, { includeRoot: true, includeArchived: false })
			: [targetRoot];
		const count = await executePauseForGoals(pauseTargets, callerSessionId);
		json({ paused: count });
		return true;
	}

	// POST /api/goals/:id/resume — cascade required.
	const resumeMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/resume$/);
	if (resumeMatch && req.method === "POST") {
		const id = resumeMatch[1];
		const goal = getGoalAcrossProjects(id);
		if (!goal) { json({ error: "Goal not found" }, 404); return true; }
		// S1: resume is an OPERATOR verb — the web UI drives it, so a verified
		// human cookie is accepted (else team-lead match).
		if (!authorizeTeamLeadOrReject(id, "operator")) return true;
		const body = await readBody(req).catch(() => null);
		if (!body || typeof body.cascade !== "boolean") {
			json({ error: "cascade (boolean) is required", code: "CASCADE_REQUIRED" }, 422);
			return true;
		}
		const cascade: boolean = body.cascade;
		const childGoalIdRaw: unknown = (body as { childGoalId?: unknown }).childGoalId;
		const childGoalId: string | undefined = typeof childGoalIdRaw === "string" && childGoalIdRaw.trim()
			? childGoalIdRaw.trim() : undefined;
		let targetRoot: PersistedGoal = goal;
		if (childGoalId !== undefined) {
			const childGoal = getGoalAcrossProjects(childGoalId);
			if (!childGoal || childGoal.archived) { json({ error: "Child goal not found" }, 404); return true; }
			if (childGoal.parentGoalId !== id) {
				json({ error: "childGoalId must be a direct child", code: "NOT_DIRECT_CHILD" }, 403);
				return true;
			}
			targetRoot = childGoal;
		}
		// Resume via cascadeSubtree so per-node failures are collected rather
		// than aborting remaining goals. Top-down order — parent reactivated
		// first so it can re-supervise children.
		// R-039: resumes only `paused` goals; does NOT touch 'blocked' state.
		// 'blocked' is scheduler-managed (set/cleared by spawn-child /
		// integrate-child) and is NOT touched here.
		const resumeCtx = projectContextManager.getContextForGoal(targetRoot.id);
		const resumeAllGoals = resumeCtx?.goalStore.getAll() ?? [];
		const resumeResult = await cascadeSubtree(
			targetRoot.id,
			resumeAllGoals,
			{ includeRoot: true, includeArchived: false, ...(cascade ? {} : { maxDepth: 0 }) },
			{
				order: "top-down",
				apply: async (g) => {
					if (!g.paused) return 0;
					const gm = getGoalManagerForGoal(g.id);
					// Resume clears any durable merge-conflict flag so the child
					// is retried clean (data contract for /descendants).
					await gm.updateGoal(g.id, { paused: false, ...(g.mergeConflict ? { mergeConflict: false } : {}) });
					broadcastToAll({ type: "goal_state_changed", goalId: g.id });
					return 1;
				},
			},
		);
		const count = resumeResult.processed.reduce((n, p) => n + (p.result as number), 0);
		json({
			resumed: count,
			...(resumeResult.errors.length > 0
				? { errors: resumeResult.errors.map(e => ({ goalId: e.goalId, error: e.error.message })) }
				: {}),
		});
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
		// S1: a mutation decision is an OPERATOR verb — the web UI's approval
		// card drives it, so a verified human cookie is accepted (else
		// team-lead match).
		if (!authorizeTeamLeadOrReject(goalId, "operator")) return true;
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
		try {
			const decided = await planMutationStore.decide(goalId, requestId, async pending => {
				if (decision === "reject") return { applied: false as const };

				// approve: apply the proposed steps and bump replanCount while the
				// request remains exclusively claimed by the store's per-goal queue.
				await applyPlanSteps(goal, pending.proposedSteps, goalManager);
				// Gov-1: bump replanCount AND trip the replan-overflow auto-pause
				// via the SAME shared helper the direct fix-up path uses, so both
				// paths have identical semantics. The helper routes the pause
				// through executePauseForGoals (canonical entry point) and excludes
				// the triggering agent's own session from the cascade-abort loop.
				const { newReplanCount, autoPaused } = await applyReplanAndMaybeAutopause(
					goal, goalManager, readCallerSessionId(),
				);
				return { applied: true as const, newReplanCount, autoPaused };
			});
			if (!decided.found) {
				json({ error: "Mutation request not found", code: "REQUEST_NOT_FOUND" }, 404);
				return true;
			}

			const outcome = decided.value;
			if (!outcome.applied) {
				broadcastToAll({ type: "mutation_decided", goalId, requestId, decision });
				json({ applied: false });
				return true;
			}

			const { newReplanCount, autoPaused } = outcome;
			broadcastToAll({ type: "mutation_decided", goalId, requestId, decision, autoPaused });
			// Cross-team propagation: when a child goal is auto-paused,
			// notify the PARENT's team-lead — without this the parent sits
			// idle indefinitely after the replan-overflow tripwire fires.
			if (autoPaused) {
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
			json({ applied: true, replanCount: newReplanCount, autoPaused });
		} catch (err) {
			jsonError(500, err);
		}
		return true;
	}

	// PATCH /api/goals/:id/policy — set divergencePolicy / maxConcurrentChildren
	// (orchestration, team-lead-only) and/or subgoalsAllowed / maxNestingDepth
	// (operator — verified human cookie OR team-lead; see split authz below).
	const policyMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/policy$/);
	if (policyMatch && req.method === "PATCH") {
		if (!requireSubgoalsEnabled()) return true;
		const id = policyMatch[1];
		const goal = getGoalAcrossProjects(id);
		if (!goal) { json({ error: "Goal not found" }, 404); return true; }
		const body = await readBody(req).catch(() => null);
		if (!body) { json({ error: "Missing body" }, 400); return true; }
		// S1 (split authz): the per-goal sub-goal opt-in fields
		// (`subgoalsAllowed` / `maxNestingDepth`) are HUMAN-OPERATOR settings the
		// goal dashboard drives — they only relax/tighten this goal's own
		// child-hosting eligibility and can never spawn, plan, integrate, or
		// resize live concurrency. They are therefore OPERATOR-class: a verified
		// human cookie is accepted (else team-lead match). The orchestration
		// fields (`divergencePolicy` / `maxConcurrentChildren`) remain
		// ORCHESTRATION-class (team-lead-only, cookie does NOT bypass). A body
		// that mixes in ANY orchestration field is classified as orchestration —
		// the stricter class wins so the cookie can't pigg-back an orchestration
		// change behind a sub-goal toggle.
		const hasOrchestrationField =
			body.divergencePolicy !== undefined || body.maxConcurrentChildren !== undefined;
		const hasOperatorField =
			body.subgoalsAllowed !== undefined || body.maxNestingDepth !== undefined;
		if (!hasOrchestrationField && !hasOperatorField) {
			json({ error: "No recognized policy fields", code: "NO_POLICY_FIELDS" }, 400);
			return true;
		}
		const mutationClass: ChildrenMutationClass = hasOrchestrationField ? "orchestration" : "operator";
		if (!authorizeTeamLeadOrReject(id, mutationClass)) return true;
		const goalManager = getGoalManagerForGoal(id);
		const updates: {
			divergencePolicy?: "strict" | "balanced" | "autonomous";
			maxConcurrentChildren?: number;
			subgoalsAllowed?: boolean;
			maxNestingDepth?: number;
		} = {};
		if (body.divergencePolicy !== undefined) {
			if (body.divergencePolicy !== "strict" && body.divergencePolicy !== "balanced" && body.divergencePolicy !== "autonomous") {
				json({ error: "divergencePolicy must be one of strict|balanced|autonomous" }, 400);
				return true;
			}
			updates.divergencePolicy = body.divergencePolicy;
		}
		if (body.subgoalsAllowed !== undefined) {
			// Per-goal opt-in toggle. The SYSTEM pref remains the master gate
			// (see subgoal-nesting-limit.ts) — flipping this to `true` only has
			// effect when the system pref `subgoalsEnabled` is also ON.
			if (typeof body.subgoalsAllowed !== "boolean") {
				json({ error: "subgoalsAllowed must be a boolean" }, 400);
				return true;
			}
			updates.subgoalsAllowed = body.subgoalsAllowed;
		}
		if (body.maxNestingDepth !== undefined) {
			// Per-goal nesting cap. Route clamping through the SSOT helper and
			// cap to the INHERITED ceiling — descendants can only tighten, never
			// widen. For a root goal the ceiling is the system-wide
			// `maxNestingDepth`; for a child goal it is the parent's *effective*
			// cap (`effectiveMaxNestingDepth(parent, prefs)` = system ∩ parent.own),
			// so a child can never widen past its parent/ancestor tree cap. Server
			// authority is mandatory here — the UI range is advisory.
			const raw = Number(body.maxNestingDepth);
			if (!Number.isFinite(raw)) {
				json({ error: "maxNestingDepth must be a finite number" }, 400);
				return true;
			}
			const prefs = getSubgoalNestingPrefs();
			const parent = goal.parentGoalId
				? getGoalAcrossProjects(goal.parentGoalId)
				: undefined;
			const ceiling = parent
				? effectiveMaxNestingDepth(parent, prefs, getGoalAcrossProjects)
				: prefs.maxNestingDepth;
			updates.maxNestingDepth = Math.min(clampMaxDepth(raw), ceiling);
		}
		if (body.maxConcurrentChildren !== undefined) {
			// C4: integer clamp. A fractional value (e.g. 1.5) would otherwise be
			// stored verbatim and let an extra child run. Floor to an integer and
			// require the result to land in [1, 8].
			const raw = Number(body.maxConcurrentChildren);
			const n = Math.floor(raw);
			if (!Number.isFinite(n) || n < 1 || n > 8) {
				json({ error: "maxConcurrentChildren must be an integer in [1, 8]" }, 400);
				return true;
			}
			updates.maxConcurrentChildren = n;
		}
		await goalManager.updateGoal(id, updates);
		// C2: live concurrency enforcement. `maxConcurrentChildren` is
		// root-resolved for the per-root subgoal semaphore, which is cached on
		// first use. Resize the cached semaphore so a lowered cap takes effect
		// on an already-running subtree instead of only after a restart.
		if (updates.maxConcurrentChildren !== undefined) {
			const rootGoalId = getGoalAcrossProjects(id)?.rootGoalId ?? id;
			const resolvedMax = goalManager.resolveRootMaxConcurrentChildren(rootGoalId);
			verificationHarness.resizeRootSubgoalSemaphore(rootGoalId, resolvedMax);
		}
		// R-017: include the new policy values in the broadcast so clients
		// don't need to re-fetch the goal record on every policy change.
		const updatedGoal = getGoalAcrossProjects(id);
		broadcastToAll({
			type: "goal_state_changed",
			goalId: id,
			...(updatedGoal?.divergencePolicy !== undefined ? { divergencePolicy: updatedGoal.divergencePolicy } : {}),
			...(updatedGoal?.maxConcurrentChildren !== undefined ? { maxConcurrentChildren: updatedGoal.maxConcurrentChildren } : {}),
			...(updatedGoal?.subgoalsAllowed !== undefined ? { subgoalsAllowed: updatedGoal.subgoalsAllowed } : {}),
			...(updatedGoal?.maxNestingDepth !== undefined ? { maxNestingDepth: updatedGoal.maxNestingDepth } : {}),
		});
		json({ ok: true });
		return true;
	}

	return false;
}
