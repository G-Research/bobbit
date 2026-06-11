// Test entry — exercises `reconcilePackPanelsForProject` + `registerPackPanels`
// + `openPackPanel` (pack schema V1 §8.1; design
// docs/design/pack-schema-v1-rationalisation.md). Mirrors
// pack-renderers-reconcile-entry.ts: stub `window.fetch` to record every request
// URL and serve fake /api/ext/contributions metadata + a fake panel module, then
// drive the pack-panel reconcile/registration/open via window-exposed helpers
// under a file:// fixture. Pins:
//   1. reconcile fetches /api/ext/contributions scoped to the project id.
//   2. a redundant reconcile for the SAME project is deduped (no re-fetch).
//   3. openPackPanel's lazy loader serves the pack-addressed
//      /api/ext/packs/:packId/panels/:panelId endpoint scoped to the CURRENT
//      project id.
//   4. a reconcile for a NEW project re-drives + swaps the loader's project scope.
//   5. out-of-order completion does not clobber the newer project's registry.
//   6. uninstall reconcile drops the panel — a later openPackPanel no-ops.
import {
	registerPackPanels,
	reconcilePackPanelsForProject,
	panelInfosFromContributions,
	openPackPanel,
} from "../../src/app/pack-panels.js";
import { state } from "../../src/app/state.js";
import { panelTabsForSession, activePanelTabIdForSession } from "../../src/app/panel-workspace.js";
import { HOST_CONTRACT_VERSION } from "../../src/shared/extension-host/host-api.js";

type PackWire = { packId: string; packName: string; panels: Array<{ id: string; title?: string }>; entrypoints: unknown[]; routeNames: string[] };

const fetchCalls: string[] = [];
let contributions: PackWire[] = [
	{ packId: "demo_pack", packName: "demo_pack", panels: [{ id: "demo.panel", title: "Demo" }], entrypoints: [], routeNames: [] },
];

// Per-project artificial delay (ms) on the /api/ext/contributions metadata fetch,
// to simulate OUT-OF-ORDER completion (slow reconcile(A) resolving AFTER fast
// reconcile(B)).
const contribDelayByProject = new Map<string, number>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A trivial ESM panel module the fake panel endpoint serves. The loader imports
// it via a Blob URL; we only assert on the request URL (recorded before fetch
// resolves), so the import succeeding is not required for the assertions.
const PANEL_MODULE = "export default function(){ return { render(){ return ''; } }; }";

(window as any).fetch = async (input: any): Promise<Response> => {
	const url = typeof input === "string" ? input : (input && input.url) || String(input);
	fetchCalls.push(url);
	if (url.includes("/panels/")) {
		return new Response(PANEL_MODULE, { status: 200, headers: { "Content-Type": "text/javascript" } });
	}
	// /api/ext/contributions metadata — optionally delayed per the requested project id.
	const m = /[?&]projectId=([^&]*)/.exec(url);
	const pid = m ? decodeURIComponent(m[1]) : "";
	const delay = contribDelayByProject.get(pid) ?? 0;
	if (delay > 0) await sleep(delay);
	return new Response(JSON.stringify({ packs: contributions }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
};

(window as any).__setContributions = (c: PackWire[]) => { contributions = c; };
(window as any).__setContribDelay = (pid: string, ms: number) => { contribDelayByProject.set(pid, ms); };
(window as any).__calls = (): string[] => fetchCalls.slice();
(window as any).__clearCalls = () => { fetchCalls.length = 0; };
(window as any).__reconcile = (pid?: string): Promise<void> => reconcilePackPanelsForProject(pid);
// Start a reconcile WITHOUT awaiting so a test can interleave two reconciles.
(window as any).__startReconcile = (pid?: string): Promise<void> => reconcilePackPanelsForProject(pid);
(window as any).__register = (pid?: string) => registerPackPanels(panelInfosFromContributions(contributions as any), pid);
// Force a re-register that invalidates surviving panels' cached modules — the
// marketplace install/update/reinstall mutation path (pack schema V1 FIX 3).
(window as any).__registerForce = (pid?: string) =>
	registerPackPanels(panelInfosFromContributions(contributions as any), pid, { invalidateLoaded: true });
// openPackPanel is PACK-RELATIVE — the launcher/route supplies the caller packId.
// A tool-renderer caller now ALSO carries its own packId (threaded from /api/tools);
// pass the packId explicitly here to exercise the exact {packId, panelId} lookup.
(window as any).__open = (panelId: string, packId?: string) => { openPackPanel({ panelId }, packId ?? "demo_pack"); };
(window as any).__openByPanelId = (panelId: string) => { openPackPanel({ panelId }); };
// CONTRACT v2: open the panel in a CHOSEN session's view (PanelTarget.sessionId).
(window as any).__openInSession = (panelId: string, sessionId: string, packId?: string) => {
	openPackPanel({ panelId, sessionId }, packId ?? "demo_pack");
};
(window as any).__selectedSessionId = (): string | undefined =>
	(state as unknown as { selectedSessionId?: string }).selectedSessionId;
(window as any).__setSelectedSessionId = (sid: string | undefined) => {
	(state as unknown as { selectedSessionId?: string }).selectedSessionId = sid;
};
// The pack-panel tab ids mounted under a given session (after openPackPanel).
(window as any).__tabIdsForSession = (sid: string | undefined): string[] =>
	panelTabsForSession(state, sid).map((t) => t?.id);
(window as any).__activeTabIdForSession = (sid: string | undefined): string | undefined =>
	activePanelTabIdForSession(state, sid);
(window as any).__contractVersion = (): number => HOST_CONTRACT_VERSION;
(window as any).__flush = async (): Promise<void> => { await new Promise((r) => setTimeout(r, 30)); };

(window as any).__ready = true;
