import { render } from "lit";
import { commitGatewayConnection } from "../../../../../src/app/gateway-fetch.js";
import { clearToolPageState, loadToolPageData, renderToolManagerPage } from "../../../../../src/app/tool-manager-page.js";
import { setRenderApp } from "../../../../../src/app/state.js";

const FIXTURE_GATEWAY_BASE_URL = "https://fixture.test/team/bobbit";
const FIXTURE_GATEWAY_TOKEN = "fixture-token";

type FetchLogEntry = {
	url: string;
	method: string;
	body: any;
	credentials: RequestCredentials | null;
	authorization: string | null;
};

let mcpServers: any[] = [];
let policies: Record<string, string> = {};
let fetchLog: FetchLogEntry[] = [];

commitGatewayConnection(FIXTURE_GATEWAY_BASE_URL, FIXTURE_GATEWAY_TOKEN);

function response(body: any, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function requestUrl(input: RequestInfo | URL): URL {
	const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
	return new URL(raw, window.location.href);
}

function mountedRoute(url: URL): string {
	const gateway = new URL(FIXTURE_GATEWAY_BASE_URL);
	const mount = gateway.pathname.replace(/\/$/, "");
	if (url.origin !== gateway.origin || (url.pathname !== mount && !url.pathname.startsWith(`${mount}/`))) return "";
	return `${url.pathname.slice(mount.length) || "/"}${url.search}`;
}

function parseBody(init?: RequestInit): any {
	if (!init?.body || typeof init.body !== "string") return null;
	try { return JSON.parse(init.body); } catch { return init.body; }
}

window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
	const request = input instanceof Request ? input : null;
	const requestUrlValue = requestUrl(input);
	const route = mountedRoute(requestUrlValue);
	const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
	const body = parseBody(init);
	const headers = new Headers(init?.headers ?? request?.headers);
	fetchLog.push({
		url: requestUrlValue.href,
		method,
		body,
		credentials: init?.credentials ?? request?.credentials ?? null,
		authorization: headers.get("Authorization"),
	});

	if (route.startsWith("/api/tools")) return response({
		tools: [{ name: "bash", description: "Run a shell command.", group: "Shell" }],
	});
	if (route.startsWith("/api/roles")) return response([]);
	if (route.startsWith("/api/mcp-servers")) return response(mcpServers);
	if (route.startsWith("/api/tool-group-policies") && method === "GET") {
		const cascade: Record<string, { policy: string; origin: string }> = {};
		for (const [key, policy] of Object.entries(policies)) cascade[key] = { policy, origin: "fixture" };
		return response(cascade);
	}
	if (route.startsWith("/api/tool-group-policies/") && method === "PUT") {
		const key = decodeURIComponent(route.split("/").pop() || "");
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
