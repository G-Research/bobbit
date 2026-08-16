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
import path from "node:path";
// Pi also exposes provider-scoped `Models` with async catalog refresh/auth.
// Bobbit intentionally stays on these synchronous static-catalog reads: its own
// registry composes that snapshot with AI Gateway and local-provider discovery,
// while credential refresh remains owned by the spawned coding-agent runtime.
import { getBuiltinProviders, getBuiltinModels, getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { PreferencesStore } from "./preferences-store.js";
import { globalAgentDir, globalAuthPath } from "../bobbit-dir.js";
import { discoverAigwModels, getAigwUrl } from "./aigw-manager.js";
import { inspectAigwTargetRealm, type AigwTargetRealm } from "./aigw-models-json.js";
import { getGoogleCodeAssistModels } from "./google-code-assist-models.js";
import { GOOGLE_GEMINI_CLI_PROVIDER, hasGoogleCodeAssistSpawnCredential } from "./google-code-assist.js";
import { isAnthropicApiKeyCredential, isUsableAnthropicOAuthCredential } from "../auth/credential-store.js";
import { runtimeFromProvider, type SessionRuntime } from "./session-runtime.js";
import {
	CLAUDE_AGENT_SDK_PROVIDER,
	getClaudeAgentSdkModels,
	isReservedClaudeAgentSdkProvider,
} from "./claude-agent-sdk-model-catalog.js";

// These Pi providers require credential/runtime integration Bobbit does not yet
// forward to host or sandbox agents. Keep the denylist provider-scoped so future
// catalog additions cannot accidentally make their models selectable.
const DEFERRED_SESSION_PROVIDER = "kimi-coding";

const UPSTREAM_ONLY_BUILTIN_PROVIDERS = new Set([
	"qwen-token-plan",
	"qwen-token-plan-cn",
	DEFERRED_SESSION_PROVIDER,
]);

function getBobbitBuiltInProviders(): ReturnType<typeof getBuiltinProviders> {
	return getBuiltinProviders().filter((provider) => !UPSTREAM_ONLY_BUILTIN_PROVIDERS.has(String(provider)));
}

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
	/** Derived from `provider`; emitted by the model registry, never selected by callers. */
	readonly runtime?: SessionRuntime;
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

/**
 * Resolve an exact provider/model tuple from Bobbit's current session catalog.
 * The provider comparison is deliberately exact: Kimi-named IDs remain valid
 * under supported AIGW, custom, local, Moonshot, and legacy gateway providers.
 */
export function findSessionSelectableModel(
	models: readonly ApiModel[],
	provider: string,
	modelId: string,
): ApiModel | undefined {
	if (provider === DEFERRED_SESSION_PROVIDER) return undefined;
	return models.find((model) =>
		model.provider === provider
		&& model.id === modelId
		&& model.sessionSelectable !== false,
	);
}

/** Attach the runtime projection at catalog API boundaries without mutating source metadata. */
function withDerivedRuntime<T extends { provider: string }>(model: T): T & { readonly runtime: SessionRuntime } {
	return { ...model, runtime: runtimeFromProvider(model.provider) };
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
let cachedDynamicModels = new Map<string, ApiModel[]>();
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
	cachedDynamicModels = new Map();
	cacheExpiry = 0;
}

// ── Live model-state metadata resolver ─────────────────────────────

/**
 * The subset of model metadata that the live per-session `state.model` frame
 * carries to the client. Kept intentionally narrow — this is what the context
 * bar and thinking selector consume.
 */
export interface ResolvedModelStateMeta {
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
	/** Present only when authoritative metadata provides it. */
	thinkingLevelMap?: Record<string, string | null>;
	input?: ("text" | "image")[];
	/** `unavailable` carries identity only; callers must not fabricate capabilities. */
	source: "cache" | "catalog" | "unavailable";
}

/**
 * Resolve authoritative metadata for a live model-state frame.
 *
 * The last assembled cache is checked first, even after its TTL, so temporary
 * custom/AIGW discovery failures do not discard trustworthy metadata. Direct Pi
 * providers then use the exact built-in row. Unknown tuples are explicitly
 * unavailable and carry no guessed capability fields.
 */
export function resolveModelStateMeta(provider: string | undefined, modelId: string): ResolvedModelStateMeta {
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

	const normalizedProvider = (provider ?? "").toLowerCase();
	if (normalizedProvider && normalizedProvider !== "aigw" && normalizedProvider !== "custom") {
		try {
			const model = getBuiltinModel(normalizedProvider as any, modelId as any);
			if (model) {
				return {
					contextWindow: model.contextWindow,
					maxTokens: model.maxTokens,
					reasoning: model.reasoning,
					...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap as Record<string, string | null> } : {}),
					input: model.input as ("text" | "image")[],
					source: "catalog",
				};
			}
		} catch {
			// Unknown provider/id is represented conservatively below.
		}
	}

	return { source: "unavailable" };
}

/**
 * Get all available models, merged from all sources.
 * Results are cached for 5 seconds.
 */
export function getBuiltInProviderIds(): string[] {
	return getBobbitBuiltInProviders().map((provider) => String(provider));
}

/**
 * Return the last successfully assembled catalog without triggering provider
 * discovery. Hot session/audit routes use this best-effort snapshot: on a cold
 * cache (or after a failed refresh), absence is intentionally unknown rather
 * than incorrectly reported as an unavailable saved model.
 */
export function peekCachedAvailableModels(): readonly ApiModel[] | undefined {
	return cachedModels ?? undefined;
}

export async function getAvailableModels(prefs: PreferencesStore): Promise<ApiModel[]> {
	const now = Date.now();
	const currentVersion = getPrefsVersion(prefs);
	if (cachedModels && now < cacheExpiry && currentVersion === cacheConfigVersion) {
		return cachedModels;
	}

	const result = await assembleModels(prefs, cachedDynamicModels);
	cachedModels = result.models;
	cachedDynamicModels = result.dynamicModels;
	cacheExpiry = now + 5000;
	cacheConfigVersion = currentVersion;
	return result.models;
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

function comparableAigwUrl(value: unknown): string | undefined {
	if (typeof value !== "string" || !value.trim()) return undefined;
	try {
		const url = new URL(value.trim());
		if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
		return url.href.replace(/\/+$/, "");
	} catch {
		return undefined;
	}
}

interface ComposedAigwModels {
	/** A structurally valid target source exists; an empty model list is authoritative. */
	available: boolean;
	models: ApiModel[];
}

/**
 * Load the exact model rows Pi composes from the active models.json. This keeps
 * defaults, overrides, compatibility merging, and duplicate-ID behavior owned
 * by Pi rather than reproducing another metadata composer in Bobbit.
 */
async function composeAigwTargetModels(
	provider: Record<string, unknown>,
	preservePublishedProvenance = false,
): Promise<ComposedAigwModels> {
	try {
		const runtime = await ModelRuntime.create({
			modelsPath: path.join(globalAgentDir(), "models.json"),
			authPath: globalAuthPath(),
			allowModelNetwork: false,
		});
		if (runtime.getError()) return { available: false, models: [] };
		const published = new Map<string, string>();
		if (preservePublishedProvenance && Array.isArray(provider.models)) {
			for (const definition of provider.models) {
				if (
					definition && typeof definition === "object"
					&& typeof (definition as any).id === "string"
					&& typeof (definition as any).upstreamProvider === "string"
				) published.set((definition as any).id, (definition as any).upstreamProvider);
			}
		}
		const models = runtime.getModels()
			.filter((model) => model.provider === "aigw")
			.map((model) => {
				const row = { ...model, authenticated: true } as ApiModel & { samplingParams?: unknown };
				if (row.headers === undefined) delete row.headers;
				// Pi 0.84's ModelRuntime materializes this optional field as an
				// enumerable undefined value. Keep retained/discovered rows JSON-exact.
				if (row.samplingParams === undefined) delete row.samplingParams;
				const upstreamProvider = published.get(row.id);
				if (upstreamProvider) row.upstreamProvider = upstreamProvider;
				return row;
			});
		return { available: true, models };
	} catch {
		return { available: false, models: [] };
	}
}

/** Read and classify models.json without normalizing or writing user-owned bytes. */
function readAigwTargetRealm(): AigwTargetRealm {
	try {
		const modelsPath = path.join(globalAgentDir(), "models.json");
		const source = fs.existsSync(modelsPath) ? fs.readFileSync(modelsPath, "utf-8") : undefined;
		return inspectAigwTargetRealm(source);
	} catch (error) {
		return { kind: "invalid", reason: error instanceof Error ? error.message : String(error) };
	}
}

async function readManagedRetainedAigwModels(
	configuredUrl: string,
	realm: Extract<AigwTargetRealm, { kind: "managed" }>,
): Promise<ComposedAigwModels> {
	const activeUrl = comparableAigwUrl(configuredUrl);
	const retainedUrl = comparableAigwUrl(realm.provider.baseUrl);
	if (!activeUrl || !retainedUrl || retainedUrl !== activeUrl) return { available: false, models: [] };
	return composeAigwTargetModels(realm.provider, true);
}

interface AssembledModelCatalog {
	models: ApiModel[];
	/** Exact rows grouped by their unchanged refresh identity for failure-only retention. */
	dynamicModels: Map<string, ApiModel[]>;
}

function customSourceKey(config: CustomProviderConfig): string {
	return `custom:${JSON.stringify([
		config.id,
		config.name,
		config.type,
		config.baseUrl,
		config.apiKey,
		config.models?.map((model) => [model.id, model.name]),
	])}`;
}

async function assembleModels(
	prefs: PreferencesStore,
	previousDynamicModels: ReadonlyMap<string, ApiModel[]>,
): Promise<AssembledModelCatalog> {
	const results: ApiModel[] = [];
	const dynamicModels = new Map<string, ApiModel[]>();
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
			const providers = getBobbitBuiltInProviders();
			for (const providerId of providers) {
				const models = getBuiltinModels(providerId as any);
				const isAuth = detectProviderAuth(providerId as string, prefs);
				for (const m of models) {
					results.push({
						...m,
						provider: providerId as string,
						authenticated: isAuth,
					} as ApiModel);
				}
			}
		} catch (err) {
			console.error("[model-registry] Failed to load built-in providers:", err);
		}

		// 1a. Claude Agent SDK exposes its own stable aliases. These are separate
		// from direct Pi Anthropic rows: only a complete, unrejected Anthropic OAuth
		// credential authenticates the SDK, and its aliases retain Pi's canonical
		// display/capability/cost fields without using canonical IDs for selection.
		try {
			const credential = readAuthJson()?.anthropic;
			results.push(...getClaudeAgentSdkModels(
				isUsableAnthropicOAuthCredential(globalAuthPath(), credential),
			));
		} catch (err) {
			console.error("[model-registry] Failed to load Claude Agent SDK aliases:", err);
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

	// 2. AI Gateway models (if configured). Selection reflects the provider Pi
	// will actually load: an unmarked user block is authoritative over discovery,
	// while malformed/ambiguous target configuration fails closed.
	if (aigwUrl) {
		const sourceKey = `aigw:${comparableAigwUrl(aigwUrl) ?? aigwUrl}`;
		const targetRealm = readAigwTargetRealm();
		let sourceModels: ApiModel[] | undefined;
		if (targetRealm.kind === "unmarked-user") {
			const composed = await composeAigwTargetModels(targetRealm.provider);
			sourceModels = composed.available ? composed.models : [];
		} else if (targetRealm.kind === "invalid") {
			console.error(`[model-registry] AIGW target realm is unavailable: ${targetRealm.reason}`);
			sourceModels = [];
		} else {
			try {
				const aigwModels = await discoverAigwModels(aigwUrl);
				sourceModels = [];
				for (const m of aigwModels) {
					if (!m.baseUrl || !m.cost) {
						console.error(`[model-registry] Omitting incomplete AIGW metadata for ${m.id}`);
						continue;
					}
					sourceModels.push({
						id: m.wireId ?? m.id,
						name: m.name,
						provider: "aigw",
						...(m.upstreamProvider ? { upstreamProvider: m.upstreamProvider } : {}),
						api: m.api,
						baseUrl: m.baseUrl,
						contextWindow: m.contextWindow,
						maxTokens: m.maxTokens,
						reasoning: m.reasoning,
						...(m.thinkingLevelMap ? { thinkingLevelMap: m.thinkingLevelMap } : {}),
						input: m.input,
						cost: m.cost,
						...(m.compat ? { compat: m.compat } : {}),
						authenticated: true,
					});
				}
			} catch (err) {
				console.error("[model-registry] Failed to discover AI Gateway models:", err);
				// Only Bobbit's marked publication can backstop its discovery source.
				// An absent target keeps the prior exact discovery snapshot; user-owned
				// targets were handled above and can never be bypassed by that cache.
				const retained = targetRealm.kind === "managed"
					? await readManagedRetainedAigwModels(aigwUrl, targetRealm)
					: { available: false, models: [] };
				sourceModels = retained.available ? retained.models : previousDynamicModels.get(sourceKey);
			}
		}
		if (sourceModels) {
			if (targetRealm.kind === "managed" || targetRealm.kind === "absent") {
				dynamicModels.set(sourceKey, sourceModels);
			}
			results.push(...sourceModels);
		}
	}

	// 3. Custom local providers. Each configured source reports failure separately,
	// so a successful empty catalog removes old rows while a transport failure can
	// retain the complete prior exact rows for that unchanged source only.
	const configs = (prefs.get("customProviders") as CustomProviderConfig[] | undefined) || [];
	for (const config of configs) {
		// The built-in Agent SDK aliases are the sole owner of this namespace.
		// Never permit a custom config (including old persisted configs) to emit
		// canonical Claude IDs as SDK selections.
		if (isReservedClaudeAgentSdkProvider(config.id) || isReservedClaudeAgentSdkProvider(config.name)) continue;
		const sourceKey = customSourceKey(config);
		let sourceModels: ApiModel[] | undefined;
		try {
			sourceModels = await discoverFromSingleConfig(config);
		} catch (err) {
			console.error(`[model-registry] Failed to discover from ${config.name}:`, err);
			sourceModels = previousDynamicModels.get(sourceKey);
		}
		if (sourceModels) {
			const selectableModels = sourceModels.filter((model) => model.provider !== DEFERRED_SESSION_PROVIDER);
			dynamicModels.set(sourceKey, selectableModels);
			results.push(...selectableModels);
		}
	}

	// Enforce the exact deferred-provider boundary across every catalog source.
	// Dynamic source snapshots deliberately stay raw: they remain the authority for
	// failure-only metadata retention, while runtime is an API-boundary projection.
	return {
		models: results
			.filter((model) => model.provider !== DEFERRED_SESSION_PROVIDER)
			.map(withDerivedRuntime),
		dynamicModels,
	};
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
	// Anthropic is stricter: Pi requires a renewable OAuth row, while API keys
	// retain their established, independent authentication path.
	if (OAUTH_AUTHENTICATED_PROVIDERS.has(provider) && hasOAuthCredentials(provider)) return true;

	return false;
}

// ── OAuth Detection ────────────────────────────────────────────────

let oauthCache: { data: any; expiry: number } | null = null;
const OAUTH_CACHE_TTL = 10_000; // 10 seconds

/** Invalidate credential-derived auth and model availability after every durable auth change. */
export function clearOAuthCache(): void {
	oauthCache = null;
	// `cachedModels` contains the computed authenticated flag. A rejected or
	// logged-out OAuth row must therefore invalidate both layers immediately.
	invalidateModelCache();
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

		if (provider === "anthropic") {
			const credential = authData[provider];
			return isUsableAnthropicOAuthCredential(globalAuthPath(), credential) || isAnthropicApiKeyCredential(credential);
		}

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
	if (isReservedClaudeAgentSdkProvider(config.id) || isReservedClaudeAgentSdkProvider(config.name)) return [];
	try {
		return (await discoverFromSingleConfig(config))
			.filter((model) => model.provider !== CLAUDE_AGENT_SDK_PROVIDER)
			.map(withDerivedRuntime);
	} catch (err) {
		// Preserve the standalone discovery API's established empty-on-failure
		// contract. Registry assembly calls the throwing primitive below so it can
		// distinguish refresh failure from an authoritative empty response.
		console.error(`[model-registry] Failed to discover from ${config.name}:`, err);
		return [];
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
	const { Ollama } = await import("ollama");
	const ollama = new Ollama({ host: config.baseUrl });
	const { models } = await ollama.list();

	const results: ApiModel[] = [];
	let inspectionError: unknown;
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
		} catch (err) {
			// A partial inspection is not an authoritative source refresh. Preserve
			// the prior complete source snapshot rather than silently deleting rows.
			inspectionError ??= err;
		}
	}
	if (inspectionError) throw inspectionError;
	return results;
}

async function discoverLMStudioModelsServer(config: CustomProviderConfig): Promise<ApiModel[]> {
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
}

async function discoverOpenAICompatModelsServer(config: CustomProviderConfig): Promise<ApiModel[]> {
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

// Preserve the server import path while using the browser-safe shared source.
export { GPT_55_RECENCY_RANK, modelRecencyRank } from "../../shared/model-ranks.js";
