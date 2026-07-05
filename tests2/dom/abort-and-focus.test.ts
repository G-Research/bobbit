import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/abort-and-focus.spec.ts (v2-dom tier).
// The legacy file:// fixture was a PLAIN-JS MIRROR of the composer. Per the
// migration guide this port renders the REAL <message-editor> lit component
// (light DOM). Abort/streaming + send-enable + auto-focus are the component's
// own behaviour. The clear-and-refocus-after-send behaviour lives in the
// CONSUMER (session-manager: `editor.value = ""` + `_focusPromptEditor()` on
// send — see src/app/session-manager.ts), so the test's `onSend` reproduces
// exactly that documented consumer glue and asserts the same end-to-end
// user-visible facts the mirror did.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "../../src/ui/components/MessageEditor.js";

let abortCalls: number;
let sendCalls: Array<{ text: string }>;

async function mount(streaming = false): Promise<any> {
	const el = document.createElement("message-editor") as any;
	el.isStreaming = streaming;
	el.onAbort = () => { abortCalls++; };
	// Mirror the real consumer (session-manager) send glue: clear the composer
	// and refocus the textarea after a send.
	el.onSend = (text: string) => {
		sendCalls.push({ text });
		el.value = "";
		const ta = el.querySelector("textarea") as HTMLTextAreaElement | null;
		if (ta) ta.focus();
	};
	document.body.appendChild(el);
	await el.updateComplete;
	return el;
}

const textarea = (el: any) => el.querySelector("textarea") as HTMLTextAreaElement;
const sendBtn = (el: any) => el.querySelector('button[title="Send message"]') as HTMLButtonElement;
const abortBtn = (el: any) => el.querySelector('button[title="Stop streaming"]') as HTMLButtonElement | null;

async function typeInto(el: any, text: string) {
	const ta = textarea(el);
	ta.value = text;
	ta.dispatchEvent(new Event("input", { bubbles: true }));
	await el.updateComplete;
}

async function setStreaming(el: any, val: boolean) {
	el.isStreaming = val;
	await el.updateComplete;
}

beforeEach(() => {
	abortCalls = 0;
	sendCalls = [];
});
afterEach(() => { document.body.innerHTML = ""; });

describe("PI-21: Abort/Stop streaming", () => {
	it("stop button hidden when not streaming", async () => {
		const el = await mount();
		expect(abortBtn(el)).toBeNull();
	});

	it("stop button visible when isStreaming=true", async () => {
		const el = await mount(true);
		expect(abortBtn(el)).toBeTruthy();
	});

	it("stop button hides again when streaming ends", async () => {
		const el = await mount(true);
		expect(abortBtn(el)).toBeTruthy();
		await setStreaming(el, false);
		expect(abortBtn(el)).toBeNull();
	});

	it("click stop button fires onAbort callback", async () => {
		const el = await mount(true);
		abortBtn(el)!.click();
		expect(abortCalls).toBe(1);
	});

	it("multiple clicks on stop button fire multiple onAbort calls", async () => {
		const el = await mount(true);
		abortBtn(el)!.click();
		abortBtn(el)!.click();
		abortBtn(el)!.click();
		expect(abortCalls).toBe(3);
	});

	it("Escape key triggers abort when streaming", async () => {
		const el = await mount(true);
		const ta = textarea(el);
		ta.focus();
		ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		expect(abortCalls).toBe(1);
	});

	it("Escape key does NOT trigger abort when not streaming", async () => {
		const el = await mount(false);
		const ta = textarea(el);
		ta.focus();
		ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		expect(abortCalls).toBe(0);
	});

	it("send button always present regardless of streaming state", async () => {
		const el = await mount(false);
		expect(sendBtn(el)).toBeTruthy();
		await setStreaming(el, true);
		expect(sendBtn(el)).toBeTruthy();
		await setStreaming(el, false);
		expect(sendBtn(el)).toBeTruthy();
	});

	it("send button disabled when textarea empty", async () => {
		const el = await mount();
		expect(sendBtn(el).disabled).toBe(true);
	});

	it("send button enabled when textarea has content", async () => {
		const el = await mount();
		await typeInto(el, "hello");
		expect(sendBtn(el).disabled).toBe(false);
	});

	it("during streaming: send still works with content (queues/steers)", async () => {
		const el = await mount(true);
		await typeInto(el, "steer message");
		sendBtn(el).click();
		expect(sendCalls).toHaveLength(1);
		expect(sendCalls[0].text).toBe("steer message");
	});

	it("abort button present alongside send during streaming", async () => {
		const el = await mount(true);
		expect(abortBtn(el)).toBeTruthy();
		expect(sendBtn(el)).toBeTruthy();
	});
});

describe("PI-24: Textarea focus management", () => {
	it("textarea auto-focuses on mount (firstUpdated)", async () => {
		const el = await mount();
		expect(document.activeElement).toBe(textarea(el));
	});

	it("focus returns to textarea after successful send", async () => {
		const el = await mount();
		await typeInto(el, "test message");
		sendBtn(el).click();
		await el.updateComplete;
		expect(textarea(el).value).toBe("");
		expect(document.activeElement).toBe(textarea(el));
	});

	it("focus returns to textarea after Enter-key send", async () => {
		const el = await mount();
		await typeInto(el, "enter send");
		const ta = textarea(el);
		ta.focus();
		ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		await el.updateComplete;
		expect(textarea(el).value).toBe("");
		expect(document.activeElement).toBe(textarea(el));
	});

	it("typing in textarea maintains focus", async () => {
		const el = await mount();
		const ta = textarea(el);
		ta.focus();
		await typeInto(el, "hello world");
		expect(document.activeElement).toBe(textarea(el));
		expect(textarea(el).value).toBe("hello world");
	});

	it("focus remains on textarea after multiple sends", async () => {
		const el = await mount();
		for (const msg of ["first", "second", "third"]) {
			await typeInto(el, msg);
			sendBtn(el).click();
			await el.updateComplete;
		}
		expect(sendCalls).toHaveLength(3);
		expect(document.activeElement).toBe(textarea(el));
		expect(textarea(el).value).toBe("");
	});

	it("textarea focused after re-mount (page reload)", async () => {
		await mount();
		document.body.innerHTML = "";
		const el2 = await mount();
		expect(document.activeElement).toBe(textarea(el2));
	});
});
