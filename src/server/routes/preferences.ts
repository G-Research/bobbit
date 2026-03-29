import http from "node:http";
import type { AppContext } from "../app-context.js";
import { json, readBody, getSafePreferences, broadcastPreferencesChanged } from "./utils.js";

export async function handle(
	ctx: AppContext,
	url: URL,
	req: http.IncomingMessage,
	res: http.ServerResponse,
): Promise<boolean> {
	// ── Config: default cwd ──

	// GET /api/config/cwd
	if (url.pathname === "/api/config/cwd" && req.method === "GET") {
		json(res, { cwd: ctx.config.defaultCwd });
		return true;
	}

	// PUT /api/config/cwd
	if (url.pathname === "/api/config/cwd" && req.method === "PUT") {
		const body = await readBody(req);
		if (!body?.cwd || typeof body.cwd !== "string") {
			json(res, { error: "Missing or invalid cwd" }, 400);
			return true;
		}
		ctx.config.defaultCwd = body.cwd;
		ctx.preferencesStore.set("defaultCwd", body.cwd);
		json(res, { cwd: ctx.config.defaultCwd });
		return true;
	}

	// ── Preferences ──

	// GET /api/preferences — return all preferences (filter sensitive keys)
	if (url.pathname === "/api/preferences" && req.method === "GET") {
		json(res, getSafePreferences(ctx.preferencesStore));
		return true;
	}

	// PUT /api/preferences — merge preferences
	if (url.pathname === "/api/preferences" && req.method === "PUT") {
		const body = await readBody(req);
		if (!body || typeof body !== "object") { json(res, { error: "Missing body" }, 400); return true; }
		for (const [key, value] of Object.entries(body)) {
			if (value === null || value === undefined) {
				ctx.preferencesStore.remove(key);
			} else {
				ctx.preferencesStore.set(key, value);
			}
		}
		json(res, { ok: true });
		broadcastPreferencesChanged(ctx.preferencesStore, ctx.broadcastToAll);
		return true;
	}

	// GET /api/project-config — return project settings
	if (url.pathname === "/api/project-config" && req.method === "GET") {
		json(res, ctx.projectConfigStore.getWithDefaults());
		return true;
	}

	// GET /api/project-config/defaults — return just the defaults
	if (url.pathname === "/api/project-config/defaults" && req.method === "GET") {
		json(res, ctx.projectConfigStore.getDefaults());
		return true;
	}

	// PUT /api/project-config — update project config fields
	if (url.pathname === "/api/project-config" && req.method === "PUT") {
		const body = await readBody(req);
		if (!body || typeof body !== "object") { json(res, { error: "Missing body" }, 400); return true; }
		for (const [key, value] of Object.entries(body)) {
			if (key.includes(".")) {
				json(res, { error: `Config key "${key}" must not contain dots` }, 400);
				return true;
			}
			if (value === null || value === "") {
				ctx.projectConfigStore.remove(key);
			} else if (typeof value === "string") {
				ctx.projectConfigStore.set(key, value);
			}
		}
		json(res, { ok: true });
		return true;
	}

	return false;
}
