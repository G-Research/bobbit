/**
 * S3 — IME composition guard on Enter-to-send (real <message-editor>).
 *
 * While composing CJK/dead-key text, the Enter that COMMITS the candidate must
 * not send. WebKit reports isComposing===true; Chromium/Firefox report
 * keyCode 229. RED on master (handleKeyDown sent on any non-shift Enter).
 * Bundles the REAL component (not the vanilla replica in message-editor-send.html).
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

test.describe("MessageEditor IME guard (S3)", () => {
	test("Enter while composing (isComposing:true) does NOT send", async ({ page }) => {
		await ready(page);
		const calls = await page.evaluate(async () => {
			const w = window as any;
			w.__resetSendCalls();
			const el = w.__mountEditor(document.getElementById("container"));
			await el.updateComplete;
			w.__setValue(el, "にほんご");
			w.__pressEnter(el, { isComposing: true });
			return w.__getSendCalls();
		});
		expect(calls).toHaveLength(0);
	});

	test("Enter with keyCode 229 (Chromium/Firefox composing) does NOT send", async ({ page }) => {
		await ready(page);
		const calls = await page.evaluate(async () => {
			const w = window as any;
			w.__resetSendCalls();
			const el = w.__mountEditor(document.getElementById("container"));
			await el.updateComplete;
			w.__setValue(el, "中文");
			w.__pressEnter(el, { keyCode: 229 });
			return w.__getSendCalls();
		});
		expect(calls).toHaveLength(0);
	});

	test("plain Enter (not composing) DOES send — guard doesn't break normal send", async ({ page }) => {
		await ready(page);
		const calls = await page.evaluate(async () => {
			const w = window as any;
			w.__resetSendCalls();
			const el = w.__mountEditor(document.getElementById("container"));
			await el.updateComplete;
			w.__setValue(el, "hello");
			w.__pressEnter(el, { isComposing: false });
			return w.__getSendCalls();
		});
		expect(calls).toHaveLength(1);
		expect(calls[0].text).toBe("hello");
	});
});
