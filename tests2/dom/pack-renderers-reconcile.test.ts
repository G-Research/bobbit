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
import {
	invalidatePackRendererModules,
	packHasLocalDataForTool,
	packIdForTool,
	registerPackRenderers,
	reconcilePackRenderersForProject,
} from "../../src/app/pack-renderers.js";
import { getToolRenderer, TOOL_RENDERER_LOADED_EVENT } from "../../src/ui/tools/renderer-registry.js";

let fetchCalls: string[];
let toolsResponse: Array<{ name: string; rendererKind?: string }>;
let rendererResponder: ((url: string) => Response | Promise<Response>) | undefined;
const rendererVersions = new Map<string, string>();
const toolsDelayByProject = new Map<string, number>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rendererModule = (version: string) => `export default function(){ return { version: ${JSON.stringify(version)}, render(){ return { content: '', isCustom: false }; } }; }`;

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
}
function defer<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => { resolve = res; });
	return { promise, resolve };
}

beforeEach(() => {
	fetchCalls = [];
	toolsResponse = [{ name: "demo_pack_tool", rendererKind: "pack" }];
	rendererResponder = undefined;
	rendererVersions.clear();
	toolsDelayByProject.clear();
	vi.stubGlobal("fetch", async (input: any): Promise<Response> => {
		const url = String(typeof input === "string" ? input : (input && input.url) || input);
		fetchCalls.push(url);
		if (url.includes("/renderer")) {
			if (rendererResponder) return rendererResponder(url);
			const match = /\/api\/tools\/([^/?]+)\/renderer/.exec(url);
			const toolName = match ? decodeURIComponent(match[1]) : "";
			return new Response(rendererModule(rendererVersions.get(toolName) ?? "default"), {
				status: 200,
				headers: { "Content-Type": "text/javascript" },
			});
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
const loadedVersion = (name: string): string | undefined => (getToolRenderer(name) as { version?: string } | undefined)?.version;
const flush = async () => { await new Promise((r) => setTimeout(r, 30)); };
const waitForRendererLoaded = (toolName: string): Promise<void> => new Promise((resolve) => {
	const listener = (event: Event) => {
		if ((event as CustomEvent).detail?.toolName !== toolName) return;
		document.removeEventListener(TOOL_RENDERER_LOADED_EVENT, listener);
		resolve();
	};
	document.addEventListener(TOOL_RENDERER_LOADED_EVENT, listener);
});

describe("reconcilePackRenderersForProject (extension-host §4a/§4c)", () => {
	it("projects local-data capability only for the current declared winning pack renderer", () => {
		registerPackRenderers([{ name: "local_data_tool", rendererKind: "pack", packId: "declared", hasLocalData: true }]);
		expect(packHasLocalDataForTool("local_data_tool")).toBe(true);

		registerPackRenderers([{ name: "local_data_tool", rendererKind: "pack", packId: "undeclared" }]);
		expect(packHasLocalDataForTool("local_data_tool")).toBe(false);

		registerPackRenderers([]);
		expect(packHasLocalDataForTool("local_data_tool")).toBe(false);
	});

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

	it("reloads only the named pack with tokenized fresh module requests and preserves project scope", async () => {
		const toolA = "hot_renderer_a";
		const toolB = "hot_renderer_b";
		const projectId = "project with & data";
		rendererVersions.set(toolA, "a-v1");
		rendererVersions.set(toolB, "b-v1");
		registerPackRenderers([
			{ name: toolA, rendererKind: "pack", packId: "pack-a" },
			{ name: toolB, rendererKind: "pack", packId: "pack-b" },
		], projectId);

		const initialA = waitForRendererLoaded(toolA);
		triggerLoad(toolA);
		await initialA;
		const initialB = waitForRendererLoaded(toolB);
		triggerLoad(toolB);
		await initialB;
		expect(loadedVersion(toolA)).toBe("a-v1");
		expect(loadedVersion(toolB)).toBe("b-v1");
		expect(packIdForTool(toolA)).toBe("pack-a");
		expect(packIdForTool(toolB)).toBe("pack-b");

		clearCalls();
		const repaintEvents: string[] = [];
		const onRepaint = (event: Event) => repaintEvents.push((event as CustomEvent).detail?.toolName);
		document.addEventListener(TOOL_RENDERER_LOADED_EVENT, onRepaint);
		try {
			rendererVersions.set(toolA, "a-v2");
			expect(invalidatePackRendererModules("pack-a", 41)).toEqual([toolA]);
			const loadedA2 = waitForRendererLoaded(toolA);
			triggerLoad(toolA);
			await loadedA2;
			expect(loadedVersion(toolA)).toBe("a-v2");
			expect(loadedVersion(toolB)).toBe("b-v1");

			rendererVersions.set(toolA, "a-v3");
			expect(invalidatePackRendererModules("pack-a", 42)).toEqual([toolA]);
			const loadedA3 = waitForRendererLoaded(toolA);
			triggerLoad(toolA);
			await loadedA3;
			expect(loadedVersion(toolA)).toBe("a-v3");
		} finally {
			document.removeEventListener(TOOL_RENDERER_LOADED_EVENT, onRepaint);
		}

		const rendererCalls = calls().filter((url) => url.includes("/renderer"));
		expect(rendererCalls).toHaveLength(2);
		expect(rendererCalls.map((url) => {
			const parsed = new URL(url);
			return {
				path: parsed.pathname,
				projectId: parsed.searchParams.get("projectId"),
				devReload: parsed.searchParams.get("devReload"),
			};
		})).toEqual([
			{ path: `/api/tools/${toolA}/renderer`, projectId, devReload: "41" },
			{ path: `/api/tools/${toolA}/renderer`, projectId, devReload: "42" },
		]);
		expect(repaintEvents).toEqual([toolA, toolA]);
		expect(packIdForTool(toolA)).toBe("pack-a");
		expect(packIdForTool(toolB)).toBe("pack-b");
	});

	it("drops a stale in-flight renderer after hot invalidation", async () => {
		const toolName = "hot_renderer_stale";
		const oldResponse = defer<Response>();
		rendererResponder = (url) => {
			const token = new URL(url).searchParams.get("devReload");
			if (token === null) return oldResponse.promise;
			return new Response(rendererModule("fresh"), { status: 200 });
		};
		registerPackRenderers([
			{ name: toolName, rendererKind: "pack", packId: "stale-pack" },
		], "stale-project");

		const loadedEvents: string[] = [];
		const onLoad = (event: Event) => loadedEvents.push((event as CustomEvent).detail?.toolName);
		document.addEventListener(TOOL_RENDERER_LOADED_EVENT, onLoad);
		try {
			triggerLoad(toolName);
			expect(invalidatePackRendererModules("stale-pack", 7)).toEqual([toolName]);
			const freshLoaded = waitForRendererLoaded(toolName);
			triggerLoad(toolName);
			await freshLoaded;
			expect(loadedVersion(toolName)).toBe("fresh");

			oldResponse.resolve(new Response(rendererModule("stale"), { status: 200 }));
			await flush();
			expect(loadedVersion(toolName)).toBe("fresh");
			expect(loadedEvents).toEqual([toolName]);
		} finally {
			document.removeEventListener(TOOL_RENDERER_LOADED_EVENT, onLoad);
		}
	});
});

// Keep a reference so the imported registrar is not tree-shaken and matches the
// legacy entry's import surface (it drove registerPackRenderers directly).
void registerPackRenderers;
