// Typed Hindsight memory route adapters. Authority, settings, and service lifecycle
// remain host-owned: this module accepts only the host-resolved scope/runtime and
// asks the EP-6 adapter for an exact, live capability before a data-plane call.

import {
	clientConfig,
	completedOutcomeRetention,
	isActive,
	isConfigured,
	loadEffectiveConfig,
	makeClient,
	resolveConfig,
	type EffectiveConfig,
	type RuntimeContext,
	type StoreLike,
	type Tags,
} from "./shared.js";

export type MemoryCapability = "memory.read" | "memory.write" | "memory.reflect" | "memory.invalidate" | "memory.read.all";

export interface MemoryRouteRequest {
	body?: unknown;
	query?: Record<string, string>;
}

export interface CapabilityDecision {
	allowed: boolean;
	reason?: "required" | "denied" | "unavailable";
}

/** Server-owned EP-6 bridge. It is deliberately an adapter, not a pack grant
 * store: decisions must be made by the host against the current project grant. */
export interface MemoryRouteHostAdapter {
	requireCapability?(capability: MemoryCapability): Promise<CapabilityDecision> | CapabilityDecision;
}

export interface MemoryRouteHost {
	store: StoreLike;
	memory?: MemoryRouteHostAdapter;
	/** Canonical, redacted EP-7 provider values injected by the host. */
	providerConfig?: unknown;
	/** Bounded, server-derived completion snapshot. Request bodies are ignored. */
	completedOutcome?: unknown;
}
export interface MemoryRouteContext {
	host: MemoryRouteHost;
	scopeContext?: { project?: { id?: string }; goal?: { id?: string } };
	runtime?: RuntimeContext;
	/** Parent dispatch cancellation; supplied by the worker boundary when available. */
	signal?: AbortSignal;
}

export type MemoryScope = { projectId: string; goalId?: string; all: boolean };

const MAX_QUERY = 4_000;
const MAX_CONTENT = 16_000;
const MAX_CURSOR = 512;
const MAX_ID = 512;
const MAX_LIMIT = 100;
const MAX_RESULT_TEXT = 16_000;
const DATA_PLANE_DEADLINE_MS = 5_000;

function record(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, max = MAX_CONTENT): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 && trimmed.length <= max ? trimmed : undefined;
}

function safeId(value: unknown): string | undefined {
	const id = text(value, MAX_ID);
	return id && !/[\u0000-\u001f\u007f]/.test(id) ? id : undefined;
}

function number(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0
		? Math.min(value, MAX_LIMIT)
		: fallback;
}

function bodyOf(req: MemoryRouteRequest): Record<string, unknown> {
	return record(req.body) ? req.body : {};
}

/** Scope is entirely route-context-derived. `all` is an explicit request only;
 * it never derives from arbitrary body tags or a missing project. */
export function resolveMemoryScope(ctx: MemoryRouteContext, req: MemoryRouteRequest): MemoryScope | undefined {
	const projectId = text(ctx.scopeContext?.project?.id, MAX_ID);
	if (!projectId) return undefined;
	const body = bodyOf(req);
	return {
		projectId,
		...(text(ctx.scopeContext?.goal?.id, MAX_ID) ? { goalId: text(ctx.scopeContext?.goal?.id, MAX_ID) } : {}),
		all: body.scope === "all",
	};
}

/** Exposed for the server bridge's pre-dispatch live EP-6 check. */
export function requiredMemoryCapability(routeName: string, req: MemoryRouteRequest): MemoryCapability | undefined {
	const scope = bodyOf(req).scope;
	if ((routeName === "browse" || routeName === "detail" || routeName === "history" || routeName === "recall") && scope === "all") return "memory.read.all";
	if (routeName === "browse" || routeName === "detail" || routeName === "history" || routeName === "recall") return "memory.read";
	if (routeName === "retain" || routeName === "retain-outcome") return "memory.write";
	if (routeName === "reflect") return "memory.reflect";
	if (routeName === "invalidate") return "memory.invalidate";
	return undefined;
}

async function authorize(ctx: MemoryRouteContext, capability: MemoryCapability): Promise<{ ok: true } | { ok: false; code: string }> {
	const requireCapability = ctx.host.memory?.requireCapability;
	if (!requireCapability) return { ok: false, code: "EXTENSION_CAPABILITY_REQUIRED" };
	try {
		const decision = await requireCapability(capability);
		// `host.memory` is the public EP-6 adapter: successful checks resolve
		// void, while test adapters may return a richer decision.
		if (decision === undefined || decision?.allowed === true) return { ok: true };
		return { ok: false, code: decision.reason === "denied" ? "EXTENSION_CAPABILITY_DENIED" : "EXTENSION_CAPABILITY_REQUIRED" };
	} catch {
		return { ok: false, code: "EXTENSION_CAPABILITY_REQUIRED" };
	}
}

function scopedTags(scope: MemoryScope): Tags {
	return { project: scope.projectId, ...(scope.goalId ? { goal: scope.goalId } : {}) };
}

type RouteConfig =
	| { state: "active"; config: EffectiveConfig }
	| { state: "dormant"; configured: false }
	| { state: "unhealthy"; configured: boolean; code: "SERVICE_UNHEALTHY" }
	| { state: "unavailable"; configured: false; error: "HINDSIGHT_CONFIG_UNAVAILABLE" };

/** Read configuration before evaluating request scope or grants. A dormant or
 * unreadable configuration is not a data-plane operation, so it cannot provoke
 * a client construction or turn a missing grant into a misleading response. */
async function routeConfig(ctx: MemoryRouteContext): Promise<RouteConfig> {
	// EP-7 is authoritative when the route boundary injects it. The legacy pack
	// record remains a migration fallback for direct/older invocations only.
	const injected = ctx.host.providerConfig;
	const loaded = injected === undefined
		? await loadEffectiveConfig(ctx.host.store)
		: { available: true as const, config: resolveConfig(injected), overrides: {} };
	if (!loaded.available) return { state: "unavailable", configured: false, error: "HINDSIGHT_CONFIG_UNAVAILABLE" };
	if (!isConfigured(loaded.config)) {
		// A generic runtime context is injected only by the managed H-4 bridge.
		// Its stopped/degraded status is meaningful even before the legacy provider
		// store has an external URL; plain direct calls remain dormant.
		return ctx.runtime ? { state: "unhealthy", configured: false, code: "SERVICE_UNHEALTHY" } : { state: "dormant", configured: false };
	}
	if (!isActive(loaded.config, ctx.runtime)) return { state: "unhealthy", configured: true, code: "SERVICE_UNHEALTHY" };
	return { state: "active", config: loaded.config };
}

function clientMethod(client: unknown, name: string): ((...args: unknown[]) => Promise<unknown>) | undefined {
	if (!record(client)) return undefined;
	const method = client[name];
	return typeof method === "function" ? method.bind(client) as (...args: unknown[]) => Promise<unknown> : undefined;
}

/** A route deadline actively aborts its client, including a body that has already
 * received headers. This is intentionally not a Promise.race: losing work must
 * not retain sockets or continue parsing an attacker-controlled response. */
async function withActiveClient<T, F = { configured: true; code: "SERVICE_UNHEALTHY" }>(
	ctx: MemoryRouteContext,
	config: EffectiveConfig,
	work: (client: unknown, config: EffectiveConfig) => Promise<T>,
	failure: F = { configured: true, code: "SERVICE_UNHEALTHY" } as F,
): Promise<T | F> {
	const controller = new AbortController();
	const abort = () => controller.abort(ctx.signal?.reason);
	if (ctx.signal?.aborted) abort(); else ctx.signal?.addEventListener("abort", abort, { once: true });
	const timer = setTimeout(() => controller.abort(), DATA_PLANE_DEADLINE_MS);
	try {
		return await work(await makeClient({ ...clientConfig(config, ctx.runtime), signal: controller.signal }), config);
	} catch {
		return failure;
	} finally {
		clearTimeout(timer); ctx.signal?.removeEventListener("abort", abort); controller.abort();
	}
}

function safeText(value: unknown, max = MAX_RESULT_TEXT): string | undefined {
	return typeof value === "string" ? value.slice(0, max) : undefined;
}
function safeRecord(value: unknown): Record<string, unknown> | undefined {
	if (!record(value)) return undefined;
	const out: Record<string, unknown> = {};
	for (const key of ["id", "text", "content", "context", "type", "state", "reason", "date", "created_at", "updated_at", "score"] as const) {
		const scalar = value[key];
		if (typeof scalar === "string") out[key] = scalar.slice(0, MAX_RESULT_TEXT);
		else if (typeof scalar === "number" && Number.isFinite(scalar)) out[key] = scalar;
	}
	if (Array.isArray(value.tags)) out.tags = value.tags.slice(0, MAX_LIMIT).flatMap(tag => typeof tag === "string" ? [tag.slice(0, MAX_ID)] : []);
	if (Array.isArray(value.entities)) out.entities = value.entities.slice(0, MAX_LIMIT).flatMap(entity => typeof entity === "string" ? [entity.slice(0, MAX_ID)] : []);
	return out;
}
function safeRows(value: unknown): Record<string, unknown>[] {
	if (!Array.isArray(value)) return [];
	const rows: Record<string, unknown>[] = [];
	for (const row of value.slice(0, MAX_LIMIT)) {
		const safe = safeRecord(row); if (safe) rows.push(safe);
	}
	return rows;
}
function belongsToScope(memory: unknown, scope: MemoryScope): boolean {
	if (scope.all || !record(memory) || !Array.isArray(memory.tags)) return scope.all;
	const tags = new Set(memory.tags.filter((tag): tag is string => typeof tag === "string"));
	return tags.has(`project:${scope.projectId}`) && (!scope.goalId || tags.has(`goal:${scope.goalId}`));
}

async function readRows(ctx: MemoryRouteContext, req: MemoryRouteRequest) {
	const availability = await routeConfig(ctx);
	if (availability.state === "unavailable") return { configured: false, error: availability.error, memories: [] };
	if (availability.state === "dormant") return { configured: false, memories: [] };
	if (availability.state === "unhealthy") return { configured: availability.configured, code: availability.code };
	const scope = resolveMemoryScope(ctx, req);
	if (!scope) return { configured: true, code: "HINDSIGHT_SCOPE_UNAVAILABLE", memories: [] };
	const permission = await authorize(ctx, scope.all ? "memory.read.all" : "memory.read");
	if (!permission.ok) return { configured: true, code: permission.code, memories: [] };
	const body = bodyOf(req);
	const query = text(body.query ?? req.query?.query, MAX_QUERY);
	const cursor = text(body.cursor, MAX_CURSOR);
	const limit = number(body.limit, 25);
	return await withActiveClient(ctx, availability.config, async (client, config) => {
		const browse = clientMethod(client, "browse");
		if (!browse) return { configured: true, code: "MEMORY_API_UNSUPPORTED", memories: [] };
		// Client construction is async, so the pre-dispatch grant is only a
		// fast-fail. Re-read the live decision immediately before the request.
		const livePermission = await authorize(ctx, scope.all ? "memory.read.all" : "memory.read");
		if (!livePermission.ok) return { configured: true, code: livePermission.code, memories: [] };
		const result = await browse(config.bank, { query, cursor, limit, tags: scope.all ? undefined : scopedTags(scope), tagsMatch: "all_strict" });
		const data = record(result) ? result : {};
		return {
			configured: true,
			memories: safeRows(data.memories),
			...(text(data.cursor, MAX_CURSOR) ? { cursor: text(data.cursor, MAX_CURSOR) } : {}),
		};
	});
}

export const memoryRoutes = {
	browse: readRows,
	search: readRows,

	/** Recall shares the ordinary scoped-read adapter rather than the legacy
	 * provider route, so an all-scope request cannot be silently narrowed or
	 * authorized with the wrong EP-6 capability. */
	recall: async (ctx: MemoryRouteContext, req: MemoryRouteRequest) => {
		const availability = await routeConfig(ctx);
		if (availability.state === "unavailable") return { configured: false, error: availability.error, memories: [] };
		if (availability.state === "dormant") return { configured: false, memories: [] };
		if (availability.state === "unhealthy") return { configured: availability.configured, code: availability.code };
		const scope = resolveMemoryScope(ctx, req);
		const query = text(bodyOf(req).query ?? req.query?.query, MAX_QUERY);
		// Do not read or contact a provider without the host-owned scope. The
		// compatibility shape intentionally remains an empty read result.
		if (!scope || !query) return { configured: true, ...(query ? {} : { code: "MEMORY_QUERY_REQUIRED" }), memories: [] };
		const permission = await authorize(ctx, scope.all ? "memory.read.all" : "memory.read");
		if (!permission.ok) return { configured: true, code: permission.code, memories: [] };
		return await withActiveClient(ctx, availability.config, async (client, config) => {
			const recall = clientMethod(client, "recall");
			if (!recall) return { configured: true, code: "MEMORY_API_UNSUPPORTED", memories: [] };
			const livePermission = await authorize(ctx, scope.all ? "memory.read.all" : "memory.read");
			if (!livePermission.ok) return { configured: true, code: livePermission.code, memories: [] };
			const result = await recall(config.bank, query, { maxTokens: config.recallBudget, tags: scope.all ? undefined : scopedTags(scope), tagsMatch: "all_strict" });
			const data = record(result) ? result : {};
			return { configured: true, memories: safeRows(data.memories) };
		});
	},

	retain: async (ctx: MemoryRouteContext, req: MemoryRouteRequest) => {
		const availability = await routeConfig(ctx);
		if (availability.state === "unavailable") return { ok: false, configured: false, error: availability.error };
		if (availability.state === "dormant") return { ok: false, configured: false, code: "SERVICE_UNHEALTHY" };
		if (availability.state === "unhealthy") return { ok: false, configured: availability.configured, code: availability.code };
		const scope = resolveMemoryScope(ctx, req);
		const content = text(bodyOf(req).content, MAX_CONTENT);
		if (!scope || !content) return { ok: false, configured: true, code: !scope ? "HINDSIGHT_SCOPE_UNAVAILABLE" : "MEMORY_CONTENT_REQUIRED" };
		const permission = await authorize(ctx, "memory.write");
		if (!permission.ok) return { ok: false, configured: true, code: permission.code };
		return await withActiveClient(ctx, availability.config, async (client, config) => {
			const retain = clientMethod(client, "retain");
			const ensureBank = clientMethod(client, "ensureBank");
			if (!retain || !ensureBank) return { ok: false, configured: true, code: "MEMORY_API_UNSUPPORTED" };
			let livePermission = await authorize(ctx, "memory.write");
			if (!livePermission.ok) return { ok: false, configured: true, code: livePermission.code };
			await ensureBank(config.bank);
			livePermission = await authorize(ctx, "memory.write");
			if (!livePermission.ok) return { ok: false, configured: true, code: livePermission.code };
			await retain(config.bank, content, { tags: { kind: "manual", ...scopedTags(scope) }, sync: bodyOf(req).sync === true });
			return { ok: true, configured: true };
		}, { ok: false as const, configured: true as const, code: "SERVICE_UNHEALTHY" as const });
	},

	reflect: async (ctx: MemoryRouteContext, req: MemoryRouteRequest) => {
		const availability = await routeConfig(ctx);
		if (availability.state === "unavailable") return { configured: false, error: availability.error, text: "" };
		if (availability.state === "dormant") return { configured: false, text: "" };
		if (availability.state === "unhealthy") return { configured: availability.configured, code: availability.code };
		const resolvedScope = resolveMemoryScope(ctx, req);
		// `memory.read.all` is deliberately limited to browse/search/detail/history/
		// recall. Reflection always remains attached to the current project/goal.
		const scope = resolvedScope ? { ...resolvedScope, all: false } : undefined;
		const prompt = text(bodyOf(req).prompt, MAX_QUERY);
		if (!scope || !prompt) return { configured: true, code: !scope ? "HINDSIGHT_SCOPE_UNAVAILABLE" : "MEMORY_PROMPT_REQUIRED", text: "" };
		const permission = await authorize(ctx, "memory.reflect");
		if (!permission.ok) return { configured: true, code: permission.code, text: "" };
		const readPermission = await authorize(ctx, scope.all ? "memory.read.all" : "memory.read");
		if (!readPermission.ok) return { configured: true, code: readPermission.code, text: "" };
		return await withActiveClient(ctx, availability.config, async (client, config) => {
			// Reflect must preserve the authoritative read scope. Older clients expose
			// only an unscoped reflect endpoint, which is deliberately rejected rather
			// than reflecting arbitrary project memories.
			const reflect = clientMethod(client, "reflectScoped");
			if (!reflect) return { configured: true, code: "MEMORY_API_UNSUPPORTED", text: "" };
			const liveReflect = await authorize(ctx, "memory.reflect");
			if (!liveReflect.ok) return { configured: true, code: liveReflect.code, text: "" };
			const liveRead = await authorize(ctx, "memory.read");
			if (!liveRead.ok) return { configured: true, code: liveRead.code, text: "" };
			const result = await reflect(config.bank, prompt, { tags: scope.all ? undefined : scopedTags(scope), tagsMatch: "all_strict" });
			const data = record(result) ? result : {};
			const reflected = safeText(data.text, MAX_CONTENT);
			return reflected === undefined ? { configured: true, code: "MEMORY_RESPONSE_INVALID", text: "" } : { configured: true, text: reflected };
		});
	},

	detail: async (ctx: MemoryRouteContext, req: MemoryRouteRequest) => {
		const availability = await routeConfig(ctx);
		if (availability.state === "unavailable") return { configured: false, error: availability.error };
		if (availability.state === "dormant") return { configured: false };
		if (availability.state === "unhealthy") return { configured: availability.configured, code: availability.code };
		const scope = resolveMemoryScope(ctx, req);
		const id = safeId(bodyOf(req).id);
		if (!scope || !id) return { configured: true, code: !scope ? "HINDSIGHT_SCOPE_UNAVAILABLE" : "MEMORY_ID_REQUIRED" };
		const permission = await authorize(ctx, scope.all ? "memory.read.all" : "memory.read");
		if (!permission.ok) return { configured: true, code: permission.code };
		return await withActiveClient(ctx, availability.config, async (client, config) => {
			const detail = clientMethod(client, "detail");
			if (!detail) return { configured: true, code: "MEMORY_API_UNSUPPORTED" };
			const livePermission = await authorize(ctx, scope.all ? "memory.read.all" : "memory.read");
			if (!livePermission.ok) return { configured: true, code: livePermission.code };
			const result = await detail(config.bank, id);
			// Hindsight 0.8.6 detail has no tag-filter parameter. Verify the returned
			// record before serialization so an id cannot bypass the route scope.
			const memory = safeRecord(result);
			return memory && belongsToScope(result, scope) ? { configured: true, memory } : { configured: true, code: "MEMORY_NOT_FOUND" };
		});
	},

	history: async (ctx: MemoryRouteContext, req: MemoryRouteRequest) => {
		const availability = await routeConfig(ctx);
		if (availability.state === "unavailable") return { configured: false, error: availability.error, history: [] };
		if (availability.state === "dormant") return { configured: false, history: [] };
		if (availability.state === "unhealthy") return { configured: availability.configured, code: availability.code };
		const scope = resolveMemoryScope(ctx, req);
		const id = safeId(bodyOf(req).id);
		if (!scope || !id) return { configured: true, code: !scope ? "HINDSIGHT_SCOPE_UNAVAILABLE" : "MEMORY_ID_REQUIRED", history: [] };
		const permission = await authorize(ctx, scope.all ? "memory.read.all" : "memory.read");
		if (!permission.ok) return { configured: true, code: permission.code, history: [] };
		return await withActiveClient(ctx, availability.config, async (client, config) => {
			const detail = clientMethod(client, "detail");
			const history = clientMethod(client, "history");
			if (!detail || !history) return { configured: true, code: "MEMORY_API_UNSUPPORTED", history: [] };
			// The history endpoint has no tag filter in Hindsight 0.8.6. Authorize it
			// through the bounded detail record first, and re-check before each read.
			let livePermission = await authorize(ctx, scope.all ? "memory.read.all" : "memory.read");
			if (!livePermission.ok) return { configured: true, code: livePermission.code, history: [] };
			const memory = await detail(config.bank, id);
			if (!belongsToScope(memory, scope)) return { configured: true, code: "MEMORY_NOT_FOUND", history: [] };
			livePermission = await authorize(ctx, scope.all ? "memory.read.all" : "memory.read");
			if (!livePermission.ok) return { configured: true, code: livePermission.code, history: [] };
			const result = await history(config.bank, id);
			const data = record(result) ? result : {};
			return { configured: true, history: safeRows(data.history) };
		});
	},

	invalidate: async (ctx: MemoryRouteContext, req: MemoryRouteRequest) => {
		const availability = await routeConfig(ctx);
		if (availability.state === "unavailable") return { ok: false, configured: false, error: availability.error };
		if (availability.state === "dormant") return { ok: false, configured: false, code: "SERVICE_UNHEALTHY" };
		if (availability.state === "unhealthy") return { ok: false, configured: availability.configured, code: availability.code };
		const resolvedScope = resolveMemoryScope(ctx, req);
		// An invalidation is never an all-bank action; body scope cannot broaden a
		// destructive request beyond the host project/goal context.
		const scope = resolvedScope ? { ...resolvedScope, all: false } : undefined;
		const body = bodyOf(req);
		const id = safeId(body.id);
		if (!scope || !id) return { ok: false, configured: true, code: !scope ? "HINDSIGHT_SCOPE_UNAVAILABLE" : "MEMORY_ID_REQUIRED" };
		// Confirmation is deliberately exact so a stale dialog cannot invalidate a
		// newly selected record. A free-form reason remains optional metadata.
		if (body.confirmation !== id) return { ok: false, configured: true, code: "INVALIDATION_CONFIRMATION_REQUIRED", id };
		const permission = await authorize(ctx, "memory.invalidate");
		if (!permission.ok) return { ok: false, configured: true, code: permission.code, id };
		return await withActiveClient(ctx, availability.config, async (client, config) => {
			const detail = clientMethod(client, "detail");
			const invalidate = clientMethod(client, "invalidateMemory") ?? clientMethod(client, "invalidate");
			if (!detail || !invalidate) return { ok: false, configured: true, code: "MEMORY_API_UNSUPPORTED", id };
			let livePermission = await authorize(ctx, "memory.invalidate");
			if (!livePermission.ok) return { ok: false, configured: true, code: livePermission.code, id };
			if (!belongsToScope(await detail(config.bank, id), scope)) return { ok: false, configured: true, code: "MEMORY_NOT_FOUND", id };
			livePermission = await authorize(ctx, "memory.invalidate");
			if (!livePermission.ok) return { ok: false, configured: true, code: livePermission.code, id };
			await invalidate(config.bank, id, { ...(text(body.reason, 1_000) ? { reason: text(body.reason, 1_000) } : {}) });
			return { ok: true, configured: true, id };
		}, { ok: false as const, configured: true as const, code: "SERVICE_UNHEALTHY" as const });
	},

	"retain-outcome": async (ctx: MemoryRouteContext, req: MemoryRouteRequest) => {
		const availability = await routeConfig(ctx);
		if (availability.state === "unavailable") return { ok: false, configured: false, error: availability.error };
		if (availability.state === "dormant") return { ok: false, configured: false, code: "SERVICE_UNHEALTHY" };
		if (availability.state === "unhealthy") return { ok: false, configured: availability.configured, code: availability.code };
		const scope = resolveMemoryScope(ctx, req);
		if (!scope) return { ok: false, configured: true, code: "HINDSIGHT_SCOPE_UNAVAILABLE" };
		const permission = await authorize(ctx, "memory.write");
		if (!permission.ok) return { ok: false, configured: true, code: permission.code };
		// Never consume a request body outcome. The host injects the durable
		// completion envelope after resolving the session/goal, so tools cannot
		// forge content, revision, or a document identity.
		const outcome = completedOutcomeRetention(ctx.host.completedOutcome, scope, availability.config);
		if (!outcome) return { ok: false, configured: true, code: "OUTCOME_UNAVAILABLE" };
		return await withActiveClient(ctx, availability.config, async (client, config) => {
			const retain = clientMethod(client, "retain");
			const ensureBank = clientMethod(client, "ensureBank");
			if (!retain || !ensureBank) return { ok: false, configured: true, code: "MEMORY_API_UNSUPPORTED" };
			let livePermission = await authorize(ctx, "memory.write");
			if (!livePermission.ok) return { ok: false, configured: true, code: livePermission.code };
			await ensureBank(config.bank);
			livePermission = await authorize(ctx, "memory.write");
			if (!livePermission.ok) return { ok: false, configured: true, code: livePermission.code };
			await retain(config.bank, outcome.content, { tags: outcome.tags, sync: true, id: outcome.documentId });
			return { ok: true, configured: true, outcomeId: outcome.documentId };
		}, { ok: false as const, configured: true as const, code: "SERVICE_UNHEALTHY" as const });
	},
};
