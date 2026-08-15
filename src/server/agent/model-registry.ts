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

import dns from "node:dns/promises";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
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

export interface CustomProviderConfig {
	id: string;
	name: string;
	type: "ollama" | "lmstudio" | "llama.cpp" | "vllm" | "manual" | "openai-images" | "gemini-images" | "google-imagen";
	baseUrl: string;
	/** Set only by the server's persisted custom-provider configuration route. */
	trusted?: boolean;
	apiKey?: string;
	models?: Array<{ id: string; name: string }>;
}

function providerHostnameForIpCheck(hostname: string): string {
	return hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

function isLoopbackProviderHost(hostname: string): boolean {
	const host = providerHostnameForIpCheck(hostname);
	return host === "localhost" || host.endsWith(".localhost") || host === "::1" || host.startsWith("127.");
}

/**
 * Canonicalize an endpoint before it becomes a model transport target. Plain HTTP
 * and private literals are useful for local model servers, but only a provider
 * record written by the server may opt into them.
 */
export function normalizeCustomProviderBaseUrl(raw: string, trusted = false): string {
	let url: URL;
	try { url = new URL(raw); }
	catch { throw new Error("Custom provider URL must be absolute"); }
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Custom provider URL must use HTTP or HTTPS");
	if (url.username || url.password || url.hash || url.search) throw new Error("Custom provider URL must not contain credentials, a query, or a fragment");
	const hostname = providerHostnameForIpCheck(url.hostname);
	const isLocal = isLoopbackProviderHost(hostname) || (net.isIP(hostname) !== 0 && !isPublicProviderIp(hostname));
	if (!trusted && (url.protocol !== "https:" || isLocal)) {
		throw new Error("Untrusted custom provider URL must use public HTTPS");
	}
	return url.href.replace(/\/$/, "");
}

function isPublicProviderIp(address: string): boolean {
	address = providerHostnameForIpCheck(address);
	const family = net.isIP(address);
	if (family === 4) {
		const octets = address.split(".").map(Number);
		if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
		const [a, b, c] = octets;
		if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
		if (a === 100 && b >= 64 && b <= 127) return false;
		if (a === 169 && b === 254) return false;
		if (a === 172 && b >= 16 && b <= 31) return false;
		if (a === 192 && b === 168) return false;
		if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
		if (a === 192 && b === 88 && c === 99) return false;
		if (a === 198 && (b === 18 || b === 19 || b === 51)) return false;
		if (a === 203 && b === 0 && c === 113) return false;
		return true;
	}
	if (family !== 6) return false;
	const lower = address.toLowerCase().split("%")[0];
	if (lower === "::" || lower === "::1") return false;
	if (/^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || /^ff/.test(lower)) return false;
	if (/^2001:db8(?:[:]|$)/.test(lower)) return false;
	return /^[23]/.test(lower);
}

interface PinnedProviderTarget {
	url: URL;
	lookup?: (...args: any[]) => void;
}

type ProviderDnsLookup = (hostname: string, options: { all: true; verbatim: true }) => Promise<Array<{ address: string; family: number }>>;
const CUSTOM_PROVIDER_DNS_TIMEOUT_MS = 5_000;

function lookupProviderBeforeDeadline(
	hostname: string,
	lookup: ProviderDnsLookup,
	deadline: number,
): Promise<Array<{ address: string; family: number }>> {
	const remaining = deadline - Date.now();
	if (remaining <= 0) return Promise.reject(new Error("Custom provider DNS deadline exceeded"));
	return new Promise((resolve, reject) => {
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			reject(new Error("Custom provider DNS deadline exceeded"));
		}, remaining);
		void lookup(hostname, { all: true, verbatim: true }).then(
			(addresses) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve(addresses);
			},
			(error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

/** Pin a custom-provider probe before its transport connects. Exported for focused DNS-admission tests. */
export async function pinCustomProviderTarget(
	raw: string,
	trusted: boolean,
	lookup: ProviderDnsLookup = dns.lookup,
	dnsTimeoutMs = CUSTOM_PROVIDER_DNS_TIMEOUT_MS,
): Promise<PinnedProviderTarget> {
	const url = new URL(normalizeCustomProviderBaseUrl(raw, trusted));
	const hostname = providerHostnameForIpCheck(url.hostname);
	if (net.isIP(hostname)) return { url };
	const deadline = Date.now() + Math.max(1, Math.min(dnsTimeoutMs, CUSTOM_PROVIDER_DNS_TIMEOUT_MS));
	const addresses = await lookupProviderBeforeDeadline(hostname, lookup, deadline);
	if (addresses.length === 0 || (!trusted && addresses.some(({ address }) => !isPublicProviderIp(address)))) {
		throw new Error("Custom provider DNS resolved to a private or invalid address");
	}
	return {
		url,
		// Connect to precisely the addresses just checked, not a later DNS answer.
		lookup: (_hostname: string, options: any, callback: any) => {
			const eligible = options?.family ? addresses.filter((entry) => entry.family === options.family) : addresses;
			if (eligible.length === 0) return callback(new Error("No validated provider address for requested family"));
			if (options?.all) return callback(null, eligible);
			return callback(null, eligible[0].address, eligible[0].family);
		},
	};
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
		const sourceKey = customSourceKey(config);
		let sourceModels: ApiModel[] | undefined;
		try {
			// Values read from PreferencesStore were persisted through the server's
			// custom-provider route. Treat pre-trust-marker records as migrated trusted
			// configuration, while preserving an explicit untrusted marker.
			sourceModels = await discoverFromSingleConfig({ ...config, trusted: config.trusted !== false });
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
	return {
		models: results.filter((model) => model.provider !== DEFERRED_SESSION_PROVIDER),
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
	try {
		return await discoverFromSingleConfig(config);
	} catch (err) {
		// Preserve the standalone discovery API's established empty-on-failure
		// contract. Registry assembly calls the throwing primitive below so it can
		// distinguish refresh failure from an authoritative empty response.
		console.error(`[model-registry] Failed to discover from ${config.name}:`, err);
		return [];
	}
}

async function discoverFromSingleConfig(config: CustomProviderConfig): Promise<ApiModel[]> {
	const baseUrl = normalizeCustomProviderBaseUrl(config.baseUrl, config.trusted === true);
	const trustedConfig = { ...config, baseUrl };
	switch (trustedConfig.type) {
		case "ollama":
			return discoverOllamaModelsServer(trustedConfig);
		case "lmstudio":
			return discoverLMStudioModelsServer(trustedConfig);
		case "llama.cpp":
		case "vllm":
			return discoverOpenAICompatModelsServer(trustedConfig);
		case "manual":
			return (trustedConfig.models || []).map(m => ({
				id: m.id,
				name: m.name || m.id,
				provider: trustedConfig.name || trustedConfig.id,
				api: "openai-completions" as const,
				baseUrl: `${trustedConfig.baseUrl}/v1`,
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
	// The SDK has no lookup hook. Admit DNS before construction so an untrusted
	// probe cannot turn a public HTTPS hostname into a private-network request.
	await pinCustomProviderTarget(config.baseUrl, config.trusted === true);
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
	// LM Studio's WebSocket SDK similarly owns its transport, so perform the
	// private-DNS admission check before it receives the endpoint.
	await pinCustomProviderTarget(config.baseUrl, config.trusted === true);
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
	const target = await pinCustomProviderTarget(`${config.baseUrl}/v1/models`, config.trusted === true);
	const data = await httpGetJson(target, config.apiKey, 5000);
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

function httpGetJson(target: PinnedProviderTarget, apiKey?: string, timeoutMs = 10_000): Promise<any> {
	return new Promise((resolve, reject) => {
		const transport = target.url.protocol === "https:" ? https : http;

		const headers: Record<string, string> = { "Content-Type": "application/json" };
		if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

		const req = transport.request(target.url, { method: "GET", headers, timeout: timeoutMs, ...(target.lookup ? { lookup: target.lookup } : {}) }, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (c: Buffer) => chunks.push(c));
			res.on("end", () => {
				const body = Buffer.concat(chunks).toString("utf-8");
				if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
					try { resolve(JSON.parse(body)); }
					catch { reject(new Error("Invalid JSON from custom provider")); }
				} else {
					reject(new Error(`HTTP ${res.statusCode} from custom provider`));
				}
			});
		});
		req.on("timeout", () => { req.destroy(); reject(new Error("Timeout fetching custom provider")); });
		req.on("error", reject);
		req.end();
	});
}

// ── Model Recency Ranking ──────────────────────────────────────────

// Preserve the server import path while using the browser-safe shared source.
export { GPT_55_RECENCY_RANK, modelRecencyRank } from "../../shared/model-ranks.js";
