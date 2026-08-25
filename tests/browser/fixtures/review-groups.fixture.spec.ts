import { expect, test, type Locator, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { buildBundle } from "./build-bundle.js";

const SHELL = path.resolve("tests/ui-fixtures/fixture-shell.html");
const FIXTURE_ORIGIN = "http://fixture.localhost";
const FIXTURE_URL = `${FIXTURE_ORIGIN}/fixture-shell.html`;
const ENTRY = path.resolve("tests/browser/fixtures/fixtures/review-groups-fixture-entry.ts");
const BUNDLE_DIR = path.resolve(".bobbit/tmp/ui-fixtures");
const BUNDLE = path.join(BUNDLE_DIR, "review-groups-fixture-bundle.js");
const REVIEW_PANE_SRC = path.resolve("src/ui/components/review/ReviewPane.ts");
const REVIEW_DOCUMENT_SRC = path.resolve("src/ui/components/review/ReviewDocument.ts");
const ANNOTATION_STORE_SRC = path.resolve("src/ui/components/review/AnnotationStore.ts");
const REVIEW_TABS = '.goal-tab-pill[data-panel-tab-kind="review"]';
const REGRESSION = "REVIEW_GROUP_PRIMARY_TAB";
const LONG_TITLE = "Overflow Review With A Very Long Primary Workspace Tab Title That Must Truncate";

test.beforeAll(() => {
	fs.mkdirSync(BUNDLE_DIR, { recursive: true });
	buildBundle({
		entry: ENTRY,
		outfile: BUNDLE,
		deps: [ENTRY, REVIEW_PANE_SRC, REVIEW_DOCUMENT_SRC, ANNOTATION_STORE_SRC],
	});
});

async function loadFixture(page: Page): Promise<void> {
	await page.route(`${FIXTURE_ORIGIN}/**`, async (route) => {
		await route.fulfill({ contentType: "text/html", body: fs.readFileSync(SHELL, "utf8") });
	});
	await page.goto(FIXTURE_URL);
	await page.addScriptTag({ path: BUNDLE });
	await page.waitForFunction(() => (window as any).__reviewGroupsFixtureReady === true, null, { timeout: 10_000 });
}

function primaryReviewTab(page: Page, title: string): Locator {
	return page.locator(REVIEW_TABS).filter({ hasText: title }).first();
}

async function fixtureState(page: Page): Promise<any> {
	return page.evaluate(() => (window as any).__getReviewGroupsFixtureState());
}

async function expectCloseInside(tab: Locator, label: string): Promise<void> {
	await tab.scrollIntoViewIfNeeded();
	const result = await tab.evaluate((element) => {
		const tabRect = element.getBoundingClientRect();
		const closeRect = element.querySelector<HTMLElement>(".goal-tab-close")?.getBoundingClientRect();
		return closeRect ? {
			left: closeRect.left >= tabRect.left - 0.5,
			right: closeRect.right <= tabRect.right + 0.5,
			top: closeRect.top >= tabRect.top - 0.5,
			bottom: closeRect.bottom <= tabRect.bottom + 0.5,
		} : null;
	});
	expect(result, `${REGRESSION}: ${label} is missing its close control`).not.toBeNull();
	expect(result, `${REGRESSION}: ${label} close geometry escaped the primary tab`).toEqual({ left: true, right: true, top: true, bottom: true });
}

test.describe("Review group browser fixture", () => {
	test.beforeEach(async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 800 });
		await loadFixture(page);
	});

	test("two primary reviews expose only review-local navigation-only secondary files and selectable top-layer overflow", async ({ page }) => {
		const primaries = page.locator(REVIEW_TABS);
		await expect(primaries, `${REGRESSION}: two groups must render exactly two primary workspace tabs`).toHaveCount(2);
		await expect(primaries.locator(".goal-tab-close"), `${REGRESSION}: each primary review must have one close control`).toHaveCount(2);
		for (const title of ["Overview.md", "Details.md", "Fixture 1.md", "Fixture 7.md"]) {
			await expect(primaries.filter({ hasText: title }), `${REGRESSION}: ${title} must not duplicate as a primary tab`).toHaveCount(0);
		}

		const alphaPane = page.locator("review-pane");
		const alphaBar = alphaPane.locator(".review-tab-bar");
		await expect(alphaBar.getByRole("tab", { name: "Overview.md", exact: true })).toBeVisible();
		await expect(alphaBar.getByRole("tab", { name: "Details.md", exact: true })).toBeVisible();
		await expect(alphaBar.locator('[class*="close"], [aria-label*="close" i], [title*="close" i]'), `${REGRESSION}: secondary files must have no close action`).toHaveCount(0);
		await alphaBar.getByRole("tab", { name: "Details.md", exact: true }).click();
		await expect(alphaPane.locator("review-document").getByText("Fixture alpha details body.").first()).toBeVisible();
		expect((await fixtureState(page)).activeFileIds["fixture-alpha"]).toBe("fixture-alpha-b");

		await primaryReviewTab(page, LONG_TITLE).click();
		const overflowPane = page.locator("review-pane");
		await expect(overflowPane.locator("review-document").getByText("Fixture overflow body 1.").first()).toBeVisible();
		await expect(overflowPane.locator(".review-tab-bar").getByRole("tab", { name: "Overview.md", exact: true }), `${REGRESSION}: switching primary reviews must replace the secondary file row`).toHaveCount(0);
		const more = overflowPane.locator('button[aria-haspopup="menu"], button[title="More tabs"], button[aria-label="More tabs"]').first();
		await expect(more, `${REGRESSION}: seven files must expose More tabs`).toBeVisible();
		await more.focus();
		await page.keyboard.press("Enter");
		const menu = page.locator('[role="menu"]').filter({ hasText: "Fixture 7.md" }).first();
		await expect(menu, `${REGRESSION}: More tabs must open a visible menu`).toBeVisible();
		expect(await menu.evaluate((element) => ({
			popover: element.hasAttribute("popover"),
			insideClippingStrip: !!element.closest(".review-tab-bar"),
		}))).toEqual({ popover: true, insideClippingStrip: false });
		await expect(menu.locator('[class*="close"], [aria-label*="close" i], [title*="close" i]'), `${REGRESSION}: overflow items must remain navigation only`).toHaveCount(0);
		await menu.getByRole("menuitem", { name: "Fixture 7.md", exact: true }).click();
		await expect(menu).toBeHidden();
		await expect(overflowPane.locator("review-document").getByText("Fixture overflow body 7.").first()).toBeVisible();
		expect((await fixtureState(page)).activeFileIds["fixture-overflow"]).toBe("fixture-overflow-7");
	});

	test("long-title close controls stay inside desktop and narrow primaries, and closing one review preserves its sibling", async ({ page }) => {
		const longTab = primaryReviewTab(page, LONG_TITLE);
		await expectCloseInside(longTab, "desktop long-title primary");
		await page.setViewportSize({ width: 360, height: 740 });
		await expectCloseInside(longTab, "360px long-title primary");

		const alpha = primaryReviewTab(page, "Alpha Review");
		await alpha.locator(".goal-tab-close").click();
		await expect(primaryReviewTab(page, "Alpha Review"), `${REGRESSION}: closing alpha must remove its whole primary review`).toHaveCount(0);
		await expect(primaryReviewTab(page, LONG_TITLE), `${REGRESSION}: closing alpha must leave overflow review open`).toBeVisible();
		expect((await fixtureState(page)).openReviewIds).toEqual(["fixture-overflow"]);
	});

	test("one review-level final comment survives secondary navigation and is emitted once", async ({ page }) => {
		const pane = page.locator("review-pane");
		const finalComment = pane.locator(".review-final-comment-input");
		await finalComment.fill("One whole-review decision note");
		await pane.locator(".review-tab-bar").getByRole("tab", { name: "Details.md", exact: true }).click();
		await expect(page.locator("review-pane .review-final-comment-input"), `${REGRESSION}: final draft belongs to the review, not the file`).toHaveValue("One whole-review decision note");
		await page.locator("review-pane .review-reject-btn").click();
		await expect.poll(async () => (await fixtureState(page)).decisions.length).toBe(1);
		const [decision] = (await fixtureState(page)).decisions;
		expect(decision.payload.finalComment).toBe("One whole-review decision note");
		expect(decision.payload.feedback.match(/One whole-review decision note/g), `${REGRESSION}: final comment must be aggregated once`).toHaveLength(1);
	});
});
