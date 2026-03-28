/**
 * AI Gateway (aigw) manager — handles model discovery, models.json generation,
 * and HTTP proxying for browser-side API access.
 *
 * When the user configures an aigw URL in preferences:
 * 1. Server fetches available models from the gateway's /v1/models endpoint
 * 2. Server writes/merges an "aigw" provider into ~/.pi/agent/models.json
 *    so agent subprocesses can use `set_model` with provider="aigw"
 * 3. Browser discovers models via server proxy (the aigw hostname may not
 *    resolve from the browser)
 *
 * When aigw is removed, the "aigw" provider is cleaned from models.json.
 */

import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import type { PreferencesStore } from "./preferences-store.js";

// ── Types ──────────────────────────────────────────────────────────

export interface AigwModel {
	id: string;
	name: string;
	api: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	contextWindow: number;
	maxTokens: number;
	compat?: Record<string, unknown>;
}

export interface AigwConfig {
	url: string;
	models: AigwModel[];
}

// ── Well-known model metadata ──────────────────────────────────────

interface ModelMeta {
	contextWindow: number;
	maxTokens: number;
	reasoning: boolean;
	input: ("text" | "image")[];
	compat?: Record<string, unknown>;
}

/**
 * Rank a model ID by recency/quality tier. Higher = newer/better.
 * Used to auto-select the best aigw model when no preference is set.
 * Keep in sync with modelRecencyRank() in ModelSelector.ts.
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

const DEFAULT_META: ModelMeta = {
	contextWindow: 128_000,
	maxTokens: 16_384,
	reasoning: false,
	input: ["text"],
};

/**
 * Infer model metadata from the model ID.
 * Patterns are matched greedily — first match wins.
 */
/**
 * Compat flags for the openai-completions provider in pi-ai.
 * These control which OpenAI API features are used in requests.
 * Gateway proxies often don't support the full OpenAI API surface,
 * so we disable features that cause errors.
 */
const GATEWAY_COMPAT: Record<string, unknown> = {
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsUsageInStreaming: false,
	supportsReasoningEffort: false,
	supportsStrictMode: false,
	maxTokensField: "max_tokens",
};

export function inferMeta(modelId: string): ModelMeta {
	const id = modelId.toLowerCase();

	// Anthropic models (via Bedrock or direct)
	if (id.includes("claude-opus")) {
		return { contextWindow: 1_000_000, maxTokens: 32_768, reasoning: true, input: ["text", "image"], compat: GATEWAY_COMPAT };
	}
	if (id.includes("claude-sonnet")) {
		return { contextWindow: 1_000_000, maxTokens: 16_384, reasoning: true, input: ["text", "image"], compat: GATEWAY_COMPAT };
	}
	if (id.includes("claude-haiku")) {
		return { contextWindow: 200_000, maxTokens: 8_192, reasoning: false, input: ["text", "image"], compat: GATEWAY_COMPAT };
	}
	if (id.includes("claude")) {
		return { contextWindow: 200_000, maxTokens: 16_384, reasoning: false, input: ["text", "image"], compat: GATEWAY_COMPAT };
	}

	// OpenAI models
	if (id.includes("gpt-5")) {
		return { contextWindow: 400_000, maxTokens: 32_768, reasoning: false, input: ["text", "image"], compat: GATEWAY_COMPAT };
	}
	if (id.includes("o4-mini") || id.includes("o3-mini") || id.includes("o1-mini")) {
		return { contextWindow: 200_000, maxTokens: 65_536, reasoning: true, input: ["text"], compat: GATEWAY_COMPAT };
	}
	if (id.includes("o4") || id.includes("o3") || id.includes("o1")) {
		return { contextWindow: 200_000, maxTokens: 100_000, reasoning: true, input: ["text", "image"], compat: GATEWAY_COMPAT };
	}
	if (id.includes("gpt-4")) {
		return { contextWindow: 128_000, maxTokens: 16_384, reasoning: false, input: ["text", "image"], compat: GATEWAY_COMPAT };
	}

	// Qwen models
	if (id.includes("qwen")) {
		return { contextWindow: 1_000_000, maxTokens: 32_768, reasoning: false, input: ["text"], compat: GATEWAY_COMPAT };
	}

	return { ...DEFAULT_META, compat: GATEWAY_COMPAT };
}

/**
 * Derive a short display name from a full gateway model ID.
 * e.g. "aws/us.anthropic.claude-sonnet-4-6" → "Claude Sonnet 4.6 (aws)"
 */
function deriveName(modelId: string): string {
	const parts = modelId.split("/");
	const prefix = parts.length > 1 ? parts[0] : undefined;
	const raw = parts[parts.length - 1];

	// Try to prettify common patterns
	let name = raw
		.replace(/^us\.anthropic\./, "")
		.replace(/^anthropic\./, "")
		.replace(/-v\d+:?\d*$/, "")     // strip version suffixes like -v1:0
		.replace(/-(\d{8})$/, "")        // strip date suffixes like -20250929
		.split("-")
		.map(s => s.charAt(0).toUpperCase() + s.slice(1))
		.join(" ");

	if (prefix && prefix !== name.toLowerCase()) {
		name += ` (${prefix})`;
	}
	return name;
}

// ── models.json management ─────────────────────────────────────────

function getModelsJsonPath(): string {
	const envDir = process.env.PI_CODING_AGENT_DIR;
	let agentDir: string;
	if (envDir) {
		if (envDir === "~") agentDir = os.homedir();
		else if (envDir.startsWith("~/")) agentDir = os.homedir() + envDir.slice(1);
		else agentDir = envDir;
	} else {
		agentDir = path.join(os.homedir(), ".pi", "agent");
	}
	return path.join(agentDir, "models.json");
}

function readModelsJson(): Record<string, any> {
	const p = getModelsJsonPath();
	try {
		if (fs.existsSync(p)) {
			return JSON.parse(fs.readFileSync(p, "utf-8"));
		}
	} catch (err) {
		console.error("[aigw-manager] Failed to read models.json:", err);
	}
	return { providers: {} };
}

function writeModelsJson(data: Record<string, any>): void {
	const p = getModelsJsonPath();
	try {
		const dir = path.dirname(p);
		if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
		const tmp = p + ".tmp";
		fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
		fs.renameSync(tmp, p);
		console.log(`[aigw-manager] Wrote models.json to ${p}`);
	} catch (err) {
		console.error("[aigw-manager] Failed to write models.json:", err);
	}
}

/**
 * Parse model IDs from pi-ai's models.generated.js, grouped by provider.
 * Reads the file as text and extracts id+provider pairs via regex.
 */
function parseModelsGenerated(): Map<string, string[]> {
	const providerModels = new Map<string, string[]>();
	try {
		const pkgUrl = import.meta.resolve("@mariozechner/pi-ai");
		const pkgDir = path.dirname(fileURLToPath(pkgUrl));
		const modelsPath = path.join(pkgDir, "models.generated.js");
		const text = fs.readFileSync(modelsPath, "utf-8");

		// The file has entries like:
		//   "some-model-id": {
		//       id: "some-model-id",
		//       ...
		//       provider: "amazon-bedrock",
		// We extract (id, provider) pairs.
		const entryRegex = /"([^"]+)":\s*\{[^}]*?provider:\s*"([^"]+)"/g;
		let match: RegExpExecArray | null;
		while ((match = entryRegex.exec(text)) !== null) {
			const modelId = match[1];
			const provider = match[2];
			if (!providerModels.has(provider)) providerModels.set(provider, []);
			providerModels.get(provider)!.push(modelId);
		}
	} catch (err) {
		console.error("[aigw-manager] Failed to parse models.generated.js:", err);
	}
	return providerModels;
}

/**
 * Write contextWindow overrides to models.json for all Claude models where
 * inferMeta() returns a larger context window than the built-in 200k.
 *
 * This fixes the 200k compaction bug: pi-ai hardcodes contextWindow: 200000
 * for all Claude models, but Sonnet/Opus actually support 1M tokens.
 * The modelOverrides in models.json tell pi-coding-agent to use the correct value.
 *
 * Preserves existing user modelOverrides — only sets contextWindow if the user
 * hasn't already overridden it for that model.
 */
export function writeContextWindowOverrides(): void {
	const providerModels = parseModelsGenerated();
	const targetProviders = ["amazon-bedrock", "anthropic"];

	const data = readModelsJson();
	if (!data.providers) data.providers = {};

	let overridesWritten = 0;

	for (const provider of targetProviders) {
		const modelIds = providerModels.get(provider) || [];
		const claudeIds = modelIds.filter(id => id.toLowerCase().includes("claude"));

		if (claudeIds.length === 0) continue;

		if (!data.providers[provider]) data.providers[provider] = {};
		if (!data.providers[provider].modelOverrides) data.providers[provider].modelOverrides = {};

		const overrides = data.providers[provider].modelOverrides;

		for (const modelId of claudeIds) {
			const meta = inferMeta(modelId);
			if (meta.contextWindow > 200_000) {
				// Don't clobber existing user contextWindow override
				if (overrides[modelId]?.contextWindow !== undefined) continue;

				if (!overrides[modelId]) overrides[modelId] = {};
				overrides[modelId].contextWindow = meta.contextWindow;
				overridesWritten++;
			}
		}
	}

	if (overridesWritten > 0) {
		writeModelsJson(data);
		console.log(`[aigw-manager] Wrote ${overridesWritten} contextWindow overrides to models.json`);
	} else {
		console.log("[aigw-manager] No contextWindow overrides needed");
	}
}

/**
 * Write aigw models into ~/.pi/agent/models.json, merging with existing
 * providers (preserving non-aigw entries).
 */
/**
 * Set env vars so agent subprocesses route Bedrock calls through the gateway.
 * Called both on fresh configuration and on startup when aigw is already configured.
 */
function setBedrockEnvVars(aigwUrl: string): void {
	const bedrockBaseUrl = aigwUrl.replace(/\/+$/, "").replace(/\/v1$/, "") + "/aws";
	process.env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME = bedrockBaseUrl;
	process.env.AWS_BEDROCK_FORCE_HTTP1 = "1";
	delete process.env.AWS_BEDROCK_SKIP_AUTH;  // pi-ai would override creds with wrong dummy values
	process.env.AWS_ACCESS_KEY_ID = "anything";
	process.env.AWS_SECRET_ACCESS_KEY = "anything";
	if (!process.env.AWS_REGION) process.env.AWS_REGION = "us-east-1";
	console.log(`[aigw] Bedrock env configured: endpoint=${bedrockBaseUrl}`);
}

export function writeAigwModelsJson(aigwUrl: string, models: AigwModel[]): void {
	const data = readModelsJson();
	if (!data.providers) data.providers = {};

	// AI gateways typically expose both OpenAI-compatible and Bedrock endpoints.
	// Route Claude models through the Bedrock Converse API (same path as Claude
	// Code) for full feature parity — native tool use, images, streaming.
	// Non-Claude models use OpenAI completions with conservative compat.
	const normalizedUrl = aigwUrl.replace(/\/+$/, "");
	const bedrockBaseUrl = normalizedUrl.replace(/\/v1$/, "") + "/aws";

	const openaiCompat: Record<string, unknown> = {
		supportsDeveloperRole: false,
		supportsStore: false,
		supportsUsageInStreaming: false,
		supportsReasoningEffort: false,
		supportsStrictMode: false,
		maxTokensField: "max_tokens",
	};

	const isClaudeModel = (id: string) => id.toLowerCase().includes("claude");

	// Strip provider prefix for Bedrock (e.g. "aws/us.anthropic.claude-..." → "us.anthropic.claude-...")
	const bedrockModelId = (id: string) => {
		const slash = id.indexOf("/");
		return slash >= 0 ? id.slice(slash + 1) : id;
	};

	data.providers.aigw = {
		baseUrl: normalizedUrl,
		apiKey: "none",
		api: "openai-completions",
		models: models.map(m => {
			if (isClaudeModel(m.id)) {
				return {
					id: bedrockModelId(m.id),
					name: m.name,
					contextWindow: m.contextWindow,
					maxTokens: m.maxTokens,
					reasoning: m.reasoning,
					input: m.input,
					api: "bedrock-converse-stream",
					...(m.compat ? { compat: m.compat } : {}),
				};
			}
			return {
				id: m.id,
				name: m.name,
				contextWindow: m.contextWindow,
				maxTokens: m.maxTokens,
				reasoning: m.reasoning,
				input: m.input,
				compat: { ...openaiCompat, ...(m.compat || {}) },
			};
		}),
	};

	setBedrockEnvVars(aigwUrl);

	writeModelsJson(data);
}

/**
 * Remove the "aigw" provider from models.json.
 */
export function removeAigwModelsJson(): void {
	const data = readModelsJson();
	if (data.providers?.aigw) {
		delete data.providers.aigw;
		writeModelsJson(data);
	}
}

// ── Startup internet check ─────────────────────────────────────────

/**
 * One-shot internet check at gateway startup. Tries HEAD requests to
 * well-known LLM API endpoints. Returns true if any responds.
 * Called once — not repeated after startup.
 */
export async function checkInternetAvailable(): Promise<boolean> {
	const targets = [
		"https://api.anthropic.com",
		"https://api.openai.com",
	];

	try {
		await Promise.any(targets.map((t) => httpHead(t, 4_000)));
		return true;
	} catch {
		return false;
	}
}

/**
 * Run once at gateway startup:
 * - If aigw is already configured, nothing to do.
 * - If not configured but internet is unavailable, try to auto-discover
 *   a gateway at a well-known local URL and configure it.
 *
 * Returns true if aigw is active after this call.
 */
export async function startupAigwCheck(prefs: PreferencesStore): Promise<boolean> {
	// Already configured — ensure env vars are set and models.json is up to date
	const existingUrl = getAigwUrl(prefs);
	if (existingUrl) {
		console.log("[aigw] AI Gateway already configured:", existingUrl);
		setBedrockEnvVars(existingUrl);
		return true;
	}

	// Check internet
	const hasInternet = await checkInternetAvailable();
	if (hasInternet) {
		console.log("[aigw] Internet available — using standard providers");
		return false;
	}

	console.log("[aigw] No internet detected — probing for local AI Gateway...");

	// Try well-known local gateway URLs
	const candidates = [
		"http://aigw-local.c3.zone/v1",
		"http://aigw-local.c3.zone",
		"http://localhost:1111/v1",
		"http://127.0.0.1:1111/v1",
	];

	for (const url of candidates) {
		try {
			const models = await discoverAigwModels(url);
			if (models.length > 0) {
				console.log(`[aigw] Found gateway at ${url} with ${models.length} models — auto-configuring`);
				await configureAigw(url, prefs);
				return true;
			}
		} catch {
			// try next
		}
	}

	console.log("[aigw] No gateway found at well-known URLs");
	return false;
}

// ── HTTP helpers ───────────────────────────────────────────────────

/**
 * Simple HTTP HEAD — resolves on any response, rejects on network error / timeout.
 */
function httpHead(url: string, timeoutMs = 4_000): Promise<void> {
	return new Promise((resolve, reject) => {
		const parsedUrl = new URL(url);
		const transport = parsedUrl.protocol === "https:" ? https : http;
		const req = transport.request(parsedUrl, { method: "HEAD", timeout: timeoutMs }, () => resolve());
		req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
		req.on("error", reject);
		req.end();
	});
}

/**
 * Simple HTTP GET that returns a parsed JSON body.
 * Works with both http:// and https:// URLs.
 */
function httpGet(url: string, timeoutMs = 10_000): Promise<any> {
	return new Promise((resolve, reject) => {
		const parsedUrl = new URL(url);
		const transport = parsedUrl.protocol === "https:" ? https : http;

		const req = transport.request(parsedUrl, { method: "GET", timeout: timeoutMs }, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (c: Buffer) => chunks.push(c));
			res.on("end", () => {
				const body = Buffer.concat(chunks).toString("utf-8");
				if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
					try { resolve(JSON.parse(body)); }
					catch { reject(new Error(`Invalid JSON from ${url}`)); }
				} else {
					reject(new Error(`HTTP ${res.statusCode} from ${url}: ${body.slice(0, 200)}`));
				}
			});
		});
		req.on("timeout", () => { req.destroy(); reject(new Error(`Timeout fetching ${url}`)); });
		req.on("error", reject);
		req.end();
	});
}

/**
 * Proxy an HTTP request: reads the incoming request body, forwards to the
 * target URL, and pipes the response back.
 */
export function proxyRequest(
	targetUrl: string,
	incomingReq: http.IncomingMessage,
	outgoingRes: http.ServerResponse,
): void {
	const parsed = new URL(targetUrl);
	const transport = parsed.protocol === "https:" ? https : http;

	const chunks: Buffer[] = [];
	incomingReq.on("data", (c: Buffer) => chunks.push(c));
	incomingReq.on("end", () => {
		const body = Buffer.concat(chunks);
		const headers: Record<string, string> = { "Content-Type": "application/json" };
		if (body.length > 0) headers["Content-Length"] = String(body.length);

		const RESPONSE_TIMEOUT_MS = 120_000;
		let responseTimer: ReturnType<typeof setTimeout> | undefined;
		let completed = false;

		const cleanup = () => {
			if (responseTimer) {
				clearTimeout(responseTimer);
				responseTimer = undefined;
			}
			completed = true;
		};

		const proxyReq = transport.request(parsed, {
			method: incomingReq.method || "GET",
			headers,
			timeout: RESPONSE_TIMEOUT_MS,
		}, (proxyRes) => {
			outgoingRes.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
			proxyRes.pipe(outgoingRes);
			proxyRes.on("end", cleanup);
			proxyRes.on("error", cleanup);
		});

		responseTimer = setTimeout(() => {
			if (!completed) {
				console.error(`[aigw-proxy] Response timeout after ${RESPONSE_TIMEOUT_MS}ms proxying to ${targetUrl}`);
				proxyReq.destroy();
				if (!outgoingRes.headersSent) {
					outgoingRes.writeHead(504, { "Content-Type": "application/json" });
				}
				outgoingRes.end(JSON.stringify({ error: "Gateway timeout: response not completed within 120s" }));
				completed = true;
			}
		}, RESPONSE_TIMEOUT_MS);

		proxyReq.on("error", (err) => {
			cleanup();
			console.error(`[aigw-proxy] Error proxying to ${targetUrl}:`, err.message);
			if (!outgoingRes.headersSent) {
				outgoingRes.writeHead(502, { "Content-Type": "application/json" });
			}
			outgoingRes.end(JSON.stringify({ error: `Gateway proxy error: ${err.message}` }));
		});
		if (body.length > 0) proxyReq.write(body);
		proxyReq.end();
	});
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Fetch the model list from an aigw endpoint and return structured model info.
 * Hits GET {baseUrl}/v1/models (or {baseUrl}/models if baseUrl already ends with /v1).
 */
export async function discoverAigwModels(baseUrl: string): Promise<AigwModel[]> {
	const url = baseUrl.replace(/\/+$/, "");
	const modelsUrl = url.endsWith("/v1") ? `${url}/models` : `${url}/v1/models`;

	const data = await httpGet(modelsUrl);
	if (!data?.data || !Array.isArray(data.data)) {
		throw new Error("Unexpected response format from /v1/models — expected { data: [...] }");
	}

	return data.data.map((m: any) => {
		const meta = inferMeta(m.id);
		// Honour fields if the gateway provides them
		const ctxFromGw = m.context_length || m.context_window;
		const maxTokFromGw = m.max_tokens || m.max_completion_tokens;
		return {
			id: m.id,
			name: deriveName(m.id),
			api: "openai-completions",
			reasoning: meta.reasoning,
			input: meta.input,
			contextWindow: Math.max(ctxFromGw || 0, meta.contextWindow),
			maxTokens: Math.max(maxTokFromGw || 0, meta.maxTokens),
			...(meta.compat ? { compat: meta.compat } : {}),
		};
	});
}

/**
 * Full configure flow: discover models, persist preference, write models.json.
 * Returns the discovered models.
 */
export async function configureAigw(baseUrl: string, prefs: PreferencesStore): Promise<AigwModel[]> {
	const rawModels = await discoverAigwModels(baseUrl);
	const normalizedUrl = baseUrl.replace(/\/+$/, "");

	// Normalize model IDs: Claude models get the provider prefix stripped
	// (e.g. "aws/us.anthropic.claude-..." → "us.anthropic.claude-...") because
	// they use the Bedrock API where the ID is just the Bedrock model ARN.
	const isClaudeModel = (id: string) => id.toLowerCase().includes("claude");
	const stripPrefix = (id: string) => { const i = id.indexOf("/"); return i >= 0 ? id.slice(i + 1) : id; };
	const models = rawModels.map(m => isClaudeModel(m.id)
		? { ...m, id: stripPrefix(m.id), api: "bedrock-converse-stream" }
		: m
	);

	prefs.set("aigw.url", normalizedUrl);
	prefs.set("aigw.models", models);

	writeAigwModelsJson(normalizedUrl, models);
	return models;
}

/**
 * Remove aigw configuration.
 */
export function removeAigw(prefs: PreferencesStore): void {
	prefs.remove("aigw.url");
	prefs.remove("aigw.models");
	removeAigwModelsJson();
}

/**
 * Get the currently configured aigw URL (if any).
 */
export function getAigwUrl(prefs: PreferencesStore): string | undefined {
	return prefs.get("aigw.url") as string | undefined;
}

/**
 * Get the cached aigw models (if any).
 */
export function getAigwModels(prefs: PreferencesStore): AigwModel[] | undefined {
	return prefs.get("aigw.models") as AigwModel[] | undefined;
}
