/**
 * Tier 2.5 \u2014 REALISTIC tail-chat reliability test for session navigate.
 *
 * Pre-creates two sessions, sends a real `STREAM_BURST:1` to each so
 * each has an actual transcript taller than the viewport (with a
 * tool-message + chunked assistant text). Hops A \u2192 B \u2192 A \u2192 B \u2192 A
 * (5 navigates) and asserts the latest message DOM node is bottom-
 * pinned within 8 px after each hop \u2014 using `getBoundingClientRect()`
 * only.
 *
 * Disables CSS scroll-anchoring inside the test scope (Safari-equivalent
 * baseline). The JS pin path (`setupSessionSubscription` \u2192 `await
 * updateComplete` \u2192 `_pinIfSticking`, plus `_imageLoadHandler` for any
 * subsequent image decodes) is the single contract.
 *
 * Sensitivity: fails when `_pinIfSticking()` returns immediately.
 */
import { test, expect } from "./fixtures.js";
import { createSession, waitForSessionStatus, waitForHealth } from "../e2e-setup.js";
import { openApp, sendMessage } from "./ui-helpers.js";
import { SCROLL_SEL, TAIL_PX, disableScrollAnchoring, expectLatestMessagePinned } from "./tail-chat-helpers.js";

test.describe("tail-chat: session navigate lands on latest message", () => {
	test.beforeAll(async () => {
		await waitForHealth();
	});

	test.setTimeout(120_000);

	test("A \u2192 B \u2192 A \u2192 B \u2192 A: each hop pins latest message bottom", async ({ page, rec }) => {
		const sessionA = await createSession();
		const sessionB = await createSession();
		await waitForSessionStatus(sessionA, "idle");
		await waitForSessionStatus(sessionB, "idle");

		await openApp(page);
		await disableScrollAnchoring(page);

		// Helper: navigate to a session and stream a real burst into it.
		const seedSession = async (sid: string, label: string) => {
			await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sid);
			await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });
			await page.waitForSelector(SCROLL_SEL, { timeout: 10_000 });
			await sendMessage(page, `STREAM_BURST:1 seed ${label}`);
			await page.waitForFunction(() => {
				const ai = document.querySelector("agent-interface");
				const content = ai?.querySelector(".max-w-5xl");
				return !!content && /STREAM_BURST_DONE:1/.test(content.textContent || "");
			}, null, { timeout: 30_000 });
			// Give Lit + RO a moment to settle after the burst.
			await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
		};

		await seedSession(sessionA, "A");
		await rec.capture("Session A seeded");
		await seedSession(sessionB, "B");
		await rec.capture("Session B seeded");

		// Now perform the 5 hops. Each hop:
		//   1. Routes to the target session.
		//   2. Re-applies `overflow-anchor: none` (addStyleTag survives navigate
		//      because we only flip the URL hash; the document is not reloaded,
		//      but we re-disable defensively in case any framework code resets).
		//   3. Awaits `_scrollContainer` to be available again.
		//   4. Awaits `updateComplete` + 2 rAFs so the production
		//      `setupSessionSubscription` \u2192 `_pinIfSticking` chain has run.
		//   5. Asserts latest-message bottom is at viewport bottom.
		const hops: Array<{ id: string; label: string }> = [
			{ id: sessionA, label: "A (1st)" },
			{ id: sessionB, label: "B (1st)" },
			{ id: sessionA, label: "A (2nd)" },
			{ id: sessionB, label: "B (2nd)" },
			{ id: sessionA, label: "A (3rd)" },
		];
		for (const { id, label } of hops) {
			await page.evaluate((sid) => { window.location.hash = `#/session/${sid}`; }, id);
			await page.waitForFunction(() => {
				const ai = document.querySelector("agent-interface") as any;
				return ai && ai._scrollContainer;
			}, null, { timeout: 10_000 });
			// Wait for at least one message DOM node to be present (pre-existing
			// transcript replay completes before pin runs).
			await page.waitForFunction(
				() => document.querySelectorAll("user-message, assistant-message, tool-message").length > 0,
				null,
				{ timeout: 15_000 },
			);
			await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
			await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
			await rec.capture(`Hop "${label}"`);
			await expectLatestMessagePinned(page, { tailPx: TAIL_PX, label });
		}

		// Sanity: at least one message rendered in the final hop.
		const msgCount = await page.evaluate(
			() => document.querySelectorAll("user-message, assistant-message, tool-message").length,
		);
		expect(msgCount, `final session must have message DOM nodes`).toBeGreaterThan(0);
	});
});
