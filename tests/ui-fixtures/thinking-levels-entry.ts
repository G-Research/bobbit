import { render } from "lit";
import { renderModelsTab } from "../../src/app/settings-page.js";
import { setRenderApp } from "../../src/app/state.js";

type FetchLogEntry = { url: string; method: string; body: any };

type Prefs = Record<string, string | null>;

const PREFS_KEY = "bobbit-thinking-levels-fixture-prefs";

const DEFAULT_MODELS = [
	{ id: "claude-opus-4-8-20260528", provider: "anthropic", api: "anthropic-messages", contextWindow: 1_000_000, maxTokens: 128_000, reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, authenticated: true, name: "Claude Opus 4.8" },
	{ id: "claude-opus-4.8-20260528", provider: "anthropic", api: "anthropic-messages", contextWindow: 1_000_000, maxTokens: 128_000, reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, authenticated: true, name: "Claude Opus 4.8 dotted" },
	{ id: "claude-opus-4-8-20260528", provider: "aigw", api: "anthropic-messages", contextWindow: 1_000_000, maxTokens: 128_000, reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, authenticated: true, name: "AIGW Claude Opus 4.8" },
	{ id: "claude-opus-4.8-20260528", provider: "aigw", api: "anthropic-messages", contextWindow: 1_000_000, maxTokens: 128_000, reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, authenticated: true, name: "AIGW Claude Opus 4.8 dotted" },
	{ id: "claude-opus-4-7-20251101", provider: "anthropic", api: "anthropic-messages", contextWindow: 200_000, maxTokens: 8192, reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, authenticated: true, name: "Claude Opus 4.7" },
	{ id: "claude-opus-4-5-20250920", provider: "anthropic", api: "anthropic-messages", contextWindow: 200_000, maxTokens: 8192, reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, authenticated: true, name: "Claude Opus 4.5" },
	{ id: "gpt-4o", provider: "openai", api: "openai-responses", contextWindow: 128_000, maxTokens: 16_000, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, authenticated: true, name: "GPT-4o" },
];

let prefs: Prefs = readPrefs();
let models: any[] = DEFAULT_MODELS;
let fetchLog: FetchLogEntry[] = [];

function readPrefs(): Prefs {
	try { return JSON.parse(localStorage.getItem(PREFS_KEY) || "{}"); } catch { return {}; }
}

function persistPrefs(): void {
	localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
}

function response(body: any, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function requestPath(input: RequestInfo | URL): string {
	const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
	try {
		const url = new URL(raw, window.location.href);
		return `${url.pathname}${url.search}`;
	} catch {
		return raw;
	}
}

function parseBody(init?: RequestInit): any {
	if (!init?.body || typeof init.body !== "string") return null;
	try { return JSON.parse(init.body); } catch { return init.body; }
}

window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
	const url = requestPath(input);
	const method = (init?.method || "GET").toUpperCase();
	const body = parseBody(init);
	fetchLog.push({ url, method, body });

	if (url === "/api/aigw/status") return response({ configured: false, url: "", models: [] });
	if (url === "/api/preferences" && method === "GET") return response(prefs);
	if (url === "/api/preferences" && method === "PUT") {
		for (const [key, value] of Object.entries(body || {})) {
			if (value === null || value === undefined || value === "") delete prefs[key];
			else prefs[key] = value as string;
		}
		persistPrefs();
		return response({ ok: true });
	}
	if (url === "/api/models") return response(models);
	if (url === "/api/image-models") return response([]);
	if (url === "/api/models/test" && method === "POST") return response({ ok: true, latencyMs: 1 });
	return response({});
}) as typeof window.fetch;

function doRender(): void {
	const container = document.getElementById("container");
	if (!container) throw new Error("#container missing");
	render(renderModelsTab(), container);
}

setRenderApp(doRender);

(window as any).__setThinkingFixture = (opts: { prefs?: Prefs; models?: any[] } = {}) => {
	prefs = { ...(opts.prefs || {}) };
	models = opts.models || DEFAULT_MODELS;
	fetchLog = [];
	persistPrefs();
};

(window as any).__setThinkingPrefs = (next: Prefs) => {
	prefs = { ...prefs, ...next };
	for (const [key, value] of Object.entries(next)) {
		if (value === null || value === undefined || value === "") delete prefs[key];
	}
	persistPrefs();
};

(window as any).__renderThinkingModels = () => {
	doRender();
};

(window as any).__getThinkingFetchLog = () => fetchLog.slice();
(window as any).__getThinkingPrefs = () => ({ ...prefs });
(window as any).__thinkingLevelsReady = true;
