/**
 * Unified Model Registry — single server-side source of truth for all available models.
 *
 * Assembles a merged model list from:
 * 1. Built-in providers (from pi-ai getProviders()/getModels())
 * 2. AI Gateway models (if configured, live fetch via discoverAigwModels())
 * 3. Custom local providers (Ollama, LM Studio, vLLM, llama.cpp)
 *
 * Served via GET /api/models with a 5-second TTL cache.
 */

import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import { getProviders, getModels, getModel } from "@earendil-works/pi-ai";
import type { PreferencesStore } from "./preferences-store.js";
import { globalAuthPath } from "../bobbit-dir.js";
import { inferMeta, discoverAigwModels, getAigwUrl, readModelsJson, writeModelsJson } from "./aigw-manager.js";
import { getOpenAIModelAdditions } from "./openai-model-additions.js";
import { getGoogleCodeAssistModels } from "./google-code-assist-models.js";
import { CLAUDE_CODE_MODEL_ALIASES } from "./claude-code-config.js";
import { getClaudeCodeStatus } from "./claude-code-status.js";

// ── Types ──────────────────────────────────────────────────────────

export interface ApiModel {
	id: string;
	name: string;
	provider: string;
	api: string;
	baseUrl?: string;
	contextWindow: number;
	maxTokens: number;
	reasoning: boolean;
	thinkingLevelMap?: Record<string, string | null>;
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	headers?: Record<string, string>;
	compat?: unknown;
	authenticated: boolean;
	/**
	 * When `false`, the model is authenticated but MUST NOT be bound to an agent
	 * session: the pi-coding-agent runtime has no provider/api capable of running
	 * it (e.g. `google-gemini-cli` Code Assist models, whose Code Assist adapter is
	 * only wired into server-side completion, not the session runtime). The
	 * ModelSelector renders these visibly unavailable-for-sessions and refuses to
	 * select them. Undefined/true means selectable. Single source of truth for
	 * session-selectability lives where each model is emitted.
	 */
	sessionSelectable?: boolean;
	/** Human-readable reason shown in the selector when `sessionSelectable === false`. */
	sessionUnavailableReason?: string;
	/** Session runtime required for this model. Undefined/"pi" preserves legacy Pi runtime behavior. */
	runtime?: "pi" | "claude-code";
	/** True for host-local runtimes that are not normal API-backed models. */
	localRuntime?: boolean;
	/** Short provider/runtime label for selectors, e.g. "Claude Code (local)". */
	runtimeLabel?: string;
}

export interface CustomProviderConfig {
	id: string;
	name: string;
	// NOTE: "openai-completions" is the Settings UI's type value (CustomProviderType
	// in src/ui/storage/stores/custom-providers-store.ts) for a manually-specified
	// OpenAI-completions-compatible remote API (e.g. NVIDIA NIM, OpenRouter, Together).
	// The UI has never had a "manual" type — it calls this class of provider
	// "openai-completions" — so both must be accepted here or every provider saved
	// via the actual Settings dialog silently discovers zero models (see
	// discoverFromSingleConfig below; bug fixed in fable/d6-glm-in-bobbit).
	type: "ollama" | "lmstudio" | "llama.cpp" | "vllm" | "manual" | "openai-completions" | "openai-images" | "gemini-images" | "google-imagen";
	baseUrl: string;
	apiKey?: string;
	models?: Array<{ id: string; name: string }>;
}

/**
 * Wire shape of a custom provider config as serialized to clients.
 *
 * Secrets are write-only: stored API keys are NEVER echoed back to the
 * client (same convention as the hindsight pack's `apiKeySet` and
 * project-config sandbox-secret redaction). Any route that serializes a
 * CustomProviderConfig to the browser MUST go through
 * redactCustomProviderConfig() — never reintroduce raw `apiKey` on a read
 * path. Pinned by tests/e2e/custom-provider-key-redaction.spec.ts.
 */
export type RedactedCustomProviderConfig = Omit<CustomProviderConfig, "apiKey"> & { hasApiKey: boolean };

export function redactCustomProviderConfig(config: CustomProviderConfig): RedactedCustomProviderConfig {
	const { apiKey, ...rest } = config;
	return { ...rest, hasApiKey: Boolean(apiKey) };
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
 * `thinkingLevelMap {off:null, xhigh:"xhigh"}`).
 *
 * Resolution order (first hit wins):
 *   1. Registry cache (`cachedModels`) keyed by exact provider+id — the same
 *      merged list `getAvailableModels` returns. The 5s TTL is intentionally
 *      IGNORED: model metadata is static per id, so a stale cache entry is
 *      strictly better than dropping to inferMeta. Synchronous, so it serves
 *      the sync broadcast sites (e.g. sendFallbackModelState).
 *   2. pi-ai catalog via `getModel(provider, id)` for known upstream providers
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
			};
		}
	}

	// Tier 2: pi-ai catalog for known upstream providers (not aigw / custom).
	const normalizedProvider = (provider ?? "").toLowerCase();
	if (normalizedProvider && normalizedProvider !== "aigw" && normalizedProvider !== "custom") {
		try {
			const model = getModel(normalizedProvider as any, modelId as any) as {
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
				};
			}
		} catch {
			// Unknown provider/id — fall through to inferMeta.
		}
	}

	// Tier 3: inferMeta (no thinkingLevelMap).
	const meta = inferMeta(modelId);
	return {
		contextWindow: meta.contextWindow,
		maxTokens: meta.maxTokens,
		reasoning: meta.reasoning,
		input: meta.input,
	};
}

/**
 * Get all available models, merged from all sources.
 * Results are cached for 5 seconds.
 */
export function getBuiltInProviderIds(): string[] {
	return getProviders().map(provider => String(provider));
}

export async function getAvailableModels(
	prefs: PreferencesStore,
	projectConfig?: { get(key: string): string | undefined } | null,
): Promise<ApiModel[]> {
	const now = Date.now();
	const currentVersion = getPrefsVersion(prefs, projectConfig);
	if (cachedModels && now < cacheExpiry && currentVersion === cacheConfigVersion) {
		return cachedModels;
	}

	const result = await assembleModels(prefs, projectConfig);
	cachedModels = result;
	cacheExpiry = now + 5000;
	cacheConfigVersion = currentVersion;
	return result;
}

/**
 * Simple version tracking — hash relevant preference keys.
 * We use a string hash of aigw.url + customProviders + providerKeys to detect changes.
 */
function getPrefsVersion(prefs: PreferencesStore, projectConfig?: { get(key: string): string | undefined } | null): number {
	const all = prefs.getAll();
	let hash = 0;
	const str = JSON.stringify([
		all["aigw.url"],
		all["aigw.exclusive"],
		all["customProviders"],
		all["claudeCode.executablePath"],
		all["claudeCode.defaultModel"],
		all["claudeCode.permissionMode"],
		all["claudeCode.allowBypassPermissions"],
		projectConfig?.get("claudeCodeDefaultModel"),
		projectConfig?.get("claudeCodePermissionMode"),
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

async function assembleModels(prefs: PreferencesStore, projectConfig?: { get(key: string): string | undefined } | null): Promise<ApiModel[]> {
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
			const providers = getProviders();
			for (const providerId of providers) {
				const models = getModels(providerId as any);
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

	// 1c. Claude Code local runtime models are synthetic and remain visible even
	// when AI Gateway exclusive mode hides direct API-backed providers.
	try {
		results.push(...await buildClaudeCodeModels(prefs, projectConfig));
	} catch (err) {
		console.error("[model-registry] Failed to probe Claude Code runtime:", err);
		results.push(...buildClaudeCodeModelsFromStatus({
			ready: false,
			authenticated: false,
			reason: "Claude Code probe failed",
		}));
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
				const normalizedId = isClaudeModel(m.id) ? stripPrefix(m.id) : m.id;
				const meta = inferMeta(normalizedId);
				results.push({
					id: normalizedId,
					name: m.name,
					provider: "aigw",
					api: isClaudeModel(m.id) ? "bedrock-converse-stream" : (m.api || "openai-completions"),
					baseUrl: aigwUrl,
					contextWindow: Math.max(meta.contextWindow, m.contextWindow || 0),
					maxTokens: Math.max(meta.maxTokens, m.maxTokens || 0),
					reasoning: meta.reasoning || m.reasoning || false,
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

async function buildClaudeCodeModels(prefs: PreferencesStore, projectConfig?: { get(key: string): string | undefined } | null): Promise<ApiModel[]> {
	const status = await getClaudeCodeStatus(prefs, projectConfig);
	return buildClaudeCodeModelsFromStatus(status);
}

function buildClaudeCodeModelsFromStatus(status: { ready: boolean; authenticated: boolean; reason?: string }): ApiModel[] {
	const unavailableReason = status.ready ? undefined : status.reason || "Claude Code CLI not ready";
	return CLAUDE_CODE_MODEL_ALIASES.map(alias => ({
		id: alias,
		name: claudeCodeModelName(alias),
		provider: "claude-code",
		api: "claude-code-runtime",
		runtime: "claude-code" as const,
		localRuntime: true,
		runtimeLabel: "Claude Code (local)",
		contextWindow: claudeCodeContextWindow(alias),
		maxTokens: 8192,
		reasoning: true,
		input: ["text"] as ("text" | "image")[],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		authenticated: status.ready && status.authenticated,
		sessionSelectable: status.ready,
		...(unavailableReason ? { sessionUnavailableReason: unavailableReason } : {}),
	}));
}

function claudeCodeContextWindow(alias: string): number {
	if (alias === "sonnet" || alias === "opus") return 1_000_000;
	const cliAlias = alias.startsWith("local-") ? alias.slice("local-".length) : alias;
	if (/^claude-(?:opus|sonnet)/i.test(cliAlias)) return Math.max(inferMeta(cliAlias).contextWindow, 1_000_000);
	return 200_000;
}

function claudeCodeModelName(alias: string): string {
	if (alias === "local-claude-opus-4-8") return "local-claude-opus-4-8";
	if (alias === "local-claude-sonnet-4-6") return "local-claude-sonnet-4-6";
	return `Claude Code ${alias}`;
}

// ── Authentication Detection ───────────────────────────────────────

const ENV_MAP: Record<string, string> = {
	"anthropic": "ANTHROPIC_API_KEY",
	"openai": "OPENAI_API_KEY",
	"google": "GOOGLE_API_KEY",
	"google-gemini-cli": "GOOGLE_API_KEY",
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

// ── Custom Provider → models.json sync ──────────────────────────────
//
// Discovery above (`discoverFromSingleConfig` et al.) only feeds
// `getAvailableModels()`, i.e. what the browser's model picker and
// server-side one-shot completions (title-gen, image-gen) can see. The
// actual spawned `pi-coding-agent` subprocess that runs a session has its
// own, separate model registry sourced from `~/.bobbit/agent/models.json`
// (see aigw-manager.ts's `writeAigwModelsJson` for the equivalent aigw
// path) — it does NOT read Bobbit's `customProviders` preference. Without
// this sync, a configured Ollama/LM Studio/vLLM/llama.cpp/manual provider
// shows up as "authenticated" in the picker but a session that selects it
// fails at spawn with `Model "<provider>/<id>" not found. Use --list-models
// to see available models.` — the model existed only in Bobbit's registry,
// never in the file the agent binary actually consults.
//
// Bookkeeping: unlike aigw (one fixed "aigw" key), each custom provider
// config owns its own models.json key (`config.name || config.id`), and
// there can be several. We track the set of keys we last wrote so renames/
// deletes/unreachable-provider syncs can prune stale entries without
// touching keys owned by other writers (aigw, openai-model-additions,
// built-ins).
const CUSTOM_PROVIDER_KEYS_FIELD = "_bobbitCustomProviderKeys";

// Conservative OpenAI-compat flags for local/self-hosted servers — mirrors
// the non-Claude `openaiCompat` block in aigw-manager.ts's
// `writeAigwModelsJson` (local servers generally don't support the newer
// OpenAI-specific request fields).
const LOCAL_OPENAI_COMPAT = {
	supportsDeveloperRole: false,
	supportsStore: false,
	supportsUsageInStreaming: false,
	supportsReasoningEffort: false,
	supportsStrictMode: false,
	maxTokensField: "max_tokens",
} as const;

/**
 * Discover and write all configured custom local providers into
 * `~/.bobbit/agent/models.json` so `pi-coding-agent` subprocesses can
 * resolve `set_model(provider, id)` for them. Call after any
 * `customProviders` preference change and once at server startup
 * (mirrors `startupAigwCheck`'s re-discovery-on-boot behavior).
 */
export async function syncCustomProviderModelsJson(prefs: PreferencesStore): Promise<void> {
	const configs = (prefs.get("customProviders") as CustomProviderConfig[] | undefined) || [];
	const data = readModelsJson();
	const previousKeys: string[] = Array.isArray(data[CUSTOM_PROVIDER_KEYS_FIELD]) ? data[CUSTOM_PROVIDER_KEYS_FIELD] : [];

	// Common case: no custom providers configured, and none ever were —
	// nothing to discover or prune, skip the read-modify-write entirely.
	if (configs.length === 0 && previousKeys.length === 0) return;

	if (!data.providers) data.providers = {};
	const nextKeys: string[] = [];

	for (const config of configs) {
		// Image-generation-only provider types are not session models; leave
		// their models.json wiring (if any) to image-generation.ts.
		if (config.type === "openai-images" || config.type === "gemini-images" || config.type === "google-imagen") continue;

		const key = config.name || config.id;
		try {
			const models = await discoverFromSingleConfig(config);
			if (models.length === 0) continue;
			data.providers[key] = {
				baseUrl: `${config.baseUrl.replace(/\/+$/, "")}/v1`,
				apiKey: config.apiKey || "none",
				api: "openai-completions",
				models: models.map(m => ({
					id: m.id,
					name: m.name,
					contextWindow: m.contextWindow,
					maxTokens: m.maxTokens,
					reasoning: m.reasoning,
					input: m.input,
					cost: m.cost,
					compat: LOCAL_OPENAI_COMPAT,
				})),
			};
			nextKeys.push(key);
		} catch (err) {
			console.error(`[model-registry] Failed to sync custom provider "${key}" to models.json:`, err);
		}
	}

	// Prune keys we previously wrote whose owning config is now gone entirely
	// (deleted or renamed to a different key). Conservative: a key whose
	// config still exists but failed discovery this round (transient
	// unreachable server) is left untouched — its models.json entry is stale
	// but harmless, and will self-heal on the next successful sync.
	for (const staleKey of previousKeys) {
		if (!nextKeys.includes(staleKey) && !configs.some(c => (c.name || c.id) === staleKey)) {
			delete data.providers[staleKey];
		}
	}
	data[CUSTOM_PROVIDER_KEYS_FIELD] = nextKeys;

	writeModelsJson(data);
}

/** Remove a single custom provider's entry from models.json immediately (used by the DELETE route so removal doesn't wait for the next full sync). */
export function removeCustomProviderModelsJsonEntry(config: CustomProviderConfig): void {
	const key = config.name || config.id;
	const data = readModelsJson();
	if (data.providers?.[key]) {
		delete data.providers[key];
		const keys: string[] = Array.isArray(data[CUSTOM_PROVIDER_KEYS_FIELD]) ? data[CUSTOM_PROVIDER_KEYS_FIELD] : [];
		data[CUSTOM_PROVIDER_KEYS_FIELD] = keys.filter(k => k !== key);
		writeModelsJson(data);
	}
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
		case "openai-completions":
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
 * One recency rule: matches against the LOWERCASED id, first match wins. `rank`
 * is a plain number for the vast majority of rules; the one dynamic case
 * (Claude Opus 4.x minor versions) supplies a function of the matched string.
 */
interface RecencyRule {
	test: (s: string) => boolean;
	rank: number | ((s: string) => number);
}

/**
 * Extension-Seam Audit S9 (`~/Documents/dev/bobbit-fable-refactor/EXTENSION-SEAM-AUDIT.md`
 * §3/§1 "modelRecencyRank ladder → data table"): this is a lookup table in
 * disguise, so it is represented as one. ORDER IS SIGNIFICANT — this is a
 * first-match-wins list, byte-parity-pinned against the prior if/else-if ladder
 * by `tests/model-recency-rank-table-parity.test.ts` (generated by running the
 * pre-refactor function, not hand-derived). Reordering, adding, or removing an
 * entry can silently change a resolved rank — extend by inserting a new rule at
 * the correct precedence position, never by appending blindly.
 *
 * One entry preserves a PRE-EXISTING QUIRK, not a bug fix: `"gpt-4.1-mini"`
 * matches the earlier bare `"gpt-4.1"` rule before it can ever reach its own
 * `"gpt-4o-mini" || "gpt-4.1-mini"` rule (see the parity test file header).
 */
const RECENCY_RULES: readonly RecencyRule[] = [
	// ── Anthropic Claude ──
	{ test: (s) => claudeOpus4Rank(s) !== undefined, rank: (s) => claudeOpus4Rank(s)! },
	{ test: (s) => s.includes("claude-sonnet-4-6") || s.includes("claude-sonnet-4.6"), rank: 99 },
	{ test: (s) => s.includes("claude-sonnet-4-5") || s.includes("claude-sonnet-4.5"), rank: 97 },
	{ test: (s) => s.includes("claude-opus-4"), rank: 95 },
	{ test: (s) => s.includes("claude-sonnet-4") && !s.includes("4-5") && !s.includes("4.5") && !s.includes("4-6") && !s.includes("4.6"), rank: 94 },
	{ test: (s) => s.includes("claude-haiku-4-5") || s.includes("claude-haiku-4.5"), rank: 90 },
	{ test: (s) => s.includes("claude-3-7-sonnet") || s.includes("claude-3.7-sonnet"), rank: 80 },
	{ test: (s) => s.includes("claude-3-5-sonnet") || s.includes("claude-3.5-sonnet"), rank: 70 },
	{ test: (s) => s.includes("claude-3-5-haiku") || s.includes("claude-3.5-haiku"), rank: 65 },
	{ test: (s) => s.includes("claude-3-opus"), rank: 60 },
	{ test: (s) => s.includes("claude"), rank: 50 },

	// ── OpenAI ──
	{ test: (s) => s.includes("gpt-5.5"), rank: GPT_55_RECENCY_RANK },
	{ test: (s) => s.includes("gpt-5.4"), rank: 100 },
	{ test: (s) => s.includes("gpt-5.3"), rank: 98 },
	{ test: (s) => s.includes("gpt-5.2"), rank: 96 },
	{ test: (s) => s.includes("gpt-5.1"), rank: 94 },
	{ test: (s) => s.includes("gpt-5") && !s.includes("5."), rank: 92 },
	{ test: (s) => s.includes("o4-mini"), rank: 91 },
	{ test: (s) => s.includes("o3-pro"), rank: 89 },
	{ test: (s) => s.includes("o3") && !s.includes("o3-mini"), rank: 88 },
	{ test: (s) => s.includes("o3-mini"), rank: 85 },
	{ test: (s) => s.includes("o1-pro"), rank: 80 },
	{ test: (s) => s.includes("o1") && !s.includes("o1-mini"), rank: 78 },
	{ test: (s) => s.includes("gpt-4o") && !s.includes("mini"), rank: 70 },
	{ test: (s) => s.includes("gpt-4.1"), rank: 68 },
	{ test: (s) => s.includes("gpt-4o-mini") || s.includes("gpt-4.1-mini"), rank: 65 },
	{ test: (s) => s.includes("gpt-4"), rank: 50 },

	// ── Google Gemini ──
	{ test: (s) => s.includes("gemini-3.1-pro"), rank: 100 },
	{ test: (s) => s.includes("gemini-3-pro"), rank: 98 },
	{ test: (s) => s.includes("gemini-3.1-flash") || s.includes("gemini-3-flash"), rank: 95 },
	{ test: (s) => s.includes("gemini-2.5-pro"), rank: 90 },
	{ test: (s) => s.includes("gemini-2.5-flash") && !s.includes("lite"), rank: 85 },
	{ test: (s) => s.includes("gemini-2.5-flash-lite"), rank: 80 },
	{ test: (s) => s.includes("gemini-2.0"), rank: 60 },
	{ test: (s) => s.includes("gemini-1.5"), rank: 40 },
	{ test: (s) => s.includes("gemini"), rank: 30 },

	// ── xAI Grok ──
	{ test: (s) => s.includes("grok-4"), rank: 100 },
	{ test: (s) => s.includes("grok-3") && !s.includes("mini"), rank: 90 },
	{ test: (s) => s.includes("grok-3-mini"), rank: 85 },
	{ test: (s) => s.includes("grok-2"), rank: 70 },
	{ test: (s) => s.includes("grok"), rank: 50 },

	// ── DeepSeek ──
	{ test: (s) => s.includes("deepseek-v3.2"), rank: 95 },
	{ test: (s) => s.includes("deepseek-v3.1"), rank: 90 },
	{ test: (s) => s.includes("deepseek-r1"), rank: 88 },
	{ test: (s) => s.includes("deepseek-v3"), rank: 85 },
	{ test: (s) => s.includes("deepseek"), rank: 50 },

	// ── Qwen ──
	{ test: (s) => s.includes("qwen3.5") || s.includes("qwen-3.5"), rank: 95 },
	{ test: (s) => s.includes("qwen3-coder") || s.includes("qwen-3-coder"), rank: 90 },
	{ test: (s) => s.includes("qwen3-next") || s.includes("qwen-3-next"), rank: 88 },
	{ test: (s) => s.includes("qwen3") || s.includes("qwen-3"), rank: 85 },
	{ test: (s) => s.includes("qwen"), rank: 50 },

	// ── Mistral ──
	{ test: (s) => s.includes("devstral-medium"), rank: 90 },
	{ test: (s) => s.includes("magistral"), rank: 88 },
	{ test: (s) => s.includes("devstral"), rank: 85 },
	{ test: (s) => s.includes("codestral"), rank: 80 },
	{ test: (s) => s.includes("mistral-large"), rank: 75 },
	{ test: (s) => s.includes("mistral-medium"), rank: 70 },
	{ test: (s) => s.includes("mistral"), rank: 50 },

	// ── Llama ──
	{ test: (s) => s.includes("llama-4") || s.includes("llama4"), rank: 90 },
	{ test: (s) => s.includes("llama-3.3") || s.includes("llama3-3"), rank: 80 },
	{ test: (s) => s.includes("llama-3.2") || s.includes("llama3-2"), rank: 70 },
	{ test: (s) => s.includes("llama"), rank: 50 },
];

/**
 * Rank a model ID by recency/quality tier. Higher = newer/better.
 * Used to auto-select the best model when no preference is set.
 * Canonical server-side copy — also used by session-manager for auto-selection.
 */
export function modelRecencyRank(id: string): number {
	const s = id.toLowerCase();
	for (const rule of RECENCY_RULES) {
		if (rule.test(s)) return typeof rule.rank === "function" ? rule.rank(s) : rule.rank;
	}
	return 0;
}

/**
 * Select which AI-Gateway-discovered model to auto-bind for a session,
 * factoring in the spawning role's thinking/cost tier (Finding
 * F5-model-aigw, Fable audit).
 *
 * Historically the aigw auto-select branch picked the single highest
 * `modelRecencyRank` model for EVERY session regardless of role — a
 * mechanical docs-only task burned the same newest/priciest model as an
 * architect. This is availability-safe by construction: it only ever
 * chooses among `models`, the set the gateway already reports as
 * discovered/configured, so it can never turn a working session into a
 * hard spawn failure the way binding a hardcoded literal `<provider>/<id>`
 * role.model default could on an install without that specific model.
 *
 * Only the `"low"` thinking tier (currently only `docs-writer`, see
 * `defaults/roles/docs-writer.yaml`) changes behavior: it gets the
 * lowest-ranked (oldest/cheapest) discovered model. Every other tier —
 * `"medium"`, `"high"`, and unset — keeps today's "always pick the
 * newest/best" behavior unchanged, to keep this fix's blast radius to the
 * one case the finding called out as unambiguously safe.
 */
export function selectAigwModelForRoleTier<T extends { id: string }>(
	models: readonly T[],
	roleThinkingLevel: string | undefined,
): T {
	const sorted = [...models].sort((a, b) => modelRecencyRank(a.id) - modelRecencyRank(b.id));
	return roleThinkingLevel === "low" ? sorted[0]! : sorted[sorted.length - 1]!;
}
