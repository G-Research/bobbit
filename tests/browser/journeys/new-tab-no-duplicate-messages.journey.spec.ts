/**
 * E2E regression for the new-tab duplicate-messages bug.
 *
 * Symptom: opening Bobbit in a SECOND browser tab in the SAME browser context
 * causes the ORIGINAL tab's currently-viewed live session to render plain-text
 * assistant messages 2-3x. Number of duplicates tracks number of new tabs.
 * Disappears on refresh.
 *
 * Mechanism (see issue-analysis gate):
 *   1. New tab triggers `visibilitychange` (hidden->visible) on the original tab.
 *   2. `RemoteAgent._onVisibilityChange` calls `requestMessages()`, which
 *      dispatches `apply({ type: "snapshot", messages })`.
 *   3. The snapshot survivor filter in `message-reducer.ts` only dedups by
 *      `id` / `toolCallId` / inner `toolCall.id`. Plain-text assistant rows
 *      whose live `message_end` arrived id-less don't match the snapshot's
 *      regenerated ids, so the live row survives AND the snapshot row is
 *      appended -> N+1 copies.
 *
 * The handler bails early on `document.visibilityState !== "visible"`, so we
 * reproduce the trigger by dispatching a synthetic `visibilitychange` event
 * on the page (the page is always visible in headless mode, satisfying the
 * guard). This is the same conceptual signal the browser sends when the user
 * opens a second tab; we additionally open a real second page in the same
 * context to exercise the full multi-client server fan-out.
 *
 * Must FAIL on master (live id-less plain-text assistant row + appended
 * snapshot row -> 2 copies of "OK") and PASS once the fix lands.
 */
import { test, expect } from "../gateway-harness.js";
import { openApp, createSessionViaUI, sendMessage, waitForAgentResponse } from "./ui-helpers.js";

test.describe("New-tab duplicate messages", () => {
	test("visibilitychange after new-tab does not duplicate plain-text replies", async ({ page, context }) => {
		// 1. Original tab: create session + plain-text exchange.
		await openApp(page);
		await createSessionViaUI(page);
		await sendMessage(page, "hello");
		await waitForAgentResponse(page); // default mock-agent reply text is "OK"

		// Wait for the assistant row to settle in the DOM.
		await expect.poll(
			async () => countAssistantOk(page),
			{ timeout: 5_000, intervals: [50, 100, 200] },
		).toBe(1);

		const initialCount = await countAssistantOk(page);
		expect(initialCount, "baseline: should have exactly one 'OK' reply").toBe(1);

		// 2. Open a SECOND page in the SAME browser context. This is the real-
		//    world repro condition (user opens Bobbit in a new tab). The new
		//    page establishes its own WS client to the same gateway.
		const page2 = await context.newPage();
		await openApp(page2);

		// 3. Trigger the visibility-change handler on the original tab. The
		//    real browser fires this on the original tab when the user opens
		//    a new tab; in headless Chromium `bringToFront` does NOT update
		//    `visibilityState`, but `RemoteAgent._onVisibilityChange` only
		//    checks `document.visibilityState === "visible"` (which is true
		//    here) so a synthetic dispatch is sufficient and faithful.
		await page.bringToFront();
		await page.evaluate(() => {
			document.dispatchEvent(new Event("visibilitychange"));
		});

		// 4. Allow the resync round-trip (`requestMessages` -> server
		//    `get_messages` reply -> `apply({type:"snapshot"})` reducer pass)
		//    to land. Poll the count for ~2 s; record the highest seen value.
		let observedMax = 1;
		await expect.poll(
			async () => {
				const c = await countAssistantOk(page);
				if (c > observedMax) observedMax = c;
				return observedMax;
			},
			{ timeout: 2_000, intervals: [50, 100, 150] },
		).toBeGreaterThanOrEqual(1);

		// 5. Final assertion: the dup must NOT have appeared. On master this
		//    fails with `expected 1, received 2`.
		const finalCount = await countAssistantOk(page);
		expect(
			finalCount,
			`after new-tab visibilitychange expected 1 'OK' reply, got ${finalCount} (max observed during window: ${observedMax})`,
		).toBe(1);
		expect(observedMax, "no duplicate must appear at any point in the resync window").toBe(1);

		await page2.close();
	});

	test("compound: multiple visibility round-trips do not pile up duplicates", async ({ page, context }) => {
		// Bug spec says duplicates compound: 1 -> 2 -> 3 -> ... per visibility tick.
		// We trigger 3 cycles with a >2s gap between each (the handler throttles
		// at 2s) and assert the count stays at 1.
		await openApp(page);
		await createSessionViaUI(page);
		await sendMessage(page, "hi");
		await waitForAgentResponse(page);

		await expect.poll(
			async () => countAssistantOk(page),
			{ timeout: 5_000, intervals: [50, 100, 200] },
		).toBe(1);

		// 3 visibility-change cycles. Each one is paired with a real new-page
		// open so the server actually sees the second client. The handler
		// throttles at 2s — wait > 2s between fires.
		const opened: import("@playwright/test").Page[] = [];
		for (let i = 0; i < 3; i++) {
			const newPage = await context.newPage();
			await openApp(newPage);
			opened.push(newPage);

			await page.bringToFront();
			await page.evaluate(() => {
				document.dispatchEvent(new Event("visibilitychange"));
			});

			// Sample after the resync should have landed. The throttle is
			// reset by passage of wall-clock time, so we wait deterministi-
			// cally for >2s using waitForFunction on a Date.now() target.
			const target = Date.now() + 2_100;
			await page.waitForFunction(
				(deadline) => Date.now() >= deadline,
				target,
				{ timeout: 5_000, polling: 100 },
			);
		}

		const finalCount = await countAssistantOk(page);
		expect(
			finalCount,
			`after 3 new-tab visibility cycles expected 1 'OK' reply, got ${finalCount}`,
		).toBe(1);

		for (const p of opened) await p.close();
	});
});

/**
 * Count assistant-message elements in the chat whose visible text contains "OK".
 * Avoids matching the textarea / sidebar / footer (those are not
 * `<assistant-message>` custom elements).
 */
async function countAssistantOk(page: import("@playwright/test").Page): Promise<number> {
	return await page.evaluate(() => {
		const ai = document.querySelector("agent-interface");
		if (!ai) return -1;
		const msgs = ai.querySelectorAll("assistant-message");
		let n = 0;
		for (const el of Array.from(msgs)) {
			const text = (el.textContent ?? "").trim();
			// Mock-agent default reply is exactly "OK" plus a timestamp suffix.
			// Match conservatively — must contain bare "OK".
			if (/(^|\s)OK(\s|$)/.test(text)) n++;
		}
		return n;
	});
}
