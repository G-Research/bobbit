import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "../_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/ui-fixtures/bash-renderer-description.spec.ts (v2-dom tier).
// Renders the REAL BashRenderer via lit into a happy-dom container (was an
// esbuild file:// bundle). The <console-block>/<diff-block> output elements are
// stubbed exactly as the legacy entry did. Same DOM facts: `description` replaces
// the summarized command in the collapsed header (muted/italic, not mono), and
// absent/empty descriptions fall back to summarizeCommand.
import { afterEach, describe, expect, it } from "vitest";
import { render } from "lit";
import { BashRenderer } from "../../../src/ui/tools/renderers/BashRenderer.js";

// Use the REAL <console-block>/<diff-block> output elements. Defining plain-
// HTMLElement stubs for these real component tags would be recorded by the shared
// custom-element bridge and replayed into lit's pinned registry, breaking every
// later file that renders the real (lit) ConsoleBlock/diff-block. The real
// ConsoleBlock renders its `.content` into textContent, so the assertions below
// (command text present in the console-block) hold unchanged.
import "../../../src/ui/components/ConsoleBlock.js";
import "../../../src/ui/lazy/diff-block.js";

const MULTI_LINE_CMD = `python -c "
import json, sys
data = json.load(open('session-costs.json'))
total = sum(s['cost'] for s in data if s['agent'] == 'agent-qa')
print(f'agent-qa total: \${total:.2f}')
"`;
const DESCRIPTION = "sum agent-qa costs from session-costs.json";

let container: HTMLElement;

function renderBash(params: { command: string; description?: string } | undefined) {
	const out = new BashRenderer().render(params, undefined, false);
	render(out.content, container);
}

// The REAL <console-block> renders its content asynchronously (lit update); await
// it before reading, unlike the old synchronous stub.
async function consoleText(): Promise<string> {
	const cb = container.querySelector("console-block") as any;
	if (cb?.updateComplete) await cb.updateComplete;
	return cb?.textContent ?? "";
}

afterEach(() => { document.body.innerHTML = ""; });

function fresh() {
	container = document.createElement("div");
	document.body.appendChild(container);
}

describe("BashRenderer description", () => {
	it("description replaces summarized command in collapsed header and has muted/italic style", () => {
		fresh();
		renderBash({ command: MULTI_LINE_CMD, description: DESCRIPTION });

		const header = container.querySelector("button")!;
		expect(header.textContent).toContain(DESCRIPTION);
		expect(header.textContent).not.toContain("python -c");

		const descEls = container.querySelectorAll(".bash-description");
		expect(descEls.length).toBe(1);
		const desc = descEls[0] as HTMLElement;
		expect((desc.textContent ?? "").trim()).toBe(DESCRIPTION);
		expect(desc.classList.contains("italic")).toBe(true);
		expect(desc.classList.contains("font-mono")).toBe(false);
	});

	it("backward compatibility: absent description uses summarizeCommand fallback", () => {
		fresh();
		renderBash({ command: MULTI_LINE_CMD });
		const header = container.querySelector("button")!;
		expect(header.textContent).toContain("python -c");
		expect(container.querySelectorAll(".bash-description").length).toBe(0);
	});

	it("backward compatibility: empty-string description falls back to summary", () => {
		fresh();
		renderBash({ command: MULTI_LINE_CMD, description: "" });
		const header = container.querySelector("button")!;
		expect(header.textContent).toContain("python -c");
		expect(container.querySelectorAll(".bash-description").length).toBe(0);
	});

	it("expanded body shows full command verbatim (with and without description)", async () => {
		fresh();
		renderBash({ command: MULTI_LINE_CMD, description: DESCRIPTION });
		let text = await consoleText();
		expect(text).toContain("import json, sys");
		expect(text).toContain("agent-qa total:");

		renderBash({ command: MULTI_LINE_CMD });
		text = await consoleText();
		expect(text).toContain("import json, sys");
		expect(text).toContain("agent-qa total:");
	});

	it("collapsed header is stable across re-render (renderer is a pure function)", () => {
		fresh();
		renderBash({ command: MULTI_LINE_CMD, description: DESCRIPTION });
		expect((container.querySelector(".bash-description")?.textContent ?? "").trim()).toBe(DESCRIPTION);

		// Re-render (equivalent to a reload — the renderer is pure).
		renderBash({ command: MULTI_LINE_CMD, description: DESCRIPTION });
		expect((container.querySelector(".bash-description")?.textContent ?? "").trim()).toBe(DESCRIPTION);
	});
});
