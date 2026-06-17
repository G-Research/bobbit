/**
 * Slice C1 launcher SURFACES — wires the previously-unrendered `git-widget-button`
 * + `command-palette` entrypoint kinds to real host surfaces (extension-host-phase2
 * §7 C1.3). Bundles the REAL <command-palette> + <git-status-widget> Lit components
 * (not replicas) and drives them through the production client pack-entrypoints
 * registry. Pins:
 *   - command palette lists registered `command-palette` launchers + filters them;
 *   - clicking a launcher runs it (route target → #/ext/<routeId>?<params>);
 *   - NO auto-invoke on mount/open (opening the palette touches no launcher);
 *   - git-widget dropdown renders `git-widget-button` launchers + a palette opener;
 *   - clicking a git launcher runs it; the opener opens the shared palette;
 *   - an empty registry (uninstall) yields no launchers + no opener (reconciled).
 */
import { test, expect } from "@playwright/test";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const FIXTURE = path.resolve("tests/fixtures/command-palette.html");
const BUNDLE = path.resolve("tests/fixtures/command-palette-bundle.js");
const ENTRY = path.resolve("tests/fixtures/command-palette-entry.ts");
const SRCS = [
	path.resolve("src/ui/components/CommandPalette.ts"),
	path.resolve("src/ui/components/GitStatusWidget.ts"),
	path.resolve("src/app/pack-entrypoints.ts"),
	path.resolve("src/app/pack-panels.ts"),
	path.resolve("src/app/routing.ts"),
];

test.beforeAll(() => {
	const entryMtime = Math.max(fs.statSync(ENTRY).mtimeMs, ...SRCS.map((s) => fs.statSync(s).mtimeMs));
	const stale = fs.existsSync(BUNDLE) && fs.statSync(BUNDLE).mtimeMs < entryMtime;
	if (!fs.existsSync(BUNDLE) || stale) {
		execSync(
			[
				`npx esbuild ${ENTRY}`,
				"--bundle --format=iife --target=es2022",
				`--outfile=${BUNDLE}`,
				"--tsconfig=tsconfig.web.json",
				"--alias:pdfjs-dist=./tests/fixtures/empty-shim",
				"--define:import.meta.url='\"http://localhost/\"'",
			].join(" "),
			{ stdio: "pipe" },
		);
	}
});

const PAGE = `file://${FIXTURE}`;
async function ready(page: any) {
	await page.goto(PAGE);
	await page.waitForFunction(() => (window as any).__ready === true, null, { timeout: 10_000 });
	await page.evaluate(() => (window as any).__clearHash());
}

test.describe("Command palette surface (C1 command-palette launchers)", () => {
	test("lists registered command-palette launchers; NO auto-invoke on open", async ({ page }) => {
		await ready(page);
		const items = await page.evaluate(() => {
			const w = window as any;
			w.__register();
			w.__openPalette();
			return { items: w.__paletteItems(), ids: w.__paletteIds(), hash: w.__hash(), keys: [w.__key("cp.nav"), w.__key("cp.other")] };
		});
		expect(items.items).toEqual(["Open Demo (palette)", "Second Command"]);
		// data-entrypoint-id carries the COMPOUND launcher key (packId+id).
		expect(items.ids).toEqual(items.keys);
		// Opening the palette must NOT have navigated/invoked any launcher.
		expect(items.hash).toBe("");
	});

	test("clicking a launcher runs it (route target → #/ext/<routeId>) and closes", async ({ page }) => {
		await ready(page);
		const result = await page.evaluate(() => {
			const w = window as any;
			w.__register();
			w.__openPalette();
			w.__clickPaletteItem(w.__key("cp.nav"));
			return { hash: w.__hash(), open: w.__paletteOpen() };
		});
		expect(result.hash).toBe("#/ext/demo.route?itemId=x1");
		expect(result.open).toBe(false);
	});

	test("filter narrows the list", async ({ page }) => {
		await ready(page);
		const filtered = await page.evaluate(() => {
			const w = window as any;
			w.__register();
			w.__openPalette();
			w.__filterPalette("second");
			return { ids: w.__paletteIds(), key: w.__key("cp.other") };
		});
		expect(filtered.ids).toEqual([filtered.key]);
	});
});

test.describe("Git-widget launcher surface (C1 git-widget-button)", () => {
	test("dropdown renders git-widget-button launchers + a command-palette opener", async ({ page }) => {
		await ready(page);
		const out = await page.evaluate(async () => {
			const w = window as any;
			w.__register();
			const el = await w.__mountGit();
			await w.__openGitDropdown(el);
			return { launchers: w.__gitLaunchers(), hasOpener: w.__gitHasPaletteOpener(), hash: w.__hash(), key: w.__key("gw.nav") };
		});
		// data-entrypoint-id carries the COMPOUND launcher key (packId+id).
		expect(out.launchers).toEqual([{ id: out.key, label: "Demo Git Button" }]);
		expect(out.hasOpener).toBe(true);
		// Rendering the dropdown must NOT auto-invoke any launcher.
		expect(out.hash).toBe("");
	});

	test("clicking a git launcher runs it; opener opens the shared palette", async ({ page }) => {
		await ready(page);
		const click = await page.evaluate(async () => {
			const w = window as any;
			w.__register();
			const el = await w.__mountGit();
			await w.__openGitDropdown(el);
			w.__clickGitLauncher(w.__key("gw.nav"));
			return w.__hash();
		});
		expect(click).toBe("#/ext/demo.route?itemId=g1");

		const opened = await page.evaluate(async () => {
			const w = window as any;
			w.__clearHash();
			w.__register();
			const el = await w.__mountGit();
			await w.__openGitDropdown(el);
			w.__clickGitPaletteOpener();
			return w.__paletteOpen();
		});
		expect(opened).toBe(true);
	});

	test("spawn launcher shows immediate pending feedback while route request is in flight", async ({ page }) => {
		await ready(page);
		const out = await page.evaluate(async () => {
			const w = window as any;
			w.__registerSpawn();
			const key = w.__packKey("pr-walkthrough", "gw.spawn");
			const el = await w.__mountGit();
			await w.__openGitDropdown(el);
			w.__clickGitLauncher(key);
			return {
				pending: w.__gitLauncherPending(),
				disabled: w.__gitLauncherDisabled(key),
				calls: w.__getSpawnRouteCalls(),
			};
		});

		expect(out.pending).toBe("Starting PR walkthrough…");
		expect(out.disabled).toBe(true);
		expect(out.calls).toHaveLength(1);
		expect(out.calls[0]).toMatchObject({ route: "run", packId: "pr-walkthrough", contributionId: "gw.spawn" });
	});

	test("empty registry (uninstall) yields no launchers + no opener", async ({ page }) => {
		await ready(page);
		const out = await page.evaluate(async () => {
			const w = window as any;
			w.__clearRegistry();
			const el = await w.__mountGit();
			await w.__openGitDropdown(el);
			w.__openPalette();
			return { launchers: w.__gitLaunchers(), hasOpener: w.__gitHasPaletteOpener(), items: w.__paletteItems() };
		});
		expect(out.launchers).toEqual([]);
		expect(out.hasOpener).toBe(false);
		expect(out.items).toEqual([]);
	});
});
