import http from "node:http";
import type { AppContext } from "../app-context.js";
import { readBody, json } from "./utils.js";

export async function handle(ctx: AppContext, url: URL, req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
	const { staffManager, sessionManager, config } = ctx;

	// GET /api/staff
	if (url.pathname === "/api/staff" && req.method === "GET") {
		json(res, { staff: staffManager.listStaff() });
		return true;
	}

	// POST /api/staff
	if (url.pathname === "/api/staff" && req.method === "POST") {
		const body = await readBody(req);
		if (!body?.name || typeof body.name !== "string") {
			json(res, { error: "Missing name" }, 400);
			return true;
		}
		if (!body?.systemPrompt || typeof body.systemPrompt !== "string") {
			json(res, { error: "Missing systemPrompt" }, 400);
			return true;
		}
		const cwd = body.cwd || config.defaultCwd;
		try {
			const staff = await staffManager.createStaff(
				body.name,
				body.description || "",
				body.systemPrompt,
				cwd,
				sessionManager,
				{ triggers: body.triggers, roleId: body.roleId },
			);
			json(res, staff, 201);
		} catch (err: any) {
			console.error("[server] Failed to create staff agent:", err);
			json(res, { error: err?.message || "Failed to create staff agent" }, 500);
		}
		return true;
	}

	// Routes with staff :id parameter
	const staffMatch = url.pathname.match(/^\/api\/staff\/([^/]+)$/);
	if (staffMatch) {
		const id = staffMatch[1];

		if (req.method === "GET") {
			const staff = staffManager.getStaff(id);
			if (!staff) { json(res, { error: "Staff agent not found" }, 404); return true; }
			json(res, staff);
			return true;
		}

		if (req.method === "PUT") {
			const body = await readBody(req);
			if (!body) { json(res, { error: "Missing body" }, 400); return true; }
			const ok = staffManager.updateStaff(id, {
				name: body.name,
				description: body.description,
				systemPrompt: body.systemPrompt,
				cwd: body.cwd,
				state: body.state,
				triggers: body.triggers,
				memory: body.memory,
				roleId: body.roleId,
			});
			if (!ok) { json(res, { error: "Staff agent not found" }, 404); return true; }
			json(res, staffManager.getStaff(id));
			return true;
		}

		if (req.method === "DELETE") {
			const ok = await staffManager.deleteStaff(id, sessionManager);
			if (!ok) { json(res, { error: "Staff agent not found" }, 404); return true; }
			json(res, { ok: true });
			return true;
		}
	}

	// POST /api/staff/:id/wake — manually trigger a wake cycle
	const staffWakeMatch = url.pathname.match(/^\/api\/staff\/([^/]+)\/wake$/);
	if (staffWakeMatch && req.method === "POST") {
		const id = staffWakeMatch[1];
		const staff = staffManager.getStaff(id);
		if (!staff) { json(res, { error: "Staff agent not found" }, 404); return true; }
		const body = await readBody(req);
		try {
			const sessionId = await staffManager.wake(id, body?.prompt, sessionManager);
			json(res, { sessionId }, 201);
		} catch (err) {
			json(res, { error: String(err) }, 400);
		}
		return true;
	}

	// GET /api/staff/:id/sessions — DEPRECATED
	const staffSessionsMatch = url.pathname.match(/^\/api\/staff\/([^/]+)\/sessions$/);
	if (staffSessionsMatch && req.method === "GET") {
		json(res, { error: "Deprecated. Staff agents have a single permanent session. Use GET /api/staff/:id." }, 410);
		return true;
	}

	return false;
}
