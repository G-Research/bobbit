// Migrated from tests/marketplace-active-project.spec.ts (v2-dom tier).
// The legacy spec esbuild-bundled a file:// entry that drove the REAL
// reconcileRenderersForActiveSession()/activeSessionProjectId() with window.fetch
// stubbed. We import those same real functions + app state here and stub the
// global fetch to record request URLs, asserting the refresh follows the ACTIVE
// SESSION's project (extension-host §4c), not the marketplace-focused project.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcileRenderersForActiveSession, activeSessionProjectId } from "../../src/app/marketplace-page.js";
import { state } from "../../src/app/state.js";

let fetchCalls: string[];
const toolsResponse = [{ name: "demo_pack_tool", rendererKind: "pack" }];
const RENDERER_MODULE = "export default function(){ return { render(){ return { content: '', isCustom: false }; } }; }";

beforeEach(() => {
	fetchCalls = [];
	vi.stubGlobal("fetch", async (input: any): Promise<Response> => {
		const url = typeof input === "string" ? input : (input && input.url) || String(input);
		fetchCalls.push(url);
		if (url.includes("/renderer")) {
			return new Response(RENDERER_MODULE, { status: 200, headers: { "Content-Type": "text/javascript" } });
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
