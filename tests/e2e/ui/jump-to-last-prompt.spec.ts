/**
 * E2E: jump-to-prompt navigation buttons (purely geometric).
 *
 * Pins the new stateless contract from goal "Simplify jump-to-prompt
 * buttons" — visibility of each button is a pure function of current DOM
 * geometry, recomputed on every scroll/resize/mutation tick:
 *
 *   - Top button ("↑ Jump to previous prompt") visible iff at least one
 *     `<user-message>` has its bottom edge above the scroll container's
 *     top edge ("above viewport").
 *
 *   - Bottom-split ("↓ Next prompt | ⤓ Bottom") visible iff at least one
 *     `<user-message>` has its top edge below the scroll container's
 *     bottom edge ("below viewport").
 *
 *   - Bottom-single ("↓ Jump to bottom") visible iff not at bottom AND no
 *     `<user-message>` is below the viewport.
 *
 *   - Nothing rendered iff at bottom AND no `<user-message>` is above the
 *     viewport.
 *
 * The split and single are mutually exclusive variants of the bottom
 * button. There is no walk-cursor / parking state — clicking the buttons
 * just inspects current geometry to pick a target.
 */
import { test, expect } from "./fixtures.js";
import type { Page } from "@playwright/test";
import { waitForHealth, waitForSessionStatus, createSession } from "../e2e-setup.js";
import { sendMessage } from "./ui-helpers.js";
import {
	SCROLL_SEL,
	disableScrollAnchoring,
	installPreStreamSpacer,
	openTailSession,
	settleFrames,
	waitForBurstDone,
} from "./tail-chat-helpers.js";

const UP_SEL = '[data-testid="jump-to-previous-prompt"]';
const NEXT_SEL = '[data-testid="jump-to-next-prompt"]';
const BOTTOM_SEL = '[data-testid="jump-to-bottom"]';
const SPLIT_SEL = '[data-testid="jump-to-bottom-split"]';

async function readOpacity(page: Page, selector: string): Promise<string> {
	const loc = page.locator(selector);
	if ((await loc.count()) === 0) return "missing";
	return await loc.first().evaluate((el: HTMLElement) => el.style.opacity);
}

interface ButtonState {
	upVisible: boolean;
	bottomVisible: boolean;
	splitPresent: boolean;
}

async function readButtonState(page: Page): Promise<ButtonState> {
	return await page.evaluate(
		({ upSel, bottomSel, splitSel }) => {
			const upEl = document.querySelector(upSel) as HTMLElement | null;
			const splitEl = document.querySelector(splitSel) as HTMLElement | null;
			// `jump-to-bottom` testid exists both as a standalone button and
			// inside the split. Pick the standalone one (no SPLIT ancestor)
			// to avoid double-counting when reading opacity.
			const bottomEls = Array.from(
				document.querySelectorAll(bottomSel),
			) as HTMLElement[];
			const standalone = bottomEls.find((el) => !el.closest(splitSel));
			const inSplit = bottomEls.find((el) => el.closest(splitSel));
			const visible = (el: HTMLElement | null | undefined): boolean =>
				!!el && el.style.opacity === "1";
			return {
				upVisible: visible(upEl),
				bottomVisible: visible(standalone) || visible(inSplit),
				splitPresent: !!splitEl,
			};
		},
		{ upSel: UP_SEL, bottomSel: BOTTOM_SEL, splitSel: SPLIT_SEL },
	);
}

/**
 * For each `<user-message>` in the transcript, return how many are above
 * the viewport (bottom < container.top), in viewport, and below
 * (top > container.bottom). Mirrors production's geometric classification.
 */
async function classifyPrompts(page: Page): Promise<{ above: number; below: number; inView: number; userCount: number }> {
	return await page.evaluate((sel) => {
		const el = document.querySelector(sel) as HTMLElement | null;
		if (!el) return { above: 0, below: 0, inView: 0, userCount: 0 };
		const containerRect = el.getBoundingClientRect();
		const users = Array.from(document.querySelectorAll("user-message")) as HTMLElement[];
		let above = 0;
		let below = 0;
		let inView = 0;
		for (const u of users) {
			const r = u.getBoundingClientRect();
			if (r.bottom < containerRect.top) above++;
			else if (r.top > containerRect.bottom) below++;
			else inView++;
		}
		return { above, below, inView, userCount: users.length };
	}, SCROLL_SEL);
}

/**
 * Wait for the given `<user-message>` (by 0-based index) to settle with
 * its top edge ~16 px below the scroll container's top edge AND scrollTop
 * stable for one poll cycle (so the spring has fully landed).
 */
async function waitForUserMessageAtTop(page: Page, idx: number, timeout = 15_000): Promise<void> {
	await page.evaluate(() => {
		(window as unknown as { __lastSpringScrollTop?: number }).__lastSpringScrollTop = undefined;
	});
	await expect.poll(async () => {
		return await page.evaluate(({ sel, i }: { sel: string; i: number }) => {
			const el = document.querySelector(sel) as HTMLElement | null;
			if (!el) return false;
			const users = document.querySelectorAll("user-message");
			if (users.length <= i) return false;
			const target = users[i] as HTMLElement;
			const elRect = el.getBoundingClientRect();
			const targetRect = target.getBoundingClientRect();
			const offset = targetRect.top - elRect.top;
			if (Math.abs(offset - 16) > 32) return false;
			const w = window as unknown as { __lastSpringScrollTop?: number };
			const prev = w.__lastSpringScrollTop;
			w.__lastSpringScrollTop = el.scrollTop;
			return prev !== undefined && prev === el.scrollTop;
		}, { sel: SCROLL_SEL, i: idx });
	}, {
		timeout,
		message: `user-message[${idx}] must land within ±32 px of 16 px below container top (and scrollTop stable)`,
	}).toBe(true);
}

async function sendBurstPrompt(
	page: Page,
	sessionId: string,
	cycles: number,
	tag: string,
): Promise<void> {
	await sendMessage(page, `STREAM_BURST:${cycles} ${tag}`);
	await page.waitForFunction(
		() => document.querySelectorAll("assistant-message, tool-message").length > 0,
		null,
		{ timeout: 30_000 },
	);
	await waitForBurstDone(page, cycles, 60_000);
	await waitForSessionStatus(sessionId, "idle", 60_000);
	await settleFrames(page, 2);
}

async function userMessageCount(page: Page): Promise<number> {
	return await page.evaluate(() => document.querySelectorAll("user-message").length);
}

async function waitForUserMessageCount(page: Page, count: number, timeout = 10_000): Promise<void> {
	await page.waitForFunction(
		(n) => document.querySelectorAll("user-message").length >= n,
		count,
		{ timeout },
	);
}

/** Scroll container directly to a specific scrollTop (programmatic). */
async function scrollContainerTo(page: Page, scrollTop: number): Promise<void> {
	await page.evaluate(({ sel, top }) => {
		const el = document.querySelector(sel) as HTMLElement;
		el.scrollTop = top;
	}, { sel: SCROLL_SEL, top: scrollTop });
	await settleFrames(page, 2);
}

/** Scroll container to its scroll bottom. */
async function scrollContainerToBottom(page: Page): Promise<void> {
	await page.evaluate((sel) => {
		const el = document.querySelector(sel) as HTMLElement;
		el.scrollTop = el.scrollHeight;
	}, SCROLL_SEL);
	await settleFrames(page, 2);
}

test.describe("jump-to-prompt buttons (geometric)", () => {
	test.beforeAll(async () => {
		await waitForHealth();
	});

	test.setTimeout(60_000);

	test("empty transcript: nothing rendered", async ({ page, rec }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		await openTailSession(page, sessionId);
		await disableScrollAnchoring(page);
		await settleFrames(page);
		await rec.capture("Empty session opened");

		const state = await readButtonState(page);
		expect(state.upVisible, "up button hidden on empty transcript").toBe(false);
		expect(state.bottomVisible, "bottom button hidden on empty transcript").toBe(false);
		expect(state.splitPresent, "split control not rendered on empty transcript").toBe(false);
	});

	test("single prompt, scrolled past it: top + bottom-single visible", async ({ page, rec }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		await openTailSession(page, sessionId);
		await disableScrollAnchoring(page);
		await installPreStreamSpacer(page);
		await rec.capture("Pre-stream spacer installed");

		await sendBurstPrompt(page, sessionId, 2, "single prompt");

		// We're pinned at the bottom; the one prompt is above the viewport
		// (its burst output occupies the visible area). No prompts below.
		// Per the new geometric contract while pinned at the tail:
		//   - top button visible (above > 0)
		//   - split hidden (below === 0)
		//   - bottom-single hidden (we ARE at the bottom: dist <= 1)
		const cls = await classifyPrompts(page);
		expect(cls.userCount, "exactly one user prompt sent").toBe(1);
		expect(cls.above, "the single prompt must be above viewport when pinned at bottom").toBeGreaterThanOrEqual(1);
		expect(cls.below, "nothing below viewport when pinned at bottom").toBe(0);

		await expect
			.poll(async () => await readOpacity(page, UP_SEL), { timeout: 5_000 })
			.toBe("1");
		{
			const state = await readButtonState(page);
			expect(state.upVisible, "up button visible while pinned at tail with one prompt above").toBe(true);
			expect(state.splitPresent, "no split when no prompt below").toBe(false);
			expect(state.bottomVisible, "bottom hidden when geometrically at the tail").toBe(false);
		}

		// Now wheel-up enough to clear the half-viewport "far from bottom"
		// threshold so the bottom-single pill is shown. The threshold
		// (`dist > clientHeight * 0.5`) is the pre-existing UX guard
		// against flashing the big pill on tiny scroll deltas — pinned by
		// `tests/ui-fixtures/chat-scroll.spec.ts`. The trusted wheel sets
		// `_escapedFromLock = true` synchronously, then the deferred scroll
		// handler classifies it as a real user gesture.
		const box = await page.locator(SCROLL_SEL).first().boundingBox();
		if (!box) throw new Error("scroll container has no bounding box");
		await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
		// Scroll well past 50% of viewport height in a single trusted wheel.
		await page.mouse.wheel(0, -Math.ceil(box.height * 0.7));
		await settleFrames(page, 3);

		const cls2 = await classifyPrompts(page);
		expect(cls2.userCount, "must still have one prompt after wheel-up").toBe(1);

		// Verify we moved off the tail AND past the half-viewport threshold.
		const { dist, halfClient } = await page.evaluate((sel) => {
			const el = document.querySelector(sel) as HTMLElement;
			return {
				dist: el.scrollHeight - el.scrollTop - el.clientHeight,
				halfClient: el.clientHeight * 0.5,
			};
		}, SCROLL_SEL);
		expect(dist, "wheel-up moved us off the tail (dist > 1)").toBeGreaterThan(1);
		expect(dist, "wheel-up cleared the half-viewport threshold").toBeGreaterThan(halfClient);

		const state = await readButtonState(page);
		// Strict per-spec assertions: button visibility tracks classification.
		expect(state.upVisible, `up visibility = (above > 0); above=${cls2.above}`)
			.toBe(cls2.above > 0);
		expect(state.splitPresent, `split visibility = (below > 0); below=${cls2.below}`)
			.toBe(cls2.below > 0);
		// Bottom-single visibility tracks the half-viewport threshold:
		// visible iff (dist > clientHeight * 0.5) OR (below > 0).
		expect(state.bottomVisible, "bottom-single visible past the half-viewport threshold with no prompts below")
			.toBe(dist > halfClient || cls2.below > 0);
	});

	test("mobile: previous-prompt button and landing target clear fixed header", async ({ page, rec }) => {
		await page.setViewportSize({ width: 375, height: 667 });
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		await openTailSession(page, sessionId);
		await disableScrollAnchoring(page);
		await installPreStreamSpacer(page);
		await rec.capture("Mobile session opened");

		await sendMessage(page, "mobile header offset");
		await waitForSessionStatus(sessionId, "idle", 60_000);
		await page.evaluate((scrollSel) => {
			const content = document.querySelector("agent-interface .max-w-5xl") as HTMLElement | null;
			const scroller = document.querySelector(scrollSel) as HTMLElement | null;
			if (!content || !scroller) throw new Error("chat DOM not ready");
			let spacer = content.querySelector("#__jump_to_prompt_bottom_spacer") as HTMLElement | null;
			if (!spacer) {
				spacer = document.createElement("div");
				spacer.id = "__jump_to_prompt_bottom_spacer";
				content.appendChild(spacer);
			}
			spacer.style.height = `${Math.max(900, window.innerHeight * 1.5)}px`;
			scroller.scrollTop = scroller.scrollHeight;
			scroller.dispatchEvent(new Event("scroll"));
		}, SCROLL_SEL);
		await settleFrames(page, 4);
		await expect
			.poll(async () => await readOpacity(page, UP_SEL), {
				timeout: 10_000,
				message: "up button visible after prompt scrolls above mobile viewport",
			})
			.toBe("1");

		const buttonClearance = await page.evaluate((upSel) => {
			const header = document.getElementById("app-header") as HTMLElement | null;
			const buttons = Array.from(document.querySelectorAll(upSel)) as HTMLElement[];
			const button = buttons.find((el) => {
				const r = el.getBoundingClientRect();
				return r.right > 0 && r.left < window.innerWidth && r.bottom > 0 && r.top < window.innerHeight;
			}) ?? null;
			if (!header || !button) return null;
			const headerRect = header.getBoundingClientRect();
			const buttonRect = button.getBoundingClientRect();
			return {
				headerBottom: headerRect.bottom,
				buttonTop: buttonRect.top,
				buttonLeft: buttonRect.left,
				buttonRight: buttonRect.right,
				buttonWidth: buttonRect.width,
				centerX: buttonRect.left + buttonRect.width / 2,
				centerY: buttonRect.top + buttonRect.height / 2,
				innerWidth: window.innerWidth,
				innerHeight: window.innerHeight,
				styleTop: button.style.top,
			};
		}, UP_SEL);
		expect(buttonClearance, "mobile header + up button must exist").not.toBeNull();
		expect(buttonClearance!.styleTop, "top offset should follow the mobile header CSS var")
			.toContain("--mobile-header-height");
		expect(buttonClearance!.buttonTop, "up button must render below fixed mobile header")
			.toBeGreaterThan(buttonClearance!.headerBottom + 8);
		expect(buttonClearance!.centerX, "visible up button center must be inside the viewport")
			.toBeGreaterThan(0);
		expect(buttonClearance!.centerX, "visible up button center must be inside the viewport")
			.toBeLessThan(buttonClearance!.innerWidth);

		await page.mouse.click(buttonClearance!.centerX, buttonClearance!.centerY);
		await expect
			.poll(async () => {
				return await page.evaluate(({ scrollSel }) => {
					const header = document.getElementById("app-header") as HTMLElement | null;
					const firstPrompt = document.querySelector("user-message") as HTMLElement | null;
					const scroller = document.querySelector(scrollSel) as HTMLElement | null;
					if (!header || !firstPrompt || !scroller) return -9999;
					return Math.round(firstPrompt.getBoundingClientRect().top - header.getBoundingClientRect().bottom);
				}, { scrollSel: SCROLL_SEL });
			}, {
				timeout: 15_000,
				message: "jump target should land below fixed mobile header",
			})
			.toBeGreaterThan(8);
	});

	test("walk up + walk down + scroll-down-while-parked + new-prompt + return-near-bottom", async ({ page, rec }) => {
		test.setTimeout(180_000);
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		await openTailSession(page, sessionId);
		await disableScrollAnchoring(page);
		await installPreStreamSpacer(page);
		await rec.capture("Pre-stream spacer installed");

		// Send 3 user prompts with intervening burst output so each older
		// prompt has scrolled fully past the viewport top by the end.
		await sendBurstPrompt(page, sessionId, 2, "prompt one");
		await sendBurstPrompt(page, sessionId, 3, "prompt two");
		await sendBurstPrompt(page, sessionId, 4, "prompt three");

		await waitForUserMessageCount(page, 3);
		expect(await userMessageCount(page), "exactly three user prompts sent").toBe(3);
		await rec.capture("Three prompts sent");

		// Pinned at the bottom. Top button visible (last prompt is above
		// viewport). No prompts below → bottom button hidden (we ARE at
		// the bottom).
		await expect
			.poll(async () => await readOpacity(page, UP_SEL), {
				timeout: 5_000,
				message: "up button visible with three prompts pinned at bottom",
			})
			.toBe("1");
		{
			const state = await readButtonState(page);
			expect(state.splitPresent, "no split when at bottom").toBe(false);
			expect(state.bottomVisible, "bottom hidden when at bottom").toBe(false);
		}

		// --- Walking UP via "previous" repeatedly ---
		const upBtn = page.locator(UP_SEL);

		// Click 1: lands the bottom-most above-viewport prompt at top.
		// With 3 prompts and pinned at bottom, the bottom-most above-viewport
		// prompt is prompt[2] (the most recent — its assistant output fills
		// the viewport so the prompt itself is just above the top edge).
		await upBtn.click();
		await waitForUserMessageAtTop(page, 2);
		await rec.capture("Up click 1: prompt[2] at top");

		// After landing on prompt[2]: prompt[2] is at top, prompts [0,1]
		// remain above viewport, and prompt[2]'s burst output is below
		// viewport → split-bottom should appear.
		{
			const cls = await classifyPrompts(page);
			expect(cls.above, "after click 1: prompts 0,1 still above viewport").toBeGreaterThanOrEqual(2);
			const state = await readButtonState(page);
			expect(state.upVisible, "up button visible (prompts above)").toBe(true);
			// Whether the split appears depends on whether any prompt is
			// below viewport. At depth 1 (parked on most recent), the most
			// recent is at the top with assistant output below → no
			// user-message below viewport, so single bottom button shows.
			expect(state.bottomVisible, "bottom button visible after up-click (escaped tail)").toBe(true);
		}

		// Click 2: walks one further back. Bottom-most above-viewport
		// prompt is now prompt[1].
		await upBtn.click();
		await waitForUserMessageAtTop(page, 1);
		await rec.capture("Up click 2: prompt[1] at top");

		{
			const cls = await classifyPrompts(page);
			expect(cls.above, "prompt[0] is still above").toBeGreaterThanOrEqual(1);
			expect(cls.below, "prompt[2] is now below viewport").toBeGreaterThanOrEqual(1);
			const state = await readButtonState(page);
			expect(state.upVisible, "up button visible (prompt[0] above)").toBe(true);
			expect(state.splitPresent, "split present (prompt[2] below)").toBe(true);
			expect(state.bottomVisible, "split visible").toBe(true);
		}

		// Click 3: walks to prompt[0] (the oldest). Top button should
		// hide — no prompt above viewport anymore.
		await upBtn.click();
		await waitForUserMessageAtTop(page, 0);
		await rec.capture("Up click 3: prompt[0] at top — oldest");

		await expect
			.poll(async () => (await classifyPrompts(page)).above, {
				timeout: 5_000,
				message: "no prompts above viewport when parked on oldest",
			})
			.toBe(0);
		await expect
			.poll(async () => await readOpacity(page, UP_SEL), {
				timeout: 5_000,
				message: "up button hides when no prompts above viewport",
			})
			.toBe("0");
		{
			const state = await readButtonState(page);
			expect(state.splitPresent, "split still present (prompts below)").toBe(true);
		}

		// --- Walking DOWN via "next" repeatedly ---
		// Each click walks to the top-most below-viewport prompt.

		// Next 1: from prompt[0] forward → top-most below is prompt[1].
		await page.locator(NEXT_SEL).click();
		await waitForUserMessageAtTop(page, 1);
		await rec.capture("Next click 1: prompt[1] at top");

		{
			const state = await readButtonState(page);
			expect(state.upVisible, "up button reappears (prompt[0] is above viewport)").toBe(true);
			expect(state.splitPresent, "split still present (prompt[2] below)").toBe(true);
		}

		// Next 2: from prompt[1] forward → top-most below is prompt[2].
		await page.locator(NEXT_SEL).click();
		await waitForUserMessageAtTop(page, 2);
		await rec.capture("Next click 2: prompt[2] at top");

		// At depth-1 again: prompt[2] is at the top. Below should be
		// just assistant output, no user-message below viewport → split
		// collapses to single.
		await expect
			.poll(async () => (await classifyPrompts(page)).below, {
				timeout: 5_000,
				message: "no user-message below viewport after walking to most-recent",
			})
			.toBe(0);
		await expect
			.poll(async () => (await readButtonState(page)).splitPresent, {
				timeout: 5_000,
				message: "split collapses to single when no prompts below viewport",
			})
			.toBe(false);
		{
			const state = await readButtonState(page);
			expect(state.bottomVisible, "single bottom still visible (not at bottom)").toBe(true);
			expect(state.upVisible, "up still visible (prompts [0,1] above)").toBe(true);
		}

		// --- KEY REGRESSION CASE: scrolling DOWN while parked on an old
		// prompt. Park on prompt[0] (oldest), then trusted-wheel-DOWN.
		// Top button must STAY visible as long as any prompt is above the
		// viewport, no matter how the user got there. Previously, reset
		// rule 4 would clear nav state and the button could hide. ---
		await upBtn.click();
		await waitForUserMessageAtTop(page, 1);
		await upBtn.click();
		await waitForUserMessageAtTop(page, 0);
		await rec.capture("Walked back to prompt[0] for scroll-down regression test");

		// Trusted wheel-DOWN. Each wheel(+) moves scrollTop forward.
		const box = await page.locator(SCROLL_SEL).first().boundingBox();
		if (!box) throw new Error("scroll container has no bounding box");
		await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);

		// Scroll down a bit at a time and verify the top button reflects
		// geometry. After enough scroll-down, prompt[0] will be above
		// viewport → top button must still show.
		for (let i = 0; i < 4; i++) {
			await page.mouse.wheel(0, 400);
			await settleFrames(page, 2);
			const cls = await classifyPrompts(page);
			const state = await readButtonState(page);
			if (cls.above >= 1) {
				expect(
					state.upVisible,
					`scroll-down step ${i}: up button must stay visible while ${cls.above} prompt(s) are above viewport (regression case: this is exactly what the simplification fixes)`,
				).toBe(true);
			}
			// Symmetric: split visibility reflects below-count.
			if (cls.below >= 1) {
				expect(
					state.splitPresent,
					`scroll-down step ${i}: split must be visible when ${cls.below} prompt(s) below viewport`,
				).toBe(true);
			}
		}
		await rec.capture("Scrolled DOWN while parked: up button still visible per geometry");

		// --- New prompt appended while scrolled up ---
		// Park on prompt[0] again (scroll back to top).
		await scrollContainerTo(page, 0);
		// Confirm we're at the very top.
		await expect
			.poll(async () => (await classifyPrompts(page)).above, { timeout: 5_000 })
			.toBe(0);

		const userCountBefore = await userMessageCount(page);
		await sendBurstPrompt(page, sessionId, 5, "prompt four");
		await waitForUserMessageCount(page, userCountBefore + 1);
		await rec.capture("Prompt four appended");

		// After sending a new prompt: `sendMessage` re-pins to bottom via
		// `_scrollToBottom`. The new prompt sits at the tail; older
		// prompts are above viewport.
		await expect
			.poll(async () => (await classifyPrompts(page)).above, {
				timeout: 10_000,
				message: "old prompts above viewport after new prompt re-pinned to bottom",
			})
			.toBeGreaterThanOrEqual(1);
		await expect
			.poll(async () => await readOpacity(page, UP_SEL), {
				timeout: 5_000,
				message: "up button visible after re-pin to bottom (older prompts above)",
			})
			.toBe("1");
		{
			const state = await readButtonState(page);
			// We re-pinned to bottom → no prompts below.
			expect(state.splitPresent, "no split after re-pin to bottom").toBe(false);
			expect(state.bottomVisible, "bottom hidden when at bottom").toBe(false);
		}

		// --- Returning near bottom hides the up button iff no prompt is
		// above the viewport. With 4 prompts in this session, returning
		// to the bottom keeps older prompts above the viewport, so the up
		// button STAYS visible. The contract is: "hides iff no prompt
		// above viewport". To exercise the hide path explicitly we need a
		// short transcript where the only prompt is in view — covered by
		// the "single prompt" test above. Here we just confirm that the
		// up button reflects geometry after returning to the bottom.
		await scrollContainerToBottom(page);
		await settleFrames(page, 2);
		{
			const cls = await classifyPrompts(page);
			const state = await readButtonState(page);
			if (cls.above === 0) {
				expect(state.upVisible, "up hides when no prompts above viewport").toBe(false);
			} else {
				expect(state.upVisible, "up stays visible when prompts above viewport").toBe(true);
			}
			expect(state.splitPresent, "no split at bottom").toBe(false);
			expect(state.bottomVisible, "bottom hidden at bottom").toBe(false);
		}
		await rec.capture("Returned to bottom; geometry-only buttons");
	});

	test("returning near bottom hides up button when last prompt is in view", async ({ page, rec }) => {
		// Short transcript: one prompt + short response → the prompt is
		// visible after sending. The up button must hide because no prompt
		// is above the viewport.
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		await openTailSession(page, sessionId);
		await disableScrollAnchoring(page);
		await rec.capture("Short-session opened");

		await sendMessage(page, "hi");
		await waitForSessionStatus(sessionId, "idle");
		await settleFrames(page, 2);

		const cls = await classifyPrompts(page);
		expect(cls.userCount, "one user message").toBeGreaterThanOrEqual(1);
		// The prompt should be in view (or near enough).
		if (cls.above === 0) {
			const state = await readButtonState(page);
			expect(state.upVisible, "up hidden when last prompt is in view").toBe(false);
			expect(state.splitPresent, "no split").toBe(false);
			expect(state.bottomVisible, "bottom hidden when at bottom").toBe(false);
		}
		await rec.capture("One prompt visible; all buttons hidden");
	});
});
