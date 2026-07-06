// src/server/routes/session-control-routes.ts
//
// STR-01 cohort 19: session control/provider-hook routes migrated out of
// handleApiRoute's legacy if/else chain into the core route registry. See
// docs/design/route-registry.md.
//
// Mechanical extraction — handler bodies below preserve the legacy behavior,
// with only handleApiRoute locals destructured from ctx.
//
// LEGACY FALL-THROUGH PARITY: no unhandled-method shim needed. Every legacy
// block here gated on path and method in the same `if` condition. A method
// mismatch skipped the block and fell through to the terminal 404; RouteTable's
// method-scoped matching preserves that by leaving other methods unregistered.

import { bobbitStateDir } from "../bobbit-dir.js";
import { ContextTraceStore } from "../agent/context-trace-store.js";
import { fenceBlock } from "../agent/context-blocks.js";
import type { HookCtx } from "../agent/lifecycle-hub.js";
import { DYNAMIC_CONTEXT_START, DYNAMIC_CONTEXT_END } from "../agent/provider-bridge-extension.js";
import { persistPromptSections } from "../agent/system-prompt.js";
import { getSlashSkill, buildSlashSkillPrompt } from "../skills/slash-skills.js";
import { buildActivationHeader } from "../skills/skill-manifest.js";
import type { CoreRouteCtx } from "./core-route-ctx.js";
import type { RouteTable } from "./route-table.js";

// POST /api/sessions/:id/activate-skill — autonomous skill activation
async function handleActivateSkill(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { json, projectConfigStore, readBody, req, sessionManager, skillMarketContext } = ctx;
	const sessionId = params.id;
	const session = sessionManager.getSession(sessionId);
	if (!session) {
		json({ error: "Session not found" }, 404);
		return;
	}
	const body = await readBody(req);
	const skillName = typeof body?.name === "string" ? body.name : "";
	const skillArgs = typeof body?.args === "string" ? body.args : "";
	if (!skillName) {
		json({ error: "name is required" }, 400);
		return;
	}
	// Resolve skill discovery context: host-side cwd + per-project store.
	let resolvedConfigStore: { get(key: string): string | undefined } | undefined = projectConfigStore;
	let skillCwd = session.cwd;
	if (session.projectId) {
		const pcm = (sessionManager as any).projectContextManager as import("../agent/project-context-manager.js").ProjectContextManager | undefined;
		const ctx = pcm?.getOrCreate(session.projectId);
		if (ctx) {
			resolvedConfigStore = ctx.projectConfigStore;
			if (session.sandboxed) skillCwd = ctx.project.rootPath;
		}
	}
	const skill = getSlashSkill(skillCwd, skillName, resolvedConfigStore, skillMarketContext(session.projectId ?? null));
	if (!skill) {
		json({ error: `Skill "${skillName}" not found` }, 404);
		return;
	}
	if (skill.disableModelInvocation === true) {
		json({ error: `Skill "${skillName}" has disable-model-invocation: true and cannot be activated by the model` }, 403);
		return;
	}
	// Inject the activation header so autonomous activation is byte-equal
	// to user `/<name>` invocation.
	const pathRewrite = session.sandboxed
		? (hostPath: string): string | null => {
			// Project worktree mounts at /workspace; rewrite when the host
			// path lives under it. Built-in / personal skills aren't mounted.
			const projectRoot = (session.projectId
				? ((sessionManager as any).projectContextManager as import("../agent/project-context-manager.js").ProjectContextManager | undefined)?.getOrCreate(session.projectId)?.project.rootPath
				: undefined);
			const normHost = hostPath.replace(/\\/g, "/");
			const normProj = projectRoot ? projectRoot.replace(/\\/g, "/") : null;
			const sessionCwdNorm = session.cwd.replace(/\\/g, "/");
			for (const candidate of [normProj, sessionCwdNorm]) {
				if (candidate && (normHost === candidate || normHost.startsWith(candidate + "/"))) {
					const rel = normHost.slice(candidate.length).replace(/^\/+/, "");
					return "/workspace" + (rel ? "/" + rel : "");
				}
			}
			return null;
		}
		: undefined;
	const skillBody = buildSlashSkillPrompt(skill, skillArgs);
	const expanded = buildActivationHeader(skill, pathRewrite) + skillBody;
	json({ ok: true, expanded, source: skill.source, filePath: skill.filePath });
	return;
}

// POST /api/sessions/:id/tool-grant-request — long-polling endpoint called by guard extension
async function handleToolGrantRequest(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { json, jsonError, readBody, req, sessionManager } = ctx;

	const sessionId = params.id;
	const body = await readBody(req);
	if (!body || !body.toolName || !body.toolGroup) {
		json({ error: "toolName and toolGroup required" }, 400);
		return;
	}
	try {
		const result = await sessionManager.requestToolGrant(sessionId, body.toolName, body.toolGroup);
		json(result);
	} catch (err: any) {
		jsonError(500, err);
	}
	return;
}

// ── Provider per-turn lifecycle hooks (EP G1.4) ──
// These endpoints are called only by the Bobbit-generated provider-bridge pi
// extension (before-prompt / before-compact) and the context-trace inspector.
// They inherit the admin-bearer gate enforced before handleApiRoute, exactly
// like POST /api/sessions/:id/tool-grant-request above. afterTurn /
// sessionShutdown are gateway-internal dispatches and intentionally have NO
// public endpoint.
//
// Resolve a session's lifecycle dispatch context from live or persisted state.
// Returns undefined when the session is unknown (→ 404 for the hook endpoints).
const resolveHookCtx = (ctx: CoreRouteCtx, id: string): Omit<HookCtx, "budget" | "config" | "gateway"> | undefined => {
	const { sessionManager } = ctx;
	const live = sessionManager.getSession(id);
	const persisted = sessionManager.getPersistedSession(id);
	if (!live && !persisted) return undefined;
	const projectId = live?.projectId ?? persisted?.projectId;
	return {
		sessionId: id,
		projectId,
		scope: projectId ? "project" : "global",
		cwd: live?.cwd ?? persisted?.cwd ?? process.cwd(),
		// Effective goal: team members, delegates, and reviewers carry the goal
		// only in teamGoalId, so fall back to it before persisted state. Without
		// this, disabled-provider filtering would not apply at the provider hook
		// endpoints (beforePrompt / beforeCompact) for non-lead sessions.
		goalId: live?.goalId ?? live?.teamGoalId ?? persisted?.goalId ?? persisted?.teamGoalId,
		roleName: live?.role ?? persisted?.role,
	};
};

// POST /api/sessions/:id/provider-hooks/before-prompt — per-turn dynamic context.
async function handleBeforePrompt(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { json, jsonError, readBody, req, sessionManager } = ctx;
	const sessionId = params.id;
	const body = await readBody(req).catch(() => ({} as any));
	if (body && body.prompt !== undefined && typeof body.prompt !== "string") {
		json({ error: "prompt must be a string" }, 400);
		return;
	}
	const base = resolveHookCtx(ctx, sessionId);
	if (!base) {
		json({ error: "Session not found" }, 404);
		return;
	}
	const hub = sessionManager.lifecycleHub;
	if (!hub) {
		json({ content: "", tail: "", blocks: [] });
		return;
	}
	try {
		const turnIndex = body?.turn?.index;
		const { blocks } = await hub.dispatch("beforePrompt", {
			...base,
			prompt: typeof body?.prompt === "string" ? body.prompt : undefined,
			turn: typeof turnIndex === "number" && Number.isFinite(turnIndex) ? { index: turnIndex } : undefined,
		});
		const content = blocks.length ? blocks.map(fenceBlock).join("\n\n") : "";
		// Temporary back-compat for generated bridges from the system-prompt-tail era.
		// New bridges consume `content` only and must never return systemPrompt.
		const tail = content ? `\n${DYNAMIC_CONTEXT_START}\n${content}\n${DYNAMIC_CONTEXT_END}` : "";
		// Best-effort: refresh the persisted prompt-sections snapshot so the
		// inspector reflects this turn's dynamic-context blocks. Non-fatal.
		try {
			const parts = sessionManager.getPromptParts(sessionId);
			if (parts) {
				parts.dynamicContext = blocks;
				persistPromptSections(sessionId, parts);
			}
		} catch (err) {
			console.debug(`[provider-hooks] prompt-sections refresh skipped for ${sessionId}:`, err);
		}
		json({
			content,
			tail,
			blocks: blocks.map((b) => ({ id: b.id, providerId: b.providerId, title: b.title, tokenEstimate: b.tokenEstimate })),
		});
	} catch (err: any) {
		jsonError(500, err);
	}
	return;
}

// POST /api/sessions/:id/provider-hooks/before-compact — notify providers before compaction.
async function handleBeforeCompact(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { json, jsonError, readBody, req, sessionManager } = ctx;
	const sessionId = params.id;
	// The bridge forwards the about-to-be-lost span (and optionally a precomputed
	// summary) from the pi session_before_compact payload. Validate both as strings
	// so a malformed body is rejected rather than silently dispatched empty.
	const body = await readBody(req).catch(() => ({} as any));
	if (body && body.span !== undefined && typeof body.span !== "string") {
		json({ error: "span must be a string" }, 400);
		return;
	}
	if (body && body.summary !== undefined && typeof body.summary !== "string") {
		json({ error: "summary must be a string" }, 400);
		return;
	}
	const base = resolveHookCtx(ctx, sessionId);
	if (!base) {
		json({ error: "Session not found" }, 404);
		return;
	}
	const hub = sessionManager.lifecycleHub;
	if (!hub) {
		json({});
		return;
	}
	try {
		await hub.dispatch("beforeCompact", {
			...base,
			span: typeof body?.span === "string" ? body.span : undefined,
			summary: typeof body?.summary === "string" ? body.summary : undefined,
		});
		json({});
	} catch (err: any) {
		jsonError(500, err);
	}
	return;
}

// GET /api/sessions/:id/context-trace?limit=N — per-turn provider dispatch trace.
function handleContextTrace(ctx: CoreRouteCtx, params: Record<string, string>): void {
	const { json, jsonError, url } = ctx;
	const sessionId = params.id;
	let limit: number | undefined;
	const rawLimit = url.searchParams.get("limit");
	if (rawLimit !== null) {
		const n = Number.parseInt(rawLimit, 10);
		if (Number.isFinite(n) && n > 0) limit = Math.min(n, 1000);
	}
	try {
		const entries = new ContextTraceStore(bobbitStateDir()).readTrace(sessionId, limit);
		json({ entries });
	} catch (err: any) {
		jsonError(500, err);
	}
	return;
}

// POST /api/sessions/:id/restart — restart a live session's agent process by id.
async function handleSessionRestart(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { json, readBody, req, sessionManager } = ctx;
	let id: string;
	try {
		id = decodeURIComponent(params.id);
	} catch {
		json({ error: "Session not found", code: "SESSION_NOT_FOUND" }, 404);
		return;
	}

	const session = sessionManager.getSession(id);
	const persisted = session ? sessionManager.getSessionStore(session.projectId).get(session.id) : undefined;
	if (!session || session.status === "terminated" || persisted?.archived) {
		json({ error: "Session not found", code: "SESSION_NOT_FOUND" }, 404);
		return;
	}
	if (session.readOnly || session.nonInteractive || persisted?.readOnly || persisted?.nonInteractive) {
		json({ error: "Session cannot be restarted", code: "SESSION_NOT_RESTARTABLE" }, 403);
		return;
	}

	const body = await readBody(req).catch(() => null);
	const status = String(session.status);
	if ((status === "busy" || status === "streaming" || session.isCompacting) && body?.force !== true) {
		json({ error: "Session is busy; retry with force to restart", code: "SESSION_BUSY" }, 409);
		return;
	}

	try {
		await sessionManager.restartAgent(id);
		json({ ok: true, sessionId: id });
	} catch (err: any) {
		const code = typeof err?.code === "string" && err.code ? err.code : "RESTART_ERROR";
		json({ error: err instanceof Error ? err.message : String(err), code }, 500);
	}
	return;
}

export function registerSessionControlRoutes(table: RouteTable<CoreRouteCtx>): void {
	table.register("POST", "/api/sessions/:id/activate-skill", handleActivateSkill);
	table.register("POST", "/api/sessions/:id/tool-grant-request", handleToolGrantRequest);
	table.register("POST", "/api/sessions/:id/provider-hooks/before-prompt", handleBeforePrompt);
	table.register("POST", "/api/sessions/:id/provider-hooks/before-compact", handleBeforeCompact);
	table.register("GET", "/api/sessions/:id/context-trace", handleContextTrace);
	table.register("POST", "/api/sessions/:id/restart", handleSessionRestart);
}
