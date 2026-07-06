// src/server/routes/extension-host-invocation-routes.ts
//
// STR-01 cohort 30: extension-host invocation routes migrated out of
// handleApiRoute's legacy if/else chain into the core route registry. See
// docs/design/route-registry.md.
//
// Mechanical extraction — handler bodies below preserve the legacy behavior,
// with only handleApiRoute locals destructured from ctx. The family stays in one
// handler because the legacy code intentionally shared authorization/identity
// shape across store/session/route/channel endpoints.
//
// LEGACY FALL-THROUGH PARITY: no unhandled-method shim needed. Every legacy
// block here gated on path and method in the same `if` condition; method
// mismatches fell through to the terminal 404. RouteTable's method-scoped
// matching preserves that by leaving other methods unregistered.

import { spawnExperimentChildGoal } from "../agent/experiment-spawn-goal.js";
import { packIdFromRoot } from "../agent/pack-contributions.js";
import { readSubgoalNestingPrefs } from "../agent/subgoal-nesting-limit.js";
import { builtinFirstPartyPackEntries, resolveBuiltinPacksDir } from "../agent/builtin-packs.js";
import { sessionFileRead, sessionFsContextForAgentFile } from "../agent/session-fs.js";
import { ActionError, resolveActionToolManager } from "../extension-host/action-dispatcher.js";
import { authorizeScopedRequest, type ActionGuardSession } from "../extension-host/action-guard.js";
import { buildTranscriptEnvelope, transcriptToHostMessages, transcriptToToolCall } from "../extension-host/contract-adapter.js";
import { getPackStore, PackStoreQuotaError, PackStoreTimeoutError, withStoreTimeout } from "../extension-host/pack-store.js";
import { resolvePackIdentityForTool } from "../extension-host/pack-identity.js";
import { createServerHostApi } from "../extension-host/server-host-api.js";
import { mintSurfaceToken, resolveSurfaceIdentity } from "../extension-host/surface-binding.js";
import type { RuntimeContext } from "../agent/lifecycle-hub.js";
import type { StorePutOptions } from "../../shared/extension-host/host-api.js";
import type { CoreRouteCtx } from "./core-route-ctx.js";
import type { RouteTable } from "./route-table.js";

// pack-schema-v1 §6.6: scoped-endpoint authorization for a PACK-BOUND surface
// token (no carrier tool). The token validation already proved installed +
// active + own-session via the pack-contribution registry, so allowedTools is
// NOT consulted (the new trust boundary, §4.5); we only re-check that the body
// session matches the header-canonical session and that the session resolves.
function packBoundScopedGuard(
	headerSid: string | undefined,
	bodySid: unknown,
	resolveSession: (id: string) => ActionGuardSession | undefined,
): { ok: true; sessionId: string } | { ok: false; status: number; error: string } {
	if (!headerSid) return { ok: false, status: 403, error: "missing session" };
	if (bodySid !== undefined && bodySid !== null && bodySid !== headerSid) {
		return { ok: false, status: 403, error: "session mismatch" };
	}
	if (!resolveSession(headerSid)) return { ok: false, status: 403, error: "unknown session" };
	return { ok: true, sessionId: headerSid };
}

async function handleExtensionHostInvocationRequest(ctx: CoreRouteCtx): Promise<void> {
	const {
		broadcastToAll,
		extensionChannelServices,
		json,
		mintScopedExtensionChannelOpenPermit,
		notePackStoreWrite,
		orchestrationCore,
		packContributionRegistry,
		packRuntimeSupervisor,
		preferencesStore,
		projectContextManager,
		readBody,
		readBodyText,
		req,
		resolveManagedRuntimeContext,
		routeDispatcher,
		routeRegistry,
		sandboxManager,
		sessionManager,
		toolManager,
		url,
		verificationHarness,
	} = ctx;

	// POST /api/ext/surface-token — mint a SERVER-MINTED surface binding token for a
	// pack surface (renderer / panel / entrypoint), called by the TRUSTED app loader
	// the first time it constructs that surface's Host API (design extension-host-
	// phase2.md §2.3 + §10). Authorize via authorizeScopedRequest (header-canonical
	// session, body===header, session resolves, `tool` ∈ allowedTools), SERVER-derive
	// the winning {packId, contributionId} from `tool`, reject a non-pack caller, and
	// mint a token BOUND to {sessionId, packId, contributionId, tool}. The client holds
	// the opaque token in the Host API closure and echoes it on every scoped call; the
	// scoped endpoints DERIVE {packId, tool} from the validated token and ignore any
	// caller-supplied tool/pack — closing the cross-pack identity hole the bare `tool`
	// field left open. (A same-realm malicious pack can still mint its own token for an
	// arbitrary tool name — the documented Model-A residual, marketplace.md threat model.)
	if (url.pathname === "/api/ext/surface-token" && req.method === "POST") {
		const body = (await readBody(req)) ?? {};
		const headerSessionId = req.headers["x-bobbit-session-id"] as string | string[] | undefined;
		const mintHeaderSid = Array.isArray(headerSessionId) ? headerSessionId[0] : headerSessionId;
		const mintSessionProjectId = mintHeaderSid
			? (sessionManager.getSession(mintHeaderSid)?.projectId
				?? sessionManager.getPersistedSession(mintHeaderSid)?.projectId)
			: undefined;
		const resolveSession = (id: string): ActionGuardSession | undefined => {
			const live = sessionManager.getSession(id);
			if (live) return { allowedTools: live.allowedTools };
			const persisted = sessionManager.getPersistedSession(id);
			if (persisted) return { allowedTools: persisted.allowedTools };
			return undefined;
		};
		const contributionKind = (body as { contributionKind?: unknown }).contributionKind;

		// ── Pack-bound surfaces (panel / entrypoint / route) are deliberately NOT
		// minted from this public REST body: a same-session caller could choose another
		// active pack's id. The trusted app mints these over the session WebSocket it
		// owns; pack code receives only the resulting HostApi closure.
		if (typeof contributionKind === "string") {
			if (contributionKind !== "panel" && contributionKind !== "entrypoint" && contributionKind !== "route") {
				json({ error: "invalid contributionKind" }, 400);
				return;
			}
			json({ error: "pack-bound surface tokens must be minted over the trusted session WebSocket" }, 403);
			return;
		}

		// ── Tool-bound surface (renderer / action) — UNCHANGED. ──
		const tool = typeof (body as { tool?: unknown }).tool === "string" ? (body as { tool: string }).tool : "";
		const mintToolManager = resolveActionToolManager(
			toolManager,
			mintSessionProjectId ? projectContextManager.getOrCreate(mintSessionProjectId)?.toolManager : undefined,
		);
		const guard = authorizeScopedRequest({
			tool,
			headerSessionId,
			bodySessionId: (body as { sessionId?: unknown }).sessionId,
			resolveSession,
		});
		if (!guard.ok) {
			json({ error: guard.error }, guard.status);
			return;
		}
		const ident = resolvePackIdentityForTool(mintToolManager, tool);
		if (!ident.isPack || !ident.packId) {
			json({ error: "surface tokens are available only to market-pack tools" }, 403);
			return;
		}
		const token = mintSurfaceToken({ sessionId: guard.sessionId, packId: ident.packId, contributionId: ident.contributionId, tool });
		console.log(`[ext-surface-token] tool=${tool} packId=${ident.packId} session=${guard.sessionId} outcome=ok`);
		json({ token });
		return;
	}

	// POST /api/ext/channel-open-permit — mint the one-shot permit required by
	// `ext_channel_open`. This scoped path accepts only pack-bound surface tokens
	// (panel / entrypoint / route); channel name is resolved inside that pack only.
	if (url.pathname === "/api/ext/channel-open-permit" && req.method === "POST") {
		if (!extensionChannelServices?.openPermits) {
			json({ error: "extension channels are not available" }, 503);
			return;
		}
		const body = (await readBody(req)) ?? {};
		const headerSessionId = req.headers["x-bobbit-session-id"] as string | string[] | undefined;
		const channelHeaderSid = Array.isArray(headerSessionId) ? headerSessionId[0] : headerSessionId;
		const channelSessionProjectId = channelHeaderSid
			? (sessionManager.getSession(channelHeaderSid)?.projectId
				?? sessionManager.getPersistedSession(channelHeaderSid)?.projectId)
			: undefined;
		const resolveSession = (id: string): ActionGuardSession | undefined => {
			const live = sessionManager.getSession(id);
			if (live) return { allowedTools: live.allowedTools };
			const persisted = sessionManager.getPersistedSession(id);
			if (persisted) return { allowedTools: persisted.allowedTools };
			return undefined;
		};
		const channelToolManager = resolveActionToolManager(
			toolManager,
			channelSessionProjectId ? projectContextManager.getOrCreate(channelSessionProjectId)?.toolManager : undefined,
		);
		const result = await mintScopedExtensionChannelOpenPermit({
			openPermits: extensionChannelServices.openPermits,
			packContributionRegistry,
			projectId: channelSessionProjectId,
			resolver: channelToolManager,
			headerSessionId: channelHeaderSid,
			rawHeaderSessionId: headerSessionId,
			bodySessionId: (body as { sessionId?: unknown }).sessionId,
			surfaceToken: (body as { surfaceToken?: unknown }).surfaceToken,
			name: (body as { name?: unknown }).name,
			init: (body as { init?: unknown }).init,
			singletonKey: (body as { singletonKey?: unknown }).singletonKey,
			resolveSession,
		});
		if (!result.ok) {
			console.warn(`[ext-channel-grant] outcome=error: ${result.error}`);
			json({ error: result.error }, result.status);
			return;
		}
		console.log(`[ext-channel-grant] channel=${result.channelName} packId=${result.packId} session=${result.sessionId} outcome=ok`);
		json({ openGrant: result.openGrant });
		return;
	}

	// POST /api/ext/store/:op — pack-namespaced KV persistence behind `host.store.*`
	// (design extension-host-phase2.md §3 B1.2). Pack-scoped (NOT tool-call-scoped):
	// the caller proves identity via a SERVER-MINTED surface token (NOT a caller-
	// supplied `tool` — closing the cross-pack identity hole); the server DERIVES
	// {packId, tool} from the validated token, then layers the per-session guard
	// (header-canonical session, body===header, session resolves, derived tool ∈
	// allowedTools — NO toolUseId-ownership, so a panel/entrypoint with no owned
	// toolUseId can persist). Keys are namespaced by the derived packId.
	const storeMatch = url.pathname.match(/^\/api\/ext\/store\/([^/]+)$/);
	if (storeMatch && req.method === "POST") {
		const op = decodeURIComponent(storeMatch[1]);
		if (op !== "get" && op !== "put" && op !== "list" && op !== "delete" && op !== "deletePrefix" && op !== "stats") {
			json({ error: `Unknown store op "${op}"`, code: "STORE_OP_UNKNOWN" }, 404);
			return;
		}
		const body = (await readBody(req)) ?? {};
		const headerSessionId = req.headers["x-bobbit-session-id"] as string | string[] | undefined;
		const storeHeaderSid = Array.isArray(headerSessionId) ? headerSessionId[0] : headerSessionId;
		// Resolve the tool through the SESSION's project-scoped tool manager (same
		// no-split-brain resolution the action endpoint uses).
		const storeSessionProjectId = storeHeaderSid
			? (sessionManager.getSession(storeHeaderSid)?.projectId
				?? sessionManager.getPersistedSession(storeHeaderSid)?.projectId)
			: undefined;
		const storeToolManager = resolveActionToolManager(
			toolManager,
			storeSessionProjectId ? projectContextManager.getOrCreate(storeSessionProjectId)?.toolManager : undefined,
		);
		const resolveSession = (id: string): ActionGuardSession | undefined => {
			const live = sessionManager.getSession(id);
			if (live) return { allowedTools: live.allowedTools };
			const persisted = sessionManager.getPersistedSession(id);
			if (persisted) return { allowedTools: persisted.allowedTools };
			return undefined;
		};
		// 1. DERIVE {packId, tool?} from the SERVER-MINTED surface token — never a
		//    caller-supplied `tool`. Rejects a missing/invalid/wrong-session/stale token.
		//    For a PACK-BOUND token (no tool) the token validation already proved
		//    installed+active+own-session against the pack-contribution registry.
		const surf = resolveSurfaceIdentity({ token: (body as { surfaceToken?: unknown }).surfaceToken, headerSessionId: storeHeaderSid, resolver: storeToolManager, contributions: packContributionRegistry, projectId: storeSessionProjectId });
		if (!surf.ok) {
			json({ error: surf.error }, surf.status);
			return;
		}
		const tool = surf.tool;
		const ident = { packId: surf.packId };
		// 2. Authorize: TOOL-bound tokens layer the allowedTools+session guard;
		//    PACK-bound tokens (no tool) skip allowedTools (new trust boundary §4.5)
		//    and only re-check the body===header session match.
		const guard = tool !== undefined
			? authorizeScopedRequest({ tool, headerSessionId, bodySessionId: (body as { sessionId?: unknown }).sessionId, resolveSession })
			: packBoundScopedGuard(storeHeaderSid, (body as { sessionId?: unknown }).sessionId, resolveSession);
		if (!guard.ok) {
			json({ error: guard.error }, guard.status);
			return;
		}
		const key = (body as { key?: unknown }).key;
		const prefix = (body as { prefix?: unknown }).prefix;
		const start = Date.now();
		try {
			const packStore = getPackStore();
			let result: unknown;
			// Bound each store op by a wall-time (design §3 B1.2): a stuck/slow backend
			// rejects with PackStoreTimeoutError → 504 rather than holding the request
			// open outside the blast-radius control.
			if (op === "get") {
				result = await withStoreTimeout(packStore.get(ident.packId, key as string), undefined, `store ${op}`);
			} else if (op === "put") {
				await withStoreTimeout(packStore.put(ident.packId, key as string, (body as { value?: unknown }).value, (body as { opts?: StorePutOptions }).opts), undefined, `store ${op}`);
				// Host-owned: a direct provider-config write must drop activation caches too.
				notePackStoreWrite(key);
				result = { ok: true };
			} else if (op === "delete") {
				result = await withStoreTimeout(packStore.delete(ident.packId, key as string), undefined, `store ${op}`);
			} else if (op === "deletePrefix") {
				result = await withStoreTimeout(packStore.deletePrefix(ident.packId, prefix as string), undefined, `store ${op}`);
			} else if (op === "stats") {
				result = await withStoreTimeout(packStore.stats(ident.packId, typeof prefix === "string" ? prefix : undefined), undefined, `store ${op}`);
			} else {
				result = await withStoreTimeout(packStore.list(ident.packId, typeof prefix === "string" ? prefix : undefined), undefined, `store ${op}`);
			}
			console.log(`[ext-store] op=${op} tool=${tool} packId=${ident.packId} session=${guard.sessionId} outcome=ok durationMs=${Date.now() - start}`);
			json(result ?? null);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			// A timed-out store op is a 5xx (backend unavailable); other errors (quota,
			// bad input) stay 4xx.
			const status = err instanceof PackStoreTimeoutError ? 504 : 400;
			const code = err instanceof PackStoreTimeoutError
				? "STORE_TIMEOUT"
				: err instanceof PackStoreQuotaError ? err.code : "STORE_ERROR";
			const details = err instanceof PackStoreQuotaError ? err.details : undefined;
			console.warn(`[ext-store] op=${op} tool=${tool} packId=${ident.packId} session=${guard.sessionId} outcome=error(${status}) durationMs=${Date.now() - start}: ${message}`);
			json({ error: message, code, ...(details ? { details } : {}) }, status);
		}
		return;
	}

	// GET /api/ext/session/{transcript,tool-call} — Slice B2 pack-scoped, OWN-SESSION
	// transcript reads (design extension-host-phase2.md §4 B2.2). The HEADER-BOUND
	// session is the single canonical identity; there is NO parameter for another
	// session — reads are own-session by construction. `tool` (query) gates on the
	// session's allowedTools through the SAME `authorizeScopedRequest` core the
	// action endpoint uses (no toolUseId required — panels/entrypoints may originate
	// the read). `sessionId` (query) is the body-vs-header fail-fast input.
	const extSessionTranscript = url.pathname === "/api/ext/session/transcript";
	const extSessionToolCall = url.pathname === "/api/ext/session/tool-call";
	if ((extSessionTranscript || extSessionToolCall) && req.method === "GET") {
		const extHeaderSid = req.headers["x-bobbit-session-id"] as string | string[] | undefined;
		const extCanonSid = Array.isArray(extHeaderSid) ? extHeaderSid[0] : extHeaderSid;
		const extResolveSession = (id: string): ActionGuardSession | undefined => {
			const live = sessionManager.getSession(id);
			if (live) return { allowedTools: live.allowedTools };
			const persisted = sessionManager.getPersistedSession(id);
			if (persisted) return { allowedTools: persisted.allowedTools };
			return undefined;
		};
		// Resolve the SESSION's project-scoped tool manager up front (no split-brain),
		// then DERIVE {packId, tool} from the SERVER-MINTED surface token (query param) —
		// never a caller-supplied `tool`. authorizeScopedRequest only gates allowedTools
		// (an UNRESTRICTED session has none), so identity MUST come from the validated
		// token; a missing/invalid/wrong-session/stale token (or non-pack tool) is rejected
		// BEFORE any transcript byte is read — session reads are pack-only + own-session.
		const extSessionProjectId = extCanonSid
			? (sessionManager.getSession(extCanonSid)?.projectId
				?? sessionManager.getPersistedSession(extCanonSid)?.projectId)
			: undefined;
		const extToolManager = resolveActionToolManager(
			toolManager,
			extSessionProjectId ? projectContextManager.getOrCreate(extSessionProjectId)?.toolManager : undefined,
		);
		const surf = resolveSurfaceIdentity({ token: url.searchParams.get("surfaceToken"), headerSessionId: extCanonSid, resolver: extToolManager, contributions: packContributionRegistry, projectId: extSessionProjectId });
		if (!surf.ok) {
			json({ error: surf.error }, surf.status);
			return;
		}
		// TOOL-bound tokens layer the allowedTools+session guard; PACK-bound tokens
		// (no tool) skip allowedTools (§4.5) and only re-check the session match.
		const extGuard = surf.tool !== undefined
			? authorizeScopedRequest({ tool: surf.tool, headerSessionId: extHeaderSid, bodySessionId: url.searchParams.get("sessionId"), resolveSession: extResolveSession })
			: packBoundScopedGuard(extCanonSid, url.searchParams.get("sessionId"), extResolveSession);
		if (!extGuard.ok) {
			json({ error: extGuard.error }, extGuard.status);
			return;
		}
		// Read the HEADER-BOUND session's transcript ONLY (own-session by construction).
		const extPs = sessionManager.getPersistedSession(extGuard.sessionId);
		let extJsonl: string | null = null;
		if (extPs?.agentSessionFile) {
			const fsCtx = sessionFsContextForAgentFile(extPs, extPs.agentSessionFile);
			extJsonl = await sessionFileRead(fsCtx, extPs.agentSessionFile, sandboxManager ?? null);
		}
		if (extSessionToolCall) {
			const toolUseId = url.searchParams.get("toolUseId");
			if (!toolUseId) { json({ error: "toolUseId required" }, 400); return; }
			json(transcriptToToolCall(extJsonl, toolUseId));
			return;
		}
		const parseIntQ = (name: string): number | undefined => {
			const raw = url.searchParams.get(name);
			if (raw === null) return undefined;
			const n = Number(raw);
			return Number.isFinite(n) ? n : undefined;
		};
		try {
			const envelope = buildTranscriptEnvelope(transcriptToHostMessages(extJsonl), {
				offset: parseIntQ("offset"),
				limit: parseIntQ("limit"),
				pattern: url.searchParams.get("pattern") ?? undefined,
			});
			json(envelope);
		} catch (err) {
			json({ error: err instanceof Error ? err.message : String(err) }, 400);
		}
		return;
	}

	// POST /api/ext/route/:name — pack-scoped typed route call behind `host.callRoute`
	// (design extension-host-phase2.md §5 B3.2). Pack-scoped (NOT tool-call-scoped):
	// authorize via authorizeScopedRequest (NO toolUseId-ownership — a panel/entrypoint
	// with no owned toolUseId may call routes), then derive the trusted packId SERVER-
	// side from the opener `tool` and resolve the route MODULE via the pack-level
	// RouteRegistry (opener-INDEPENDENT) so a route declared on tool Y is reachable from
	// a surface opened by tool X in the SAME pack. There is NO `<pack>` URL segment to
	// forge — the routed pack is derived from a tool the caller proves it owns.
	const routeMatch = url.pathname.match(/^\/api\/ext\/route\/([^/]+)$/);
	if (routeMatch && req.method === "POST") {
		const routeName = decodeURIComponent(routeMatch[1]);
		const body = (await readBody(req)) ?? {};
		const headerSessionId = req.headers["x-bobbit-session-id"] as string | string[] | undefined;
		const routeHeaderSid = Array.isArray(headerSessionId) ? headerSessionId[0] : headerSessionId;
		const routePs = routeHeaderSid ? sessionManager.getPersistedSession(routeHeaderSid) : undefined;
		// Resolve the tool through the SESSION's project-scoped tool manager (same
		// no-split-brain resolution the action + store endpoints use).
		const routeSessionProjectId = routeHeaderSid
			? (sessionManager.getSession(routeHeaderSid)?.projectId
				?? routePs?.projectId)
			: undefined;
		const routeToolManager = resolveActionToolManager(
			toolManager,
			routeSessionProjectId ? projectContextManager.getOrCreate(routeSessionProjectId)?.toolManager : undefined,
		);
		const resolveSession = (id: string): ActionGuardSession | undefined => {
			const live = sessionManager.getSession(id);
			if (live) return { allowedTools: live.allowedTools };
			const persisted = sessionManager.getPersistedSession(id);
			if (persisted) return { allowedTools: persisted.allowedTools };
			return undefined;
		};
		// 1. DERIVE the trusted {packId, tool} from the SERVER-MINTED surface token —
		//    never a caller-supplied `tool` (closing the cross-pack identity hole). The
		//    derived tool is the OPENER (the surface's contributing tool); the route
		//    MODULE is resolved opener-INDEPENDENTLY below via the pack-level registry.
		const surf = resolveSurfaceIdentity({ token: (body as { surfaceToken?: unknown }).surfaceToken, headerSessionId: routeHeaderSid, resolver: routeToolManager, contributions: packContributionRegistry, projectId: routeSessionProjectId });
		if (!surf.ok) {
			json({ error: surf.error }, surf.status);
			return;
		}
		const routeTool = surf.tool;
		const ident = { packId: surf.packId, contributionId: surf.contributionId };
		// 2. Authorize: TOOL-bound tokens layer the allowedTools+session guard;
		//    PACK-bound tokens (no tool — orphan/UI-only pack) skip allowedTools
		//    (§4.5) and only re-check the session match. NO toolUseId-ownership.
		const guard = routeTool !== undefined
			? authorizeScopedRequest({ tool: routeTool, headerSessionId, bodySessionId: (body as { sessionId?: unknown }).sessionId, resolveSession })
			: packBoundScopedGuard(routeHeaderSid, (body as { sessionId?: unknown }).sessionId, resolveSession);
		if (!guard.ok) {
			json({ error: guard.error }, guard.status);
			return;
		}
		// 4. Resolve the route MODULE via the pack-level registry (off pack-level
		//    routes, opener-independent — pack-schema-v1 §5.3).
		const resolved = routeRegistry.resolve(ident.packId, routeName, routeSessionProjectId);
		if (!resolved) {
			json({ error: `pack "${ident.packId}" declares no route "${routeName}"` }, 404);
			return;
		}
		// 5. Dispatch the registry's DECLARING-tool module with the packId-bound host
		//    context (identity from ident, NOT the opener tool).
		const toolUseId = typeof (body as { toolUseId?: unknown }).toolUseId === "string"
			? (body as { toolUseId: string }).toolUseId
			: undefined;
		const init = ((body as { init?: unknown }).init ?? {}) as { method?: unknown; query?: unknown; body?: unknown };
		const method = typeof init.method === "string" ? init.method : "GET";
		let query: Record<string, string> | undefined;
		if (init.query && typeof init.query === "object") {
			query = {};
			for (const [k, v] of Object.entries(init.query as Record<string, unknown>)) {
				if (v !== undefined && v !== null) query[k] = String(v);
			}
		}
		const readOwnTranscript = async (): Promise<string | null> => {
			const ps = sessionManager.getPersistedSession(guard.sessionId);
			if (!ps?.agentSessionFile) return null;
			const fsCtx = sessionFsContextForAgentFile(ps, ps.agentSessionFile);
			return sessionFileRead(fsCtx, ps.agentSessionFile, sandboxManager ?? null);
		};
		const host = createServerHostApi({
			sessionId: guard.sessionId,
			toolUseId,
			packId: ident.packId,
			contributionId: ident.contributionId,
			packStore: getPackStore(),
			readOwnTranscript,
			// Sub-goal A seam — sub-goal C consumes this to back `host.agents`.
			orchestrationCore,
			// Sub-goal C: live status reader for host.agents.status/list (the core has
			// no public status accessor).
			readChildStatus: (id: string) => sessionManager.getSession(id)?.status,
			// EXPERIMENT-RUNNER SEAM: back host.agents.spawnGoal with the shared
			// nested-goal creation closure (parent-derived, cap-aware team start).
			spawnChildGoal: (ownerSessionId: string, spawnOpts) => spawnExperimentChildGoal({
				sessionManager,
				projectContextManager,
				verificationHarness,
				getSubgoalNestingPrefs: () => readSubgoalNestingPrefs((k) => preferencesStore.get(k)),
				broadcastToAll,
			}, ownerSessionId, spawnOpts),
			// Drop activation caches when a route persists provider config (host-owned).
			onStoreWrite: notePackStoreWrite,
		});
		// P3/P4 — managed-runtime context injection for pack ROUTES. Mirror the
		// LifecycleHub provider-hook path: if the routed pack has a provider declaring a
		// `runtime` linkage and its EFFECTIVE config selects a managed deployment mode,
		// resolve `ctx.runtime` from the supervisor WITHOUT starting Docker so the route
		// handlers reach the locally-running managed runtime (e.g. Hindsight status/recall).
		// External mode / no runtime / a stopped runtime ⇒ undefined, and the route stays
		// dormant via its own `isActive(cfg, ctx.runtime)` gate. Resolution failure is
		// non-fatal (the route just runs without runtime).
		let routeRuntime: RuntimeContext | undefined;
		try {
			const pack = packContributionRegistry.getPack(routeSessionProjectId, ident.packId);
			const runtimeProvider = pack?.providers.find((p) => typeof p.runtime === "string" && p.runtime.length > 0);
			if (runtimeProvider?.runtime) {
				routeRuntime = await resolveManagedRuntimeContext(packRuntimeSupervisor, {
					packId: ident.packId,
					runtimeId: runtimeProvider.runtime,
					projectId: routeSessionProjectId,
					config: runtimeProvider.config ?? {},
				});
			}
		} catch {
			routeRuntime = undefined; // non-fatal — the route runs without ctx.runtime
		}
		const start = Date.now();
		try {
			// The session working dir the confined worker uses as its process.cwd()
			// (tool parity — prefer the worktree path; fall back to the recorded cwd).
			const routeWorkingDir = routePs?.worktreePath ?? routePs?.cwd;
			const result = await routeDispatcher.dispatch(
				resolved.modulePath,
				resolved.packRoot,
				routeName,
				{ host, sessionId: guard.sessionId, toolUseId: toolUseId ?? "", tool: ident.contributionId, projectId: routeSessionProjectId, workingDir: routeWorkingDir, sessionArchived: routePs?.archived === true, ...(routeRuntime ? { runtime: routeRuntime } : {}) },
				{ method, query, body: init.body },
			);
			const durationMs = Date.now() - start;
			// PR Walkthrough status is a browser polling route; keep slow successes and
			// all catch-branch errors visible, but do not flood logs with fast ticks.
			const suppressNoisyOk = ident.packId === "pr-walkthrough" && routeName === "status" && durationMs < 1_000;
			if (!suppressNoisyOk) {
				console.log(`[ext-route] name=${routeName} tool=${routeTool ?? ident.contributionId} packId=${ident.packId} session=${guard.sessionId} outcome=ok durationMs=${durationMs}`);
			}
			json(result ?? null);
		} catch (err) {
			const status = err instanceof ActionError ? err.status : 500;
			const message = err instanceof Error ? err.message : String(err);
			console.warn(`[ext-route] name=${routeName} tool=${routeTool ?? ident.contributionId} packId=${ident.packId} session=${guard.sessionId} outcome=error(${status}) durationMs=${Date.now() - start}: ${message}`);
			json({ error: message }, status);
		}
		return;
	}

	// GET/POST /api/ext/pack-route/:packId/:routeName — SESSIONLESS admin access to a
	// BUILT-IN pack's route (Hindsight UX polish). The Marketplace must read built-in
	// Hindsight config/status, AND write Hindsight config, after `#/market` navigation
	// when there is no active chat session, so the surface-token path
	// (`/api/ext/surface-token` → `/api/ext/route`) 403s. This additive route serves
	// the SAME pack-level route module WITHOUT a bound session. It is narrowly scoped
	// so it cannot widen the extension threat model:
	//   • Admin-bearer only (gated before handleApiRoute) — the trusted app shell.
	//   • BUILT-IN first-party packs only — a same-realm third-party pack cannot use
	//     this sessionless seam to read or write another pack's route output.
	//   • GET → any route (pure read). POST → ALLOWLISTED to the `config` route name
	//     ONLY (the built-in config write); any other routeName under POST is rejected
	//     403, so this is NOT a general write seam — it is purely the GET seam's
	//     config-write sibling. The `config` route validates + persists to the pack
	//     store (CONFIG_INVALID for bad input) and returns the redacted effective
	//     config.
	// CRITICAL: this path NEVER starts Docker and works with NO session — POST only
	// persists config to the pack store. `ctx.runtime` is resolved WITHOUT starting
	// Docker (mirrors `/api/ext/route`), preserving the no-Docker-auto-start invariant.
	const packRouteMatch = url.pathname.match(/^\/api\/ext\/pack-route\/([^/]+)\/([^/]+)$/);
	if (packRouteMatch && (req.method === "GET" || req.method === "POST")) {
		const reqPackId = decodeURIComponent(packRouteMatch[1]);
		const routeName = decodeURIComponent(packRouteMatch[2]);
		const isWrite = req.method === "POST";
		const projectId = url.searchParams.get("projectId") || undefined;
		// POST is allowlisted to the `config` route ONLY — never a general write seam.
		if (isWrite && routeName !== "config") {
			json({ error: "sessionless pack-route writes are available only for the 'config' route" }, 403);
			return;
		}
		// Parse the JSON body for the config write. An empty body is rejected for POST
		// (a config write must carry overrides); malformed JSON is a 400 client error.
		let writeBody: Record<string, unknown> = {};
		if (isWrite) {
			const bodyText = await readBodyText(req);
			if (bodyText === null) { json({ error: "request body unreadable or too large" }, 400); return; }
			const trimmed = bodyText.trim();
			if (trimmed.length === 0) { json({ error: "config write requires a JSON body" }, 400); return; }
			try {
				const parsed = JSON.parse(trimmed);
				if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
					json({ error: "config write body must be a JSON object" }, 400);
					return;
				}
				writeBody = parsed as Record<string, unknown>;
			} catch {
				json({ error: "config write body must be valid JSON" }, 400);
				return;
			}
		}
		// Restrict to BUILT-IN first-party packs (same enumeration the Installed list
		// uses to synthesise built-in rows), keyed by the STRUCTURAL packId.
		const builtinPackIds = new Set(
			builtinFirstPartyPackEntries(resolveBuiltinPacksDir())
				.filter((e) => e.manifest)
				.map((e) => packIdFromRoot(e.path)),
		);
		if (!builtinPackIds.has(reqPackId)) {
			json({ error: "sessionless pack-route access is available only to built-in packs" }, 403);
			return;
		}
		const resolved = routeRegistry.resolve(reqPackId, routeName, projectId);
		if (!resolved) {
			json({ error: `pack "${reqPackId}" declares no route "${routeName}"` }, 404);
			return;
		}
		const host = createServerHostApi({
			sessionId: "",
			toolUseId: undefined,
			packId: reqPackId,
			contributionId: "",
			packStore: getPackStore(),
			orchestrationCore,
			readChildStatus: (id: string) => sessionManager.getSession(id)?.status,
			onStoreWrite: notePackStoreWrite,
		});
		// Managed-runtime context injection (NO Docker start) — mirror `/api/ext/route`.
		let packRouteRuntime: RuntimeContext | undefined;
		try {
			const pack = packContributionRegistry.getPack(projectId, reqPackId);
			const runtimeProvider = pack?.providers.find((p) => typeof p.runtime === "string" && p.runtime.length > 0);
			if (runtimeProvider?.runtime) {
				packRouteRuntime = await resolveManagedRuntimeContext(packRuntimeSupervisor, {
					packId: reqPackId,
					runtimeId: runtimeProvider.runtime,
					projectId,
					config: runtimeProvider.config ?? {},
				});
			}
		} catch {
			packRouteRuntime = undefined; // non-fatal — the route runs without ctx.runtime
		}
		const start = Date.now();
		try {
			const result = await routeDispatcher.dispatch(
				resolved.modulePath,
				resolved.packRoot,
				routeName,
				{ host, sessionId: "", toolUseId: "", tool: "", projectId, ...(packRouteRuntime ? { runtime: packRouteRuntime } : {}) },
				isWrite ? { method: "POST", body: writeBody } : { method: "GET" },
			);
			console.log(`[ext-pack-route] name=${routeName} packId=${reqPackId} method=${isWrite ? "POST" : "GET"} sessionless outcome=ok durationMs=${Date.now() - start}`);
			json(result ?? null);
		} catch (err) {
			const status = err instanceof ActionError ? err.status : 500;
			const message = err instanceof Error ? err.message : String(err);
			console.warn(`[ext-pack-route] name=${routeName} packId=${reqPackId} sessionless outcome=error(${status}) durationMs=${Date.now() - start}: ${message}`);
			json({ error: message }, status);
		}
		return;
	}
}

export function registerExtensionHostInvocationRoutes(table: RouteTable<CoreRouteCtx>): void {
	table.register("POST", "/api/ext/surface-token", handleExtensionHostInvocationRequest);
	table.register("POST", "/api/ext/channel-open-permit", handleExtensionHostInvocationRequest);
	table.register("POST", "/api/ext/store/:op", handleExtensionHostInvocationRequest);
	table.register("GET", "/api/ext/session/transcript", handleExtensionHostInvocationRequest);
	table.register("GET", "/api/ext/session/tool-call", handleExtensionHostInvocationRequest);
	table.register("POST", "/api/ext/route/:name", handleExtensionHostInvocationRequest);
	table.register("GET", "/api/ext/pack-route/:packId/:routeName", handleExtensionHostInvocationRequest);
	table.register("POST", "/api/ext/pack-route/:packId/:routeName", handleExtensionHostInvocationRequest);
}
