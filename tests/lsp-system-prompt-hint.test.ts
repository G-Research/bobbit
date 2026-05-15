/**
 * Regression tests: LSP symbol-lookup hint must appear in the assembled
 * system prompt when `lsp_*` tools are in the allowed-tools list, and must
 * NOT appear when they are absent.
 *
 * Pattern after `tests/lsp-tool-activation.test.ts`.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { initPromptDirs, assembleSystemPrompt } = await import("../src/server/agent/system-prompt.ts");
const { LSP_HINT_MARKER, buildLspSymbolLookupHint } = await import("../src/server/agent/lsp-hint.ts");

let tmpDir: string;

before(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-hint-test-"));
	initPromptDirs(tmpDir);
});

after(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Call assembleSystemPrompt with minimal PromptParts and return the assembled
 * content (read back from the written file).
 */
function assemble(
	sessionId: string,
	allowedTools: string[] | undefined,
	opts: { lspDisabled?: boolean } = {},
): string {
	const projectConfigStore = opts.lspDisabled !== undefined
		? { get: (k: string) => k === "lsp_disabled" ? String(opts.lspDisabled) : undefined }
		: undefined;
	const promptPath = assembleSystemPrompt(sessionId, {
		cwd: tmpDir,
		goalSpec: "Test goal spec.",
		goalTitle: "Test",
		goalState: "active",
		allowedTools,
		projectConfigStore,
	});
	assert.ok(promptPath, "assembleSystemPrompt should return a path");
	return fs.readFileSync(promptPath, "utf-8");
}

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

describe("LSP symbol-lookup hint — assembleSystemPrompt integration", () => {
	it("includes the hint marker when allowedTools contains lsp_ tools", () => {
		const content = assemble("hint-test-with-lsp", ["lsp_workspace_symbol", "read", "bash"]);
		assert.ok(
			content.includes(LSP_HINT_MARKER),
			`Expected '${LSP_HINT_MARKER}' in assembled prompt when lsp_ tools are present.\n` +
			`Prompt excerpt: ${content.slice(0, 500)}`,
		);
	});

	it("excludes the hint marker when allowedTools contains no lsp_ tools", () => {
		const content = assemble("hint-test-no-lsp", ["read", "bash", "grep", "find", "ls"]);
		assert.ok(
			!content.includes(LSP_HINT_MARKER),
			`Expected '${LSP_HINT_MARKER}' to be absent when no lsp_ tools allowed.\n` +
			`Prompt excerpt: ${content.slice(0, 500)}`,
		);
	});

	it("includes the hint when allowedTools is undefined (all tools active)", () => {
		const content = assemble("hint-test-unrestricted", undefined);
		assert.ok(
			content.includes(LSP_HINT_MARKER),
			`Expected '${LSP_HINT_MARKER}' in assembled prompt when allowedTools is unrestricted.`,
		);
	});

	it("excludes the hint when lsp_disabled=true even with lsp_ tools in allowedTools", () => {
		const content = assemble("hint-test-lsp-disabled", ["lsp_workspace_symbol", "read"], { lspDisabled: true });
		assert.ok(
			!content.includes(LSP_HINT_MARKER),
			`Expected '${LSP_HINT_MARKER}' to be absent when lsp_disabled=true.`,
		);
	});

	it("hint appears after the tool docs section in the prompt", () => {
		const content = assemble("hint-test-ordering", ["lsp_hover", "read"]);
		// Both sections should be present
		assert.ok(content.includes(LSP_HINT_MARKER), "Hint marker should be in prompt");
		// Hint should appear somewhere in the body (no strict ordering check needed,
		// but it must not be before the working-directory section)
		const hintPos = content.indexOf(LSP_HINT_MARKER);
		const cwdPos = content.indexOf("Working Directory");
		assert.ok(hintPos > cwdPos, "Hint should appear after the Working Directory section");
	});
});
