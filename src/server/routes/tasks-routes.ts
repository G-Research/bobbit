// src/server/routes/tasks-routes.ts
//
// STR-01 cohort 27: task routes migrated out of handleApiRoute's legacy
// if/else chain into the core route registry. See docs/design/route-registry.md.
//
// Mechanical extraction — handler bodies below preserve the legacy behavior,
// with only handleApiRoute locals destructured from ctx and registry params
// replacing regex captures.
//
// LEGACY FALL-THROUGH PARITY: no unhandled-method shim needed. The legacy
// /api/tasks/:id block branched by method and returned only for GET/PUT/DELETE;
// other methods fell through to the terminal 404. RouteTable's method-scoped
// matching preserves that by leaving other methods unregistered.

import type { TaskState } from "../agent/task-store.js";
import type { CoreRouteCtx } from "./core-route-ctx.js";
import type { RouteTable } from "./route-table.js";

const VALID_TASK_STATES = new Set<string>(["todo", "in-progress", "blocked", "complete", "skipped"]);

// Routes with task :id parameter
// GET /api/tasks/:id
async function handleTaskGet(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { getTaskRecordForTask, json, sandboxCanAccessTask } = ctx;
	const id = params.id;
	try {
		const record = getTaskRecordForTask(id);
		if (!record) { json({ error: "Task not found" }, 404); return; }
		if (!sandboxCanAccessTask(record.task)) return;
		json(record.task);
	} catch {
		json({ error: "Task not found" }, 404);
	}
	return;
}

// PUT /api/tasks/:id
async function handleTaskPut(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { getTaskRecordForTask, json, jsonError, readBody, req, sandboxCanAccessTask, teamManager } = ctx;
	const id = params.id;
	const body = await readBody(req);
	if (!body) { json({ error: "Missing body" }, 400); return; }
	try {
		const record = getTaskRecordForTask(id);
		if (!record) { json({ error: "Task not found" }, 404); return; }
		if (!sandboxCanAccessTask(record.task)) return;
		const tm = record.taskManager;
		const task = record.task;
		const prevState = task.state;
		const ok = tm.updateTask(id, {
			title: body.title,
			spec: body.spec,
			state: body.state,
			assignedSessionId: body.assignedSessionId,
			dependsOn: body.dependsOn,
			workflowGateId: typeof body.workflowGateId === "string" ? body.workflowGateId : undefined,
			inputGateIds: Array.isArray(body.inputGateIds) ? body.inputGateIds as string[] : undefined,
			headSha: typeof body.headSha === "string" ? body.headSha : undefined,
			baseSha: typeof body.baseSha === "string" ? body.baseSha : undefined,
			branch: typeof body.branch === "string" ? body.branch : undefined,
			resultSummary: typeof body.resultSummary === "string" ? body.resultSummary : undefined,
		});
		if (!ok) { json({ error: "Task not found" }, 404); return; }

		// Notify team lead when state transitions to terminal or blocked via PUT
		if (body.state && body.state !== prevState && (body.state === "complete" || body.state === "skipped" || body.state === "blocked") && task?.goalId) {
			teamManager.notifyTeamLeadOfTaskCompletion(task.goalId, task.title, body.state);
		}

		json({ ok: true });
	} catch (err: any) {
		jsonError(400, err);
	}
	return;
}

// DELETE /api/tasks/:id
async function handleTaskDelete(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { getTaskManagerForTask, json } = ctx;
	const id = params.id;
	try {
		const ok = getTaskManagerForTask(id).deleteTask(id);
		if (!ok) { json({ error: "Task not found" }, 404); return; }
		json({ ok: true });
	} catch {
		json({ error: "Task not found" }, 404);
	}
	return;
}

// POST /api/tasks/:id/assign — assign task to session
async function handleTaskAssign(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { getTaskRecordForTask, json, jsonError, readBody, req, sandboxCanAccessTask, teamManager } = ctx;
	const body = await readBody(req);
	const sessionId = body?.sessionId;
	if (!sessionId || typeof sessionId !== "string") {
		json({ error: "Missing sessionId" }, 400);
		return;
	}
	try {
		const taskId = params.id;
		const record = getTaskRecordForTask(taskId);
		if (!record) { json({ error: "Task not found" }, 400); return; }
		if (!sandboxCanAccessTask(record.task)) return;
		const tm = record.taskManager;
		const ok = tm.assignTask(taskId, sessionId);
		if (!ok) { json({ error: "Task not found" }, 400); return; }

		// Auto-populate baseSha and branch from TeamAgent record
		const agent = teamManager.findAgentBySessionId(sessionId);
		if (agent) {
			const task = tm.getTask(taskId);
			if (task) {
				const fields: Record<string, string> = {};
				if (agent.baseSha && !task.baseSha) fields.baseSha = agent.baseSha;
				if (agent.branch && !task.branch) fields.branch = agent.branch;
				if (Object.keys(fields).length) {
					tm.updateTask(taskId, fields);
				}
			}
		}

		json({ ok: true });
	} catch (err: any) {
		jsonError(400, err);
	}
	return;
}

// POST /api/tasks/:id/transition — state transition
async function handleTaskTransition(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { getTaskRecordForTask, json, jsonError, readBody, req, sandboxCanAccessTask, teamManager } = ctx;
	const body = await readBody(req);
	const state = body?.state;
	if (!state || typeof state !== "string") {
		json({ error: "Missing state" }, 400);
		return;
	}
	if (!VALID_TASK_STATES.has(state)) {
		json({ error: `Invalid task state: ${state}` }, 400);
		return;
	}
	try {
		const taskId = params.id;
		const record = getTaskRecordForTask(taskId);
		if (!record) { json({ error: "Task not found" }, 400); return; }
		if (!sandboxCanAccessTask(record.task)) return;
		const tm = record.taskManager;
		const task = record.task;
		const ok = tm.transitionTask(taskId, state as TaskState);
		if (!ok) { json({ error: "Task not found" }, 400); return; }

		// Notify team lead when a task reaches a terminal or blocked state
		if ((state === "complete" || state === "skipped" || state === "blocked") && task?.goalId) {
			teamManager.notifyTeamLeadOfTaskCompletion(task.goalId, task.title, state);
		}

		json({ ok: true });
	} catch (err: any) {
		jsonError(400, err);
	}
	return;
}

export function registerTasksRoutes(table: RouteTable<CoreRouteCtx>): void {
	table.register("GET", "/api/tasks/:id", handleTaskGet);
	table.register("PUT", "/api/tasks/:id", handleTaskPut);
	table.register("DELETE", "/api/tasks/:id", handleTaskDelete);
	table.register("POST", "/api/tasks/:id/assign", handleTaskAssign);
	table.register("POST", "/api/tasks/:id/transition", handleTaskTransition);
}
