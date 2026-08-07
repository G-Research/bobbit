// Hindsight pack SERVER routes. Durable reads use the host store's tri-state
// contract so an unreadable queue/config is never presented as an empty/default
// snapshot or overwritten by a route mutation.

import { memoryRoutes, type MemoryRouteHostAdapter } from "./memory-routes.js";
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
} from "./shared.js";

export { __setClientFactory } from "./shared.js";

interface RouteCtx {
	host: { store: StoreLike; memory?: MemoryRouteHostAdapter; providerConfig?: unknown; completedOutcome?: unknown };
	sessionId?: string;
	/** Authoritative host snapshot; flat projectId is compatibility-only. */
	scopeContext?: { project?: { id?: string }; goal?: { id?: string } };
	projectId?: string;
	runtime?: RuntimeContext;
	signal?: AbortSignal;
}
interface RouteReq {
	method?: string;
	query?: Record<string, string>;
	body?: unknown;
}

function isObj(v: unknown): v is Record<string, unknown> {
	return !!v && typeof v === "object" && !Array.isArray(v);
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

export const routes = {
	...memoryRoutes,
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
		const injectedConfig = ctx.host.providerConfig;
		const [configResult, queue, error] = await Promise.all([
			injectedConfig === undefined ? loadEffectiveConfig(store) : Promise.resolve({ available: true as const, config: resolveConfig(injectedConfig), overrides: {} }),
			queueStatus(store), lastError(store),
		]);
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

	banks: async (ctx: RouteCtx) => {
		const loaded = ctx.host.providerConfig === undefined
			? await loadEffectiveConfig(ctx.host.store)
			: { available: true as const, config: resolveConfig(ctx.host.providerConfig), overrides: {} };
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
