import { test, expect } from "../../e2e/gateway-harness.js";
import { createSession, deleteSession, waitForSessionStatus } from "../../e2e/e2e-setup.js";
import { openApp, sendMessage, waitForAgentResponse, navigateToHash } from "../../e2e/ui/ui-helpers.js";

const STATUS_WORDS = ["Idle", "Busy", "Compacting", "Ended"];

test.describe("Replace bobbit sprite with text", () => {
	test("the preference swaps the live chat sprite and survives reload", async ({ page }) => {
		const sessionId = await createSession();
		try {
			await waitForSessionStatus(sessionId, "idle");
			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			await sendMessage(page, "hello");
			await waitForAgentResponse(page);
			await expect(page.locator("canvas.bobbit-blob__sprite").first()).toBeVisible({ timeout: 10_000 });

			await navigateToHash(page, "#/settings/system/general");
			const toggle = page.getByTestId("general-replace-bobbit-with-text");
			await expect(toggle).not.toBeChecked();
			await toggle.click();
			await navigateToHash(page, `#/session/${sessionId}`);

			const label = page.locator(".bobbit-blob-text").first();
			await expect(label).toBeVisible({ timeout: 10_000 });
			expect(STATUS_WORDS).toContain(await label.getAttribute("aria-label"));
			await expect(page.locator("canvas.bobbit-blob__sprite")).toHaveCount(0);

			await page.reload();
			await expect(page.locator(".bobbit-blob-text").first()).toBeVisible({ timeout: 15_000 });
			await expect(page.locator("canvas.bobbit-blob__sprite")).toHaveCount(0);
		} finally {
			await deleteSession(sessionId);
		}
	});
});
