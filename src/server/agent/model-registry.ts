/**
 * Unified Model Registry — single server-side source of truth for all available models.
 *
 * Assembles a merged model list from:
 * 1. Built-in providers (from pi-ai getBuiltinProviders()/getBuiltinModels())
 * 2. AI Gateway models (if configured, live fetch via discoverAigwModels())
 * 3. Custom local providers (Ollama, LM Studio, vLLM, llama.cpp)
 *
 * Served via GET /api/models with a 5-second TTL cache.
 */

import fs from "node:fs";
import http from "node:http";
import https from "node:https";
// Pi 0.81 also exposes provider-scoped `Models` with async catalog refresh/auth.
// Bobbit intentionally stays on these synchronous static-catalog reads: its own
// registry composes that snapshot with AI Gateway and local-provider discovery,
// while credential refresh remains owned by the spawned coding-agent runtime.
import { getBuiltinProviders, getBuiltinModels, getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import type { PreferencesStore } from "./preferences-store.js";
import { globalAuthPath } from "../bobbit-dir.js";
import { inferMeta, discoverAigwModels, getAigwUrl } from "./aigw-manager.js";
import { getOpenAIModelAdditions } from "./openai-model-additions.js";
import { getGoogleCodeAssistModels } from "./google-code-assist-models.js";
import { GOOGLE_GEMINI_CLI_PROVIDER, hasGoogleCodeAssistSpawnCredential } from "./google-code-assist.js";

// ── Types ──────────────────────────────────────────────────────────

export interface ApiModel {
	id: string;
	name: string;
	provider: string;
	api: string;
	baseUrl?: string;
	/** For AIGW models, the upstream well-known provider key (e.g. openai, aws-mantle). */
	upstreamProvider?: string;
	contextWindow: number;
	maxTokens: number;
	reasoning: boolean;
	thinkingLevelMap?: Record<string, string | null>;
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; tiers?: Array<{ input: number; output: number; cacheRead: number; cacheWrite: number; inputTokensAbove: number }> };
	headers?: Record<string, string>;
	compat?: unknown;
	authenticated: boolean;
	/**
	 * When `false`, the model is authenticated but MUST NOT be bound to an agent
	 * session because Bobbit has no runnable agent-side provider path for it. The
	 * ModelSelector renders these visibly unavailable-for-sessions and refuses to
	 * select them. Undefined/true means selectable. Single source of truth for
	 * session-selectability lives where each model is emitted.
	 */
	sessionSelectable?: boolean;
	/** Human-readable reason shown in the selector when `sessionSelectable === false`. */
	sessionUnavailableReason?: string;
}

export interface CustomProviderConfig {
	id: string;
	name: string;
	type: "ollama" | "lmstudio" | "llama.cpp" | "vllm" | "manual" | "openai-images" | "gemini-images" | "google-imagen";
	baseUrl: string;
	apiKey?: string;
	models?: Array<{ id: string; name: string }>;
}

// ── Cache ──────────────────────────────────────────────────────────

let cachedModels: ApiModel[] | null = null;
let cacheExpiry = 0;
let cacheConfigVersion = 0;

/**
 * Invalidate the models cache. Call when upstream config changes in a way
 * that the prefs-version hash doesn't reflect (e.g. external mutation of
 * the aigw endpoint's model list after a successful reconfigure/refresh).
 * The next `getAvailableModels` call will assemble fresh.
 *
 * This keeps the UX snappy: when a user reconfigures the gateway, clicks
 * Refresh, or removes the gateway, the next /api/models response reflects
 * reality immediately instead of serving up to 5s of stale data.
 */
export function invalidateModelCache(): void {
	cachedModels = null;
	cacheExpiry = 0;
}

// ── Live model-state metadata resolver ─────────────────────────────

/**
 * The subset of model metadata that the live per-session `state.model` frame
 * carries to the client. Kept intentionally narrow — this is what the context
 * bar and thinking selector consume.
 */
export interface ResolvedModelStateMeta {
	contextWindow: number;
	maxTokens: number;
	reasoning: boolean;
	/** Present only when upstream metadata provides it (omitted otherwise). */
	thinkingLevelMap?: Record<string, string | null>;
	input: ("text" | "image")[];
	/**
	 * Which resolution tier produced this metadata:
	 *   - `cache` / `catalog`: authoritative — safe to overwrite live frame fields
	 *     (fixes stale/incorrect frames, e.g. Fable's 1M context + max thinking).
	 *   - `inferred`: last-resort defaults from `inferMeta`. Callers holding more
	 *     accurate live fields (custom/aigw/unknown providers) should PRESERVE the
	 *     live values rather than clobber them with these inferred defaults.
	 */
	source: "cache" | "catalog" | "inferred";
}

/**
 * SINGLE SOURCE OF TRUTH for the metadata embedded in live model-state frames.
 *
 * Every `state.model` broadcast (model select, spawn-pin, role/default pin,
 * fallback, archived rehydration) must route through here so the values the
 * client renders after selecting a model MATCH what the ModelSelector dropdown
 * shows (which is built from `getAvailableModels` / `assembleModels`). Deriving
 * live state from `inferMeta` alone clobbers the correct merged pi-ai metadata
 * (e.g. Claude Fable 5's 1M context, `reasoning:true`, and
 * `thinkingLevelMap {off:null, xhigh:"xhigh", max:"max"}`).
 *
 * Resolution order (first hit wins):
 *   1. Registry cache (`cachedModels`) keyed by exact provider+id — the same
 *      merged list `getAvailableModels` returns. The 5s TTL is intentionally
 *      IGNORED: model metadata is static per id, so a stale cache entry is
 *      strictly better than dropping to inferMeta. Synchronous, so it serves
 *      the sync broadcast sites (e.g. sendFallbackModelState).
 *   2. pi-ai catalog via `getBuiltinModel(provider, id)` for known upstream providers
 *      (skip empty / `aigw` / `custom`; aigw strips prefixes and merges no
 *      thinkingLevelMap, so it legitimately falls through to inferMeta). Any
 *      missing numeric is filled from inferMeta.
 *   3. `inferMeta(id)` — last resort for genuinely-unknown models. Carries no
 *      thinkingLevelMap (the client then falls back to the family heuristic).
 */
export function resolveModelStateMeta(provider: string | undefined, modelId: string): ResolvedModelStateMeta {
	// Tier 1: registry cache (ignore TTL — metadata is static per id).
	if (cachedModels) {
		const hit = cachedModels.find(m => m.provider === provider && m.id === modelId);
		if (hit) {
			return {
				contextWindow: hit.contextWindow,
				maxTokens: hit.maxTokens,
				reasoning: hit.reasoning,
				...(hit.thinkingLevelMap ? { thinkingLevelMap: hit.thinkingLevelMap } : {}),
				input: hit.input,
				source: "cache",
			};
		}
	}

	// Tier 2: pi-ai catalog for known upstream providers (not aigw / custom).
	const normalizedProvider = (provider ?? "").toLowerCase();
	if (normalizedProvider && normalizedProvider !== "aigw" && normalizedProvider !== "custom") {
		try {
			const model = getBuiltinModel(normalizedProvider as any, modelId as any) as {
				contextWindow?: number; maxTokens?: number; reasoning?: boolean;
				thinkingLevelMap?: Record<string, string | null>; input?: ("text" | "image")[];
			} | undefined;
			if (model) {
				const inferred = inferMeta(modelId);
				const contextWindow = typeof model.contextWindow === "number" && model.contextWindow > 0 ? model.contextWindow : inferred.contextWindow;
				const maxTokens = typeof model.maxTokens === "number" && model.maxTokens > 0 ? model.maxTokens : inferred.maxTokens;
				const input = (model.input && model.input.length > 0 ? model.input : inferred.input) as ("text" | "image")[];
				return {
					contextWindow,
					maxTokens,
					reasoning: model.reasoning ?? inferred.reasoning,
					...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
					input,
					source: "catalog",
				};
			}
		} catch {
			// Unknown provider/id — fall through to inferMeta.
		}
	}

	// Tier 3: inferMeta. Marked `inferred` so live-frame callers preserve any
	// more-accurate live metadata instead of clobbering it. inferMeta usually
	// carries no thinkingLevelMap (client then applies the family heuristic), but
	// a few routed families (e.g. GPT 5.6 Luna/Sol/Terra) attach an explicit map
	// so extended `xhigh`/`max` thinking survives the fallback path.
	const meta = inferMeta(modelId);
	return {
		contextWindow: meta.contextWindow,
		maxTokens: meta.maxTokens,
		reasoning: meta.reasoning,
		...(meta.thinkingLevelMap ? { thinkingLevelMap: meta.thinkingLevelMap } : {}),
		input: meta.input,
		source: "inferred",
	};
}

/**
 * Get all available models, merged from all sources.
 * Results are cached for 5 seconds.
 */
export function getBuiltInProviderIds(): string[] {
	return getBuiltinProviders().map((provider) => String(provider));
}

export async function getAvailableModels(prefs: PreferencesStore): Promise<ApiModel[]> {
	const now = Date.now();
	const currentVersion = getPrefsVersion(prefs);
	if (cachedModels && now < cacheExpiry && currentVersion === cacheConfigVersion) {
		return cachedModels;
	}

	const result = await assembleModels(prefs);
	cachedModels = result;
	cacheExpiry = now + 5000;
	cacheConfigVersion = currentVersion;
	return result;
}

/**
 * Simple version tracking — hash relevant preference keys.
 * We use a string hash of aigw.url + customProviders + providerKeys to detect changes.
 */
function getPrefsVersion(prefs: PreferencesStore): number {
	const all = prefs.getAll();
	let hash = 0;
	const str = JSON.stringify([
		all["aigw.url"],
		all["aigw.exclusive"],
		all["customProviders"],
		...Object.keys(all).filter(k => k.startsWith("providerKey.")).sort(),
	]);
	for (let i = 0; i < str.length; i++) {
		hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
	}
	return hash;
}

// ── Model Assembly ─────────────────────────────────────────────────

function shouldRaiseBuiltInMeta(modelId: string, explicitValue: number | undefined, inferredValue: number): boolean {
	if (!explicitValue || inferredValue <= explicitValue) return false;
	// Bobbit intentionally patches stale Claude Sonnet/Opus metadata upward (see
	// writeContextWindowOverrides). Do not use generic inference to inflate newer
	// OpenAI built-ins; pi-ai's provider-specific metadata is authoritative there.
	return /claude-(?:opus|sonnet)/i.test(modelId);
}

function builtInNumber(modelId: string, explicitValue: unknown, inferredValue: number): number {
	const explicit = typeof explicitValue === "number" && explicitValue > 0 ? explicitValue : undefined;
	if (shouldRaiseBuiltInMeta(modelId, explicit, inferredValue)) return inferredValue;
	return explicit ?? inferredValue;
}

async function assembleModels(prefs: PreferencesStore): Promise<ApiModel[]> {
	const results: ApiModel[] = [];
	const aigwUrl = getAigwUrl(prefs);

	// When an AI Gateway is configured, it is treated as the single egress path
	// by default — built-in upstream providers (anthropic, openai, bedrock, ...)
	// are hidden because in a secure-zone deployment they can't be reached
	// directly. Users who need to see built-ins alongside the gateway (e.g. for
	// local development against a real API key AND a dev gateway) can opt out
	// by setting `aigw.exclusive` to false in preferences.
	// Custom local providers (Ollama, LM Studio) are always shown because they
	// live on the user's own machine, not behind the gateway.
	const aigwExclusive = aigwUrl ? (prefs.get("aigw.exclusive") as boolean | undefined) ?? true : false;

	if (!aigwExclusive) {
		// 1. Built-in providers from pi-ai
		try {
			const providers = getBuiltinProviders();
			for (const providerId of providers) {
				const models = getBuiltinModels(providerId as any);
				const isAuth = detectProviderAuth(providerId as string, prefs);
				const bobbitAdditions = getOpenAIModelAdditions(providerId as string);
				const mergedModels = [
					...models,
					...bobbitAdditions.filter(addition => !models.some(m => m.id === addition.id)),
				];
				for (const m of mergedModels) {
					const meta = inferMeta(m.id);
					results.push({
						id: m.id,
						name: m.name,
						provider: providerId as string,
						api: m.api as string,
						baseUrl: m.baseUrl,
						contextWindow: builtInNumber(m.id, m.contextWindow, meta.contextWindow),
						maxTokens: builtInNumber(m.id, m.maxTokens, meta.maxTokens),
						reasoning: meta.reasoning || m.reasoning || false,
						...(m.thinkingLevelMap ? { thinkingLevelMap: m.thinkingLevelMap as Record<string, string | null> } : {}),
						input: (meta.input && meta.input.length > (m.input?.length || 0)) ? meta.input : (m.input || ["text"]) as ("text" | "image")[],
						cost: m.cost || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						...((m as any).headers ? { headers: (m as any).headers } : {}),
						...((m as any).compat ? { compat: (m as any).compat } : {}),
						authenticated: isAuth,
					});
				}
			}
		} catch (err) {
			console.error("[model-registry] Failed to load built-in providers:", err);
		}

		// 1b. Google account (Code Assist / OAuth) Gemini models. These reach
		// cloudcode-pa.googleapis.com directly from the gateway host, so they share
		// the same direct-egress visibility semantics as built-in providers and are
		// only emitted when an account credential is present.
		try {
			for (const m of getGoogleCodeAssistModels()) {
				results.push({ ...m, authenticated: detectProviderAuth(m.provider, prefs) });
			}
		} catch (err) {
			console.error("[model-registry] Failed to load Google Code Assist models:", err);
		}
	}

	// 2. AI Gateway models (if configured)
	if (aigwUrl) {
		try {
			const aigwModels = await discoverAigwModels(aigwUrl);
			// IMPORTANT: Claude models get their provider prefix stripped and are
			// routed through bedrock-converse-stream by configureAigw() when writing
			// models.json. The agent's rpc `set_model` does a strict equality match
			// against that file, so the IDs we return here MUST match the stripped
			// form — otherwise picking a Claude model from the UI silently fails
			// (the agent rejects with "Model not found", the error is swallowed,
			// and the next prompt goes to the previously bound model).
			const isClaudeModel = (id: string) => id.toLowerCase().includes("claude");
			const stripPrefix = (id: string) => { const i = id.indexOf("/"); return i >= 0 ? id.slice(i + 1) : id; };
			for (const m of aigwModels) {
				// AUTHORITATIVE path: a model carrying both `api` and `baseUrl` came from
				// well-known discovery (or the fallback option-1 OpenAI-responses fix).
				// Trust those fields verbatim and DON'T re-derive via inferMeta — the
				// id/baseUrl/api must match writeAigwModelsJson (which emits the bare
				// wireId) so `set_model`'s strict-equality match keeps working.
				if (m.api && m.baseUrl) {
					const wireId = m.wireId ?? m.id;
					results.push({
						id: wireId,
						name: m.name,
						provider: "aigw",
						...(m.upstreamProvider ? { upstreamProvider: m.upstreamProvider } : {}),
						api: m.api,
						baseUrl: m.baseUrl,
						contextWindow: m.contextWindow || 0,
						maxTokens: m.maxTokens || 0,
						reasoning: m.reasoning || false,
						...(m.thinkingLevelMap ? { thinkingLevelMap: m.thinkingLevelMap } : {}),
						input: m.input || ["text"],
						cost: m.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						...(m.compat ? { compat: m.compat as Record<string, unknown> } : {}),
						authenticated: true,
					});
					continue;
				}
				// ── Fallback heuristic path (no authoritative api/baseUrl) ──
				// Claude models get their provider prefix stripped and are routed
				// through bedrock-converse-stream by configureAigw() when writing
				// models.json. The agent's rpc `set_model` does a strict equality match
				// against that file, so the IDs we return here MUST match the stripped
				// form — otherwise picking a Claude model from the UI silently fails.
				const normalizedId = isClaudeModel(m.id) ? stripPrefix(m.id) : m.id;
				const meta = inferMeta(normalizedId);
				results.push({
					id: normalizedId,
					name: m.name,
					provider: "aigw",
					...(m.upstreamProvider ? { upstreamProvider: m.upstreamProvider } : {}),
					api: isClaudeModel(m.id) ? "bedrock-converse-stream" : (m.api || "openai-completions"),
					baseUrl: aigwUrl,
					contextWindow: Math.max(meta.contextWindow, m.contextWindow || 0),
					maxTokens: Math.max(meta.maxTokens, m.maxTokens || 0),
					reasoning: meta.reasoning || m.reasoning || false,
					// Preserve extended-thinking metadata for routed families that would
					// otherwise lose it (e.g. AIGW-routed GPT 5.6 Luna/Sol/Terra, whose
					// `openai/gpt-5.6-*` id only matches inferMeta's substring rule).
					...(meta.thinkingLevelMap ?? m.thinkingLevelMap ? { thinkingLevelMap: meta.thinkingLevelMap ?? m.thinkingLevelMap } : {}),
					input: meta.input || ["text"],
					cost: m.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					authenticated: true, // aigw is always authenticated (no key needed)
				});
			}
		} catch (err) {
			console.error("[model-registry] Failed to discover AI Gateway models:", err);
		}
	}

	// 3. Custom local providers
	try {
		const customModels = await discoverCustomProviderModels(prefs);
		results.push(...customModels);
	} catch (err) {
		console.error("[model-registry] Failed to discover custom providers:", err);
	}

	return results;
}

// ── Authentication Detection ───────────────────────────────────────

const ENV_MAP: Record<string, string> = {
	"anthropic": "ANTHROPIC_API_KEY",
	"openai": "OPENAI_API_KEY",
	"google": "GOOGLE_API_KEY",
	// Google account (Code Assist) authenticates via the Bearer access token, NOT a
	// Gemini Developer API key. Mapping this to GOOGLE_API_KEY would let a generic
	// GOOGLE_API_KEY/GEMINI_API_KEY masquerade as an authenticated account provider
	// and cross-contaminate isolation. Auth is ultimately resolved through the shared
	// spawn-credential helper (see detectProviderAuth) so whitespace-only tokens and
	// stored OAuth are handled consistently; this entry documents the association.
	"google-gemini-cli": "GOOGLE_CLOUD_ACCESS_TOKEN",
	"google-vertex": "GOOGLE_APPLICATION_CREDENTIALS",
	"xai": "XAI_API_KEY",
	"amazon-bedrock": "AWS_ACCESS_KEY_ID",
	"groq": "GROQ_API_KEY",
	"mistral": "MISTRAL_API_KEY",
	"openrouter": "OPENROUTER_API_KEY",
};

/**
 * Providers whose `auth.json` credentials are genuine OAuth/account tokens.
 * Only these may be authenticated via `hasOAuthCredentials()` — this prevents a
 * generic OAuth credential (e.g. `auth.json["google-gemini-cli"]`) from making
 * API-key-only providers like `google` (Gemini Developer API) look usable.
 * Single source of truth for OAuth-capable provider detection.
 */
const OAUTH_AUTHENTICATED_PROVIDERS = new Set(["anthropic", "openai-codex", "google-gemini-cli"]);

export function isOAuthCapableProvider(provider: string): boolean {
	return OAUTH_AUTHENTICATED_PROVIDERS.has(provider);
}

function detectProviderAuth(provider: string, prefs: PreferencesStore): boolean {
	// Check provider key in preferences (migrated from IndexedDB)
	const storedKey = prefs.get(`providerKey.${provider}`) as string | undefined;
	if (storedKey) return true;

	// Code Assist (Google account) is authenticated ONLY by a stored auth.json OAuth
	// credential OR a pre-acquired GOOGLE_CLOUD_ACCESS_TOKEN Bearer env token. Route
	// through the shared spawn-credential helper so settings/model-API auth metadata,
	// spawn-pinning, and the generated provider extension's authenticatedAtLoad gate
	// all agree on the credential picture (including trimming whitespace-only tokens).
	// A generic GOOGLE_API_KEY/GEMINI_API_KEY must never authenticate the account
	// provider, and the Bearer token must never authenticate the API-key `google`.
	if (provider === GOOGLE_GEMINI_CLI_PROVIDER) return hasGoogleCodeAssistSpawnCredential();

	// Check env vars
	const envVar = ENV_MAP[provider];
	if (envVar && process.env[envVar]) return true;

	// Check OAuth credentials (auth.json) — only for OAuth-capable providers so a
	// google-gemini-cli account token can't authenticate API-key-only `google`.
	if (OAUTH_AUTHENTICATED_PROVIDERS.has(provider) && hasOAuthCredentials(provider)) return true;

	return false;
}

// ── OAuth Detection ────────────────────────────────────────────────

let oauthCache: { data: any; expiry: number } | null = null;
const OAUTH_CACHE_TTL = 10_000; // 10 seconds

/** Invalidate the cached auth.json data so the next read picks up fresh credentials. */
export function clearOAuthCache(): void {
	oauthCache = null;
}

function readAuthJson(): any {
	const now = Date.now();
	if (oauthCache && now < oauthCache.expiry) {
		return oauthCache.data;
	}

	const authPath = globalAuthPath();
	try {
		if (fs.existsSync(authPath)) {
			const data = JSON.parse(fs.readFileSync(authPath, "utf-8"));
			oauthCache = { data, expiry: now + OAUTH_CACHE_TTL };
			return data;
		}
	} catch {
		// Ignore read errors
	}

	oauthCache = { data: null, expiry: now + OAUTH_CACHE_TTL };
	return null;
}

function hasOAuthCredentials(provider?: string): boolean {
	const authData = readAuthJson();
	if (!authData) return false;

	// auth.json has various structures — check for access tokens
	// It may have provider-specific sections or a flat structure
	if (typeof authData === "object") {
		// If no specific provider requested, check if any auth exists
		if (!provider) return Object.keys(authData).length > 0;

		// Check for provider-specific keys
		if (authData[provider]) return true;
		// Check for an access_token (general OAuth)
		if (authData.accessToken || authData.access_token) return true;
	}

	return false;
}

// ── Custom Provider Discovery ──────────────────────────────────────

/** Discover models from a single custom provider config (without persisting anything). */
export async function discoverModelsForConfig(config: CustomProviderConfig): Promise<ApiModel[]> {
	return discoverFromSingleConfig(config);
}

async function discoverCustomProviderModels(prefs: PreferencesStore): Promise<ApiModel[]> {
	const configs = (prefs.get("customProviders") as CustomProviderConfig[] | undefined) || [];
	const results: ApiModel[] = [];

	for (const config of configs) {
		try {
			const models = await discoverFromSingleConfig(config);
			results.push(...models);
		} catch (err) {
			console.error(`[model-registry] Failed to discover from ${config.name}:`, err);
		}
	}
	return results;
}

async function discoverFromSingleConfig(config: CustomProviderConfig): Promise<ApiModel[]> {
	switch (config.type) {
		case "ollama":
			return discoverOllamaModelsServer(config);
		case "lmstudio":
			return discoverLMStudioModelsServer(config);
		case "llama.cpp":
		case "vllm":
			return discoverOpenAICompatModelsServer(config);
		case "manual":
			return (config.models || []).map(m => ({
				id: m.id,
				name: m.name || m.id,
				provider: config.name || config.id,
				api: "openai-completions" as const,
				baseUrl: `${config.baseUrl}/v1`,
				contextWindow: 8192,
				maxTokens: 4096,
				reasoning: false,
				input: ["text"] as ("text" | "image")[],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				authenticated: true,
			}));
		default:
			return [];
	}
}

async function discoverOllamaModelsServer(config: CustomProviderConfig): Promise<ApiModel[]> {
	try {
		const { Ollama } = await import("ollama");
		const ollama = new Ollama({ host: config.baseUrl });
		const { models } = await ollama.list();

		const results: ApiModel[] = [];
		for (const model of models) {
			try {
				const details = await ollama.show({ model: model.name });
				const capabilities: string[] = (details as any).capabilities || [];
				if (!capabilities.includes("tools")) continue;

				const modelInfo: any = details.model_info || {};
				const architecture = modelInfo["general.architecture"] || "";
				const contextKey = `${architecture}.context_length`;
				const contextWindow = parseInt(modelInfo[contextKey] || "8192", 10);
				const maxTokens = contextWindow * 10;

				results.push({
					id: model.name,
					name: model.name,
					provider: config.name || config.id,
					api: "openai-completions",
					baseUrl: `${config.baseUrl}/v1`,
					contextWindow,
					maxTokens,
					reasoning: capabilities.includes("thinking"),
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					authenticated: true,
				});
			} catch {
				// Skip models we can't inspect
			}
		}
		return results;
	} catch (err) {
		console.error(`[model-registry] Ollama discovery failed for ${config.baseUrl}:`, err);
		return [];
	}
}

async function discoverLMStudioModelsServer(config: CustomProviderConfig): Promise<ApiModel[]> {
	try {
		const { LMStudioClient } = await import("@lmstudio/sdk");
		const url = new URL(config.baseUrl);
		const port = url.port ? parseInt(url.port, 10) : 1234;
		const client = new LMStudioClient({ baseUrl: `ws://${url.hostname}:${port}` });
		const models = await client.system.listDownloadedModels();

		return models
			.filter((m: any) => m.type === "llm")
			.map((m: any) => ({
				id: m.path,
				name: m.displayName || m.path,
				provider: config.name || config.id,
				api: "openai-completions",
				baseUrl: `${config.baseUrl}/v1`,
				contextWindow: m.maxContextLength || 8192,
				maxTokens: m.maxContextLength || 8192,
				reasoning: m.trainedForToolUse || false,
				input: (m.vision ? ["text", "image"] : ["text"]) as ("text" | "image")[],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				authenticated: true,
			}));
	} catch (err) {
		console.error(`[model-registry] LM Studio discovery failed for ${config.baseUrl}:`, err);
		return [];
	}
}

async function discoverOpenAICompatModelsServer(config: CustomProviderConfig): Promise<ApiModel[]> {
	try {
		const data = await httpGetJson(`${config.baseUrl}/v1/models`, config.apiKey, 5000);
		if (!data?.data || !Array.isArray(data.data)) return [];

		return data.data.map((m: any) => {
			const contextWindow = m.context_length || m.max_model_len || 8192;
			const maxTokens = m.max_tokens || Math.min(contextWindow, 4096);
			return {
				id: m.id,
				name: m.id,
				provider: config.name || config.id,
				api: "openai-completions",
				baseUrl: `${config.baseUrl}/v1`,
				contextWindow,
				maxTokens,
				reasoning: false,
				input: ["text"] as ("text" | "image")[],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				authenticated: true,
			};
		});
	} catch (err) {
		console.error(`[model-registry] OpenAI-compat discovery failed for ${config.baseUrl}:`, err);
		return [];
	}
}

// ── HTTP helper ────────────────────────────────────────────────────

function httpGetJson(url: string, apiKey?: string, timeoutMs = 10_000): Promise<any> {
	return new Promise((resolve, reject) => {
		const parsedUrl = new URL(url);
		const transport = parsedUrl.protocol === "https:" ? https : http;

		const headers: Record<string, string> = { "Content-Type": "application/json" };
		if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

		const req = transport.request(parsedUrl, { method: "GET", headers, timeout: timeoutMs }, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (c: Buffer) => chunks.push(c));
			res.on("end", () => {
				const body = Buffer.concat(chunks).toString("utf-8");
				if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
					try { resolve(JSON.parse(body)); }
					catch { reject(new Error(`Invalid JSON from ${url}`)); }
				} else {
					reject(new Error(`HTTP ${res.statusCode} from ${url}`));
				}
			});
		});
		req.on("timeout", () => { req.destroy(); reject(new Error(`Timeout fetching ${url}`)); });
		req.on("error", reject);
		req.end();
	});
}

// ── Model Recency Ranking ──────────────────────────────────────────

// Re-export GPT_55_RECENCY_RANK from the shared module so server callers
// who already pull from model-registry keep a stable import path. The
// canonical declaration lives in `src/shared/model-ranks.ts` so the UI can
// import it without crossing the server/web tsconfig boundary.
import { GPT_55_RECENCY_RANK } from "../../shared/model-ranks.js";
export { GPT_55_RECENCY_RANK };

function claudeOpus4Minor(id: string): number | undefined {
	// Keep in lockstep with src/ui/dialogs/ModelSelector.ts. Limit the minor
	// capture to version-looking values so date-only IDs like
	// claude-opus-4-20250514 remain the generic Opus 4 tier.
	const match = id.toLowerCase().match(/claude-opus-4(?:-|\.)(\d{1,3})\b/);
	return match ? Number(match[1]) : undefined;
}

function claudeOpus4Rank(id: string): number | undefined {
	const minor = claudeOpus4Minor(id);
	if (minor === undefined) return undefined;
	if (minor === 1) return 96;
	return 88 + minor * 2;
}

/**
 * Rank a model ID by recency/quality tier. Higher = newer/better.
 * Used to auto-select the best model when no preference is set.
 * Canonical server-side copy — also used by session-manager for auto-selection.
 */
export function modelRecencyRank(id: string): number {
	const s = id.toLowerCase();

	// ── Anthropic Claude ──
	const opus4Rank = claudeOpus4Rank(s);
	if (opus4Rank !== undefined) return opus4Rank;
	if (s.includes("claude-sonnet-4-6") || s.includes("claude-sonnet-4.6")) return 99;
	if (s.includes("claude-sonnet-4-5") || s.includes("claude-sonnet-4.5")) return 97;
	if (s.includes("claude-opus-4")) return 95;
	if (s.includes("claude-sonnet-4") && !s.includes("4-5") && !s.includes("4.5") && !s.includes("4-6") && !s.includes("4.6")) return 94;
	if (s.includes("claude-haiku-4-5") || s.includes("claude-haiku-4.5")) return 90;
	if (s.includes("claude-3-7-sonnet") || s.includes("claude-3.7-sonnet")) return 80;
	if (s.includes("claude-3-5-sonnet") || s.includes("claude-3.5-sonnet")) return 70;
	if (s.includes("claude-3-5-haiku") || s.includes("claude-3.5-haiku")) return 65;
	if (s.includes("claude-3-opus")) return 60;
	if (s.includes("claude")) return 50;

	// ── OpenAI ──
	if (s.includes("gpt-5.5")) return GPT_55_RECENCY_RANK;
	if (s.includes("gpt-5.4")) return 100;
	if (s.includes("gpt-5.3")) return 98;
	if (s.includes("gpt-5.2")) return 96;
	if (s.includes("gpt-5.1")) return 94;
	if (s.includes("gpt-5") && !s.includes("5.")) return 92;
	if (s.includes("o4-mini")) return 91;
	if (s.includes("o3-pro")) return 89;
	if (s.includes("o3") && !s.includes("o3-mini")) return 88;
	if (s.includes("o3-mini")) return 85;
	if (s.includes("o1-pro")) return 80;
	if (s.includes("o1") && !s.includes("o1-mini")) return 78;
	if (s.includes("gpt-4o") && !s.includes("mini")) return 70;
	if (s.includes("gpt-4.1")) return 68;
	if (s.includes("gpt-4o-mini") || s.includes("gpt-4.1-mini")) return 65;
	if (s.includes("gpt-4")) return 50;

	// ── Google Gemini ──
	if (s.includes("gemini-3.1-pro")) return 100;
	if (s.includes("gemini-3-pro")) return 98;
	if (s.includes("gemini-3.1-flash") || s.includes("gemini-3-flash")) return 95;
	if (s.includes("gemini-2.5-pro")) return 90;
	if (s.includes("gemini-2.5-flash") && !s.includes("lite")) return 85;
	if (s.includes("gemini-2.5-flash-lite")) return 80;
	if (s.includes("gemini-2.0")) return 60;
	if (s.includes("gemini-1.5")) return 40;
	if (s.includes("gemini")) return 30;

	// ── xAI Grok ──
	if (s.includes("grok-4")) return 100;
	if (s.includes("grok-3") && !s.includes("mini")) return 90;
	if (s.includes("grok-3-mini")) return 85;
	if (s.includes("grok-2")) return 70;
	if (s.includes("grok")) return 50;

	// ── DeepSeek ──
	if (s.includes("deepseek-v3.2")) return 95;
	if (s.includes("deepseek-v3.1")) return 90;
	if (s.includes("deepseek-r1")) return 88;
	if (s.includes("deepseek-v3")) return 85;
	if (s.includes("deepseek")) return 50;

	// ── Qwen ──
	if (s.includes("qwen3.5") || s.includes("qwen-3.5")) return 95;
	if (s.includes("qwen3-coder") || s.includes("qwen-3-coder")) return 90;
	if (s.includes("qwen3-next") || s.includes("qwen-3-next")) return 88;
	if (s.includes("qwen3") || s.includes("qwen-3")) return 85;
	if (s.includes("qwen")) return 50;

	// ── Mistral ──
	if (s.includes("devstral-medium")) return 90;
	if (s.includes("magistral")) return 88;
	if (s.includes("devstral")) return 85;
	if (s.includes("codestral")) return 80;
	if (s.includes("mistral-large")) return 75;
	if (s.includes("mistral-medium")) return 70;
	if (s.includes("mistral")) return 50;

	// ── Llama ──
	if (s.includes("llama-4") || s.includes("llama4")) return 90;
	if (s.includes("llama-3.3") || s.includes("llama3-3")) return 80;
	if (s.includes("llama-3.2") || s.includes("llama3-2")) return 70;
	if (s.includes("llama")) return 50;

	return 0;
}
