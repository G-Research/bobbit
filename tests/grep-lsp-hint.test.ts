/**
 * Unit tests for `defaults/tools/_builtins/grep-lsp-hint.ts`.
 *
 * The module exposes `lspHintFor(params, result)` which returns a one-line
 * hint string when a grep call looks like an LSP-shaped symbol lookup over
 * TS/JS source files, or `null` otherwise. The hint is prepended to the
 * grep result by `wrapGrepWithLspHint` in `_builtins/extension.ts`.
 *
 * Heuristic recap (from the design doc):
 *  - emit only when pattern is symbol-shaped (identifier branches, optional
 *    declaration keyword prefix, optional escaped call suffix `\(`)
 *  - emit only when the grep result has non-empty text content
 *  - emit only when the glob (if any) targets TS/JS source extensions
 *  - skip when BOBBIT_GREP_LSP_HINT=0
 *  - hint is exactly one line, ≤200 chars, prefixed with `[lsp-hint]`
 *  - `foo\(` patterns recommend `lsp_references` instead of
 *    `lsp_workspace_symbol`
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { lspHintFor } from "../defaults/tools/_builtins/grep-lsp-hint.ts";

function grepResult(text: string) {
	return { content: [{ type: "text", text }] };
}
function emptyResult() {
	return { content: [{ type: "text", text: "" }] };
}

const SAMPLE_HIT =
	"src/server/agent/store.ts:42:export function getPersistedSession() {";

function assertHintShape(hint: string) {
	assert.ok(hint.startsWith("[lsp-hint]"), `hint must be prefixed: ${hint}`);
	assert.ok(!hint.includes("\n"), `hint must be one line: ${hint}`);
	assert.ok(
		hint.length <= 200,
		`hint must be ≤200 chars, got ${hint.length}: ${hint}`,
	);
}

describe("lspHintFor — emits for symbol-shaped TS/JS patterns", () => {
	it("alternation of two identifiers with *.ts glob recommends lsp_workspace_symbol on first id", () => {
		const hint = lspHintFor(
			{ pattern: "getPersistedSession|agentSessionFile", glob: "*.ts" },
			grepResult(SAMPLE_HIT),
		);
		assert.ok(hint, "expected a hint");
		assertHintShape(hint!);
		assert.ok(
			hint!.includes(`lsp_workspace_symbol("getPersistedSession")`),
			`expected workspace_symbol suggestion on first identifier: ${hint}`,
		);
	});

	it("escaped call suffix `archiveGoal\\(` recommends lsp_references", () => {
		const hint = lspHintFor(
			{ pattern: "archiveGoal\\(", glob: "*.ts" },
			grepResult("src/server/server.ts:101:  archiveGoal(id);"),
		);
		assert.ok(hint, "expected a hint");
		assertHintShape(hint!);
		assert.ok(
			hint!.includes("lsp_references"),
			`expected lsp_references suggestion: ${hint}`,
		);
		assert.ok(
			hint!.includes("archiveGoal"),
			`expected identifier name in hint: ${hint}`,
		);
	});

	it("`function foo` strips declaration keyword and emits on `foo`", () => {
		const hint = lspHintFor(
			{ pattern: "function foo", glob: "*.ts" },
			grepResult("src/a.ts:1:function foo() {}"),
		);
		assert.ok(hint, "expected a hint");
		assertHintShape(hint!);
		assert.ok(
			hint!.includes(`lsp_workspace_symbol("foo")`),
			`expected workspace_symbol on stripped identifier 'foo': ${hint}`,
		);
	});

	it("conventionally-string pattern `TODO|FIXME` still emits (acceptable false positive)", () => {
		const hint = lspHintFor(
			{ pattern: "TODO|FIXME", glob: "*.ts" },
			grepResult("src/a.ts:1:// TODO: thing"),
		);
		assert.ok(hint, "expected a hint (acceptable false positive)");
		assertHintShape(hint!);
	});

	it("no glob defaults to TS/JS-allowed territory", () => {
		const hint = lspHintFor(
			{ pattern: "getPersistedSession" },
			grepResult(SAMPLE_HIT),
		);
		assert.ok(hint, "expected a hint with no glob");
		assertHintShape(hint!);
	});

	it("glob `*.tsx` is allowed", () => {
		const hint = lspHintFor(
			{ pattern: "MyComponent", glob: "*.tsx" },
			grepResult("src/ui/x.tsx:1:export function MyComponent() {}"),
		);
		assert.ok(hint, "expected a hint for tsx glob");
		assertHintShape(hint!);
	});

	it("brace-expansion glob `**/*.{ts,tsx,js,jsx,mts,cts}` is allowed", () => {
		const hint = lspHintFor(
			{
				pattern: "getPersistedSession",
				glob: "**/*.{ts,tsx,js,jsx,mts,cts}",
			},
			grepResult(SAMPLE_HIT),
		);
		assert.ok(hint, "expected a hint for full source brace glob");
		assertHintShape(hint!);
	});

	it("brace-expansion glob `*.{ts,tsx}` is allowed", () => {
		const hint = lspHintFor(
			{ pattern: "MyComponent", glob: "*.{ts,tsx}" },
			grepResult("src/ui/x.tsx:1:export function MyComponent() {}"),
		);
		assert.ok(hint, "expected a hint for `*.{ts,tsx}` brace glob");
		assertHintShape(hint!);
	});

	it("brace-expansion glob `**/*.{js,jsx}` is allowed", () => {
		const hint = lspHintFor(
			{ pattern: "renderThing", glob: "**/*.{js,jsx}" },
			grepResult("src/x.js:1:function renderThing() {}"),
		);
		assert.ok(hint, "expected a hint for `**/*.{js,jsx}` brace glob");
		assertHintShape(hint!);
	});
});

describe("lspHintFor — suppresses hint for non-symbol or non-source cases", () => {
	it("path-like pattern `team/teardown` is not symbol-shaped", () => {
		const hint = lspHintFor(
			{ pattern: "team/teardown", glob: "*.ts" },
			grepResult("src/server/team/teardown.ts:1:..."),
		);
		assert.equal(hint, null);
	});

	it("free-text pattern with a space `Archive goal` is not symbol-shaped", () => {
		const hint = lspHintFor(
			{ pattern: "Archive goal", glob: "*.ts" },
			grepResult("src/ui/x.ts:1:// Archive goal button"),
		);
		assert.equal(hint, null);
	});

	it("empty grep result suppresses hint", () => {
		const hint = lspHintFor(
			{ pattern: "getPersistedSession", glob: "*.ts" },
			emptyResult(),
		);
		assert.equal(hint, null);
	});

	it("result with no content array suppresses hint", () => {
		const hint = lspHintFor(
			{ pattern: "getPersistedSession", glob: "*.ts" },
			{ content: [] },
		);
		assert.equal(hint, null);
	});

	it("non-source glob `*.md` suppresses hint", () => {
		const hint = lspHintFor(
			{ pattern: "getPersistedSession", glob: "*.md" },
			grepResult("docs/x.md:1:getPersistedSession is the function"),
		);
		assert.equal(hint, null);
	});

	it("non-source brace glob `*.{md,txt}` suppresses hint", () => {
		const hint = lspHintFor(
			{ pattern: "getPersistedSession", glob: "*.{md,txt}" },
			grepResult("docs/x.md:1:getPersistedSession"),
		);
		assert.equal(hint, null);
	});

	it("non-source glob `*.json` suppresses hint (must not match `js` inside `json`)", () => {
		const hint = lspHintFor(
			{ pattern: "getPersistedSession", glob: "*.json" },
			grepResult("package.json:1:..."),
		);
		assert.equal(hint, null);
	});

	it("missing pattern suppresses hint", () => {
		const hint = lspHintFor({ glob: "*.ts" }, grepResult(SAMPLE_HIT));
		assert.equal(hint, null);
	});
});

describe("lspHintFor — env opt-out", () => {
	let prev: string | undefined;
	before(() => {
		prev = process.env.BOBBIT_GREP_LSP_HINT;
		process.env.BOBBIT_GREP_LSP_HINT = "0";
	});
	after(() => {
		if (prev === undefined) delete process.env.BOBBIT_GREP_LSP_HINT;
		else process.env.BOBBIT_GREP_LSP_HINT = prev;
	});

	it("BOBBIT_GREP_LSP_HINT=0 disables hint generation", () => {
		const hint = lspHintFor(
			{ pattern: "getPersistedSession", glob: "*.ts" },
			grepResult(SAMPLE_HIT),
		);
		assert.equal(hint, null);
	});
});
