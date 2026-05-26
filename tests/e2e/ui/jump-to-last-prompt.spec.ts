/**
 * E2E: floating "Jump to last prompt" button.
 *
 * Mirrors the structure of `tail-chat-user-scroll-up.spec.ts`. Covers the
 * full lifecycle of the new button:
 *
 *   1. Hidden initially (no <user-message> nodes).
 *   2. Hidden when the last user-message is in view.
 *   3. Shown after the pre-stream spacer + burst output pushes the last
 *      <user-message> fully above the viewport top (we never need to
 *      wheel-up — the spacer above the transcript provides plenty of
 *      scroll runway; while pinned at the bottom, the user prompt is
 *      naturally off-screen above).
 *   4. Click springs the last <user-message> to ~16 px below the viewport
 *      top and re-hides the button.
 *   5. From a state where the button is visible (re-scrolled to bottom
 *      programmatically), sending a new prompt re-pins to the bottom on
 *      the new <user-message> and re-hides the button.
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

const JUMP_SEL = '[data-testid="jump-to-last-prompt"]';

async function readJumpOpacity(page: Page): Promise<string> {
	return await page.locator(JUMP_SEL).evaluate((el: HTMLElement) => el.style.opacity);
}

/**
 * Predicate: last <user-message> bottom edge strictly above container top
 * (matches the production geometry rule in
 * `_refreshJumpToLastPromptButton`).
 */
async function waitForLastPromptOffTop(page: Page, timeout = 10_000): Promise<void> {
	await page.waitForFunction((sel) => {
		const el = document.querySelector(sel) as HTMLElement | null;
		if (!el) return false;
		const users = document.querySelectorAll("user-message");
		if (users.length === 0) return false;
		const last = users[users.length - 1] as HTMLElement;
		const elRect = el.getBoundingClientRect();
		const lastRect = last.getBoundingClientRect();
		return lastRect.bottom < elRect.top - 1;
	}, SCROLL_SEL, { timeout });
}

test.describe("jump-to-last-prompt button", () => {
	test.beforeAll(async () => {
		await waitForHealth();
	});

	test.setTimeout(75_000);

	test("lifecycle: hidden empty → hidden in-view → shown after burst → click hides → new prompt hides", async ({ page, rec }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");

		await openTailSession(page, sessionId);
		await disableScrollAnchoring(page);
		await rec.capture("Empty session opened");

		// --- Case 1: hidden initially (no user-message nodes) ---
		await settleFrames(page);
		expect(await readJumpOpacity(page), "button hidden when transcript is empty").toBe("0");

		// --- Case 2: hidden when last user-message is in view ---
		await sendMessage(page, "hi");
		await waitForSessionStatus(sessionId, "idle");
		await settleFrames(page);
		const inViewGeom = await page.evaluate((sel) => {
			const el = document.querySelector(sel) as HTMLElement | null;
			if (!el) return { error: "no scroll container" } as const;
			const users = Array.from(document.querySelectorAll("user-message")) as HTMLElement[];
			if (users.length === 0) return { error: "no user-message" } as const;
			const elRect = el.getBoundingClientRect();
			const lastRect = users[users.length - 1].getBoundingClientRect();
			return {
				userCount: users.length,
				containerTop: elRect.top,
				lastBottom: lastRect.bottom,
			} as const;
		}, SCROLL_SEL);
		if ("error" in inViewGeom) throw new Error(inViewGeom.error);
		expect(inViewGeom.userCount, "one user-message after sending 'hi'").toBeGreaterThanOrEqual(1);
		// Sanity: last user-message must NOT have its bottom above the container top.
		expect(
			inViewGeom.lastBottom,
			"last user-message must be visible (bottom at/below container top)",
		).toBeGreaterThanOrEqual(inViewGeom.containerTop - 1);
		expect(await readJumpOpacity(page), "button hidden while last prompt is in view").toBe("0");
		await rec.capture("Short message sent, button still hidden");

		// --- Case 3: shown after a tall pre-stream spacer + burst output
		// pushes the last <user-message> fully above the viewport top while
		// the transcript is pinned at the bottom. No wheel-up needed: the
		// 5000 px spacer that `installPreStreamSpacer` inserts above the
		// transcript guarantees the scrollHeight far exceeds clientHeight
		// even before the burst grows. While pinned at bottom, all upstream
		// content (including the STREAM_BURST prompt) sits above the
		// viewport top.
		await installPreStreamSpacer(page);

		await sendMessage(page, "STREAM_BURST:3 keep streaming");
		await page.waitForFunction(
			() => document.querySelectorAll("assistant-message, tool-message").length > 0,
			null,
			{ timeout: 30_000 },
		);

		// Let the burst run to completion so case 4's click isn't fighting
		// an in-flight RO-driven tail-pin.
		await waitForBurstDone(page, 3, 60_000);
		await waitForSessionStatus(sessionId, "idle", 60_000);
		await settleFrames(page, 2);

		await waitForLastPromptOffTop(page);

		const jumpBtn = page.locator(JUMP_SEL);
		await expect.poll(
			async () => await readJumpOpacity(page),
			{ timeout: 5_000, message: "jump-to-last-prompt must reach opacity=1 once last prompt scrolls off the top" },
		).toBe("1");
		await rec.capture("Last prompt off-screen; jump-to-last-prompt visible");

		// --- Case 4: click scrolls last <user-message> to top and re-hides ---
		await jumpBtn.click();
		// Spring animation can take ~30 frames at default damping/stiffness;
		// poll for landing rather than fixed sleep so we don't flake on
		// slow CI runners. Production scrolls so the last prompt sits
		// TOP_MARGIN (16 px) below the container top; ±32 px tolerance per
		// the design doc.
		await page.waitForFunction((sel) => {
			const el = document.querySelector(sel) as HTMLElement | null;
			if (!el) return false;
			const users = document.querySelectorAll("user-message");
			if (users.length === 0) return false;
			const last = users[users.length - 1] as HTMLElement;
			const elRect = el.getBoundingClientRect();
			const lastRect = last.getBoundingClientRect();
			const offset = lastRect.top - elRect.top;
			return Math.abs(offset - 16) <= 32;
		}, SCROLL_SEL, { timeout: 10_000 });
		await settleFrames(page, 3);
		await rec.capture("Clicked jump-to-last-prompt; spring landed at top");

		await expect.poll(
			async () => await readJumpOpacity(page),
			{ timeout: 5_000, message: "button must re-hide after the click brings the last prompt back into view" },
		).toBe("0");

		// --- Case 5: re-scroll to bottom programmatically (button visible
		// again), then send a new prompt. The new <user-message> becomes
		// the last one and sits at the bottom — button must hide.
		await page.evaluate((sel) => {
			const el = document.querySelector(sel) as HTMLElement;
			el.scrollTop = el.scrollHeight;
		}, SCROLL_SEL);
		await waitForLastPromptOffTop(page);
		await expect.poll(
			async () => await readJumpOpacity(page),
			{ timeout: 5_000, message: "button should re-show after programmatic scroll-to-bottom" },
		).toBe("1");
		await rec.capture("Re-scrolled to bottom; button visible again pre-new-prompt");

		await sendMessage(page, "another");
		// New <user-message> appended at the bottom of the transcript and
		// `_updateAndPin()` recomputes `_refreshJumpToLastPromptButton` after
		// Lit commits. The button must hide within ~5 seconds (the new last
		// prompt is fully visible at the bottom).
		await expect.poll(
			async () => await readJumpOpacity(page),
			{ timeout: 5_000, message: "button must hide after sending a new prompt (new last user-message is at the bottom)" },
		).toBe("0");
		await rec.capture("New prompt sent; button hidden");
	});
});
