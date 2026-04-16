/**
 * Mobile review commenting E2E tests — verifies the full mobile annotation
 * flow through the real server with a mock agent.
 *
 * Trimmed to essential coverage: one creation flow + one persistence test.
 */
import { test, expect } from "../gateway-harness.js";
import { openApp, sendMessage, waitForAgentResponse, navigateToHash } from "./ui-helpers.js";
import { createSession } from "../e2e-setup.js";

/** Add matchMedia mock for pointer:coarse before the page loads */
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

/** Navigate to the review tab after opening a review document */
async function openReviewTab(page: import("@playwright/test").Page) {
	await sendMessage(page, "REVIEW_OPEN");
	await waitForAgentResponse(page, { text: "Done. Used review_open tool." });

	const reviewTab = page.locator(".goal-tab-pill", { hasText: "Review" });
	await expect(reviewTab).toBeVisible({ timeout: 10_000 });
	await reviewTab.click();

	// Wait for review document to render
	await expect(page.locator("review-document")).toBeVisible({ timeout: 5_000 });
	await expect(
		page.locator("review-document").getByText("Some important text").first(),
	).toBeVisible({ timeout: 5_000 });
}

/**
 * Create a session via API and navigate to it — works at any viewport width.
 * Unlike createSessionViaUI, this doesn't need the sidebar "New session" button
 * which is hidden on mobile viewports (< 768px).
 */
async function createSessionViaAPI(page: import("@playwright/test").Page) {
	const sessionId = await createSession();
	await navigateToHash(page, `#/session/${sessionId}`);
	await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });
}

/** Programmatically select text inside the review document content */
async function selectReviewText(page: import("@playwright/test").Page) {
	await page.evaluate(() => {
		// Find a text node inside .review-document-content to select
		const content = document.querySelector(".review-document-content")!;
		const paragraphs = content.querySelectorAll("p");
		// Select the paragraph with "Some important text"
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

		// Fire selectionchange to trigger the component's debounce
		document.dispatchEvent(new Event("selectionchange"));
	});
}

test.describe("Mobile review commenting", () => {
	test("mobile annotation creation flow", async ({ page }) => {
		await setupMobileEmulation(page);
		await page.setViewportSize({ width: 375, height: 667 });
		await openApp(page);
		await createSessionViaAPI(page);
		await openReviewTab(page);

		// Select text in the review document
		await selectReviewText(page);

		// Wait for debounce (300ms) + buffer
		await page.waitForTimeout(500);

		// Floating "Add Comment" button should appear
		const floatingBtn = page.locator(".review-floating-btn");
		await expect(floatingBtn).toBeVisible({ timeout: 3_000 });

		// Click the floating button
		await floatingBtn.click();

		// Bottom sheet should open (annotation-popover with mode=bottom-sheet)
		const popover = page.locator("annotation-popover");
		await expect(popover).toHaveAttribute("mode", "bottom-sheet", { timeout: 3_000 });
		await expect(popover).toHaveAttribute("open", "", { timeout: 3_000 });

		// The bottom sheet inner div should be visible
		// AnnotationPopover uses Shadow DOM, so use evaluate to check
		const sheetVisible = await page.evaluate(() => {
			const ap = document.querySelector("annotation-popover");
			if (!ap || !ap.shadowRoot) return false;
			const sheet = ap.shadowRoot.querySelector(".review-popover--sheet");
			return sheet !== null;
		});
		expect(sheetVisible).toBe(true);

		// Type a comment in the textarea inside the shadow root
		await page.evaluate(() => {
			const ap = document.querySelector("annotation-popover")!;
			const textarea = ap.shadowRoot!.querySelector("textarea") as HTMLTextAreaElement;
			textarea.value = "Mobile test annotation";
			textarea.dispatchEvent(new Event("input", { bubbles: true }));
		});

		// Click Submit inside shadow root
		await page.evaluate(() => {
			const ap = document.querySelector("annotation-popover")!;
			const submitBtn = ap.shadowRoot!.querySelector(".review-popover-submit") as HTMLButtonElement;
			submitBtn.click();
		});

		// Floating button should be hidden after submission
		await expect(floatingBtn).not.toBeVisible({ timeout: 3_000 });

		// Annotation badge count should show 1
		const badge = page.locator(".review-tab-badge");
		await expect(badge).toHaveText("1", { timeout: 5_000 });
	});

	test("annotations persist after page reload", async ({ page }) => {
		test.setTimeout(60_000);
		await setupMobileEmulation(page);
		await page.setViewportSize({ width: 375, height: 667 });
		await openApp(page);
		await createSessionViaAPI(page);
		await openReviewTab(page);

		// Create annotation via mobile flow
		await selectReviewText(page);
		await page.waitForTimeout(500);

		const floatingBtn = page.locator(".review-floating-btn");
		await expect(floatingBtn).toBeVisible({ timeout: 3_000 });
		await floatingBtn.click();

		// Use Playwright's shadow-piercing locators instead of manual shadowRoot access
		await page.locator("annotation-popover textarea").fill("Persisted comment");
		await page.locator("annotation-popover .review-popover-submit").click();

		// Verify badge shows 1 before reload
		await expect(page.locator(".review-tab-badge")).toHaveText("1", { timeout: 5_000 });

		// Reload — sessionStorage persists in the same tab, URL hash preserved
		await page.reload();

		// Wait for app to fully reload — URL hash is preserved so session auto-reconnects.
		// At mobile viewport there's no sidebar Settings button; wait for the chat textarea instead.
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });

		// Re-send REVIEW_OPEN (client review state is gone after reload)
		await openReviewTab(page);

		// Badge should still show 1 (annotations restored from sessionStorage)
		await expect(page.locator(".review-tab-badge")).toHaveText("1", { timeout: 5_000 });
	});
});
