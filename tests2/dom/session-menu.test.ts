import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/session-menu.spec.ts (v2-dom tier).
// Ports the entire fixture harness (tests/fixtures/session-menu-entry.ts) into
// happy-dom, driving the REAL shared session action menu model + popover:
//   - buildSessionActions (src/app/session-actions.ts)
//   - registerPackEntrypoints/listLauncherEntrypoints/launcherKey (pack-entrypoints)
//   - setLauncherHostFactory (pack-panels)
//   - <sidebar-actions-popover> + <git-status-widget> custom elements.
// The popover renders its [role='menu']/[role='menuitem'] rows into light DOM
// regardless of layout (it guards getBoundingClientRect/animate/matchMedia), so
// menu-label/icon/click assertions work without real geometry.
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { SessionActionDescriptor } from "../../src/app/session-actions.js";
import type { GatewaySession } from "../../src/app/state.js";

let html: typeof import("lit").html;
let render: typeof import("lit").render;
let icon: typeof import("@mariozechner/mini-lit").icon;
let Boxes: typeof import("lucide").Boxes;
let buildSessionActions: typeof import("../../src/app/session-actions.js").buildSessionActions;
let registerPackEntrypoints: typeof import("../../src/app/pack-entrypoints.js").registerPackEntrypoints;
let listLauncherEntrypoints: typeof import("../../src/app/pack-entrypoints.js").listLauncherEntrypoints;
let launcherKey: typeof import("../../src/app/pack-entrypoints.js").launcherKey;
let setLauncherHostFactory: typeof import("../../src/app/pack-panels.js").setLauncherHostFactory;

beforeAll(async () => {
	({ html, render } = await import("lit"));
	({ icon } = await import("@mariozechner/mini-lit"));
	({ Boxes } = await import("lucide"));
	await import("../../src/ui/components/SidebarActionsPopover.js");
	await import("../../src/ui/components/GitStatusWidget.js");
	({ buildSessionActions } = await import("../../src/app/session-actions.js"));
	({ registerPackEntrypoints, listLauncherEntrypoints, launcherKey } = await import("../../src/app/pack-entrypoints.js"));
	({ setLauncherHostFactory } = await import("../../src/app/pack-panels.js"));
});

let app: HTMLElement;
let lastActions: SessionActionDescriptor[] = [];
let activePopover: HTMLElement | null = null;
let currentSurface: "sidebar" | "header" | null = null;
let feedbackText = "";
const feedbackEvents: Array<{ kind?: string; message?: string }> = [];
let activeSessionId = "active-session";
let sidebarSessionId = "sidebar-session";

type SpawnBehavior = "defer" | "nopr" | "throw";
let resolveSpawnRoute: ((value: { ok: boolean; childSessionId?: string }) => void) | null = null;
let callRouteCalls: Array<{ route: string; body?: unknown; sessionId?: string; packId: string; contributionId: string }> = [];
let openPanelCalls: Array<{ panelId?: string; sessionId?: string }> = [];

function fakeSession(id: string): GatewaySession {
	return {
		id, title: "Fixture session", cwd: "/tmp/project", status: "idle",
		createdAt: Date.now(), updatedAt: Date.now(), role: "assistant",
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
	if (!row) throw new Error(`menu row for action ${JSON.stringify(actionId)} not found`);
	row.click();
	await flush();
}

async function mountGit(): Promise<any> {
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

function flush(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 30));
}

async function waitForFeedback(re: RegExp, timeout = 2000): Promise<void> {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		if (re.test(feedbackTextValue())) return;
		await flush();
	}
}

const key = (id: string) => launcherKey("tp", id);
const hash = () => window.location.hash;
const feedbackTextValue = () => normalizeLabel(feedbackText || document.getElementById("feedback")?.textContent);
const launchers = (kind?: any) => listLauncherEntrypoints(kind).map((l) => l.id);
const gitLaunchers = () =>
	[...document.querySelectorAll("#git-status-dropdown [data-testid='git-widget-launcher']")].map((e) => ({
		id: (e as HTMLElement).dataset.entrypointId,
		label: normalizeLabel(e.textContent),
	}));
const gitHasPaletteOpener = () => !!document.querySelector("#git-status-dropdown [data-testid='git-widget-open-command-palette']");
const gitDropdownText = () => normalizeLabel(document.querySelector("#git-status-dropdown")?.textContent);

function resolveSpawnSuccess(): void {
	// Let the real `resolved` feedback event (from session-actions.ts) drive the
	// cleared state rather than stamping feedbackText by hand.
	resolveSpawnRoute?.({ ok: true, childSessionId: "child-prw" });
	renderFixture();
}

function setSessionIds(active: string, sidebar: string): void {
	activeSessionId = active;
	sidebarSessionId = sidebar;
	renderFixture();
}

const onFeedback = (ev: Event) => {
	const detail = (ev as CustomEvent<any>).detail ?? {};
	feedbackEvents.push({ kind: detail.kind, message: detail.message });
	// `resolved` clears any active launcher feedback (mirrors render.ts).
	if (detail.kind === "resolved") feedbackText = "";
	else feedbackText = String(detail.message ?? detail.error ?? detail.code ?? detail.status ?? "");
	renderFixture();
};

function reset(): void {
	dismissMenuSync();
	document.querySelectorAll("git-status-widget, #git-status-dropdown").forEach((el) => el.remove());
	feedbackText = "";
	feedbackEvents.length = 0;
	callRouteCalls = [];
	openPanelCalls = [];
	resolveSpawnRoute = null;
	clearEntrypoints();
	activeSessionId = "active-session";
	sidebarSessionId = "sidebar-session";
	history.replaceState({}, "", window.location.pathname);
	renderFixture();
}

beforeEach(async () => {
	document.body.innerHTML = "";
	app = document.createElement("div");
	app.id = "app";
	document.body.appendChild(app);
	window.addEventListener("bobbit-launcher-feedback", onFeedback);
	reset();
	// Drain any queued hashchange/popstate from a prior test's navigation so it
	// cannot close this test's popover (the popover legitimately closes on route
	// change). happy-dom may fire these asynchronously after replaceState.
	await flush();
});

afterEach(async () => {
	// Settle any still-pending deferred spawn so runSpawnLauncher's `finally`
	// clears its module-level in-flight guard (keyed by launcher key, shared across
	// tests under isolate:false) — otherwise the next spawn of the same key is
	// silently ignored.
	if (resolveSpawnRoute) {
		resolveSpawnRoute({ ok: true, childSessionId: "cleanup" });
		resolveSpawnRoute = null;
		await flush();
	}
	window.removeEventListener("bobbit-launcher-feedback", onFeedback);
	dismissMenuSync();
	document.body.innerHTML = "";
	setLauncherHostFactory(null as any);
	clearEntrypoints();
	history.replaceState({}, "", window.location.pathname);
});

describe("pack launcher session-menu surfaces", () => {
	it("renders session-menu launchers in the sidebar session menu", async () => {
		registerSessionMenu();
		await openSurface("sidebar");
		const labels = menuLabels();
		const launcherIds = launcherEntryIdsFromActions();
		expect(labels).toEqual(expect.arrayContaining(["Open Demo", "PR Walkthrough", "Broken Walkthrough"]));
		expect(launcherIds).toContain(key("sm.route"));
		// Opening the menu must not auto-invoke any launcher.
		expect(hash()).toBe("");
	});

	it("renders the same session-menu launchers in the chat header menu", async () => {
		registerSessionMenu();
		await openSurface("header");
		const labels = menuLabels();
		const launcherIds = launcherEntryIdsFromActions();
		expect(labels).toEqual(expect.arrayContaining(["Open Demo", "PR Walkthrough", "Broken Walkthrough"]));
		expect(launcherIds).toEqual(expect.arrayContaining([key("sm.route"), key("sm.spawn")]));
	});

	it("renders resolved launcher icons in sidebar and chat header menus", async () => {
		const terminalSignatures = ["path[d=\"M12 19h8\"]", "path[d=\"m4 17 6-6-6-6\"]"];
		const gitPullRequestSignatures = ["circle[cx=\"18\"][cy=\"18\"][r=\"3\"]", "line[x1=\"6\"][x2=\"6\"][y1=\"9\"][y2=\"21\"]"];
		const zapSignature = "path[d=\"M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z\"]";

		for (const surface of ["sidebar", "header"] as const) {
			reset();
			registerSessionMenu();
			await openSurface(surface);
			const signaturesByLabel = menuIconSignaturesByLabel();
			expect(signaturesByLabel["Open Demo"]).toEqual(expect.arrayContaining(terminalSignatures));
			expect(signaturesByLabel["PR Walkthrough"]).toEqual(expect.arrayContaining(gitPullRequestSignatures));
			expect(signaturesByLabel["Missing Route"]).toContain(zapSignature);
			expect(signaturesByLabel["Broken Walkthrough"]).toContain(zapSignature);
		}
	});

	it("clicking a route launcher uses runLauncherEntrypoint and closes the menu", async () => {
		registerSessionMenu();
		await openSurface("sidebar");
		await clickMenuEntry(key("sm.route"));
		expect(hash()).toBe("#/ext/demo.route?itemId=x1");
		expect(menuOpen()).toBe(false);
	});

	it("unresolved route launchers show visible feedback without opening or switching", async () => {
		registerSessionMenu();
		await openSurface("sidebar");
		await clickMenuEntry(key("sm.missing"));
		await waitForFeedback(/missing\.route|unavailable/i);
		expect(feedbackTextValue()).toMatch(/missing\.route|unavailable/i);
		expect(hash()).toBe("");
		expect(menuOpen()).toBe(false);
		expect(openPanelCalls).toEqual([]);
	});

	it("spawn launcher shows pending feedback, then opens the returned child panel on success", async () => {
		registerSessionMenu();
		installSpawnHost("defer");
		await openSurface("header");
		await clickMenuEntry(key("sm.spawn"));
		await flush();
		expect(feedbackTextValue()).toMatch(/Starting PR walkthrough/i);
		expect(menuOpen()).toBe(false);
		expect(callRouteCalls).toHaveLength(1);
		expect(callRouteCalls[0]).toMatchObject({ route: "run", packId: "tp", contributionId: "sm.spawn" });
		expect(openPanelCalls).toEqual([]);

		resolveSpawnSuccess();
		await flush();
		// Item 2: success emits a `resolved` event that clears the persistent pending
		// feedback (the panel opening is the confirmation) rather than leaving text.
		expect(feedbackEvents).toContainEqual({ kind: "resolved", message: "" });
		expect(feedbackTextValue()).toBe("");
		expect(openPanelCalls).toEqual([{ panelId: "demo.viewer", sessionId: "child-prw" }]);
	});

	it("sidebar launchers bind to the row session even when another session is active", async () => {
		setSessionIds("active-session", "inactive-sidebar-session");
		registerSessionMenu();
		installSpawnHost("defer");
		await openSurface("sidebar");
		await clickMenuEntry(key("sm.spawn"));
		await flush();
		expect(callRouteCalls).toHaveLength(1);
		expect(callRouteCalls[0]).toMatchObject({ route: "run", sessionId: "inactive-sidebar-session", packId: "tp", contributionId: "sm.spawn" });
		expect(callRouteCalls[0].sessionId).not.toBe("active-session");
	});

	it("NO_PR and thrown route failures show visible feedback without opening or switching", async () => {
		registerSessionMenu();
		installSpawnHost("nopr");
		await openSurface("sidebar");
		await clickMenuEntry(key("sm.spawn"));
		await waitForFeedback(/No open GitHub PR|NO_PR/i);
		expect(feedbackTextValue()).toMatch(/No open GitHub PR|NO_PR/i);
		expect(menuOpen()).toBe(false);
		expect(openPanelCalls).toEqual([]);

		reset();
		registerSessionMenu();
		installSpawnHost("throw");
		await openSurface("header");
		await clickMenuEntry(key("sm.spawn"));
		await waitForFeedback(/route exploded/i);
		expect(feedbackTextValue()).toMatch(/route exploded/i);
		expect(menuOpen()).toBe(false);
		expect(openPanelCalls).toEqual([]);
	});

	it("reload/reconcile removal and restoration updates both menu surfaces", async () => {
		registerSessionMenu();
		clearEntrypoints();
		await openSurface("sidebar");
		const removedSidebar = menuLabels();
		await closeMenu();
		await openSurface("header");
		const removedHeader = menuLabels();
		expect(removedSidebar).not.toContain("Open Demo");
		expect(removedHeader).not.toContain("Open Demo");

		registerSessionMenu();
		await closeMenu();
		await openSurface("sidebar");
		const restoredSidebar = menuLabels();
		await closeMenu();
		await openSurface("header");
		const restoredHeader = menuLabels();
		expect(restoredSidebar).toContain("Open Demo");
		expect(restoredHeader).toContain("Open Demo");
	});

	it("legacy command-palette and git-widget-button launchers are ignored and never rendered", async () => {
		registerWithLegacyEntrypoints();
		await openSurface("sidebar");
		const labels = menuLabels();
		expect(labels).toContain("Open Demo");
		expect(labels).not.toContain("Legacy Palette");
		expect(labels).not.toContain("Legacy Git Button");
		expect(launchers("session-menu")).toEqual(["sm.route"]);
		expect(launchers("command-palette")).toEqual([]);
		expect(launchers("git-widget-button")).toEqual([]);
		expect(launchers()).toEqual(["sm.route"]);
	});

	it("Git status dropdown has no extension launcher buttons or command palette opener", async () => {
		registerWithLegacyEntrypoints();
		const el = await mountGit();
		await openGitDropdown(el);
		expect(gitLaunchers()).toEqual([]);
		expect(gitHasPaletteOpener()).toBe(false);
		expect(gitDropdownText()).not.toMatch(/Extensions|Command palette|Legacy Git Button|Open Demo/);
	});
});
