import { render } from "lit";
import { clearToolPageState, loadToolPageData, renderToolManagerPage } from "../../src/app/tool-manager-page.js";
import { setRenderApp } from "../../src/app/state.js";

type FetchLogEntry = { url: string; method: string; body: any };

let mcpServers: any[] = [];
let policies: Record<string, string> = {};
let fetchLog: FetchLogEntry[] = [];

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

	if (url.startsWith("/api/tools")) return response({
		tools: [{ name: "bash", description: "Run a shell command.", group: "Shell" }],
	});
	if (url === "/api/roles") return response([]);
	if (url === "/api/mcp-servers") return response(mcpServers);
	if (url === "/api/tool-group-policies" && method === "GET") {
		const cascade: Record<string, { policy: string; origin: string }> = {};
		for (const [key, policy] of Object.entries(policies)) cascade[key] = { policy, origin: "fixture" };
		return response(cascade);
	}
	if (url.startsWith("/api/tool-group-policies/") && method === "PUT") {
		const key = decodeURIComponent(url.split("/").pop() || "");
		const policy = body?.policy ?? null;
		if (policy) policies[key] = policy;
		else delete policies[key];
		return response({ ok: true });
	}
	return response({});
}) as typeof window.fetch;

function doRender(): void {
	const container = document.getElementById("container");
	if (!container) throw new Error("#container missing");
	render(renderToolManagerPage(), container);
}

setRenderApp(doRender);

(window as any).__setMcpFixture = (opts: { servers: any[]; policies?: Record<string, string> }) => {
	mcpServers = opts.servers;
	policies = { ...(opts.policies || {}) };
	fetchLog = [];
	clearToolPageState();
	doRender();
};

(window as any).__loadToolManager = async () => {
	await loadToolPageData();
	await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
};

(window as any).__getMcpFetchLog = () => fetchLog.slice();
(window as any).__toolMcpReady = true;
