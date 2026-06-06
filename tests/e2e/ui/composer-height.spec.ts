/**
 * E2E: composer textarea sizing + newline/send behavior.
 *
 * Pins the "Taller composer input" contract (src/ui/components/MessageEditor.ts):
 *   - The empty composer renders at least ~2 text lines tall (rows=2 / min-height: 2lh).
 *   - Typing many lines grows the field, but it caps near 20vh and then scrolls
 *     internally (scrollHeight > clientHeight once content exceeds the cap).
 *   - Shift+Enter inserts a newline; plain Enter sends (composer clears).
 */
import { test, expect } from "../gateway-harness.js";
import type { Page } from "@playwright/test";
import { waitForHealth, waitForSessionStatus, createSession, deleteSession } from "../e2e-setup.js";
import { openApp } from "./ui-helpers.js";

async function navigateToSession(page: Page, sessionId: string): Promise<void> {
	await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
	await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });
}

interface Metrics {
	clientHeight: number;
	scrollHeight: number;
	lineHeight: number;
	viewportH: number;
}

async function readMetrics(page: Page): Promise<Metrics> {
	return await page.evaluate(() => {
		const ta = document.querySelector("textarea") as HTMLTextAreaElement;
		const cs = getComputedStyle(ta);
		let lineHeight = parseFloat(cs.lineHeight);
		if (!Number.isFinite(lineHeight) || lineHeight === 0) {
			lineHeight = parseFloat(cs.fontSize) * 1.2;
		}
		return {
			clientHeight: ta.clientHeight,
			scrollHeight: ta.scrollHeight,
			lineHeight,
			viewportH: window.innerHeight,
		};
	});
}

test.describe("composer height + newline behavior", () => {
	test.beforeAll(async () => {
		await waitForHealth();
	});

	test("empty composer is >=2 lines; grows then caps/scrolls at ~20vh; Shift+Enter newline, Enter sends", async ({ page }) => {
		const sessionId = await createSession();
		try {
			await waitForSessionStatus(sessionId, "idle");
			await openApp(page);
			await navigateToSession(page, sessionId);

			const textarea = page.locator("textarea").first();
			await expect(textarea).toBeEditable({ timeout: 15_000 });

			// (a) Empty composer renders at least ~2 lines tall.
			const empty = await readMetrics(page);
			expect(
				empty.clientHeight,
				`empty composer should be >=2 lines (lineHeight=${empty.lineHeight}, clientHeight=${empty.clientHeight})`,
			).toBeGreaterThanOrEqual(empty.lineHeight * 1.8);

			// (b) Typing many lines grows the field, then caps near 20vh and scrolls.
			const manyLines = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n");
			await textarea.fill(manyLines);
			await expect(async () => {
				const m = await readMetrics(page);
				const cap = m.viewportH * 0.2;
				// Capped: visible height stays near 20vh (allow small rounding/padding slack).
				expect(m.clientHeight, `clientHeight (${m.clientHeight}) should cap near 20vh (${cap})`).toBeLessThanOrEqual(cap + 40);
				expect(m.clientHeight, `clientHeight (${m.clientHeight}) should have grown well past 2 lines`).toBeGreaterThan(empty.clientHeight);
				// Scrolls internally: content exceeds the visible box.
				expect(m.scrollHeight, `scrollHeight (${m.scrollHeight}) should exceed clientHeight (${m.clientHeight}) once capped`).toBeGreaterThan(m.clientHeight + 4);
			}).toPass({ intervals: [100, 250, 500, 1000], timeout: 8_000 });

			// (c) Shift+Enter inserts a newline (value gains "\n"), Enter clears (sends).
			await textarea.fill("");
			await textarea.click();
			await textarea.type("first");
			await textarea.press("Shift+Enter");
			await textarea.type("second");
			await expect(textarea).toHaveValue("first\nsecond", { timeout: 5_000 });

			// Plain Enter submits and clears the composer.
			await textarea.press("Enter");
			await expect(textarea).toHaveValue("", { timeout: 5_000 });
		} finally {
			await deleteSession(sessionId).catch(() => { /* best-effort */ });
		}
	});
});
