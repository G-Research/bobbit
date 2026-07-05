import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/suggest-goal.spec.ts (v2-dom tier).
// The legacy fixture tested a plain-JS mirror of the <suggest_goal/> detection/
// stripping regex plus a synthetic button. This port renders the REAL
// <assistant-message> lit component (src/ui/components/Messages.ts) under
// happy-dom — strictly higher fidelity: the same regex + the real "+ Create Goal"
// button + the real bubbling/composed `suggest-goal` CustomEvent.
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { syncCustomElements } from "./_setup/custom-elements.js";

// Ordered dynamic import (session-manager first to prime the pack-panels ⇄
// session-manager cycle before Messages.js's app/* imports hit it as a TDZ
// error), then the lazy markdown chunk, then re-sync so every @customElement
// define is replayed into this window + lit-html's pinned window.
beforeAll(async () => {
	await import("../../src/app/session-manager.js");
	await import("../../src/ui/components/Messages.js");
	await import("../../src/ui/lazy/safe-markdown-block.js");
	syncCustomElements();
	await customElements.whenDefined("assistant-message");
});

afterEach(() => { document.body.innerHTML = ""; });

async function mount(text: string) {
	const parent = document.createElement("div");
	document.body.appendChild(parent);
	const el = document.createElement("assistant-message") as any;
	el.isStreaming = false;
	el.message = { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" };
	parent.appendChild(el);
	await el.updateComplete;
	return { parent, el: el as HTMLElement };
}

const btn = (el: HTMLElement) => el.querySelector<HTMLButtonElement>(".suggest-goal-btn");
const markdown = (el: HTMLElement) => el.querySelector("markdown-block") as any;

describe("suggest-goal tag detection and stripping", () => {
	it("tag present → detected (button rendered) and stripped from markdown", async () => {
		const { el } = await mount("Here is some text <suggest_goal/> and more text.");
		expect(btn(el)).toBeTruthy();
		const content: string = markdown(el)?.content ?? "";
		expect(content).not.toContain("suggest_goal");
		expect(content).toContain("Here is some text");
		expect(content).toContain("and more text.");
	});

	it("tag absent → not detected (no button)", async () => {
		const { el } = await mount("Just normal text without any tag.");
		expect(btn(el)).toBeNull();
		expect(markdown(el)?.content).toBe("Just normal text without any tag.");
	});

	it("whitespace variants detected and stripped", async () => {
		const variants = ["<suggest_goal/>", "<suggest_goal />", "<suggest_goal  />", "<suggest_goal>"];
		for (const v of variants) {
			const { el } = await mount(`text ${v} more`);
			expect(btn(el), `variant "${v}" should be detected`).toBeTruthy();
			expect(markdown(el)?.content ?? "").not.toContain("suggest_goal");
			document.body.innerHTML = "";
		}
	});

	it("multiple tags → single detection, all stripped", async () => {
		const { el } = await mount("first <suggest_goal/> second <suggest_goal /> third");
		expect(el.querySelectorAll(".suggest-goal-btn").length).toBe(1);
		const content: string = markdown(el)?.content ?? "";
		expect(content).not.toContain("suggest_goal");
		expect(content).toContain("first");
		expect(content).toContain("third");
	});

	it("tag-only content → button rendered, stripped chunk produces no markdown-block", async () => {
		const { el } = await mount("<suggest_goal/>");
		expect(btn(el)).toBeTruthy();
		// displayText is empty after stripping → the markdown-block chunk is dropped.
		expect(markdown(el)).toBeNull();
	});

	it("button click fires suggest-goal CustomEvent that bubbles", async () => {
		const { parent, el } = await mount("do it <suggest_goal/>");
		let fired = false;
		parent.addEventListener("suggest-goal", () => { fired = true; });
		btn(el)!.click();
		expect(fired).toBe(true);
	});
});
