import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/marketplace-active-project.spec.ts (v2-dom tier).
// The legacy spec esbuild-bundled a file:// entry that drove the REAL
// reconcileRenderersForActiveSession()/activeSessionProjectId() with window.fetch
// stubbed. We import those same real functions + app state here and stub the
// global fetch to record request URLs, asserting the refresh follows the ACTIVE
// SESSION's project (extension-host §4c), not the marketplace-focused project.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "lit";
import {
	activeSessionProjectId,
	clearMarketplaceState,
	loadMarketplaceData,
	reconcileRenderersForActiveSession,
	renderMarketplacePage,
} from "../../src/app/marketplace-page.js";
import { grantExtensionCapability, revokeExtensionCapability } from "../../src/app/api.js";
import { setRenderApp, state } from "../../src/app/state.js";

let fetchCalls: string[];
let fetchRequests: Array<{ url: string; init: RequestInit }>;
const toolsResponse = [{ name: "demo_pack_tool", rendererKind: "pack" }];
const RENDERER_MODULE = "export default function(){ return { render(){ return { content: '', isCustom: false }; } }; }";

beforeEach(() => {
	fetchCalls = [];
	fetchRequests = [];
	vi.stubGlobal("fetch", async (input: any, init: RequestInit = {}): Promise<Response> => {
		const url = typeof input === "string" ? input : (input && input.url) || String(input);
		fetchCalls.push(url);
		fetchRequests.push({ url, init });
		if (url.includes("/renderer")) {
			return new Response(RENDERER_MODULE, { status: 200, headers: { "Content-Type": "text/javascript" } });
		}
		if (url.includes("/side-panel-workspace")) {
			// Valid workspace body so the app's fire-and-forget hydrate/settleMutation
			// (session-selection path, server-authoritative under happy-dom's http
			// origin) resolves instead of throwing a run-failing unhandled rejection.
			return new Response(JSON.stringify({ version: 1, tabs: [], activeTabId: "", sizeMode: "split" }), { status: 200, headers: { "Content-Type": "application/json" } });
		}
		return new Response(JSON.stringify({ tools: toolsResponse, packs: [] }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
	state.selectedSessionId = null;
	state.remoteAgent = null;
	state.gatewaySessions.length = 0;
	state.activeProjectId = null;
	state.projects = [];
	clearMarketplaceState();
	setRenderApp(() => {});
	document.body.innerHTML = "";
	window.location.hash = "";
});

function setup(opts: { sessionId?: string; sessionProjectId?: string; activeProjectId?: string | null }): void {
	state.selectedSessionId = opts.sessionId ?? null;
	state.remoteAgent = opts.sessionId ? ({ gatewaySessionId: opts.sessionId } as any) : null;
	state.gatewaySessions.length = 0;
	if (opts.sessionId) {
		state.gatewaySessions.push({ id: opts.sessionId, projectId: opts.sessionProjectId } as any);
	}
	state.activeProjectId = opts.activeProjectId ?? null;
}

describe("marketplace refresh scopes renderers to the active session (extension-host §4c)", () => {
	it("refresh fetches /api/tools for the ACTIVE SESSION's project, not the marketplace-focused/active project", async () => {
		// Active session is in project "sessionproj"; the active *project* (which a
		// project-scope install/uninstall would target) is a DIFFERENT "otherproj".
		setup({ sessionId: "s1", sessionProjectId: "sessionproj", activeProjectId: "otherproj" });
		fetchCalls = [];
		await reconcileRenderersForActiveSession();

		expect(activeSessionProjectId()).toBe("sessionproj");
		expect(fetchCalls.some((u) => /\/api\/tools\?projectId=sessionproj$/.test(u))).toBe(true);
		// Must NOT have refreshed for the marketplace's active/focused project.
		expect(fetchCalls.some((u) => u.includes("projectId=otherproj"))).toBe(false);
	});

	it("falls back to the active project when there is no active session", async () => {
		setup({ sessionId: undefined, sessionProjectId: undefined, activeProjectId: "fallbackproj" });
		fetchCalls = [];
		await reconcileRenderersForActiveSession();

		expect(activeSessionProjectId()).toBe("fallbackproj");
		expect(fetchCalls.some((u) => /\/api\/tools\?projectId=fallbackproj$/.test(u))).toBe(true);
	});
});

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
	const deadline = Date.now() + 3_000;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`Timed out waiting for ${label}`);
}

function fixturePack(packName: string): any {
	return {
		scope: "project", packName, status: "ok", updateAvailable: false, sourceStatus: "ok",
		manifest: { name: packName, version: "1.0.0", schema: 2 },
		meta: { version: "1.0.0", sourceUrl: "https://example.test/fixture", installedAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() },
	};
}

function settingsTarget(packId: string, kind: "pack" | "hook", id: string, enabled: boolean, configuration: "ready" | "requires-config", grants: string[] = []): any {
	return {
		ref: { packId, kind, id }, packName: packId, listName: id,
		enabled: { effective: enabled }, configuration: { state: configuration, missing: configuration === "requires-config" ? ["endpoint"] : [] }, fields: [],
		...(kind === "pack"
			? { packGrant: { requestedCapabilities: ["service.manage"], grants } }
			: { hookGrant: { requestedCapabilities: ["decide"], grants } }),
	};
}

async function renderGrantFixture(): Promise<HTMLElement> {
	const projectId = "market-grants-project";
	const root = document.createElement("div");
	document.body.append(root);
	state.projects = [{ id: projectId, name: "Grant fixture", rootPath: "/fixture", colorLight: "#888", colorDark: "#aaa" }];
	state.activeProjectId = projectId;
	window.location.hash = `#/market/${projectId}/installed`;
	setRenderApp(() => render(renderMarketplacePage(), root));
	const targets = [
		settingsTarget("aggregate-pack", "hook", "enabled-hook", true, "ready"),
		settingsTarget("aggregate-pack", "hook", "disabled-hook", false, "ready"),
		settingsTarget("aggregate-pack", "pack", "aggregate-pack", true, "ready"),
		settingsTarget("grants-only-pack", "pack", "grants-only-pack", true, "ready"),
		settingsTarget("legacy-pack", "hook", "legacy-hook", true, "requires-config"),
		settingsTarget("disabled-pack", "pack", "disabled-pack", false, "ready"),
	];
	vi.stubGlobal("fetch", async (input: RequestInfo | URL): Promise<Response> => {
		const url = new URL(typeof input === "string" ? input : input.toString(), "http://localhost");
		const body = url.pathname === "/api/marketplace/sources" ? { sources: [] }
			: url.pathname === "/api/marketplace/installed" ? { installed: [fixturePack("aggregate-pack"), fixturePack("grants-only-pack"), fixturePack("legacy-pack"), fixturePack("disabled-pack")] }
			: url.pathname === "/api/packs/conflicts" ? { conflicts: [] }
			: url.pathname === "/api/marketplace/adoptions" ? { adoptions: [] }
			: url.pathname === "/api/marketplace/browse" ? { sources: [], packs: [] }
			: url.pathname.endsWith("/extension-settings") ? { schema: 2, revision: 1, targets }
			: url.pathname.endsWith("/extension-grant-audit") ? { entries: [] }
			: url.pathname === "/api/marketplace/pack-activation" ? { scope: "project", packName: url.searchParams.get("packName"), catalogue: { roles: [], tools: [], skills: [], entrypoints: [], mcp: [], piExtensions: [] }, disabled: {} }
			: {};
		return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
	});
	await loadMarketplaceData(false);
	await waitFor(() => root.querySelector('[data-testid="market-project-pack-row"]') !== null, "Market grant projection");
	return root;
}

describe("Market extension capability grant API", () => {
	it("uses only the exact project, pack, hook, and capability tuple for grants and revokes", async () => {
		const tuple = { packId: "fixture-pack", hookId: "decision.hook", capability: "filter:tool-result" as const };

		await expect(grantExtensionCapability("project A", tuple)).resolves.toMatchObject({ ok: true });
		expect(fetchRequests).toHaveLength(1);
		// apiFetch/gatewayFetch correctly resolves the relative request against the
		// DOM harness origin. Assert the exact route and tuple, not a fragile
		// relative-vs-absolute URL representation.
		expect(new URL(fetchRequests[0].url).pathname).toBe("/api/projects/project%20A/extension-grants");
		expect(fetchRequests[0].init.method).toBe("PUT");
		expect(JSON.parse(String(fetchRequests[0].init.body))).toEqual(tuple);

		await expect(revokeExtensionCapability("project A", tuple)).resolves.toMatchObject({ ok: true });
		expect(fetchRequests).toHaveLength(2);
		expect(new URL(fetchRequests[1].url).pathname).toBe("/api/projects/project%20A/extension-grants/fixture-pack/decision.hook/filter%3Atool-result");
		expect(fetchRequests[1].init.method).toBe("DELETE");
		expect(fetchRequests[1].init.body).toBeUndefined();
	});

	it("preserves an operator-route 403 for the Market UI's browser-operator guidance", async () => {
		vi.stubGlobal("fetch", async (): Promise<Response> => new Response(JSON.stringify({ error: "operator required" }), {
			status: 403, headers: { "Content-Type": "application/json" },
		}));

		await expect(grantExtensionCapability("project", { packId: "pack", hookId: "hook", capability: "mutate" }))
			.resolves.toEqual({ ok: false, error: "operator required", status: 403 });
	});

	it("keeps grants-only pack grants actionable while its inert activation toggle is disabled", async () => {
		const root = await renderGrantFixture();
		const row = root.querySelector<HTMLElement>('[data-testid="market-project-pack-row"][data-contribution-id="grants-only-pack"]')!;
		expect(row.querySelector<HTMLInputElement>('[data-testid="market-project-pack-enabled"]')?.disabled).toBe(true);
		expect(row.querySelector<HTMLButtonElement>('[data-testid="market-capability-action"]')?.disabled).toBe(false);
	});

	it("keeps pack headers first, preserves partial status, and leaves legacy config-pending hook grants actionable", async () => {
		const root = await renderGrantFixture();
		const aggregate = root.querySelector<HTMLElement>('[data-testid="market-project-runtime"][data-pack-id="aggregate-pack"]')!;
		const rows = [...aggregate.querySelectorAll<HTMLElement>(".market-runtime-target")];
		expect(rows[0]?.dataset.testid).toBe("market-project-pack-row");
		expect(rows[0]?.querySelector('[data-testid="market-runtime-status"]')?.textContent).toContain("Partially enabled");
		const legacy = root.querySelector<HTMLElement>('[data-testid="market-project-hook-row"][data-contribution-id="legacy-hook"]')!;
		expect(legacy.querySelector<HTMLButtonElement>('[data-testid="market-capability-action"]')?.disabled).toBe(false);
	});

	it("uses distinct, present capability descriptions for disabled pack actions", async () => {
		const root = await renderGrantFixture();
		const action = root.querySelector<HTMLButtonElement>('[data-testid="market-project-pack-row"][data-contribution-id="disabled-pack"] [data-testid="market-capability-action"]')!;
		const ids = action.getAttribute("aria-describedby")!.split(" ");
		expect(ids).toHaveLength(2);
		expect(new Set(ids).size).toBe(2);
		for (const id of ids) expect(root.querySelectorAll(`#${id}`)).toHaveLength(1);
	});
});
