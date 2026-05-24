/**
 * Browser smoke for the real review_open tool path.
 *
 * Pure review-pane tab management/rendering is covered by
 * tests/ui-fixtures/proposal-review-fixture.spec.ts to keep browser E2E focused
 * on the gateway + mock-agent integration flow.
 */
import { test, expect } from "../gateway-harness.js";
import { openApp, createSessionViaUI, sendMessage, waitForAgentResponse } from "./ui-helpers.js";

const REVIEW_PANEL_TAB_SELECTOR = ".goal-preview-panel .goal-tab-pill[data-panel-tab-kind='review']";

test.describe("Review Pane", () => {
	test("opens review pane with inline markdown via review_open @smoke", async ({ page }) => {
		await openApp(page);
		await createSessionViaUI(page);
		await sendMessage(page, "REVIEW_OPEN");
		await waitForAgentResponse(page, { text: "Done. Used review_open tool." });

		const tab = page.locator(REVIEW_PANEL_TAB_SELECTOR).filter({ hasText: /^Review:\s*Test Document$/ });
		await expect(tab).toHaveCount(1, { timeout: 10_000 });
		await tab.click();

		await expect(page.locator("review-pane")).toBeVisible({ timeout: 5_000 });
		await expect(page.locator("review-document").getByText("Section One").first()).toBeVisible({ timeout: 5_000 });
	});
});
