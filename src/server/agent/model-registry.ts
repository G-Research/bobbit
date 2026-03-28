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
import { getProviders, getModels } from "@mariozechner/pi-ai";
import type { PreferencesStore } from "./preferences-store.js";
import { globalAuthPath } from "../bobbit-dir.js";
import { inferMeta, discoverAigwModels, getAigwUrl } from "./aigw-manager.js";

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
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	authenticated: boolean;
}

export interface CustomProviderConfig {
	id: string;
	name: string;
	type: "ollama" | "lmstudio" | "llama.cpp" | "vllm" | "manual";
	baseUrl: string;
	apiKey?: string;
	models?: Array<{ id: string; name: string }>;
}

// ── Cache ──────────────────────────────────────────────────────────

let cachedModels: ApiModel[] | null = null;
let cacheExpiry = 0;
let cacheConfigVersion = 0;

/**
 * Get all available models, merged from all sources.
 * Results are cached for 5 seconds.
 */
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
		all["customProviders"],
		...Object.keys(all).filter(k => k.startsWith("providerKey.")).sort(),
	]);
	for (let i = 0; i < str.length; i++) {
		hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
	}
	return hash;
}

// ── Model Assembly ─────────────────────────────────────────────────

async function assembleModels(prefs: PreferencesStore): Promise<ApiModel[]> {
	const results: ApiModel[] = [];

	// 1. Built-in providers from pi-ai
	try {
		const providers = getProviders();
		for (const providerId of providers) {
			const models = getModels(providerId as any);
			const isAuth = detectProviderAuth(providerId as string, prefs);
			for (const m of models) {
				const meta = inferMeta(m.id);
				results.push({
					id: m.id,
					name: m.name,
					provider: providerId as string,
					api: m.api as string,
					baseUrl: m.baseUrl,
					contextWindow: Math.max(meta.contextWindow, m.contextWindow || 0),
					maxTokens: Math.max(meta.maxTokens, m.maxTokens || 0),
					reasoning: meta.reasoning || m.reasoning || false,
					input: (meta.input && meta.input.length > (m.input?.length || 0)) ? meta.input : (m.input || ["text"]) as ("text" | "image")[],
					cost: m.cost || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					authenticated: isAuth,
				});
			}
		}
	} catch (err) {
		console.error("[model-registry] Failed to load built-in providers:", err);
	}

	// 2. AI Gateway models (if configured)
	const aigwUrl = getAigwUrl(prefs);
	if (aigwUrl) {
		try {
			const aigwModels = await discoverAigwModels(aigwUrl);
			for (const m of aigwModels) {
				const meta = inferMeta(m.id);
				results.push({
					id: m.id,
					name: m.name,
					provider: "aigw",
					api: m.api || "openai-completions",
					baseUrl: aigwUrl,
					contextWindow: Math.max(meta.contextWindow, m.contextWindow || 0),
					maxTokens: Math.max(meta.maxTokens, m.maxTokens || 0),
					reasoning: meta.reasoning || m.reasoning || false,
					input: meta.input || ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
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
	"google-gemini-cli": "GOOGLE_API_KEY",
	"google-vertex": "GOOGLE_APPLICATION_CREDENTIALS",
	"xai": "XAI_API_KEY",
	"amazon-bedrock": "AWS_ACCESS_KEY_ID",
	"groq": "GROQ_API_KEY",
	"mistral": "MISTRAL_API_KEY",
};

function detectProviderAuth(provider: string, prefs: PreferencesStore): boolean {
	// Check provider key in preferences (migrated from IndexedDB)
	const storedKey = prefs.get(`providerKey.${provider}`) as string | undefined;
	if (storedKey) return true;

	// Check env vars
	const envVar = ENV_MAP[provider];
	if (envVar && process.env[envVar]) return true;

	// Check OAuth credentials (auth.json)
	if (hasOAuthCredentials(provider)) return true;

	return false;
}

// ── OAuth Detection ────────────────────────────────────────────────

let oauthCache: { data: any; expiry: number } | null = null;
const OAUTH_CACHE_TTL = 10_000; // 10 seconds

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

/**
 * Rank a model ID by recency/quality tier. Higher = newer/better.
 * Used to auto-select the best model when no preference is set.
 * Canonical server-side copy — also used by session-manager for auto-selection.
 */
export function modelRecencyRank(id: string): number {
	const s = id.toLowerCase();
	// Anthropic Claude
	if (s.includes("claude-opus-4-6") || s.includes("claude-opus-4.6")) return 100;
	if (s.includes("claude-sonnet-4-6") || s.includes("claude-sonnet-4.6")) return 99;
	if (s.includes("claude-opus-4-5") || s.includes("claude-opus-4.5")) return 98;
	if (s.includes("claude-sonnet-4-5") || s.includes("claude-sonnet-4.5")) return 97;
	if (s.includes("claude-sonnet-4") && !s.includes("4-5") && !s.includes("4.5") && !s.includes("4-6") && !s.includes("4.6")) return 94;
	if (s.includes("claude-haiku-4-5") || s.includes("claude-haiku-4.5")) return 90;
	if (s.includes("claude")) return 50;
	// OpenAI
	if (s.includes("gpt-5.4")) return 100;
	if (s.includes("gpt-5.3")) return 98;
	if (s.includes("gpt-5.2")) return 96;
	if (s.includes("gpt-5") && !s.includes("5.")) return 92;
	if (s.includes("o4-mini")) return 91;
	if (s.includes("o3") && !s.includes("o3-mini")) return 88;
	if (s.includes("gpt-4o") && !s.includes("mini")) return 70;
	if (s.includes("gpt-4")) return 50;
	// Gemini
	if (s.includes("gemini-3.1-pro") || s.includes("gemini-3-pro")) return 98;
	if (s.includes("gemini-2.5-pro")) return 90;
	if (s.includes("gemini")) return 30;
	// Grok
	if (s.includes("grok-4")) return 100;
	if (s.includes("grok-3") && !s.includes("mini")) return 90;
	if (s.includes("grok")) return 50;
	// DeepSeek
	if (s.includes("deepseek-r1")) return 88;
	if (s.includes("deepseek-v3")) return 85;
	if (s.includes("deepseek")) return 50;
	// Qwen
	if (s.includes("qwen3-coder") || s.includes("qwen-3-coder")) return 90;
	if (s.includes("qwen3") || s.includes("qwen-3")) return 85;
	if (s.includes("qwen")) return 50;
	// Mistral
	if (s.includes("devstral")) return 85;
	if (s.includes("codestral")) return 80;
	if (s.includes("mistral")) return 50;
	// Llama
	if (s.includes("llama-4") || s.includes("llama4")) return 90;
	if (s.includes("llama")) return 50;
	return 0;
}
