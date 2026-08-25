import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { buildBundle } from "../fixtures/build-bundle.js";

const SHELL = path.resolve("tests/ui-fixtures/fixture-shell.html");
const FIXTURE_ORIGIN = "http://fixture.localhost";
const FIXTURE_SHELL_URL = `${FIXTURE_ORIGIN}/fixture-shell.html`;
const ENTRY = path.resolve("tests/ui-fixtures/dynamic-panel-workspace-fixture-entry.ts");
const BUNDLE_DIR = path.resolve(".bobbit/tmp/ui-fixtures");
const BUNDLE = path.join(BUNDLE_DIR, "dynamic-panel-workspace-fixture-bundle.js");

const APP_RENDER_SRC = path.resolve("src/app/render.ts");
const APP_STATE_SRC = path.resolve("src/app/state.ts");
const SIDE_PANEL_WORKSPACE_SRC = path.resolve("src/app/side-panel-workspace.ts");
const PANEL_WORKSPACE_SRC = path.resolve("src/app/panel-workspace.ts");
const PREVIEW_RENDERER_SRC = path.resolve("src/ui/tools/renderers/PreviewRenderer.ts");
const REVIEW_PANE_SRC = path.resolve("src/ui/components/review/ReviewPane.ts");
const REVIEW_DOCUMENT_SRC = path.resolve("src/ui/components/review/ReviewDocument.ts");
const ANNOTATION_STORE_SRC = path.resolve("src/ui/components/review/AnnotationStore.ts");

const PANEL_TAB_SELECTOR = ".goal-tab-pill";
const GOAL_TAB_RE = /^Goal( Proposal)?$/i;
const PREVIEW_TAB_RE = /\.html(?:\s*\(v\d+\))?$/i;
function hashOf(char: string): string {
	return char.repeat(64);
}

test.beforeAll(() => {
	fs.mkdirSync(BUNDLE_DIR, { recursive: true });
	buildBundle({
		entry: ENTRY,
		outfile: BUNDLE,
		deps: [
			ENTRY,
			APP_RENDER_SRC,
			APP_STATE_SRC,
			SIDE_PANEL_WORKSPACE_SRC,
			PANEL_WORKSPACE_SRC,
			PREVIEW_RENDERER_SRC,
			REVIEW_PANE_SRC,
			REVIEW_DOCUMENT_SRC,
			ANNOTATION_STORE_SRC,
		],
	});
});

async function loadFixture(page: Page): Promise<void> {
	await page.route(`${FIXTURE_ORIGIN}/**`, async (route) => {
		const pathname = new URL(route.request().url()).pathname;
		await route.fulfill({
			contentType: "text/html",
			body: pathname === "/fixture-shell.html"
				? fs.readFileSync(SHELL, "utf8")
				: "<!doctype html><html><body>Fixture preview</body></html>",
		});
	});
	await page.goto(FIXTURE_SHELL_URL);
	await page.addScriptTag({ path: BUNDLE });
	await page.waitForFunction(() => (window as any).__dynamicPanelWorkspaceReady === true, null, { timeout: 10_000 });
	await page.evaluate(() => (window as any).__resetDynamicPanelWorkspaceFixture());
	await expect(page.locator("[data-testid='fixture-chat'] textarea")).toBeVisible({ timeout: 10_000 });
}

async function reloadAndRehydrateFixture(page: Page): Promise<void> {
	await page.reload();
	await page.addScriptTag({ path: BUNDLE });
	await page.waitForFunction(() => (window as any).__dynamicPanelWorkspaceReady === true, null, { timeout: 10_000 });
	await page.evaluate(() => (window as any).__rehydrateDynamicPanelWorkspaceFixture());
}

async function sessions(page: Page): Promise<{ a: string; b: string }> {
	return page.evaluate(() => (window as any).__dynamicPanelWorkspaceSessions);
}

async function fixtureState(page: Page): Promise<any> {
	return page.evaluate(() => (window as any).__getDynamicPanelWorkspaceState());
}

async function visiblePanelTabs(page: Page): Promise<Array<{ index: number; label: string; title: string; id: string; kind: string; active: boolean }>> {
	return page.locator(PANEL_TAB_SELECTOR).evaluateAll((buttons) => buttons
		.map((button, index) => {
			const el = button as HTMLElement;
			const style = window.getComputedStyle(el);
			const rect = el.getBoundingClientRect();
			if (style.visibility === "hidden" || style.display === "none" || rect.width <= 0 || rect.height <= 0) return null;
			const normalize = (value: string | null | undefined) => (value || "").replace(/\s+/g, " ").trim();
			const label = normalize(button.getAttribute("title") || button.textContent);
			return label ? {
				index,
				label,
				title: normalize(button.getAttribute("data-panel-tab-title")),
				id: normalize(button.getAttribute("data-panel-tab-id")),
				kind: normalize(button.getAttribute("data-panel-tab-kind")),
				active: button.classList.contains("goal-tab-pill--active"),
			} : null;
		})
		.filter(Boolean) as Array<{ index: number; label: string; title: string; id: string; kind: string; active: boolean }>);
}

async function visiblePanelTabLabels(page: Page): Promise<string[]> {
	return (await visiblePanelTabs(page)).map((tab) => tab.label);
}

async function waitForTopLevelTabCounts(
	page: Page,
	expectations: Array<{ name: string; match: RegExp; min: number }>,
	errorPrefix: string,
): Promise<void> {
	try {
		await expect.poll(async () => {
			const labels = await visiblePanelTabLabels(page);
			return expectations.every((expected) => labels.filter((label) => expected.match.test(label)).length >= expected.min);
		}, { timeout: 10_000, message: errorPrefix }).toBe(true);
	} catch {
		const labels = await visiblePanelTabLabels(page);
		const counts = expectations
			.map((expected) => `${expected.name}=${labels.filter((label) => expected.match.test(label)).length}/${expected.min}`)
			.join(", ");
		throw new Error(`${errorPrefix}; counts: ${counts}; visible tabs were: ${labels.join(", ") || "<none>"}`);
	}
}

async function selectTopLevelTab(page: Page, label: RegExp, errorPrefix: string): Promise<string> {
	try {
		await expect.poll(async () => {
			const tabs = await visiblePanelTabs(page);
			return tabs.some((tab) => label.test(tab.label) || label.test(tab.title));
		}, { timeout: 5_000, message: `${errorPrefix}: expected selectable tab ${label}` }).toBe(true);
	} catch {
		const tabs = await visiblePanelTabs(page);
		throw new Error(`${errorPrefix}: expected selectable tab ${label}; visible tabs were: ${tabs.map((tab) => `${tab.label} [${tab.title}]`).join(", ") || "<none>"}`);
	}

	const tabs = await visiblePanelTabs(page);
	const match = tabs.find((tab) => label.test(tab.label) || label.test(tab.title));
	if (!match) {
		throw new Error(`${errorPrefix}: expected selectable tab ${label}; visible tabs changed before click; visible tabs were: ${tabs.map((tab) => `${tab.label} [${tab.title}]`).join(", ") || "<none>"}`);
	}
	const tab = page.locator(PANEL_TAB_SELECTOR).nth(match.index);
	await tab.evaluate((el) => (el as HTMLElement).scrollIntoView({ block: "nearest", inline: "center" }));
	await tab.click();
	return match.label;
}

async function selectTopLevelTabByTitle(page: Page, title: RegExp, errorPrefix: string): Promise<void> {
	await selectTopLevelTab(page, title, errorPrefix);
}

async function clickTopLevelTabById(page: Page, id: string, errorPrefix: string): Promise<void> {
	const tabs = await visiblePanelTabs(page);
	const match = tabs.find((tab) => tab.id === id);
	if (!match) {
		throw new Error(`${errorPrefix}: expected selectable tab id ${id}; visible tabs were: ${JSON.stringify(tabs)}`);
	}
	await page.locator(PANEL_TAB_SELECTOR).nth(match.index).click();
}

async function expectPreviewEntry(page: Page, entry: string, hash: string, errorPrefix: string): Promise<void> {
	await expect.poll(async () => {
		const state = await fixtureState(page);
		return { entry: state.previewPanelEntry, hash: state.previewPanelContentHash };
	}, { timeout: 5_000, message: `${errorPrefix}: preview state should restore ${entry}` }).toEqual({ entry, hash });
	await expect(page.locator(".goal-preview-panel iframe").first(), `${errorPrefix}: preview iframe should be mounted`).toBeVisible({ timeout: 5_000 });
	await expect(page.locator(".goal-preview-panel iframe").first(), `${errorPrefix}: preview iframe should target ${entry}`).toHaveAttribute("src", new RegExp(`/preview/.*/${entry.replace(/\./g, "\\.")}`));
}

async function expectGoalProposalAccessible(page: Page, errorPrefix: string): Promise<void> {
	await selectTopLevelTab(page, GOAL_TAB_RE, `${errorPrefix}: Goal proposal tab should be selectable`);
	await expect(page.locator('[data-panel="goal-proposal"] input[placeholder="Goal title"]').first(), `${errorPrefix}: goal title input`).toHaveValue("Fixture Dynamic Goal", { timeout: 10_000 });
}

async function setGoalProposal(page: Page): Promise<void> {
	await page.evaluate(() => (window as any).__setDynamicGoalProposal({
		title: "Fixture Dynamic Goal",
		cwd: "/tmp/dynamic-workspace",
		spec: "Fixture dynamic goal spec.",
	}));
}

async function setLivePreview(page: Page, entry: string, contentHash: string, bodyText = entry): Promise<void> {
	await page.evaluate(({ entry, contentHash, bodyText }) => (window as any).__setDynamicLivePreview({ entry, contentHash, bodyText }), { entry, contentHash, bodyText });
}

async function setHistoricalPreviews(page: Page, sessionId: string, previews: Array<{ toolId: string; entry: string; bodyText: string; contentHash: string }>): Promise<void> {
	await page.evaluate(({ sessionId, previews }) => (window as any).__setDynamicHistoricalPreviews(sessionId, previews), { sessionId, previews });
}

async function visiblePreviewTabPresentations(page: Page): Promise<Array<{ text: string; tooltip: string; dataTitle: string; id: string }>> {
	return page.locator(PANEL_TAB_SELECTOR).evaluateAll((buttons) => buttons
		.map((button) => {
			const el = button as HTMLElement;
			const style = window.getComputedStyle(el);
			const rect = el.getBoundingClientRect();
			if (style.visibility === "hidden" || style.display === "none" || rect.width <= 0 || rect.height <= 0) return null;
			if (button.getAttribute("data-panel-tab-kind") !== "preview") return null;
			const normalize = (value: string | null | undefined) => (value || "").replace(/\s+/g, " ").trim();
			return {
				text: normalize(button.textContent),
				tooltip: normalize(button.getAttribute("title")),
				dataTitle: normalize(button.getAttribute("data-panel-tab-title")),
				id: normalize(button.getAttribute("data-panel-tab-id")),
			};
		})
		.filter(Boolean) as Array<{ text: string; tooltip: string; dataTitle: string; id: string }>);
}

test.describe("Dynamic panel workspace lightweight fixture", () => {
	test.beforeEach(async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 800 });
		await loadFixture(page);
	});

	test("render derivation is restricted to file fixtures", async ({ page }) => {
		const result = await page.evaluate(() => ({
			file: (window as any).__shouldDerivePanelTabsInRender("file:"),
			http: (window as any).__shouldDerivePanelTabsInRender("http:"),
			https: (window as any).__shouldDerivePanelTabsInRender("https:"),
		}));
		expect(result).toEqual({ file: true, http: false, https: false });
	});

	test("preview mount updates and stale hydrate do not resurrect closed server tabs", async ({ page }) => {
		expect(await page.evaluate(() => (window as any).__exercisePreviewMountUpdateDoesNotCreateClosedTab())).toEqual({
			tabIds: [],
			legacyTabIds: [],
		});
	});

	test("same-revision server rollback force-replaces optimistic workspace", async ({ page }) => {
		const result = await page.evaluate(() => (window as any).__exerciseSameRevisionWorkspaceRollback());
		expect(result).toEqual({
			ignoredIds: ["proposal:goal", "review:optimistic"],
			hydrateIgnoredIds: ["proposal:goal", "review:optimistic"],
			forcedIds: ["proposal:goal"],
			storedIds: ["proposal:goal"],
			storedRevision: 7,
		});
	});

	test("multiple historical preview tabs reopen independently without hiding a goal proposal", async ({ page }) => {
		const { a } = await sessions(page);
		await setGoalProposal(page);
		await setHistoricalPreviews(page, a, [
			{ toolId: "multipreview-a", entry: "multipreview-a.html", bodyText: "Multipreview Preview A Content", contentHash: hashOf("a") },
			{ toolId: "multipreview-b", entry: "multipreview-b.html", bodyText: "Multipreview Preview B Content", contentHash: hashOf("b") },
		]);

		await waitForTopLevelTabCounts(
			page,
			[
				{ name: "Goal proposal", match: GOAL_TAB_RE, min: 1 },
				{ name: "HTML Preview", match: PREVIEW_TAB_RE, min: 2 },
			],
			"DYNAMIC_CHAT_TABS_MULTIPREVIEW_BUG",
		);

		await clickTopLevelTabById(page, "preview:entry:multipreview-a.html:v:1", "DYNAMIC_CHAT_TABS_MULTIPREVIEW_BUG");
		await expectPreviewEntry(page, "multipreview-a.html", hashOf("a"), "DYNAMIC_CHAT_TABS_MULTIPREVIEW_BUG: first preview");
		await clickTopLevelTabById(page, "preview:entry:multipreview-b.html:v:1", "DYNAMIC_CHAT_TABS_MULTIPREVIEW_BUG");
		await expectPreviewEntry(page, "multipreview-b.html", hashOf("b"), "DYNAMIC_CHAT_TABS_MULTIPREVIEW_BUG: second preview");
		await expectGoalProposalAccessible(page, "DYNAMIC_CHAT_TABS_MULTIPREVIEW_BUG");
		await clickTopLevelTabById(page, "preview:entry:multipreview-a.html:v:1", "DYNAMIC_CHAT_TABS_MULTIPREVIEW_BUG: reopen first");
		await expectPreviewEntry(page, "multipreview-a.html", hashOf("a"), "DYNAMIC_CHAT_TABS_MULTIPREVIEW_BUG: reopened first preview");
	});


	test("different-content historical v3 previews remain separately restorable across reload", async ({ page }) => {
		const { a } = await sessions(page);
		await setHistoricalPreviews(page, a, [
			{ toolId: "v3-different-a", entry: "inline.html", bodyText: "Content Hash Preview A Content", contentHash: hashOf("e") },
			{ toolId: "v3-different-b", entry: "inline.html", bodyText: "Content Hash Preview B Content", contentHash: hashOf("f") },
		]);
		await waitForTopLevelTabCounts(page, [{ name: "HTML Preview", match: PREVIEW_TAB_RE, min: 2 }], "DYNAMIC_CHAT_TABS_V3_DIFFERENT_HASH_BUG: previews mounted");

		await clickTopLevelTabById(page, "preview:entry:inline.html:v:1", "DYNAMIC_CHAT_TABS_V3_DIFFERENT_HASH_BUG: first open");
		await expectPreviewEntry(page, "inline.html", hashOf("e"), "DYNAMIC_CHAT_TABS_V3_DIFFERENT_HASH_BUG: preview A");
		await clickTopLevelTabById(page, "preview:entry:inline.html:v:2", "DYNAMIC_CHAT_TABS_V3_DIFFERENT_HASH_BUG: preview B");
		await expectPreviewEntry(page, "inline.html", hashOf("f"), "DYNAMIC_CHAT_TABS_V3_DIFFERENT_HASH_BUG: preview B");

		await reloadAndRehydrateFixture(page);
		await waitForTopLevelTabCounts(page, [{ name: "HTML Preview", match: PREVIEW_TAB_RE, min: 2 }], "DYNAMIC_CHAT_TABS_V3_DIFFERENT_HASH_BUG: after reload");
		await clickTopLevelTabById(page, "preview:entry:inline.html:v:1", "DYNAMIC_CHAT_TABS_V3_DIFFERENT_HASH_BUG: reloaded preview A");
		await expectPreviewEntry(page, "inline.html", hashOf("e"), "DYNAMIC_CHAT_TABS_V3_DIFFERENT_HASH_BUG: reloaded preview A");
		await clickTopLevelTabById(page, "preview:entry:inline.html:v:2", "DYNAMIC_CHAT_TABS_V3_DIFFERENT_HASH_BUG: reloaded preview B");
		await expectPreviewEntry(page, "inline.html", hashOf("f"), "DYNAMIC_CHAT_TABS_V3_DIFFERENT_HASH_BUG: reloaded preview B");
	});

	test("v3 preview tabs expose source labels, disambiguate same-name snapshots, and reopen independently", async ({ page }) => {
		const { a } = await sessions(page);
		await setLivePreview(page, "inline.html", hashOf("1"), "Live Inline Preview Content");
		await setHistoricalPreviews(page, a, [
			{ toolId: "v3-a", entry: "v3-a.html", bodyText: "V3 Preview A Content", contentHash: hashOf("2") },
			{ toolId: "v3-b", entry: "v3-b.html", bodyText: "V3 Preview B Content", contentHash: hashOf("3") },
			{ toolId: "inline-snapshot", entry: "inline.html", bodyText: "Historical Inline Preview Content", contentHash: hashOf("4") },
		]);

		await waitForTopLevelTabCounts(page, [{ name: "HTML Preview", match: PREVIEW_TAB_RE, min: 4 }], "DYNAMIC_CHAT_TABS_PREVIEW_LABEL_BUG");
		const presentations = await visiblePreviewTabPresentations(page);
		const labels = presentations.map((tab) => tab.text || tab.tooltip || tab.dataTitle);
		expect(labels).toEqual(expect.arrayContaining([
			"inline.html",
			"v3-a.html (v1)",
			"v3-b.html (v1)",
			"inline.html (v2)",
		]));
		expect(new Set(labels).size, `DYNAMIC_CHAT_TABS_PREVIEW_DUPLICATE_LABEL_BUG: duplicate preview labels: ${JSON.stringify(presentations)}`).toBe(labels.length);

		await selectTopLevelTabByTitle(page, /^v3-a\.html(?:\s*\(v\d+\))?$/i, "DYNAMIC_CHAT_TABS_V3_REOPEN_BUG");
		await expectPreviewEntry(page, "v3-a.html", hashOf("2"), "DYNAMIC_CHAT_TABS_V3_REOPEN_BUG: preview A");
		await selectTopLevelTabByTitle(page, /^v3-b\.html(?:\s*\(v\d+\))?$/i, "DYNAMIC_CHAT_TABS_V3_REOPEN_BUG");
		await expectPreviewEntry(page, "v3-b.html", hashOf("3"), "DYNAMIC_CHAT_TABS_V3_REOPEN_BUG: preview B");
	});

});
