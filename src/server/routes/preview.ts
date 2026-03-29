import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { bobbitStateDir } from "../bobbit-dir.js";
import type { AppContext } from "../app-context.js";
import { json, readBody } from "./utils.js";

export async function handle(
	ctx: AppContext,
	url: URL,
	req: http.IncomingMessage,
	res: http.ServerResponse,
): Promise<boolean> {
	// GET /api/preview?sessionId=xxx — get preview HTML for a session
	if (url.pathname === "/api/preview" && req.method === "GET") {
		const sessionId = url.searchParams.get("sessionId");
		const previewPath = sessionId
			? path.join(bobbitStateDir(), `preview-${sessionId}.html`)
			: path.join(bobbitStateDir(), "preview.html");
		try {
			const content = fs.readFileSync(previewPath, "utf-8");
			const stat = fs.statSync(previewPath);
			json(res, { html: content, mtime: stat.mtimeMs });
		} catch {
			json(res, { html: "", mtime: 0 });
		}
		return true;
	}

	// POST /api/preview?sessionId=xxx — set preview HTML for a session
	if (url.pathname === "/api/preview" && req.method === "POST") {
		const body = await readBody(req);
		const sessionId = url.searchParams.get("sessionId");
		const previewPath = sessionId
			? path.join(bobbitStateDir(), `preview-${sessionId}.html`)
			: path.join(bobbitStateDir(), "preview.html");
		fs.writeFileSync(previewPath, body?.html || "", "utf-8");
		json(res, { ok: true });
		return true;
	}

	return false;
}
