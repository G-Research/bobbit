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
import { resolveProjectForRequest } from "../agent/resolve-project.js";
import { deleteRemoteGoalBranches } from "../git/goal-branches.js";
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
		method: "POST",
		pattern: "/api/goals",
		handler: async ({ deps, readBody, json, jsonError }) => {
			const { config, projectRegistry, projectContextManager, sandboxManager, configCascade, teamManager, broadcastToAll } = deps;
			const body = await readBody();
			const title = body?.title;
			let cwd = body?.cwd || config.defaultCwd;
			if (!body?.cwd && body?.projectId && typeof body.projectId === "string") {
				const proj = projectRegistry.get(body.projectId);
				if (proj) cwd = proj.rootPath;
			}
			const spec = body?.spec || "";
			const workflowId = (body?.workflowId && typeof body.workflowId === "string") ? body.workflowId : "general";
			if (!title || typeof title !== "string") {
				jsonError(400, new Error("Missing title"));
				return;
			}
			try {
				const sandboxed = body.sandboxed === true;
				const autoStartTeam = body.autoStartTeam !== false;
				let enabledOptionalSteps: string[] | undefined;
				if (Array.isArray(body.enabledOptionalSteps) && body.enabledOptionalSteps.every((s: unknown) => typeof s === "string")) {
					enabledOptionalSteps = body.enabledOptionalSteps;
				}
				const resolved = resolveProjectForRequest(projectRegistry, projectContextManager, { projectId: body.projectId, cwd });
				if (!resolved.ok) { jsonError(resolved.status, new Error(resolved.error)); return; }
				const targetProjectId = resolved.projectId;
				if (!body?.cwd) cwd = resolved.project.rootPath;
				const targetCtx = projectContextManager.getOrCreate(targetProjectId);
				if (!targetCtx) {
					jsonError(400, new Error("Invalid project"));
					return;
				}
				if (sandboxed && sandboxManager) {
					try {
						await sandboxManager.ensureForProject(targetProjectId);
					} catch (err) {
						jsonError(500, err, { error: `Sandbox init failed: ${(err as Error).message || err}` });
						return;
					}
				}
				const targetGoalManager = targetCtx.goalManager;
				const cascadeWorkflows = configCascade.resolveWorkflows(targetProjectId);
				const resolvedWorkflow = cascadeWorkflows.find(r => r.item.id === workflowId)?.item;
				const goal = await targetGoalManager.createGoal(title, cwd, {
					spec,
					workflowId,
					workflowStore: targetCtx.workflowStore,
					resolvedWorkflow,
					sandboxed,
					enabledOptionalSteps,
					projectId: targetProjectId,
				});
				if (targetProjectId) {
					targetGoalManager.updateGoal(goal.id, { projectId: targetProjectId });
					goal.projectId = targetProjectId;
				}
				if (body.reattemptOf && typeof body.reattemptOf === "string") {
					targetGoalManager.updateGoal(goal.id, { reattemptOf: body.reattemptOf });
					goal.reattemptOf = body.reattemptOf;
				}
				targetGoalManager.updateGoal(goal.id, { autoStartTeam });
				goal.autoStartTeam = autoStartTeam;
				if (goal.workflow) {
					targetCtx.gateStore.initGatesForGoal(goal.id, goal.workflow.gates.map(g => g.id));
				}
				json(goal, 201);

				if (goal.setupStatus === "preparing") {
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
		},
	},
	{
		method: "DELETE",
		pattern: /^\/api\/goals\/([^/]+)$/,
		handler: async ({ deps, params, json }) => {
			const { projectContextManager, teamManager, verificationHarness, prStatusStore } = deps;
			const id = params[1];
			for (const active of verificationHarness.getActiveVerifications(id)) {
				try {
					await verificationHarness.cancelStaleVerifications(id, active.gateId);
				} catch (err) {
					console.error(`[api] Error cancelling verification for gate ${active.gateId}:`, err);
				}
			}
			const goalProjectCtx = projectContextManager.getContextForGoal(id);
			const teamEntry = goalProjectCtx?.teamStore.get(id);
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

			const teamState = teamManager.getTeamState(id);
			if (teamState) {
				try {
					await teamManager.teardownTeam(id);
				} catch (err) {
					console.error(`[api] Error tearing down team for goal ${id}:`, err);
				}
			}
			const deleteGoalMgr = getGoalManagerForGoal(deps, id);
			await deleteGoalMgr.archiveGoal(id);

			const archivedGoal = deleteGoalMgr.getGoal(id);
			if (archivedGoal?.repoPath) {
				deleteRemoteGoalBranches(archivedGoal, agentBranches, archivedGoal.repoPath).catch(err => {
					console.warn(`[api] Remote branch cleanup failed for goal ${id}:`, err);
				});
			}

			prStatusStore.remove(id);
			json({ ok: true });
		},
	},
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
		handler: ({ deps, params, json, jsonError }) => {
			const goalId = params[1];
			const retryGoalManager = getGoalManagerForGoal(deps, goalId);
			const ok = retryGoalManager.retrySetup(goalId);
			if (!ok) {
				jsonError(400, new Error("Goal not found or not in error state"));
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
		handler: ({ deps, params, json, jsonError }) => {
			const id = params[1];
			const goal = getGoalAcrossProjects(deps, id);
			if (!goal) { jsonError(404, new Error("Goal not found")); return; }
			json(goal);
		},
	},
	{
		method: "PUT",
		pattern: /^\/api\/goals\/([^/]+)$/,
		handler: async ({ deps, params, readBody, json, jsonError }) => {
			const id = params[1];
			const putGoal = getGoalAcrossProjects(deps, id);
			if (putGoal?.archived) { jsonError(409, new Error("Goal is archived")); return; }
			const body = await readBody();
			if (!body) { jsonError(400, new Error("Missing body")); return; }
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
			if (!ok) { jsonError(404, new Error("Goal not found")); return; }
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
				jsonError(409, new Error("Goal is archived"));
				return;
			}
			if (spawnGoal && spawnGoal.setupStatus !== "ready") {
				jsonError(409, new Error("Goal setup not complete"));
				return;
			}
			const body = await readBody();
			if (!body?.role || !body?.task) {
				jsonError(400, new Error("Missing role or task"));
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
				jsonError(400, new Error("Missing sessionId"));
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
		handler: ({ deps, params, json, jsonError }) => {
			const goalId = params[1];
			const state = deps.teamManager.getTeamState(goalId);
			if (!state) {
				jsonError(404, new Error("No active team for this goal"));
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
				jsonError(400, new Error("Missing sessionId or message"));
				return;
			}
			const agents = deps.teamManager.listAgents(goalId);
			if (!agents.find(a => a.sessionId === body.sessionId)) {
				jsonError(403, new Error("Session is not a member of this team"));
				return;
			}
			const session = deps.sessionManager.getSession(body.sessionId);
			if (!session) {
				jsonError(404, new Error("Session not found"));
				return;
			}
			if (session.status !== "streaming") {
				jsonError(409, new Error("Agent is not currently streaming — use team/prompt instead"));
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
				jsonError(400, new Error("Missing sessionId"));
				return;
			}
			const agents = deps.teamManager.listAgents(goalId);
			if (!agents.find(a => a.sessionId === body.sessionId)) {
				jsonError(403, new Error("Session is not a member of this team"));
				return;
			}
			const session = deps.sessionManager.getSession(body.sessionId);
			if (!session) {
				jsonError(404, new Error("Session not found"));
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
				jsonError(400, new Error("Missing sessionId or message"));
				return;
			}
			const agents = deps.teamManager.listAgents(goalId);
			if (!agents.find(a => a.sessionId === body.sessionId)) {
				jsonError(403, new Error("Session is not a member of this team"));
				return;
			}
			const session = deps.sessionManager.getSession(body.sessionId);
			if (!session) {
				jsonError(404, new Error("Session not found"));
				return;
			}
			if (session.nonInteractive) {
				jsonError(400, new Error("Cannot prompt a non-interactive (automated review) session"));
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
						jsonError(409, new Error(depError));
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
