/**
 * Browser coverage for the real review_open gateway/tool integration path.
 * Review tab management, reload suppression, approve/reject validation, and
 * annotation feedback are covered by tests/ui-fixtures/proposal-review-fixture.spec.ts.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "../gateway-harness.js";
import { createSession, deleteSession, waitForSessionStatus } from "../e2e-setup.js";
import { openApp, sendMessage, waitForAgentResponse, navigateToHash } from "./ui-helpers.js";

const REVIEW_PANEL_TAB_SELECTOR = ".goal-preview-panel .goal-tab-pill[data-panel-tab-kind='review']";

function reviewTab(page: Page) {
	return page.locator(REVIEW_PANEL_TAB_SELECTOR).filter({ hasText: /^Review:\s*Test Document$/ });
}

async function goToSession(page: Page, sessionId: string) {
	await navigateToHash(page, `#/session/${sessionId}`);
	await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });
}

async function openReviewDocument(page: Page) {
	await sendMessage(page, "REVIEW_OPEN");
	await waitForAgentResponse(page, { text: "Done. Used review_open tool." });

	const tab = reviewTab(page);
	await expect(tab).toHaveCount(1, { timeout: 10_000 });
	await tab.click();

	const pane = page.locator("review-pane");
	await expect(pane).toBeVisible({ timeout: 5_000 });
	await expect(page.locator("review-document").getByText("Section One").first()).toBeVisible({ timeout: 5_000 });
	return pane;
}

test.describe("Review Pane", () => {
	test("opens review pane via review_open and approves through agent chat @smoke", async ({ page }) => {
		const sessionId = await createSession();
		try {
			await waitForSessionStatus(sessionId, "idle");
			await openApp(page);
			await goToSession(page, sessionId);
			const pane = await openReviewDocument(page);

			await pane.getByRole("button", { name: "Approve", exact: true }).click();
			await expect(
				page.locator("user-message").filter({ hasText: /approv/i }).last(),
				"Approve should send review feedback through the existing agent chat flow",
			).toBeVisible({ timeout: 10_000 });
			await waitForAgentResponse(page, { text: "OK", timeout: 15_000 });
			await expect(reviewTab(page), "submitted review_open document should close its review tab").toHaveCount(0, { timeout: 5_000 });
		} finally {
			await deleteSession(sessionId);
		}
	});
});
