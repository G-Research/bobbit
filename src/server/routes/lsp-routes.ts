// src/server/routes/lsp-routes.ts
//
// Wave 1 of the `code_*` product tool group (docs/design/lsp-product-tools.md).
// Backs `defaults/tools/code/` (`code_definition`, `code_references`,
// `code_hover`, `code_symbols`) exactly the way
// `src/server/agent/orient.ts` + the `/api/internal/orient` route back the
// `orient` tool: a thin, session-scoped GET endpoint the tool's `extension.ts`
// proxies to over HTTP (the tools run in a separate process from the
// gateway, so even though `TsServerSupervisor` lives in-process here, tools
// still reach it via a gateway round trip, same as every other
// `bobbit-extension` tool).
//
// Session → worktree resolution mirrors `/api/internal/orient` exactly
// (live session, falling back to the persisted session for a dormant one).
// Sandboxed sessions fail open per design doc §6 — LSP has no mount-path
// translation into a sandbox container yet (wave 2).

import path from "node:path";
import type { CoreRouteCtx } from "./core-route-ctx.js";
import type { RouteTable } from "./route-table.js";
import type { LspLocationsOutcome, LspHoverOutcome, LspSymbolsOutcome, TsServerSupervisor } from "../lsp/supervisor.js";

interface ResolvedLspSession {
	worktreeRoot: string;
	sandboxed: boolean;
}

/** Resolve the calling session's worktree root + sandbox flag, mirroring `/api/internal/orient`'s live-then-persisted lookup. Returns `undefined` if the session id is missing/unknown (caller returns 403, matching orient). */
function resolveLspSession(ctx: CoreRouteCtx, sessionId: string | undefined): ResolvedLspSession | undefined {
	if (!sessionId) return undefined;
	const liveSession = ctx.sessionManager.getSession(sessionId);
	const projectCtx = ctx.projectContextManager.getContextForSession(sessionId);
	const persistedSession = liveSession ? undefined : projectCtx?.sessionStore.get(sessionId);
	const sessionRecord: any = liveSession ?? persistedSession;
	if (!sessionRecord) return undefined;
	const worktreeRoot = sessionRecord.worktreePath || sessionRecord.cwd;
	if (!worktreeRoot) return undefined;
	return { worktreeRoot, sandboxed: !!sessionRecord.sandboxed };
}

/** Resolve `fileParam` against `worktreeRoot`, rejecting any path that escapes it (same escape-prevention idiom as `generate_image`'s `outputPath`). Returns `undefined` on escape. */
function resolveFileWithinWorktree(worktreeRoot: string, fileParam: string): string | undefined {
	const abs = path.isAbsolute(fileParam) ? path.normalize(fileParam) : path.resolve(worktreeRoot, fileParam);
	const rootWithSep = worktreeRoot.endsWith(path.sep) ? worktreeRoot : worktreeRoot + path.sep;
	if (abs !== worktreeRoot && !abs.startsWith(rootWithSep)) return undefined;
	return abs;
}

interface ParsedRequest {
	worktreeRoot: string;
	absFile: string;
}

/** Shared header/query parsing + validation for all four endpoints. On failure, writes the HTTP error response itself and returns `undefined`. */
function parseCommon(ctx: CoreRouteCtx, lspSupervisor: TsServerSupervisor | undefined): ParsedRequest | undefined {
	const { req, url, json } = ctx;
	if (!lspSupervisor) {
		json({ available: false, reason: "LSP supervisor not initialized on this gateway" }, 200);
		return undefined;
	}
	const sessionId = req.headers["x-bobbit-session-id"] as string | undefined;
	if (!sessionId) {
		json({ error: "Missing X-Bobbit-Session-Id header" }, 403);
		return undefined;
	}
	const resolved = resolveLspSession(ctx, sessionId);
	if (!resolved) {
		json({ error: `Session "${sessionId}" not found` }, 403);
		return undefined;
	}
	if (resolved.sandboxed) {
		json({ available: false, reason: "LSP not yet supported for sandboxed sessions" }, 200);
		return undefined;
	}
	const fileParam = url.searchParams.get("file");
	if (!fileParam) {
		json({ error: "file query parameter is required" }, 400);
		return undefined;
	}
	const absFile = resolveFileWithinWorktree(resolved.worktreeRoot, fileParam);
	if (!absFile) {
		json({ error: `file must resolve within the session worktree (${resolved.worktreeRoot})` }, 400);
		return undefined;
	}
	return { worktreeRoot: resolved.worktreeRoot, absFile };
}

function parsePosition(ctx: CoreRouteCtx): { line: number; col: number } | undefined {
	const { url, json } = ctx;
	const lineStr = url.searchParams.get("line");
	const colStr = url.searchParams.get("col");
	const line = Number(lineStr);
	const col = Number(colStr);
	if (!Number.isInteger(line) || !Number.isInteger(col) || line < 1 || col < 1) {
		json({ error: "line and col query parameters are required and must be 1-based positive integers" }, 400);
		return undefined;
	}
	return { line, col };
}

async function handleDefinition(ctx: CoreRouteCtx, _params: Record<string, string>): Promise<void> {
	const parsed = parseCommon(ctx, ctx.lspSupervisor);
	if (!parsed) return;
	const position = parsePosition(ctx);
	if (!position) return;
	const outcome: LspLocationsOutcome = await ctx.lspSupervisor!.definition({ ...parsed, ...position });
	ctx.json(outcome);
}

async function handleReferences(ctx: CoreRouteCtx, _params: Record<string, string>): Promise<void> {
	const parsed = parseCommon(ctx, ctx.lspSupervisor);
	if (!parsed) return;
	const position = parsePosition(ctx);
	if (!position) return;
	const outcome: LspLocationsOutcome = await ctx.lspSupervisor!.references({ ...parsed, ...position });
	ctx.json(outcome);
}

async function handleHover(ctx: CoreRouteCtx, _params: Record<string, string>): Promise<void> {
	const parsed = parseCommon(ctx, ctx.lspSupervisor);
	if (!parsed) return;
	const position = parsePosition(ctx);
	if (!position) return;
	const outcome: LspHoverOutcome = await ctx.lspSupervisor!.hover({ ...parsed, ...position });
	ctx.json(outcome);
}

async function handleSymbols(ctx: CoreRouteCtx, _params: Record<string, string>): Promise<void> {
	const parsed = parseCommon(ctx, ctx.lspSupervisor);
	if (!parsed) return;
	const query = ctx.url.searchParams.get("query") || undefined;
	const outcome: LspSymbolsOutcome = await ctx.lspSupervisor!.symbols({ ...parsed, query });
	ctx.json(outcome);
}

export function registerLspRoutes(table: RouteTable<CoreRouteCtx>): void {
	table.register("GET", "/api/internal/lsp/definition", handleDefinition);
	table.register("GET", "/api/internal/lsp/references", handleReferences);
	table.register("GET", "/api/internal/lsp/hover", handleHover);
	table.register("GET", "/api/internal/lsp/symbols", handleSymbols);
}
