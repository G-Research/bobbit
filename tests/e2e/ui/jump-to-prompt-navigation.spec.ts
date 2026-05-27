/**
 * E2E: prompt-by-prompt jump navigation (extends PR #639's single-shot
 * "Jump to last prompt" into history walking).
 *
 * Covers the 9 required scenarios from design \u00a74:
 *  1. Backward stepping walks one prompt back per click.
 *  2. Up button label transitions "last" -> "previous" after first click.
 *  3. Up button hides at the oldest prompt.
 *  4. Jump-to-bottom reveals after any prompt-nav click.
 *  5. Split control appears at depth >= 2.
 *  6. "Next prompt" walks forward; depth-1 collapses the split.
 *  7. Split's "Bottom" half jumps all the way and clears nav state.
 *  8. Reset on new prompt sent.
 *  9. Reset on manual scroll past the parked prompt.
 *
 * Patterns mirror `jump-to-last-prompt.spec.ts` (geometry + pre-stream
 * spacer) and `tail-chat-user-scroll-up.spec.ts` (trusted wheel).
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

const UP_SEL = '[data-testid="jump-to-last-prompt"]';
const NEXT_SEL = '[data-testid="jump-to-next-prompt"]';
const BOTTOM_SEL = '[data-testid="jump-to-bottom"]';

async function readOpacity(page: Page, selector: string): Promise<string> {
	const loc = page.locator(selector);
	if ((await loc.count()) === 0) return "missing";
	return await loc.first().evaluate((el: HTMLElement) => el.style.opacity);
}

async function readUpLabel(page: Page): Promise<string | null> {
	const loc = page.locator(UP_SEL);
	if ((await loc.count()) === 0) return null;
	return await loc.first().getAttribute("data-label");
}

/**
 * Wait for the given <user-message> (by 0-based index in the live NodeList)
 * to land near the top of the viewport (~16 px below container top, \u00b132 px
 * tolerance per the design doc).
 */
async function waitForUserMessageAtTop(page: Page, idx: number, timeout = 15_000): Promise<void> {
	// Reset the stability cookie so each call only counts post-call frames.
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
			// Stability: scrollTop unchanged since last poll — confirms the
			// spring has fully landed (not just within tolerance mid-animation).
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

/**
 * Send a STREAM_BURST prompt, wait for the burst to complete and the
 * session to return to idle. Each call uses a distinct cycle count so
 * `waitForBurstDone` matches the correct burst (the helper looks for
 * `STREAM_BURST_DONE:N` anywhere in the transcript).
 */
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

/**
 * Wait for the up button to reach the requested opacity. Polls the live
 * `style.opacity` rather than relying on a setTimeout sleep.
 */
async function waitForUpButtonOpacity(page: Page, opacity: "0" | "1", message?: string): Promise<void> {
	await expect.poll(
		async () => await readOpacity(page, UP_SEL),
		{ timeout: 5_000, message: message ?? `up button must reach opacity=${opacity}` },
	).toBe(opacity);
}

async function waitForUpButtonLabel(page: Page, label: "last" | "previous", message?: string): Promise<void> {
	await expect.poll(
		async () => await readUpLabel(page),
		{ timeout: 5_000, message: message ?? `up button must transition to data-label="${label}"` },
	).toBe(label);
}

test.describe("jump-to-prompt navigation", () => {
	test.beforeAll(async () => {
		await waitForHealth();
	});

	// One long test exercising the full nav state machine end-to-end \u2014 each
	// step builds on the previous state, so splitting into multiple tests
	// would just re-pay the 30 s session + burst setup cost.
	test.setTimeout(180_000);

	test("backward / forward stepping + label transitions + reset rules", async ({ page, rec }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");

		await openTailSession(page, sessionId);
		await disableScrollAnchoring(page);

		// Pre-stream spacer guarantees the transcript scrolls under the
		// viewport even with modest burst output.
		await installPreStreamSpacer(page);
		await rec.capture("Pre-stream spacer installed");

		// --- Send 3 user prompts with intervening burst output, so each
		// older prompt has scrolled fully past the viewport top by the
		// end. Distinct cycle counts let waitForBurstDone match the
		// correct burst on each call.
		await sendBurstPrompt(page, sessionId, 2, "prompt one");
		await sendBurstPrompt(page, sessionId, 3, "prompt two");
		await sendBurstPrompt(page, sessionId, 4, "prompt three");

		// Sanity: three user-messages in the transcript.
		await waitForUserMessageCount(page, 3);
		expect(await userMessageCount(page), "exactly three user prompts sent").toBe(3);

		// After the last burst we're pinned at the bottom. The last
		// user-message sits above the viewport (its burst output occupies
		// the visible area), so the up button must reach opacity=1.
		await waitForUpButtonOpacity(page, "1", "up button must show after three prompts + bursts pinned at bottom");
		await rec.capture("Three prompts sent; up button visible");

		// --- Test 2: label transition (default = "last").
		await waitForUpButtonLabel(page, "last", "initial label must be 'last' before any nav click");

		// Pre-2nd-click: split control does NOT exist yet (depth < 2).
		expect(
			await page.locator(NEXT_SEL).count(),
			"jump-to-next-prompt must not exist before depth>=2",
		).toBe(0);

		// --- Test 1 (a): first up-click walks to last prompt (idx 2).
		const upBtn = page.locator(UP_SEL);
		await upBtn.click();
		await waitForUserMessageAtTop(page, 2);
		await rec.capture("Up click 1: landed on prompt[2]");

		// --- Test 4: jump-to-bottom must REVEAL after the first nav
		// click (spec change vs PR #639).
		await expect.poll(
			async () => await readOpacity(page, BOTTOM_SEL),
			{ timeout: 5_000, message: "jump-to-bottom must reveal after the first prompt-nav click" },
		).toBe("1");

		// --- Test 2 (cont): label transitions to "previous" while older
		// prompts exist.
		await waitForUpButtonLabel(page, "previous", "label must be 'previous' after first up-click (older prompts exist)");

		// At depth 1 (parked on last) the bottom button is still the
		// single (non-split) variant.
		expect(
			await page.locator(NEXT_SEL).count(),
			"depth 1 must still render single jump-to-bottom (no split yet)",
		).toBe(0);

		// --- Test 1 (b) + Test 5: second up-click walks to prompt[1];
		// depth >= 2 -> split control appears.
		await upBtn.click();
		await waitForUserMessageAtTop(page, 1);
		await rec.capture("Up click 2: landed on prompt[1]; split should appear");

		await page.waitForSelector(NEXT_SEL, { timeout: 5_000 });
		await expect.poll(
			async () => await readOpacity(page, NEXT_SEL),
			{ timeout: 5_000, message: "jump-to-next-prompt must reach opacity=1 at depth>=2" },
		).toBe("1");
		await expect.poll(
			async () => await readOpacity(page, BOTTOM_SEL),
			{ timeout: 5_000, message: "jump-to-bottom (split-right) must reach opacity=1 at depth>=2" },
		).toBe("1");
		// Both halves of the split must be present and clickable.
		expect(
			await page.locator(NEXT_SEL).count(),
			"split must render jump-to-next-prompt",
		).toBe(1);
		expect(
			await page.locator(BOTTOM_SEL).count(),
			"split must render jump-to-bottom",
		).toBe(1);

		// --- Test 1 (c): third up-click walks to prompt[0] (the oldest).
		await upBtn.click();
		await waitForUserMessageAtTop(page, 0);
		await rec.capture("Up click 3: landed on prompt[0]");

		// --- Test 3: up button hides when parked on the oldest prompt
		// (no more "previous" to walk to).
		await waitForUpButtonOpacity(page, "0", "up button must hide when parked on the oldest prompt");

		// Split control still shows (we're still navigating, depth = 3).
		await expect.poll(
			async () => await readOpacity(page, NEXT_SEL),
			{ timeout: 5_000, message: "split jump-to-next-prompt remains visible while parked on oldest" },
		).toBe("1");

		// --- Test 6 (a): "Next prompt" walks forward from depth 3 to
		// depth 2; parked moves prompt[0] -> prompt[1].
		await page.locator(NEXT_SEL).click();
		await waitForUserMessageAtTop(page, 1);
		await rec.capture("Next click: parked moved to prompt[1] (depth 2)");

		// Up button reappears with label "previous" (older prompt exists).
		await waitForUpButtonOpacity(page, "1", "up button must reappear after stepping forward from oldest");
		await waitForUpButtonLabel(page, "previous", "label must be 'previous' while still navigating with older prompts");

		// Still at depth 2 -> split present.
		await expect.poll(
			async () => await page.locator(NEXT_SEL).count(),
			{ timeout: 5_000, message: "split must still render at depth 2" },
		).toBe(1);

		// --- Test 6 (b): one more "Next prompt" lands on prompt[2]
		// (depth 1) and the split collapses back to the single bottom
		// button.
		await page.locator(NEXT_SEL).click();
		await waitForUserMessageAtTop(page, 2);
		await rec.capture("Next click: parked moved to prompt[2] (depth 1)");

		await expect.poll(
			async () => await page.locator(NEXT_SEL).count(),
			{ timeout: 5_000, message: "jump-to-next-prompt must be removed when depth collapses to 1" },
		).toBe(0);
		// Single jump-to-bottom is still present and visible.
		await expect.poll(
			async () => await readOpacity(page, BOTTOM_SEL),
			{ timeout: 5_000, message: "single jump-to-bottom still visible at depth 1" },
		).toBe("1");
		// Up button still shows "previous" while older prompts exist.
		await waitForUpButtonLabel(page, "previous", "up button stays 'previous' at depth 1 with older prompts");

		// --- Test 7: walk back to depth >= 2, then click split's bottom
		// half. Must jump to bottom AND clear nav state.
		await upBtn.click();
		await waitForUserMessageAtTop(page, 1);
		await page.waitForSelector(NEXT_SEL, { timeout: 5_000 });
		// Click the bottom half of the split.
		await page.locator(BOTTOM_SEL).click();
		// After landing at bottom: split collapses, nav state cleared,
		// up button is hidden (last prompt is visible) or label resets.
		await expect.poll(
			async () => await page.locator(NEXT_SEL).count(),
			{ timeout: 5_000, message: "split must collapse after clicking split's Bottom" },
		).toBe(0);
		// We should now be at the bottom (or near-bottom). The
		// jump-to-bottom button hides itself once intent + geometry agree.
		await expect.poll(
			async () => await readOpacity(page, BOTTOM_SEL),
			{ timeout: 5_000, message: "jump-to-bottom hides after returning to bottom" },
		).toBe("0");
		// Up button reverts to "last" label (default) or hides because
		// last prompt is now in view. Either is a valid post-bottom state.
		await expect.poll(
			async () => {
				const opacity = await readOpacity(page, UP_SEL);
				const label = await readUpLabel(page);
				return { opacity, label };
			},
			{
				timeout: 5_000,
				message: "after Bottom click: up button hides or resets to 'last'",
			},
		).toEqual({ opacity: expect.stringMatching(/^(0|1)$/), label: "last" });
		await rec.capture("Bottom-half click cleared nav state");

		// --- Test 8: reset on new prompt. First, walk back into split
		// territory (depth >= 2), then send a new prompt.
		await waitForUpButtonOpacity(page, "1", "scroll-to-bottom may have left last prompt off-top; if so up shows");
		// If the up button is hidden because the last prompt is in view,
		// we need to nudge: re-scroll to bottom programmatically just to
		// be sure (the previous click should have done so, but a brand
		// new burst is not arriving so geometry is stable).
		// Walk back to depth 2.
		await upBtn.click();
		await waitForUserMessageAtTop(page, 2);
		await upBtn.click();
		await waitForUserMessageAtTop(page, 1);
		await page.waitForSelector(NEXT_SEL, { timeout: 5_000 });
		await rec.capture("Walked back to depth 2 to test new-prompt reset");

		// Send a new prompt. _viewedPromptIdx clears on user-count growth.
		const userCountBefore = await userMessageCount(page);
		await sendBurstPrompt(page, sessionId, 5, "prompt four");
		await waitForUserMessageCount(page, userCountBefore + 1);

		// Split must collapse (nav state cleared).
		await expect.poll(
			async () => await page.locator(NEXT_SEL).count(),
			{ timeout: 5_000, message: "split must collapse after a new prompt is sent" },
		).toBe(0);
		// Up button is either hidden (last in view) or shows "last".
		await expect.poll(
			async () => await readUpLabel(page),
			{ timeout: 5_000, message: "label must reset to 'last' after new prompt sent" },
		).toBe("last");
		await rec.capture("New prompt sent; nav state reset");

		// --- Test 9: reset on manual scroll past the parked prompt.
		// Park on prompt[2] (depth 2 \u2014 lastUserIdx is now 3).
		await waitForUpButtonOpacity(page, "1", "up button must show with 4 prompts pinned at bottom");
		await upBtn.click();
		await waitForUserMessageAtTop(page, 3);
		await upBtn.click();
		await waitForUserMessageAtTop(page, 2);
		await page.waitForSelector(NEXT_SEL, { timeout: 5_000 });
		await rec.capture("Parked on prompt[2] before manual scroll");

		// Trusted wheel-UP to scroll well past the parked prompt. After
		// the wheel: parked prompt's top is now > 200 px below container
		// top, which triggers the user-gesture reset rule in
		// `_refreshJumpToLastPromptButton({ userGesture: true })`.
		const box = await page.locator(SCROLL_SEL).first().boundingBox();
		if (!box) throw new Error("scroll container has no bounding box");
		await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
		for (let i = 0; i < 6; i++) await page.mouse.wheel(0, -600);

		// Nav state must clear: the split control collapses
		// (`_viewedPromptIdx` is now null, so `_showSplitBottom` is false).
		await expect.poll(
			async () => await page.locator(NEXT_SEL).count(),
			{ timeout: 5_000, message: "split must collapse after user scrolls past parked prompt" },
		).toBe(0);
		// Whenever the up button is rendered, its data-label must be "last"
		// (default) — never "previous" (which would mean stale nav state).
		// The button may be hidden depending on viewport position; we only
		// assert nav-state cleared via the split + label.
		const labelAfterReset = await readUpLabel(page);
		expect(
			labelAfterReset === "last" || labelAfterReset === null,
			`up button label after manual scroll reset must be "last" or hidden, got: ${labelAfterReset}`,
		).toBe(true);
		await rec.capture("Manual scroll cleared nav state");
	});
});
