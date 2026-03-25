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
function inferMeta(modelId: string): ModelMeta {
	const id = modelId.toLowerCase();

	// Anthropic models (via Bedrock or direct)
	if (id.includes("claude-opus")) {
		return { contextWindow: 1_000_000, maxTokens: 32_768, reasoning: true, input: ["text", "image"] };
	}
	if (id.includes("claude-sonnet")) {
		return { contextWindow: 1_000_000, maxTokens: 16_384, reasoning: true, input: ["text", "image"] };
	}
	if (id.includes("claude-haiku")) {
		return { contextWindow: 200_000, maxTokens: 8_192, reasoning: false, input: ["text", "image"] };
	}
	if (id.includes("claude")) {
		return { contextWindow: 200_000, maxTokens: 16_384, reasoning: false, input: ["text", "image"] };
	}

	// OpenAI models
	if (id.includes("gpt-5")) {
		return { contextWindow: 400_000, maxTokens: 32_768, reasoning: false, input: ["text", "image"] };
	}
	if (id.includes("o4-mini") || id.includes("o3-mini") || id.includes("o1-mini")) {
		return { contextWindow: 200_000, maxTokens: 65_536, reasoning: true, input: ["text"] };
	}
	if (id.includes("o4") || id.includes("o3") || id.includes("o1")) {
		return { contextWindow: 200_000, maxTokens: 100_000, reasoning: true, input: ["text", "image"] };
	}
	if (id.includes("gpt-4")) {
		return { contextWindow: 128_000, maxTokens: 16_384, reasoning: false, input: ["text", "image"] };
	}

	// Qwen models
	if (id.includes("qwen")) {
		return { contextWindow: 1_000_000, maxTokens: 32_768, reasoning: false, input: ["text"] };
	}

	return { ...DEFAULT_META };
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
		fs.writeFileSync(p, JSON.stringify(data, null, 2), "utf-8");
		console.log(`[aigw-manager] Wrote models.json to ${p}`);
	} catch (err) {
		console.error("[aigw-manager] Failed to write models.json:", err);
	}
}

/**
 * Write aigw models into ~/.pi/agent/models.json, merging with existing
 * providers (preserving non-aigw entries).
 */
export function writeAigwModelsJson(aigwUrl: string, models: AigwModel[]): void {
	const data = readModelsJson();
	if (!data.providers) data.providers = {};

	data.providers.aigw = {
		baseUrl: aigwUrl.replace(/\/+$/, ""),
		apiKey: "none",
		api: "openai-completions",
		models: models.map(m => ({
			id: m.id,
			name: m.name,
			contextWindow: m.contextWindow,
			maxTokens: m.maxTokens,
			reasoning: m.reasoning,
			input: m.input,
			...(m.compat ? { compat: m.compat } : {}),
		})),
	};

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

	for (const target of targets) {
		try {
			await httpHead(target, 4_000);
			return true;
		} catch {
			// try next
		}
	}
	return false;
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
	// Already configured — nothing to do
	if (getAigwUrl(prefs)) {
		console.log("[aigw] AI Gateway already configured:", getAigwUrl(prefs));
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

		const proxyReq = transport.request(parsed, {
			method: incomingReq.method || "GET",
			headers,
			timeout: 120_000,
		}, (proxyRes) => {
			outgoingRes.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
			proxyRes.pipe(outgoingRes);
		});
		proxyReq.on("error", (err) => {
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
			contextWindow: ctxFromGw || meta.contextWindow,
			maxTokens: maxTokFromGw || meta.maxTokens,
			...(meta.compat ? { compat: meta.compat } : {}),
		};
	});
}

/**
 * Full configure flow: discover models, persist preference, write models.json.
 * Returns the discovered models.
 */
export async function configureAigw(baseUrl: string, prefs: PreferencesStore): Promise<AigwModel[]> {
	const models = await discoverAigwModels(baseUrl);
	const normalizedUrl = baseUrl.replace(/\/+$/, "");

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
