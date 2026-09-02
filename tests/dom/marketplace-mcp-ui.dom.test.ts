import { beforeAll as syncBeforeAll } from "vitest";
import { syncCustomElements } from "../support/helpers/dom/setup/custom-elements.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "lit";
import { clearMarketplaceState, loadMarketplaceData, renderMarketplacePage } from "../../src/app/marketplace-page.js";
import { setRenderApp, state } from "../../src/app/state.js";

syncBeforeAll(() => syncCustomElements());

const GATEWAY_URL = "http://mcp-local.t3.zone/readonly/mcp";
const PACK_NAME = "mcp-jira-source-1";
let installed: any[] = [];
let capturedSourceBody: any;
let capturedOperationBody: any;
let operationDisabled = false;

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function activation() {
	return {
		revision: operationDisabled ? "act:2" : "act:1",
		scope: "server",
		packName: PACK_NAME,
		catalogue: {
			roles: [], tools: [], skills: [], entrypoints: [], piExtensions: [],
			mcp: [{
				ref: "jira",
				contributionId: "jira",
				listName: "jira",
				serverName: "gr",
				subNamespace: "jira",
				label: "Jira",
				transport: "http",
				status: "active-owner",
				totalOperationCount: 2,
				selectedOperationCount: operationDisabled ? 1 : 2,
				operations: [
					{ name: "jira_search", description: "Search Jira", selected: !operationDisabled, disabledByActivation: operationDisabled },
					{ name: "jira_get_issue", description: "Read Jira", selected: true, disabledByActivation: false },
					{ name: "retired_op", selected: false, disabledByActivation: true, stale: true },
				],
				disabledOperations: operationDisabled ? ["jira_search"] : [],
				staleDisabledOperations: ["retired_op"],
			}],
			descriptions: { mcp: { jira: "Jira issue tools" } },
		},
		disabled: { mcp: [], mcpOperations: { jira: operationDisabled ? ["jira_search", "retired_op"] : ["retired_op"] } },
	};
}

function installedPack() {
	return {
		scope: "server",
		packName: PACK_NAME,
		manifest: {
			name: PACK_NAME,
			description: "Jira issue tools",
			version: "1.0.0",
			contents: { roles: [], tools: [], skills: [], entrypoints: [], mcp: ["jira"] },
		},
		meta: { version: "1.0.0", sourceUrl: GATEWAY_URL, installedAt: new Date(0).toISOString() },
		status: "ok",
		updateAvailable: false,
		sourceStatus: "ok",
	};
}

function repaint(): void {
	render(renderMarketplacePage(), document.querySelector<HTMLElement>("#app")!);
}

syncBeforeAll(() => syncCustomElements());

beforeEach(() => {
	(window as any).happyDOM?.setURL?.("http://localhost/#/market");
	document.body.innerHTML = '<div id="app"></div>';
	clearMarketplaceState();
	installed = [];
	capturedSourceBody = undefined;
	capturedOperationBody = undefined;
	operationDisabled = false;
	state.projects = [{ id: "project-1", name: "Project One" } as any];
	state.activeProjectId = "project-1";
	setRenderApp(repaint);
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input), "http://localhost");
		const method = init?.method ?? "GET";
		if (url.pathname === "/api/marketplace/sources" && method === "POST") {
			capturedSourceBody = JSON.parse(String(init?.body ?? "{}"));
			return json({ source: { id: "source-1", url: GATEWAY_URL, type: "mcp-gateway", addedAt: new Date(0).toISOString() } }, 201);
		}
		if (url.pathname === "/api/marketplace/sources") return json({ sources: [] });
		if (url.pathname === "/api/marketplace/installed") return json({ installed });
		if (url.pathname === "/api/packs/conflicts") return json({ conflicts: [] });
		if (url.pathname === "/api/marketplace/browse") return json({ sources: [], packs: [] });
		if (url.pathname === "/api/marketplace/pack-activation/mcp-operation" && method === "PATCH") {
			capturedOperationBody = JSON.parse(String(init?.body ?? "{}"));
			operationDisabled = capturedOperationBody.disabled === true;
			return json(activation());
		}
		if (url.pathname === "/api/marketplace/pack-activation") return json(activation());
		if (url.pathname === "/api/mcp-servers") return json([{ name: "gr", status: "connected", activeSubNamespaces: ["jira"], toolCount: 2, tools: [] }]);
		if (url.pathname === "/api/tools") return json({ tools: [] });
		if (url.pathname === "/api/ext/contributions") return json({ packs: [] });
		return json({});
	});
});

afterEach(() => {
	setRenderApp(() => {});
	vi.unstubAllGlobals();
	document.body.innerHTML = "";
	clearMarketplaceState();
});

describe("Marketplace MCP UI", () => {
	it("posts an MCP gateway source without a pack ref", async () => {
		await loadMarketplaceData();
		repaint();
		(document.querySelector('[data-testid="market-tab-sources"]') as HTMLButtonElement).click();
		await vi.waitFor(() => expect(document.querySelector('[data-testid="market-sources-panel"]')).not.toBeNull());

		(document.querySelector('[data-testid="market-source-kind-mcp-gateway"]') as HTMLButtonElement).click();
		await vi.waitFor(() => expect(document.querySelector('[data-testid="market-mcp-source-helper"]')?.textContent).toContain("one provider pack per namespace"));
		expect(document.querySelector('[data-testid="market-source-ref"]')).toBeNull();
		expect(document.querySelector('[data-testid="market-source-url"]')?.getAttribute("placeholder")).toBe(GATEWAY_URL);

		const input = document.querySelector('[data-testid="market-source-url"]') as HTMLInputElement;
		input.value = GATEWAY_URL;
		input.dispatchEvent(new Event("input", { bubbles: true }));
		await vi.waitFor(() => expect((document.querySelector('[data-testid="market-add-source"]') as HTMLButtonElement).disabled).toBe(false));
		(document.querySelector('[data-testid="market-add-source"]') as HTMLButtonElement).click();
		await vi.waitFor(() => expect(capturedSourceBody).toEqual({ url: GATEWAY_URL, type: "mcp-gateway" }));
	});

	it("renders gateway operations and patches one operation independently", async () => {
		installed = [installedPack()];
		await loadMarketplaceData();
		repaint();

		await vi.waitFor(() => expect(document.querySelector('[data-testid="market-activation-mcp-group"]')).not.toBeNull());
		expect(document.querySelector('[data-testid="market-mcp-status-jira"]')?.textContent).toContain("Connected");
		expect(document.querySelector('[data-testid="market-operation-row-retired_op"]')).not.toBeNull();

		const toggle = document.querySelector('[data-testid="market-toggle-operation-jira_search"]') as HTMLInputElement;
		expect(toggle.checked).toBe(true);
		toggle.checked = false;
		toggle.dispatchEvent(new Event("change", { bubbles: true }));
		await vi.waitFor(() => expect(capturedOperationBody).toMatchObject({
			scope: "server",
			contributionId: "jira",
			operationName: "jira_search",
			disabled: true,
			expectedRevision: "act:1",
		}));
		await vi.waitFor(() => expect(document.querySelector('[data-testid="market-mcp-operation-summary-jira"]')?.textContent).toContain("1/2 operations enabled"));
		expect((document.querySelector('[data-testid="market-toggle-operation-jira_search"]') as HTMLInputElement).checked).toBe(false);
	});
});
