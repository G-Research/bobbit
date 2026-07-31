import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { buildBundle } from "../fixtures/build-bundle.js";
import {
	previewNavigationBridge,
	previewNavigationHandoffDocument,
} from "../../../src/shared/preview-bridge-scripts.js";

const SHELL = path.resolve("tests/ui-fixtures/fixture-shell.html");
const FIXTURE_ORIGIN = "http://fixture.localhost";
const FIXTURE_SHELL_URL = `${FIXTURE_ORIGIN}/fixture-shell.html`;
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
const PREVIEW_BRIDGE_SRC = path.resolve("src/shared/preview-bridge-scripts.ts");

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
			PREVIEW_BRIDGE_SRC,
		],
	});
});

async function loadFixture(page: Page): Promise<void> {
	await page.context().route(`${FIXTURE_ORIGIN}/**`, async (route) => {
		const pathname = new URL(route.request().url()).pathname;
		const svgPreview = pathname.endsWith("/hostile.svg");
		const previewScope = `/preview/${SESSION_A}/`;
		const capability = "a".repeat(43);
		const capabilityBase = `${previewScope}_content/${capability}/`;
		const capabilityNavigation = pathname.startsWith(capabilityBase);
		const canonicalPreview = [
			"/navigation.html",
			"/programmatic-navigation.html",
			"/meta-navigation.html",
			"/nested-navigation.html",
		].some(suffix => pathname.endsWith(suffix) && !capabilityNavigation);
		const navigationTarget = pathname.endsWith("/next.html") && !capabilityNavigation;
		const document = (body: string, head = "") => `<!doctype html><html><head><base data-bobbit-preview-base href="${capabilityBase}">${previewNavigationBridge()}${head}</head><body>${body}</body></html>`;
		const navigationBody = document(`<a id="next-page" href="next.html">Next page</a>`);
		const programmaticBody = document(`<button id="programmatic-page" onclick="location.assign('next.html')">Programmatic page</button><button id="cross-scope" onclick="parent.postMessage({type:'bobbit-preview-navigate',url:'${FIXTURE_ORIGIN}/preview/other-session/owned.html'},'*')">Cross scope</button>`);
		const metaBody = document("Waiting for meta navigation", `<meta http-equiv="refresh" content="0;url=next.html">`);
		const nestedBody = document(`<iframe id="nested-page" src="next.html"></iframe>`);
		await route.fulfill({
			contentType: svgPreview ? "image/svg+xml" : "text/html",
			headers: svgPreview || canonicalPreview || navigationTarget || capabilityNavigation ? {
				"Content-Security-Policy": "sandbox allow-scripts",
				"Referrer-Policy": "no-referrer",
			} : undefined,
			body: pathname === "/fixture-shell.html"
				? fs.readFileSync(SHELL, "utf8")
				: svgPreview
					? `<svg xmlns="http://www.w3.org/2000/svg"><script>window.__svgScriptRan=true</script><text>Isolated SVG preview</text></svg>`
					: capabilityNavigation
						? previewNavigationHandoffDocument(capabilityBase)
						: pathname.endsWith("/navigation.html")
							? navigationBody
							: pathname.endsWith("/programmatic-navigation.html")
								? programmaticBody
								: pathname.endsWith("/meta-navigation.html")
									? metaBody
									: pathname.endsWith("/nested-navigation.html")
										? nestedBody
										: navigationTarget
											? "<!doctype html><html><body><h1>Navigated preview page</h1></body></html>"
											: "<!doctype html><html><body>Fixture preview</body></html>",
		});
	});
	await page.goto(FIXTURE_SHELL_URL);
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

type VisibleSidePanelSizeMode = "collapsed" | "split" | "fullscreen" | "unknown";

async function visibleSidePanelSizeMode(page: Page): Promise<VisibleSidePanelSizeMode> {
	return page.evaluate(() => {
		const visible = (selector: string): boolean => {
			const element = document.querySelector(selector) as HTMLElement | null;
			if (!element) return false;
			const style = window.getComputedStyle(element);
			const rect = element.getBoundingClientRect();
			return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
		};
		// Fullscreen no longer renders a composer prompt strip; the workspace fills
		// to the bottom edge and carries data-side-panel-mode="fullscreen".
		const panelMode = (document.querySelector('[data-panel-workspace="content"]') as HTMLElement | null)?.getAttribute("data-side-panel-mode");
		if (panelMode === "fullscreen" && visible('[data-panel-workspace="content"]')) return "fullscreen";
		if (visible('[data-testid="side-panel-fullscreen"]')) return "split";
		if (visible('[data-testid="side-panel-restore"]') && !visible('[data-testid="side-panel-collapse"]')) return "collapsed";
		return "unknown";
	}) as Promise<VisibleSidePanelSizeMode>;
}

async function expectVisibleSidePanelSizeMode(page: Page, expected: VisibleSidePanelSizeMode, message: string): Promise<void> {
	await expect.poll(async () => visibleSidePanelSizeMode(page), {
		timeout: 5_000,
		message: `${message}: expected visible side-panel sizeMode ${expected}; fullscreen collapse must go to split, not collapsed`,
	}).toBe(expected);
}

async function sidePanelControlTitles(page: Page): Promise<string[]> {
	return page.evaluate(() => {
		const controls = document.querySelector('[data-panel-workspace="content"] > div:first-child > div:last-child');
		return [...(controls?.querySelectorAll('a,button') || [])]
			.map((el) => (el.getAttribute("title") || "").replace(/\s+\([^)]*\)$/, ""))
			.filter(Boolean);
	});
}

async function expectSidePanelControlTitles(page: Page, expected: string[], message: string): Promise<void> {
	await expect.poll(async () => sidePanelControlTitles(page), {
		timeout: 5_000,
		message,
	}).toEqual(expected);
}

test.describe("Preview panel fixture", () => {
	test.beforeEach(async ({ page }) => {
		await loadFixture(page);
	});

	test("renders preview iframe controls in split and fullscreen, and refresh updates cache buster", async ({ page }) => {
		await setLivePreview(page, "report.html", hashOf("a"), "Preview panel display");

		const iframe = page.locator(".goal-preview-panel iframe").first();
		await expect(iframe).toBeVisible({ timeout: 5_000 });
		await expect(iframe).toHaveAttribute("sandbox", "allow-scripts");
		await expect(iframe).toHaveAttribute("referrerpolicy", "no-referrer");
		expect(await iframe.getAttribute("sandbox"), "agent-authored previews must retain an opaque origin").not.toContain("allow-same-origin");
		await expect(iframe).toHaveAttribute("src", new RegExp(`^${FIXTURE_ORIGIN}/preview/${SESSION_A}/report\\.html\\?mtime=\\d+$`));
		const initialSrc = await iframe.getAttribute("src");
		expect(initialSrc).not.toContain("/api/preview/render");

		const openLinks = page.locator('a[title="Open preview in new tab"]');
		await expect(openLinks).toHaveCount(1);
		const openLink = openLinks.first();
		await expect(openLink).toBeVisible({ timeout: 5_000 });
		await expect(openLink).toHaveAttribute("href", `${FIXTURE_ORIGIN}/preview/${SESSION_A}/report.html`);
		await expect(openLink).toHaveAttribute("target", "_blank");
		await expect(openLink).toHaveAttribute("rel", /noopener.*noreferrer|noreferrer.*noopener/);
		expect(await openLink.getAttribute("href")).not.toMatch(/[?#]mtime=/);
		await expect(page.getByTestId("side-panel-popout"), "preview tab should not render the generic side-panel popout").toHaveCount(0);

		await expectSidePanelControlTitles(page, [
			"Refresh preview",
			"Open preview in new tab",
			"Expand preview to fullscreen",
			"Collapse side panel",
		], "preview split controls should appear in stable action order");

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
		await expect(page.getByTestId("side-panel-collapse")).toHaveCount(1);
		await expect(page.getByTestId("side-panel-restore"), "fullscreen chrome should not show a duplicate restore/collapse button").toHaveCount(0);
		await expect(openLink, "Open-in-new-tab remains available in fullscreen chrome").toBeVisible({ timeout: 5_000 });
		await expect(refresh, "Refresh remains available in fullscreen chrome").toBeVisible({ timeout: 5_000 });
		await expectSidePanelControlTitles(page, [
			"Refresh preview",
			"Open preview in new tab",
			"Collapse to split view",
		], "preview fullscreen controls should appear in stable action order");

		await refresh.click();
		await expect.poll(async () => iframe.getAttribute("src"), {
			timeout: 5_000,
			message: "fullscreen Refresh should update the iframe cache-buster",
		}).not.toEqual(refreshedSrc);
	});

	test("navigates relative preview pages through the validated iframe and popout ambient-auth handoff", async ({ page }) => {
		await setLivePreview(page, "navigation.html", hashOf("a"), "Navigation preview");
		const iframe = page.locator(".goal-preview-panel iframe").first();
		await expect(iframe).toHaveAttribute("sandbox", "allow-scripts");
		const frame = page.frameLocator(".goal-preview-panel iframe").first();
		await expect(frame.locator("#next-page")).toBeVisible({ timeout: 5_000 });
		await frame.locator("#next-page").click();
		await expect(iframe).toHaveAttribute("src", `${FIXTURE_ORIGIN}/preview/${SESSION_A}/next.html`);
		await expect(frame.getByRole("heading", { name: "Navigated preview page" })).toBeVisible({ timeout: 5_000 });
		expect(await frame.locator("body").evaluate(() => {
			try { localStorage.getItem("shared-origin-secret"); return false; }
			catch { return true; }
		}), "navigated iframe document must retain its opaque origin").toBe(true);

		await setLivePreview(page, "navigation.html", hashOf("b"), "Navigation popout");
		const popupPromise = page.waitForEvent("popup");
		await page.locator('a[title="Open preview in new tab"]').first().click();
		const popup = await popupPromise;
		try {
			await expect(popup.locator("#next-page")).toBeVisible({ timeout: 5_000 });
			await popup.locator("#next-page").click();
			await expect(popup).toHaveURL(`${FIXTURE_ORIGIN}/preview/${SESSION_A}/next.html`);
			await expect(popup.getByRole("heading", { name: "Navigated preview page" })).toBeVisible();
			expect(await popup.evaluate(() => {
				try { localStorage.getItem("shared-origin-secret"); return false; }
				catch { return true; }
			}), "navigated popout document must retain its response-sandboxed opaque origin").toBe(true);
			await expect.poll(() => popup.evaluate(() => window.opener === null)).toBe(true);
		} finally {
			await popup.close();
		}
	});

	test("bridges programmatic, meta-refresh, and nested-frame navigation without serving preview bytes from capabilities", async ({ page }) => {
		const iframe = page.locator(".goal-preview-panel iframe").first();
		const frame = page.frameLocator(".goal-preview-panel iframe").first();

		await setLivePreview(page, "programmatic-navigation.html", hashOf("c"), "Programmatic navigation");
		await expect(frame.locator("#programmatic-page")).toBeVisible({ timeout: 5_000 });
		const programmaticSrc = await iframe.getAttribute("src");
		await frame.locator("#cross-scope").click();
		await page.waitForTimeout(100);
		expect(await iframe.getAttribute("src"), "cross-session authored messages must be denied").toBe(programmaticSrc);
		const programmaticHandoff = page.waitForResponse(response => new URL(response.url()).pathname.includes("/_content/") && new URL(response.url()).pathname.endsWith("/next.html"));
		await frame.locator("#programmatic-page").click();
		expect((await programmaticHandoff).status()).toBe(200);
		await expect(iframe).toHaveAttribute("src", `${FIXTURE_ORIGIN}/preview/${SESSION_A}/next.html`);
		await expect(frame.getByRole("heading", { name: "Navigated preview page" })).toBeVisible({ timeout: 5_000 });

		await page.evaluate(() => (window as any).__resetDynamicPanelWorkspaceFixture());
		const metaDocument = page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/meta-navigation.html"));
		await setLivePreview(page, "meta-navigation.html", hashOf("d"), "Meta navigation");
		expect((await metaDocument).status()).toBe(200);
		await expect(iframe).toHaveAttribute("src", `${FIXTURE_ORIGIN}/preview/${SESSION_A}/next.html`, { timeout: 5_000 });
		await expect(frame.getByRole("heading", { name: "Navigated preview page" })).toBeVisible({ timeout: 5_000 });

		await page.evaluate(() => (window as any).__resetDynamicPanelWorkspaceFixture());
		const nestedHandoff = page.waitForResponse(response => new URL(response.url()).pathname.includes("/_content/") && new URL(response.url()).pathname.endsWith("/next.html"));
		await setLivePreview(page, "nested-navigation.html", hashOf("e"), "Nested navigation");
		expect((await nestedHandoff).status()).toBe(200);
		await expect(iframe).toHaveAttribute("src", `${FIXTURE_ORIGIN}/preview/${SESSION_A}/next.html`, { timeout: 5_000 });
		await expect(frame.getByRole("heading", { name: "Navigated preview page" })).toBeVisible({ timeout: 5_000 });

		await page.evaluate(() => (window as any).__resetDynamicPanelWorkspaceFixture());
		await setLivePreview(page, "programmatic-navigation.html", hashOf("f"), "Programmatic popout");
		const popupPromise = page.waitForEvent("popup");
		await page.locator('a[title="Open preview in new tab"]').first().click();
		const popup = await popupPromise;
		try {
			await expect(popup.locator("#programmatic-page")).toBeVisible({ timeout: 5_000 });
			const popupHandoff = popup.waitForResponse(response => new URL(response.url()).pathname.includes("/_content/") && new URL(response.url()).pathname.endsWith("/next.html"));
			await popup.locator("#programmatic-page").click();
			expect((await popupHandoff).status()).toBe(200);
			await expect(popup).toHaveURL(`${FIXTURE_ORIGIN}/preview/${SESSION_A}/next.html`);
			await expect(popup.getByRole("heading", { name: "Navigated preview page" })).toBeVisible({ timeout: 5_000 });
		} finally {
			await popup.close();
		}
	});

	test("keeps script-capable SVG popouts in an opaque response sandbox", async ({ page }) => {
		const iframeResponsePromise = page.waitForResponse(response => {
			const url = new URL(response.url());
			return url.pathname === `/preview/${SESSION_A}/hostile.svg`
				&& response.request().resourceType() === "document";
		});
		await setLivePreview(page, "hostile.svg", hashOf("f"), "Isolated SVG preview");
		const iframe = page.locator(".goal-preview-panel iframe").first();
		await expect(iframe).toBeVisible({ timeout: 5_000 });
		await expect(iframe).toHaveAttribute("sandbox", "allow-scripts");
		const iframeResponse = await iframeResponsePromise;
		expect(await iframeResponse.headerValue("content-security-policy")).toBe("sandbox allow-scripts");
		expect(await iframeResponse.headerValue("referrer-policy")).toBe("no-referrer");

		const popupPromise = page.waitForEvent("popup");
		await page.locator('a[title="Open preview in new tab"]').first().click();
		const popup = await popupPromise;
		try {
			await popup.waitForLoadState("domcontentloaded");
			expect(await popup.evaluate(() => {
				try { localStorage.getItem("shared-origin-secret"); return false; }
				catch { return true; }
			}), "response CSP must keep a top-level SVG popout out of shared-origin storage").toBe(true);
		} finally {
			await popup.close();
		}
	});

	test("uses the same action order for preview and non-preview panel tabs", async ({ page }) => {
		await setLivePreview(page, "order.html", hashOf("e"), "preview order");
		await expectSidePanelControlTitles(page, [
			"Refresh preview",
			"Open preview in new tab",
			"Expand preview to fullscreen",
			"Collapse side panel",
		], "preview controls should appear in stable action order");

		await page.evaluate(() => (window as any).__openDynamicReviewDoc({ title: "Review panel", markdown: "# Review panel" }));
		await expect(page.getByTestId("side-panel-popout")).toBeVisible({ timeout: 5_000 });
		await expectSidePanelControlTitles(page, [
			"Open side panel in new tab",
			"Expand side panel to fullscreen",
			"Collapse side panel",
		], "non-preview controls should appear in stable action order");
	});

	test("visible side-panel controls move one size level at a time", async ({ page }) => {
		await setLivePreview(page, "levels.html", hashOf("d"), "level controls");

		await expectVisibleSidePanelSizeMode(page, "split", "live preview should start in split mode");

		await page.getByTestId("side-panel-collapse").click();
		await expectVisibleSidePanelSizeMode(page, "collapsed", "split collapse should move one level to collapsed");
		await expect(page.getByTestId("side-panel-restore")).toBeVisible({ timeout: 5_000 });

		await page.getByTestId("side-panel-restore").click();
		await expectVisibleSidePanelSizeMode(page, "split", "collapsed restore should move one level to split");

		await page.getByTestId("side-panel-fullscreen").click();
		await expectVisibleSidePanelSizeMode(page, "fullscreen", "split fullscreen expand should move one level to fullscreen");

		await page.getByTestId("side-panel-collapse").click();
		await expectVisibleSidePanelSizeMode(page, "split", "fullscreen collapse should move one level to split, not collapsed");
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
		await expect(page.locator(".goal-preview-panel iframe").first()).toHaveAttribute("src", new RegExp(`^${FIXTURE_ORIGIN}/preview/${SESSION_A}/next\\.html\\?mtime=\\d+$`));
	});
});
