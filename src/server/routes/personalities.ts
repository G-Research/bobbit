import http from "node:http";
import type { AppContext } from "../app-context.js";
import { json, readBody } from "./utils.js";

export async function handle(
	ctx: AppContext,
	url: URL,
	req: http.IncomingMessage,
	res: http.ServerResponse,
): Promise<boolean> {
	// GET /api/personalities
	if (url.pathname === "/api/personalities" && req.method === "GET") {
		json(res, { personalities: ctx.personalityManager.listPersonalities() });
		return true;
	}

	// POST /api/personalities
	if (url.pathname === "/api/personalities" && req.method === "POST") {
		const body = await readBody(req);
		try {
			const personality = ctx.personalityManager.createPersonality({
				name: body?.name,
				label: body?.label,
				description: body?.description || "",
				promptFragment: body?.promptFragment || "",
			});
			json(res, personality, 201);
		} catch (err: any) {
			json(res, { error: err.message }, 400);
		}
		return true;
	}

	// Routes with personality :name parameter
	const personalityMatch = url.pathname.match(/^\/api\/personalities\/([^/]+)$/);
	if (personalityMatch) {
		const name = decodeURIComponent(personalityMatch[1]);

		if (req.method === "GET") {
			const personality = ctx.personalityManager.getPersonality(name);
			if (!personality) { json(res, { error: "Personality not found" }, 404); return true; }
			json(res, personality);
			return true;
		}

		if (req.method === "PUT") {
			const body = await readBody(req);
			if (!body) { json(res, { error: "Missing body" }, 400); return true; }
			const ok = ctx.personalityManager.updatePersonality(name, {
				label: body.label,
				description: body.description,
				promptFragment: body.promptFragment,
			});
			if (!ok) { json(res, { error: "Personality not found" }, 404); return true; }
			json(res, { ok: true });
			return true;
		}

		if (req.method === "DELETE") {
			const ok = ctx.personalityManager.deletePersonality(name);
			if (!ok) { json(res, { error: "Personality not found" }, 404); return true; }
			json(res, { ok: true });
			return true;
		}
	}

	return false;
}
