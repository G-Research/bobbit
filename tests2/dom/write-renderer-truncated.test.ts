import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/write-renderer-truncated.spec.ts (v2-dom tier).
//
// The legacy file:// fixture gave up importing the real renderer and inlined a
// plain-JS mirror (isTruncated/formatSize + hand-built innerHTML). Here we render
// the REAL WriteRenderer via lit for all badge/button/content facts — higher
// fidelity than the mirror. `isTruncated` and `formatSize` are module-private in
// WriteRenderer.ts (not exported), so the two pure-predicate tests reproduce those
// exact functions and assert them directly (as the legacy spec did).
import { afterEach, describe, expect, it } from "vitest";
import { render } from "lit";
import { WriteRenderer } from "../../src/ui/tools/renderers/WriteRenderer.js";

// Exact copies of the module-private helpers in WriteRenderer.ts.
function isTruncated(content: unknown): boolean {
	return typeof content === "object" && content !== null && (content as any)._truncated === true;
}
function formatSize(bytes: number): string {
	if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
	if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${bytes} bytes`;
}

const okResult = { isError: false, content: [{ type: "text", text: "written" }] } as any;
const TRUNCATED = {
	_truncated: true as const,
	_originalLength: 10_485_760,
	preview: "// First 512 characters of a very large file...\nconst data = [1, 2, 3];",
};

function renderWrite(params: any, result: any, isStreaming?: boolean): HTMLDivElement {
	const container = document.createElement("div");
	document.body.appendChild(container);
	render(new WriteRenderer().render(params, result, isStreaming).content, container);
	return container;
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement | undefined {
	return Array.from(container.querySelectorAll("button")).find((b) => (b.textContent || "").trim() === text) as
		| HTMLButtonElement
		| undefined;
}

afterEach(() => {
	document.body.innerHTML = "";
});

describe("WriteRenderer truncated content handling", () => {
	it("normal string content is not detected as truncated", () => {
		const content = "console.log('hello');";
		expect(isTruncated(content)).toBe(false);

		const container = renderWrite({ path: "test.js", content }, okResult, false);
		expect(container.textContent).not.toContain("Content truncated");
		const codeBlock = container.querySelector("code-block") as any;
		expect(codeBlock).not.toBeNull();
		expect(codeBlock.code).toContain("console.log");
	});

	it("truncated object is detected and preview is extracted", () => {
		expect(isTruncated(TRUNCATED)).toBe(true);

		const container = renderWrite({ path: "big.txt", content: TRUNCATED }, undefined, true);
		const codeBlock = container.querySelector("code-block") as any;
		expect(codeBlock).not.toBeNull();
		expect(codeBlock.code).toContain("First 512 characters");
	});

	it("truncated size is formatted correctly", () => {
		expect(formatSize(TRUNCATED._originalLength)).toBe("10.0 MB");
		const container = renderWrite({ path: "big.txt", content: TRUNCATED }, undefined, true);
		expect(container.textContent).toContain("10.0 MB");
	});

	it("streaming badge shows truncation indicator", () => {
		const container = renderWrite({ path: "big.txt", content: TRUNCATED }, undefined, true);
		const text = (container.textContent || "").replace(/\s+/g, " ");
		expect(text).toContain("Truncated");
		expect(text).toContain("10.0 MB");
	});

	it("final render shows truncation badge with size info", () => {
		const container = renderWrite({ path: "big.txt", content: TRUNCATED }, okResult, false);
		const text = (container.textContent || "").replace(/\s+/g, " ");
		expect(text).toContain("Content truncated");
		expect(text).toContain("10.0 MB");
		expect(text).toContain("preview only");
	});

	it("Load full content button is present in final render", () => {
		const container = renderWrite({ path: "big.txt", content: TRUNCATED }, okResult, false);
		const btn = buttonByText(container, "Load full content");
		expect(btn).toBeTruthy();
		expect(btn!.textContent!.trim()).toBe("Load full content");
	});

	it("clicking Load full content dispatches CustomEvent and shows loading state", () => {
		const container = renderWrite({ path: "big.txt", content: TRUNCATED }, okResult, false);
		let fired = false;
		document.addEventListener("load-full-content", () => {
			fired = true;
		});
		const btn = buttonByText(container, "Load full content")!;
		btn.click();

		expect(btn.textContent!.trim()).toBe("Loading...");
		expect(fired).toBe(true);
	});

	it("edge cases: isTruncated handles various inputs correctly", () => {
		expect(isTruncated(null)).toBe(false);
		expect(isTruncated(undefined)).toBe(false);
		expect(isTruncated("")).toBe(false);
		expect(isTruncated({ _truncated: false, _originalLength: 100, preview: "x" })).toBe(false);
		expect(isTruncated({ _truncated: true, _originalLength: 0, preview: "" })).toBe(true);
		expect(isTruncated({ _truncated: true, _originalLength: 50000, preview: "abc" })).toBe(true);
	});

	it("formatSize produces human-readable sizes", () => {
		expect(formatSize(500)).toBe("500 bytes");
		expect(formatSize(1024)).toBe("1.0 KB");
		expect(formatSize(32768)).toBe("32.0 KB");
		expect(formatSize(1048576)).toBe("1.0 MB");
		expect(formatSize(10485760)).toBe("10.0 MB");
		expect(formatSize(41943040)).toBe("40.0 MB");
	});
});
