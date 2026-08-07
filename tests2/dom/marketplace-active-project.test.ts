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
import { reconcileRenderersForActiveSession, activeSessionProjectId } from "../../src/app/marketplace-page.js";
import { grantExtensionCapability, revokeExtensionCapability } from "../../src/app/api.js";
import { state } from "../../src/app/state.js";

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

describe("Market extension capability grant API", () => {
	it("uses only the exact project, pack, hook, and capability tuple for grants and revokes", async () => {
		const tuple = { packId: "fixture-pack", hookId: "decision.hook", capability: "filter:tool-result" as const };

		await expect(grantExtensionCapability("project A", tuple)).resolves.toMatchObject({ ok: true });
		expect(fetchRequests).toHaveLength(1);
		expect(fetchRequests[0]).toMatchObject({
			url: "/api/projects/project%20A/extension-grants",
			init: { method: "PUT", body: JSON.stringify(tuple) },
		});

		await expect(revokeExtensionCapability("project A", tuple)).resolves.toMatchObject({ ok: true });
		expect(fetchRequests).toHaveLength(2);
		expect(fetchRequests[1]).toMatchObject({
			url: "/api/projects/project%20A/extension-grants/fixture-pack/decision.hook/filter%3Atool-result",
			init: { method: "DELETE" },
		});
	});

	it("preserves an operator-route 403 for the Market UI's browser-operator guidance", async () => {
		vi.stubGlobal("fetch", async (): Promise<Response> => new Response(JSON.stringify({ error: "operator required" }), {
			status: 403, headers: { "Content-Type": "application/json" },
		}));

		await expect(grantExtensionCapability("project", { packId: "pack", hookId: "hook", capability: "mutate" }))
			.resolves.toEqual({ ok: false, error: "operator required", status: 403 });
	});
});
