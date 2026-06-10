// Test entry — bundles the REAL <command-palette> + <git-status-widget> Lit
// components to pin the Slice C1 launcher SURFACES (extension-host-phase2 §7 C1.3):
//   - command-palette: lists `command-palette` launchers, runs one on click,
//     never auto-invokes on mount/open.
//   - git-widget dropdown: renders `git-widget-button` launchers + a "Command
//     palette…" opener, runs a launcher on click.
// Both consume the SAME client pack-entrypoints registry. A route-target launcher
// navigates (sets `#/ext/<routeId>?…`), which we assert without needing a server.
import "../../src/ui/components/CommandPalette.js";
import "../../src/ui/components/GitStatusWidget.js";
import { registerPackEntrypoints } from "../../src/app/pack-entrypoints.js";
import { openCommandPalette } from "../../src/ui/components/CommandPalette.js";

function register(): void {
	registerPackEntrypoints(
		[
			{ id: "tp.route", packId: "tp", kind: "route", routeId: "demo.route", target: { panelId: "demo.viewer" }, paramKeys: ["itemId"] },
			{ id: "cp.nav", packId: "tp", kind: "command-palette", label: "Open Demo (palette)", target: { route: "demo.route", params: { itemId: "x1" } } },
			{ id: "cp.other", packId: "tp", kind: "command-palette", label: "Second Command", target: { route: "demo.route", params: { itemId: "x2" } } },
			{ id: "gw.nav", packId: "tp", kind: "git-widget-button", label: "Demo Git Button", target: { route: "demo.route", params: { itemId: "g1" } } },
		],
		"proj1",
	);
}

function clearRegistry(): void {
	registerPackEntrypoints([], "proj2");
}

(window as any).__register = register;
(window as any).__clearRegistry = clearRegistry;
(window as any).__hash = () => window.location.hash;
(window as any).__clearHash = () => history.replaceState({}, "", window.location.pathname);

// ── Command palette helpers ──
(window as any).__openPalette = () => openCommandPalette();
(window as any).__paletteOpen = () => !!document.querySelector("[data-testid='command-palette']");
(window as any).__paletteItems = () =>
	[...document.querySelectorAll("[data-testid='command-palette-item']")].map((e) => (e.textContent || "").trim());
(window as any).__paletteIds = () =>
	[...document.querySelectorAll("[data-testid='command-palette-item']")].map((e) => (e as HTMLElement).dataset.entrypointId);
(window as any).__filterPalette = (q: string) => {
	const input = document.querySelector<HTMLInputElement>("[data-testid='command-palette-input']");
	if (!input) throw new Error("palette input not found");
	input.value = q;
	input.dispatchEvent(new Event("input", { bubbles: true }));
};
(window as any).__clickPaletteItem = (id: string) => {
	const el = document.querySelector<HTMLElement>(`[data-testid='command-palette-item'][data-entrypoint-id='${id}']`);
	if (!el) throw new Error(`palette item ${id} not found`);
	el.click();
};

// ── Git-widget helpers ──
async function mountGit() {
	const el = document.createElement("git-status-widget") as any;
	el.branch = "feature/x";
	el.token = "";
	el.sessionId = "s1";
	el.clean = true;
	document.body.appendChild(el);
	await el.updateComplete;
	return el;
}
(window as any).__mountGit = mountGit;
(window as any).__openGitDropdown = async (el: any) => {
	el.expanded = true;
	await el.updateComplete;
	// updated() builds the portal asynchronously within the same microtask; give it a tick.
	await new Promise((r) => setTimeout(r, 0));
};
(window as any).__gitLaunchers = () =>
	[...document.querySelectorAll("#git-status-dropdown [data-testid='git-widget-launcher']")].map((e) => ({
		id: (e as HTMLElement).dataset.entrypointId,
		label: (e.textContent || "").trim(),
	}));
(window as any).__clickGitLauncher = (id: string) => {
	const el = document.querySelector<HTMLElement>(`#git-status-dropdown [data-testid='git-widget-launcher'][data-entrypoint-id='${id}']`);
	if (!el) throw new Error(`git launcher ${id} not found`);
	el.click();
};
(window as any).__gitHasPaletteOpener = () =>
	!!document.querySelector("#git-status-dropdown [data-testid='git-widget-open-command-palette']");
(window as any).__clickGitPaletteOpener = () => {
	const el = document.querySelector<HTMLElement>("#git-status-dropdown [data-testid='git-widget-open-command-palette']");
	if (!el) throw new Error("git palette opener not found");
	el.click();
};

(window as any).__ready = true;
