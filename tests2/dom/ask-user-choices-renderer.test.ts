// Migrated from tests/ask-user-choices-renderer.spec.ts (v2-dom tier).
// Renders the REAL AskUserChoicesRenderer via lit into happy-dom, replacing the
// esbuild file:// bundle. Pins the gating between error chip and interactive
// widget for the three completed-result shapes.
import { afterEach, describe, expect, it } from "vitest";
import { render } from "lit";
import { AskUserChoicesRenderer } from "../../src/ui/tools/renderers/AskUserChoicesRenderer.js";
import "../../src/ui/components/AskUserChoicesWidget.js";

const PARAMS = {
	questions: [
		{ question: "Q1", options: ["a", "b"], tab_label: "First" },
		{ question: "Q2", options: ["c", "d"], tab_label: "Second" },
	],
};

async function renderAsk(params: any, result: any): Promise<HTMLElement> {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const out = new AskUserChoicesRenderer().render(params, result, false, undefined as any);
	render(out.content, container);
	// The renderer emits an <ask-user-choices-widget>; its light-DOM content
	// (.ask-error / tabs / .ask-submit) only exists after the widget's async
	// first update settles.
	await customElements.whenDefined("ask-user-choices-widget");
	const widget = container.querySelector("ask-user-choices-widget") as any;
	if (widget?.updateComplete) await widget.updateComplete;
	return container;
}
const count = (el: HTMLElement, sel: string) => el.querySelectorAll(sel).length;

afterEach(() => { document.body.innerHTML = ""; });

describe("AskUserChoicesRenderer error-vs-interactive gating", () => {
	it("isError:true result renders minimal error chip, not interactive widget", async () => {
		const el = await renderAsk(PARAMS, {
			isError: true,
			content: [{ type: "text", text: JSON.stringify({ error: "ask_user_choices: questions[1].tab_label is required when there are multiple questions." }) }],
		});
		expect(count(el, ".ask-error")).toBe(1);
		expect(count(el, '[role="tab"]')).toBe(0);
		expect(count(el, ".ask-submit")).toBe(0);
	});

	it("{error:'...'} content without isError flag also renders minimal error chip (defense-in-depth)", async () => {
		const el = await renderAsk(PARAMS, {
			content: [{ type: "text", text: JSON.stringify({ error: "some failure" }) }],
		});
		expect(count(el, ".ask-error")).toBe(1);
		expect(count(el, '[role="tab"]')).toBe(0);
		expect(count(el, ".ask-submit")).toBe(0);
	});

	it("{status:'posted'} stub renders interactive widget (tabs + submit)", async () => {
		const el = await renderAsk(PARAMS, {
			content: [{ type: "text", text: JSON.stringify({ status: "posted", tool_use_id: "abc" }) }],
		});
		expect(count(el, '[role="tab"]')).toBe(2);
		expect(count(el, ".ask-submit")).toBe(1);
		expect(count(el, ".ask-error")).toBe(0);
	});
});
