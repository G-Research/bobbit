import type { IncomingMessage, ServerResponse } from "node:http";
import type { AppContext } from "../app-context.js";
import { readBody, json } from "./utils.js";

export async function handle(
	ctx: AppContext,
	url: URL,
	req: IncomingMessage,
	res: ServerResponse,
): Promise<boolean> {
	const { toolManager } = ctx;

	// GET /api/tools — list available agent tools
	if (url.pathname === "/api/tools" && req.method === "GET") {
		json(res, { tools: toolManager.getAvailableTools() });
		return true;
	}

	// Routes with tool :name parameter
	const toolMatch = url.pathname.match(/^\/api\/tools\/([^/]+)$/);
	if (toolMatch) {
		const name = decodeURIComponent(toolMatch[1]);

		if (req.method === "GET") {
			const tool = toolManager.getToolByName(name);
			if (!tool) { json(res, { error: "Tool not found" }, 404); return true; }
			json(res, tool);
			return true;
		}

		if (req.method === "PUT") {
			const body = await readBody(req);
			if (!body) { json(res, { error: "Missing body" }, 400); return true; }
			const ok = toolManager.updateToolMetadata(name, {
				description: body.description,
				group: body.group,
				docs: body.docs,
				detail_docs: body.detail_docs,
			});
			if (!ok) { json(res, { error: "Tool not found" }, 404); return true; }
			json(res, { ok: true });
			return true;
		}
	}

	return false;
}
