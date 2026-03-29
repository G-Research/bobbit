import http from "node:http";
import type { AppContext } from "../app-context.js";
import { readBody, json } from "./utils.js";
import { GateDependencyError } from "../agent/team-manager.js";

export async function handle(ctx: AppContext, url: URL, req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
	const { teamManager, sessionManager, gateStore } = ctx;

	// POST /api/goals/:id/team/start — start a team for a goal
	const teamStartMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/(?:team|swarm)\/start$/);
	if (teamStartMatch && req.method === "POST") {
		const goalId = teamStartMatch[1];
		try {
			const session = await teamManager.startTeam(goalId);
			json(res, { sessionId: session.id, title: session.title }, 201);
		} catch (err) {
			json(res, { error: String(err) }, 400);
		}
		return true;
	}

	// POST /api/goals/:id/team/spawn — spawn a role agent
	const teamSpawnMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/(?:team|swarm)\/spawn$/);
	if (teamSpawnMatch && req.method === "POST") {
		const goalId = teamSpawnMatch[1];
		// Guard: reject spawn if goal is archived
		const spawnGoal = sessionManager.goalManager.getGoal(goalId);
		if (spawnGoal?.archived) {
			json(res, { error: "Goal is archived" }, 409);
			return true;
		}
		// Guard: reject spawn if goal worktree is not ready
		if (spawnGoal && spawnGoal.setupStatus !== "ready") {
			json(res, { error: "Goal setup not complete" }, 409);
			return true;
		}
		const body = await readBody(req);
		if (!body?.role || !body?.task) {
			json(res, { error: "Missing role or task" }, 400);
			return true;
		}
		try {
			const spawnOpts: { personalities?: string[]; workflowGateId?: string; inputGateIds?: string[] } = {};
			if (Array.isArray(body.personalities)) spawnOpts.personalities = body.personalities as string[];
			if (typeof body.workflowGateId === "string") spawnOpts.workflowGateId = body.workflowGateId;
			if (Array.isArray(body.inputGateIds)) spawnOpts.inputGateIds = body.inputGateIds as string[];
			const result = await teamManager.spawnRole(goalId, body.role, body.task, spawnOpts);
			json(res, result, 201);
		} catch (err) {
			if (err instanceof GateDependencyError) {
				json(res, { error: String(err.message) }, 409);
			} else {
				json(res, { error: String(err) }, 400);
			}
		}
		return true;
	}

	// POST /api/goals/:id/team/dismiss — dismiss a role agent
	const teamDismissMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/(?:team|swarm)\/dismiss$/);
	if (teamDismissMatch && req.method === "POST") {
		const body = await readBody(req);
		if (!body?.sessionId) {
			json(res, { error: "Missing sessionId" }, 400);
			return true;
		}
		try {
			const ok = await teamManager.dismissRole(body.sessionId);
			json(res, { ok });
		} catch (err) {
			json(res, { error: String(err) }, 400);
		}
		return true;
	}

	// GET /api/goals/:id/team — get team state
	const teamStateMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/(?:team|swarm)$/);
	if (teamStateMatch && req.method === "GET") {
		const goalId = teamStateMatch[1];
		const state = teamManager.getTeamState(goalId);
		if (!state) {
			json(res, { error: "No active team for this goal" }, 404);
			return true;
		}
		json(res, state);
		return true;
	}

	// POST /api/goals/:id/team/steer — steer a team agent mid-turn
	const teamSteerMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/(?:team|swarm)\/steer$/);
	if (teamSteerMatch && req.method === "POST") {
		const goalId = teamSteerMatch[1];
		const body = await readBody(req);
		if (!body?.sessionId || !body?.message) {
			json(res, { error: "Missing sessionId or message" }, 400);
			return true;
		}
		// Validate target is a team agent
		const agents = teamManager.listAgents(goalId);
		if (!agents.find(a => a.sessionId === body.sessionId)) {
			json(res, { error: "Session is not a member of this team" }, 403);
			return true;
		}
		const session = sessionManager.getSession(body.sessionId);
		if (!session) {
			json(res, { error: "Session not found" }, 404);
			return true;
		}
		if (session.nonInteractive) {
			json(res, { error: "Cannot steer a non-interactive (automated review) session" }, 400);
			return true;
		}
		if (session.status !== "streaming") {
			json(res, { error: "Agent is not currently streaming — use team/prompt instead" }, 409);
			return true;
		}
		try {
			await session.rpcClient.steer(body.message);
			json(res, { ok: true, dispatched: true });
		} catch (err) {
			json(res, { error: String(err) }, 500);
		}
		return true;
	}

	// POST /api/goals/:id/team/abort — force-abort a stuck team agent
	const teamAbortMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/(?:team|swarm)\/abort$/);
	if (teamAbortMatch && req.method === "POST") {
		const goalId = teamAbortMatch[1];
		const body = await readBody(req);
		if (!body?.sessionId) {
			json(res, { error: "Missing sessionId" }, 400);
			return true;
		}
		// Validate target is a team agent
		const agents = teamManager.listAgents(goalId);
		if (!agents.find(a => a.sessionId === body.sessionId)) {
			json(res, { error: "Session is not a member of this team" }, 403);
			return true;
		}
		const session = sessionManager.getSession(body.sessionId);
		if (!session) {
			json(res, { error: "Session not found" }, 404);
			return true;
		}
		try {
			await sessionManager.forceAbort(body.sessionId);
			const afterSession = sessionManager.getSession(body.sessionId);
			json(res, { ok: true, status: afterSession?.status || "idle" });
		} catch (err) {
			json(res, { error: String(err) }, 500);
		}
		return true;
	}

	// POST /api/goals/:id/team/prompt — send a prompt to a team agent (queued or immediate)
	const teamPromptMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/(?:team|swarm)\/prompt$/);
	if (teamPromptMatch && req.method === "POST") {
		const goalId = teamPromptMatch[1];
		const body = await readBody(req);
		if (!body?.sessionId || !body?.message) {
			json(res, { error: "Missing sessionId or message" }, 400);
			return true;
		}
		// Validate target is a team agent
		const agents = teamManager.listAgents(goalId);
		if (!agents.find(a => a.sessionId === body.sessionId)) {
			json(res, { error: "Session is not a member of this team" }, 403);
			return true;
		}
		const session = sessionManager.getSession(body.sessionId);
		if (!session) {
			json(res, { error: "Session not found" }, 404);
			return true;
		}
		if (session.nonInteractive) {
			json(res, { error: "Cannot prompt a non-interactive (automated review) session" }, 400);
			return true;
		}
		// Enforce gate dependency check for team/prompt
		const wfGateId = typeof body.workflowGateId === "string" ? body.workflowGateId : undefined;
		const inputIds = Array.isArray(body.inputGateIds) ? body.inputGateIds as string[] : undefined;
		if (wfGateId) {
			const goal = sessionManager.goalManager.getGoal(goalId);
			if (goal?.workflow && gateStore) {
				const wfGate = goal.workflow.gates.find((g: any) => g.id === wfGateId);
				if (wfGate?.dependsOn?.length) {
					const gateStates = gateStore.getGatesForGoal(goalId);
					const passedIds = new Set(gateStates.filter((g: any) => g.status === "passed").map((g: any) => g.gateId));
					const notPassed = wfGate.dependsOn.filter((depId: string) => !passedIds.has(depId));
					if (notPassed.length > 0) {
						const names = notPassed.map((id: string) => {
							const def = goal.workflow!.gates.find((g: any) => g.id === id);
							return def ? `${def.name} (${id})` : id;
						});
						json(res, { error: `Upstream gate(s) not passed: ${names.join(", ")}. Cannot prompt for gate "${wfGateId}" until dependencies are met.` }, 409);
						return true;
					}
				}
			}
		}
		try {
			// Resolve workflow gate context and prepend to message if provided
			let message = body.message as string;
			if (wfGateId || inputIds?.length) {
				const depCtx = teamManager.buildDependencyContext(goalId, wfGateId, inputIds);
				if (depCtx) {
					message = depCtx + "\n\n---\n\n" + message;
				}
			}
			await sessionManager.enqueuePrompt(body.sessionId, message);
			json(res, { ok: true, status: session.status === "idle" ? "dispatched" : "queued" });
		} catch (err) {
			json(res, { error: String(err) }, 500);
		}
		return true;
	}

	// GET /api/goals/:id/team/agents — list agents for a team goal
	const teamAgentsMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/(?:team|swarm)\/agents$/);
	if (teamAgentsMatch && req.method === "GET") {
		const goalId = teamAgentsMatch[1];
		const agents = teamManager.listAgents(goalId);

		// Include archived (dismissed) agents when ?include=archived is set
		const includeArchived = url.searchParams.get("include") === "archived";
		let archivedAgents: unknown[] = [];
		if (includeArchived) {
			const liveSessionIds = new Set(agents.map((a: any) => a.sessionId));
			archivedAgents = sessionManager.listArchivedSessions()
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
				}));
		}

		json(res, { agents: [...agents, ...archivedAgents] });
		return true;
	}

	// POST /api/goals/:id/team/complete — complete a team (dismiss agents, keep team lead)
	const teamCompleteMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/(?:team|swarm)\/complete$/);
	if (teamCompleteMatch && req.method === "POST") {
		const goalId = teamCompleteMatch[1];
		try {
			await teamManager.completeTeam(goalId);
			json(res, { ok: true });
		} catch (err) {
			json(res, { error: String(err) }, 400);
		}
		return true;
	}

	// POST /api/goals/:id/team/teardown — fully tear down a team (dismiss agents + terminate team lead)
	const teamTeardownMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/(?:team|swarm)\/teardown$/);
	if (teamTeardownMatch && req.method === "POST") {
		const goalId = teamTeardownMatch[1];
		try {
			await teamManager.teardownTeam(goalId);
			json(res, { ok: true });
		} catch (err) {
			json(res, { error: String(err) }, 400);
		}
		return true;
	}

	return false;
}
