import http from "node:http";
import type { AppContext } from "../app-context.js";
import { json, readBody } from "./utils.js";

export async function handle(
	ctx: AppContext,
	url: URL,
	req: http.IncomingMessage,
	res: http.ServerResponse,
): Promise<boolean> {
	// GET /api/workflows
	const workflowsMatch = url.pathname === "/api/workflows";
	if (workflowsMatch && req.method === "GET") {
		json(res, { workflows: ctx.workflowManager.listWorkflows() });
		return true;
	}

	// POST /api/workflows
	if (workflowsMatch && req.method === "POST") {
		const body = await readBody(req);
		if (!body) { json(res, { error: "Missing body" }, 400); return true; }
		try {
			const workflow = ctx.workflowManager.createWorkflow({
				id: body.id,
				name: body.name,
				description: body.description,
				gates: body.gates || [],
			});
			json(res, workflow, 201);
		} catch (err: any) {
			json(res, { error: err.message }, 400);
		}
		return true;
	}

	// GET /api/workflows/:id
	const workflowMatch = url.pathname.match(/^\/api\/workflows\/([^/]+)$/);
	if (workflowMatch && req.method === "GET") {
		const wf = ctx.workflowManager.getWorkflow(decodeURIComponent(workflowMatch[1]));
		if (!wf) { json(res, { error: "Workflow not found" }, 404); return true; }
		json(res, wf);
		return true;
	}

	// PUT /api/workflows/:id
	if (workflowMatch && req.method === "PUT") {
		const id = decodeURIComponent(workflowMatch[1]);
		const body = await readBody(req);
		if (!body) { json(res, { error: "Missing body" }, 400); return true; }
		try {
			const ok = ctx.workflowManager.updateWorkflow(id, body);
			if (!ok) { json(res, { error: "Workflow not found" }, 404); return true; }
			const updated = ctx.workflowManager.getWorkflow(id);
			json(res, updated);
		} catch (err: any) {
			json(res, { error: err.message }, 400);
		}
		return true;
	}

	// DELETE /api/workflows/:id
	if (workflowMatch && req.method === "DELETE") {
		const id = decodeURIComponent(workflowMatch[1]);
		const wf = ctx.workflowManager.getWorkflow(id);
		if (!wf) { json(res, { error: "Workflow not found" }, 404); return true; }
		// Check if any active goal references this workflow
		const allGoals = ctx.sessionManager.goalManager.listGoals();
		if (allGoals.some((g: any) => g.workflowId === id && g.state !== "complete")) {
			json(res, { error: "Cannot delete: workflow is in use by active goals" }, 409);
			return true;
		}
		ctx.workflowManager.deleteWorkflow(id);
		res.writeHead(204);
		res.end();
		return true;
	}

	return false;
}
