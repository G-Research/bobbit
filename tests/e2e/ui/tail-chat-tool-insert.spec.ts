/**
 * Reproducing test for goal "Fix tail-chat reliability" — Case (1):
 * **A new tool-use card appears below the fold and the viewport doesn't
 * follow.**
 *
 * Per Issue Analysis section 4, case (1) the multi-write echo-latch race
 * causes a stale scroll event to fall through to the geometry path in
 * `_handleScroll` (line 729 in AgentInterface.ts on master), which flips
 * `_stickToBottom = false` based on a transient mid-pin geometry. Subsequent
 * tool_use insertions do not re-pin because the master flag is now false.
 *
 * The redesign deletes the geometry-driven flip entirely (section 6.1), so
 * stale scroll events become no-ops for `_stickToBottom`.
 *
 * Assertion target: after a tool-card-sized growth following the stale-echo
 * race, the viewport must remain pinned to the bottom within 4 px AND
 * `_stickToBottom` must remain true.
 *
 * Expected master failure: `_stickToBottom` becomes false after the stale
 * scroll event; the subsequent growth leaves the new card below the fold.
 * Failure tail will read approximately:
 *   "tail-chat-tool-insert: viewport not pinned after tool_use insert
 *    scrollTop+clientHeight=<X> scrollHeight=<Y> distance=<Y-X> (>4)"
 */
import { test, expect } from "./fixtures.js";
import { setupTailChatScene, growContent, injectStaleScrollEvent, TAIL_PX } from "./tail-chat-helpers.js";

test.describe("tail-chat: tool_use card insert keeps viewport pinned", () => {
	test("inserting a tool_use card after a stale-echo race still pins to bottom", async ({ page, rec }) => {
		const { scrollSel } = await setupTailChatScene(page);
		await rec.capture("Scene ready — pinned at bottom");

		// First small "streamed token" growth — the RO ticks, _stickToBottom
		// is true, this re-pins us. Mimics the first half of a tool_use
		// streamed in chunks.
		const after1 = await growContent(page, 80);
		await rec.capture(`After 80px streamed token: stick=${after1.stick}`);
		expect(after1.stick).toBe(true);
		expect(after1.scrollHeight - after1.scrollTop - after1.clientHeight)
			.toBeLessThanOrEqual(TAIL_PX);

		// The race: a stale browser-emitted scroll event from the prior write
		// arrives after the latch has already been overwritten. On master, the
		// geometry path in `_handleScroll` flips _stickToBottom = false because
		// the event's scrollTop is "more than 10% of clientHeight" away from
		// the bottom. The redesign deletes that geometry path.
		const afterStale = await injectStaleScrollEvent(page);
		await rec.capture(`Stale scroll injected: stick=${afterStale.stick}`);
		// Don't assert on `afterStale.stick` — that's the implementation
		// behaviour we're trying to fix; assert on the *outcome* below.

		// A new tool_use card appears, extending below the fold.
		const after2 = await growContent(page, 600);
		await rec.capture(`After 600px tool-use card: stick=${after2.stick} dist=${after2.scrollHeight - after2.scrollTop - after2.clientHeight}`);

		const distance = after2.scrollHeight - after2.scrollTop - after2.clientHeight;
		const stickFinal = after2.stick;

		// Failure mode on master: stickFinal=false (geometry flipped it during
		// injectStaleScrollEvent), so the RO no longer re-pins on subsequent
		// growth → distance ≈ 600 (the new card height).
		expect(
			stickFinal,
			`tail-chat-tool-insert: _stickToBottom must remain true; was=${stickFinal}; ` +
			`stale-event metrics=${JSON.stringify(afterStale)}`,
		).toBe(true);
		expect(
			distance,
			`tail-chat-tool-insert: viewport not pinned after tool_use insert ` +
			`scrollTop+clientHeight=${after2.scrollTop + after2.clientHeight} ` +
			`scrollHeight=${after2.scrollHeight} distance=${distance} (>${TAIL_PX})`,
		).toBeLessThanOrEqual(TAIL_PX);

		// Persistence/repeat: a second tool_use insert must also remain pinned.
		const after3 = await growContent(page, 240);
		const distance3 = after3.scrollHeight - after3.scrollTop - after3.clientHeight;
		await rec.capture(`After 2nd insert (240px): stick=${after3.stick} dist=${distance3}`);
		expect(
			distance3,
			`tail-chat-tool-insert: second insert lost pin; distance=${distance3}`,
		).toBeLessThanOrEqual(TAIL_PX);
		void scrollSel; // silence unused
	});
});
