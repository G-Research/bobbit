// Test entry — drives the real shared session action menu model and popover to
// pin pack `session-menu` launcher behavior without a gateway server.
import { html, render } from "lit";
import { icon } from "@mariozechner/mini-lit";
import { Boxes } from "lucide";
import "../../src/ui/components/SidebarActionsPopover.js";
import "../../src/ui/components/GitStatusWidget.js";
import { buildSessionActions, type SessionActionDescriptor } from "../../src/app/session-actions.js";
import { registerPackEntrypoints, listLauncherEntrypoints, launcherKey } from "../../src/app/pack-entrypoints.js";
import { setLauncherHostFactory } from "../../src/app/pack-panels.js";
import type { GatewaySession } from "../../src/app/state.js";

const app = document.getElementById("app")!;

let lastActions: SessionActionDescriptor[] = [];
let activePopover: HTMLElement | null = null;
let currentSurface: "sidebar" | "header" | null = null;
let feedbackText = "";
const feedbackEvents: Array<{ kind?: string; message?: string }> = [];
let activeSessionId = "active-session";
let sidebarSessionId = "sidebar-session";

type SpawnBehavior = "defer" | "nopr" | "throw";
let resolveSpawnRoute: ((value: { ok: boolean; childSessionId?: string }) => void) | null = null;
const callRouteCalls: Array<{ route: string; body?: unknown; sessionId?: string; packId: string; contributionId: string }> = [];
const openPanelCalls: Array<{ panelId?: string; sessionId?: string }> = [];

function fakeSession(id: string): GatewaySession {
	return {
		id,
		title: "Fixture session",
		cwd: "/tmp/project",
		status: "idle",
		createdAt: Date.now(),
		updatedAt: Date.now(),
		role: "assistant",
	} as unknown as GatewaySession;
}

function registerSessionMenu(): void {
	registerPackEntrypoints(
		[
			{ id: "tp.route", packId: "tp", kind: "route", routeId: "demo.route", target: { panelId: "demo.viewer" }, paramKeys: ["itemId"] },
			{ id: "sm.route", packId: "tp", kind: "session-menu", label: "Open Demo", icon: "terminal", target: { route: "demo.route", params: { itemId: "x1" } } },
			{ id: "sm.missing", packId: "tp", kind: "session-menu", label: "Missing Route", target: { route: "missing.route" } },
			{ id: "sm.spawn", packId: "tp", kind: "session-menu", label: "PR Walkthrough", icon: "git-pull-request", target: { action: "spawn", route: "run", panelId: "demo.viewer" } },
			{ id: "sm.fail", packId: "tp", kind: "session-menu", label: "Broken Walkthrough", icon: "no-such-icon", target: { action: "spawn", route: "run", panelId: "demo.viewer" } },
		] as any,
		"proj1",
	);
}

function registerWithLegacyEntrypoints(): void {
	registerPackEntrypoints(
		[
			{ id: "tp.route", packId: "tp", kind: "route", routeId: "demo.route", target: { panelId: "demo.viewer" }, paramKeys: ["itemId"] },
			{ id: "sm.route", packId: "tp", kind: "session-menu", label: "Open Demo", target: { route: "demo.route", params: { itemId: "x1" } } },
			{ id: "legacy.palette", packId: "tp", kind: "command-palette", label: "Legacy Palette", target: { route: "demo.route" } },
			{ id: "legacy.git", packId: "tp", kind: "git-widget-button", label: "Legacy Git Button", target: { route: "demo.route" } },
		] as any,
		"proj1",
	);
}

function clearEntrypoints(): void {
	registerPackEntrypoints([], "proj2");
}

function installSpawnHost(behavior: SpawnBehavior): void {
	callRouteCalls.length = 0;
	openPanelCalls.length = 0;
	resolveSpawnRoute = null;
	setLauncherHostFactory((sessionId, packId, contributionId) => ({
		capabilities: { callRoute: true } as any,
		callRoute: async (route: string, init?: { body?: unknown }) => {
			callRouteCalls.push({ route, body: init?.body, sessionId, packId, contributionId });
			if (behavior === "nopr") return { ok: false, code: "NO_PR", error: "No open GitHub PR for the current branch." };
			if (behavior === "throw") throw new Error("route exploded");
			return await new Promise<{ ok: boolean; childSessionId?: string }>((resolve) => { resolveSpawnRoute = resolve; });
		},
		ui: { openPanel: (target: { panelId?: string; sessionId?: string }) => { openPanelCalls.push({ panelId: target.panelId, sessionId: target.sessionId }); } },
	}) as any);
}

function normalizeLabel(text: string | null | undefined): string {
	return (text || "").replace(/\s+/g, " ").trim();
}

function renderFixture(): void {
	render(html`
		<style>
			:root { color-scheme: light; }
			body { margin: 0; font-family: sans-serif; color: #111; }
			.surface { display: flex; gap: 12px; padding: 20px; }
			button { font: inherit; }
			#feedback { margin: 0 20px; min-height: 1.4em; color: #075985; }
		</style>
		<div class="surface">
			<button id="sidebar-trigger" type="button" data-testid="sidebar-actions-trigger" data-sidebar-actions-kind="session" data-sidebar-actions-id=${sidebarSessionId} @click=${() => openSurface("sidebar")}>Sidebar menu</button>
			<button id="header-trigger" type="button" data-testid="session-actions-trigger" data-session-action-surface="header" @click=${() => openSurface("header")}>Header menu</button>
		</div>
		<div id="feedback" role="status">${feedbackText}</div>
	`, app);
}

function buildActions(): SessionActionDescriptor[] {
	const sessionId = currentSurface === "sidebar" ? sidebarSessionId : activeSessionId;
	lastActions = buildSessionActions({ session: fakeSession(sessionId), displayTitle: "Fixture session" });
	return lastActions;
}

async function openSurface(surface: "sidebar" | "header"): Promise<void> {
	await closeMenu();
	currentSurface = surface;
	const anchor = document.getElementById(surface === "sidebar" ? "sidebar-trigger" : "header-trigger")!;
	const actions = buildActions();
	const popover = document.createElement("sidebar-actions-popover") as any;
	activePopover = popover;
	popover.items = actions.map((action) => ({
		id: action.id,
		label: action.label,
		title: action.title,
		icon: action.icon ?? icon(Boxes, "xs"),
		tone: action.tone,
		quick: !!action.quick,
		trailingToggle: action.trailingToggle,
	}));
	popover.anchorEl = anchor;
	popover.open = true;
	popover.addEventListener("sidebar-action-select", ((ev: Event) => {
		const detail = (ev as CustomEvent<{ actionId: string }>).detail;
		const action = lastActions.find((candidate) => String(candidate.id) === detail.actionId);
		dismissMenuSync();
		if (action) void action.run(ev);
	}) as EventListener);
	document.body.appendChild(popover);
	await popover.updateComplete;
	await flush();
}

function dismissMenuSync(): void {
	if (!activePopover) return;
	const popover = activePopover;
	activePopover = null;
	currentSurface = null;
	(popover as any).open = false;
	popover.remove();
}

async function closeMenu(): Promise<void> {
	if (!activePopover) return;
	dismissMenuSync();
	await flush();
}

function menuOpen(): boolean {
	return !!document.querySelector("sidebar-actions-popover [role='menu']");
}

function menuLabels(): string[] {
	return [...document.querySelectorAll("sidebar-actions-popover [role='menuitem']")].map((el) => normalizeLabel(el.textContent));
}

function menuIconSignaturesByLabel(): Record<string, string[]> {
	const out: Record<string, string[]> = {};
	for (const row of document.querySelectorAll<HTMLElement>("sidebar-actions-popover [role='menuitem']")) {
		const label = normalizeLabel(row.querySelector("[data-sidebar-actions-label]")?.textContent);
		if (!label) continue;
		const svg = row.querySelector<SVGElement>("[data-sidebar-actions-popover-icon] svg");
		out[label] = svg
			? Array.from(svg.children).map((child) => {
				const el = child as Element;
				const attrs = ["d", "points", "cx", "cy", "r", "x1", "x2", "y1", "y2"]
					.map((name) => [name, el.getAttribute(name)] as const)
					.filter(([, value]) => value !== null)
					.map(([name, value]) => `[${name}=${JSON.stringify(value)}]`)
					.join("");
				return `${el.tagName.toLowerCase()}${attrs}`;
			})
			: [];
	}
	return out;
}

function launcherEntryIdsFromActions(): string[] {
	const launchers = listLauncherEntrypoints("session-menu" as any);
	return launchers
		.filter((launcher) => lastActions.some((action) => action.label === launcher.label))
		.map((launcher) => launcher.key);
}

function findActionIdForLauncherKey(key: string): string {
	const launcher = listLauncherEntrypoints("session-menu" as any).find((candidate) => candidate.key === key);
	const action = lastActions.find((candidate) => {
		const extra = candidate as any;
		const id = String(candidate.id);
		return id === key || id.includes(key)
			|| extra.entrypointId === key || extra.entrypointKey === key || extra.launcherKey === key
			|| (!!launcher && candidate.label === launcher.label);
	});
	if (!action) throw new Error(`launcher action ${key} not found in ${currentSurface || "unknown"} menu: ${lastActions.map((a) => a.label).join(", ")}`);
	return String(action.id);
}

async function clickMenuEntry(key: string): Promise<void> {
	const actionId = findActionIdForLauncherKey(key);
	const rows = [...document.querySelectorAll<HTMLElement>("sidebar-actions-popover [role='menuitem'][data-session-action-id]")];
	const row = rows.find((el) => el.dataset.sessionActionId === actionId);
	if (!row) throw new Error(`menu row for action ${actionId} not found`);
	row.click();
	await flush();
}

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

async function openGitDropdown(el: any): Promise<void> {
	el.expanded = true;
	await el.updateComplete;
	await flush();
}

async function flush(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 30));
}

window.addEventListener("bobbit-launcher-feedback", (ev: Event) => {
	const detail = (ev as CustomEvent<any>).detail ?? {};
	feedbackEvents.push({ kind: detail.kind, message: detail.message });
	// `resolved` clears any active launcher feedback (mirrors render.ts).
	if (detail.kind === "resolved") feedbackText = "";
	else feedbackText = String(detail.message ?? detail.error ?? detail.code ?? detail.status ?? "");
	renderFixture();
});

(window as any).__registerSessionMenu = registerSessionMenu;
(window as any).__registerWithLegacyEntrypoints = registerWithLegacyEntrypoints;
(window as any).__clearEntrypoints = clearEntrypoints;
(window as any).__installSpawnHost = installSpawnHost;
(window as any).__openSurface = openSurface;
(window as any).__closeMenu = closeMenu;
(window as any).__menuOpen = menuOpen;
(window as any).__menuLabels = menuLabels;
(window as any).__menuIconSignaturesByLabel = menuIconSignaturesByLabel;
(window as any).__launcherEntryIdsFromMenu = launcherEntryIdsFromActions;
(window as any).__clickMenuEntry = clickMenuEntry;
(window as any).__launchers = (kind?: any) => listLauncherEntrypoints(kind).map((l) => l.id);
(window as any).__key = (id: string) => launcherKey("tp", id);
(window as any).__hash = () => window.location.hash;
(window as any).__clearHash = () => { history.replaceState({}, "", window.location.pathname); };
(window as any).__feedbackText = () => normalizeLabel(feedbackText || document.getElementById("feedback")?.textContent);
(window as any).__callRouteCalls = () => callRouteCalls.slice();
(window as any).__setSessionIds = (active: string, sidebar: string) => {
	activeSessionId = active;
	sidebarSessionId = sidebar;
	renderFixture();
};
(window as any).__openPanelCalls = () => openPanelCalls.slice();
(window as any).__feedbackEvents = () => feedbackEvents.slice();
(window as any).__resolveSpawnSuccess = () => {
	// Let the real `resolved` feedback event drive the cleared state.
	resolveSpawnRoute?.({ ok: true, childSessionId: "child-prw" });
	renderFixture();
};
(window as any).__mountGit = mountGit;
(window as any).__openGitDropdown = openGitDropdown;
(window as any).__gitLaunchers = () =>
	[...document.querySelectorAll("#git-status-dropdown [data-testid='git-widget-launcher']")].map((e) => ({
		id: (e as HTMLElement).dataset.entrypointId,
		label: normalizeLabel(e.textContent),
	}));
(window as any).__gitHasPaletteOpener = () => !!document.querySelector("#git-status-dropdown [data-testid='git-widget-open-command-palette']");
(window as any).__gitDropdownText = () => normalizeLabel(document.querySelector("#git-status-dropdown")?.textContent);
(window as any).__flush = flush;
(window as any).__reset = () => {
	dismissMenuSync();
	document.querySelectorAll("git-status-widget, #git-status-dropdown").forEach((el) => el.remove());
	feedbackText = "";
	feedbackEvents.length = 0;
	callRouteCalls.length = 0;
	openPanelCalls.length = 0;
	resolveSpawnRoute = null;
	clearEntrypoints();
	activeSessionId = "active-session";
	sidebarSessionId = "sidebar-session";
	history.replaceState({}, "", window.location.pathname);
	renderFixture();
};

renderFixture();
(window as any).__ready = true;
