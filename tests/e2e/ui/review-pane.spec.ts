/**
 * Review Pane E2E tests — verifies the review pane feature end-to-end.
 * Tests: opening review documents, multi-tab management, closing tabs,
 * and tab switching between chat and review.
 */
import { test, expect } from "../gateway-harness.js";
import { openApp, createSessionViaUI, sendMessage, waitForAgentResponse } from "./ui-helpers.js";

test.describe("Review Pane", () => {

	test("opens review pane with inline markdown", async ({ page }) => {
		await openApp(page);
		await createSessionViaUI(page);
		await sendMessage(page, "REVIEW_OPEN");
		await waitForAgentResponse(page, { text: "Done. Used review_open tool." });

		// Wait for review tab to appear in unified panel tab bar
		const reviewTab = page.locator(".goal-tab-pill", { hasText: "Review" });
		await expect(reviewTab).toBeVisible({ timeout: 10_000 });

		// Click the Review tab to switch to it
		await reviewTab.click();

		// Verify review pane element is present
		await expect(page.locator("review-pane")).toBeVisible({ timeout: 5_000 });

		// Verify the markdown heading rendered
		// ReviewDocument uses light DOM, so standard selectors work
		await expect(page.locator("review-document").getByText("Test Document").first()).toBeVisible({ timeout: 5_000 });

		// Verify section content rendered
		await expect(page.locator("review-document").getByText("Section One").first()).toBeVisible();
	});

	test("handles multiple review tabs", async ({ page }) => {
		await openApp(page);
		await createSessionViaUI(page);
		await sendMessage(page, "REVIEW_MULTI");
		// Multi-tool returns "Done. Used 3 tools."
		await waitForAgentResponse(page, { text: "Done. Used 3 tools." });

		// Wait for review tab to appear
		const reviewTab = page.locator(".goal-tab-pill", { hasText: "Review" });
		await expect(reviewTab).toBeVisible({ timeout: 10_000 });
		await reviewTab.click();

		// Verify multiple document tabs appear inside the review pane
		await expect(page.locator(".review-tab")).toHaveCount(3, { timeout: 5_000 });

		// Verify tab labels
		await expect(page.locator(".review-tab", { hasText: "Document A" })).toBeVisible();
		await expect(page.locator(".review-tab", { hasText: "Document B" })).toBeVisible();
		await expect(page.locator(".review-tab", { hasText: "Document C" })).toBeVisible();
	});

	test("closes review tab via review_close", async ({ page }) => {
		await openApp(page);
		await createSessionViaUI(page);

		// First open a review document
		await sendMessage(page, "REVIEW_OPEN");
		await waitForAgentResponse(page, { text: "Done. Used review_open tool." });
		const reviewTab = page.locator(".goal-tab-pill", { hasText: "Review" });
		await expect(reviewTab).toBeVisible({ timeout: 10_000 });

		// Now close the review document
		await sendMessage(page, "REVIEW_CLOSE");
		await waitForAgentResponse(page, { text: "Done. Used review_close tool." });

		// Review tab should disappear from the unified panel tab bar
		await expect(reviewTab).not.toBeVisible({ timeout: 10_000 });
	});

	test("switches between chat and review tabs", async ({ page }) => {
		await openApp(page);
		await createSessionViaUI(page);
		await sendMessage(page, "REVIEW_OPEN");
		await waitForAgentResponse(page, { text: "Done. Used review_open tool." });

		// Both Chat and Review tabs should be visible in the unified tab bar
		const chatTab = page.locator(".goal-tab-pill", { hasText: "Chat" });
		const reviewTab = page.locator(".goal-tab-pill", { hasText: "Review" });
		await expect(chatTab).toBeVisible({ timeout: 10_000 });
		await expect(reviewTab).toBeVisible({ timeout: 10_000 });

		// Switch to Review tab — review pane should be visible
		await reviewTab.click();
		await expect(page.locator("review-pane")).toBeVisible({ timeout: 5_000 });

		// Switch back to Chat tab — textarea should be visible again
		await chatTab.click();
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 5_000 });
	});

	test("multi-tab switching preserves content", async ({ page }) => {
		await openApp(page);
		await createSessionViaUI(page);
		await sendMessage(page, "REVIEW_MULTI");
		await waitForAgentResponse(page, { text: "Done. Used 3 tools." });

		// Switch to review panel
		const reviewTab = page.locator(".goal-tab-pill", { hasText: "Review" });
		await expect(reviewTab).toBeVisible({ timeout: 10_000 });
		await reviewTab.click();

		// Click on "Document B" tab within the review pane
		await page.locator(".review-tab", { hasText: "Document B" }).click();

		// Verify Document B content is displayed
		await expect(page.locator("review-document").getByText("Second document content").first()).toBeVisible({ timeout: 5_000 });

		// Switch to "Document A"
		await page.locator(".review-tab", { hasText: "Document A" }).click();

		// Verify Document A content is displayed
		await expect(page.locator("review-document").getByText("First document content").first()).toBeVisible({ timeout: 5_000 });
	});

	test("submit review button is disabled with no annotations", async ({ page }) => {
		await openApp(page);
		await createSessionViaUI(page);
		await sendMessage(page, "REVIEW_OPEN");
		await waitForAgentResponse(page, { text: "Done. Used review_open tool." });

		// Switch to review tab
		const reviewTab = page.locator(".goal-tab-pill", { hasText: "Review" });
		await expect(reviewTab).toBeVisible({ timeout: 10_000 });
		await reviewTab.click();

		// Submit Review button should be disabled when there are no annotations
		const submitBtn = page.locator("button", { hasText: "Submit Review" });
		await expect(submitBtn).toBeVisible({ timeout: 5_000 });
		await expect(submitBtn).toBeDisabled();
	});
});
