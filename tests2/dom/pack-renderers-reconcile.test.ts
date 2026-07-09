import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/pack-renderers-reconcile.spec.ts (v2-dom tier).
// The legacy spec esbuild-bundled an entry that drove the REAL
// reconcilePackRenderersForProject / registerPackRenderers / getToolRenderer via
// window globals under a file:// fixture. This port imports those SAME real
// functions and stubs the global fetch to record request URLs + serve fake
// /api/tools metadata (with per-project delay for the out-of-order race). No
// geometry — pure registry/fetch/generation-guard logic.
//
// Module-level reconcile dedupe state persists across tests in a fork (the
// legacy suite got a fresh page per test), so each test uses UNIQUE project ids.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerPackRenderers, reconcilePackRenderersForProject } from "../../src/app/pack-renderers.js";
import { getToolRenderer } from "../../src/ui/tools/renderer-registry.js";

let fetchCalls: string[];
let toolsResponse: Array<{ name: string; rendererKind?: string }>;
const toolsDelayByProject = new Map<string, number>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const RENDERER_MODULE = "export default function(){ return { render(){ return { content: '', isCustom: false }; } }; }";

beforeEach(() => {
	fetchCalls = [];
	toolsResponse = [{ name: "demo_pack_tool", rendererKind: "pack" }];
	toolsDelayByProject.clear();
	vi.stubGlobal("fetch", async (input: any): Promise<Response> => {
		const url = typeof input === "string" ? input : (input && input.url) || String(input);
		fetchCalls.push(String(url));
		if (String(url).includes("/renderer")) {
			return new Response(RENDERER_MODULE, { status: 200, headers: { "Content-Type": "text/javascript" } });
		}
		const m = /[?&]projectId=([^&]*)/.exec(String(url));
		const pid = m ? decodeURIComponent(m[1]) : "";
		const delay = toolsDelayByProject.get(pid) ?? 0;
		if (delay > 0) await sleep(delay);
		return new Response(JSON.stringify({ tools: toolsResponse }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	});
});

afterEach(() => { vi.unstubAllGlobals(); });

const clearCalls = () => { fetchCalls.length = 0; };
const calls = (): string[] => fetchCalls.slice();
const reconcile = (pid?: string) => reconcilePackRenderersForProject(pid);
const triggerLoad = (name: string) => { getToolRenderer(name); };
const flush = async () => { await new Promise((r) => setTimeout(r, 30)); };

describe("reconcilePackRenderersForProject (extension-host §4a/§4c)", () => {
	it("re-drives registration scoped to the active session's project; dedupes unchanged; swaps the loader on project change", async () => {
		clearCalls();
		await reconcile("A1");
		expect(calls().some((u) => /\/api\/tools\?projectId=A1$/.test(u))).toBe(true);

		clearCalls();
		await reconcile("A1");
		expect(calls().some((u) => u.includes("/api/tools"))).toBe(false);

		clearCalls();
		triggerLoad("demo_pack_tool");
		await flush();
		expect(calls().some((u) => u.includes("/api/tools/demo_pack_tool/renderer?projectId=A1"))).toBe(true);

		clearCalls();
		await reconcile("B1");
		expect(calls().some((u) => /\/api\/tools\?projectId=B1$/.test(u))).toBe(true);

		clearCalls();
		triggerLoad("demo_pack_tool");
		await flush();
		expect(calls().some((u) => u.includes("/api/tools/demo_pack_tool/renderer?projectId=B1"))).toBe(true);
		expect(calls().some((u) => u.includes("projectId=A1"))).toBe(false);
	});

	it("out-of-order completion: a late reconcile(A) response does NOT clobber the registry already applied for B", async () => {
		clearCalls();
		toolsDelayByProject.set("A2", 120);
		toolsDelayByProject.set("B2", 0);
		const pA = reconcile("A2"); // slow fetch
		const pB = reconcile("B2"); // fast fetch, resolves first
		await pB;
		await pA; // stale A response settles (must be a no-op)

		clearCalls();
		triggerLoad("demo_pack_tool");
		await flush();
		expect(calls().some((u) => u.includes("/api/tools/demo_pack_tool/renderer?projectId=B2"))).toBe(true);
		expect(calls().some((u) => u.includes("projectId=A2"))).toBe(false);

		clearCalls();
		await reconcile("B2");
		expect(calls().some((u) => u.includes("/api/tools"))).toBe(false);

		clearCalls();
		await reconcile("C2");
		expect(calls().some((u) => /\/api\/tools\?projectId=C2$/.test(u))).toBe(true);
	});
});

// Keep a reference so the imported registrar is not tree-shaken and matches the
// legacy entry's import surface (it drove registerPackRenderers directly).
void registerPackRenderers;
