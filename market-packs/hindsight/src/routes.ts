// Hindsight pack SERVER routes. Durable reads use the host store's tri-state
// contract so an unreadable queue/config is never presented as an empty/default
// snapshot or overwritten by a route mutation.

import {
	clientConfig,
	isActive,
	isConfigured,
	loadEffectiveConfig,
	loadQueue,
	makeClient,
	redactConfig,
	readStore,
	resolveConfig,
	validateConfigOverrides,
	CONFIG_DEFAULTS,
	CONFIG_KEY,
	LAST_ERROR_KEY,
	type EffectiveConfig,
	type RuntimeContext,
	type StoreLike,
	type StoreReadDiagnostic,
	type Tags,
} from "./shared.js";

export { __setClientFactory } from "./shared.js";

interface RouteCtx {
	host: { store: StoreLike };
	sessionId?: string;
	/** Authoritative host snapshot; flat projectId is compatibility-only. */
	scopeContext?: { project?: { id?: string }; goal?: { id?: string } };
	projectId?: string;
	runtime?: RuntimeContext;
}
interface RouteReq {
	method?: string;
	query?: Record<string, string>;
	body?: unknown;
}

function isObj(v: unknown): v is Record<string, unknown> {
	return !!v && typeof v === "object" && !Array.isArray(v);
}

function strOf(v: unknown): string | undefined {
	return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}

/** Keep externally visible durable-store diagnostics stable, useful, and free of
 * implementation details (including paths or original error messages). */
function safeDiagnostic(diagnostic: StoreReadDiagnostic): StoreReadDiagnostic {
	return {
		code: diagnostic.code,
		...(diagnostic.retryable === true ? { retryable: true } : {}),
		...(diagnostic.recoverable === true ? { recoverable: true } : {}),
	};
}

async function queueStatus(store: StoreLike): Promise<{ queueDepth: number | null; queueState: "available" | "unavailable"; queueError?: StoreReadDiagnostic }> {
	const result = await loadQueue(store);
	return result.loaded
		? { queueDepth: result.queue.length, queueState: "available" }
		: { queueDepth: null, queueState: "unavailable", queueError: safeDiagnostic(result.diagnostic) };
}

async function lastError(store: StoreLike): Promise<{ value?: unknown; unavailable?: StoreReadDiagnostic }> {
	const result = await readStore<unknown>(store, LAST_ERROR_KEY);
	if (result.state === "present") return { value: result.value };
	if (result.state === "error") return { unavailable: safeDiagnostic(result.diagnostic) };
	return {};
}

function configUnavailable(diagnostic: StoreReadDiagnostic): { ok: false; error: "HINDSIGHT_CONFIG_UNAVAILABLE"; diagnostic: StoreReadDiagnostic } {
	return { ok: false, error: "HINDSIGHT_CONFIG_UNAVAILABLE", diagnostic: safeDiagnostic(diagnostic) };
}

function routeConfigUnavailable(diagnostic: StoreReadDiagnostic) {
	return { configured: false, error: "HINDSIGHT_CONFIG_UNAVAILABLE", diagnostic: safeDiagnostic(diagnostic) };
}

function manualTags(extra: Tags | undefined): Tags {
	const { project: _project, goal: _goal, ...safe } = extra ?? {};
	return { kind: "manual", ...safe };
}

export const routes = {
	config: async (ctx: RouteCtx, req: RouteReq) => {
		const store = ctx.host.store;
		const method = (req?.method ?? "GET").toUpperCase();
		const hasBody = isObj(req?.body) && Object.keys(req!.body as object).length > 0;
		const loaded = await loadEffectiveConfig(store);
		if (!loaded.available) return configUnavailable(loaded.diagnostic);

		if (method === "GET" || !hasBody) {
			return { ok: true, configured: isConfigured(loaded.config), config: redactConfig(loaded.config) };
		}

		const validation = validateConfigOverrides(req!.body);
		if (!validation.ok) return { ok: false, error: "CONFIG_INVALID", errors: validation.errors ?? [] };
		const overrides = { ...loaded.overrides, ...(validation.value ?? {}) };
		await store.put(CONFIG_KEY, overrides);
		const config = resolveConfig({ ...CONFIG_DEFAULTS, ...overrides });
		return { ok: true, configured: isConfigured(config), config: redactConfig(config) };
	},

	status: async (ctx: RouteCtx) => {
		const store = ctx.host.store;
		const [configResult, queue, error] = await Promise.all([loadEffectiveConfig(store), queueStatus(store), lastError(store)]);
		if (!configResult.available) {
			return {
				...routeConfigUnavailable(configResult.diagnostic),
				healthy: false,
				...queue,
				...(error.unavailable ? { lastErrorUnavailable: error.unavailable } : {}),
			};
		}
		const cfg = configResult.config;
		const base = {
			configured: isConfigured(cfg),
			runtimeMode: cfg.runtimeMode,
			bank: cfg.bank,
			namespace: cfg.namespace,
			recallScope: cfg.recallScope,
			autoRecall: cfg.autoRecall,
			autoRetain: cfg.autoRetain,
			...queue,
			...(error.value ? { lastError: error.value } : {}),
			...(error.unavailable ? { lastErrorUnavailable: error.unavailable } : {}),
		};
		if (!isActive(cfg, ctx.runtime)) return { ...base, healthy: false };
		try {
			const client = await makeClient(clientConfig(cfg, ctx.runtime));
			return { ...base, healthy: (await client.health()).ok === true };
		} catch {
			return { ...base, healthy: false };
		}
	},

	recall: async (ctx: RouteCtx, req: RouteReq) => {
		const loaded = await loadEffectiveConfig(ctx.host.store);
		if (!loaded.available) return { ...routeConfigUnavailable(loaded.diagnostic), memories: [] };
		const cfg = loaded.config;
		if (!isActive(cfg, ctx.runtime)) return { configured: isConfigured(cfg), memories: [] };
		const body = isObj(req?.body) ? req!.body : {};
		const query = strOf(body.query) ?? strOf(req?.query?.query);
		if (!query) return { configured: true, memories: [] };
		// Route bodies and legacy flat fields cannot choose or broaden a scope.
		const projectId = strOf(ctx.scopeContext?.project?.id);
		if (!projectId) return { configured: true, memories: [] };
		const goalId = strOf(ctx.scopeContext?.goal?.id);
		const tags: Tags = { project: projectId, ...(goalId ? { goal: goalId } : {}) };
		try {
			const client = await makeClient(clientConfig(cfg, ctx.runtime));
			const res = await client.recall(cfg.bank, query, { maxTokens: cfg.recallBudget, tags, tagsMatch: "all_strict" as const });
			return { configured: true, memories: res?.memories ?? [] };
		} catch (e) {
			return { configured: true, memories: [], error: String((e as { message?: unknown })?.message ?? e) };
		}
	},

	retain: async (ctx: RouteCtx, req: RouteReq) => {
		const loaded = await loadEffectiveConfig(ctx.host.store);
		if (!loaded.available) return { ...configUnavailable(loaded.diagnostic), configured: false };
		const cfg = loaded.config;
		if (!isActive(cfg, ctx.runtime)) return { ok: false, configured: isConfigured(cfg) };
		const body = isObj(req?.body) ? req!.body : {};
		const content = strOf(body.content);
		if (!content) return { ok: false, configured: true, error: "content is required" };
		const projectId = strOf(ctx.scopeContext?.project?.id);
		if (!projectId) return { ok: false, configured: true, error: "HINDSIGHT_SCOPE_UNAVAILABLE" };
		const goalId = strOf(ctx.scopeContext?.goal?.id);
		try {
			const client = await makeClient(clientConfig(cfg, ctx.runtime));
			await client.ensureBank(cfg.bank);
			await client.retain(cfg.bank, content, { tags: { ...manualTags(isObj(body.tags) ? (body.tags as Tags) : undefined), project: projectId, ...(goalId ? { goal: goalId } : {}) }, sync: body.sync === true });
			return { ok: true, configured: true };
		} catch (e) {
			return { ok: false, configured: true, error: String((e as { message?: unknown })?.message ?? e) };
		}
	},

	reflect: async (ctx: RouteCtx, req: RouteReq) => {
		const loaded = await loadEffectiveConfig(ctx.host.store);
		if (!loaded.available) return { ...routeConfigUnavailable(loaded.diagnostic), text: "" };
		const cfg = loaded.config;
		if (!isActive(cfg, ctx.runtime)) return { configured: isConfigured(cfg), text: "" };
		const body = isObj(req?.body) ? req!.body : {};
		const prompt = strOf(body.prompt);
		if (!prompt) return { configured: true, text: "" };
		try {
			const client = await makeClient(clientConfig(cfg, ctx.runtime));
			return { configured: true, text: (await client.reflect(cfg.bank, prompt))?.text ?? "" };
		} catch (e) {
			return { configured: true, text: "", error: String((e as { message?: unknown })?.message ?? e) };
		}
	},

	banks: async (ctx: RouteCtx) => {
		const loaded = await loadEffectiveConfig(ctx.host.store);
		if (!loaded.available) return { ...routeConfigUnavailable(loaded.diagnostic), banks: [] };
		const cfg: EffectiveConfig = loaded.config;
		if (!isActive(cfg, ctx.runtime)) return { configured: isConfigured(cfg), banks: [] };
		try {
			const client = await makeClient(clientConfig(cfg, ctx.runtime));
			return { configured: true, banks: (await client.listBanks())?.banks ?? [] };
		} catch (e) {
			return { configured: true, banks: [], error: String((e as { message?: unknown })?.message ?? e) };
		}
	},
};
