// Test entry — exercises `reconcilePackSettingsSectionsForProject` +
// `registerPackSettingsSections` + `renderPackSettingsSections` + the
// `SettingsHostApi` (docs/design/pack-settings-contribution.md §4.2/§4.3).
// Mirrors pack-panels-reconcile-entry.ts: stub `window.fetch` to record every
// request URL and serve fake `/api/ext/contributions` metadata, a fake
// settings-section module, fake `/api/preferences`, and a fake surface-token
// mint endpoint; drive the registry + render + host API via window-exposed
// helpers under a file:// fixture. Pins:
//   1. reconcile fetches /api/ext/contributions scoped to HEADQUARTERS.
//   2. renderPackSettingsSections filters by tab, sorts by order/packId, and
//      wraps each section under a `{packId}-{sectionId}` testid (§4.6).
//   3. a registry change (install/update/uninstall) repaints LIVE — a section
//      dropped from the registry stops rendering with NO reload.
//   4. host.preferences.get/set round-trips through PUT /api/preferences
//      carrying the `x-bobbit-settings-section-token` header (never a raw
//      unmediated write).
import { render } from "lit";
import {
	registerPackSettingsSections,
	reconcilePackSettingsSectionsForProject,
	settingsSectionInfosFromContributions,
	renderPackSettingsSections,
} from "../../src/app/pack-settings-sections.js";

type SectionWire = { id: string; title?: string; tab: string; order: number };
type PackWire = { packId: string; packName: string; panels: unknown[]; settingsSections: SectionWire[]; entrypoints: unknown[]; routeNames: string[] };

const fetchCalls: string[] = [];
const putCalls: Array<{ url: string; body: unknown; headers: Record<string, string> }> = [];
let contributions: PackWire[] = [
	{ packId: "pr-walkthrough", packName: "pr-walkthrough", panels: [], settingsSections: [{ id: "pr-walkthrough.trusted-hosts", title: "Trusted GitHub hosts", tab: "general", order: 100 }], entrypoints: [], routeNames: [] },
];
let prefs: Record<string, unknown> = { githubTrustedHosts: ["ghe.example.com"] };

// A trivial ESM settings-section module the fake serving endpoint returns. Uses
// ONLY the injected toolkit (no bare `lit` import) — exactly the constraint a
// real Blob-URL-loaded pack module operates under.
const SECTION_MODULE = `
export default function create({ html }) {
	return {
		render(host) {
			const hosts = host.preferences.get("githubTrustedHosts");
			return html\`<div data-testid="fake-section-body">\${Array.isArray(hosts) ? hosts.join(",") : "none"}</div>
				<button data-testid="fake-add" @click=\${() => { void host.preferences.set("githubTrustedHosts", ["added.example.com"]); }}></button>\`;
		},
	};
}
`;

(window as any).fetch = async (input: any, init?: any): Promise<Response> => {
	const url = typeof input === "string" ? input : (input && input.url) || String(input);
	fetchCalls.push(url);
	if (url.includes("/settings-sections/") && url.endsWith("/surface-token")) {
		return new Response(JSON.stringify({ token: "fake-token" }), { status: 200, headers: { "Content-Type": "application/json" } });
	}
	if (url.includes("/settings-sections/")) {
		return new Response(SECTION_MODULE, { status: 200, headers: { "Content-Type": "text/javascript" } });
	}
	if (url.includes("/api/ext/contributions")) {
		return new Response(JSON.stringify({ packs: contributions }), { status: 200, headers: { "Content-Type": "application/json" } });
	}
	if (url.endsWith("/api/preferences") && (!init || !init.method || init.method === "GET")) {
		return new Response(JSON.stringify(prefs), { status: 200, headers: { "Content-Type": "application/json" } });
	}
	if (url.endsWith("/api/preferences") && init && init.method === "PUT") {
		const headers: Record<string, string> = { ...(init.headers ?? {}) };
		const body = init.body ? JSON.parse(init.body) : {};
		putCalls.push({ url, body, headers });
		prefs = { ...prefs, ...body };
		return new Response(JSON.stringify(prefs), { status: 200, headers: { "Content-Type": "application/json" } });
	}
	return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
};

const container = document.getElementById("container") as HTMLElement;

(window as any).__setContributions = (c: PackWire[]) => { contributions = c; };
(window as any).__setPrefs = (p: Record<string, unknown>) => { prefs = p; };
(window as any).__calls = (): string[] => fetchCalls.slice();
(window as any).__clearCalls = () => { fetchCalls.length = 0; };
(window as any).__putCalls = () => putCalls.slice();
(window as any).__clearPutCalls = () => { putCalls.length = 0; };
(window as any).__reconcile = (): Promise<void> => reconcilePackSettingsSectionsForProject();
(window as any).__register = (opts?: { invalidateLoaded?: boolean }) =>
	registerPackSettingsSections(settingsSectionInfosFromContributions(contributions as any), "headquarters", opts);
(window as any).__render = (tab: string): string => {
	render(renderPackSettingsSections("system", tab), container);
	return container.innerHTML;
};
(window as any).__flush = async (): Promise<void> => { await new Promise((r) => setTimeout(r, 30)); };
// Each render pass can kick off a NEW async step (module lazy-load, then the
// first host.preferences.get() lazy-loading the preferences cache) — mirrors
// how the real Settings page repaints on renderApp() broadcasts rather than a
// single synchronous pass. Loops render+flush until the output stops changing
// (or a bounded number of passes), so a test doesn't need to hand-count steps.
(window as any).__renderStable = async (tab: string): Promise<string> => {
	let last = "";
	for (let i = 0; i < 8; i++) {
		const html = (window as any).__render(tab) as string;
		if (html === last) return html;
		last = html;
		await (window as any).__flush();
	}
	return last;
};

(window as any).__ready = true;
