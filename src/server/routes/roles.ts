import type { IncomingMessage, ServerResponse } from "node:http";
import type { AppContext } from "../app-context.js";
import { readBody, json } from "./utils.js";

export async function handle(
	ctx: AppContext,
	url: URL,
	req: IncomingMessage,
	res: ServerResponse,
): Promise<boolean> {
	const { roleManager } = ctx;

	// GET /api/roles/assistant/prompts — must come before :name route
	if (url.pathname === "/api/roles/assistant/prompts" && req.method === "GET") {
		const { ASSISTANT_REGISTRY } = await import("../agent/assistant-registry.js");
		const prompts = Object.values(ASSISTANT_REGISTRY).map((def) => ({
			type: def.type,
			title: def.title,
			promptTitle: def.promptTitle,
			prompt: def.prompt,
		}));
		json(res, { prompts });
		return true;
	}

	// PUT /api/roles/assistant/prompts/:type
	if (url.pathname.startsWith("/api/roles/assistant/prompts/") && req.method === "PUT") {
		const type = url.pathname.slice("/api/roles/assistant/prompts/".length);
		if (!type) {
			json(res, { error: "Missing type parameter" }, 400);
			return true;
		}
		const body = await readBody(req);
		const { updateAssistantDef } = await import("../agent/assistant-registry.js");
		const updated = updateAssistantDef(type, {
			prompt: body?.prompt,
			title: body?.title,
			promptTitle: body?.promptTitle,
		});
		if (!updated) {
			json(res, { error: `Unknown assistant type: ${type}` }, 404);
			return true;
		}
		json(res, updated);
		return true;
	}

	// GET /api/roles
	if (url.pathname === "/api/roles" && req.method === "GET") {
		json(res, { roles: roleManager.listRoles() });
		return true;
	}

	// POST /api/roles
	if (url.pathname === "/api/roles" && req.method === "POST") {
		const body = await readBody(req);
		try {
			const role = roleManager.createRole({
				name: body?.name,
				label: body?.label,
				promptTemplate: body?.promptTemplate || "",
				allowedTools: body?.allowedTools,
				accessory: body?.accessory,
			});
			json(res, role, 201);
		} catch (err: any) {
			json(res, { error: err.message }, 400);
		}
		return true;
	}

	// Routes with role :name parameter
	const roleMatch = url.pathname.match(/^\/api\/roles\/([^/]+)$/);
	if (roleMatch) {
		const name = decodeURIComponent(roleMatch[1]);

		if (req.method === "GET") {
			const role = roleManager.getRole(name);
			if (!role) { json(res, { error: "Role not found" }, 404); return true; }
			json(res, role);
			return true;
		}

		if (req.method === "PUT") {
			const body = await readBody(req);
			if (!body) { json(res, { error: "Missing body" }, 400); return true; }
			const ok = roleManager.updateRole(name, {
				label: body.label,
				promptTemplate: body.promptTemplate,
				allowedTools: body.allowedTools,
				accessory: body.accessory,
			});
			if (!ok) { json(res, { error: "Role not found" }, 404); return true; }
			json(res, { ok: true });
			return true;
		}

		if (req.method === "DELETE") {
			const ok = roleManager.deleteRole(name);
			if (!ok) { json(res, { error: "Role not found" }, 404); return true; }
			json(res, { ok: true });
			return true;
		}
	}

	return false;
}
