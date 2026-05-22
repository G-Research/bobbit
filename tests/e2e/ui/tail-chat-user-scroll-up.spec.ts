/** Full-stack user-intent release + jump-to-bottom recovery during a live stream. */
import { test, expect } from "./fixtures.js";
import { waitForHealth, waitForSessionStatus, createSession } from "../e2e-setup.js";
import { sendMessage } from "./ui-helpers.js";
import {
	SCROLL_SEL,
	TAIL_PX,
	disableScrollAnchoring,
	expectLatestMessagePinned,
	installPreStreamSpacer,
	openTailSession,
	settleFrames,
	waitForBurstDone,
} from "./tail-chat-helpers.js";

test.describe("tail-chat: user wheel-up release + recovery", () => {
	test.beforeAll(async () => {
		await waitForHealth();
	});

	test.setTimeout(75_000);

	test("trusted wheel-up unsticks; jump-to-bottom click recovers + tracks", async ({ page, rec }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");

		await openTailSession(page, sessionId);
		await disableScrollAnchoring(page);
		await installPreStreamSpacer(page);
		await rec.capture("Pre-stream spacer ready, at bottom");

		await sendMessage(page, "STREAM_BURST:3 keep streaming while I scroll");
		await page.waitForFunction(() => document.querySelectorAll("assistant-message, tool-message").length > 0, null, { timeout: 30_000 });
		await rec.capture("STREAM_BURST:3 active");

		const box = await page.locator(SCROLL_SEL).first().boundingBox();
		if (!box) throw new Error("scroll container has no bounding box");
		await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
		for (let i = 0; i < 5; i++) await page.mouse.wheel(0, -800);
		await page.waitForFunction(
			(sel) => {
				const el = document.querySelector(sel) as HTMLElement | null;
				return !!el && el.scrollHeight - el.scrollTop - el.clientHeight > el.clientHeight * 0.4;
			},
			SCROLL_SEL,
			{ timeout: 5_000 },
		).catch(async () => {
			for (let i = 0; i < 5; i++) await page.mouse.wheel(0, -1200);
		});

		const afterWheel = await page.evaluate((sel) => {
			const el = document.querySelector(sel) as HTMLElement;
			return {
				scrollTop: el.scrollTop,
				scrollHeight: el.scrollHeight,
				clientHeight: el.clientHeight,
				distFromBottom: el.scrollHeight - el.scrollTop - el.clientHeight,
			};
		}, SCROLL_SEL);
		expect(afterWheel.distFromBottom, "trusted wheel-up must move viewport off bottom")
			.toBeGreaterThan(afterWheel.clientHeight * 0.4);

		const jumpBtn = page.locator('[data-testid="jump-to-bottom"]');
		await expect(jumpBtn).toBeVisible();
		await expect.poll(
			async () => await jumpBtn.evaluate((el: HTMLElement) => el.style.opacity),
			{ timeout: 5_000, message: "jump-to-bottom button must reach opacity=1 after wheel-up" },
		).toBe("1");
		await rec.capture("Wheel-up released stickiness; jump button visible");

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
				clientHeight: el.clientHeight,
				distFromBottom: el.scrollHeight - el.scrollTop - el.clientHeight,
			};
		}, SCROLL_SEL);
		expect(
			duringStream.distFromBottom,
			`stream after wheel-up pulled viewport toward bottom; before=${afterWheel.scrollTop} after=${duringStream.scrollTop}`,
		).toBeGreaterThan(duringStream.clientHeight * 0.4);

		await jumpBtn.click();
		await settleFrames(page);
		await rec.capture("Clicked jump-to-bottom");

		await waitForBurstDone(page, 3, 60_000);
		await waitForSessionStatus(sessionId, "idle");
		await settleFrames(page);
		await expectLatestMessagePinned(page, { tailPx: TAIL_PX, label: "after-recovery" });
		await expect.poll(
			async () => await jumpBtn.evaluate((el: HTMLElement) => el.style.opacity),
			{ timeout: 5_000, message: "jump-to-bottom button must hide again after recovery" },
		).toBe("0");
	});
});
