// Hindsight pack SERVER routes (Extension Platform G2.1/G2.2, external mode).
// Bundled (with the REST client inlined) to lib/routes.mjs and executed in the
// confined worker. Reached via host.callRoute(<name>); the route module is
// resolved by the pack-level RouteRegistry from the SERVER-derived packId.
//
// `ctx.host.store` is pack-scoped (server-derived packId; cross-pack reads
// rejected) and is the SAME store the provider's retry queue + diagnostics live
// in — so `status.queueDepth` / `status.lastError` observe the provider's state,
// and the `config` route persists under the key the loader overlays
// (`CONFIG_KEY`). See docs/design/hindsight-pack-external.md §6/§8.
//
// DORMANCY: when not configured (no external URL) every route returns a clean,
// structured signal (`configured:false` / empty list) rather than erroring, so the
// panel and tests get a deterministic dormant response with no network touched.

import {
	clientConfig,
	isConfigured,
	loadEffectiveConfig,
	loadQueue,
	makeClient,
	redactConfig,
	validateConfigOverrides,
	CONFIG_KEY,
	LAST_ERROR_KEY,
	type EffectiveConfig,
	type StoreLike,
	type Tags,
} from "./shared.js";

// Re-exported so API/unit tests may inject a fake client through the routes module.
export { __setClientFactory } from "./shared.js";

interface RouteCtx {
	host: { store: StoreLike };
	sessionId?: string;
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

async function queueDepth(store: StoreLike): Promise<number> {
	return (await loadQueue(store)).length;
}

async function lastError(store: StoreLike): Promise<unknown> {
	try {
		return await store.get(LAST_ERROR_KEY);
	} catch {
		return null;
	}
}

/** Auto-tags applied to a manual `retain` route call (mirrors the provider). */
function manualTags(extra: Tags | undefined): Tags {
	return { kind: "manual", ...(extra ?? {}) };
}

export const routes = {
	// GET → merged effective config (secrets redacted). SET (body present) →
	// validate against the schema + persist overrides to the pack store + return
	// the new effective config.
	config: async (ctx: RouteCtx, req: RouteReq) => {
		const store = ctx.host.store;
		const method = (req?.method ?? "GET").toUpperCase();
		const hasBody = isObj(req?.body) && Object.keys(req!.body as object).length > 0;

		if (method === "GET" || !hasBody) {
			const cfg = await loadEffectiveConfig(store);
			return { ok: true, configured: isConfigured(cfg), config: redactConfig(cfg) };
		}

		const validation = validateConfigOverrides(req!.body);
		if (!validation.ok) {
			return { ok: false, error: "CONFIG_INVALID", errors: validation.errors ?? [] };
		}
		let prev: Record<string, unknown> = {};
		try {
			const stored = await store.get(CONFIG_KEY);
			if (isObj(stored)) prev = stored;
		} catch {
			/* treat as empty */
		}
		const merged = { ...prev, ...(validation.value ?? {}) };
		await store.put(CONFIG_KEY, merged);
		const cfg = await loadEffectiveConfig(store);
		return { ok: true, configured: isConfigured(cfg), config: redactConfig(cfg) };
	},

	// Health + queue + effective-config snapshot. `healthy` is a fresh probe when
	// configured (short client timeout), else false.
	status: async (ctx: RouteCtx) => {
		const store = ctx.host.store;
		const cfg = await loadEffectiveConfig(store);
		const depth = await queueDepth(store);
		const err = await lastError(store);
		const base = {
			configured: isConfigured(cfg),
			mode: cfg.mode,
			bank: cfg.bank,
			namespace: cfg.namespace,
			recallScope: cfg.recallScope,
			autoRecall: cfg.autoRecall,
			autoRetain: cfg.autoRetain,
			queueDepth: depth,
			...(err ? { lastError: err } : {}),
		};
		if (!isConfigured(cfg)) return { ...base, healthy: false };
		let healthy = false;
		try {
			const client = await makeClient(clientConfig(cfg));
			healthy = (await client.health()).ok === true;
		} catch {
			healthy = false;
		}
		return { ...base, healthy };
	},

	// { query, scope? } → resolve bank + tags and recall. Dormant ⇒ empty.
	recall: async (ctx: RouteCtx, req: RouteReq) => {
		const store = ctx.host.store;
		const cfg = await loadEffectiveConfig(store);
		if (!isConfigured(cfg)) return { configured: false, memories: [] };
		const body = isObj(req?.body) ? req!.body : {};
		const query = strOf(body.query) ?? strOf(req?.query?.query);
		if (!query) return { configured: true, memories: [] };
		const scope = body.scope === "project" || body.scope === "all" ? body.scope : cfg.recallScope;
		const tags: Tags | undefined = scope === "project" ? { project: "current" } : undefined;
		try {
			const client = await makeClient(clientConfig(cfg));
			const res = await client.recall(cfg.bank, query, {
				maxTokens: cfg.recallBudget,
				...(tags ? { tags, tagsMatch: "any" as const } : {}),
			});
			return { configured: true, memories: res?.memories ?? [] };
		} catch (e) {
			return { configured: true, memories: [], error: String((e as { message?: unknown })?.message ?? e) };
		}
	},

	// { content, tags?, sync? } → ensureBank + retain with merged auto-tags.
	retain: async (ctx: RouteCtx, req: RouteReq) => {
		const store = ctx.host.store;
		const cfg = await loadEffectiveConfig(store);
		if (!isConfigured(cfg)) return { ok: false, configured: false };
		const body = isObj(req?.body) ? req!.body : {};
		const content = strOf(body.content);
		if (!content) return { ok: false, configured: true, error: "content is required" };
		const tags = manualTags(isObj(body.tags) ? (body.tags as Tags) : undefined);
		const sync = body.sync === true;
		try {
			const client = await makeClient(clientConfig(cfg));
			await client.ensureBank(cfg.bank);
			await client.retain(cfg.bank, content, { tags, sync });
			return { ok: true, configured: true };
		} catch (e) {
			return { ok: false, configured: true, error: String((e as { message?: unknown })?.message ?? e) };
		}
	},

	// { prompt } → reflect. Dormant ⇒ empty text.
	reflect: async (ctx: RouteCtx, req: RouteReq) => {
		const store = ctx.host.store;
		const cfg = await loadEffectiveConfig(store);
		if (!isConfigured(cfg)) return { configured: false, text: "" };
		const body = isObj(req?.body) ? req!.body : {};
		const prompt = strOf(body.prompt);
		if (!prompt) return { configured: true, text: "" };
		try {
			const client = await makeClient(clientConfig(cfg));
			const res = await client.reflect(cfg.bank, prompt);
			return { configured: true, text: res?.text ?? "" };
		} catch (e) {
			return { configured: true, text: "", error: String((e as { message?: unknown })?.message ?? e) };
		}
	},

	// Diagnostic: list banks. Dormant ⇒ empty list.
	banks: async (ctx: RouteCtx) => {
		const store = ctx.host.store;
		const cfg: EffectiveConfig = await loadEffectiveConfig(store);
		if (!isConfigured(cfg)) return { configured: false, banks: [] };
		try {
			const client = await makeClient(clientConfig(cfg));
			const res = await client.listBanks();
			return { configured: true, banks: res?.banks ?? [] };
		} catch (e) {
			return { configured: true, banks: [], error: String((e as { message?: unknown })?.message ?? e) };
		}
	},
};
