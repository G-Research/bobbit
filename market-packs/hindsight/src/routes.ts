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
	applyBankMission,
	clampRecallQuery,
	clearError,
	clientConfig,
	isActive,
	isConfigured,
	isQueryTooLongError,
	loadEffectiveConfig,
	loadProjectOverride,
	loadQueue,
	makeClient,
	projectConfigKey,
	recallTagFilter,
	redactConfig,
	validateConfigOverrides,
	validateProjectOverride,
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

function numOrStringOf(v: unknown): string | undefined {
	if (typeof v === "number" && Number.isFinite(v)) return String(v);
	return strOf(v);
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return isObj(v);
}

const FACT_TYPES = new Set(["observation", "world", "experience"]);

function factTypesOf(v: unknown): Array<"observation" | "world" | "experience"> | undefined {
	if (!Array.isArray(v)) return undefined;
	const out = v.filter((x): x is "observation" | "world" | "experience" => typeof x === "string" && FACT_TYPES.has(x));
	return out.length > 0 ? [...new Set(out)] : undefined;
}

function queryTimestampOf(body: Record<string, unknown>, cfg: EffectiveConfig): string | undefined {
	if (body.queryTimestamp === false || body.queryTimestamp === null) return undefined;
	const explicit = strOf(body.queryTimestamp);
	if (explicit) return explicit;
	if ((cfg as unknown as { recallQueryTimestampEnabled?: boolean }).recallQueryTimestampEnabled === false) return undefined;
	return new Date().toISOString();
}

const BOBBIT_REFLECT_INSTRUCTION = [
	"Bobbit coding-agent memory reflection instructions:",
	"- Prefer durable project facts, decisions, conventions, and recent outcomes over transient turn noise.",
	"- Answer for a coding agent working in the repository; be concise, concrete, and cite source facts when Hindsight includes them.",
	"- Do not invent facts that are not supported by memory.",
].join("\n");

function reflectPrompt(prompt: string, cfg: EffectiveConfig, body: Record<string, unknown>): string {
	// Bank-wide directives are disabled by default for shared banks. Until scoped
	// directive semantics are verified, keep Bobbit-specific behaviour per-request.
	if (body.bobbitInstruction === false) return prompt;
	if ((cfg as unknown as { directivesEnabled?: boolean }).directivesEnabled === true) return prompt;
	return `${BOBBIT_REFLECT_INSTRUCTION}\n\nUser query:\n${prompt}`;
}

interface EntityInput { text: string; type?: string }

function entityListOf(v: unknown): EntityInput[] {
	if (!Array.isArray(v)) return [];
	const out: EntityInput[] = [];
	for (const item of v) {
		if (!isObj(item)) continue;
		const text = strOf(item.text);
		if (!text) continue;
		const type = strOf(item.type);
		out.push({ text, ...(type ? { type } : {}) });
	}
	return out;
}

function stringsOf(v: unknown): string[] {
	return Array.isArray(v) ? v.map(strOf).filter((x): x is string => !!x) : [];
}

function outcomeEntities(body: Record<string, unknown>): EntityInput[] {
	const entities = entityListOf(body.entities);
	for (const file of stringsOf(body.files)) entities.push({ text: file, type: "file" });
	for (const component of stringsOf(body.components)) entities.push({ text: component, type: "component" });
	return entities;
}

function outcomeTags(body: Record<string, unknown>, projectId?: string): Tags {
	const extra = isObj(body.tags) ? (body.tags as Tags) : {};
	const goalId = strOf(body.goalId);
	const pr = numOrStringOf(body.pr);
	return {
		...extra,
		...(projectId ? { project: projectId } : {}),
		...(goalId ? { goal: goalId } : {}),
		...(pr ? { pr } : {}),
		bobbit: "true",
		kind: "outcome",
	};
}

function projectObservationScopes(projectId?: string): string[][] | undefined {
	const pid = strOf(projectId);
	return pid ? [[`project:${pid}`]] : undefined;
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

/** Per-project config metadata for the GET/SET config surface. Returns the global
 *  (no-overlay) effective config and the raw stored project overlay (or null) when
 *  a project context is present; otherwise an empty object. */
async function configMeta(store: StoreLike, projectId?: string): Promise<Record<string, unknown>> {
	if (!projectId) return {};
	const globalCfg = await loadEffectiveConfig(store);
	const projectOverride = await loadProjectOverride(store, projectId);
	return { globalConfig: redactConfig(globalCfg), projectOverride: projectOverride ?? null };
}

export const routes = {
	// GET → merged effective config (secrets redacted). SET (body present) →
	// validate against the schema + persist overrides to the pack store + return
	// the new effective config.
	config: async (ctx: RouteCtx, req: RouteReq) => {
		const store = ctx.host.store;
		const projectId = strOf(ctx.projectId);
		const method = (req?.method ?? "GET").toUpperCase();
		const hasBody = isObj(req?.body) && Object.keys(req!.body as object).length > 0;

		if (method === "GET" || !hasBody) {
			const cfg = await loadEffectiveConfig(store, projectId);
			return { ok: true, configured: isConfigured(cfg), config: redactConfig(cfg), ...(await configMeta(store, projectId)) };
		}

		const body = req!.body as Record<string, unknown>;

		// Per-project overlay write (safe memory-quality keys only). A full-replace:
		// the validated overlay REPLACES the stored one (omitted/cleared keys are
		// dropped ⇒ inherit global). Requires a project context.
		if ("projectOverride" in body) {
			if (!projectId) return { ok: false, error: "NO_PROJECT", errors: ["projectOverride requires a project context"] };
			const validation = validateProjectOverride(body.projectOverride);
			if (!validation.ok) return { ok: false, error: "CONFIG_INVALID", errors: validation.errors ?? [] };
			await store.put(projectConfigKey(projectId), validation.value ?? {});
			const cfg = await loadEffectiveConfig(store, projectId);
			return { ok: true, configured: isConfigured(cfg), config: redactConfig(cfg), ...(await configMeta(store, projectId)) };
		}

		// Global write (server-scope), merged over the stored global config.
		const validation = validateConfigOverrides(body);
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
		const cfg = await loadEffectiveConfig(store, projectId);
		return { ok: true, configured: isConfigured(cfg), config: redactConfig(cfg), ...(await configMeta(store, projectId)) };
	},

	// Health + queue + effective-config snapshot. `healthy` is a fresh probe when the
	// data plane is reachable (external URL, or a host-injected running managed
	// runtime via ctx.runtime; short client timeout), else false.
	status: async (ctx: RouteCtx) => {
		const store = ctx.host.store;
		const projectId = strOf(ctx.projectId);
		const cfg = await loadEffectiveConfig(store, projectId);
		const projectOverride = projectId ? await loadProjectOverride(store, projectId) : undefined;
		const depth = await queueDepth(store);
		const err = await lastError(store);
		const base = {
			configured: isConfigured(cfg),
			mode: cfg.mode,
			bank: cfg.bank,
			namespace: cfg.namespace,
			recallScope: cfg.recallScope,
			tagsMatch: cfg.tagsMatch,
			autoRecall: cfg.autoRecall,
			autoRetain: cfg.autoRetain,
			retainEveryNTurns: cfg.retainEveryNTurns,
			retainMaxDelayMs: cfg.retainMaxDelayMs,
			retainOverlapTurns: cfg.retainOverlapTurns,
			// Per-project override indicator for the panel/marketplace status row.
			projectOverrideActive: !!projectOverride,
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
		const cfg = await loadEffectiveConfig(store, strOf(ctx.projectId));
		// Recall needs a reachable data plane. Not active (unconfigured, or a managed
		// mode with no running runtime) ⇒ a deterministic empty result that still
		// reports whether a deployment is configured, with NO empty-base client call.
		if (!isActive(cfg, ctx.runtime)) return { configured: isConfigured(cfg), memories: [] };
		const body = isObj(req?.body) ? req!.body : {};
		const query = strOf(body.query) ?? strOf(req?.query?.query);
		if (!query) return { configured: true, memories: [] };
		const scope = body.scope === "project" || body.scope === "all" ? body.scope : cfg.recallScope;
		// Scope a `project` recall to the REAL project id from the host route ctx via
		// the shared recallTagFilter: project-tagged PLUS (tagsMatch `any`) untagged/
		// global memories on the shared bank. `all`/no-project ⇒ no fabricated project
		// tag. An optional `tags` map is a simple additive targeted filter (no DSL).
		const extraTags = isObj(body.tags) ? (body.tags as Tags) : undefined;
		const filter = recallTagFilter(scope, ctx.projectId, cfg.tagsMatch, extraTags);
		// Clamp the query to avoid the data plane's 500-token "Query too long" 400.
		const clampedQuery = clampRecallQuery(query, cfg.recallMaxInputChars);
		try {
			const client = await makeClient(clientConfig(cfg, ctx.runtime));
			const queryTimestamp = queryTimestampOf(body as Record<string, unknown>, cfg);
			const res = await client.recall(cfg.bank, clampedQuery, {
				maxTokens: cfg.recallBudget,
				types: cfg.recallTypes,
				...(queryTimestamp ? { queryTimestamp } : {}),
				...(filter ? { tags: filter.tags, tagsMatch: filter.tagsMatch } : {}),
			} as never);
			await clearError(store);
			return { configured: true, memories: res?.memories ?? [] };
		} catch (e) {
			// The data plane's 500-token "Query too long" 400 is a SOFT skip: return a
			// clean empty result with NO `error` field and clear any prior sticky error,
			// so the panel/marketplace banner can never reappear from this cause (the
			// token-safe clamp should already prevent it). Genuine errors still surface.
			if (isQueryTooLongError(e)) {
				await clearError(store);
				return { configured: true, memories: [] };
			}
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
		const projectId = strOf(ctx.projectId);
		const cfg = await loadEffectiveConfig(store, projectId);
		// A manual retain needs a reachable data plane; not active ⇒ report the
		// configured surface without dialing an empty base URL.
		if (!isActive(cfg, ctx.runtime)) return { ok: false, configured: isConfigured(cfg) };
		const body = isObj(req?.body) ? req!.body : {};
		const content = strOf(body.content);
		if (!content) return { ok: false, configured: true, error: "content is required" };
		const scope = body.scope === "project" || body.scope === "all" ? body.scope : cfg.recallScope;
		const projectTag: Tags | undefined = scope === "project" && projectId ? { project: projectId } : undefined;
		const userTags = isObj(body.tags) ? (body.tags as Tags) : undefined;
		const tags = manualTags({ ...(userTags ?? {}), ...(projectTag ?? {}) });
		const sync = body.sync === true;
		try {
			const client = await makeClient(clientConfig(cfg, ctx.runtime));
			await client.ensureBank(cfg.bank);
			await applyBankMission(store, client, cfg);
			await client.retain(cfg.bank, content, { tags, sync });
			await clearError(store);
			return { ok: true, configured: true };
		} catch (e) {
			return { ok: false, configured: true, error: String((e as { message?: unknown })?.message ?? e) };
		}
	},

	// Dedicated outcome-digest retain route. It is intentionally stricter than the
	// manual `retain` route: stable document id, replace semantics, async write,
	// canonical outcome tags, optional file/component entities, and project
	// observation scopes when the host provides a real project id.
	retainOutcome: async (ctx: RouteCtx, req: RouteReq) => {
		const store = ctx.host.store;
		const projectId = strOf(ctx.projectId);
		const cfg = await loadEffectiveConfig(store, projectId);
		if (!isActive(cfg, ctx.runtime)) return { ok: false, configured: isConfigured(cfg) };
		const body = isObj(req?.body) ? req!.body : {};
		const content = strOf(body.content);
		if (!content) return { ok: false, configured: true, error: "content is required" };
		const goalId = strOf(body.goalId);
		const pr = numOrStringOf(body.pr);
		const documentId = goalId ? `outcome:${goalId}` : pr ? `outcome:pr:${pr}` : undefined;
		if (!documentId) return { ok: false, configured: true, error: "goalId or pr is required" };
		const timestamp = strOf(body.timestamp) ?? new Date().toISOString();
		const entities = outcomeEntities(body as Record<string, unknown>);
		try {
			const client = await makeClient(clientConfig(cfg, ctx.runtime));
			await client.ensureBank(cfg.bank);
			await applyBankMission(store, client, cfg);
			await client.retain(cfg.bank, content, {
				tags: outcomeTags(body as Record<string, unknown>, projectId),
				sync: false,
				documentId,
				updateMode: "replace",
				timestamp,
				...(entities.length > 0 ? { entities } : {}),
				...(projectObservationScopes(projectId) ? { observationScopes: projectObservationScopes(projectId) } : {}),
			} as never);
			await clearError(store);
			return { ok: true, configured: true, documentId };
		} catch (e) {
			return { ok: false, configured: true, error: String((e as { message?: unknown })?.message ?? e), documentId };
		}
	},

	// { prompt, scope? } → reflect, with scope mapped to a tag filter on the single
	// shared bank (NOT a different bank), mirroring `recall`:
	//   - scope "project" + a REAL project id in the route ctx ⇒ filter on `project:<id>`.
	//   - scope "all" (or no project id) ⇒ no project filter (reflect over the bank).
	// Dormant ⇒ empty text.
	reflect: async (ctx: RouteCtx, req: RouteReq) => {
		const store = ctx.host.store;
		const cfg = await loadEffectiveConfig(store, strOf(ctx.projectId));
		if (!isActive(cfg, ctx.runtime)) return { configured: isConfigured(cfg), text: "" };
		const body = isObj(req?.body) ? req!.body : {};
		const prompt = strOf(body.prompt);
		if (!prompt) return { configured: true, text: "" };
		const scope = body.scope === "project" || body.scope === "all" ? body.scope : cfg.recallScope;
		// Same shared tag-scoped filter as recall: project scope ⇒ project-tagged plus
		// (tagsMatch `any`) untagged/global; `all`/no-project ⇒ reflect over the whole
		// bank. An optional `tags` map is a simple additive targeted filter (no DSL).
		const extraTags = isObj(body.tags) ? (body.tags as Tags) : undefined;
		const filter = recallTagFilter(scope, ctx.projectId, cfg.tagsMatch, extraTags);
		const responseSchema = isRecord(body.responseSchema) ? body.responseSchema : undefined;
		const factTypes = factTypesOf(body.factTypes);
		try {
			const client = await makeClient(clientConfig(cfg, ctx.runtime));
			const res = await client.reflect(cfg.bank, reflectPrompt(prompt, cfg, body as Record<string, unknown>), {
				...(filter ? { tags: filter.tags, tagsMatch: filter.tagsMatch } : {}),
				...(responseSchema ? { responseSchema } : {}),
				...(factTypes ? { factTypes } : {}),
				...(typeof body.excludeMentalModels === "boolean" ? { excludeMentalModels: body.excludeMentalModels } : {}),
				...(strOf(body.budget) ? { budget: strOf(body.budget) } : {}),
				...(typeof body.maxTokens === "number" && Number.isFinite(body.maxTokens) ? { maxTokens: body.maxTokens } : {}),
			} as never);
			return { configured: true, text: res?.text ?? "", ...("structuredOutput" in (res ?? {}) ? { structuredOutput: (res as { structuredOutput?: unknown }).structuredOutput } : {}) };
		} catch (e) {
			return { configured: true, text: "", error: String((e as { message?: unknown })?.message ?? e) };
		}
	},

	// Minimal reversible curation route. Agents can invalidate a stale/incorrect
	// memory but cannot permanently delete it; revert remains manual/direct API.
	invalidate: async (ctx: RouteCtx, req: RouteReq) => {
		const store = ctx.host.store;
		const cfg = await loadEffectiveConfig(store, strOf(ctx.projectId));
		if (!isActive(cfg, ctx.runtime)) return { ok: false, configured: isConfigured(cfg) };
		const body = isObj(req?.body) ? req!.body : {};
		const id = strOf(body.id);
		const reason = strOf(body.reason);
		if (!id) return { ok: false, configured: true, error: "id is required" };
		if (!reason) return { ok: false, configured: true, error: "reason is required" };
		try {
			const client = await makeClient(clientConfig(cfg, ctx.runtime));
			const invalidateMemory = (client as unknown as { invalidateMemory?: (bank: string, id: string, reason: string) => Promise<void> }).invalidateMemory;
			if (typeof invalidateMemory !== "function") throw new Error("Hindsight client does not support memory invalidation");
			await invalidateMemory.call(client, cfg.bank, id, reason);
			await clearError(store);
			return { ok: true, configured: true, id };
		} catch (e) {
			return { ok: false, configured: true, error: String((e as { message?: unknown })?.message ?? e), id };
		}
	},

	// Diagnostic: list banks. Dormant ⇒ empty list.
	banks: async (ctx: RouteCtx) => {
		const store = ctx.host.store;
		const cfg: EffectiveConfig = await loadEffectiveConfig(store, strOf(ctx.projectId));
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
