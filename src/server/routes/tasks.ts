import type { IncomingMessage, ServerResponse } from "node:http";
import type { AppContext } from "../app-context.js";
import type { TaskState } from "../agent/task-store.js";
import { readBody, json } from "./utils.js";

const VALID_TASK_STATES = new Set<string>(["todo", "in-progress", "blocked", "complete", "skipped"]);

export async function handle(
	ctx: AppContext,
	url: URL,
	req: IncomingMessage,
	res: ServerResponse,
): Promise<boolean> {
	const { sessionManager, teamManager } = ctx;

	// GET /api/goals/:goalId/tasks — list tasks for a goal
	const goalTasksMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/tasks$/);
	if (goalTasksMatch && req.method === "GET") {
		const tasks = sessionManager.taskManager.getTasksForGoal(goalTasksMatch[1]);
		json(res, { tasks });
		return true;
	}

	// POST /api/goals/:goalId/tasks — create a task
	if (goalTasksMatch && req.method === "POST") {
		const goalId = goalTasksMatch[1];
		const goal = sessionManager.goalManager.getGoal(goalId);
		if (!goal) { json(res, { error: "Goal not found" }, 404); return true; }
		if (goal.archived) { json(res, { error: "Goal is archived" }, 409); return true; }

		const body = await readBody(req);
		const title = body?.title;
		const type = body?.type;
		if (!title || typeof title !== "string") {
			json(res, { error: "Missing title" }, 400);
			return true;
		}
		if (!type || typeof type !== "string") {
			json(res, { error: "Missing type" }, 400);
			return true;
		}
		try {
			const task = sessionManager.taskManager.createTask(goalId, title, type, {
				parentTaskId: body.parentTaskId,
				spec: body.spec,
				dependsOn: body.dependsOn,
				workflowGateId: typeof body.workflowGateId === "string" ? body.workflowGateId : undefined,
				inputGateIds: Array.isArray(body.inputGateIds) ? body.inputGateIds as string[] : undefined,
			});
			json(res, task, 201);
		} catch (err: any) {
			json(res, { error: err.message }, 400);
		}
		return true;
	}

	// Routes with task :id parameter
	const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
	if (taskMatch) {
		const id = taskMatch[1];

		// GET /api/tasks/:id
		if (req.method === "GET") {
			const task = sessionManager.taskManager.getTask(id);
			if (!task) { json(res, { error: "Task not found" }, 404); return true; }
			json(res, task);
			return true;
		}

		// PUT /api/tasks/:id
		if (req.method === "PUT") {
			const body = await readBody(req);
			if (!body) { json(res, { error: "Missing body" }, 400); return true; }
			try {
				const task = sessionManager.taskManager.getTask(id);
				const prevState = task?.state;
				const ok = sessionManager.taskManager.updateTask(id, {
					title: body.title,
					spec: body.spec,
					state: body.state,
					assignedSessionId: body.assignedSessionId,
					dependsOn: body.dependsOn,
					workflowGateId: typeof body.workflowGateId === "string" ? body.workflowGateId : undefined,
					inputGateIds: Array.isArray(body.inputGateIds) ? body.inputGateIds as string[] : undefined,
				});
				if (!ok) { json(res, { error: "Task not found" }, 404); return true; }

				// Notify team lead when state transitions to terminal or blocked via PUT
				if (body.state && body.state !== prevState && (body.state === "complete" || body.state === "skipped" || body.state === "blocked") && task?.goalId) {
					teamManager.notifyTeamLeadOfTaskCompletion(task.goalId, task.title, body.state);
				}

				json(res, { ok: true });
			} catch (err: any) {
				json(res, { error: err.message }, 400);
			}
			return true;
		}

		// DELETE /api/tasks/:id
		if (req.method === "DELETE") {
			const ok = sessionManager.taskManager.deleteTask(id);
			if (!ok) { json(res, { error: "Task not found" }, 404); return true; }
			json(res, { ok: true });
			return true;
		}
	}

	// POST /api/tasks/:id/assign — assign task to session
	const taskAssignMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/assign$/);
	if (taskAssignMatch && req.method === "POST") {
		const body = await readBody(req);
		const sessionId = body?.sessionId;
		if (!sessionId || typeof sessionId !== "string") {
			json(res, { error: "Missing sessionId" }, 400);
			return true;
		}
		try {
			const ok = sessionManager.taskManager.assignTask(taskAssignMatch[1], sessionId);
			if (!ok) { json(res, { error: "Task not found" }, 400); return true; }
			json(res, { ok: true });
		} catch (err: any) {
			json(res, { error: err.message }, 400);
		}
		return true;
	}

	// POST /api/tasks/:id/transition — state transition
	const taskTransitionMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/transition$/);
	if (taskTransitionMatch && req.method === "POST") {
		const body = await readBody(req);
		const state = body?.state;
		if (!state || typeof state !== "string") {
			json(res, { error: "Missing state" }, 400);
			return true;
		}
		if (!VALID_TASK_STATES.has(state)) {
			json(res, { error: `Invalid task state: ${state}` }, 400);
			return true;
		}
		try {
			const taskId = taskTransitionMatch[1];
			const task = sessionManager.taskManager.getTask(taskId);
			const ok = sessionManager.taskManager.transitionTask(taskId, state as TaskState);
			if (!ok) { json(res, { error: "Task not found" }, 400); return true; }

			// Notify team lead when a task reaches a terminal or blocked state
			if ((state === "complete" || state === "skipped" || state === "blocked") && task?.goalId) {
				teamManager.notifyTeamLeadOfTaskCompletion(task.goalId, task.title, state);
			}

			json(res, { ok: true });
		} catch (err: any) {
			json(res, { error: err.message }, 400);
		}
		return true;
	}

	return false;
}
