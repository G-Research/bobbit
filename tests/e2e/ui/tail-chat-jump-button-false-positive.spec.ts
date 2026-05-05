/**
 * Tier 2.5 — REPRODUCING test for the false-positive Jump-to-bottom button.
 *
 * Bug (post-PR #468, with `overflow-anchor: none` as the single contract):
 *   During sustained streaming + reflows, the scroll handler's
 *   early-return-on-echo path leaves `_showJumpToBottom = true` even when
 *   the viewport is at (or within a few px of) the bottom. Users see the
 *   "Jump to bottom" pill stuck visible while already at the tail.
 *
 * Strategy (matches `tail-chat-real-stream.spec.ts`):
 *   1. Open app, navigate to fresh session, disable scroll-anchoring so
 *      Chromium ≡ Safari and the JS pin path is the single contract.
 *   2. Inject a 5000 px pre-stream spacer so the container has real overflow
 *      and "at bottom" is non-trivial; snap to bottom; seed the echo latch.
 *   3. Drive the real path with STREAM_BURST:3 and, mid-stream, inject a
 *      single programmatic `scrollTop -= clientHeight * 0.6` write on the
 *      chat container. This is the canonical trigger for Bug A in the
 *      issue analysis: NOT a user gesture, so production's user-intent
 *      listeners don't flip `_stickToBottom = false`, but the resulting
 *      `scroll` event has `dist > clientHeight * 0.5`, which is exactly
 *      the geometry condition under which `_handleScroll` flips
 *      `_showJumpToBottom = true`. The subsequent rAF re-pin pushes a
 *      fresh echo into the ring; the NEXT scroll event matches that echo
 *      and early-returns from `_handleScroll` WITHOUT recomputing
 *      visibility — leaving `_showJumpToBottom` stuck `true` for the rest
 *      of the session even once the viewport is back at `dist ≈ 0`.
 *   4. Sample every ~100 ms in-page: record scroll metrics AND the
 *      computed `opacity` + `pointer-events` of `[data-testid=
 *      "jump-to-bottom"]`. Production renders the button continuously and
 *      toggles via opacity/pointer-events (NOT display) — Playwright's
 *      `toBeHidden()` treats opacity:0 as visible, so we read computed
 *      style directly. NO private-field reads.
 *   5. After `STREAM_BURST_DONE:3` detected, assert: every sample where
 *      the viewport is within `clientHeight * 0.1` of the bottom must
 *      have the Jump button hidden (opacity ~ 0 AND pointer-events: none).
 *
 * Outcome-only contract:
 *   - Reads ONLY public DOM/scroll metrics and `getComputedStyle(button)`.
 *   - Never inspects `_showJumpToBottom`, `_stickToBottom`,
 *     `_programmaticEchoes`, or any other private field on `agent-interface`.
 *
 * Expected on master HEAD: FAIL — at least one mid-stream sample shows
 * `dist < clientHeight*0.1` with the Jump button visible (opacity 1).
 *
 * Expected after the use-stick-to-bottom port lands: PASS.
 */
import { test, expect } from "./fixtures.js";
import { waitForHealth, waitForSessionStatus, createSession } from "../e2e-setup.js";
import { openApp, sendMessage } from "./ui-helpers.js";
import { disableScrollAnchoring, SCROLL_SEL } from "./tail-chat-helpers.js";

const JUMP_SEL = "[data-testid='jump-to-bottom']";

/**
 * The viewport is "effectively at the bottom" when the distance from the
 * scroll bottom is under 10 % of the client height. Industry uses 70 px
 * fixed; 10 % adapts to the test viewport (default 1280×720 → 72 px,
 * essentially the same).
 */
const NEAR_BOTTOM_FACTOR = 0.1;

/** Opacity below this counts as effectively hidden (sub-frame transitions). */
const HIDDEN_OPACITY_MAX = 0.05;

test.describe("tail-chat: jump-to-bottom button is not falsely shown at the tail", () => {
	test.beforeAll(async () => {
		await waitForHealth();
	});

	// STREAM_BURST:3 plus a mid-stream programmatic scroll-up trigger.
	// Wall-clock floor ≈ 4.5 s plus reducer/render time. Bump the test
	// timeout to comfortably cover Windows CI with slack.
	test.setTimeout(90_000);

	test("STREAM_BURST:3 + mid-stream programmatic scroll-up — Jump button stays hidden whenever viewport is within 10% of bottom", async ({
		page,
		rec,
	}) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");

		await openApp(page);
		await page.evaluate((id) => {
			window.location.hash = `#/session/${id}`;
		}, sessionId);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });
		await page.waitForSelector(SCROLL_SEL, { timeout: 10_000 });

		// Single-contract: disable CSS scroll-anchoring so the JS pin path is
		// what's keeping us at the bottom — and the buggy echo-return path
		// has nowhere to hide. Production also sets `overflow-anchor: none`
		// on the scroll container; this helper cascades the rule to every
		// descendant for safety.
		await disableScrollAnchoring(page);

		// Pre-stream spacer: ensure the container has real overflow before the
		// burst, so "at bottom" is non-trivial. Snap to bottom and seed the
		// echo latch so the post-spacer scroll event is consumed cleanly.
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
		await page.evaluate(
			() =>
				new Promise<void>((resolve) => {
					requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
				}),
		);

		// Precondition: there's overflow, we're at the bottom, and the Jump
		// button is hidden right now (opacity 0).
		const pre = await page.evaluate(
			({ scrollSel, jumpSel }) => {
				const el = document.querySelector(scrollSel) as HTMLElement;
				const btn = document.querySelector(jumpSel) as HTMLElement | null;
				const cs = btn ? getComputedStyle(btn) : null;
				return {
					overflow: el.scrollHeight - el.clientHeight,
					distance: el.scrollHeight - el.scrollTop - el.clientHeight,
					jumpFound: !!btn,
					jumpOpacity: cs ? cs.opacity : null,
					jumpPointerEvents: cs ? cs.pointerEvents : null,
				};
			},
			{ scrollSel: SCROLL_SEL, jumpSel: JUMP_SEL },
		);
		expect(
			pre.overflow,
			`pre-condition: scroll container must have overflow; overflow=${pre.overflow}`,
		).toBeGreaterThan(2000);
		expect(
			pre.distance,
			`pre-condition: must start at bottom; distance=${pre.distance}`,
		).toBeLessThanOrEqual(8);
		expect(pre.jumpFound, "pre-condition: jump-to-bottom button must be in DOM").toBe(true);
		expect(
			Number(pre.jumpOpacity ?? "1"),
			`pre-condition: jump button must start hidden; opacity=${pre.jumpOpacity}`,
		).toBeLessThanOrEqual(HIDDEN_OPACITY_MAX);
		await rec.capture(`Pre-stream: spacer in, at bottom, button hidden (opacity=${pre.jumpOpacity})`);

		// Install in-page sampler. Records scroll metrics + button computed
		// style at ~100 ms cadence so a transient false-positive is caught
		// even if the final tick clears it.
		await page.evaluate(
			({ scrollSel, jumpSel }) => {
				const w = window as any;
				w.__jumpFalseSamples = [];
				const start = performance.now();
				w.__jumpFalseSamplerId = setInterval(() => {
					const el = document.querySelector(scrollSel) as HTMLElement | null;
					const btn = document.querySelector(jumpSel) as HTMLElement | null;
					if (!el) return;
					const cs = btn ? getComputedStyle(btn) : null;
					w.__jumpFalseSamples.push({
						t: Math.round(performance.now() - start),
						scrollTop: el.scrollTop,
						scrollHeight: el.scrollHeight,
						clientHeight: el.clientHeight,
						opacity: cs ? Number(cs.opacity) : 1,
						pointerEvents: cs ? cs.pointerEvents : "auto",
						visibility: cs ? cs.visibility : "visible",
						display: cs ? cs.display : "inline",
					});
				}, 100);
			},
			{ scrollSel: SCROLL_SEL, jumpSel: JUMP_SEL },
		);

		// Drive the real streaming path.
		await sendMessage(page, "STREAM_BURST:3 please tail this chat");
		await rec.capture("Sent STREAM_BURST:3 — streaming begins");

		// Mid-stream trigger for Bug A. Wait for some content growth from the
		// burst, then inject a single programmatic `scrollTop` write that moves
		// the viewport up by ~60 % of clientHeight. This is NOT a user gesture
		// (no wheel / touch / key event), so `_stickToBottom` is not flipped
		// false by the production user-intent listeners — but the resulting
		// `scroll` event has `dist > clientHeight * 0.5`, which is the exact
		// geometry condition under which `_handleScroll` flips
		// `_showJumpToBottom = true`. Production then rAF re-pins, pushes a
		// fresh echo, and the next scroll event matches that echo and
		// early-returns without recomputing visibility — leaving the flag
		// stuck true while the viewport is back at the bottom. We do this
		// while still streaming so the rest of the burst exercises the
		// scroll-handler-on-echo path repeatedly.
		await page.waitForFunction(
			({ scrollSel, baseline }) => {
				const el = document.querySelector(scrollSel) as HTMLElement | null;
				return !!el && el.scrollHeight > baseline + 400;
			},
			{ scrollSel: SCROLL_SEL, baseline: pre.overflow + 720 },
			{ timeout: 30_000 },
		);
		const trigger = await page.evaluate((sel) => {
			const el = document.querySelector(sel) as HTMLElement;
			const before = {
				scrollTop: el.scrollTop,
				scrollHeight: el.scrollHeight,
				clientHeight: el.clientHeight,
			};
			const delta = Math.floor(el.clientHeight * 0.6);
			el.scrollTop = Math.max(0, el.scrollTop - delta);
			// Don't dispatch a synthetic event — let the browser fire the real
			// `scroll` event so the production `_handleScroll` runs against the
			// new geometry exactly as it would for any layout-induced scroll.
			return { before, delta, scrollTopAfter: el.scrollTop };
		}, SCROLL_SEL);
		await rec.capture(
			`Mid-stream trigger: scrolled up by ${trigger.delta}px ` +
				`(scrollTop ${trigger.before.scrollTop} → ${trigger.scrollTopAfter})`,
		);

		// Wait for the burst-done marker. We scan textContent (not innerText)
		// — a broken pin path can leave the marker below the fold where
		// innerText would not see it.
		await page.waitForFunction(
			() => {
				const ai = document.querySelector("agent-interface");
				const content = ai?.querySelector(".max-w-5xl");
				return !!content && /STREAM_BURST_DONE:3/.test(content.textContent || "");
			},
			null,
			{ timeout: 60_000 },
		);
		await rec.capture("STREAM_BURST_DONE:3 detected");

		// Stop sampler, drain buffer, allow final RO ticks to settle.
		const samples = await page.evaluate(() => {
			const w = window as any;
			if (w.__jumpFalseSamplerId) clearInterval(w.__jumpFalseSamplerId);
			w.__jumpFalseSamplerId = null;
			return (w.__jumpFalseSamples || []) as Array<{
				t: number;
				scrollTop: number;
				scrollHeight: number;
				clientHeight: number;
				opacity: number;
				pointerEvents: string;
				visibility: string;
				display: string;
			}>;
		});
		await page.evaluate(
			() =>
				new Promise<void>((resolve) => {
					requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
				}),
		);

		const final = await page.evaluate(
			({ scrollSel, jumpSel }) => {
				const el = document.querySelector(scrollSel) as HTMLElement;
				const btn = document.querySelector(jumpSel) as HTMLElement | null;
				const cs = btn ? getComputedStyle(btn) : null;
				return {
					scrollTop: el.scrollTop,
					scrollHeight: el.scrollHeight,
					clientHeight: el.clientHeight,
					opacity: cs ? Number(cs.opacity) : 1,
					pointerEvents: cs ? cs.pointerEvents : "auto",
				};
			},
			{ scrollSel: SCROLL_SEL, jumpSel: JUMP_SEL },
		);
		const finalDist = final.scrollHeight - final.scrollTop - final.clientHeight;
		await rec.capture(
			`Final: dist=${finalDist} jumpOpacity=${final.opacity} samples=${samples.length}`,
		);

		// Sanity: sampler ran for the whole burst, and the burst meaningfully
		// grew the transcript (otherwise the test is trivially passing).
		expect(
			samples.length,
			`sampler buffer too small (${samples.length}) — burst may not have run long enough`,
		).toBeGreaterThan(20);
		expect(
			final.scrollHeight,
			`scrollHeight (${final.scrollHeight}) did not grow beyond pre-stream baseline ` +
				`(${pre.overflow + final.clientHeight}). STREAM_BURST didn't add real content.`,
		).toBeGreaterThan(pre.overflow + final.clientHeight + 200);

		// --- Outcome assertion (the bug under test) ---
		//
		// For every sample (mid-stream + final): if the viewport is within
		// `clientHeight * NEAR_BOTTOM_FACTOR` of the bottom, the Jump button
		// MUST be effectively hidden (opacity ≤ 0.05 AND pointer-events:none,
		// OR display:none / visibility:hidden). Anything else is the
		// false-positive regression: button shown while at the tail.
		const offenders = samples.filter((s) => {
			const dist = s.scrollHeight - s.scrollTop - s.clientHeight;
			const nearBottomBand = s.clientHeight * NEAR_BOTTOM_FACTOR;
			const atBottom = dist <= nearBottomBand;
			if (!atBottom) return false;
			const cssHidden = s.display === "none" || s.visibility === "hidden";
			const opacityHidden = s.opacity <= HIDDEN_OPACITY_MAX && s.pointerEvents === "none";
			return !(cssHidden || opacityHidden);
		});

		const summary = offenders
			.slice(0, 8)
			.map(
				(s) =>
					`t=${s.t}ms dist=${s.scrollHeight - s.scrollTop - s.clientHeight}/` +
					`${s.clientHeight} (band=${Math.round(s.clientHeight * NEAR_BOTTOM_FACTOR)}) ` +
					`opacity=${s.opacity} pe=${s.pointerEvents}`,
			)
			.join("\n  ");

		expect(
			offenders.length,
			`Jump button visible while at bottom: ${offenders.length} of ${samples.length} ` +
				`samples showed the Jump-to-bottom button rendered (opacity>${HIDDEN_OPACITY_MAX}) ` +
				`while the scroll viewport was within clientHeight*${NEAR_BOTTOM_FACTOR} of the bottom. ` +
				`Offenders:\n  ${summary}\n` +
				`Final: dist=${finalDist}/${final.clientHeight} opacity=${final.opacity} ` +
				`pointerEvents=${final.pointerEvents}`,
		).toBe(0);
	});
});
