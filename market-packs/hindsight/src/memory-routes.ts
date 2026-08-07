// Typed Hindsight memory route adapters. Authority, settings, and service lifecycle
// remain host-owned: this module accepts only the host-resolved scope/runtime and
// asks the EP-6 adapter for an exact, live capability before a data-plane call.

import {
	clientConfig,
	isActive,
	isConfigured,
	loadEffectiveConfig,
	makeClient,
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
	/** Durable goal-completion writer supplied by the host lifecycle boundary. */
	retainOutcome?(input: { scope: MemoryScope; outcome: unknown }): Promise<{ ok: boolean; outcomeId?: string; code?: string }>;
}

export interface MemoryRouteContext {
	host: { store: StoreLike; memory?: MemoryRouteHostAdapter };
	scopeContext?: { project?: { id?: string }; goal?: { id?: string } };
	runtime?: RuntimeContext;
	/** Host-built, bounded completion snapshot; request bodies never provide this. */
	outcome?: unknown;
}

export type MemoryScope = { projectId: string; goalId?: string; all: boolean };

const MAX_QUERY = 4_000;
const MAX_CONTENT = 16_000;
const MAX_CURSOR = 512;
const MAX_ID = 512;
const MAX_LIMIT = 100;

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
		if (decision?.allowed === true) return { ok: true };
		return { ok: false, code: decision?.reason === "denied" ? "EXTENSION_CAPABILITY_DENIED" : "EXTENSION_CAPABILITY_REQUIRED" };
	} catch {
		return { ok: false, code: "EXTENSION_CAPABILITY_REQUIRED" };
	}
}

function scopedTags(scope: MemoryScope): Tags {
	return { project: scope.projectId, ...(scope.goalId ? { goal: scope.goalId } : {}) };
}

function inactive(configured: boolean) {
	return { configured, code: "SERVICE_UNHEALTHY" };
}

function clientMethod(client: unknown, name: string): ((...args: unknown[]) => Promise<unknown>) | undefined {
	if (!record(client)) return undefined;
	const method = client[name];
	return typeof method === "function" ? method.bind(client) as (...args: unknown[]) => Promise<unknown> : undefined;
}

/** New read endpoints use the expanded client protocol when present. The legacy
 * client never had browse/detail/history, so fail closed instead of fabricating
 * an empty bank or falling back to a different endpoint. */
async function withActiveClient<T>(
	ctx: MemoryRouteContext,
	work: (client: unknown, config: EffectiveConfig) => Promise<T>,
): Promise<T | { configured: boolean; code: string }> {
	const loaded = await loadEffectiveConfig(ctx.host.store);
	if (!loaded.available) return { configured: false, code: "HINDSIGHT_CONFIG_UNAVAILABLE" };
	if (!isActive(loaded.config, ctx.runtime)) return inactive(isConfigured(loaded.config));
	try {
		return await work(await makeClient(clientConfig(loaded.config, ctx.runtime)), loaded.config);
	} catch {
		return { configured: true, code: "SERVICE_UNHEALTHY" };
	}
}

async function readRows(ctx: MemoryRouteContext, req: MemoryRouteRequest) {
	const scope = resolveMemoryScope(ctx, req);
	if (!scope) return { configured: true, code: "HINDSIGHT_SCOPE_UNAVAILABLE", memories: [] };
	const permission = await authorize(ctx, scope.all ? "memory.read.all" : "memory.read");
	if (!permission.ok) return { configured: true, code: permission.code, memories: [] };
	const body = bodyOf(req);
	const query = text(body.query ?? req.query?.query, MAX_QUERY);
	const cursor = text(body.cursor, MAX_CURSOR);
	const limit = number(body.limit, 25);
	return await withActiveClient(ctx, async (client, config) => {
		const browse = clientMethod(client, "browse");
		if (!browse) return { configured: true, code: "MEMORY_API_UNSUPPORTED", memories: [] };
		const result = await browse(config.bank, { query, cursor, limit, tags: scope.all ? undefined : scopedTags(scope), tagsMatch: "all_strict" });
		const data = record(result) ? result : {};
		return {
			configured: true,
			memories: Array.isArray(data.memories) ? data.memories : [],
			...(text(data.cursor, MAX_CURSOR) ? { cursor: text(data.cursor, MAX_CURSOR) } : {}),
		};
	});
}

export const memoryRoutes = {
	browse: readRows,
	search: readRows,

	detail: async (ctx: MemoryRouteContext, req: MemoryRouteRequest) => {
		const scope = resolveMemoryScope(ctx, req);
		const id = safeId(bodyOf(req).id);
		if (!scope || !id) return { configured: true, code: !scope ? "HINDSIGHT_SCOPE_UNAVAILABLE" : "MEMORY_ID_REQUIRED" };
		const permission = await authorize(ctx, scope.all ? "memory.read.all" : "memory.read");
		if (!permission.ok) return { configured: true, code: permission.code };
		return await withActiveClient(ctx, async (client, config) => {
			const detail = clientMethod(client, "detail");
			if (!detail) return { configured: true, code: "MEMORY_API_UNSUPPORTED" };
			const result = await detail(config.bank, id, { tags: scope.all ? undefined : scopedTags(scope), tagsMatch: "all_strict" });
			return record(result) ? { configured: true, memory: result } : { configured: true, code: "MEMORY_NOT_FOUND" };
		});
	},

	history: async (ctx: MemoryRouteContext, req: MemoryRouteRequest) => {
		const scope = resolveMemoryScope(ctx, req);
		const id = safeId(bodyOf(req).id);
		if (!scope || !id) return { configured: true, code: !scope ? "HINDSIGHT_SCOPE_UNAVAILABLE" : "MEMORY_ID_REQUIRED", history: [] };
		const permission = await authorize(ctx, scope.all ? "memory.read.all" : "memory.read");
		if (!permission.ok) return { configured: true, code: permission.code, history: [] };
		return await withActiveClient(ctx, async (client, config) => {
			const history = clientMethod(client, "history");
			if (!history) return { configured: true, code: "MEMORY_API_UNSUPPORTED", history: [] };
			const result = await history(config.bank, id, { tags: scope.all ? undefined : scopedTags(scope), tagsMatch: "all_strict" });
			const data = record(result) ? result : {};
			return { configured: true, history: Array.isArray(data.history) ? data.history : [] };
		});
	},

	invalidate: async (ctx: MemoryRouteContext, req: MemoryRouteRequest) => {
		const scope = resolveMemoryScope(ctx, req);
		const body = bodyOf(req);
		const id = safeId(body.id);
		if (!scope || !id) return { ok: false, configured: true, code: !scope ? "HINDSIGHT_SCOPE_UNAVAILABLE" : "MEMORY_ID_REQUIRED" };
		// Confirmation is deliberately exact so a stale dialog cannot invalidate a
		// newly selected record. A free-form reason remains optional metadata.
		if (body.confirmation !== id) return { ok: false, configured: true, code: "INVALIDATION_CONFIRMATION_REQUIRED", id };
		const permission = await authorize(ctx, "memory.invalidate");
		if (!permission.ok) return { ok: false, configured: true, code: permission.code, id };
		return await withActiveClient(ctx, async (client, config) => {
			const invalidate = clientMethod(client, "invalidateMemory") ?? clientMethod(client, "invalidate");
			if (!invalidate) return { ok: false, configured: true, code: "MEMORY_API_UNSUPPORTED", id };
			await invalidate(config.bank, id, { tags: scopedTags(scope), tagsMatch: "all_strict", ...(text(body.reason, 1_000) ? { reason: text(body.reason, 1_000) } : {}) });
			return { ok: true, configured: true, id };
		});
	},

	"retain-outcome": async (ctx: MemoryRouteContext, req: MemoryRouteRequest) => {
		const scope = resolveMemoryScope(ctx, req);
		if (!scope) return { ok: false, configured: true, code: "HINDSIGHT_SCOPE_UNAVAILABLE" };
		const permission = await authorize(ctx, "memory.write");
		if (!permission.ok) return { ok: false, configured: true, code: permission.code };
		// The durable lifecycle boundary supplies the snapshot. Never consume a body
		// outcome: that would let a tool forge another project's completed record.
		if (ctx.outcome === undefined || !ctx.host.memory?.retainOutcome) return { ok: false, configured: true, code: "OUTCOME_UNAVAILABLE" };
		try {
			const result = await ctx.host.memory.retainOutcome({ scope, outcome: ctx.outcome });
			return result.ok ? { ok: true, ...(result.outcomeId ? { outcomeId: result.outcomeId } : {}) } : { ok: false, code: result.code ?? "OUTCOME_NOT_DURABLE" };
		} catch {
			return { ok: false, code: "OUTCOME_NOT_DURABLE" };
		}
	},
};
