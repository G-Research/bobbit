/**
 * Review Pane E2E tests — verifies the review pane feature end-to-end.
 * Tests: opening review documents, multi-tab management, closing tabs,
 * and tab switching between chat and review.
 */
import { test, expect } from "../gateway-harness.js";
import type { Page } from "@playwright/test";
import { openApp, createSessionViaUI, sendMessage, waitForAgentResponse } from "./ui-helpers.js";

const REVIEW_PANEL_TAB_SELECTOR = ".goal-preview-panel button.goal-tab-pill[data-panel-tab-kind='review']";

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function reviewPanelTab(page: Page, title: string) {
	return page.locator(REVIEW_PANEL_TAB_SELECTOR).filter({ hasText: new RegExp(`^Review:\\s*${escapeRegExp(title)}$`) });
}

function reviewPaneTab(page: Page, title: string) {
	return page.locator(`review-pane button.review-tab[title="${title}"]`);
}

async function selectReviewPanelTab(page: Page, title: string) {
	const tab = reviewPanelTab(page, title);
	await expect(tab).toHaveCount(1, { timeout: 10_000 });
	await expect(tab).toBeVisible({ timeout: 5_000 });
	await tab.click();
}

test.describe("Review Pane", () => {

	test("opens review pane with inline markdown @smoke", async ({ page }) => {
		await openApp(page);
		await createSessionViaUI(page);
		await sendMessage(page, "REVIEW_OPEN");
		await waitForAgentResponse(page, { text: "Done. Used review_open tool." });

		// Wait for the per-document review tab to appear in the side panel tab bar.
		await selectReviewPanelTab(page, "Test Document");

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

		// Dynamic chat tabs promotes each review document to a top-level side panel tab.
		await expect(page.locator(REVIEW_PANEL_TAB_SELECTOR)).toHaveCount(3, { timeout: 10_000 });
		await selectReviewPanelTab(page, "Document A");

		// Verify multiple document tabs still appear inside the review pane.
		await expect(page.locator("review-pane .review-tab")).toHaveCount(3, { timeout: 5_000 });

		// Verify tab labels
		await expect(reviewPaneTab(page, "Document A")).toBeVisible();
		await expect(reviewPaneTab(page, "Document B")).toBeVisible();
		await expect(reviewPaneTab(page, "Document C")).toBeVisible();
	});

	test("closes review tab via review_close", async ({ page }) => {
		await openApp(page);
		await createSessionViaUI(page);

		// First open a review document
		await sendMessage(page, "REVIEW_OPEN");
		await waitForAgentResponse(page, { text: "Done. Used review_open tool." });
		await expect(reviewPanelTab(page, "Test Document")).toHaveCount(1, { timeout: 10_000 });

		// Now close the review document
		await sendMessage(page, "REVIEW_CLOSE");
		await waitForAgentResponse(page, { text: "Done. Used review_close tool." });

		// Review tab should disappear from the unified panel tab bar
		await expect(reviewPanelTab(page, "Test Document")).toHaveCount(0, { timeout: 10_000 });
	});

	test("shows review pane in side panel on desktop", async ({ page }) => {
		await openApp(page);
		await createSessionViaUI(page);
		await sendMessage(page, "REVIEW_OPEN");
		await waitForAgentResponse(page, { text: "Done. Used review_open tool." });

		// On desktop, the review pane appears in the side panel (goal-preview-panel)
		// The per-document Review tab should appear in the side panel header
		await expect(reviewPanelTab(page, "Test Document")).toHaveCount(1, { timeout: 10_000 });

		// Review pane should be visible in the side panel
		await expect(page.locator("review-pane")).toBeVisible({ timeout: 5_000 });

		// Chat textarea should still be visible alongside (desktop split view)
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 5_000 });
	});

	test("multi-tab switching preserves content", async ({ page }) => {
		await openApp(page);
		await createSessionViaUI(page);
		await sendMessage(page, "REVIEW_MULTI");
		await waitForAgentResponse(page, { text: "Done. Used 3 tools." });

		// Verify all review documents are exposed as unambiguous top-level tabs.
		await expect(page.locator(REVIEW_PANEL_TAB_SELECTOR)).toHaveCount(3, { timeout: 10_000 });

		// Switch to Document B through its top-level review tab.
		await selectReviewPanelTab(page, "Document B");

		// Verify Document B content is displayed
		await expect(page.locator("review-document").getByText("Second document content").first()).toBeVisible({ timeout: 5_000 });

		// Switch to Document A using the internal review-pane tab.
		await reviewPaneTab(page, "Document A").click();

		// Verify Document A content is displayed
		await expect(page.locator("review-document").getByText("First document content").first()).toBeVisible({ timeout: 5_000 });
	});

	test("submit review button is disabled with no annotations", async ({ page }) => {
		await openApp(page);
		await createSessionViaUI(page);
		await sendMessage(page, "REVIEW_OPEN");
		await waitForAgentResponse(page, { text: "Done. Used review_open tool." });

		// Switch to the per-document review tab.
		await selectReviewPanelTab(page, "Test Document");

		// Submit Review button should be disabled when there are no annotations
		const submitBtn = page.locator("button", { hasText: "Submit Review" });
		await expect(submitBtn).toBeVisible({ timeout: 5_000 });
		await expect(submitBtn).toBeDisabled();
	});
});
