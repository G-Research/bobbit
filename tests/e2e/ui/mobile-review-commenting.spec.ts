/**
 * Mobile review commenting E2E tests — verifies the full mobile annotation
 * flow through the real server with a mock agent.
 *
 * Tests: mobile selection → floating button → bottom sheet → submit,
 * desktop flow unaffected, and submit review on mobile.
 */
import { test, expect } from "../gateway-harness.js";
import { openApp, createSessionViaUI, sendMessage, waitForAgentResponse } from "./ui-helpers.js";

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
		await createSessionViaUI(page);
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

	test("desktop flow shows no floating button on text selection", async ({ page }) => {
		// No mobile emulation — default desktop
		await openApp(page);
		await createSessionViaUI(page);
		await openReviewTab(page);

		// Select text
		await selectReviewText(page);
		await page.waitForTimeout(500);

		// Floating button should NOT appear on desktop
		const floatingBtn = page.locator(".review-floating-btn");
		await expect(floatingBtn).toHaveCount(0, { timeout: 2_000 });
	});

	test("submit review on mobile includes annotations", async ({ page }) => {
		await setupMobileEmulation(page);
		await page.setViewportSize({ width: 375, height: 667 });
		await openApp(page);
		await createSessionViaUI(page);
		await openReviewTab(page);

		// Create an annotation via the mobile flow
		await selectReviewText(page);
		await page.waitForTimeout(500);

		const floatingBtn = page.locator(".review-floating-btn");
		await expect(floatingBtn).toBeVisible({ timeout: 3_000 });
		await floatingBtn.click();

		// Type and submit a comment
		await page.evaluate(() => {
			const ap = document.querySelector("annotation-popover")!;
			const textarea = ap.shadowRoot!.querySelector("textarea") as HTMLTextAreaElement;
			textarea.value = "Review comment for submission";
			textarea.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await page.evaluate(() => {
			const ap = document.querySelector("annotation-popover")!;
			ap.shadowRoot!.querySelector<HTMLButtonElement>(".review-popover-submit")!.click();
		});

		// Wait for badge to update
		await expect(page.locator(".review-tab-badge")).toHaveText("1", { timeout: 5_000 });

		// Click "Submit Review"
		const submitBtn = page.locator("button", { hasText: "Submit Review" });
		await expect(submitBtn).toBeEnabled({ timeout: 5_000 });
		await submitBtn.click();

		// After submit, review tab should disappear or badge reset
		// The review feedback is sent as a message — check for the review feedback text in chat
		// Switch back to chat view
		const chatTab = page.locator(".goal-tab-pill", { hasText: "Chat" });
		if (await chatTab.isVisible()) {
			await chatTab.click();
		}

		// The review feedback message should contain the comment text
		await expect(
			page.getByText("Review comment for submission").first(),
		).toBeVisible({ timeout: 10_000 });
	});

	test("toast appears when selection is lost on mobile", async ({ page }) => {
		await setupMobileEmulation(page);
		await page.setViewportSize({ width: 375, height: 667 });
		await openApp(page);
		await createSessionViaUI(page);
		await openReviewTab(page);

		// Select text
		await selectReviewText(page);
		await page.waitForTimeout(500);

		const floatingBtn = page.locator(".review-floating-btn");
		await expect(floatingBtn).toBeVisible({ timeout: 3_000 });

		// Clear the selection before tapping Add Comment
		await page.evaluate(() => {
			window.getSelection()!.removeAllRanges();
		});

		// Click the floating button (selection is now gone)
		await floatingBtn.click({ force: true });

		// Toast should appear with "Selection lost" message
		const toast = page.locator(".review-toast");
		await expect(toast).toBeVisible({ timeout: 3_000 });
		const toastText = await toast.textContent();
		expect(toastText).toContain("Selection lost");
	});

	test("cancel bottom sheet removes uncommitted annotation on mobile", async ({ page }) => {
		await setupMobileEmulation(page);
		await page.setViewportSize({ width: 375, height: 667 });
		await openApp(page);
		await createSessionViaUI(page);
		await openReviewTab(page);

		// Create selection and open bottom sheet
		await selectReviewText(page);
		await page.waitForTimeout(500);

		const floatingBtn = page.locator(".review-floating-btn");
		await expect(floatingBtn).toBeVisible({ timeout: 3_000 });
		await floatingBtn.click();

		// Popover should be open in bottom-sheet mode
		const popover = page.locator("annotation-popover");
		await expect(popover).toHaveAttribute("open", "", { timeout: 3_000 });

		// Click Cancel
		await page.evaluate(() => {
			const ap = document.querySelector("annotation-popover")!;
			ap.shadowRoot!.querySelector<HTMLButtonElement>(".review-popover-cancel")!.click();
		});

		// Popover should close
		await expect(popover).not.toHaveAttribute("open", "", { timeout: 3_000 });

		// No annotation badge should be visible (or should show 0)
		const badge = page.locator(".review-tab-badge");
		const badgeCount = await badge.count();
		if (badgeCount > 0) {
			const text = await badge.textContent();
			expect(text).toBe("0");
		}
	});
});
