/**
 * Reproducing test for goal "Fix tail-chat reliability" — Case (2):
 * **A tool result returns and the existing tool-use card expands; the
 * viewport stays frozen.**
 *
 * Per Issue Analysis section 4 case (2), this is the same multi-write
 * echo-latch race as case (1), aggravated by async syntax highlighting that
 * mutates the DOM after the initial result render. Master's geometry-flip
 * in `_handleScroll` (line 729) is the central source of fragility.
 *
 * Scenario: a tool_use card is inserted (initial render), then a tool_result
 * arrives and grows the existing card by a much larger amount (the result
 * body). A stale scroll event in between simulates the browser-emitted echo
 * race that escapes the single-pair latch.
 *
 * Expected master failure: after the stale-echo race, `_stickToBottom` is
 * false, so the result-expansion growth doesn't re-pin and the result
 * extends below the fold.
 */
import { test, expect } from "../gateway-harness.js";
import { setupTailChatScene, growContent, injectStaleScrollEvent, TAIL_PX } from "./tail-chat-helpers.js";

test.describe("tail-chat: tool_result expansion keeps viewport pinned", () => {
	test("expanding a tool card with result content still pins to bottom", async ({ page }) => {
		await setupTailChatScene(page);

		// Insert the initial tool_use card.
		const after1 = await growContent(page, 120);
		expect(after1.stick).toBe(true);
		expect(after1.scrollHeight - after1.scrollTop - after1.clientHeight)
			.toBeLessThanOrEqual(TAIL_PX);

		// Race: stale scroll event from a queued browser scroll arrives after
		// the latch was already overwritten by the next pin write.
		const afterStale = await injectStaleScrollEvent(page);

		// Tool_result lands — the existing tool-card grows by the full result
		// body height.
		const afterResult = await growContent(page, 800);

		// Async syntax-highlighting / markdown post-processing mutates the
		// DOM again, growing height a second time. On master this often
		// arrives after the settle window has exited.
		const afterHighlight = await growContent(page, 60);

		const distance = afterHighlight.scrollHeight - afterHighlight.scrollTop - afterHighlight.clientHeight;
		expect(
			afterHighlight.stick,
			`tail-chat-tool-expand: _stickToBottom flipped during expand. ` +
			`stale=${JSON.stringify(afterStale)} afterResult.stick=${afterResult.stick}`,
		).toBe(true);
		expect(
			distance,
			`tail-chat-tool-expand: viewport not pinned after tool_result expand+highlight; ` +
			`scrollTop+clientHeight=${afterHighlight.scrollTop + afterHighlight.clientHeight} ` +
			`scrollHeight=${afterHighlight.scrollHeight} distance=${distance} (>${TAIL_PX})`,
		).toBeLessThanOrEqual(TAIL_PX);
	});
});
