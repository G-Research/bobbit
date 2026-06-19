import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { buildBundle } from "../fixtures/build-bundle.js";

const SHELL = path.resolve("tests/ui-fixtures/fixture-shell.html");
const ENTRY = path.resolve("tests/ui-fixtures/preview-panel-entry.ts");
const DYNAMIC_WORKSPACE_ENTRY = path.resolve("tests/ui-fixtures/dynamic-panel-workspace-fixture-entry.ts");
const BUNDLE_DIR = path.resolve(".bobbit/tmp/ui-fixtures");
const BUNDLE = path.join(BUNDLE_DIR, "preview-panel-workspace-bundle.js");

const APP_RENDER_SRC = path.resolve("src/app/render.ts");
const APP_STATE_SRC = path.resolve("src/app/state.ts");
const SIDE_PANEL_WORKSPACE_SRC = path.resolve("src/app/side-panel-workspace.ts");
const PANEL_WORKSPACE_SRC = path.resolve("src/app/panel-workspace.ts");
const PREVIEW_PANEL_SRC = path.resolve("src/app/preview-panel.ts");
const PREVIEW_RENDERER_SRC = path.resolve("src/ui/tools/renderers/PreviewRenderer.ts");

const SESSION_A = "dynamic-workspace-session-a";
const PREVIEW_TAB = '.goal-tab-pill[data-panel-tab-kind="preview"]';

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
			DYNAMIC_WORKSPACE_ENTRY,
			APP_RENDER_SRC,
			APP_STATE_SRC,
			SIDE_PANEL_WORKSPACE_SRC,
			PANEL_WORKSPACE_SRC,
			PREVIEW_PANEL_SRC,
			PREVIEW_RENDERER_SRC,
		],
	});
});

async function loadFixture(page: Page): Promise<void> {
	await page.goto(`file://${SHELL.replace(/\\/g, "/")}`);
	await page.addScriptTag({ path: BUNDLE });
	await page.waitForFunction(() => (window as any).__dynamicPanelWorkspaceReady === true, null, { timeout: 10_000 });
	await page.evaluate(() => (window as any).__resetDynamicPanelWorkspaceFixture());
	await expect(page.locator("[data-testid='fixture-chat'] textarea")).toBeVisible({ timeout: 10_000 });
}

async function setLivePreview(page: Page, entry: string, contentHash: string, bodyText = entry): Promise<void> {
	await page.evaluate(
		({ entry, contentHash, bodyText }) => (window as any).__setDynamicLivePreview({ entry, contentHash, bodyText }),
		{ entry, contentHash, bodyText },
	);
}

async function simulatePreviewChanged(page: Page, entry: string, contentHash: string): Promise<void> {
	await page.evaluate(
		({ entry, contentHash }) => (window as any).__previewPanelSimulatePreviewChanged(entry, contentHash),
		{ entry, contentHash },
	);
}

async function previewState(page: Page): Promise<any> {
	return page.evaluate(() => (window as any).__getDynamicPanelWorkspaceState());
}

test.describe("Preview panel fixture", () => {
	test.beforeEach(async ({ page }) => {
		await loadFixture(page);
	});

	test("renders preview iframe controls in split and fullscreen, and refresh updates cache buster", async ({ page }) => {
		await setLivePreview(page, "report.html", hashOf("a"), "Preview panel display");

		const iframe = page.locator(".goal-preview-panel iframe").first();
		await expect(iframe).toBeVisible({ timeout: 5_000 });
		await expect(iframe).toHaveAttribute("src", new RegExp(`^/preview/${SESSION_A}/report\\.html\\?mtime=\\d+$`));
		const initialSrc = await iframe.getAttribute("src");
		expect(initialSrc).not.toContain("/api/preview/render");

		const openLinks = page.locator('a[title="Open preview in new tab"]');
		await expect(openLinks).toHaveCount(1);
		const openLink = openLinks.first();
		await expect(openLink).toBeVisible({ timeout: 5_000 });
		await expect(openLink).toHaveAttribute("href", `/preview/${SESSION_A}/report.html`);
		await expect(openLink).toHaveAttribute("target", "_blank");
		await expect(openLink).toHaveAttribute("rel", /noopener.*noreferrer|noreferrer.*noopener/);
		expect(await openLink.getAttribute("href")).not.toMatch(/[?#]mtime=/);
		await expect(page.getByTestId("side-panel-popout"), "preview tab should not render the generic side-panel popout").toHaveCount(0);

		const refresh = page.locator('button[title="Refresh preview"]').first();
		await expect(refresh).toBeVisible();
		await refresh.click();
		await expect.poll(async () => iframe.getAttribute("src"), {
			timeout: 5_000,
			message: "split-panel Refresh should update the iframe cache-buster",
		}).not.toEqual(initialSrc);
		const refreshedSrc = await iframe.getAttribute("src");

		await page.getByTestId("side-panel-fullscreen").first().click();
		await expect.poll(async () => (await previewState(page)).activePanelTabId, { timeout: 5_000 }).toContain("preview");
		await expect(page.getByTestId("side-panel-restore").first()).toBeVisible({ timeout: 5_000 });
		await expect(openLink, "Open-in-new-tab remains available in fullscreen chrome").toBeVisible({ timeout: 5_000 });
		await expect(refresh, "Refresh remains available in fullscreen chrome").toBeVisible({ timeout: 5_000 });

		await refresh.click();
		await expect.poll(async () => iframe.getAttribute("src"), {
			timeout: 5_000,
			message: "fullscreen Refresh should update the iframe cache-buster",
		}).not.toEqual(refreshedSrc);
	});

	test("dismissed live preview stays closed until new preview content reopens it", async ({ page }) => {
		await setLivePreview(page, "inline.html", hashOf("b"), "dismiss me");
		const previewTab = page.locator(PREVIEW_TAB).first();
		await expect(previewTab).toBeVisible({ timeout: 5_000 });
		await previewTab.locator(".goal-tab-close").click();
		await expect(page.locator(PREVIEW_TAB), "preview tab should close immediately").toHaveCount(0, { timeout: 5_000 });

		await expect(page.locator(PREVIEW_TAB), "closed tab should remain absent before the next preview event").toHaveCount(0, { timeout: 1_000 });

		await simulatePreviewChanged(page, "next.html", hashOf("c"));
		await expect(page.locator(PREVIEW_TAB), "new preview entry should reopen the tab").toHaveCount(1, { timeout: 5_000 });
		await expect(page.locator(".goal-preview-panel iframe").first()).toHaveAttribute("src", new RegExp(`^/preview/${SESSION_A}/next\\.html\\?mtime=\\d+$`));
	});
});
