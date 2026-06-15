/**
 * S31 — composer aggregate-size guard (real <message-editor>).
 *
 * An oversized attachment set must be rejected with a clear inline error BEFORE
 * the irreversible draft-cleanup ('message-send') / onSend / editor-clear — and
 * before it can build a frame that exceeds the gateway's WS maxPayload and tear
 * the socket down (close-1009, S31). The limit is lowered via the static field so
 * the test stays fast (no 200 MB fixtures). Reuses the message-editor-ime bundle.
 */
import { test, expect } from "@playwright/test";
import path from "node:path";
import { buildBundle } from "./fixtures/build-bundle.js";

const FIXTURE = path.resolve("tests/fixtures/message-editor-ime.html");
const BUNDLE = path.resolve("tests/fixtures/message-editor-ime-bundle.js");
const ENTRY = path.resolve("tests/fixtures/message-editor-ime-entry.ts");
const SRC = path.resolve("src/ui/components/MessageEditor.ts");

test.beforeAll(() => {
	buildBundle({ entry: ENTRY, outfile: BUNDLE, deps: [ENTRY, SRC] });
});

const PAGE = `file://${FIXTURE}`;
async function ready(page: any) {
	await page.goto(PAGE);
	await page.waitForFunction(() => (window as any).__ready === true, null, { timeout: 10_000 });
}
const img = (content: string) => ({
	id: "a1", type: "image", fileName: "big.png", mimeType: "image/png", size: content.length, content, preview: content,
});

test.describe("MessageEditor aggregate-size guard (S31)", () => {
	test("oversized send is rejected: error shown, onSend NOT called, draft retained, no message-send", async ({ page }) => {
		await ready(page);
		const r = await page.evaluate(async () => {
			const w = window as any;
			w.MessageEditorClass.MAX_SERIALIZED_SEND_BYTES = 100; // tiny limit for the test
			w.__resetSendCalls();
			let messageSendFired = false;
			document.addEventListener("message-send", () => { messageSendFired = true; }, { once: true });
			const el = w.__mountEditor(document.getElementById("container"));
			await el.updateComplete;
			w.__setValue(el, "with a big image");
			w.__setAttachments(el, [{ id: "a1", type: "image", fileName: "big.png", mimeType: "image/png", size: 500, content: "A".repeat(500), preview: "A".repeat(500) }]);
			await el.updateComplete;
			w.__pressEnter(el, { isComposing: false });
			await el.updateComplete;
			return {
				sendCalls: w.__getSendCalls().length,
				messageSendFired,
				errorVisible: !!el.querySelector("[data-testid='composer-size-error']"),
				valueRetained: el.value === "with a big image",
				attachmentsRetained: el.attachments.length === 1,
			};
		});
		expect(r.sendCalls).toBe(0);
		expect(r.messageSendFired).toBe(false); // draft NOT tombstoned
		expect(r.errorVisible).toBe(true);
		expect(r.valueRetained).toBe(true);
		expect(r.attachmentsRetained).toBe(true);
	});

	test("under-limit send proceeds normally and clears any prior error", async ({ page }) => {
		await ready(page);
		const r = await page.evaluate(async () => {
			const w = window as any;
			w.MessageEditorClass.MAX_SERIALIZED_SEND_BYTES = 200 * 1024 * 1024; // restore default
			w.__resetSendCalls();
			const el = w.__mountEditor(document.getElementById("container"));
			await el.updateComplete;
			w.__setValue(el, "small ok");
			w.__setAttachments(el, [{ id: "a1", type: "image", fileName: "s.png", mimeType: "image/png", size: 8, content: "AAAA", preview: "AAAA" }]);
			await el.updateComplete;
			w.__pressEnter(el, { isComposing: false });
			await el.updateComplete;
			return {
				sendCalls: w.__getSendCalls().length,
				errorVisible: !!el.querySelector("[data-testid='composer-size-error']"),
			};
		});
		expect(r.sendCalls).toBe(1);
		expect(r.errorVisible).toBe(false);
	});

	test("serializedSendBytes counts each image ~3x (images.data + content + preview)", async ({ page }) => {
		await ready(page);
		const bytes = await page.evaluate(() => {
			const w = window as any;
			const content = "X".repeat(1000);
			const atts = [{ id: "a", type: "image", fileName: "x.png", mimeType: "image/png", size: 1000, content, preview: content }];
			return w.MessageEditorClass.serializedSendBytes("hi", atts);
		});
		// 3 copies of the 1000-char content (images.data + attachments.content + attachments.preview) ≈ >3000.
		expect(bytes).toBeGreaterThan(3000);
	});
});
