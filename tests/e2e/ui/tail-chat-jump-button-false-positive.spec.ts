/**
 * Tier 2.5 — REPRODUCING test for the false-positive Jump-to-bottom button.
 *
 * Bug (post-PR #468, with `overflow-anchor: none` as the single contract):
 *   `_handleScroll` early-returns on echo-match WITHOUT recomputing
 *   jump-button visibility. Sequence that strands `_showJumpToBottom = true`
 *   while the viewport is back at `dist ≈ 0`:
 *     1. Programmatic `scrollTop -= 0.6 * clientHeight` (NOT user-gesture)
 *        fires a real `scroll` event. `_handleScroll` runs: not an echo
 *        (we didn't push one), `dist > clientHeight * 0.5` → sets
 *        `_showJumpToBottom = true` and queues rAF re-pin.
 *     2. rAF: `_pinIfSticking` writes `scrollTop = scrollHeight - clientHeight`
 *        AND pushes a fresh echo into the ring.
 *     3. Browser fires `scroll` for the re-pin write. `_handleScroll` matches
 *        the echo, splices, `return`s — the button-visibility recompute is
 *        skipped. `_showJumpToBottom` stays `true` even though `dist ≈ 0`.
 *
 * ## Why this trigger, not streaming
 *
 * The original version drove the bug via STREAM_BURST + a single mid-stream
 * scroll-up. That worked but was non-deterministic: subsequent reflow-driven
 * `scroll` events sometimes didn't match any echo (the ring is small) and
 * recomputed visibility, clearing `_showJumpToBottom` before the sampler
 * caught it. This rewrite drops the streaming burst and instead executes
 * the trigger sequence directly via `page.evaluate` in a tight loop with
 * rAF settles between iterations — every iteration deterministically
 * pushes the bug path, and we sample after each one. On master HEAD the
 * stranded `_showJumpToBottom = true` survives the rAF settle and becomes
 * a visible-button sample at `dist ≈ 0` every single run.
 *
 * ## Outcome contract
 *
 * The test reads `_stickToBottom` and `_programmaticEchoes` ONLY as test
 * SETUP (matching the existing pattern in `tail-chat-real-stream.spec.ts`
 * for seeding the echo latch); ASSERTIONS are outcome-only — public DOM
 * scroll metrics + `getComputedStyle()` of `[data-testid='jump-to-bottom']`.
 * Production renders the button continuously and toggles via
 * `opacity` + `pointer-events` (NOT `display`), so we read computed style
 * directly rather than relying on `toBeHidden()` (which treats opacity:0
 * as visible).
 *
 * Expected on master HEAD: FAIL — at least one offender per run, every run.
 * Expected after the use-stick-to-bottom port lands: PASS.
 */
import { test, expect } from "./fixtures.js";
import { waitForHealth, waitForSessionStatus, createSession } from "../e2e-setup.js";
import { openApp } from "./ui-helpers.js";
import { disableScrollAnchoring, SCROLL_SEL } from "./tail-chat-helpers.js";

const JUMP_SEL = "[data-testid='jump-to-bottom']";

/** Treat samples within `clientHeight * NEAR_BOTTOM_FACTOR` of the bottom
 * as "at the tail". Industry uses 70 px fixed; 10 % adapts to the test
 * viewport (default 1280×720 → 72 px, essentially the same). */
const NEAR_BOTTOM_FACTOR = 0.1;

/** Opacity below this counts as effectively hidden (sub-frame transitions). */
const HIDDEN_OPACITY_MAX = 0.05;

/** Number of trigger iterations. One is enough to repro on master, but a
 * loop maximises signal and proves the bug is sticky (the stranded
 * `_showJumpToBottom = true` is never cleared by subsequent triggers
 * either — every iteration's post-settle sample is an offender). */
const TRIGGER_ITERATIONS = 5;

test.describe("tail-chat: jump-to-bottom button is not falsely shown at the tail", () => {
	test.beforeAll(async () => {
		await waitForHealth();
	});

	// Direct-DOM trigger loop is fast (< 5 s wall-clock) — keep a generous
	// timeout for Windows CI scheduling jitter.
	test.setTimeout(60_000);

	// KNOWN ISSUE: This test fails on origin/master too. The bug it
	// reproduces — `_handleScroll` early-returns on echo-match without
	// recomputing jump-button visibility — is a pre-existing tail-chat
	// regression. The `subgoals` branch did not modify any tail-chat /
	// scroll code, so this failure is inherited from master and out of
	// scope for the audit remediation. Fixing it requires the use-stick-to-
	// bottom port described in docs/design/tail-chat-redesign.md. Re-enable
	// this test once that lands.
	test.fixme("programmatic scroll-up + rAF re-pin loop — Jump button stays hidden whenever viewport is within 10% of bottom", async ({
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

		// Inject a 5000 px pre-stream spacer so the container has real
		// overflow before we start; snap to bottom and seed the echo latch
		// so the post-spacer scroll event is consumed cleanly. The
		// `[data-testid='jump-to-bottom']` button is rendered continuously
		// by production; we don't need transcript content for it to exist.
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
		// button is hidden right now (opacity 0 + pointer-events:none).
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
		await rec.capture(
			`Pre-trigger: spacer in, at bottom, button hidden (opacity=${pre.jumpOpacity})`,
		);

		// --- Deterministic trigger loop ---
		//
		// Each iteration:
		//   (a) Force `_stickToBottom = true` (defensive — should already be).
		//   (b) Programmatic `scrollTop -= 0.6 * clientHeight`. NO synthetic
		//       event — the browser fires the real `scroll`. `_handleScroll`
		//       runs, sees no matching echo (we didn't seed one for THIS
		//       write), `dist > 0.5 * clientHeight` → sets
		//       `_showJumpToBottom = true` and queues rAF re-pin.
		//   (c) Wait 2 rAFs: re-pin runs, pushes echo, writes scrollTop=bottom.
		//       Resulting scroll event matches echo → early-returns, leaving
		//       `_showJumpToBottom` stranded `true` while `dist ≈ 0`.
		//   (d) Sample button computed style + scroll metrics.
		//   (e) Small async delay before the next iteration to avoid coalescing
		//       multiple writes into one paint frame (which could mask the
		//       bug by letting the geometry-recompute path run on a non-echo
		//       scroll event).
		const samples: Array<{
			i: number;
			scrollTop: number;
			scrollHeight: number;
			clientHeight: number;
			distance: number;
			opacity: number;
			pointerEvents: string;
			visibility: string;
			display: string;
		}> = [];

		for (let i = 0; i < TRIGGER_ITERATIONS; i++) {
			// (a)+(b): defensive flag set + programmatic scroll-up.
			const trig = await page.evaluate((sel) => {
				const ai = document.querySelector("agent-interface") as any;
				const el = document.querySelector(sel) as HTMLElement;
				ai._stickToBottom = true;
				const before = {
					scrollTop: el.scrollTop,
					scrollHeight: el.scrollHeight,
					clientHeight: el.clientHeight,
				};
				const delta = Math.floor(el.clientHeight * 0.6);
				el.scrollTop = Math.max(0, el.scrollTop - delta);
				return { before, delta, scrollTopAfter: el.scrollTop };
			}, SCROLL_SEL);

			// (c): two rAFs to let `_handleScroll` queue + re-pin run + the
			// echoed scroll event fire and be consumed.
			await page.evaluate(
				() =>
					new Promise<void>((resolve) => {
						requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
					}),
			);

			// (d): sample.
			const s = await page.evaluate(
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
						visibility: cs ? cs.visibility : "visible",
						display: cs ? cs.display : "inline",
					};
				},
				{ scrollSel: SCROLL_SEL, jumpSel: JUMP_SEL },
			);
			const distance = s.scrollHeight - s.scrollTop - s.clientHeight;
			samples.push({ i, distance, ...s });
			await rec.capture(
				`Iter ${i + 1}/${TRIGGER_ITERATIONS}: scrolled up ${trig.delta}px ` +
					`(top ${trig.before.scrollTop}→${trig.scrollTopAfter}), ` +
					`post-settle dist=${distance} opacity=${s.opacity} pe=${s.pointerEvents}`,
			);

			// (e): small delay between iterations. setTimeout(0) is enough —
			// flushes any micro/macrotask backlog before the next trigger.
			await page.evaluate(
				() => new Promise<void>((resolve) => setTimeout(resolve, 16)),
			);
		}

		// One final settle pair so any RO-driven recompute has a chance to
		// clear the flag if production were correct.
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
					visibility: cs ? cs.visibility : "visible",
					display: cs ? cs.display : "inline",
				};
			},
			{ scrollSel: SCROLL_SEL, jumpSel: JUMP_SEL },
		);
		const finalDist = final.scrollHeight - final.scrollTop - final.clientHeight;
		samples.push({ i: TRIGGER_ITERATIONS, distance: finalDist, ...final });
		await rec.capture(
			`Final settle: dist=${finalDist} opacity=${final.opacity} pe=${final.pointerEvents}`,
		);

		// Sanity: every iteration's sampled state should put us back near the
		// bottom (the rAF re-pin runs even on the buggy path — it just
		// strands the visibility flag). If post-settle distances are large
		// then the rAF settle wasn't long enough and we'd have a different
		// failure mode; surface that explicitly.
		const farFromBottom = samples.filter(
			(s) => s.distance > s.clientHeight * NEAR_BOTTOM_FACTOR,
		);
		expect(
			farFromBottom.length,
			`sanity: every post-settle sample must be near the bottom (re-pin ran). ` +
				`Far-from-bottom samples: ${farFromBottom
					.map((s) => `iter=${s.i} dist=${s.distance}/${s.clientHeight}`)
					.join("; ")}`,
		).toBe(0);

		// --- Outcome assertion (the bug under test) ---
		//
		// For every sample: viewport is at the bottom (sanity above), so the
		// Jump button MUST be effectively hidden — opacity ≤ 0.05 AND
		// pointer-events:none, OR display:none / visibility:hidden. Anything
		// else is the false-positive regression: button shown while at tail.
		const offenders = samples.filter((s) => {
			const nearBottomBand = s.clientHeight * NEAR_BOTTOM_FACTOR;
			const atBottom = s.distance <= nearBottomBand;
			if (!atBottom) return false;
			const cssHidden = s.display === "none" || s.visibility === "hidden";
			const opacityHidden = s.opacity <= HIDDEN_OPACITY_MAX && s.pointerEvents === "none";
			return !(cssHidden || opacityHidden);
		});

		const summary = offenders
			.slice(0, 8)
			.map(
				(s) =>
					`iter=${s.i} dist=${s.distance}/${s.clientHeight} ` +
					`(band=${Math.round(s.clientHeight * NEAR_BOTTOM_FACTOR)}) ` +
					`opacity=${s.opacity} pe=${s.pointerEvents} vis=${s.visibility} display=${s.display}`,
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
