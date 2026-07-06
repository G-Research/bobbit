// src/server/routes/goal-lifecycle-routes.ts
//
// STR-01 goals cohort G2b: goal lifecycle/archive routes migrated out of
// handleApiRoute's legacy if/else chain into the core route registry.
// See docs/design/route-registry.md.
//
// Mechanical extraction — handler bodies below preserve the legacy behavior,
// with only handleApiRoute locals destructured from ctx and registry params
// replacing regex captures.

import { authorizeChildrenMutation } from "../auth/children-mutation-authz.js";
import { tryAuth as cookieTryAuth } from "../auth/cookie.js";
import { cleanupGateDiagnosticsForGoal } from "../agent/gate-diagnostics-cleanup.js";
import type { PersistedGoal } from "../agent/goal-store.js";
import { cascadeSubtree as cascadeGoalSubtree } from "../agent/goal-subtree.js";
import { listDescendants } from "../agent/nested-goal-routes.js";
import { deleteRemoteGoalBranches } from "../skills/git-gh.js";
import type { CoreRouteCtx } from "./core-route-ctx.js";
import type { RouteTable } from "./route-table.js";

// POST /api/goals/:id/retry-setup � retry worktree setup for a goal in error state
async function handleGoalRetrySetup(routeCtx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const {
		broadcastToAll,
		getGoalManagerForGoal,
		json,
		teamManager,
	} = routeCtx;
	const goalId = params.id;
	const retryGoalManager = getGoalManagerForGoal(goalId);
	const ok = retryGoalManager.retrySetup(goalId);
	if (!ok) {
		json({ error: "Goal not found or not in error state" }, 400);
		return;
	}
	json({ ok: true });
	// Fire-and-forget async worktree setup (and optionally start team)
	const retryGoal = retryGoalManager.getGoal(goalId);
	if (retryGoal?.autoStartTeam) {
		retryGoalManager.setupWorktreeAndStartTeam(goalId, () => teamManager.startTeam(goalId)).then(() => {
			broadcastToAll({ type: "goal_setup_complete", goalId });
		}).catch((err) => {
			const g = retryGoalManager.getGoal(goalId);
			if (g?.setupStatus === "ready") {
				broadcastToAll({ type: "goal_setup_complete", goalId });
				console.error("[goal] Auto-start team failed on retry (worktree ready):", err);
			} else {
				broadcastToAll({ type: "goal_setup_error", goalId, error: String(err) });
			}
		});
	} else {
		retryGoalManager.setupWorktree(goalId).then(() => {
			broadcastToAll({ type: "goal_setup_complete", goalId });
		}).catch((err) => {
			broadcastToAll({ type: "goal_setup_error", goalId, error: String(err) });
		});
	}
}

/**
 * Archive a goal (root or cascade). Extracted from the DELETE
 * `/api/goals/:id` handler so the parent-scoped
 * `DELETE /api/goals/:parentId/archive-child/:childId` route can
 * reuse the exact same cascade + mergedManually semantics after
 * its parent-child authorization check.
 *
 * Reads `cascade` / `mergedManually` from `url.searchParams`; writes
 * the response via the closed-over `json` helper.
 */
const archiveGoalEndpoint = async (routeCtx: CoreRouteCtx, id: string): Promise<void> => {
	const {
		getGoalAcrossProjects,
		getGoalManagerForGoal,
		json,
		prStatusStore,
		projectContextManager,
		teamManager,
		url,
		verificationHarness,
	} = routeCtx;
	// `cascade` is REQUIRED — mirrors pause/resume/teardown. The UI is
	// the cascade-policy authority; api.ts always sends ?cascade=.
	const cascadeParam = url.searchParams.get("cascade");
	if (cascadeParam !== "true" && cascadeParam !== "false") {
		json({ error: "cascade=true|false query parameter is required", code: "CASCADE_REQUIRED" }, 422);
		return;
	}
	const cascade = cascadeParam === "true";

	const rootGoal = getGoalAcrossProjects(id);
	if (!rootGoal) { json({ error: "Goal not found" }, 404); return; }

	if (!cascade) {
		const liveDescendants = listDescendants(projectContextManager, id, { includeArchived: false });
		if (liveDescendants.length > 0) {
			json({
				error: `Goal has ${liveDescendants.length} live descendant(s). Re-call with ?cascade=true to archive them all.`,
				code: "HAS_DESCENDANTS",
				count: liveDescendants.length,
			}, 409);
			return;
		}
	}

	const mergedManually = url.searchParams.get("mergedManually") === "true";

	const archiveOne = async (g: PersistedGoal): Promise<boolean> => {
		if (g.archived) {
			try {
				await cleanupGateDiagnosticsForGoal(g.id, projectContextManager.getContextForGoal(g.id)?.stateDir);
			} catch (err) {
				console.warn(`[api] archive: gate diagnostics cleanup failed for already-archived goal ${g.id}:`, err);
			}
			return false;
		}
		if (mergedManually && g.id === id && g.state !== "complete") {
			await getGoalManagerForGoal(g.id).updateGoal(g.id, { state: "complete" });
		}
		for (const active of verificationHarness.getActiveVerifications(g.id)) {
			try {
				await verificationHarness.cancelStaleVerifications(g.id, active.gateId);
			} catch (err) {
				console.error(`[api] archive: error cancelling verification for ${g.id}/${active.gateId}:`, err);
			}
		}
		const goalProjectCtx = projectContextManager.getContextForGoal(g.id);
		const teamEntry = goalProjectCtx?.teamStore.get(g.id);
		const agentBranches: string[] = [];
		if (teamEntry?.agents) {
			for (const a of teamEntry.agents) {
				if (a.branch) agentBranches.push(a.branch);
			}
		}
		if (teamEntry?.teamLeadSessionId) {
			const tl = goalProjectCtx?.sessionStore.get(teamEntry.teamLeadSessionId);
			if (tl?.branch) agentBranches.push(tl.branch);
		}
		if (teamManager.getTeamState(g.id)) {
			await teamManager.teardownTeam(g.id);
		}
		// Finding 2 — terminal event: release any per-root scheduler permit
		// this child held (or drop it from the capacity queue) so the next
		// capacity-blocked sibling can start. Best-effort + idempotent.
		if (g.parentGoalId) {
			// SWARM-W0: this is a general archive, not necessarily a merge — a
			// goal archived without ever reaching state=complete is an
			// operator-initiated "kill" from the swarm barrier's point of view
			// (see docs/design/swarm-orchestration-w0.md for why goals have no
			// separate "failed" state yet). Mirrors the mergedManually stamp
			// above (which flips this same goal's state to "complete" first).
			const swarmTerminalStatus = (g.state === "complete" || (mergedManually && g.id === id)) ? "done" : "killed";
			try { await verificationHarness.notifyChildTerminal(g.id, swarmTerminalStatus); } catch (err) {
				console.warn(`[api] archive: notifyChildTerminal failed for ${g.id} (non-fatal):`, err);
			}
		}
		const gm = getGoalManagerForGoal(g.id);
		await gm.archiveGoal(g.id);
		prStatusStore.remove(g.id);
		const archivedGoal = gm.getGoal(g.id);
		if (archivedGoal?.repoPath) {
			deleteRemoteGoalBranches(archivedGoal, agentBranches, archivedGoal.repoPath).catch(err => {
				console.warn(`[api] archive: remote branch cleanup failed for ${g.id}:`, err);
			});
		}
		return true;
	};

	if (!cascade) {
		await archiveOne(rootGoal);
		json({ ok: true, archived: 1 });
		return;
	}

	const ctx = projectContextManager.getContextForGoal(id);
	const allGoals = ctx?.goalStore.getAll() ?? [];
	const result = await cascadeGoalSubtree(
		id,
		allGoals,
		{ includeRoot: true, includeArchived: true },
		{ order: "bottom-up", apply: archiveOne },
	);
	const archivedCount = result.processed.filter(p => p.result === true).length;
	if (result.errors.length > 0) {
		for (const e of result.errors) {
			console.error(`[api] archive cascade: ${e.goalId} failed:`, e.error);
		}
	}
	json({
		ok: true,
		archived: archivedCount,
		...(result.errors.length > 0
			? { errors: result.errors.map(e => ({ goalId: e.goalId, error: e.error.message })) }
			: {}),
	});
};

// DELETE /api/goals/:parentId/archive-child/:childId — parent-scoped
// archive. Enforces parent-child relationship server-side so a
// compromised/buggy team-lead cannot archive arbitrary goals by
// supplying their id to the general DELETE /api/goals/:id route.
// Pinned by tests/e2e/parent-scoped-archive-child.spec.ts.
async function handleGoalArchiveChild(routeCtx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const {
		cookieStore,
		getGoalAcrossProjects,
		json,
		projectContextManager,
		req,
		requireSubgoalsEnabled,
		sessionManager,
		teamManager,
	} = routeCtx;
	const parentId = params.parentId;
	const childId = params.childId;
	// Subgoals feature gate — archive-child is a Children mutation.
	if (!requireSubgoalsEnabled()) return;
	// S1: archive-child is an OPERATOR Children verb (the web UI drives it),
	// so a verified human cookie is accepted; otherwise an agent caller must
	// present a spawning-session header matching the parent goal's
	// authoritative team-lead. See children-mutation-authz.ts.
	{
		const h = req.headers as Record<string, string | string[] | undefined>;
		const readHeader = (n: string): string | undefined => {
			const v = h[n.toLowerCase()];
			const s = Array.isArray(v) ? v[0] : v;
			return typeof s === "string" && s.trim() ? s.trim() : undefined;
		};
		const authz = authorizeChildrenMutation({
			mutationClass: "operator",
			isHumanOperator: cookieTryAuth(req, cookieStore!),
			// S1: derive the AUTHENTIC caller from the per-session secret,
			// never the forgeable public spawning-session header.
			authenticCallerSessionId: sessionManager.sessionSecretStore.resolveSessionIdBySecret(
				readHeader("x-bobbit-session-secret"),
			),
			teamLeadSessionId: teamManager.getTeamState(parentId)?.teamLeadSessionId,
		});
		if (!authz.ok) {
			json({
				error: "Caller session is not the team-lead for this goal",
				code: "NOT_TEAM_LEAD",
				goalId: parentId,
			}, 403);
			return;
		}
	}
	const parent = getGoalAcrossProjects(parentId);
	if (!parent) { json({ error: "Parent goal not found" }, 404); return; }
	const child = getGoalAcrossProjects(childId);
	if (!child) { json({ error: "Child goal not found" }, 404); return; }
	// Security: target must be a DIRECT child of the parent. Reject
	// non-children (siblings, roots, descendants beyond depth 1, or
	// goals from other project contexts) with 403 before touching state.
	if (child.parentGoalId !== parentId) {
		json({
			error: `Goal ${childId} is not a direct child of ${parentId} (parentGoalId=${child.parentGoalId ?? "null"}).`,
			code: "NOT_DIRECT_CHILD",
		}, 403);
		return;
	}
	// Cross-project guard — child must live in the same project context
	// as the parent. getGoalAcrossProjects can resolve both even when
	// they belong to different projects, so check explicitly.
	const parentCtx = projectContextManager.getContextForGoal(parentId);
	const childCtx = projectContextManager.getContextForGoal(childId);
	if (!parentCtx || !childCtx || parentCtx !== childCtx) {
		json({
			error: `Parent ${parentId} and child ${childId} are not in the same project context.`,
			code: "PROJECT_MISMATCH",
		}, 403);
		return;
	}
	await archiveGoalEndpoint(routeCtx, childId);
}

// DELETE /api/goals/:id
async function handleGoalDelete(routeCtx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const id = params.id;
	await archiveGoalEndpoint(routeCtx, id);
}

export function registerGoalLifecycleRoutes(table: RouteTable<CoreRouteCtx>): void {
	table.register("POST", "/api/goals/:id/retry-setup", handleGoalRetrySetup);
	table.register("DELETE", "/api/goals/:parentId/archive-child/:childId", handleGoalArchiveChild);
	table.register("DELETE", "/api/goals/:id", handleGoalDelete);
}
