/**
 * Regression tests for the LSP-over-text-search guidance.
 *
 * Historically `assembleSystemPrompt()` appended a `## Symbol-lookup hint`
 * block built by `buildLspSymbolLookupHint()` when `lsp_*` tools were active.
 * That conditional append is now superseded by the **canonical** section
 *
 *     ## Tool selection — LSP before text search
 *
 * shipped in `defaults/system-prompt.md` (the global base prompt every agent
 * receives). The `buildLspSymbolLookupHint()` helper remains exported for
 * backward compatibility — these unit tests pin its behaviour — but the
 * integration assertions now target the canonical base-prompt section.
 *
 * Sibling pin: `tests/lsp-canonical-base-prompt.test.ts` (broader role matrix).
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { initPromptDirs, assembleSystemPrompt } = await import("../src/server/agent/system-prompt.ts");
const { LSP_HINT_MARKER, buildLspSymbolLookupHint } = await import("../src/server/agent/lsp-hint.ts");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultsSystemPrompt = path.resolve(__dirname, "../defaults/system-prompt.md");

const CANONICAL_HEADER = "## Tool selection — LSP before text search";

let tmpDir: string;

before(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-hint-test-"));
	initPromptDirs(tmpDir);
});

after(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Assemble a prompt and return the file content. Always passes the shipped
 * `defaults/system-prompt.md` as the base so we are testing the real canonical
 * rule rather than any developer `.bobbit/config/system-prompt.md` overlay.
 */
function assemble(
	sessionId: string,
	allowedTools: string[] | undefined,
	opts: { lspDisabled?: boolean; includeBasePrompt?: boolean } = {},
): string {
	const projectConfigStore = opts.lspDisabled !== undefined
		? { get: (k: string) => k === "lsp_disabled" ? String(opts.lspDisabled) : undefined }
		: undefined;
	const baseSystemPromptPath = opts.includeBasePrompt === false ? undefined : defaultsSystemPrompt;
	const promptPath = assembleSystemPrompt(sessionId, {
		cwd: tmpDir,
		goalSpec: "Test goal spec.",
		goalTitle: "Test",
		goalState: "active",
		allowedTools,
		projectConfigStore,
		baseSystemPromptPath,
	});
	assert.ok(promptPath, "assembleSystemPrompt should return a path");
	return fs.readFileSync(promptPath, "utf-8");
}

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function count(haystack: string, needle: string): number {
	let n = 0;
	let from = 0;
	while (true) {
		const i = haystack.indexOf(needle, from);
		if (i < 0) return n;
		n++;
		from = i + needle.length;
	}
}

// ---------------------------------------------------------------------------
// 1. buildLspSymbolLookupHint() — legacy helper, still exported.
// ---------------------------------------------------------------------------

describe("LSP symbol-lookup hint — buildLspSymbolLookupHint()", () => {
	it("returns the hint string when allowedTools contains an lsp_ tool", () => {
		const hint = buildLspSymbolLookupHint(["lsp_workspace_symbol", "read", "bash"]);
		assert.ok(hint !== undefined, "Expected hint to be returned");
		assert.ok(hint.includes(LSP_HINT_MARKER), "Hint must contain the marker heading");
	});

	it("hint copy mentions rg and shell text search alongside grep", () => {
		const hint = buildLspSymbolLookupHint(undefined);
		assert.ok(hint !== undefined);
		assert.ok(hint.includes("rg"), "Hint should mention `rg`");
		assert.ok(
			hint.includes("shell text search") || hint.includes("git grep"),
			"Hint should mention shell text search or `git grep`",
		);
	});

	it("returns the hint string when allowedTools is undefined (unrestricted)", () => {
		const hint = buildLspSymbolLookupHint(undefined);
		assert.ok(hint !== undefined, "Expected hint when allowedTools is unrestricted");
	});

	it("returns undefined when allowedTools is defined but contains no lsp_ tools", () => {
		const hint = buildLspSymbolLookupHint(["read", "bash", "grep", "find", "ls"]);
		assert.strictEqual(hint, undefined, "Hint must be absent when no lsp_ tools are allowed");
	});

	it("returns undefined when lspDisabled=true even if lsp_ tools are present", () => {
		const hint = buildLspSymbolLookupHint(["lsp_workspace_symbol", "read"], true);
		assert.strictEqual(hint, undefined, "Hint must be suppressed when lsp_disabled=true");
	});

	it("returns undefined when lspDisabled=true and allowedTools is undefined", () => {
		const hint = buildLspSymbolLookupHint(undefined, true);
		assert.strictEqual(hint, undefined, "Hint must be suppressed when lsp_disabled=true even for unrestricted sessions");
	});

	it("returns the hint for any lsp_ tool prefix", () => {
		const lspTools = [
			"lsp_definition",
			"lsp_references",
			"lsp_hover",
			"lsp_diagnostics",
			"lsp_document_symbols",
			"lsp_workspace_symbol",
			"lsp_rename",
		];
		for (const toolName of lspTools) {
			const hint = buildLspSymbolLookupHint([toolName]);
			assert.ok(
				hint !== undefined,
				`Expected hint when allowedTools = ["${toolName}"]`,
			);
		}
	});
});

// ---------------------------------------------------------------------------
// 2. assembleSystemPrompt — canonical base-prompt section integration.
// ---------------------------------------------------------------------------

describe("LSP symbol-lookup — assembleSystemPrompt integration (canonical base prompt)", () => {
	it("includes the canonical section regardless of allowedTools (lsp tools present)", () => {
		const content = assemble("hint-canonical-with-lsp", ["lsp_workspace_symbol", "read", "bash"]);
		assert.strictEqual(
			count(content, CANONICAL_HEADER),
			1,
			`Expected exactly one '${CANONICAL_HEADER}' in assembled prompt.`,
		);
	});

	it("includes the canonical section even when no lsp_ tools are in allowedTools", () => {
		// The canonical rule is owned by the base prompt — it is not gated on
		// the per-session allowedTools list.
		const content = assemble("hint-canonical-no-lsp", ["read", "bash", "grep", "find", "ls"]);
		assert.strictEqual(count(content, CANONICAL_HEADER), 1);
	});

	it("includes the canonical section when allowedTools is undefined (unrestricted)", () => {
		const content = assemble("hint-canonical-unrestricted", undefined);
		assert.strictEqual(count(content, CANONICAL_HEADER), 1);
	});

	it("still includes the canonical section when lsp_disabled=true", () => {
		// Even when LSP tools are operationally disabled, the base prompt's
		// guidance about LSP-vs-text-search remains useful and harmless.
		const content = assemble(
			"hint-canonical-lsp-disabled",
			["lsp_workspace_symbol", "read"],
			{ lspDisabled: true },
		);
		assert.strictEqual(count(content, CANONICAL_HEADER), 1);
	});

	it("canonical section mentions rg, ripgrep, git grep, ag, ack, and bash", () => {
		const content = assemble("hint-canonical-tokens", ["lsp_hover", "read"]);
		for (const token of ["rg", "ripgrep", "git grep", "ag", "ack", "bash"]) {
			assert.ok(
				content.includes(token),
				`Canonical LSP section in assembled prompt must mention "${token}"`,
			);
		}
	});

	it("canonical section includes the lsp_definition({ symbolName: \"X\" }) example", () => {
		const content = assemble("hint-canonical-symbolname", ["lsp_definition", "read"]);
		assert.ok(
			content.includes(`lsp_definition({ symbolName: "X" })`),
			'Canonical section must include literal `lsp_definition({ symbolName: "X" })` example',
		);
	});

	it("canonical section appears after the Working Directory section", () => {
		const content = assemble("hint-canonical-order", ["lsp_hover", "read"]);
		const headerPos = content.indexOf(CANONICAL_HEADER);
		const cwdPos = content.indexOf("Working Directory");
		assert.ok(headerPos > 0, "Canonical header should be in prompt");
		assert.ok(cwdPos > 0, "Working Directory section should be in prompt");
		// Base prompt (which contains the canonical header) is emitted before
		// the working-directory section, so headerPos < cwdPos.
		assert.ok(
			headerPos < cwdPos,
			"Canonical header should appear in the base prompt (before Working Directory)",
		);
	});

	it("legacy `## Symbol-lookup hint` marker is no longer emitted by assembleSystemPrompt", () => {
		// `buildLspSymbolLookupHint` is still exported but no longer appended
		// to assembled prompts; the canonical base-prompt section supersedes it.
		const content = assemble("hint-legacy-absent", ["lsp_workspace_symbol", "read"]);
		assert.ok(
			!content.includes(LSP_HINT_MARKER),
			`Legacy '${LSP_HINT_MARKER}' must not appear in assembled prompts — superseded by '${CANONICAL_HEADER}'.`,
		);
	});

	it("without baseSystemPromptPath the canonical section is absent (sanity check)", () => {
		// Confirms the canonical section comes from the base prompt, not from
		// any synthesised section in assembleSystemPrompt itself.
		const content = assemble("hint-canonical-no-base", ["lsp_workspace_symbol", "read"], {
			includeBasePrompt: false,
		});
		assert.ok(
			!content.includes(CANONICAL_HEADER),
			"Canonical section should originate exclusively from defaults/system-prompt.md",
		);
	});
});
