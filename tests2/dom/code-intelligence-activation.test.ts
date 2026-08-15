import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { render } from "lit";
import {
	clearMarketplaceState,
	loadMarketplaceData,
	renderMarketplacePage,
} from "../../src/app/marketplace-page.js";
import { setRenderApp } from "../../src/app/state.js";

const activation = (enabled = false) => ({
	scope: "server",
	packName: "code-intelligence",
	catalogue: {
		roles: [],
		tools: ["ast_grep", "graph_query"],
		skills: [],
		entrypoints: [{ listName: "code-intelligence-route", kind: "route", routeId: "code-intelligence" }],
	},
	disabled: enabled ? { enabled: true } : {},
});

const builtinCodeIntelligence = {
	scope: "server",
	packName: "code-intelligence",
	builtin: true,
	status: "ok",
	updateAvailable: false,
	sourceStatus: "ok",
	meta: { version: "0.1.0" },
	manifest: {
		name: "code-intelligence",
		version: "0.1.0",
		description: "Structural and graph intelligence",
		defaultDisabled: true,
		contents: {
			roles: [],
			tools: ["graph", "ast"],
			skills: [],
			entrypoints: ["code-intelligence-route"],
		},
	},
};

let requests: Array<{ path: string; method: string; body?: unknown }>;
let enabled = false;
let host: HTMLElement;

function response(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

function renderMarketplace(): void {
	render(renderMarketplacePage(), host);
}

async function waitFor(check: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("Timed out waiting for marketplace update");
}

beforeEach(() => {
	requests = [];
	enabled = false;
	host = document.createElement("div");
	document.body.appendChild(host);
	setRenderApp(renderMarketplace);
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const url = new URL(rawUrl, "http://localhost");
		const method = (init?.method || "GET").toUpperCase();
		const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
		requests.push({ path: `${url.pathname}${url.search}`, method, body });

		if (url.pathname === "/api/marketplace/sources") return response({ sources: [] });
		if (url.pathname === "/api/marketplace/installed") return response({ installed: [builtinCodeIntelligence] });
		if (url.pathname === "/api/packs/conflicts") return response({ conflicts: [] });
		if (url.pathname === "/api/marketplace/browse") return response({ sources: [], packs: [] });
		if (url.pathname === "/api/marketplace/pack-activation" && method === "GET") return response(activation(enabled));
		if (url.pathname === "/api/marketplace/pack-activation" && method === "PUT") {
			enabled = (body as any)?.disabled?.enabled === true;
			return response(activation(enabled));
		}
		return response({ tools: [], packs: [] });
	});
});

afterEach(() => {
	clearMarketplaceState();
	setRenderApp(() => {});
	document.body.innerHTML = "";
	vi.unstubAllGlobals();
});

describe("Code Intelligence built-in activation", () => {
	it("declares the real AST group but no inert LSP group", () => {
		const manifest = readFileSync("market-packs/code-intelligence/pack.yaml", "utf8");
		const toolsLine = manifest.match(/^\s*tools: \[([^\]]+)\]$/m)?.[1] || "";

		expect(toolsLine).toContain("graph");
		expect(toolsLine).toContain("ast");
		expect(toolsLine).not.toContain("lsp");
	});

	it("uses the existing server activation sentinel while naming its server-wide scope", async () => {
		await loadMarketplaceData();
		renderMarketplace();
		await waitFor(() => host.querySelector('[data-testid="market-toggle-pack-code-intelligence"]') !== null);

		const toggle = host.querySelector('[data-testid="market-toggle-pack-code-intelligence"]') as HTMLInputElement;
		expect(toggle.checked).toBe(false);
		expect(toggle.getAttribute("aria-label")).toBe("Enable Code Intelligence for this Bobbit server");
		expect(host.querySelector('[data-testid="code-intelligence-server-scope"]')?.textContent)
			.toContain("every project on this server");
		expect(host.querySelector('[data-testid="market-toggle-tool-ast_grep"]')).not.toBeNull();
		expect(host.querySelector('[data-testid="market-toggle-tool-graph_query"]')).not.toBeNull();

		toggle.checked = true;
		toggle.dispatchEvent(new Event("change", { bubbles: true }));
		await waitFor(() => requests.some((request) => request.path === "/api/marketplace/pack-activation" && request.method === "PUT"));

		expect(requests.find((request) => request.path === "/api/marketplace/pack-activation" && request.method === "PUT")?.body)
			.toEqual({ scope: "server", packName: "code-intelligence", disabled: { enabled: true } });
	});
});
