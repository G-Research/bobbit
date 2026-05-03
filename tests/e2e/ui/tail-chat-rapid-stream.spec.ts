/**
 * Reproducing test for goal "Fix tail-chat reliability" — Rapid stream:
 * **10+ message_update events back-to-back; bottom must stay pinned
 * throughout, asserted at the midpoint AND end.**
 *
 * Per Issue Analysis section 7.1 row 3. Rapid streaming is the canonical
 * stressor for the multi-write echo-latch race: the single-pair latch only
 * holds the most recent (scrollTop, scrollHeight) pair, so under fast bursts
 * many echoes fall through to the geometry path and at least one transient
 * `scrollTop` reading is far enough from the bottom to flip
 * `_stickToBottom = false` on master.
 *
 * The redesign replaces the single-pair latch with a ring buffer AND removes
 * the geometry-driven flip altogether — so geometry never matters and rapid
 * streams stay pinned.
 *
 * Expected master failure: after some growth tick mid-stream, `_stickToBottom`
 * is false. Subsequent growth ticks no longer re-pin → viewport drifts away
 * from the bottom by the cumulative height of remaining ticks.
 */
import { test, expect } from "./fixtures.js";
import { setupTailChatScene, growContent, injectStaleScrollEvent, TAIL_PX, SCROLL_SEL } from "./tail-chat-helpers.js";

test.describe("tail-chat: rapid stream of message_update events", () => {
	test("12 back-to-back growth events keep viewport pinned at midpoint and end", async ({ page, rec }) => {
		await setupTailChatScene(page);
		await rec.capture("Scene ready: spacer installed, pinned at bottom");

		const TOTAL = 12;
		const MID = 6;
		// Mix of small token-sized growths and a couple of larger result-sized
		// growths, with stale scroll events sprinkled in to simulate the echo
		// race that real browsers exhibit under fast streaming.
		const sequence = [40, 80, 60, 120, 90, 150, 200, 70, 110, 80, 60, 90];

		for (let i = 0; i < TOTAL; i++) {
			const m = await growContent(page, sequence[i]);
			// Inject a stale scroll event roughly every other tick — this is
			// the multi-write race: a browser echo lands after the next
			// programmatic write has already overwritten the single-pair latch.
			if (i % 2 === 1) {
				await injectStaleScrollEvent(page);
			}

			if (i === MID) {
				const distMid = m.scrollHeight - m.scrollTop - m.clientHeight;
				const stickMid = m.stick;
				await rec.capture(`Midpoint i=${MID}: stick=${stickMid} dist=${distMid}`);
				expect(
					stickMid,
					`tail-chat-rapid-stream: _stickToBottom=${stickMid} at midpoint (i=${MID})`,
				).toBe(true);
				expect(
					distMid,
					`tail-chat-rapid-stream: midpoint viewport drift; ` +
					`distance=${distMid} (>${TAIL_PX})`,
				).toBeLessThanOrEqual(TAIL_PX);
			}
		}
		await rec.capture(`After ${TOTAL} growth events`);

		// Final assertion — yield two rAFs to let any trailing RO ticks settle.
		await page.evaluate(() => new Promise<void>((resolve) => {
			requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
		}));
		const final = await page.evaluate((sel) => {
			const ai = document.querySelector("agent-interface") as any;
			const el = document.querySelector(sel) as HTMLElement;
			return {
				stick: ai._stickToBottom,
				scrollTop: el.scrollTop,
				scrollHeight: el.scrollHeight,
				clientHeight: el.clientHeight,
			};
		}, SCROLL_SEL);
		const distFinal = final.scrollHeight - final.scrollTop - final.clientHeight;
		await rec.capture(`End-of-stream: stick=${final.stick} dist=${distFinal}`);
		expect(
			final.stick,
			`tail-chat-rapid-stream: _stickToBottom=${final.stick} after ${TOTAL} events`,
		).toBe(true);
		expect(
			distFinal,
			`tail-chat-rapid-stream: end-of-stream viewport drift; ` +
			`distance=${distFinal} (>${TAIL_PX})`,
		).toBeLessThanOrEqual(TAIL_PX);
	});
});
