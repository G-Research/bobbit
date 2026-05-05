/**
 * Tier 2.5 \u2014 REALISTIC tail-chat reliability test for tool_result
 * expansion + async syntax-highlighting reflow.
 *
 * `STREAM_BURST:2` emits two real cycles, each consisting of:
 *   - a `propose_goal` tool_use that streams in (renders a tool card),
 *   - a chunked assistant-text stream,
 *   - a real `bash_bg.wait` (1.5 s tool_use + tool_result expansion),
 *   - more chunked assistant-text.
 *
 * The bash_bg.wait tool_result expands the existing tool card by the
 * full output body \u2014 the canonical "tool result returns and the card
 * expands" path. Async markdown rendering / syntax highlighting then
 * grows the layout a second time after initial commit. This is the
 * exact stress pattern Section 4 case (2) of the design doc names.
 *
 * Disables CSS scroll-anchoring inside the test scope so the JS pin
 * path is the single contract (Safari-equivalent baseline).
 *
 * Asserts only on `getBoundingClientRect()`-derived facts.
 *
 * Sensitivity: fails when `_pinIfSticking()` returns immediately or the
 * RO `delta > 0` branch is removed.
 */
import { test, expect } from "./fixtures.js";
import { waitForHealth, waitForSessionStatus, createSession } from "../e2e-setup.js";
import { openApp, sendMessage } from "./ui-helpers.js";
import { SCROLL_SEL, TAIL_PX, disableScrollAnchoring, expectLatestMessagePinned } from "./tail-chat-helpers.js";

test.describe("tail-chat: tool_result expansion keeps latest message pinned", () => {
	test.beforeAll(async () => {
		await waitForHealth();
	});

	test.setTimeout(60_000);

	test("STREAM_BURST:2 \u2014 tool_use \u2192 tool_result expansion stays pinned", async ({ page, rec }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");

		await openApp(page);
		await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });
		await page.waitForSelector(SCROLL_SEL, { timeout: 10_000 });

		await disableScrollAnchoring(page);

		await page.evaluate((sel) => {
			const ai = document.querySelector("agent-interface") as any;
			const content = ai?.querySelector(".max-w-5xl") as HTMLElement | null;
			if (!content) throw new Error("messages content container not found");
			const spacer = document.createElement("div");
			spacer.id = "__tail_chat_pre_spacer";
			spacer.style.height = "5000px";
			spacer.style.background = "linear-gradient(#eef, #fee)";
			content.insertBefore(spacer, content.firstChild);
			const el = document.querySelector(sel) as HTMLElement;
			el.scrollTop = el.scrollHeight;
		}, SCROLL_SEL);
		await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));

		const pre = await page.evaluate((sel) => {
			const el = document.querySelector(sel) as HTMLElement;
			return {
				overflow: el.scrollHeight - el.clientHeight,
				distance: el.scrollHeight - el.scrollTop - el.clientHeight,
			};
		}, SCROLL_SEL);
		expect(pre.overflow, `pre: scroll container must have overflow`).toBeGreaterThan(2000);
		expect(pre.distance, `pre: must start at bottom`).toBeLessThanOrEqual(TAIL_PX);
		await rec.capture(`Pre-stream: spacer (overflow=${pre.overflow})`);

		await sendMessage(page, "STREAM_BURST:2 expand a tool card mid-stream");
		await rec.capture("Sent STREAM_BURST:2");

		// Wait until the FIRST tool_result lands (proves expansion fired).
		await page.waitForSelector("tool-message", { timeout: 30_000 });
		await rec.capture("First tool-message rendered");

		// Mid-stream pin check: latest message tracked while bursting.
		// Allow a single retry rAF cycle so any in-flight `_pinIfSticking`
		// can settle. The assertion still fails if drift persists.
		await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
		await expectLatestMessagePinned(page, { tailPx: 32, label: "mid-burst" });
		await rec.capture("Mid-burst: latest message pinned");

		await page.waitForFunction(() => {
			const ai = document.querySelector("agent-interface");
			const content = ai?.querySelector(".max-w-5xl");
			return !!content && /STREAM_BURST_DONE:2/.test(content.textContent || "");
		}, null, { timeout: 30_000 });
		await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
		await rec.capture("STREAM_BURST_DONE:2 detected");

		// Outcome assertion: end-of-stream latest-message bottom at viewport bottom.
		await expectLatestMessagePinned(page, { tailPx: TAIL_PX, label: "end-of-stream" });

		// Sanity: a tool-message DOM node exists (otherwise the expansion path didn't run).
		const toolCount = await page.evaluate(() => document.querySelectorAll("tool-message").length);
		expect(toolCount, `expected at least one tool-message rendered`).toBeGreaterThan(0);
	});
});
