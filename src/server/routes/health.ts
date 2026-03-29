import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { bobbitStateDir, bobbitConfigDir } from "../bobbit-dir.js";
import { getAigwUrl } from "../agent/aigw-manager.js";
import type { AppContext } from "../app-context.js";
import { json } from "./utils.js";

/** Check if project setup has been completed (sentinel exists or system-prompt.md has been customized). */
export function isSetupComplete(): boolean {
	// Check sentinel file
	const sentinelPath = path.join(bobbitStateDir(), "setup-complete");
	if (fs.existsSync(sentinelPath)) return true;

	// Check if system-prompt.md has been customized beyond the default template
	const systemPromptPath = path.join(bobbitConfigDir(), "system-prompt.md");
	if (!fs.existsSync(systemPromptPath)) return false;

	// Compare with default template — if the file differs, setup is considered done
	const defaultTemplatePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "defaults", "system-prompt.md");
	if (!fs.existsSync(defaultTemplatePath)) {
		// Can't find default template; if the file exists at all, assume customized
		return true;
	}
	try {
		const current = fs.readFileSync(systemPromptPath, "utf-8");
		const defaultContent = fs.readFileSync(defaultTemplatePath, "utf-8");
		return current.trim() !== defaultContent.trim();
	} catch {
		return false;
	}
}

export async function handle(
	ctx: AppContext,
	url: URL,
	req: http.IncomingMessage,
	res: http.ServerResponse,
): Promise<boolean> {
	// GET /api/health — unauthenticated so the client can probe localhost mode
	if (url.pathname === "/api/health" && req.method === "GET") {
		const isLocalhost = !ctx.config.forceAuth && (ctx.config.host === "localhost" || ctx.config.host === "127.0.0.1" || ctx.config.host === "::1");
		json(res, { status: "ok", sessions: ctx.sessionManager.listSessions().length, localhost: isLocalhost, aigw: !!getAigwUrl(ctx.preferencesStore), setupComplete: isSetupComplete() });
		return true;
	}

	// GET /api/setup-status — check if project setup has been completed
	if (url.pathname === "/api/setup-status" && req.method === "GET") {
		json(res, { complete: isSetupComplete() });
		return true;
	}

	// POST /api/setup-status/dismiss — mark setup as dismissed (writes sentinel file)
	if (url.pathname === "/api/setup-status/dismiss" && req.method === "POST") {
		const stateDir = bobbitStateDir();
		fs.mkdirSync(stateDir, { recursive: true });
		fs.writeFileSync(path.join(stateDir, "setup-complete"), "dismissed\n");
		json(res, { ok: true });
		return true;
	}

	// POST /api/shutdown — graceful shutdown (used by coverage teardown to flush V8 coverage)
	if (url.pathname === "/api/shutdown" && req.method === "POST") {
		json(res, { status: "shutting down" });
		// Defer exit to allow the response to be sent
		setTimeout(() => process.exit(0), 500);
		return true;
	}

	return false;
}
