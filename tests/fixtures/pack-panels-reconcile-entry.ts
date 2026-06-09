// Test entry — exercises `reconcilePackPanelsForProject` + `registerPackPanels`
// + `openPackPanel` (Slice B4; design extension-host-phase2.md §6). Mirrors
// pack-renderers-reconcile-entry.ts: stub `window.fetch` to record every request
// URL and serve fake /api/tools metadata + a fake panel module, then drive the
// pack-panel reconcile/registration/open via window-exposed helpers under a
// file:// fixture. Pins:
//   1. reconcile fetches /api/tools scoped to the project id.
//   2. a redundant reconcile for the SAME project is deduped (no re-fetch).
//   3. openPackPanel's lazy loader serves /api/tools/:tool/panel/:panelId scoped
//      to the CURRENT project id.
//   4. a reconcile for a NEW project re-drives + swaps the loader's project scope.
//   5. out-of-order completion does not clobber the newer project's registry.
//   6. uninstall reconcile drops the panel — a later openPackPanel no-ops.
import {
	registerPackPanels,
	reconcilePackPanelsForProject,
	openPackPanel,
} from "../../src/app/pack-panels.js";

const fetchCalls: string[] = [];
let toolsResponse: Array<{ name: string; panels?: Array<{ id: string; title?: string }> }> = [
	{ name: "demo_pack_tool", panels: [{ id: "demo.panel", title: "Demo" }] },
];

// Per-project artificial delay (ms) on the /api/tools metadata fetch, to simulate
// OUT-OF-ORDER completion (slow reconcile(A) resolving AFTER fast reconcile(B)).
const toolsDelayByProject = new Map<string, number>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A trivial ESM panel module the fake /panel endpoint serves. The loader imports
// it via a Blob URL; we only assert on the request URL (recorded before fetch
// resolves), so the import succeeding is not required for the assertions.
const PANEL_MODULE = "export default function(){ return { render(){ return ''; } }; }";

(window as any).fetch = async (input: any): Promise<Response> => {
	const url = typeof input === "string" ? input : (input && input.url) || String(input);
	fetchCalls.push(url);
	if (url.includes("/panel/")) {
		return new Response(PANEL_MODULE, { status: 200, headers: { "Content-Type": "text/javascript" } });
	}
	// /api/tools metadata — optionally delayed per the requested project id.
	const m = /[?&]projectId=([^&]*)/.exec(url);
	const pid = m ? decodeURIComponent(m[1]) : "";
	const delay = toolsDelayByProject.get(pid) ?? 0;
	if (delay > 0) await sleep(delay);
	return new Response(JSON.stringify({ tools: toolsResponse }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
};

(window as any).__setTools = (t: typeof toolsResponse) => { toolsResponse = t; };
(window as any).__setToolsDelay = (pid: string, ms: number) => { toolsDelayByProject.set(pid, ms); };
(window as any).__calls = (): string[] => fetchCalls.slice();
(window as any).__clearCalls = () => { fetchCalls.length = 0; };
(window as any).__reconcile = (pid?: string): Promise<void> => reconcilePackPanelsForProject(pid);
// Start a reconcile WITHOUT awaiting so a test can interleave two reconciles.
(window as any).__startReconcile = (pid?: string): Promise<void> => reconcilePackPanelsForProject(pid);
(window as any).__register = (pid?: string) =>
	registerPackPanels(
		toolsResponse.flatMap((t) => (t.panels ?? []).map((p) => ({ panelId: p.id, tool: t.name, title: p.title }))),
		pid,
	);
(window as any).__open = (panelId: string) => { openPackPanel({ panelId }); };
(window as any).__flush = async (): Promise<void> => { await new Promise((r) => setTimeout(r, 30)); };

(window as any).__ready = true;
