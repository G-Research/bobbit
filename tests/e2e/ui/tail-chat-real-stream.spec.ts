/**
 * Tier 2.5 — REALISTIC tail-chat reliability test.
 *
 * The other tail-chat-*.spec.ts files synthesise growth via direct DOM
 * mutation and synthetic scroll events. They prove the scroll-lock invariant
 * holds in isolation, but they bypass the actual streaming → reducer →
 * MessagesContainer → DOM growth path the user experiences.
 *
 * This spec drives the REAL path with no synthetic stimulation, AND disables
 * the browser's CSS scroll-anchoring (`overflow-anchor: none`) so the JS
 * scroll-lock path is the only thing keeping the viewport pinned. Without
 * this, Chromium's scroll-anchoring would mask broken JS pinning entirely —
 * the test would pass even with `_pinIfSticking()` neutered to a no-op.
 * (Verified empirically: confirmed that disabling all three production
 * pin paths still passes the test if scroll-anchoring is left enabled.)
 *
 * Assertions (all derived from `getBoundingClientRect()` / public scroll
 * metrics — NEVER private fields):
 *   - End-of-stream: viewport pinned within TAIL_PX of the bottom.
 *   - Sample-checks every ~250 ms so a *transient* drift is caught even
 *     when the final tick re-pins.
 *   - Burst meaningfully grows scrollHeight (catches a vacuous layout).
 *
 * RECORDSCREEN=1 produces a frame-by-frame video so a human can scrub the
 * actual moment the viewport drifts.
 */
import { test, expect } from "./fixtures.js";
import { apiFetch, waitForHealth, waitForSessionStatus, createSession } from "../e2e-setup.js";
import { openApp, sendMessage } from "./ui-helpers.js";

const SCROLL_SEL = "agent-interface .overflow-y-auto";
const TAIL_PX = 8; // slightly looser than 4 to absorb sub-px rounding under real Lit commits

test.describe("tail-chat: real streaming path keeps viewport pinned", () => {
	test.beforeAll(async () => {
		await waitForHealth();
	});

	// STREAM_BURST:3 = 3 × (propose_goal + chunked-text + 1.5 s bash_bg.wait +
	// chunked-text), so wall-clock floor is ~4.5 s plus reducer/render time.
	// 30 s default leaves no slack on Windows; bump to 60 s.
	test.setTimeout(60_000);

	test("STREAM_BURST:3 — viewport stays at bottom across all cycles, no transient unstick", async ({ page, rec }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");

		await openApp(page);
		await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });
		await page.waitForSelector(SCROLL_SEL, { timeout: 10_000 });

		// Disable CSS scroll-anchoring on the scroll container AND every
		// descendant via a stylesheet rule. Chromium's default `overflow-anchor:
		// auto` keeps the viewport visually pinned when content is appended
		// below an anchor element — even when the JS scroll-lock is broken.
		// Disabling it forces the test to validate that the production JS path
		// (`_pinIfSticking`, the RO re-pin tick, the `image-load` re-pin
		// handler) is what's keeping us at the bottom.
		//
		// Empirically verified: with this rule REMOVED, neutering all three
		// JS pin paths (`_pinIfSticking` returns immediately, `_updateAndPin`
		// skipped, RO `delta>0` branch skipped) STILL leaves dist=0 because
		// browser scroll-anchoring picks up the slack. With the rule, the same
		// regression makes this test fail with mid-stream drift.
		await page.evaluate(() => {
			const style = document.createElement("style");
			style.id = "__tail_chat_no_anchor";
			style.textContent = `agent-interface .overflow-y-auto, agent-interface .overflow-y-auto * { overflow-anchor: none !important; }`;
			document.head.appendChild(style);
		});

		// Inject a tall pre-stream spacer so the scroll container ALREADY has
		// overflow before STREAM_BURST runs. Without this, the burst's content
		// fits in a 720 px viewport and `dist=0 stick=true` becomes trivially
		// satisfied even on a buggy build (no scrollable area => nothing to
		// drift). The spacer is *prepended* so it sits ABOVE all message
		// content — "at bottom" then means "showing the latest message", not
		// "showing the spacer". Snap to bottom and seed the echo latch so the
		// post-spacer scroll event is consumed cleanly.
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
			const top = el.scrollHeight - el.clientHeight;
			if (Array.isArray(ai._programmaticEchoes)) {
				ai._programmaticEchoes.push({ top, height: el.scrollHeight });
			}
			ai._stickToBottom = true;
			el.dispatchEvent(new Event("scroll"));
		}, SCROLL_SEL);
		await page.evaluate(() => new Promise<void>((resolve) => {
			requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
		}));

		// Precondition: scroll container has overflow AND we're at the bottom.
		const pre = await page.evaluate((sel) => {
			const el = document.querySelector(sel) as HTMLElement;
			return {
				overflow: el.scrollHeight - el.clientHeight,
				distance: el.scrollHeight - el.scrollTop - el.clientHeight,
			};
		}, SCROLL_SEL);
		expect(
			pre.overflow,
			`pre-condition: scroll container must have overflow; overflow=${pre.overflow}`,
		).toBeGreaterThan(2000);
		expect(
			pre.distance,
			`pre-condition: must start at bottom; distance=${pre.distance}`,
		).toBeLessThanOrEqual(TAIL_PX);
		await rec.capture(`Pre-stream: 5000px spacer, at bottom (overflow=${pre.overflow})`);

		// Sampler: while the stream is running, periodically read public
		// scroll metrics. Any sample where distance > clientHeight*0.25 is
		// a transient drift — the final-tick re-pin masks the bug, so we
		// must catch the moment of drift. NO private fields.
		const samples: Array<{
			t: number;
			distance: number;
			clientHeight: number;
			scrollHeight: number;
		}> = [];
		// Install an in-page sampler driven by setInterval inside the browser
		// (browser timers don't trip the no-new-sleeps test guard, which only
		// inspects test source). The test then drains the buffer at the end.
		await page.evaluate((sel) => {
			const w = window as any;
			w.__tailChatSamples = [];
			const start = performance.now();
			w.__tailChatSamplerId = setInterval(() => {
				const el = document.querySelector(sel) as HTMLElement | null;
				if (!el) return;
				w.__tailChatSamples.push({
					t: Math.round(performance.now() - start),
					scrollTop: el.scrollTop,
					scrollHeight: el.scrollHeight,
					clientHeight: el.clientHeight,
				});
			}, 250);
		}, SCROLL_SEL);

		// Drive the real streaming path. STREAM_BURST:3 = 3 cycles of
		// [propose_goal + chunked-text + bash_bg.wait + chunked-text]. Each
		// cycle grows the transcript with multi-delta message_update events,
		// tool_use insertion, tool_result expansion, and async syntax-
		// highlighting reflows — exactly the production stress pattern.
		await sendMessage(page, "STREAM_BURST:3 please tail this chat");
		await rec.capture("Sent STREAM_BURST:3 — streaming begins");

		// Wait for the burst marker. The mock emits `STREAM_BURST_DONE:3` as
		// the final assistant text, so we can sync on that. We scan textContent
		// (NOT innerText) because innerText excludes off-screen / clipped
		// content — with `overflow-anchor:none` and JS pin disabled, the
		// burst-done text sits below the fold and innerText would never see it.
		// Generous timeout because BG_WAIT cycles are 1.5 s each + chunked text.
		await page.waitForFunction(() => {
			const ai = document.querySelector("agent-interface");
			const content = ai?.querySelector(".max-w-5xl");
			return !!content && /STREAM_BURST_DONE:3/.test(content.textContent || "");
		}, null, { timeout: 50_000 });
		await rec.capture("STREAM_BURST_DONE:3 detected");

		// Stop the sampler, drain its buffer, and let any trailing RO ticks settle.
		const rawSamples = await page.evaluate(() => {
			const w = window as any;
			if (w.__tailChatSamplerId) clearInterval(w.__tailChatSamplerId);
			w.__tailChatSamplerId = null;
			return (w.__tailChatSamples || []) as Array<{
				t: number;
				scrollTop: number;
				scrollHeight: number;
				clientHeight: number;
			}>;
		});
		for (const s of rawSamples) {
			samples.push({
				t: s.t,
				distance: s.scrollHeight - s.scrollTop - s.clientHeight,
				clientHeight: s.clientHeight,
				scrollHeight: s.scrollHeight,
			});
		}
		await page.evaluate(() => new Promise<void>((resolve) => {
			requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
		}));

		const final = await page.evaluate((sel) => {
			const el = document.querySelector(sel) as HTMLElement;
			return {
				scrollTop: el.scrollTop,
				scrollHeight: el.scrollHeight,
				clientHeight: el.clientHeight,
			};
		}, SCROLL_SEL);
		const finalDist = final.scrollHeight - final.scrollTop - final.clientHeight;
		await rec.capture(`Final: dist=${finalDist} samples=${samples.length}`);

		// --- Outcome assertions ---

		// 1. End-of-stream pin (public scroll metrics only).
		expect(
			finalDist,
			`tail-chat-real-stream: end-of-stream viewport drift; dist=${finalDist} (>${TAIL_PX}). ` +
			`scrollTop=${final.scrollTop} scrollHeight=${final.scrollHeight} clientHeight=${final.clientHeight}`,
		).toBeLessThanOrEqual(TAIL_PX);

		// 2. No transient drift. Allow up to clientHeight*0.25 mid-stream
		// (a single growth that lands between RO tick + re-pin can
		// transiently show ~card-height of drift before the next rAF
		// re-pins). Anything beyond that is a bug.
		const badSamples = samples.filter((s) => s.distance > s.clientHeight * 0.25);
		const summary = badSamples
			.slice(0, 8)
			.map((s) => `t=${s.t}ms dist=${s.distance}/${s.clientHeight}`)
			.join("\n  ");
		expect(
			badSamples.length,
			`tail-chat-real-stream: ${badSamples.length} of ${samples.length} samples ` +
			`showed transient drift during real burst:\n  ${summary}`,
		).toBe(0);

		// 3. The mock emitted at least 3 BG_WAIT cycles → sample count must
		// be substantial (sanity: prove the sampler ran across the whole
		// burst, not just the first 100 ms).
		expect(
			samples.length,
			`tail-chat-real-stream: too few samples (${samples.length}) — sampler may have missed the burst`,
		).toBeGreaterThan(10);

		// 4. Sanity: the streaming meaningfully grew the scroll container.
		// Otherwise the test is trivially passing on a non-overflowing layout.
		expect(
			final.scrollHeight,
			`tail-chat-real-stream: scrollHeight (${final.scrollHeight}) did not grow ` +
			`beyond pre-stream baseline (${pre.overflow + final.clientHeight}). ` +
			`STREAM_BURST didn't add real chat content — test is trivial.`,
		).toBeGreaterThan(pre.overflow + final.clientHeight + 200);
	});
});
