// Test entry — exercises `reconcilePackRenderersForProject` + `registerPackRenderers`
// (extension-host §4a/§4c). We stub `window.fetch` to record every request URL
// and serve fake /api/tools metadata + a fake renderer module, then drive the
// pack-renderer reconcile/registration via window-exposed helpers under a
// file:// fixture. Pins:
//   1. reconcile fetches /api/tools scoped to the project id.
//   2. a redundant reconcile for the SAME project is deduped (no re-fetch).
//   3. a reconcile for a NEW project re-drives (re-fetch + re-register).
//   4. the per-tool renderer loader URL carries the CURRENT project id, so a
//      project switch swaps the loader to the new project's renderer.
import { registerPackRenderers, reconcilePackRenderersForProject } from "../../src/app/pack-renderers.js";
import { getToolRenderer } from "../../src/ui/tools/renderer-registry.js";

const fetchCalls: string[] = [];
let toolsResponse: Array<{ name: string; rendererKind?: string }> = [
	{ name: "demo_pack_tool", rendererKind: "pack" },
];

// A trivial ESM renderer module the fake /renderer endpoint serves. The loader
// imports it via a Blob URL; we only assert on the request URL (recorded before
// fetch resolves), so the import succeeding is not required for the assertions.
const RENDERER_MODULE =
	"export default function(){ return { render(){ return { content: '', isCustom: false }; } }; }";

(window as any).fetch = async (input: any): Promise<Response> => {
	const url = typeof input === "string" ? input : (input && input.url) || String(input);
	fetchCalls.push(url);
	if (url.includes("/renderer")) {
		return new Response(RENDERER_MODULE, { status: 200, headers: { "Content-Type": "text/javascript" } });
	}
	return new Response(JSON.stringify({ tools: toolsResponse }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
};

(window as any).__setTools = (t: Array<{ name: string; rendererKind?: string }>) => { toolsResponse = t; };
(window as any).__calls = (): string[] => fetchCalls.slice();
(window as any).__clearCalls = () => { fetchCalls.length = 0; };
(window as any).__reconcile = (pid?: string): Promise<void> => reconcilePackRenderersForProject(pid);
(window as any).__register = (pid?: string) => registerPackRenderers(toolsResponse, pid);
(window as any).__triggerLoad = (name: string) => { getToolRenderer(name); };
(window as any).__flush = async (): Promise<void> => { await new Promise(r => setTimeout(r, 30)); };

(window as any).__ready = true;
