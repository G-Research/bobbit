/**
 * Browser E2E — Escape key aborts the streaming agent regardless of focus.
 *
 * Contract:
 *   - Escape pressed while agent is streaming → abort fires (same as clicking
 *     the Stop button), even when focus is NOT on the textarea.
 *   - Escape inside the textarea also aborts (existing MessageEditor handler).
 */
import { test, expect } from "../../../support/harnesses/browser/legacy-ui/fixtures.js";
import {
	createSession,
	deleteSession,
	waitForHealth,
	waitForSessionStatus,
} from "../../_helpers/e2e-setup.js";
import { navigateToHash, openApp, sendMessage } from "../../../support/harnesses/browser/legacy-ui/ui-helpers.js";

test.describe("Escape aborts agent globally", () => {
	test.beforeAll(async () => {
		await waitForHealth();
	});

	test("Escape outside textarea aborts the streaming agent", async ({ page }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		try {
			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });

			await sendMessage(page, "STAY_BUSY:30000 working");
			await expect(page.getByRole("button", { name: "Stop current turn" })).toBeVisible({ timeout: 10_000 });

			// Blur the textarea so focus is NOT on an editable element.
			await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur?.(); });
			const focusedTag = await page.evaluate(() => document.activeElement?.tagName || "");
			expect(["TEXTAREA", "INPUT"].includes(focusedTag)).toBe(false);

			// Confirm the agent thinks it's streaming, then dispatch Escape at
			// document level (capture-phase listener picks it up).
			// Press Escape via the page's keyboard — by default Playwright sends
			// it to the focused element; with no focus it dispatches to body.
			await page.keyboard.press("Escape");

			await expect(page.locator(".stop-current-turn")).toHaveCount(0, { timeout: 10_000 });
			await waitForSessionStatus(sessionId, "idle", 10_000);
		} finally {
			await deleteSession(sessionId).catch(() => {});
		}
	});

	test("Escape inside textarea still aborts (existing path)", async ({ page }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		try {
			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			const textarea = page.locator("message-editor textarea").first();
			await expect(textarea).toBeVisible({ timeout: 15_000 });

			await sendMessage(page, "STAY_BUSY:30000 working");
			await expect(page.getByRole("button", { name: "Stop current turn" })).toBeVisible({ timeout: 10_000 });

			await textarea.focus();
			await textarea.press("Escape");

			await expect(page.locator(".stop-current-turn")).toHaveCount(0, { timeout: 10_000 });
		} finally {
			await deleteSession(sessionId).catch(() => {});
		}
	});
});
