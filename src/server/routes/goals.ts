/**
 * Goals routes — list, GET/PUT, retry-setup, team start/spawn/dismiss/state/
 * steer/abort/prompt/agents/complete/teardown.
 *
 * POST /api/goals (create) and DELETE /api/goals/:id (archive + branch cleanup)
 * stay in server.ts for now — they have complex auto-start-team and remote
 * branch cleanup logic worth a dedicated follow-up.
 */
import {
	getGoalAcrossProjects,
	getGoalManagerForGoal,
	listGoalsAcrossProjects,
} from "./cross-project.js";
import { GateDependencyError } from "../agent/team-manager.js";
import { checkGateDependencies } from "../agent/gate-dependency-check.js";
import type { Route } from "./types.js";

// BFS helper: walk delegateOf, teamLeadSessionId, teamGoalId, and goalId chains
// from seed IDs through an archived session pool.
function bfsEnrichArchived(seedIds: string[], allArchived: any[]): any[] {
	const result: any[] = [];
	const seen = new Set<string>();
	const queue = [...seedIds];
	while (queue.length > 0) {
		const parentId = queue.shift()!;
		for (const s of allArchived) {
			if (!seen.has(s.id) && (
				s.delegateOf === parentId ||
				s.teamLeadSessionId === parentId ||
				s.teamGoalId === parentId ||
				s.goalId === parentId
			)) {
				seen.add(s.id);
				result.push(s);
				queue.push(s.id);
			}
		}
	}
	return result;
}

export const goalsRoutes: Route[] = [
	{
		method: "GET",
		pattern: "/api/goals",
		handler: ({ deps, url, json }) => {
			if (url.searchParams.get("archived") === "true") {
				const limit = Math.min(Math.max(1, parseInt(url.searchParams.get("limit") || "50", 10) || 50), 200);
				const afterParam = url.searchParams.get("after");
				const afterCursor = afterParam ? parseInt(afterParam, 10) : undefined;
				const filterProjectId = url.searchParams.get("projectId") || undefined;
				let allArchived: any[] = [];
				for (const ctx of deps.projectContextManager.all()) {
					if (filterProjectId && ctx.project.id !== filterProjectId) continue;
					allArchived.push(...ctx.goalStore.getArchived());
				}
				allArchived.sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0));
				const total = allArchived.length;
				if (afterCursor !== undefined) {
					allArchived = allArchived.filter(g => (g.archivedAt ?? 0) < afterCursor);
				}
				const page = allArchived.slice(0, limit);
				const hasMore = allArchived.length > limit;
				const nextCursor = page.length > 0 ? page[page.length - 1].archivedAt : undefined;

				const goalIdsInPage = new Set(page.map((g: any) => g.id));
				const affiliatedSessions: any[] = [];
				const seenSessionIds = new Set<string>();
				for (const ctx of deps.projectContextManager.all()) {
					for (const s of ctx.sessionStore.getArchived()) {
						if (!seenSessionIds.has(s.id) && (goalIdsInPage.has((s as any).teamGoalId) || goalIdsInPage.has((s as any).goalId))) {
							seenSessionIds.add(s.id);
							affiliatedSessions.push({ ...s, colorIndex: deps.colorStore.get(s.id), status: "archived" });
						}
					}
				}
				const allArchivedForGoalsBfs: any[] = [];
				for (const ctx of deps.projectContextManager.all()) {
					for (const s of ctx.sessionStore.getArchived()) {
						allArchivedForGoalsBfs.push({ ...s, colorIndex: deps.colorStore.get(s.id), status: "archived" });
					}
				}
				const delegateEnriched = bfsEnrichArchived(affiliatedSessions.map(s => s.id), allArchivedForGoalsBfs);
				for (const s of delegateEnriched) {
					if (!seenSessionIds.has(s.id)) {
						seenSessionIds.add(s.id);
						affiliatedSessions.push(s);
					}
				}

				json({ goals: page, total, hasMore, nextCursor, archivedSessions: affiliatedSessions });
				return;
			}

			const currentGen = deps.projectContextManager.getGoalGeneration();
			const sinceParam = url.searchParams.get("since");
			if (sinceParam !== null) {
				const since = parseInt(sinceParam, 10);
				if (!isNaN(since) && since === currentGen) {
					json({ generation: currentGen, changed: false });
					return;
				}
			}
			const filterProjectId = url.searchParams.get("projectId") || undefined;
			const goals = listGoalsAcrossProjects(deps, { projectId: filterProjectId });
			json({ generation: currentGen, goals });
		},
	},
	{
		method: "POST",
		pattern: /^\/api\/goals\/([^/]+)\/retry-setup$/,
		handler: ({ deps, params, json }) => {
			const goalId = params[1];
			const retryGoalManager = getGoalManagerForGoal(deps, goalId);
			const ok = retryGoalManager.retrySetup(goalId);
			if (!ok) {
				json({ error: "Goal not found or not in error state" }, 400);
				return;
			}
			json({ ok: true });
			const retryGoal = retryGoalManager.getGoal(goalId);
			if (retryGoal?.autoStartTeam) {
				retryGoalManager.setupWorktreeAndStartTeam(goalId, () => deps.teamManager.startTeam(goalId)).then(() => {
					deps.broadcastToAll({ type: "goal_setup_complete", goalId });
				}).catch((err) => {
					const g = retryGoalManager.getGoal(goalId);
					if (g?.setupStatus === "ready") {
						deps.broadcastToAll({ type: "goal_setup_complete", goalId });
						console.error("[goal] Auto-start team failed on retry (worktree ready):", err);
					} else {
						deps.broadcastToAll({ type: "goal_setup_error", goalId, error: String(err) });
					}
				});
			} else {
				retryGoalManager.setupWorktree(goalId).then(() => {
					deps.broadcastToAll({ type: "goal_setup_complete", goalId });
				}).catch((err) => {
					deps.broadcastToAll({ type: "goal_setup_error", goalId, error: String(err) });
				});
			}
		},
	},
	{
		method: "GET",
		pattern: /^\/api\/goals\/([^/]+)$/,
		handler: ({ deps, params, json }) => {
			const id = params[1];
			const goal = getGoalAcrossProjects(deps, id);
			if (!goal) { json({ error: "Goal not found" }, 404); return; }
			json(goal);
		},
	},
	{
		method: "PUT",
		pattern: /^\/api\/goals\/([^/]+)$/,
		handler: async ({ deps, params, readBody, json }) => {
			const id = params[1];
			const putGoal = getGoalAcrossProjects(deps, id);
			if (putGoal?.archived) { json({ error: "Goal is archived" }, 409); return; }
			const body = await readBody();
			if (!body) { json({ error: "Missing body" }, 400); return; }
			const goalMgr = getGoalManagerForGoal(deps, id);
			const ok = await goalMgr.updateGoal(id, {
				title: body.title,
				cwd: body.cwd,
				state: body.state,
				spec: body.spec,
				team: true,
				repoPath: body.repoPath,
				branch: body.branch,
				reattemptOf: body.reattemptOf,
			});
			if (!ok) { json({ error: "Goal not found" }, 404); return; }
			json({ ok: true });
		},
	},
	// ── Team endpoints (accept /team or legacy /swarm) ──
	{
		method: "POST",
		pattern: /^\/api\/goals\/([^/]+)\/(?:team|swarm)\/start$/,
		handler: async ({ deps, params, json, jsonError }) => {
			const goalId = params[1];
			try {
				const session = await deps.teamManager.startTeam(goalId);
				json({ sessionId: session.id, title: session.title }, 201);
			} catch (err) {
				jsonError(400, err);
			}
		},
	},
	{
		method: "POST",
		pattern: /^\/api\/goals\/([^/]+)\/(?:team|swarm)\/spawn$/,
		handler: async ({ deps, params, readBody, json, jsonError }) => {
			const goalId = params[1];
			const spawnGoal = getGoalAcrossProjects(deps, goalId);
			if (spawnGoal?.archived) {
				json({ error: "Goal is archived" }, 409);
				return;
			}
			if (spawnGoal && spawnGoal.setupStatus !== "ready") {
				json({ error: "Goal setup not complete" }, 409);
				return;
			}
			const body = await readBody();
			if (!body?.role || !body?.task) {
				json({ error: "Missing role or task" }, 400);
				return;
			}
			try {
				const spawnOpts: { workflowGateId?: string; inputGateIds?: string[] } = {};
				if (typeof body.workflowGateId === "string") spawnOpts.workflowGateId = body.workflowGateId;
				if (Array.isArray(body.inputGateIds)) spawnOpts.inputGateIds = body.inputGateIds as string[];
				const result = await deps.teamManager.spawnRole(goalId, body.role, body.task, spawnOpts);
				json(result, 201);
			} catch (err) {
				if (err instanceof GateDependencyError) {
					jsonError(409, err);
				} else {
					jsonError(400, err);
				}
			}
		},
	},
	{
		method: "POST",
		pattern: /^\/api\/goals\/([^/]+)\/(?:team|swarm)\/dismiss$/,
		handler: async ({ deps, readBody, json, jsonError }) => {
			const body = await readBody();
			if (!body?.sessionId) {
				json({ error: "Missing sessionId" }, 400);
				return;
			}
			try {
				const ok = await deps.teamManager.dismissRole(body.sessionId);
				json({ ok });
			} catch (err) {
				jsonError(400, err);
			}
		},
	},
	{
		method: "GET",
		pattern: /^\/api\/goals\/([^/]+)\/(?:team|swarm)$/,
		handler: ({ deps, params, json }) => {
			const goalId = params[1];
			const state = deps.teamManager.getTeamState(goalId);
			if (!state) {
				json({ error: "No active team for this goal" }, 404);
				return;
			}
			json(state);
		},
	},
	{
		method: "POST",
		pattern: /^\/api\/goals\/([^/]+)\/(?:team|swarm)\/steer$/,
		handler: async ({ deps, params, readBody, json, jsonError }) => {
			const goalId = params[1];
			const body = await readBody();
			if (!body?.sessionId || !body?.message) {
				json({ error: "Missing sessionId or message" }, 400);
				return;
			}
			const agents = deps.teamManager.listAgents(goalId);
			if (!agents.find(a => a.sessionId === body.sessionId)) {
				json({ error: "Session is not a member of this team" }, 403);
				return;
			}
			const session = deps.sessionManager.getSession(body.sessionId);
			if (!session) {
				json({ error: "Session not found" }, 404);
				return;
			}
			if (session.status !== "streaming") {
				json({ error: "Agent is not currently streaming — use team/prompt instead" }, 409);
				return;
			}
			try {
				await deps.sessionManager.deliverLiveSteer(session.id, body.message);
				json({ ok: true, dispatched: true });
			} catch (err) {
				jsonError(500, err);
			}
		},
	},
	{
		method: "POST",
		pattern: /^\/api\/goals\/([^/]+)\/(?:team|swarm)\/abort$/,
		handler: async ({ deps, params, readBody, json, jsonError }) => {
			const goalId = params[1];
			const body = await readBody();
			if (!body?.sessionId) {
				json({ error: "Missing sessionId" }, 400);
				return;
			}
			const agents = deps.teamManager.listAgents(goalId);
			if (!agents.find(a => a.sessionId === body.sessionId)) {
				json({ error: "Session is not a member of this team" }, 403);
				return;
			}
			const session = deps.sessionManager.getSession(body.sessionId);
			if (!session) {
				json({ error: "Session not found" }, 404);
				return;
			}
			try {
				await deps.sessionManager.forceAbort(body.sessionId);
				const afterSession = deps.sessionManager.getSession(body.sessionId);
				json({ ok: true, status: afterSession?.status || "idle" });
			} catch (err) {
				jsonError(500, err);
			}
		},
	},
	{
		method: "POST",
		pattern: /^\/api\/goals\/([^/]+)\/(?:team|swarm)\/prompt$/,
		handler: async ({ deps, params, readBody, json, jsonError }) => {
			const goalId = params[1];
			const body = await readBody();
			if (!body?.sessionId || !body?.message) {
				json({ error: "Missing sessionId or message" }, 400);
				return;
			}
			const agents = deps.teamManager.listAgents(goalId);
			if (!agents.find(a => a.sessionId === body.sessionId)) {
				json({ error: "Session is not a member of this team" }, 403);
				return;
			}
			const session = deps.sessionManager.getSession(body.sessionId);
			if (!session) {
				json({ error: "Session not found" }, 404);
				return;
			}
			if (session.nonInteractive) {
				json({ error: "Cannot prompt a non-interactive (automated review) session" }, 400);
				return;
			}
			const wfGateId = typeof body.workflowGateId === "string" ? body.workflowGateId : undefined;
			const inputIds = Array.isArray(body.inputGateIds) ? body.inputGateIds as string[] : undefined;
			if (wfGateId) {
				const goal = getGoalAcrossProjects(deps, goalId);
				const goalGateCtx = deps.projectContextManager.getContextForGoal(goalId);
				const goalGateStore = goalGateCtx?.gateStore;
				if (goal?.workflow && goalGateStore) {
					const gateStates = goalGateStore.getGatesForGoal(goalId);
					const depError = checkGateDependencies(wfGateId, goal.workflow.gates, gateStates);
					if (depError) {
						json({ error: depError }, 409);
						return;
					}
				}
			}
			try {
				let message = body.message as string;
				if (wfGateId || inputIds?.length) {
					const ctx = deps.teamManager.buildDependencyContext(goalId, wfGateId, inputIds);
					if (ctx) {
						message = ctx + "\n\n---\n\n" + message;
					}
				}
				await deps.sessionManager.enqueuePrompt(body.sessionId, message);
				json({ ok: true, status: session.status === "idle" ? "dispatched" : "queued" });
			} catch (err) {
				jsonError(500, err);
			}
		},
	},
	{
		method: "GET",
		pattern: /^\/api\/goals\/([^/]+)\/(?:team|swarm)\/agents$/,
		handler: ({ deps, params, url, json }) => {
			const goalId = params[1];
			const agents = deps.teamManager.listAgents(goalId);
			const includeArchived = url.searchParams.get("include") === "archived";
			let archivedAgents: unknown[] = [];
			if (includeArchived) {
				const liveSessionIds = new Set(agents.map((a: any) => a.sessionId));
				archivedAgents = deps.sessionManager.listArchivedSessions()
					.filter(s => s.teamGoalId === goalId && !liveSessionIds.has(s.id))
					.map(s => ({
						sessionId: s.id,
						role: s.role || "unknown",
						status: "archived",
						worktreePath: s.worktreePath || "",
						branch: "",
						task: "",
						createdAt: s.createdAt,
						archivedAt: s.archivedAt,
						title: s.title,
						accessory: s.accessory,
						taskId: s.taskId,
						teamLeadSessionId: s.teamLeadSessionId,
						teamGoalId: s.teamGoalId,
						delegateOf: s.delegateOf,
					}));
			}

			json({ agents: [...agents, ...archivedAgents] });
		},
	},
	{
		method: "POST",
		pattern: /^\/api\/goals\/([^/]+)\/(?:team|swarm)\/complete$/,
		handler: async ({ deps, params, json, jsonError }) => {
			const goalId = params[1];
			try {
				await deps.teamManager.completeTeam(goalId);
				json({ ok: true });
			} catch (err) {
				jsonError(400, err);
			}
		},
	},
	{
		method: "POST",
		pattern: /^\/api\/goals\/([^/]+)\/(?:team|swarm)\/teardown$/,
		handler: async ({ deps, params, json, jsonError }) => {
			const goalId = params[1];
			try {
				await deps.teamManager.teardownTeam(goalId);
				json({ ok: true });
			} catch (err) {
				jsonError(400, err);
			}
		},
	},
];
