// src/server/routes/cost-routes.ts
//
// STR-01 cohort 16a: Cost endpoints migrated out of handleApiRoute's legacy
// if/else chain into the core route registry. See docs/design/route-registry.md.
//
// Mechanical extraction — handler bodies below preserve the legacy behavior,
// with only handleApiRoute locals destructured from ctx.
//
// LEGACY FALL-THROUGH PARITY: no unhandled-method shim needed. Every legacy
// block gated on route match and method in the same `if` condition. A method
// mismatch skipped the block and fell through to the terminal 404; RouteTable's
// method-scoped matching preserves that by leaving other methods unregistered.

import type { CoreRouteCtx } from "./core-route-ctx.js";
import type { RouteTable } from "./route-table.js";

const zeroCost = {
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	totalCost: 0,
	cacheHitRate: null,
};

// GET /api/sessions/:id/cost/breakdown — cost breakdown including delegates.
async function handleSessionCostBreakdown(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { json, sessionManager } = ctx;
	const sessionId = params.id;
	const live = sessionManager.getSession(sessionId);
	const sessionForCost = live ?? sessionManager.getPersistedSession(sessionId);
	if (!sessionForCost?.projectId) {
		json({ error: "Session not found or has no project" }, 404);
		return;
	}
	const costTracker = sessionManager.getCostTracker(sessionForCost.projectId);
	const allCosts = costTracker.getAllCosts();
	const sessionCost = allCosts.get(sessionId);
	if (!sessionCost) {
		json({ error: "No cost data" }, 404);
		return;
	}

	// Find delegate sessions.
	const delegates: any[] = [];
	const allSessions = [...sessionManager.listSessions(), ...sessionManager.listArchivedSessions()];
	for (const s of allSessions) {
		if ((s as any).delegateOf === sessionId) {
			const dCost = allCosts.get(s.id);
			if (dCost && dCost.totalCost > 0) {
				delegates.push({
					sessionId: s.id,
					title: (s as any).title || s.id.slice(0, 8),
					...dCost,
				});
			}
		}
	}
	delegates.sort((a, b) => b.totalCost - a.totalCost);

	json({
		session: { sessionId, ...sessionCost },
		delegates,
	});
	return;
}

// GET /api/sessions/:id/cost — cost for a single session.
async function handleSessionCost(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { json, sessionManager } = ctx;
	const id = params.id;
	const liveSession = sessionManager.getSession(id);
	const sessionForCost = liveSession ?? sessionManager.getPersistedSession(id);
	if (!sessionForCost?.projectId) {
		json({ error: "Session not found or has no project" }, 404);
		return;
	}
	const cost = sessionManager.getCostTracker(sessionForCost.projectId).getSessionCost(id);
	if (!cost) {
		json({ error: "No cost data for this session" }, 404);
		return;
	}
	json(cost);
	return;
}

// GET /api/goals/:goalId/cost/breakdown — per-session cost breakdown for a goal.
async function handleGoalCostBreakdown(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { getGoalAcrossProjects, json, sessionManager } = ctx;
	const goalId = params.goalId;
	const goal = getGoalAcrossProjects(goalId);
	if (!goal) {
		json({ error: "Goal not found" }, 404);
		return;
	}
	if (!goal.projectId) {
		json({ aggregate: zeroCost, sessions: [] });
		return;
	}
	const sessionIds = sessionManager.getAllSessionIdsForGoal(goalId);
	const costTracker = sessionManager.getCostTracker(goal.projectId);
	const allCosts = costTracker.getAllCosts();

	// Build per-session breakdown with metadata.
	const sessions: any[] = [];
	for (const sid of sessionIds) {
		const cost = allCosts.get(sid);
		if (!cost || cost.totalCost === 0) continue;

		// Get session metadata from live sessions or store.
		const live = sessionManager.listSessions().find(s => s.id === sid);
		const archived = !live ? sessionManager.listArchivedSessions().find(s => s.id === sid) : null;
		const meta = live || archived;

		sessions.push({
			sessionId: sid,
			title: (meta as any)?.title || sid.slice(0, 8),
			role: (meta as any)?.role || null,
			delegateOf: (meta as any)?.delegateOf || null,
			assistantType: (meta as any)?.assistantType || null,
			taskId: (meta as any)?.taskId || null,
			...cost,
		});
	}

	// Sort by cost descending.
	sessions.sort((a, b) => b.totalCost - a.totalCost);

	// Compute aggregate.
	const aggregate = costTracker.getGoalCost(goalId, sessionIds);

	json({ aggregate, sessions });
	return;
}

// GET /api/goals/:goalId/cost — aggregate cost across all sessions linked to a goal.
async function handleGoalCost(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { getGoalAcrossProjects, json, sessionManager } = ctx;
	const goalId = params.goalId;
	const goal = getGoalAcrossProjects(goalId);
	if (!goal) {
		json({ error: "Goal not found" }, 404);
		return;
	}
	if (!goal.projectId) {
		json(zeroCost);
		return;
	}
	const sessionIds = sessionManager.getAllSessionIdsForGoal(goalId);
	const cost = sessionManager.getCostTracker(goal.projectId).getGoalCost(goalId, sessionIds);
	json(cost);
	return;
}

// GET /api/tasks/:id/cost — cost for the session(s) assigned to a task.
async function handleTaskCost(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { getTaskManagerForTask, json, sessionManager } = ctx;
	const taskId = params.id;
	const task = getTaskManagerForTask(taskId).getTask(taskId);
	if (!task) {
		json({ error: "Task not found" }, 404);
		return;
	}
	if (!task.assignedSessionId) {
		json(zeroCost);
		return;
	}
	const taskSessionLive = sessionManager.getSession(task.assignedSessionId);
	const taskSession = taskSessionLive ?? sessionManager.getPersistedSession(task.assignedSessionId);
	if (!taskSession?.projectId) {
		json(zeroCost);
		return;
	}
	const cost = sessionManager.getCostTracker(taskSession.projectId).getSessionCost(task.assignedSessionId);
	json(cost ?? zeroCost);
	return;
}

export function registerCostRoutes(table: RouteTable<CoreRouteCtx>): void {
	table.register("GET", "/api/sessions/:id/cost/breakdown", handleSessionCostBreakdown);
	table.register("GET", "/api/sessions/:id/cost", handleSessionCost);
	table.register("GET", "/api/goals/:goalId/cost/breakdown", handleGoalCostBreakdown);
	table.register("GET", "/api/goals/:goalId/cost", handleGoalCost);
	table.register("GET", "/api/tasks/:id/cost", handleTaskCost);
}
