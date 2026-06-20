/**
 * Pack launcher session-menu surfaces — the single supported host launcher
 * surface for pack-contributed menu entrypoints. Bundles the real shared session
 * actions model, SidebarActionsPopover, GitStatusWidget, and client entrypoint
 * registry to pin:
 *   - `session-menu` launchers render in both sidebar and chat header menus;
 *   - route targets dispatch through `runLauncherEntrypoint` to #/ext/<routeId>;
 *   - spawn targets surface pending/success/error feedback and open child panels
 *     only after success;
 *   - legacy `command-palette` / `git-widget-button` launchers stay hidden;
 *   - Git status dropdown has no extension launcher/opener section.
 */
import { test, expect } from "@playwright/test";
import path from "node:path";
import { buildBundle } from "./fixtures/build-bundle";

const FIXTURE = path.resolve("tests/fixtures/session-menu.html");
const BUNDLE = path.resolve("tests/fixtures/session-menu-bundle.js");
const ENTRY = path.resolve("tests/fixtures/session-menu-entry.ts");
const SRCS = [
	ENTRY,
	path.resolve("src/app/session-actions.ts"),
	path.resolve("src/app/pack-entrypoints.ts"),
	path.resolve("src/app/pack-panels.ts"),
	path.resolve("src/app/routing.ts"),
	path.resolve("src/ui/components/SidebarActionsPopover.ts"),
	path.resolve("src/ui/components/GitStatusWidget.ts"),
];

test.beforeAll(() => {
	buildBundle({ entry: ENTRY, outfile: BUNDLE, deps: SRCS });
});

const PAGE = `file://${FIXTURE}`;
async function ready(page: any) {
	await page.goto(PAGE);
	await page.waitForFunction(() => (window as any).__ready === true, null, { timeout: 10_000 });
	await page.evaluate(() => (window as any).__reset());
}

test.describe("pack launcher session-menu surfaces", () => {
	test("renders session-menu launchers in the sidebar session menu", async ({ page }) => {
		await ready(page);
		const out = await page.evaluate(async () => {
			const w = window as any;
			w.__registerSessionMenu();
			await w.__openSurface("sidebar");
			return { labels: w.__menuLabels(), launcherIds: w.__launcherEntryIdsFromMenu(), hash: w.__hash(), routeKey: w.__key("sm.route") };
		});
		expect(out.labels).toEqual(expect.arrayContaining(["Open Demo", "PR Walkthrough", "Broken Walkthrough"]));
		expect(out.launcherIds).toContain(out.routeKey);
		// Opening the menu must not auto-invoke any launcher.
		expect(out.hash).toBe("");
	});

	test("renders the same session-menu launchers in the chat header menu", async ({ page }) => {
		await ready(page);
		const out = await page.evaluate(async () => {
			const w = window as any;
			w.__registerSessionMenu();
			await w.__openSurface("header");
			return { labels: w.__menuLabels(), launcherIds: w.__launcherEntryIdsFromMenu(), routeKey: w.__key("sm.route"), spawnKey: w.__key("sm.spawn") };
		});
		expect(out.labels).toEqual(expect.arrayContaining(["Open Demo", "PR Walkthrough", "Broken Walkthrough"]));
		expect(out.launcherIds).toEqual(expect.arrayContaining([out.routeKey, out.spawnKey]));
	});

	test("clicking a route launcher uses runLauncherEntrypoint and closes the menu", async ({ page }) => {
		await ready(page);
		const out = await page.evaluate(async () => {
			const w = window as any;
			w.__registerSessionMenu();
			await w.__openSurface("sidebar");
			await w.__clickMenuEntry(w.__key("sm.route"));
			return { hash: w.__hash(), open: w.__menuOpen() };
		});
		expect(out.hash).toBe("#/ext/demo.route?itemId=x1");
		expect(out.open).toBe(false);
	});

	test("spawn launcher shows pending feedback, then opens the returned child panel on success", async ({ page }) => {
		await ready(page);
		const pending = await page.evaluate(async () => {
			const w = window as any;
			w.__registerSessionMenu();
			w.__installSpawnHost("defer");
			await w.__openSurface("header");
			await w.__clickMenuEntry(w.__key("sm.spawn"));
			await w.__flush();
			return { feedback: w.__feedbackText(), open: w.__menuOpen(), calls: w.__callRouteCalls(), panels: w.__openPanelCalls() };
		});
		expect(pending.feedback).toMatch(/Starting PR walkthrough/i);
		expect(pending.open).toBe(false);
		expect(pending.calls).toHaveLength(1);
		expect(pending.calls[0]).toMatchObject({ route: "run", packId: "tp", contributionId: "sm.spawn" });
		expect(pending.panels).toEqual([]);

		const success = await page.evaluate(async () => {
			const w = window as any;
			w.__resolveSpawnSuccess();
			await w.__flush();
			return { feedback: w.__feedbackText(), panels: w.__openPanelCalls() };
		});
		expect(success.feedback).toMatch(/PR walkthrough|Started|Opening/i);
		expect(success.panels).toEqual([{ panelId: "demo.viewer", sessionId: "child-prw" }]);
	});

	test("sidebar launchers bind to the row session even when another session is active", async ({ page }) => {
		await ready(page);
		const out = await page.evaluate(async () => {
			const w = window as any;
			w.__setSessionIds("active-session", "inactive-sidebar-session");
			w.__registerSessionMenu();
			w.__installSpawnHost("defer");
			await w.__openSurface("sidebar");
			await w.__clickMenuEntry(w.__key("sm.spawn"));
			await w.__flush();
			return { calls: w.__callRouteCalls(), active: "active-session", sidebar: "inactive-sidebar-session" };
		});
		expect(out.calls).toHaveLength(1);
		expect(out.calls[0]).toMatchObject({ route: "run", sessionId: out.sidebar, packId: "tp", contributionId: "sm.spawn" });
		expect(out.calls[0].sessionId).not.toBe(out.active);
	});

	test("NO_PR and thrown route failures show visible feedback without opening or switching", async ({ page }) => {
		await ready(page);
		const noPr = await page.evaluate(async () => {
			const w = window as any;
			w.__registerSessionMenu();
			w.__installSpawnHost("nopr");
			await w.__openSurface("sidebar");
			await w.__clickMenuEntry(w.__key("sm.spawn"));
			await w.__flush();
			return { feedback: w.__feedbackText(), open: w.__menuOpen(), panels: w.__openPanelCalls() };
		});
		expect(noPr.feedback).toMatch(/No open GitHub PR|NO_PR/i);
		expect(noPr.open).toBe(false);
		expect(noPr.panels).toEqual([]);

		const thrown = await page.evaluate(async () => {
			const w = window as any;
			w.__reset();
			w.__registerSessionMenu();
			w.__installSpawnHost("throw");
			await w.__openSurface("header");
			await w.__clickMenuEntry(w.__key("sm.spawn"));
			await w.__flush();
			return { feedback: w.__feedbackText(), open: w.__menuOpen(), panels: w.__openPanelCalls() };
		});
		expect(thrown.feedback).toMatch(/route exploded/i);
		expect(thrown.open).toBe(false);
		expect(thrown.panels).toEqual([]);
	});

	test("reload/reconcile removal and restoration updates both menu surfaces", async ({ page }) => {
		await ready(page);
		const removed = await page.evaluate(async () => {
			const w = window as any;
			w.__registerSessionMenu();
			w.__clearEntrypoints();
			await w.__openSurface("sidebar");
			const sidebar = w.__menuLabels();
			await w.__closeMenu();
			await w.__openSurface("header");
			return { sidebar, header: w.__menuLabels() };
		});
		expect(removed.sidebar).not.toContain("Open Demo");
		expect(removed.header).not.toContain("Open Demo");

		const restored = await page.evaluate(async () => {
			const w = window as any;
			w.__registerSessionMenu();
			await w.__closeMenu();
			await w.__openSurface("sidebar");
			const sidebar = w.__menuLabels();
			await w.__closeMenu();
			await w.__openSurface("header");
			return { sidebar, header: w.__menuLabels() };
		});
		expect(restored.sidebar).toContain("Open Demo");
		expect(restored.header).toContain("Open Demo");
	});

	test("legacy command-palette and git-widget-button launchers are ignored and never rendered", async ({ page }) => {
		await ready(page);
		const out = await page.evaluate(async () => {
			const w = window as any;
			w.__registerWithLegacyEntrypoints();
			await w.__openSurface("sidebar");
			return {
				labels: w.__menuLabels(),
				allLaunchers: w.__launchers(),
				sessionMenuLaunchers: w.__launchers("session-menu"),
				oldPaletteLaunchers: w.__launchers("command-palette"),
				oldGitLaunchers: w.__launchers("git-widget-button"),
			};
		});
		expect(out.labels).toContain("Open Demo");
		expect(out.labels).not.toContain("Legacy Palette");
		expect(out.labels).not.toContain("Legacy Git Button");
		expect(out.sessionMenuLaunchers).toEqual(["sm.route"]);
		expect(out.oldPaletteLaunchers).toEqual([]);
		expect(out.oldGitLaunchers).toEqual([]);
		expect(out.allLaunchers).toEqual(["sm.route"]);
	});

	test("Git status dropdown has no extension launcher buttons or command palette opener", async ({ page }) => {
		await ready(page);
		const out = await page.evaluate(async () => {
			const w = window as any;
			w.__registerWithLegacyEntrypoints();
			const el = await w.__mountGit();
			await w.__openGitDropdown(el);
			return { launchers: w.__gitLaunchers(), opener: w.__gitHasPaletteOpener(), text: w.__gitDropdownText() };
		});
		expect(out.launchers).toEqual([]);
		expect(out.opener).toBe(false);
		expect(out.text).not.toMatch(/Extensions|Command palette|Legacy Git Button|Open Demo/);
	});
});
