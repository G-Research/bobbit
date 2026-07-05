import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/bg-process-renderer.spec.ts (v2-dom tier).
// The legacy file:// fixture was a PLAIN-JS MIRROR of the renderer + a stub
// console-block. Per the migration guide this port renders the REAL
// BgProcessRenderer (src/ui/tools/renderers/BgProcessRenderer) + the REAL
// <console-block> (src/ui/components/ConsoleBlock) which uses the REAL ansi
// util. Assertions preserve the same user-visible facts (output goes through
// <console-block>, ANSI → styled colour spans, plain text → unstyled <pre>,
// empty → "(no output)"), adapted to the real component's markup — the real
// ansi palette uses CSS-var colours (var(--ansi-green …)) rather than the
// mirror's hard-coded #0a0/#c00 hexes.
import { afterEach, describe, expect, it } from "vitest";
import { render } from "lit";
import { BgProcessRenderer } from "../../src/ui/tools/renderers/BgProcessRenderer.js";
import "../../src/ui/components/ConsoleBlock.js";

const renderer = new BgProcessRenderer();

/** Render a `logs` bg-process result and return the outer render div. */
async function renderBg(output: string): Promise<HTMLElement> {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const result = {
		role: "toolResult",
		isError: false,
		content: [{ type: "text", text: output }],
		toolCallId: "tc-1",
		toolName: "bash_bg",
		timestamp: Date.now(),
	};
	const out = renderer.render({ action: "logs", id: "bg-1" } as any, result as any, false);
	render(out.content, container);
	const outerDiv = container.firstElementChild as HTMLElement;
	const cb = container.querySelector("console-block") as any;
	if (cb?.updateComplete) await cb.updateComplete;
	return outerDiv;
}

afterEach(() => { document.body.innerHTML = ""; });

describe("BgProcessRenderer ANSI color support", () => {
	it("renders output via console-block element, not a raw <pre> sibling", async () => {
		const div = await renderBg("some output");
		expect(div.querySelectorAll("console-block").length).toBeGreaterThanOrEqual(1);
		// The <pre> must live INSIDE <console-block>, never as a direct child of
		// the renderer's own output container.
		const directPre = Array.from(div.children).some((c) => c.tagName === "PRE");
		expect(directPre).toBe(false);
	});

	it("ANSI escape codes are converted to styled HTML spans", async () => {
		const div = await renderBg("\x1b[32mgreen text\x1b[0m normal \x1b[31mred text\x1b[0m");
		const block = div.querySelector("console-block")!;

		const spans = Array.from(block.querySelectorAll("span"));
		const green = spans.find((s) => s.textContent === "green text");
		expect(green).toBeTruthy();
		expect(green!.getAttribute("style") || "").toContain("--ansi-green");

		const red = spans.find((s) => s.textContent === "red text");
		expect(red).toBeTruthy();
		expect(red!.getAttribute("style") || "").toContain("--ansi-red");

		// The raw ANSI escape sequence must NOT appear in the visible text.
		const visibleText = block.textContent || "";
		expect(visibleText).not.toContain("\x1b[");
		expect(visibleText).toContain("green text");
		expect(visibleText).toContain("red text");
		expect(visibleText).toContain("normal");
	});

	it("plain text output renders without ANSI processing (unstyled <pre>)", async () => {
		const div = await renderBg("just plain text");
		const block = div.querySelector("console-block")!;

		const pre = block.querySelector("pre");
		expect(pre).toBeTruthy();
		expect((pre!.textContent || "").trim()).toBe("just plain text");
		// No colour spans for plain output.
		expect(block.querySelectorAll("span[style*='color']").length).toBe(0);
	});

	it("empty output shows fallback text", async () => {
		const div = await renderBg("");
		const block = div.querySelector("console-block")!;
		expect(block.textContent || "").toContain("(no output)");
	});
});
