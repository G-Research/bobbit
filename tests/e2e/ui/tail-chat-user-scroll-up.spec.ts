/**
 * Tier 2.5 \u2014 REALISTIC tail-chat reliability test for user-intent
 * scroll-up + recovery via jump-to-bottom.
 *
 * Drives a real `STREAM_BURST:3` so the scroll container has actual
 * overflow + a live stream is running. Uses Playwright's TRUSTED
 * `page.mouse.wheel()` to scroll up \u2014 NOT a synthetic
 * `dispatchEvent(new WheelEvent)`, which Chromium treats as untrusted
 * and which races subsequent test steps. After the trusted wheel:
 *   - Subsequent stream growth must NOT pull the viewport to the
 *     bottom (the user expects scrollTop to stay put).
 *   - The jump-to-bottom button must become visible (style.opacity=1).
 *   - Clicking the button must restore stickiness; the latest message
 *     bottom must then track stream growth.
 *
 * Disables CSS scroll-anchoring inside the test scope (Safari-equivalent
 * baseline). Asserts only on `getBoundingClientRect()`-derived facts
 * (and the public `data-testid` button visibility) \u2014 never private
 * fields.
 *
 * Sensitivity: this test exercises user-intent release + recovery
 * tracking; it fails when `_pinIfSticking()` returns immediately
 * (post-click recovery cannot pin) and is generally robust to RO /
 * image-handler regressions.
 */
import { test, expect } from "./fixtures.js";
import { waitForHealth, waitForSessionStatus, createSession } from "../e2e-setup.js";
import { openApp, sendMessage } from "./ui-helpers.js";
import { SCROLL_SEL, TAIL_PX, disableScrollAnchoring, expectLatestMessagePinned } from "./tail-chat-helpers.js";

test.describe("tail-chat: user wheel-up release + recovery", () => {
	test.beforeAll(async () => {
		await waitForHealth();
	});

	test.setTimeout(90_000);

	test("trusted wheel-up unsticks; jump-to-bottom click recovers + tracks", async ({ page, rec }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");

		await openApp(page);
		await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });
		await page.waitForSelector(SCROLL_SEL, { timeout: 10_000 });

		await disableScrollAnchoring(page);

		// Pre-stream spacer so we have headroom to scroll up.
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
		await rec.capture("Pre-stream: spacer ready, at bottom");

		await sendMessage(page, "STREAM_BURST:3 keep streaming while I scroll");
		await rec.capture("Sent STREAM_BURST:3");

		// Wait until the burst is actively streaming (at least one
		// assistant- or tool-message has rendered) so wheel-up has a
		// live stream to interrupt.
		await page.waitForFunction(() => {
			return document.querySelectorAll("assistant-message, tool-message").length > 0;
		}, null, { timeout: 30_000 });

		// Trusted user wheel-up. Position cursor inside the scroll
		// container, then dispatch wheel events. Chromium delivers wheel
		// events asynchronously and the resulting scroll commits over a
		// few rAFs; poll until scrollTop has actually moved off the bottom
		// (or the budget expires — in which case we fall back to a single
		// extra wheel pulse). The user-intent listener (`wheel`) flips
		// `_stickToBottom` on the FIRST trusted wheel, so even before the
		// scroll lands the production code knows the user took control.
		const box = await page.locator(SCROLL_SEL).first().boundingBox();
		if (!box) throw new Error("scroll container has no bounding box");
		await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
		for (let i = 0; i < 5; i++) {
			await page.mouse.wheel(0, -800);
		}
		// Wait for the scroll to commit — Chromium may smooth-scroll the
		// wheel deltas across several rAFs.
		await page.waitForFunction(
			(sel) => {
				const el = document.querySelector(sel) as HTMLElement | null;
				if (!el) return false;
				return el.scrollHeight - el.scrollTop - el.clientHeight > el.clientHeight * 0.4;
			},
			SCROLL_SEL,
			{ timeout: 5_000 },
		).catch(async () => {
			// Fallback: pulse a few more wheel events. We've already flipped
			// _stickToBottom via the first wheel; this just nudges scrollTop.
			for (let i = 0; i < 5; i++) await page.mouse.wheel(0, -1200);
		});
		await rec.capture("Trusted wheel up (5×-800)");

		// Outcome 1: viewport sits substantially above the bottom (user
		// intent honoured). Use bounding rects \u2014 no private fields.
		const afterWheel = await page.evaluate((sel) => {
			const el = document.querySelector(sel) as HTMLElement;
			return {
				scrollTop: el.scrollTop,
				scrollHeight: el.scrollHeight,
				clientHeight: el.clientHeight,
				distFromBottom: el.scrollHeight - el.scrollTop - el.clientHeight,
			};
		}, SCROLL_SEL);
		expect(
			afterWheel.distFromBottom,
			`tail-chat-user-scroll-up: trusted wheel-up did not move viewport off bottom; ` +
			`distFromBottom=${afterWheel.distFromBottom} (must be > clientHeight*0.4=${afterWheel.clientHeight * 0.4})`,
		).toBeGreaterThan(afterWheel.clientHeight * 0.4);

		// Outcome 2: jump-to-bottom button becomes visible (opacity=1).
		// `toBeVisible` is not enough \u2014 the element is always in the DOM
		// and `opacity:0` doesn't hide it for that matcher. Poll the
		// inline style instead; this is a public DOM observation.
		const jumpBtn = page.locator('[data-testid="jump-to-bottom"]');
		await expect(jumpBtn).toBeVisible();
		await expect.poll(
			async () => await jumpBtn.evaluate((el: HTMLElement) => el.style.opacity),
			{ timeout: 5_000, message: "jump-to-bottom button must reach opacity=1 after wheel-up" },
		).toBe("1");
		await rec.capture("Jump-to-bottom button visible");

		// Outcome 3: while wheel-released, ongoing stream growth must
		// NOT pull the viewport to the bottom. Capture scrollTop, give
		// the burst a chance to grow, and confirm we're still high up.
		const scrollTopBefore = afterWheel.scrollTop;
		// Wait for at least 3 message_update ticks worth of growth by
		// polling scrollHeight \u2014 this proves the stream is still emitting.
		await page.waitForFunction(
			(prevSh) => {
				const el = document.querySelector("agent-interface .overflow-y-auto") as HTMLElement | null;
				return !!el && el.scrollHeight > prevSh + 200;
			},
			afterWheel.scrollHeight,
			{ timeout: 30_000 },
		);
		const duringStream = await page.evaluate((sel) => {
			const el = document.querySelector(sel) as HTMLElement;
			return {
				scrollTop: el.scrollTop,
				scrollHeight: el.scrollHeight,
				clientHeight: el.clientHeight,
				distFromBottom: el.scrollHeight - el.scrollTop - el.clientHeight,
			};
		}, SCROLL_SEL);
		expect(
			duringStream.distFromBottom,
			`tail-chat-user-scroll-up: stream after wheel-up pulled viewport toward bottom; ` +
			`scrollTopBefore=${scrollTopBefore} after=${duringStream.scrollTop} ` +
			`distFromBottom=${duringStream.distFromBottom} (must remain > clientHeight*0.4)`,
		).toBeGreaterThan(duringStream.clientHeight * 0.4);
		await rec.capture("During stream after wheel: viewport stayed above bottom");

		// Outcome 4: click the jump-to-bottom button. Stickiness restored,
		// latest-message bottom at viewport bottom, AND continued growth
		// keeps it pinned.
		await jumpBtn.click();
		await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
		await rec.capture("Clicked jump-to-bottom");

		// Wait for STREAM_BURST_DONE so we assert against the *final*
		// latest-message DOM node.
		await page.waitForFunction(() => {
			const ai = document.querySelector("agent-interface");
			const content = ai?.querySelector(".max-w-5xl");
			return !!content && /STREAM_BURST_DONE:3/.test(content.textContent || "");
		}, null, { timeout: 60_000 });
		await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
		await rec.capture("Burst done; latest message must be pinned");

		await expectLatestMessagePinned(page, { tailPx: TAIL_PX, label: "after-recovery" });

		// Outcome 5: the button hides again now that we're back at bottom.
		await expect.poll(
			async () => await jumpBtn.evaluate((el: HTMLElement) => el.style.opacity),
			{ timeout: 5_000, message: "jump-to-bottom button must hide again after recovery" },
		).toBe("0");
	});
});
