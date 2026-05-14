/**
 * Unit tests for LSP tool renderers + LspShared helpers.
 *
 * The renderers return lit `TemplateResult`s — we walk those into a string and
 * assert key substrings appear. Pure helpers are unit-tested directly.
 */
import "./helpers/dom-stub.ts"; // MUST be first — installs a minimal `document` global.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
	symbolKindLabel,
	severityLabel,
	parseLspResult,
	isLspErrorEnvelope,
	renderLspErrorEnvelope,
	normalisePath,
	renderLocationRow,
} from "../src/ui/tools/renderers/LspShared.ts";
import { LspDefinitionRenderer } from "../src/ui/tools/renderers/LspDefinitionRenderer.ts";
import { LspReferencesRenderer } from "../src/ui/tools/renderers/LspReferencesRenderer.ts";
import { LspDiagnosticsRenderer } from "../src/ui/tools/renderers/LspDiagnosticsRenderer.ts";
import { LspDocumentSymbolsRenderer } from "../src/ui/tools/renderers/LspDocumentSymbolsRenderer.ts";
import { LspWorkspaceSymbolRenderer } from "../src/ui/tools/renderers/LspWorkspaceSymbolRenderer.ts";
import { LspRenameRenderer } from "../src/ui/tools/renderers/LspRenameRenderer.ts";
import { LspHoverRenderer } from "../src/ui/tools/renderers/LspHoverRenderer.ts";

// ── Helpers ──────────────────────────────────────────────────────────

/** Flatten a lit TemplateResult-or-anything into a single string. */
function flatten(node: any): string {
	if (node == null || node === false) return "";
	if (typeof node === "string" || typeof node === "number") return String(node);
	if (Array.isArray(node)) return node.map(flatten).join("");
	if (typeof node === "object") {
		// TemplateResult: { strings: TemplateStringsArray, values: any[] }
		if (Array.isArray(node.strings) && Array.isArray(node.values)) {
			let out = "";
			for (let i = 0; i < node.strings.length; i++) {
				out += node.strings[i] ?? "";
				if (i < node.values.length) out += flatten(node.values[i]);
			}
			return out;
		}
		// DirectiveResult or unknown — best effort
		if (typeof node.values !== "undefined") return flatten(node.values);
	}
	return "";
}

function mkResult(body: any, isError = false) {
	const text = typeof body === "string" ? body : JSON.stringify(body);
	return {
		role: "toolResult" as const,
		toolCallId: "t1",
		toolName: "lsp",
		isError,
		content: [{ type: "text", text }],
		timestamp: 0,
	} as any;
}

function renderText(renderer: any, params: any, result: any | undefined): string {
	const out = renderer.render(params, result, false);
	return flatten(out.content);
}

// ── symbolKindLabel ──────────────────────────────────────────────────

describe("symbolKindLabel", () => {
	it("returns Class for kind=5", () => {
		assert.equal(symbolKindLabel(5).label, "Class");
	});
	it("returns Function for kind=12", () => {
		assert.equal(symbolKindLabel(12).label, "Function");
	});
	it("returns Method for kind=6", () => {
		assert.equal(symbolKindLabel(6).label, "Method");
	});
	it("falls back to Symbol for unknown kinds", () => {
		assert.equal(symbolKindLabel(999).label, "Symbol");
	});
});

// ── severityLabel ────────────────────────────────────────────────────

describe("severityLabel", () => {
	it("error uses destructive color", () => {
		assert.match(severityLabel("error").color, /destructive/);
		assert.equal(severityLabel("error").label, "Error");
	});
	it("warning uses amber color", () => {
		assert.match(severityLabel("warning").color, /amber/);
	});
	it("info uses blue color", () => {
		assert.match(severityLabel("info").color, /blue/);
	});
	it("hint uses muted color", () => {
		assert.match(severityLabel("hint").color, /muted/);
	});
});

// ── normalisePath ────────────────────────────────────────────────────

describe("normalisePath", () => {
	it("strips file:// prefix", () => {
		assert.equal(normalisePath("file:///Users/x/foo.ts"), "/Users/x/foo.ts");
	});
	it("strips file:// + windows drive slash", () => {
		assert.equal(normalisePath("file:///C:/x/foo.ts"), "C:/x/foo.ts");
	});
	it("leaves relative paths untouched", () => {
		assert.equal(normalisePath("src/foo.ts"), "src/foo.ts");
	});
});

// ── parseLspResult ───────────────────────────────────────────────────

describe("parseLspResult", () => {
	it("returns null for undefined", () => {
		assert.equal(parseLspResult(undefined), null);
	});
	it("parses JSON body", () => {
		assert.deepEqual(parseLspResult(mkResult({ a: 1 })), { a: 1 });
	});
	it("returns null when text is not JSON", () => {
		assert.equal(parseLspResult(mkResult("not json")), null);
	});
});

// ── renderLspErrorEnvelope ───────────────────────────────────────────

describe("renderLspErrorEnvelope", () => {
	it("detects lsp_unavailable envelopes", () => {
		assert.equal(isLspErrorEnvelope({ error: "lsp_unavailable", message: "x" }), true);
	});
	it("rejects non-envelopes", () => {
		assert.equal(isLspErrorEnvelope(null), false);
		assert.equal(isLspErrorEnvelope({ error: "other" }), false);
		assert.equal(isLspErrorEnvelope(["a"]), false);
	});
	it("renders a warning with the fallback hint", () => {
		const out = flatten(renderLspErrorEnvelope({ error: "lsp_unavailable", message: "no server" }));
		assert.match(out, /LSP unavailable/);
		assert.match(out, /no server/);
	});
	it("returns null for non-error bodies", () => {
		assert.equal(renderLspErrorEnvelope({ foo: 1 }), null);
	});
});

// ── renderLocationRow ────────────────────────────────────────────────

describe("renderLocationRow", () => {
	it("renders path:line with 1-indexed line", () => {
		const out = flatten(renderLocationRow({ path: "src/x.ts", range: { start: { line: 41, character: 2 } } }));
		assert.match(out, /src\/x\.ts:42/);
	});
});

// ── LspDefinitionRenderer ────────────────────────────────────────────

describe("LspDefinitionRenderer", () => {
	const r = new LspDefinitionRenderer();
	const params = { path: "src/foo.ts", line: 10, character: 5 };

	it('renders "No definition found." for null result', () => {
		const text = renderText(r, params, mkResult(null));
		assert.match(text, /No definition found/);
		assert.match(text, /src\/foo\.ts/);
	});
	it("renders a single location", () => {
		const text = renderText(r, params, mkResult({ path: "src/bar.ts", range: { start: { line: 7, character: 0 } } }));
		assert.match(text, /src\/bar\.ts:8/);
	});
	it("renders array of locations", () => {
		const text = renderText(r, params, mkResult([
			{ path: "a.ts", range: { start: { line: 0, character: 0 } } },
			{ path: "b.ts", range: { start: { line: 2, character: 0 } } },
		]));
		assert.match(text, /a\.ts:1/);
		assert.match(text, /b\.ts:3/);
	});
	it("renders error envelope as warning hint", () => {
		const text = renderText(r, params, mkResult({ error: "lsp_unavailable", message: "boom" }));
		assert.match(text, /LSP unavailable/);
	});
});

// ── LspReferencesRenderer ────────────────────────────────────────────

describe("LspReferencesRenderer", () => {
	const r = new LspReferencesRenderer();
	const params = { path: "src/foo.ts", line: 1, character: 1 };

	it("groups by path and shows counts", () => {
		const text = renderText(r, params, mkResult([
			{ path: "a.ts", range: { start: { line: 0, character: 0 } } },
			{ path: "a.ts", range: { start: { line: 4, character: 0 } } },
			{ path: "b.ts", range: { start: { line: 1, character: 0 } } },
		]));
		assert.match(text, /3 references in 2 files/);
		assert.match(text, /a\.ts/);
		assert.match(text, /b\.ts/);
	});
	it("handles empty results", () => {
		const text = renderText(r, params, mkResult([]));
		assert.match(text, /No references found/);
	});
});

// ── LspDiagnosticsRenderer ───────────────────────────────────────────

describe("LspDiagnosticsRenderer", () => {
	const r = new LspDiagnosticsRenderer();

	it('shows "No diagnostics" for empty results', () => {
		const text = renderText(r, { path: "src/x.ts" }, mkResult([]));
		assert.match(text, /No diagnostics/);
	});
	it("summarises error + warning counts (omitting zeros)", () => {
		const text = renderText(r, { path: "src/x.ts" }, mkResult([
			{ path: "src/x.ts", range: { start: { line: 0, character: 0 } }, severity: "error", message: "broken" },
			{ path: "src/x.ts", range: { start: { line: 1, character: 0 } }, severity: "error", message: "still broken" },
			{ path: "src/x.ts", range: { start: { line: 2, character: 0 } }, severity: "warning", message: "iffy" },
		]));
		assert.match(text, /2 errors/);
		assert.match(text, /1 warning/);
		assert.doesNotMatch(text, /0 (info|hint)/);
		assert.match(text, /broken/);
		assert.match(text, /iffy/);
	});
	it("renders source chip when present", () => {
		const text = renderText(r, { path: "src/x.ts" }, mkResult([
			{ path: "src/x.ts", range: { start: { line: 0, character: 0 } }, severity: "error", message: "m", source: "ts" },
		]));
		assert.match(text, /\bts\b/);
	});
});

// ── LspDocumentSymbolsRenderer ───────────────────────────────────────

describe("LspDocumentSymbolsRenderer", () => {
	const r = new LspDocumentSymbolsRenderer();

	it("renders a flat list of symbols", () => {
		const text = renderText(r, { path: "src/x.ts" }, mkResult([
			{ name: "Foo", kind: 5, range: { start: { line: 0, character: 0 } } },
			{ name: "bar", kind: 12, range: { start: { line: 10, character: 0 } } },
		]));
		assert.match(text, /2 symbols in src\/x\.ts/);
		assert.match(text, /Foo/);
		assert.match(text, /bar/);
	});
	it("collapses depth beyond MAX_DEPTH", () => {
		const deep = {
			name: "L0", kind: 5, range: { start: { line: 0, character: 0 } },
			children: [{
				name: "L1", kind: 5, range: { start: { line: 1, character: 0 } },
				children: [{
					name: "L2", kind: 5, range: { start: { line: 2, character: 0 } },
					children: [{ name: "L3", kind: 5, range: { start: { line: 3, character: 0 } } }],
				}],
			}],
		};
		const text = renderText(r, { path: "x.ts" }, mkResult([deep]));
		// Should mention nested count once depth limit hits
		assert.match(text, /more nested symbol/);
	});
});

// ── LspWorkspaceSymbolRenderer ───────────────────────────────────────

describe("LspWorkspaceSymbolRenderer", () => {
	const r = new LspWorkspaceSymbolRenderer();
	it("renders match count and per-row path:line", () => {
		const text = renderText(r, { query: "foo" }, mkResult([
			{ name: "fooBar", kind: 12, path: "src/a.ts", range: { start: { line: 4, character: 0 } } },
		]));
		assert.match(text, /1 symbol/);
		assert.match(text, /"foo"/);
		assert.match(text, /fooBar/);
		assert.match(text, /src\/a\.ts:5/);
	});
});

// ── LspRenameRenderer ────────────────────────────────────────────────

describe("LspRenameRenderer", () => {
	const r = new LspRenameRenderer();
	const params = { path: "src/x.ts", line: 1, character: 1, newName: "newFoo" };

	it("summarises files and edits", () => {
		const text = renderText(r, params, mkResult({
			changes: {
				"src/a.ts": [{ range: {}, newText: "x" }, { range: {}, newText: "y" }],
				"file:///src/b.ts": [{ range: {}, newText: "z" }],
			},
		}));
		assert.match(text, /newFoo/);
		assert.match(text, /in 2 files \(3 total edits\)/);
		assert.match(text, /src\/a\.ts/);
		// file:// prefix stripped:
		assert.doesNotMatch(text, /file:\/\//);
		assert.match(text, /Preview only/);
	});
	it("handles no changes", () => {
		const text = renderText(r, params, mkResult({ changes: {} }));
		assert.match(text, /No edits proposed/);
	});
});

// ── LspHoverRenderer ─────────────────────────────────────────────────

describe("LspHoverRenderer", () => {
	const r = new LspHoverRenderer();
	const params = { path: "src/x.ts", line: 9, character: 0 };

	it('shows "No hover info." for null', () => {
		const text = renderText(r, params, mkResult(null));
		assert.match(text, /No hover info/);
		assert.match(text, /src\/x\.ts:10/);
	});
	it("includes the file/line in the header", () => {
		const text = renderText(r, params, mkResult({ contents: "**Cool**" }));
		assert.match(text, /Hover: src\/x\.ts:10/);
	});
});

