import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "../_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/ui-fixtures/find-tool.spec.ts (v2-dom tier).
// The legacy spec esbuild-bundled tests/fixtures/find-renderer-entry.ts and
// rendered the REAL FindRenderer into a file:// fixture, then asserted the DOM.
// FindRenderer is a pure function of (params, result), so we render it directly
// under happy-dom via lit `render()` — full fidelity, no gateway.
import { afterEach, describe, expect, it } from "vitest";
import { render } from "lit";
import { FindRenderer } from "../../../src/ui/tools/renderers/FindRenderer.js";

// Use the REAL <console-block>. A plain-HTMLElement stub for this real component
// tag would be recorded by the shared custom-element bridge and replayed into
// lit's pinned registry, breaking later files that render the real (lit)
// ConsoleBlock. The real ConsoleBlock renders `.content` into textContent, so the
// result-text assertions below hold unchanged.
import "../../../src/ui/components/ConsoleBlock.js";

function renderFind(
	container: HTMLElement,
	params: { pattern: string; path?: string; limit?: number } | undefined,
	result: any = undefined,
	isStreaming = false,
) {
	const out = new FindRenderer().render(params, result, isStreaming);
	render(out.content, container);
}

function container(): HTMLElement {
	document.getElementById("container")?.remove();
	const el = document.createElement("div");
	el.id = "container";
	document.body.appendChild(el);
	return el;
}

afterEach(() => { document.body.innerHTML = ""; });

// The REAL <console-block> renders its content asynchronously (lit update); await
// it before reading, unlike the old synchronous stub.
async function settleConsole(el: HTMLElement): Promise<void> {
	const cb = el.querySelector("console-block") as any;
	if (cb?.updateComplete) await cb.updateComplete;
}

describe("FindRenderer (v2-dom)", () => {
	it("streaming header shows pattern and path before result arrives", () => {
		const el = container();
		renderFind(el, { pattern: "*.ts", path: "src/server" }, undefined, true);
		const text = el.textContent ?? "";
		expect(text).toContain("Finding");
		expect(text).toContain("*.ts");
		expect(text).toContain("src/server");
	});

	it("happy path: result renders into console-block with matched paths", async () => {
		const el = container();
		const output = ["src/server/binaries.ts", "src/server/cli.ts", "src/server/server.ts"].join("\n");
		renderFind(el, { pattern: "*.ts", path: "src/server" }, { isError: false, content: [{ type: "text", text: output }] });
		await settleConsole(el);

		const consoleBlocks = el.querySelectorAll("console-block");
		expect(consoleBlocks.length).toBe(1);
		expect(consoleBlocks[0].textContent).toContain("src/server/binaries.ts");
		expect(consoleBlocks[0].textContent).toContain("src/server/cli.ts");

		const header = el.querySelector("button")!;
		expect(header.textContent).toContain("*.ts");
		expect(header.textContent).toContain("src/server");
	});

	it("happy path with pattern only (no path) renders header without 'in <path>'", async () => {
		const el = container();
		renderFind(el, { pattern: "*.md" }, { isError: false, content: [{ type: "text", text: "README.md\nAGENTS.md" }] });
		await settleConsole(el);

		const header = el.querySelector("button")!;
		expect(header.textContent).toContain("Finding");
		expect(header.textContent).toContain("*.md");
		expect(header.textContent ?? "").not.toMatch(/\sin\s/);

		expect(el.querySelector("console-block")!.textContent).toContain("README.md");
	});

	it("error result renders destructive message, no console-block", () => {
		const el = container();
		renderFind(el, { pattern: "*.ts", path: "/nope" }, { isError: true, content: [{ type: "text", text: "fd: '/nope': No such file or directory" }] });

		expect(el.querySelectorAll("console-block").length).toBe(0);
		expect(el.textContent).toContain("No such file or directory");

		const errDivs = Array.from(el.querySelectorAll("div")).filter((d) => d.textContent?.includes("No such file or directory"));
		const errDiv = errDivs[errDivs.length - 1];
		const cls = errDiv?.getAttribute("class") ?? "";
		expect(cls).toMatch(/text-destructive|text-amber/);
	});

	it("renderer is a pure function: re-render produces identical DOM", async () => {
		const params = { pattern: "*.ts", path: "src" };
		const out = "src/a.ts\nsrc/b.ts";

		const first = container();
		renderFind(first, params, { isError: false, content: [{ type: "text", text: out }] });
		await settleConsole(first);
		const firstHtml = first.querySelector("console-block")!.textContent;
		expect(firstHtml).toContain("src/a.ts");

		const second = container();
		renderFind(second, params, { isError: false, content: [{ type: "text", text: out }] });
		await settleConsole(second);
		expect(second.querySelector("console-block")!.textContent).toBe(firstHtml);
	});
});
