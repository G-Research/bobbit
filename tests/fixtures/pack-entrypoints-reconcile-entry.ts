// Test entry — exercises `reconcilePackEntrypointsForProject` + `registerPackEntrypoints`
// + `lookupPackRoute` + `navigateToTarget` + `runLauncherEntrypoint` (Slice C1;
// design docs/design/extension-host-phase2.md §7 / §7 C1.1a). Mirrors
// pack-panels-reconcile-entry.ts: stub `window.fetch` to record every request URL
// and serve fake /api/tools metadata, then drive the helpers via window globals
// under a file:// fixture. Uses a THIRD-PARTY pack fixture (not the litmus packs)
// to prove the surface is reusable, not hardcoded. Pins:
//   1. reconcile fetches /api/tools scoped to the project id; dedupes unchanged.
//   2. lookupPackRoute resolves a registered routeId → its target panel + paramKeys.
//   3. navigateToTarget maps a structured RouteTarget → #/ext/<routeId>?<params>
//      (params filtered to declared paramKeys; pack never builds the URL), and
//      getRouteFromHash parses it back to { view:"ext", extRouteId, extParams }.
//   4. reload restoration: a #/ext/<routeId> deep-link → lookupPackRoute →
//      openPackPanel serves the bearer-only /panel/ endpoint.
//   5. uninstall reconcile drops the route + launchers (a later navigate no-ops).
//   6. duplicate routeId across tools/packs is rejected (lookupPackRoute undefined).
//   7. NO auto-invoke on mount: reconcile alone hits no /panel/ endpoint + no hash.
import {
	registerPackEntrypoints,
	reconcilePackEntrypointsForProject,
	entrypointInfosFromTools,
	lookupPackRoute,
	navigateToTarget,
	runLauncherEntrypoint,
	listLauncherEntrypoints,
} from "../../src/app/pack-entrypoints.js";
import { getRouteFromHash } from "../../src/app/routing.js";
import { registerPackPanels } from "../../src/app/pack-panels.js";

type EntrypointWire = {
	id: string;
	kind: "composer-slash" | "git-widget-button" | "command-palette" | "route";
	label?: string;
	routeId?: string;
	target?: { panelId?: string; route?: string; params?: Record<string, unknown> };
	paramKeys?: string[];
};
type ToolWire = { name: string; entrypoints?: EntrypointWire[] };

const fetchCalls: string[] = [];

// THIRD-PARTY pack (not artifacts / pr-walkthrough): a deep-link route + a panel
// launcher + a route launcher. Proves the surface is generic.
const THIRDPARTY_TOOLS: ToolWire[] = [
	{
		name: "thirdparty_pack_tool",
		entrypoints: [
			{ id: "tp.route", kind: "route", routeId: "thirdparty.route", target: { panelId: "thirdparty.viewer" }, paramKeys: ["itemId"] },
			{ id: "tp.slash", kind: "composer-slash", label: "Open Third-Party", target: { panelId: "thirdparty.viewer" } },
			{ id: "tp.navlaunch", kind: "command-palette", label: "Deep-link TP", target: { route: "thirdparty.route" } },
			{ id: "tp.gitbtn", kind: "git-widget-button", label: "TP Button", target: { panelId: "thirdparty.viewer" } },
		],
	},
];

let toolsResponse: ToolWire[] = THIRDPARTY_TOOLS;

const toolsDelayByProject = new Map<string, number>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PANEL_MODULE = "export default function(){ return { render(){ return ''; } }; }";

(window as any).fetch = async (input: any): Promise<Response> => {
	const url = typeof input === "string" ? input : (input && input.url) || String(input);
	fetchCalls.push(url);
	if (url.includes("/panel/")) {
		return new Response(PANEL_MODULE, { status: 200, headers: { "Content-Type": "text/javascript" } });
	}
	const m = /[?&]projectId=([^&]*)/.exec(url);
	const pid = m ? decodeURIComponent(m[1]) : "";
	const delay = toolsDelayByProject.get(pid) ?? 0;
	if (delay > 0) await sleep(delay);
	return new Response(JSON.stringify({ tools: toolsResponse }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
};

(window as any).__setTools = (t: ToolWire[]) => { toolsResponse = t; };
(window as any).__thirdparty = () => THIRDPARTY_TOOLS;
(window as any).__setToolsDelay = (pid: string, ms: number) => { toolsDelayByProject.set(pid, ms); };
(window as any).__calls = (): string[] => fetchCalls.slice();
(window as any).__clearCalls = () => { fetchCalls.length = 0; };
(window as any).__reconcile = (pid?: string): Promise<void> => reconcilePackEntrypointsForProject(pid);
(window as any).__startReconcile = (pid?: string): Promise<void> => reconcilePackEntrypointsForProject(pid);
// Register directly from the current metadata (bypassing the dedupe guard) — the
// marketplace install/uninstall path.
(window as any).__register = (pid?: string) => registerPackEntrypoints(entrypointInfosFromTools(toolsResponse as any), pid);
(window as any).__lookup = (routeId: string) => lookupPackRoute(routeId) ?? null;
(window as any).__navigate = (route: string, params?: Record<string, unknown>) => navigateToTarget({ route, params });
// Register the third-party panel in the (separate) pack-panel registry so a panel-
// target launcher's openPackPanel actually resolves + fetches the /panel/ endpoint
// (panel registration is B4's registry, distinct from the entrypoint registry).
(window as any).__registerPanel = (pid?: string) =>
	registerPackPanels([{ panelId: "thirdparty.viewer", tool: "thirdparty_pack_tool" }], pid);
(window as any).__runLauncher = (id: string) => runLauncherEntrypoint(id);
(window as any).__launchers = (kind?: any) => listLauncherEntrypoints(kind).map((l) => l.id);
(window as any).__route = () => getRouteFromHash();
(window as any).__hash = () => window.location.hash;
(window as any).__setHash = (h: string) => { window.location.hash = h; };
(window as any).__clearHash = () => { history.replaceState({}, "", window.location.pathname); };
(window as any).__flush = async (): Promise<void> => { await new Promise((r) => setTimeout(r, 30)); };

(window as any).__ready = true;
