/**
 * Tier 2.5 \u2014 REALISTIC tail-chat reliability test for rapid streaming.
 *
 * Drives the real streaming path with `STREAM_BURST:6` (6 cycles of
 * propose_goal + chunked-text + bash_bg.wait + chunked-text). This is
 * the canonical stressor for the multi-write echo-latch race \u2014 many
 * `message_update` events land back-to-back across cycles, and async
 * syntax highlighting / hydrated tool-content reflows the layout
 * mid-stream.
 *
 * Disables CSS scroll-anchoring inside the test scope so the JS pin
 * path (`_pinIfSticking` + RO `delta>0` + `_imageLoadHandler`) is the
 * single contract \u2014 mirroring Safari, where `overflow-anchor` has
 * limited availability.
 *
 * Asserts only on `getBoundingClientRect()`-derived facts \u2014 never
 * private fields. Sample-checks every ~250 ms so a *transient* drift is
 * caught even when the final tick happens to re-pin.
 *
 * Sensitivity: fails when `_pinIfSticking()` returns immediately or the
 * RO `delta > 0` branch is removed.
 */
import { test, expect } from "./fixtures.js";
import { waitForHealth, waitForSessionStatus, createSession } from "../e2e-setup.js";
import { openApp, sendMessage } from "./ui-helpers.js";
import { SCROLL_SEL, TAIL_PX, disableScrollAnchoring, expectLatestMessagePinned } from "./tail-chat-helpers.js";

test.describe("tail-chat: rapid streaming keeps latest message pinned", () => {
	test.beforeAll(async () => {
		await waitForHealth();
	});

	test.setTimeout(90_000);

	test("STREAM_BURST:6 \u2014 viewport tracks latest message bottom across all cycles", async ({ page, rec }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");

		await openApp(page);
		await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });
		await page.waitForSelector(SCROLL_SEL, { timeout: 10_000 });

		await disableScrollAnchoring(page);

		// Pre-stream spacer so the scroll container has overflow before
		// any message lands. Prepended above all message content so "at
		// bottom" means "showing the latest message".
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
		await rec.capture(`Pre-stream: spacer installed (overflow=${pre.overflow})`);

		// Sampler: probe `getBoundingClientRect()` every ~250 ms so we
		// catch transient drift even if the final tick re-pins.
		await page.evaluate((selectors) => {
			const w = window as any;
			w.__tailRapidSamples = [];
			const start = performance.now();
			w.__tailRapidSamplerId = setInterval(() => {
				const el = document.querySelector(selectors.scroll) as HTMLElement | null;
				if (!el) return;
				const msgs = Array.from(document.querySelectorAll(selectors.msg)) as HTMLElement[];
				if (msgs.length === 0) return;
				const last = msgs[msgs.length - 1];
				const er = el.getBoundingClientRect();
				const lr = last.getBoundingClientRect();
				w.__tailRapidSamples.push({
					t: Math.round(performance.now() - start),
					dist: Math.abs(er.bottom - lr.bottom),
					scrollHeight: el.scrollHeight,
					clientHeight: el.clientHeight,
					scrollTop: el.scrollTop,
				});
			}, 250);
		}, { scroll: SCROLL_SEL, msg: "user-message, assistant-message, tool-message" });

		await sendMessage(page, "STREAM_BURST:6 please tail this chat");
		await rec.capture("Sent STREAM_BURST:6");

		await page.waitForFunction(() => {
			const ai = document.querySelector("agent-interface");
			const content = ai?.querySelector(".max-w-5xl");
			return !!content && /STREAM_BURST_DONE:6/.test(content.textContent || "");
		}, null, { timeout: 80_000 });
		await rec.capture("STREAM_BURST_DONE:6 detected");

		const samples = await page.evaluate(() => {
			const w = window as any;
			if (w.__tailRapidSamplerId) clearInterval(w.__tailRapidSamplerId);
			return (w.__tailRapidSamples || []) as Array<{
				t: number; dist: number; scrollHeight: number; clientHeight: number; scrollTop: number;
			}>;
		});
		await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));

		// Outcome: end-of-stream latest-message bottom is at viewport bottom.
		await expectLatestMessagePinned(page, { tailPx: TAIL_PX, label: "end-of-stream" });
		await rec.capture(`End-of-stream pinned (${samples.length} samples)`);

		// Outcome: no transient drift > clientHeight*0.25.
		const bad = samples.filter((s) => s.dist > s.clientHeight * 0.25);
		const summary = bad.slice(0, 8).map((s) => `t=${s.t}ms dist=${Math.round(s.dist)}/${s.clientHeight}`).join("\n  ");
		expect(
			bad.length,
			`tail-chat-rapid-stream: ${bad.length}/${samples.length} samples drifted > clientHeight*0.25:\n  ${summary}`,
		).toBe(0);

		expect(samples.length, `sampler must run across the whole burst`).toBeGreaterThan(10);

		// Sanity: streaming meaningfully grew the scroll container.
		const finalSh = samples.length > 0 ? samples[samples.length - 1].scrollHeight : 0;
		expect(
			finalSh,
			`scrollHeight (${finalSh}) didn't grow beyond pre-stream baseline (${pre.overflow + (samples[0]?.clientHeight ?? 0)})`,
		).toBeGreaterThan(pre.overflow + 200);
	});
});
