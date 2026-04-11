/**
 * Unit fixture tests for abort/stop streaming (PI-21) and textarea focus management (PI-24).
 */
import { test, expect } from "@playwright/test";
import path from "node:path";

const FIXTURE = `file://${path.resolve("tests/abort-and-focus.html").replace(/\\/g, "/")}`;

test.describe("PI-21: Abort/Stop streaming", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(FIXTURE);
		await page.waitForFunction(() => (window as any)._testReady === true);
	});

	test("stop button hidden when not streaming", async ({ page }) => {
		const visible = await page.evaluate(() => (window as any).isAbortVisible());
		expect(visible).toBe(false);
	});

	test("stop button visible when isStreaming=true", async ({ page }) => {
		await page.evaluate(() => (window as any).setStreaming(true));
		const visible = await page.evaluate(() => (window as any).isAbortVisible());
		expect(visible).toBe(true);
	});

	test("stop button hides again when streaming ends", async ({ page }) => {
		await page.evaluate(() => (window as any).setStreaming(true));
		expect(await page.evaluate(() => (window as any).isAbortVisible())).toBe(true);

		await page.evaluate(() => (window as any).setStreaming(false));
		expect(await page.evaluate(() => (window as any).isAbortVisible())).toBe(false);
	});

	test("click stop button fires onAbort callback", async ({ page }) => {
		await page.evaluate(() => (window as any).setStreaming(true));
		await page.click("#abort-btn");

		const calls = await page.evaluate(() => (window as any).getAbortCalls());
		expect(calls).toBe(1);
	});

	test("multiple clicks on stop button fire multiple onAbort calls", async ({ page }) => {
		await page.evaluate(() => (window as any).setStreaming(true));
		await page.click("#abort-btn");
		await page.click("#abort-btn");
		await page.click("#abort-btn");

		const calls = await page.evaluate(() => (window as any).getAbortCalls());
		expect(calls).toBe(3);
	});

	test("Escape key triggers abort when streaming", async ({ page }) => {
		await page.evaluate(() => (window as any).setStreaming(true));
		await page.click("#textarea");
		await page.keyboard.press("Escape");

		const calls = await page.evaluate(() => (window as any).getAbortCalls());
		expect(calls).toBe(1);
	});

	test("Escape key does NOT trigger abort when not streaming", async ({ page }) => {
		await page.click("#textarea");
		await page.keyboard.press("Escape");

		const calls = await page.evaluate(() => (window as any).getAbortCalls());
		expect(calls).toBe(0);
	});

	test("send button always visible regardless of streaming state", async ({ page }) => {
		expect(await page.evaluate(() => (window as any).isSendVisible())).toBe(true);

		await page.evaluate(() => (window as any).setStreaming(true));
		expect(await page.evaluate(() => (window as any).isSendVisible())).toBe(true);

		await page.evaluate(() => (window as any).setStreaming(false));
		expect(await page.evaluate(() => (window as any).isSendVisible())).toBe(true);
	});

	test("send button disabled when textarea empty", async ({ page }) => {
		const disabled = await page.evaluate(() =>
			(document.getElementById("send-btn") as HTMLButtonElement).disabled,
		);
		expect(disabled).toBe(true);
	});

	test("send button enabled when textarea has content", async ({ page }) => {
		await page.fill("#textarea", "hello");
		const disabled = await page.evaluate(() =>
			(document.getElementById("send-btn") as HTMLButtonElement).disabled,
		);
		expect(disabled).toBe(false);
	});

	test("during streaming: send still works with content (queues/steers)", async ({ page }) => {
		await page.evaluate(() => (window as any).setStreaming(true));
		await page.fill("#textarea", "steer message");
		await page.click("#send-btn");

		const calls = await page.evaluate(() => (window as any).getSendCalls());
		expect(calls).toHaveLength(1);
		expect(calls[0].text).toBe("steer message");
	});

	test("abort button present alongside send during streaming", async ({ page }) => {
		await page.evaluate(() => (window as any).setStreaming(true));

		const abortVisible = await page.evaluate(() => (window as any).isAbortVisible());
		const sendVisible = await page.evaluate(() => (window as any).isSendVisible());
		expect(abortVisible).toBe(true);
		expect(sendVisible).toBe(true);
	});
});

test.describe("PI-24: Textarea focus management", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(FIXTURE);
		await page.waitForFunction(() => (window as any)._testReady === true);
	});

	test("textarea auto-focuses on page load (simulates firstUpdated)", async ({ page }) => {
		const activeId = await page.evaluate(() => (window as any).getActiveElement());
		expect(activeId).toBe("textarea");
	});

	test("focus returns to textarea after successful send", async ({ page }) => {
		await page.fill("#textarea", "test message");
		await page.click("#send-btn");

		// Textarea should be cleared
		expect(await page.inputValue("#textarea")).toBe("");

		// Focus should be back on textarea
		const activeId = await page.evaluate(() => (window as any).getActiveElement());
		expect(activeId).toBe("textarea");
	});

	test("focus returns to textarea after Enter-key send", async ({ page }) => {
		await page.fill("#textarea", "enter send");
		await page.click("#textarea");
		await page.keyboard.press("Enter");

		expect(await page.inputValue("#textarea")).toBe("");
		const activeId = await page.evaluate(() => (window as any).getActiveElement());
		expect(activeId).toBe("textarea");
	});

	test("typing in textarea maintains focus", async ({ page }) => {
		await page.click("#textarea");
		await page.keyboard.type("hello world");

		const activeId = await page.evaluate(() => (window as any).getActiveElement());
		expect(activeId).toBe("textarea");
		expect(await page.inputValue("#textarea")).toBe("hello world");
	});

	test("focus remains on textarea after multiple sends", async ({ page }) => {
		for (const msg of ["first", "second", "third"]) {
			await page.fill("#textarea", msg);
			await page.click("#send-btn");
		}

		const calls = await page.evaluate(() => (window as any).getSendCalls());
		expect(calls).toHaveLength(3);

		const activeId = await page.evaluate(() => (window as any).getActiveElement());
		expect(activeId).toBe("textarea");
		expect(await page.inputValue("#textarea")).toBe("");
	});

	test("textarea focused after page reload", async ({ page }) => {
		await page.reload();
		await page.waitForFunction(() => (window as any)._testReady === true);

		const activeId = await page.evaluate(() => (window as any).getActiveElement());
		expect(activeId).toBe("textarea");
	});
});
