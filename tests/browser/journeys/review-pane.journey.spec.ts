import type { Page } from "@playwright/test";
import { test, expect } from "../../e2e/gateway-harness.js";
import { createSession, deleteSession, waitForSessionStatus } from "../../e2e/e2e-setup.js";
import { openApp, sendMessage, waitForAgentResponse, navigateToHash } from "../../e2e/ui/ui-helpers.js";

const REVIEW_TAB = "[data-testid=side-panel-tab][data-panel-tab-kind=review][data-panel-tab-title='Review: Test Document']";

async function openReview(page: Page) {
	await sendMessage(page, "REVIEW_OPEN");
	await waitForAgentResponse(page, { text: "Done. Used review_open tool." });
	const tab = page.locator(REVIEW_TAB);
	await expect(tab).toHaveCount(1, { timeout: 10_000 });
	await tab.click();
	const pane = page.locator("review-pane");
	await expect(pane).toBeVisible();
	return pane;
}

test.describe("Review Pane", () => {
	test("a revised live review_open reopens the rejected review with new markdown", async ({ page }) => {
		const sessionId = await createSession();
		try {
			await waitForSessionStatus(sessionId, "idle");
			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });
			const pane = await openReview(page);

			await pane.getByRole("textbox", { name: /final comment/i }).fill("Needs revised markdown.");
			await pane.getByRole("button", { name: "Reject" }).click();
			await waitForAgentResponse(page, { text: "OK", timeout: 15_000 });
			await expect(page.locator(REVIEW_TAB)).toHaveCount(0);

			await sendMessage(page, "REVIEW_OPEN_REVISED");
			await expect(page.getByText("Done. Used review_open tool.", { exact: true })).toHaveCount(2, { timeout: 15_000 });
			const reopened = page.locator(REVIEW_TAB);
			await expect(reopened).toHaveCount(1, { timeout: 10_000 });
			await reopened.click();
			await expect(page.locator("review-document").getByText(
				"Revised markdown after rejected feedback should reopen the review pane.",
			).first()).toBeVisible();
		} finally {
			await deleteSession(sessionId);
		}
	});
});
