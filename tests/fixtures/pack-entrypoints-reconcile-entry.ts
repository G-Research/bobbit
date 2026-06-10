// Test entry — exercises `reconcilePackEntrypointsForProject` + `registerPackEntrypoints`
// + `lookupPackRoute` + `navigateToTarget` + `runLauncherEntrypoint` (pack schema
// V1 §8.2; design docs/design/pack-schema-v1-rationalisation.md). Mirrors
// pack-panels-reconcile-entry.ts: stub `window.fetch` to record every request URL
// and serve fake /api/ext/contributions metadata, then drive the helpers via window
// globals under a file:// fixture. Uses a THIRD-PARTY pack fixture (not the litmus
// packs) to prove the surface is reusable, not hardcoded. Pins:
//   1. reconcile fetches /api/ext/contributions scoped to the project id; dedupes.
//   2. lookupPackRoute resolves a registered routeId → its target panel + paramKeys + packId.
//   3. navigateToTarget maps a structured RouteTarget → #/ext/<routeId>?<params>
//      (params filtered to declared paramKeys; pack never builds the URL), and
//      getRouteFromHash parses it back to { view:"ext", extRouteId, extParams }.
//   4. reload restoration: a #/ext/<routeId> deep-link → lookupPackRoute →
//      openPackPanel serves the pack-addressed bearer-only /panels/ endpoint.
//   5. uninstall reconcile drops the route + launchers (a later navigate no-ops).
//   6. duplicate routeId across packs is rejected (lookupPackRoute undefined).
//   7. NO auto-invoke on mount: reconcile alone hits no /panels/ endpoint + no hash.
import {
	registerPackEntrypoints,
	reconcilePackEntrypointsForProject,
	entrypointInfosFromContributions,
	lookupPackRoute,
	navigateToTarget,
	runLauncherEntrypoint,
	listLauncherEntrypoints,
	launcherKey,
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
	listName: string;
};
type PackWire = { packId: string; packName: string; panels: Array<{ id: string; title?: string }>; entrypoints: EntrypointWire[]; routeNames: string[] };

const fetchCalls: string[] = [];

// THIRD-PARTY pack (not artifacts / pr-walkthrough): a deep-link route + a panel
// launcher + a route launcher. Proves the surface is generic.
const THIRDPARTY_PACKS: PackWire[] = [
	{
		packId: "thirdparty_pack",
		packName: "thirdparty_pack",
		panels: [{ id: "thirdparty.viewer" }],
		routeNames: [],
		entrypoints: [
			{ id: "tp.route", kind: "route", routeId: "thirdparty.route", target: { panelId: "thirdparty.viewer" }, paramKeys: ["itemId"], listName: "tp-route" },
			{ id: "tp.slash", kind: "composer-slash", label: "Open Third-Party", target: { panelId: "thirdparty.viewer" }, listName: "tp-slash" },
			{ id: "tp.navlaunch", kind: "command-palette", label: "Deep-link TP", target: { route: "thirdparty.route" }, listName: "tp-navlaunch" },
			{ id: "tp.gitbtn", kind: "git-widget-button", label: "TP Button", target: { panelId: "thirdparty.viewer" }, listName: "tp-gitbtn" },
		],
	},
];

let contributions: PackWire[] = THIRDPARTY_PACKS;

const contribDelayByProject = new Map<string, number>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PANEL_MODULE = "export default function(){ return { render(){ return ''; } }; }";

(window as any).fetch = async (input: any): Promise<Response> => {
	const url = typeof input === "string" ? input : (input && input.url) || String(input);
	fetchCalls.push(url);
	if (url.includes("/panels/")) {
		return new Response(PANEL_MODULE, { status: 200, headers: { "Content-Type": "text/javascript" } });
	}
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
(window as any).__thirdparty = () => THIRDPARTY_PACKS;
(window as any).__setContribDelay = (pid: string, ms: number) => { contribDelayByProject.set(pid, ms); };
(window as any).__calls = (): string[] => fetchCalls.slice();
(window as any).__clearCalls = () => { fetchCalls.length = 0; };
(window as any).__reconcile = (pid?: string): Promise<void> => reconcilePackEntrypointsForProject(pid);
(window as any).__startReconcile = (pid?: string): Promise<void> => reconcilePackEntrypointsForProject(pid);
// Register directly from the current metadata (bypassing the dedupe guard) — the
// marketplace install/uninstall path.
(window as any).__register = (pid?: string) => registerPackEntrypoints(entrypointInfosFromContributions(contributions as any), pid);
(window as any).__lookup = (routeId: string) => lookupPackRoute(routeId) ?? null;
(window as any).__navigate = (route: string, params?: Record<string, unknown>) => navigateToTarget({ route, params });
// Register the third-party panel in the (separate) pack-panel registry so a panel-
// target launcher's openPackPanel actually resolves + fetches the /panels/ endpoint
// (panel registration is a distinct registry from the entrypoint registry).
(window as any).__registerPanel = (pid?: string, packId?: string, panelId?: string) =>
	registerPackPanels([{ packId: packId ?? "thirdparty_pack", panelId: panelId ?? "thirdparty.viewer" }], pid);
// Register MULTIPLE panels at once — registerPackPanels REPLACES the whole registry,
// so two packs' panels must be registered together (used by the collision test).
(window as any).__registerPanels = (list: Array<{ packId: string; panelId: string }>, pid?: string) =>
	registerPackPanels(list, pid);
(window as any).__runLauncher = (keyOrId: string) => runLauncherEntrypoint(keyOrId);
(window as any).__launchers = (kind?: any) => listLauncherEntrypoints(kind).map((l) => l.id);
// Compound launcher keys (packId+id) — for the same-id-across-packs collision test.
(window as any).__launcherKey = (packId: string, id: string) => launcherKey(packId, id);
(window as any).__launcherEntries = (kind?: any) =>
	listLauncherEntrypoints(kind).map((l) => ({ id: l.id, packId: l.packId, key: l.key }));
(window as any).__route = () => getRouteFromHash();
(window as any).__hash = () => window.location.hash;
(window as any).__setHash = (h: string) => { window.location.hash = h; };
(window as any).__clearHash = () => { history.replaceState({}, "", window.location.pathname); };
(window as any).__flush = async (): Promise<void> => { await new Promise((r) => setTimeout(r, 30)); };

(window as any).__ready = true;
