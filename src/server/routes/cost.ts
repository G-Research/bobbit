/**
 * Cost endpoints — per-session, per-goal, per-task.
 * Extracted from server.ts (commit: split server.ts).
 */
import { getGoalAcrossProjects, getTaskManagerForTask } from "./cross-project.js";
import type { Route } from "./types.js";

export const costRoutes: Route[] = [
	{
		method: "GET",
		pattern: /^\/api\/sessions\/([^/]+)\/cost\/breakdown$/,
		handler: ({ deps, params, json }) => {
			const sessionId = params[1];
			const live = deps.sessionManager.getSession(sessionId);
			const sessionForCost = live ?? deps.sessionManager.getPersistedSession(sessionId);
			if (!sessionForCost?.projectId) {
				json({ error: "Session not found or has no project" }, 404);
				return;
			}
			const costTracker = deps.sessionManager.getCostTracker(sessionForCost.projectId);
			const allCosts = costTracker.getAllCosts();
			const sessionCost = allCosts.get(sessionId);
			if (!sessionCost) {
				json({ error: "No cost data" }, 404);
				return;
			}

			const delegates: any[] = [];
			const allSessions = [...deps.sessionManager.listSessions(), ...deps.sessionManager.listArchivedSessions()];
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
		},
	},
	{
		method: "GET",
		pattern: /^\/api\/sessions\/([^/]+)\/cost$/,
		handler: ({ deps, params, json }) => {
			const id = params[1];
			const liveSession = deps.sessionManager.getSession(id);
			const sessionForCost = liveSession ?? deps.sessionManager.getPersistedSession(id);
			if (!sessionForCost?.projectId) {
				json({ error: "Session not found or has no project" }, 404);
				return;
			}
			const cost = deps.sessionManager.getCostTracker(sessionForCost.projectId).getSessionCost(id);
			if (!cost) {
				json({ error: "No cost data for this session" }, 404);
				return;
			}
			json(cost);
		},
	},
	{
		method: "GET",
		pattern: /^\/api\/goals\/([^/]+)\/cost\/breakdown$/,
		handler: ({ deps, params, json }) => {
			const goalId = params[1];
			const goal = getGoalAcrossProjects(deps, goalId);
			if (!goal) {
				json({ error: "Goal not found" }, 404);
				return;
			}
			if (!goal.projectId) {
				json({ aggregate: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: 0 }, sessions: [] });
				return;
			}
			const sessionIds = deps.sessionManager.getAllSessionIdsForGoal(goalId);
			const costTracker = deps.sessionManager.getCostTracker(goal.projectId);
			const allCosts = costTracker.getAllCosts();

			const sessions: any[] = [];
			for (const sid of sessionIds) {
				const cost = allCosts.get(sid);
				if (!cost || cost.totalCost === 0) continue;

				const live = deps.sessionManager.listSessions().find(s => s.id === sid);
				const archived = !live ? deps.sessionManager.listArchivedSessions().find(s => s.id === sid) : null;
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

			sessions.sort((a, b) => b.totalCost - a.totalCost);

			const aggregate = costTracker.getGoalCost(goalId, sessionIds);

			json({ aggregate, sessions });
		},
	},
	{
		method: "GET",
		pattern: /^\/api\/goals\/([^/]+)\/cost$/,
		handler: ({ deps, params, json }) => {
			const goalId = params[1];
			const goal = getGoalAcrossProjects(deps, goalId);
			if (!goal) {
				json({ error: "Goal not found" }, 404);
				return;
			}
			if (!goal.projectId) {
				json({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: 0 });
				return;
			}
			const sessionIds = deps.sessionManager.getAllSessionIdsForGoal(goalId);
			const cost = deps.sessionManager.getCostTracker(goal.projectId).getGoalCost(goalId, sessionIds);
			json(cost);
		},
	},
	{
		method: "GET",
		pattern: /^\/api\/tasks\/([^/]+)\/cost$/,
		handler: ({ deps, params, json }) => {
			const taskId = params[1];
			const task = getTaskManagerForTask(deps, taskId).getTask(taskId);
			if (!task) {
				json({ error: "Task not found" }, 404);
				return;
			}
			if (!task.assignedSessionId) {
				json({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: 0 });
				return;
			}
			const taskSessionLive = deps.sessionManager.getSession(task.assignedSessionId);
			const taskSession = taskSessionLive ?? deps.sessionManager.getPersistedSession(task.assignedSessionId);
			if (!taskSession?.projectId) {
				json({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: 0 });
				return;
			}
			const cost = deps.sessionManager.getCostTracker(taskSession.projectId).getSessionCost(task.assignedSessionId);
			json(cost ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: 0 });
		},
	},
];
