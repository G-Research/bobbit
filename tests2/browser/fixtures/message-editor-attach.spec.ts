/**
 * Unit fixture tests for MessageEditor attachment handling (PI-06, PI-07, PI-08).
 *
 * PI-06: File attachment via button — click attach, select files, remove, max count/size
 * PI-07: Drag and drop files — dragover indicator, drop files, multiple drop
 * PI-08: Image paste edge cases — oversized image, multiple paste, near-limit paste
 */
import { test, expect } from "@playwright/test";
import path from "node:path";

const FIXTURE = `file://${path.resolve("tests/message-editor-attach.html").replace(/\\/g, "/")}`;

test.describe("PI-06: File attachment via button", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(FIXTURE);
		await page.waitForFunction(() => (window as any)._testReady === true);
	});

	test("click attach button triggers file input click", async ({ page }) => {
		// Listen for click on the hidden file input
		const inputClicked = await page.evaluate(() => {
			return new Promise<boolean>((resolve) => {
				const input = document.getElementById("file-input") as HTMLInputElement;
				input.addEventListener("click", () => resolve(true), { once: true });
				(document.getElementById("attach-btn") as HTMLButtonElement).click();
			});
		});
		expect(inputClicked).toBe(true);
	});

	test("select file via input → attachment tile appears", async ({ page }) => {
		// Use Playwright's setInputFiles to simulate file selection
		const fileInput = page.locator("#file-input");
		await fileInput.setInputFiles({
			name: "photo.png",
			mimeType: "image/png",
			buffer: Buffer.alloc(1024),
		});

		await page.waitForFunction(() => (window as any).getAttachments().length > 0);
		const attachments = await page.evaluate(() => (window as any).getAttachments());
		expect(attachments).toHaveLength(1);
		expect(attachments[0].fileName).toBe("photo.png");
		expect(attachments[0].mimeType).toBe("image/png");

		await expect(page.locator(".attachment-tile")).toHaveCount(1);
		await expect(page.locator(".attachment-tile")).toContainText("photo.png");
	});

	test("select multiple files → multiple tiles appear", async ({ page }) => {
		const fileInput = page.locator("#file-input");
		await fileInput.setInputFiles([
			{ name: "a.png", mimeType: "image/png", buffer: Buffer.alloc(512) },
			{ name: "b.jpg", mimeType: "image/jpeg", buffer: Buffer.alloc(512) },
			{ name: "c.txt", mimeType: "text/plain", buffer: Buffer.from("hello") },
		]);

		await page.waitForFunction(() => (window as any).getAttachments().length === 3);
		await expect(page.locator(".attachment-tile")).toHaveCount(3);
	});

	test("remove attachment via X button", async ({ page }) => {
		const fileInput = page.locator("#file-input");
		await fileInput.setInputFiles([
			{ name: "keep.png", mimeType: "image/png", buffer: Buffer.alloc(256) },
			{ name: "remove.png", mimeType: "image/png", buffer: Buffer.alloc(256) },
		]);

		await page.waitForFunction(() => (window as any).getAttachments().length === 2);
		await expect(page.locator(".attachment-tile")).toHaveCount(2);

		// Click remove button on the second tile
		await page.locator(".attachment-tile:nth-child(2) .remove-btn").click();

		await expect(page.locator(".attachment-tile")).toHaveCount(1);
		const remaining = await page.evaluate(() => (window as any).getAttachments());
		expect(remaining).toHaveLength(1);
		expect(remaining[0].fileName).toBe("keep.png");
	});

	test("max file count enforcement — >10 files rejected with alert", async ({ page }) => {
		// Pre-populate with 8 attachments
		await page.evaluate(() => {
			const existing = Array.from({ length: 8 }, (_, i) => ({
				id: `existing-${i}`,
				type: "image",
				fileName: `img${i}.png`,
				mimeType: "image/png",
				size: 100,
				content: "",
			}));
			(window as any).setAttachments(existing);
		});

		// Try to add 3 more (8 + 3 = 11 > 10)
		const fileInput = page.locator("#file-input");
		await fileInput.setInputFiles([
			{ name: "x1.png", mimeType: "image/png", buffer: Buffer.alloc(64) },
			{ name: "x2.png", mimeType: "image/png", buffer: Buffer.alloc(64) },
			{ name: "x3.png", mimeType: "image/png", buffer: Buffer.alloc(64) },
		]);

		// Wait for the alert to be captured
		await page.waitForFunction(() => (window as any).getAlerts().length > 0);
		const alerts = await page.evaluate(() => (window as any).getAlerts());
		expect(alerts).toContain("Maximum 10 files allowed");

		// Attachments should not have increased
		const count = await page.evaluate(() => (window as any).getAttachments().length);
		expect(count).toBe(8);
	});

	test("max file size enforcement — >20MB rejected with alert", async ({ page }) => {
		// Create a file larger than 20MB (we use a small buffer but override size via evaluate)
		await page.evaluate(() => {
			const MAX_FILE_SIZE = (window as any).MAX_FILE_SIZE;
			// Dispatch a synthetic change event with an oversized file
			const input = document.getElementById("file-input") as HTMLInputElement;
			const oversizedFile = new File([new ArrayBuffer(MAX_FILE_SIZE + 1)], "huge.png", { type: "image/png" });
			const dt = new DataTransfer();
			dt.items.add(oversizedFile);
			(input as any).files = dt.files;
			input.dispatchEvent(new Event("change", { bubbles: true }));
		});

		await page.waitForFunction(() => (window as any).getAlerts().length > 0);
		const alerts = await page.evaluate(() => (window as any).getAlerts());
		expect(alerts.some((a: string) => a.includes("exceeds maximum size of 20MB"))).toBe(true);

		const count = await page.evaluate(() => (window as any).getAttachments().length);
		expect(count).toBe(0);
	});
});

test.describe("PI-07: Drag and drop files", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(FIXTURE);
		await page.waitForFunction(() => (window as any)._testReady === true);
	});

	test("dragover adds isDragging class to container", async ({ page }) => {
		await page.evaluate(() => {
			const container = document.getElementById("editor-container")!;
			const dragOverEvent = new DragEvent("dragover", {
				bubbles: true,
				cancelable: true,
				dataTransfer: new DataTransfer(),
			});
			container.dispatchEvent(dragOverEvent);
		});

		await expect(page.locator("#editor-container")).toHaveClass(/isDragging/);
	});

	test("dragleave outside container removes isDragging class", async ({ page }) => {
		// First trigger dragover
		await page.evaluate(() => {
			const container = document.getElementById("editor-container")!;
			container.dispatchEvent(new DragEvent("dragover", {
				bubbles: true,
				cancelable: true,
				dataTransfer: new DataTransfer(),
			}));
		});
		await expect(page.locator("#editor-container")).toHaveClass(/isDragging/);

		// Simulate dragleave with coordinates outside the container
		await page.evaluate(() => {
			const container = document.getElementById("editor-container")!;
			const rect = container.getBoundingClientRect();
			container.dispatchEvent(new DragEvent("dragleave", {
				bubbles: true,
				cancelable: true,
				clientX: rect.left - 10,
				clientY: rect.top - 10,
				dataTransfer: new DataTransfer(),
			}));
		});

		await expect(page.locator("#editor-container")).not.toHaveClass(/isDragging/);
	});

	test("drop files → attachments added", async ({ page }) => {
		await page.evaluate(() => {
			const container = document.getElementById("editor-container")!;
			const file = new File([new ArrayBuffer(512)], "dropped.png", { type: "image/png" });
			const dt = new DataTransfer();
			dt.items.add(file);
			container.dispatchEvent(new DragEvent("drop", {
				bubbles: true,
				cancelable: true,
				dataTransfer: dt,
			}));
		});

		await page.waitForFunction(() => (window as any).getAttachments().length > 0);
		const attachments = await page.evaluate(() => (window as any).getAttachments());
		expect(attachments).toHaveLength(1);
		expect(attachments[0].fileName).toBe("dropped.png");
		await expect(page.locator(".attachment-tile")).toHaveCount(1);
	});

	test("drop removes isDragging class", async ({ page }) => {
		// Set dragging state first
		await page.evaluate(() => {
			const container = document.getElementById("editor-container")!;
			container.dispatchEvent(new DragEvent("dragover", {
				bubbles: true,
				cancelable: true,
				dataTransfer: new DataTransfer(),
			}));
		});
		await expect(page.locator("#editor-container")).toHaveClass(/isDragging/);

		// Drop with a file
		await page.evaluate(() => {
			const container = document.getElementById("editor-container")!;
			const file = new File([new ArrayBuffer(64)], "f.png", { type: "image/png" });
			const dt = new DataTransfer();
			dt.items.add(file);
			container.dispatchEvent(new DragEvent("drop", {
				bubbles: true,
				cancelable: true,
				dataTransfer: dt,
			}));
		});

		await expect(page.locator("#editor-container")).not.toHaveClass(/isDragging/);
	});

	test("drop multiple files at once", async ({ page }) => {
		await page.evaluate(() => {
			const container = document.getElementById("editor-container")!;
			const dt = new DataTransfer();
			dt.items.add(new File([new ArrayBuffer(128)], "one.png", { type: "image/png" }));
			dt.items.add(new File([new ArrayBuffer(128)], "two.jpg", { type: "image/jpeg" }));
			dt.items.add(new File([new ArrayBuffer(128)], "three.txt", { type: "text/plain" }));
			container.dispatchEvent(new DragEvent("drop", {
				bubbles: true,
				cancelable: true,
				dataTransfer: dt,
			}));
		});

		await page.waitForFunction(() => (window as any).getAttachments().length === 3);
		await expect(page.locator(".attachment-tile")).toHaveCount(3);
	});

	test("drop exceeding max file count → alert", async ({ page }) => {
		// Pre-populate 9 attachments
		await page.evaluate(() => {
			const existing = Array.from({ length: 9 }, (_, i) => ({
				id: `e-${i}`, type: "image", fileName: `e${i}.png`,
				mimeType: "image/png", size: 10, content: "",
			}));
			(window as any).setAttachments(existing);
		});

		// Drop 2 more (9+2=11>10)
		await page.evaluate(() => {
			const container = document.getElementById("editor-container")!;
			const dt = new DataTransfer();
			dt.items.add(new File([new ArrayBuffer(64)], "drop1.png", { type: "image/png" }));
			dt.items.add(new File([new ArrayBuffer(64)], "drop2.png", { type: "image/png" }));
			container.dispatchEvent(new DragEvent("drop", {
				bubbles: true,
				cancelable: true,
				dataTransfer: dt,
			}));
		});

		await page.waitForFunction(() => (window as any).getAlerts().length > 0);
		const alerts = await page.evaluate(() => (window as any).getAlerts());
		expect(alerts).toContain("Maximum 10 files allowed");

		const count = await page.evaluate(() => (window as any).getAttachments().length);
		expect(count).toBe(9);
	});

	test("drop oversized file → alert, valid files still added", async ({ page }) => {
		await page.evaluate(() => {
			const MAX = (window as any).MAX_FILE_SIZE;
			const container = document.getElementById("editor-container")!;
			const dt = new DataTransfer();
			dt.items.add(new File([new ArrayBuffer(MAX + 1)], "toobig.png", { type: "image/png" }));
			dt.items.add(new File([new ArrayBuffer(256)], "ok.png", { type: "image/png" }));
			container.dispatchEvent(new DragEvent("drop", {
				bubbles: true,
				cancelable: true,
				dataTransfer: dt,
			}));
		});

		await page.waitForFunction(() => (window as any).getAttachments().length > 0);
		const alerts = await page.evaluate(() => (window as any).getAlerts());
		expect(alerts.some((a: string) => a.includes("exceeds maximum size"))).toBe(true);

		// Only the valid file should be added
		const attachments = await page.evaluate(() => (window as any).getAttachments());
		expect(attachments).toHaveLength(1);
		expect(attachments[0].fileName).toBe("ok.png");
	});
});

test.describe("PI-08: Image paste edge cases", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(FIXTURE);
		await page.waitForFunction(() => (window as any)._testReady === true);
	});

	test("paste oversized image → alert, no attachment added", async ({ page }) => {
		await page.evaluate(() => {
			const MAX = (window as any).MAX_FILE_SIZE;
			const textarea = document.getElementById("textarea")!;
			const file = new File([new ArrayBuffer(MAX + 1)], "huge.png", { type: "image/png" });
			const dt = new DataTransfer();
			dt.items.add(file);
			textarea.dispatchEvent(new ClipboardEvent("paste", {
				clipboardData: dt,
				bubbles: true,
			}));
		});

		await page.waitForFunction(() => (window as any).getAlerts().length > 0);
		const alerts = await page.evaluate(() => (window as any).getAlerts());
		expect(alerts.some((a: string) => a.includes("exceeds maximum size of 20MB"))).toBe(true);

		const count = await page.evaluate(() => (window as any).getAttachments().length);
		expect(count).toBe(0);
	});

	test("paste multiple images in sequence → all added", async ({ page }) => {
		// Paste first image
		await page.evaluate(() => {
			const textarea = document.getElementById("textarea")!;
			const file = new File([new ArrayBuffer(256)], "img1.png", { type: "image/png" });
			const dt = new DataTransfer();
			dt.items.add(file);
			textarea.dispatchEvent(new ClipboardEvent("paste", {
				clipboardData: dt,
				bubbles: true,
			}));
		});
		await page.waitForFunction(() => (window as any).getAttachments().length === 1);

		// Paste second image
		await page.evaluate(() => {
			const textarea = document.getElementById("textarea")!;
			const file = new File([new ArrayBuffer(256)], "img2.png", { type: "image/png" });
			const dt = new DataTransfer();
			dt.items.add(file);
			textarea.dispatchEvent(new ClipboardEvent("paste", {
				clipboardData: dt,
				bubbles: true,
			}));
		});
		await page.waitForFunction(() => (window as any).getAttachments().length === 2);

		// Paste third image
		await page.evaluate(() => {
			const textarea = document.getElementById("textarea")!;
			const file = new File([new ArrayBuffer(256)], "img3.png", { type: "image/png" });
			const dt = new DataTransfer();
			dt.items.add(file);
			textarea.dispatchEvent(new ClipboardEvent("paste", {
				clipboardData: dt,
				bubbles: true,
			}));
		});
		await page.waitForFunction(() => (window as any).getAttachments().length === 3);

		const attachments = await page.evaluate(() => (window as any).getAttachments());
		expect(attachments).toHaveLength(3);
		expect(attachments.map((a: any) => a.fileName)).toEqual(["img1.png", "img2.png", "img3.png"]);
	});

	test("paste when at max file limit → alert", async ({ page }) => {
		// Pre-populate with exactly 10 attachments
		await page.evaluate(() => {
			const existing = Array.from({ length: 10 }, (_, i) => ({
				id: `fill-${i}`, type: "image", fileName: `fill${i}.png`,
				mimeType: "image/png", size: 10, content: "",
			}));
			(window as any).setAttachments(existing);
		});

		// Paste one more image
		await page.evaluate(() => {
			const textarea = document.getElementById("textarea")!;
			const file = new File([new ArrayBuffer(128)], "overflow.png", { type: "image/png" });
			const dt = new DataTransfer();
			dt.items.add(file);
			textarea.dispatchEvent(new ClipboardEvent("paste", {
				clipboardData: dt,
				bubbles: true,
			}));
		});

		await page.waitForFunction(() => (window as any).getAlerts().length > 0);
		const alerts = await page.evaluate(() => (window as any).getAlerts());
		expect(alerts).toContain("Maximum 10 files allowed");

		const count = await page.evaluate(() => (window as any).getAttachments().length);
		expect(count).toBe(10);
	});

	test("paste non-image content does not add attachment", async ({ page }) => {
		await page.evaluate(() => {
			const textarea = document.getElementById("textarea")!;
			const dt = new DataTransfer();
			dt.items.add("plain text content", "text/plain");
			textarea.dispatchEvent(new ClipboardEvent("paste", {
				clipboardData: dt,
				bubbles: true,
			}));
		});

		// Small delay to ensure no async handler fires
		await page.waitForTimeout(200);
		const count = await page.evaluate(() => (window as any).getAttachments().length);
		expect(count).toBe(0);
		const alerts = await page.evaluate(() => (window as any).getAlerts());
		expect(alerts).toHaveLength(0);
	});

	test("paste near limit — room for 1, paste 1 → accepted", async ({ page }) => {
		// Pre-populate with 9 attachments (room for 1 more)
		await page.evaluate(() => {
			const existing = Array.from({ length: 9 }, (_, i) => ({
				id: `pre-${i}`, type: "image", fileName: `pre${i}.png`,
				mimeType: "image/png", size: 10, content: "",
			}));
			(window as any).setAttachments(existing);
		});

		// Paste 1 image — should succeed (9+1=10)
		await page.evaluate(() => {
			const textarea = document.getElementById("textarea")!;
			const file = new File([new ArrayBuffer(128)], "last.png", { type: "image/png" });
			const dt = new DataTransfer();
			dt.items.add(file);
			textarea.dispatchEvent(new ClipboardEvent("paste", {
				clipboardData: dt,
				bubbles: true,
			}));
		});

		await page.waitForFunction(() => (window as any).getAttachments().length === 10);
		const alerts = await page.evaluate(() => (window as any).getAlerts());
		expect(alerts).toHaveLength(0);
	});
});
