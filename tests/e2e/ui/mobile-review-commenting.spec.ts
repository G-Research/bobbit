/**
 * Mobile review commenting E2E — full mobile annotation flow with persistence.
 */
import { test, expect } from "../gateway-harness.js";
import { openApp, sendMessage, waitForAgentResponse, navigateToHash } from "./ui-helpers.js";
import { createSession } from "../e2e-setup.js";

async function setupMobileEmulation(page: import("@playwright/test").Page) {
	await page.addInitScript(() => {
		const orig = window.matchMedia;
		window.matchMedia = function (q: string) {
			if (q === "(pointer: coarse)") {
				return {
					matches: true,
					media: q,
					addEventListener: () => {},
					removeEventListener: () => {},
					addListener: () => {},
					removeListener: () => {},
					onchange: null,
					dispatchEvent: () => true,
				} as unknown as MediaQueryList;
			}
			return orig.call(window, q);
		};
	});
}

async function openReviewTab(page: import("@playwright/test").Page) {
	await sendMessage(page, "REVIEW_OPEN");
	await waitForAgentResponse(page, { text: "Done. Used review_open tool." });

	const reviewTab = page.locator(".goal-tab-pill", { hasText: "Review" });
	await expect(reviewTab).toBeVisible({ timeout: 10_000 });
	await reviewTab.click();
	await expect(page.locator("review-document")).toBeVisible({ timeout: 5_000 });
	await expect(page.locator("review-document").getByText("Some important text").first()).toBeVisible({ timeout: 5_000 });
}

async function createSessionViaAPI(page: import("@playwright/test").Page) {
	const sessionId = await createSession();
	await navigateToHash(page, `#/session/${sessionId}`);
	await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });
}

async function selectReviewText(page: import("@playwright/test").Page) {
	await page.evaluate(() => {
		const content = document.querySelector(".review-document-content")!;
		const paragraphs = content.querySelectorAll("p");
		let targetP: Element | null = null;
		for (const p of paragraphs) {
			if (p.textContent?.includes("Some important text")) {
				targetP = p;
				break;
			}
		}
		if (!targetP) targetP = paragraphs[0];

		const range = document.createRange();
		range.selectNodeContents(targetP);
		const selection = window.getSelection()!;
		selection.removeAllRanges();
		selection.addRange(range);
		document.dispatchEvent(new Event("selectionchange"));
	});
}

test.describe("Mobile review commenting", () => {
	test("mobile annotation creation flow uses bottom sheet and persists after reload", async ({ page }) => {
		test.setTimeout(60_000);
		await setupMobileEmulation(page);
		await page.setViewportSize({ width: 375, height: 667 });
		await openApp(page);
		await createSessionViaAPI(page);
		await openReviewTab(page);

		await selectReviewText(page);
		const floatingBtn = page.locator(".review-floating-btn");
		await expect(floatingBtn).toBeVisible({ timeout: 5_000 });
		await floatingBtn.click();

		const popover = page.locator("annotation-popover");
		await expect(popover).toHaveAttribute("mode", "bottom-sheet", { timeout: 3_000 });
		await expect(popover).toHaveAttribute("open", "", { timeout: 3_000 });
		expect(await page.evaluate(() => {
			const ap = document.querySelector("annotation-popover");
			return !!ap?.shadowRoot?.querySelector(".review-popover--sheet");
		})).toBe(true);

		await page.locator("annotation-popover textarea").fill("Persisted mobile comment");
		await page.locator("annotation-popover .review-popover-submit").click();
		await expect(floatingBtn).not.toBeVisible({ timeout: 3_000 });
		await expect(page.locator(".review-tab-badge")).toHaveText("1", { timeout: 5_000 });

		await page.reload();
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });
		await openReviewTab(page);
		await expect(page.locator(".review-tab-badge")).toHaveText("1", { timeout: 5_000 });
	});
});
