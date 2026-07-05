// src/server/routes/session-utility-routes.ts
//
// STR-01 cohort 7: contiguous session utility routes — background processes,
// drafts, abort, and prompt-sections — migrated out of handleApiRoute's
// legacy if/else chain into the core route registry. See
// docs/design/route-registry.md.
//
// Mechanical extraction — every handler body below preserves the legacy
// behavior, with only these substitutions:
//   - url.pathname.match(...)[1]/[2] -> registry params.id/processId.
//   - handleApiRoute locals (json, noContent, readBody, sessionManager,
//     bgProcessManager, toolManager) are destructured from ctx.
//   - leaf helpers are imported directly.
//
// LEGACY FALL-THROUGH PARITY: no unhandled-method shim needed. Every legacy
// block here gated on path and method in the same `if` condition, with no
// path-first shared resolution step. A method mismatch skipped the block and
// fell through to the terminal 404; RouteTable's method-scoped matching does
// the same by leaving other methods unregistered.

import { bobbitStateDir } from "../bobbit-dir.js";
import { streamBgWaitResponse } from "../agent/bg-wait-response.js";
import { getPromptSections, loadPersistedPromptSections } from "../agent/system-prompt.js";
import type { CoreRouteCtx } from "./core-route-ctx.js";
import type { RouteTable } from "./route-table.js";

// POST /api/sessions/:id/bg-processes — create a background process
async function handleBgProcessCreate(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { json, readBody, req, sessionManager, bgProcessManager } = ctx;
	const id = params.id;
	const session = sessionManager.getSession(id);
	if (!session) { json({ error: "Session not found" }, 404); return; }
	const body = await readBody(req);
	if (!body?.command) { json({ error: "command is required" }, 400); return; }
	try {
		const info = bgProcessManager.create(id, body.command, session.cwd, session.containerId, session.sandboxed, body.name);
		json(info, 201);
	} catch (err: any) {
		if (err?.message?.includes("Sandboxed session without containerId")) {
			json({ error: "Sandboxed session cannot run host processes" }, 403);
		} else {
			throw err;
		}
	}
}

// GET /api/sessions/:id/bg-processes — list background processes
async function handleBgProcessList(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { json, bgProcessManager } = ctx;
	const id = params.id;
	json({ processes: bgProcessManager.list(id) });
}

// GET /api/sessions/:id/bg-processes/:processId/logs — get logs
async function handleBgProcessLogs(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { url, json, bgProcessManager } = ctx;
	const { id: sessionId, processId } = params;
	const logs = bgProcessManager.getLogs(sessionId, processId);
	if (!logs) { json({ error: "Process not found" }, 404); return; }
	const tail = parseInt(url.searchParams.get("tail") || "15", 10);
	json({
		log: logs.log.slice(-tail),
		stdout: logs.stdout.slice(-tail),
		stderr: logs.stderr.slice(-tail),
	});
}

// GET /api/sessions/:id/bg-processes/:processId/grep — search logs
async function handleBgProcessGrep(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { url, json, bgProcessManager } = ctx;
	const { id: sessionId, processId } = params;
	const pattern = url.searchParams.get("pattern") || "";
	if (!pattern) { json({ error: "pattern is required" }, 400); return; }
	const context = parseInt(url.searchParams.get("context") || "0", 10);
	const maxResults = parseInt(url.searchParams.get("max") || "50", 10);
	const result = bgProcessManager.grepLogs(sessionId, processId, pattern, context, maxResults);
	if (!result) { json({ error: "Process not found" }, 404); return; }
	json(result);
}

// GET /api/sessions/:id/bg-processes/:processId/head — first N lines
async function handleBgProcessHead(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { url, json, bgProcessManager } = ctx;
	const { id: sessionId, processId } = params;
	const lines = parseInt(url.searchParams.get("lines") || "50", 10);
	const result = bgProcessManager.headLogs(sessionId, processId, lines);
	if (!result) { json({ error: "Process not found" }, 404); return; }
	json(result);
}

// GET /api/sessions/:id/bg-processes/:processId/slice — line range (1-indexed)
async function handleBgProcessSlice(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { url, json, bgProcessManager } = ctx;
	const { id: sessionId, processId } = params;
	const from = parseInt(url.searchParams.get("from") || "1", 10);
	const to = parseInt(url.searchParams.get("to") || "50", 10);
	const result = bgProcessManager.sliceLogs(sessionId, processId, from, to);
	if (!result) { json({ error: "Process not found" }, 404); return; }
	json(result);
}

// GET /api/sessions/:id/bg-processes/:processId/wait — block until exit or timeout
async function handleBgProcessWait(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { url, res, bgProcessManager } = ctx;
	const { id: sessionId, processId } = params;
	const timeout = parseInt(url.searchParams.get("timeout") || "300", 10);
	const controller = new AbortController();
	bgProcessManager.registerWait(sessionId, controller);
	try {
		await streamBgWaitResponse(res, () =>
			bgProcessManager.waitForExit(sessionId, processId, timeout * 1000, controller.signal));
	} finally {
		bgProcessManager.unregisterWait(sessionId, controller);
	}
}

// DELETE /api/sessions/:id/bg-processes/:processId — kill or dismiss a background process
async function handleBgProcessDelete(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { url, json, bgProcessManager } = ctx;
	const { id: sessionId, processId } = params;
	const action = url.searchParams.get("action");
	if (action === "kill") {
		const killed = bgProcessManager.kill(sessionId, processId);
		if (!killed) { json({ error: "Process not found or not running" }, 404); return; }
		json({ ok: true, killed: true });
		return;
	}
	if (action === "dismiss") {
		const dismissed = bgProcessManager.dismiss(sessionId, processId);
		if (!dismissed) { json({ error: "Process not found or still running" }, 409); return; }
		json({ ok: true });
		return;
	}
	// Legacy: kill-if-running else dismiss.
	const killed = bgProcessManager.kill(sessionId, processId);
	if (!killed) {
		const dismissed = bgProcessManager.dismiss(sessionId, processId);
		if (!dismissed) { json({ error: "Process not found" }, 404); return; }
	}
	json({ ok: true });
}

// PUT|POST /api/sessions/:id/draft — upsert a draft
async function handleDraftUpsert(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { json, readBody, req, sessionManager } = ctx;
	const id = params.id;
	const body = await readBody(req);
	if (!body || typeof body.type !== "string") {
		json({ error: "Missing type" }, 400);
		return;
	}
	const ok = sessionManager.setDraft(id, body.type, body.data);
	if (!ok) { json({ error: "Session not found" }, 404); return; }
	json({ ok: true });
}

// GET /api/sessions/:id/draft?type=prompt — retrieve a draft
async function handleDraftGet(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { url, json, noContent, sessionManager } = ctx;
	const id = params.id;
	const type = url.searchParams.get("type");
	if (!type) { json({ error: "Missing type query param" }, 400); return; }
	const data = sessionManager.getDraft(id, type);
	if (data === undefined) {
		const session = sessionManager.getSession(id);
		if (!session) { json({ error: "Session not found" }, 404); return; }
		if (url.searchParams.get("optional") === "1") { noContent(); return; }
		json({ error: "Draft not found" }, 404);
		return;
	}
	json({ type, data });
}

// DELETE /api/sessions/:id/draft?type=prompt — clear a draft
async function handleDraftDelete(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { url, json, sessionManager } = ctx;
	const id = params.id;
	const type = url.searchParams.get("type");
	if (!type) { json({ error: "Missing type query param" }, 400); return; }
	const session = sessionManager.getSession(id);
	if (!session) { json({ error: "Session not found" }, 404); return; }
	sessionManager.deleteDraft(id, type);
	json({ ok: true });
}

// POST /api/sessions/:id/abort — force-abort a streaming session (graceful + force-kill)
async function handleSessionAbort(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { json, sessionManager } = ctx;
	const id = params.id;
	const session = sessionManager.getSession(id);
	if (!session) { json({ error: "Session not found" }, 404); return; }
	if (session.status !== "streaming") { json({ ok: true, status: session.status }); return; }
	await sessionManager.forceAbort(id);
	json({ ok: true, status: "idle" });
}

// GET /api/sessions/:id/prompt-sections — return system prompt broken into labeled sections
async function handlePromptSections(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { json, sessionManager, toolManager } = ctx;
	const id = params.id;

	const persisted = loadPersistedPromptSections(id);
	if (persisted) {
		json(persisted);
		return;
	}

	const parts = sessionManager.getPromptParts(id);
	if (!parts) { json({ error: "Session not found or no prompt data" }, 404); return; }

	if (!parts.toolDocs && toolManager) {
		parts.toolDocs = toolManager.getToolDocsForPrompt(parts.allowedTools, bobbitStateDir());
	}

	const sections = getPromptSections(parts);
	const totalTokens = sections.reduce((sum, s) => sum + s.tokens, 0);
	json({ sections, totalTokens });
}

export function registerSessionUtilityRoutes(table: RouteTable<CoreRouteCtx>): void {
	table.register("POST", "/api/sessions/:id/bg-processes", handleBgProcessCreate);
	table.register("GET", "/api/sessions/:id/bg-processes", handleBgProcessList);
	table.register("GET", "/api/sessions/:id/bg-processes/:processId/logs", handleBgProcessLogs);
	table.register("GET", "/api/sessions/:id/bg-processes/:processId/grep", handleBgProcessGrep);
	table.register("GET", "/api/sessions/:id/bg-processes/:processId/head", handleBgProcessHead);
	table.register("GET", "/api/sessions/:id/bg-processes/:processId/slice", handleBgProcessSlice);
	table.register("GET", "/api/sessions/:id/bg-processes/:processId/wait", handleBgProcessWait);
	table.register("DELETE", "/api/sessions/:id/bg-processes/:processId", handleBgProcessDelete);
	table.register("PUT", "/api/sessions/:id/draft", handleDraftUpsert);
	table.register("POST", "/api/sessions/:id/draft", handleDraftUpsert);
	table.register("GET", "/api/sessions/:id/draft", handleDraftGet);
	table.register("DELETE", "/api/sessions/:id/draft", handleDraftDelete);
	table.register("POST", "/api/sessions/:id/abort", handleSessionAbort);
	table.register("GET", "/api/sessions/:id/prompt-sections", handlePromptSections);
}
