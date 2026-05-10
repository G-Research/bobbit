/**
 * Task CRUD + assign + transition + nested under /goals/:id/tasks.
 * Extracted from server.ts (commit: split server.ts).
 */
import {
	getGoalAcrossProjects,
	getTaskManagerForGoal,
	getTaskManagerForTask,
} from "./cross-project.js";
import type { TaskState } from "../agent/task-store.js";
import type { Route } from "./types.js";

const VALID_TASK_STATES = new Set<string>(["todo", "in-progress", "blocked", "complete", "skipped"]);

export const tasksRoutes: Route[] = [
	{
		method: "GET",
		pattern: /^\/api\/goals\/([^/]+)\/tasks$/,
		handler: ({ deps, params, url, json }) => {
			const goalId = params[1];
			const tasks = getTaskManagerForGoal(deps, goalId).getTasksForGoal(goalId);
			if (url.searchParams.get("view") === "summary") {
				const slim = tasks.map(t => ({
					id: t.id,
					title: t.title,
					type: t.type,
					state: t.state,
					assignedSessionId: t.assignedSessionId,
					branch: t.branch,
					headSha: t.headSha,
					workflowGateId: t.workflowGateId,
					dependsOn: t.dependsOn || [],
				}));
				json({ tasks: slim });
				return;
			}
			json({ tasks });
		},
	},
	{
		method: "POST",
		pattern: /^\/api\/goals\/([^/]+)\/tasks$/,
		handler: async ({ deps, params, readBody, json, jsonError }) => {
			const goalId = params[1];
			const goal = getGoalAcrossProjects(deps, goalId);
			if (!goal) { json({ error: "Goal not found" }, 404); return; }
			if (goal.archived) { json({ error: "Goal is archived" }, 409); return; }

			const body = await readBody();
			const title = body?.title;
			const type = body?.type;
			if (!title || typeof title !== "string") {
				json({ error: "Missing title" }, 400);
				return;
			}
			if (!type || typeof type !== "string") {
				json({ error: "Missing type" }, 400);
				return;
			}
			try {
				const task = getTaskManagerForGoal(deps, goalId).createTask(goalId, title, type, {
					parentTaskId: body.parentTaskId,
					spec: body.spec,
					dependsOn: body.dependsOn,
					workflowGateId: typeof body.workflowGateId === "string" ? body.workflowGateId : undefined,
					inputGateIds: Array.isArray(body.inputGateIds) ? body.inputGateIds as string[] : undefined,
				});
				json(task, 201);
			} catch (err: any) {
				jsonError(400, err);
			}
		},
	},
	{
		method: "GET",
		pattern: /^\/api\/tasks\/([^/]+)$/,
		handler: ({ deps, params, json }) => {
			const id = params[1];
			try {
				const task = getTaskManagerForTask(deps, id).getTask(id);
				if (!task) { json({ error: "Task not found" }, 404); return; }
				json(task);
			} catch {
				json({ error: "Task not found" }, 404);
			}
		},
	},
	{
		method: "PUT",
		pattern: /^\/api\/tasks\/([^/]+)$/,
		handler: async ({ deps, params, readBody, json, jsonError }) => {
			const id = params[1];
			const body = await readBody();
			if (!body) { json({ error: "Missing body" }, 400); return; }
			try {
				const tm = getTaskManagerForTask(deps, id);
				const task = tm.getTask(id);
				const prevState = task?.state;
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

				if (body.state && body.state !== prevState && (body.state === "complete" || body.state === "skipped" || body.state === "blocked") && task?.goalId) {
					deps.teamManager.notifyTeamLeadOfTaskCompletion(task.goalId, task.title, body.state);
				}

				json({ ok: true });
			} catch (err: any) {
				jsonError(400, err);
			}
		},
	},
	{
		method: "DELETE",
		pattern: /^\/api\/tasks\/([^/]+)$/,
		handler: ({ deps, params, json }) => {
			const id = params[1];
			try {
				const ok = getTaskManagerForTask(deps, id).deleteTask(id);
				if (!ok) { json({ error: "Task not found" }, 404); return; }
				json({ ok: true });
			} catch {
				json({ error: "Task not found" }, 404);
			}
		},
	},
	{
		method: "POST",
		pattern: /^\/api\/tasks\/([^/]+)\/assign$/,
		handler: async ({ deps, params, readBody, json, jsonError }) => {
			const taskId = params[1];
			const body = await readBody();
			const sessionId = body?.sessionId;
			if (!sessionId || typeof sessionId !== "string") {
				json({ error: "Missing sessionId" }, 400);
				return;
			}
			try {
				const tm = getTaskManagerForTask(deps, taskId);
				const ok = tm.assignTask(taskId, sessionId);
				if (!ok) { json({ error: "Task not found" }, 400); return; }

				const agent = deps.teamManager.findAgentBySessionId(sessionId);
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
		},
	},
	{
		method: "POST",
		pattern: /^\/api\/tasks\/([^/]+)\/transition$/,
		handler: async ({ deps, params, readBody, json, jsonError }) => {
			const taskId = params[1];
			const body = await readBody();
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
				const tm = getTaskManagerForTask(deps, taskId);
				const task = tm.getTask(taskId);
				const ok = tm.transitionTask(taskId, state as TaskState);
				if (!ok) { json({ error: "Task not found" }, 400); return; }

				if ((state === "complete" || state === "skipped" || state === "blocked") && task?.goalId) {
					deps.teamManager.notifyTeamLeadOfTaskCompletion(task.goalId, task.title, state);
				}

				json({ ok: true });
			} catch (err: any) {
				jsonError(400, err);
			}
		},
	},
];
