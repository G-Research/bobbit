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
//
// REACHABILITY vs CONFIGURED (managed modes): `isConfigured` is the user-facing
// "a valid deployment is selected" gate (external needs a URL; a managed mode is
// configured the moment it is picked). It is NOT a license to dial a client.
// `clientConfig` only yields a usable base URL when there is a REACHABLE data
// plane — an external URL, or a host-injected running managed runtime
// (`ctx.runtime.baseUrl`). The route ctx carries `runtime` ONLY when the host
// injected one for this call; in a managed mode with no running runtime it is
// absent and `clientConfig(cfg)` would otherwise produce an EMPTY base URL. So
// every client-touching route gates on `isActive(cfg, ctx.runtime)` (the same
// reachability gate the provider uses) and reports a deterministic
// configured-but-not-healthy / dormant state instead of issuing an empty-base
// client call. External-mode behavior is unchanged (`isActive` == `isConfigured`
// there). See docs/design/hindsight-pack-external.md §6/§8 + the P3 runtime modes.

import {
	clampRecallQuery,
	clearError,
	clientConfig,
	isActive,
	isConfigured,
	loadEffectiveConfig,
	loadQueue,
	makeClient,
	recallTagFilter,
	redactConfig,
	validateConfigOverrides,
	CONFIG_KEY,
	LAST_ERROR_KEY,
	type EffectiveConfig,
	type RuntimeContext,
	type StoreLike,
	type Tags,
} from "./shared.js";

// Re-exported so API/unit tests may inject a fake client through the routes module.
export { __setClientFactory } from "./shared.js";

interface RouteCtx {
	host: { store: StoreLike };
	sessionId?: string;
	/** The calling session's project id, supplied by the host route ctx. Used to
	 *  scope a `project` recall to the REAL project; absent ⇒ no project filter. */
	projectId?: string;
	/** Managed-runtime context injected by the host for a route call against an
	 *  ACTIVE managed Hindsight runtime (mirrors the provider's `ctx.runtime`).
	 *  Carries the locally-running managed API base URL. Absent in external mode and
	 *  whenever the managed runtime is not running — the route then reports a
	 *  deterministic dormant/not-healthy state and NEVER dials an empty base URL
	 *  (it never starts Docker). */
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

/** Auto-tags applied to a manual `retain` route call (mirrors the provider).
 *  `kind: "manual"` is spread LAST so user-supplied/scope tags stay additive but can
 *  NEVER override the manual-retain provenance marker (a user `tags: { kind: "x" }`
 *  is ignored for `kind`). */
function manualTags(extra: Tags | undefined): Tags {
	return { ...(extra ?? {}), kind: "manual" };
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

	// Health + queue + effective-config snapshot. `healthy` is a fresh probe when the
	// data plane is reachable (external URL, or a host-injected running managed
	// runtime via ctx.runtime; short client timeout), else false.
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
			// Additive (UX surfacing — existing keys unchanged): the active configured
			// values both the panel and marketplace render without a second round-trip.
			// Both URLs are NON-secret; secrets are never echoed here.
			externalUrl: cfg.externalUrl ?? "", // data-plane API URL
			uiUrl: cfg.uiUrl ?? "", // human dashboard URL (display/open-only)
			timeoutMs: cfg.timeoutMs,
			recallBudget: cfg.recallBudget,
			...(err ? { lastError: err } : {}),
		};
		// Probe health ONLY when there is a reachable data plane (an external URL, or a
		// host-injected running managed runtime). A managed mode that is configured but
		// has no running runtime reports `healthy:false` deterministically — the panel
		// renders that as "Starting" — without ever dialing an empty base URL.
		if (!isActive(cfg, ctx.runtime)) return { ...base, healthy: false };
		let healthy = false;
		try {
			const client = await makeClient(clientConfig(cfg, ctx.runtime));
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
		// Recall needs a reachable data plane. Not active (unconfigured, or a managed
		// mode with no running runtime) ⇒ a deterministic empty result that still
		// reports whether a deployment is configured, with NO empty-base client call.
		if (!isActive(cfg, ctx.runtime)) return { configured: isConfigured(cfg), memories: [] };
		const body = isObj(req?.body) ? req!.body : {};
		const query = strOf(body.query) ?? strOf(req?.query?.query);
		if (!query) return { configured: true, memories: [] };
		const scope = body.scope === "project" || body.scope === "all" ? body.scope : cfg.recallScope;
		// Scope a `project` recall to the REAL project id from the host route ctx via
		// the shared recallTagFilter: project-tagged PLUS untagged/global memories on
		// the shared bank (PROJECT_RECALL_TAGS_MATCH). When the ctx carries no project
		// (global/server-scope session) or scope is `all`, NO tag filter is applied
		// (recall the whole bank) rather than a fabricated placeholder tag.
		const filter = recallTagFilter(scope, ctx.projectId);
		// Clamp the query to avoid the data plane's 500-token "Query too long" 400.
		const clampedQuery = clampRecallQuery(query, cfg.recallMaxInputChars);
		try {
			const client = await makeClient(clientConfig(cfg, ctx.runtime));
			const res = await client.recall(cfg.bank, clampedQuery, {
				maxTokens: cfg.recallBudget,
				...(filter ? { tags: filter.tags, tagsMatch: filter.tagsMatch } : {}),
			});
			await clearError(store);
			return { configured: true, memories: res?.memories ?? [] };
		} catch (e) {
			return { configured: true, memories: [], error: String((e as { message?: unknown })?.message ?? e) };
		}
	},

	// { content, tags?, sync?, scope? } → ensureBank + retain with merged auto-tags.
	// `scope` maps to a PROJECT TAG on the single shared bank (NOT a different bank):
	//   - scope "project" + a REAL project id in the route ctx ⇒ add `project:<id>`.
	//   - scope "all" (or no project id) ⇒ no project tag fabricated from scope.
	// User-supplied `tags` stay additive and never change the bank (cfg.bank).
	retain: async (ctx: RouteCtx, req: RouteReq) => {
		const store = ctx.host.store;
		const cfg = await loadEffectiveConfig(store);
		// A manual retain needs a reachable data plane; not active ⇒ report the
		// configured surface without dialing an empty base URL.
		if (!isActive(cfg, ctx.runtime)) return { ok: false, configured: isConfigured(cfg) };
		const body = isObj(req?.body) ? req!.body : {};
		const content = strOf(body.content);
		if (!content) return { ok: false, configured: true, error: "content is required" };
		const scope = body.scope === "project" || body.scope === "all" ? body.scope : cfg.recallScope;
		const projectId = strOf(ctx.projectId);
		const projectTag: Tags | undefined = scope === "project" && projectId ? { project: projectId } : undefined;
		const userTags = isObj(body.tags) ? (body.tags as Tags) : undefined;
		const tags = manualTags({ ...(userTags ?? {}), ...(projectTag ?? {}) });
		const sync = body.sync === true;
		try {
			const client = await makeClient(clientConfig(cfg, ctx.runtime));
			await client.ensureBank(cfg.bank);
			await client.retain(cfg.bank, content, { tags, sync });
			await clearError(store);
			return { ok: true, configured: true };
		} catch (e) {
			return { ok: false, configured: true, error: String((e as { message?: unknown })?.message ?? e) };
		}
	},

	// { prompt, scope? } → reflect, with scope mapped to a tag filter on the single
	// shared bank (NOT a different bank), mirroring `recall`:
	//   - scope "project" + a REAL project id in the route ctx ⇒ filter on `project:<id>`.
	//   - scope "all" (or no project id) ⇒ no project filter (reflect over the bank).
	// Dormant ⇒ empty text.
	reflect: async (ctx: RouteCtx, req: RouteReq) => {
		const store = ctx.host.store;
		const cfg = await loadEffectiveConfig(store);
		if (!isActive(cfg, ctx.runtime)) return { configured: isConfigured(cfg), text: "" };
		const body = isObj(req?.body) ? req!.body : {};
		const prompt = strOf(body.prompt);
		if (!prompt) return { configured: true, text: "" };
		const scope = body.scope === "project" || body.scope === "all" ? body.scope : cfg.recallScope;
		// Same shared tag-scoped filter as recall: project scope ⇒ project-tagged plus
		// untagged/global; `all`/no-project ⇒ reflect over the whole bank.
		const filter = recallTagFilter(scope, ctx.projectId);
		try {
			const client = await makeClient(clientConfig(cfg, ctx.runtime));
			const res = await client.reflect(cfg.bank, prompt, filter ? { tags: filter.tags, tagsMatch: filter.tagsMatch } : undefined);
			return { configured: true, text: res?.text ?? "" };
		} catch (e) {
			return { configured: true, text: "", error: String((e as { message?: unknown })?.message ?? e) };
		}
	},

	// Diagnostic: list banks. Dormant ⇒ empty list.
	banks: async (ctx: RouteCtx) => {
		const store = ctx.host.store;
		const cfg: EffectiveConfig = await loadEffectiveConfig(store);
		if (!isActive(cfg, ctx.runtime)) return { configured: isConfigured(cfg), banks: [] };
		try {
			const client = await makeClient(clientConfig(cfg, ctx.runtime));
			const res = await client.listBanks();
			return { configured: true, banks: res?.banks ?? [] };
		} catch (e) {
			return { configured: true, banks: [], error: String((e as { message?: unknown })?.message ?? e) };
		}
	},
};
