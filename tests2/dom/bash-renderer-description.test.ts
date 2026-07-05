// Migrated from tests/bash-renderer-description.spec.ts (v2-dom tier).
// Renders the REAL BashRenderer via lit into happy-dom (was an esbuild file://
// bundle) with the REAL <console-block>. Pins that the collapsed header shows
// the `description` when provided (italic .bash-description, not the mono
// command fallback) and falls back to the summarized command otherwise, while
// the expanded body always shows the full command verbatim.
import { afterEach, describe, expect, it } from "vitest";
import { render } from "lit";
import { BashRenderer } from "../../src/ui/tools/renderers/BashRenderer.js";
import "../../src/ui/components/ConsoleBlock.js";

const MULTI_LINE_CMD = `python -c "
import json, sys
data = json.load(open('session-costs.json'))
total = sum(s['cost'] for s in data if s['agent'] == 'agent-qa')
print(f'agent-qa total: \${total:.2f}')
"`;

const DESCRIPTION = "sum agent-qa costs from session-costs.json";

async function renderBash(params: { command: string; description?: string }): Promise<HTMLElement> {
	const container = document.createElement("div");
	container.id = "container";
	document.body.appendChild(container);
	const out = new BashRenderer().render(params, undefined, false);
	render(out.content, container);
	const cb = container.querySelector("console-block") as any;
	if (cb?.updateComplete) await cb.updateComplete;
	return container;
}

afterEach(() => { document.body.innerHTML = ""; });

describe("BashRenderer description param", () => {
	it("collapsed header shows description when provided", async () => {
		const el = await renderBash({ command: MULTI_LINE_CMD, description: DESCRIPTION });

		const header = el.querySelector("button")!;
		expect(header.textContent || "").toContain(DESCRIPTION);
		expect(header.textContent || "").not.toContain("python -c");

		// The description element has the distinguishing CSS class.
		const desc = el.querySelectorAll(".bash-description");
		expect(desc.length).toBe(1);
		expect(desc[0].textContent).toBe(DESCRIPTION);
		expect(desc[0].classList.contains("italic")).toBe(true);
		// And is NOT monospace (the fallback uses font-mono).
		expect(desc[0].classList.contains("font-mono")).toBe(false);
	});

	it("collapsed header falls back to summarized command when description is absent", async () => {
		const el = await renderBash({ command: MULTI_LINE_CMD });

		const header = el.querySelector("button")!;
		expect(header.textContent || "").toContain("python -c");
		expect(el.querySelectorAll(".bash-description").length).toBe(0);
		// Monospace fallback class is present on the header text.
		expect(el.querySelector(".font-mono")).toBeTruthy();
	});

	it("collapsed header falls back when description is empty string", async () => {
		const el = await renderBash({ command: MULTI_LINE_CMD, description: "" });

		const header = el.querySelector("button")!;
		expect(header.textContent || "").toContain("python -c");
		expect(el.querySelectorAll(".bash-description").length).toBe(0);
	});

	it("expanded body shows full command verbatim, with description", async () => {
		const el = await renderBash({ command: MULTI_LINE_CMD, description: DESCRIPTION });

		const cb = el.querySelector("console-block")!;
		const text = cb.textContent ?? "";
		expect(text).toContain("import json, sys");
		expect(text).toContain("agent-qa total:");
		expect(text).toContain("session-costs.json");
	});

	it("expanded body shows full command verbatim, without description", async () => {
		const el = await renderBash({ command: MULTI_LINE_CMD });

		const cb = el.querySelector("console-block")!;
		const text = cb.textContent ?? "";
		expect(text).toContain("import json, sys");
		expect(text).toContain("agent-qa total:");
	});

	it("description persists across page reload (pure render function)", async () => {
		let el = await renderBash({ command: MULTI_LINE_CMD, description: DESCRIPTION });
		expect(el.querySelector(".bash-description")?.textContent).toBe(DESCRIPTION);

		// Simulate a reload: fresh render of the same pure output.
		document.body.innerHTML = "";
		el = await renderBash({ command: MULTI_LINE_CMD, description: DESCRIPTION });
		expect(el.querySelector(".bash-description")?.textContent).toBe(DESCRIPTION);
	});
});
