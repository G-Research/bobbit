import http from "node:http";
import type { AppContext } from "../app-context.js";
import { getAvailableModels } from "../agent/model-registry.js";
import { json } from "./utils.js";

export async function handle(
	ctx: AppContext,
	url: URL,
	req: http.IncomingMessage,
	res: http.ServerResponse,
): Promise<boolean> {
	// GET /api/models — unified model list from all sources
	if (url.pathname === "/api/models" && req.method === "GET") {
		try {
			const models = await getAvailableModels(ctx.preferencesStore);
			json(res, models);
		} catch (err: any) {
			json(res, { error: `Failed to load models: ${err.message}` }, 500);
		}
		return true;
	}

	return false;
}
