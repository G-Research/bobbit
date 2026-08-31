/**
 * Unit fixture tests for MessageEditor sending behavior (stories 1-5, 24).
 */
import { test, expect } from "@playwright/test";
import path from "node:path";

const FIXTURE = `file://${path.resolve("tests/message-editor-send.html").replace(/\\/g, "/")}`;

test.describe("Sending messages", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(FIXTURE);
		await page.waitForFunction(() => (window as any)._testReady === true);
		await page.evaluate(() => sessionStorage.clear());
	});

	test("story 1: type hello, press Enter — onSend fires, textarea clears", async ({ page }) => {
		await page.fill("#textarea", "hello");
		await page.click("#textarea");
		await page.keyboard.press("Enter");

		const calls = await page.evaluate(() => (window as any).getSendCalls());
		expect(calls).toHaveLength(1);
		expect(calls[0].text).toBe("hello");
		expect(calls[0].attachments).toHaveLength(0);
		expect(await page.inputValue("#textarea")).toBe("");
	});

	test("story 2: click Send button — onSend fires with correct text", async ({ page }) => {
		await page.fill("#textarea", "send via button");
		await page.click("#send-btn");

		const calls = await page.evaluate(() => (window as any).getSendCalls());
		expect(calls).toHaveLength(1);
		expect(calls[0].text).toBe("send via button");
		expect(await page.inputValue("#textarea")).toBe("");
	});

	test("story 3: Enter with empty textarea — onSend NOT fired", async ({ page }) => {
		await page.click("#textarea");
		await page.keyboard.press("Enter");

		const calls = await page.evaluate(() => (window as any).getSendCalls());
		expect(calls).toHaveLength(0);
	});

	test("story 4: Shift+Enter inserts newline, no send", async ({ page }) => {
		await page.fill("#textarea", "line1");
		await page.click("#textarea");
		await page.keyboard.press("Shift+Enter");

		const calls = await page.evaluate(() => (window as any).getSendCalls());
		expect(calls).toHaveLength(0);

		const val = await page.inputValue("#textarea");
		expect(val).toContain("\n");
	});

	test("story 5: paste image, send — both text and attachments cleared", async ({ page }) => {
		// Type some text
		await page.fill("#textarea", "describe this");

		// Simulate paste with image blob by programmatically creating and dispatching a paste event
		await page.evaluate(() => {
			const textarea = document.getElementById("textarea") as HTMLTextAreaElement;
			// Create a minimal file-like Blob
			const canvas = document.createElement("canvas");
			canvas.width = 10;
			canvas.height = 10;
			canvas.toBlob((blob) => {
				if (!blob) return;
				const file = new File([blob], "test.png", { type: "image/png" });

				// Create a DataTransfer with the file
				const dt = new DataTransfer();
				dt.items.add(file);

				const pasteEvent = new ClipboardEvent("paste", {
					clipboardData: dt,
					bubbles: true,
				});
				textarea.dispatchEvent(pasteEvent);
			}, "image/png");
		});

		// Wait for the FileReader to process and render attachment
		await page.waitForFunction(() => (window as any).getAttachments().length > 0, undefined, { timeout: 5000 });
		await expect(page.locator(".attachment-tile")).toHaveCount(1);

		// Send
		await page.click("#send-btn");

		const calls = await page.evaluate(() => (window as any).getSendCalls());
		expect(calls).toHaveLength(1);
		expect(calls[0].text).toBe("describe this");
		expect(calls[0].attachments).toHaveLength(1);
		expect(calls[0].attachments[0].name).toBe("test.png");

		// Verify cleared
		expect(await page.inputValue("#textarea")).toBe("");
		await expect(page.locator(".attachment-tile")).toHaveCount(0);
		const remainingAttachments = await page.evaluate(() => (window as any).getAttachments());
		expect(remainingAttachments).toHaveLength(0);
	});
});

test.describe("Draft cleared on send (story 24)", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(FIXTURE);
		await page.waitForFunction(() => (window as any)._testReady === true);
		await page.evaluate(() => sessionStorage.clear());
	});

	test("typing saves draft, message-send clears it", async ({ page }) => {
		const draftKey = await page.evaluate(() => (window as any).getDraftKey());

		// Type text and wait for draft debounce to save
		await page.fill("#textarea", "work in progress");
		await page.waitForFunction(
			(key: string) => sessionStorage.getItem(key) === "work in progress",
			draftKey,
		);

		// Send the message (fires message-send event internally)
		await page.click("#send-btn");

		// Verify draft cleared from sessionStorage
		const draft = await page.evaluate((key: string) => sessionStorage.getItem(key), draftKey);
		expect(draft).toBeNull();
	});

	test("draft cleared even when send is via Enter key", async ({ page }) => {
		const draftKey = await page.evaluate(() => (window as any).getDraftKey());

		await page.fill("#textarea", "will be sent");
		await page.waitForFunction(
			(key: string) => sessionStorage.getItem(key) === "will be sent",
			draftKey,
		);

		await page.click("#textarea");
		await page.keyboard.press("Enter");

		const draft = await page.evaluate((key: string) => sessionStorage.getItem(key), draftKey);
		expect(draft).toBeNull();
		expect(await page.inputValue("#textarea")).toBe("");
	});
});
