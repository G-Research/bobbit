/**
 * Browser integration for canonical session-status recovery.
 * Pure status-derivation cases are covered by tests/remote-agent-status.spec.ts;
 * this file keeps the full WS/browser path and duplicate-message regression.
 */
import { test, expect } from "../gateway-harness.js";
import { createSession, deleteSession, waitForSessionStatus } from "../e2e-setup.js";
import { openApp } from "./ui-helpers.js";

test.describe("Session status — canonical-status recovery", () => {
	test("status_resync heals stuck-streaming and subsequent prompts render once", async ({ page }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");

		try {
			await openApp(page);
			await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
			await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });
			await page.waitForFunction(
				() => !!(window as any).__bobbitState?.remoteAgent?.connected,
				undefined,
				{ timeout: 15_000 },
			);

			await expect.poll(async () =>
				page.evaluate(() => (window as any).__bobbitState.remoteAgent.state.isStreaming),
			).toBe(false);

			await page.evaluate(() => {
				const a = (window as any).__bobbitState.remoteAgent;
				a._state.status = "streaming";
				a._lastStatusVersion = -1;
			});
			expect(
				await page.evaluate(() => (window as any).__bobbitState.remoteAgent.state.isStreaming),
			).toBe(true);

			await page.evaluate(() => {
				(window as any).__bobbitState.remoteAgent.send({ type: "status_resync" });
			});
			await expect.poll(
				async () => page.evaluate(() => (window as any).__bobbitState.remoteAgent.state.isStreaming),
				{ timeout: 10_000, intervals: [100, 250, 500] },
			).toBe(false);
			expect(await page.evaluate(() => (window as any).__bobbitState.remoteAgent._state.status)).toBe("idle");

			const marker1 = `dup-check-${Date.now()}-A`;
			const marker2 = `dup-check-${Date.now()}-B`;
			const textarea = page.locator("textarea").first();

			await textarea.fill(marker1);
			await textarea.press("Enter");
			await expect(page.locator("user-message").filter({ hasText: marker1 }).first()).toBeVisible({ timeout: 15_000 });
			await page.waitForFunction(
				() => (window as any).__bobbitState.remoteAgent.state.status === "idle",
				undefined,
				{ timeout: 15_000 },
			);

			await textarea.fill(marker2);
			await textarea.press("Enter");
			await expect(page.locator("user-message").filter({ hasText: marker2 }).first()).toBeVisible({ timeout: 15_000 });
			await page.waitForFunction(
				() => (window as any).__bobbitState.remoteAgent.state.status === "idle",
				undefined,
				{ timeout: 15_000 },
			);

			expect(await page.locator("user-message").filter({ hasText: marker1 }).count()).toBe(1);
			expect(await page.locator("user-message").filter({ hasText: marker2 }).count()).toBe(1);
		} finally {
			await deleteSession(sessionId).catch(() => { /* best-effort */ });
		}
	});
});
