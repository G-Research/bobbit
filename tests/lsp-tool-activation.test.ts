/**
 * Regression test: LSP tools must be registered in spawned agents.
 *
 * Previously the LSP YAMLs declared `provider.type: builtin`, which caused
 * tool-activation to silently drop them — agents never saw `lsp_*` tools even
 * though the gateway hosted the LSP routes correctly. The fix changes all 7
 * LSP YAMLs to `provider.type: bobbit-extension` with `extension: extension.ts`.
 *
 * This test asserts that `computeToolActivationArgs` produces `--extension`
 * flags pointing at `defaults/tools/lsp/extension.ts` when `lsp_definition`
 * (or any other LSP tool) is in the allowed-tools list.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { ToolManager } = await import("../src/server/agent/tool-manager.ts");
const { computeToolActivationArgs } = await import("../src/server/agent/tool-activation.ts");

/** Resolve the real defaults/tools directory from the repo root. */
const DEFAULTS_TOOLS_DIR = path.resolve(
	import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
	"..",
	"defaults",
	"tools",
);

/** Build a ToolManager backed by the real defaults/tools directory. */
function realToolManager() {
	const fakeConfig = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-tool-activation-"));
	fs.mkdirSync(path.join(fakeConfig, "tools"), { recursive: true });
	return {
		tm: new ToolManager(fakeConfig, DEFAULTS_TOOLS_DIR),
		cleanup: () => fs.rmSync(fakeConfig, { recursive: true, force: true }),
	};
}

/** Extract --extension paths from a computeToolActivationArgs result. */
function extensionPaths(args: string[]): string[] {
	return args
		.filter((_a, i) => i > 0 && args[i - 1] === "--extension")
		.map(p => p.replace(/\\/g, "/"));
}

describe("LSP tool activation", () => {
	it("lsp_definition (explicit allowedTools) produces --extension for lsp/extension.ts", () => {
		const { tm, cleanup } = realToolManager();
		try {
			const result = computeToolActivationArgs(
				[{ kind: "yaml", name: "lsp_definition" }],
				tm,
			);
			const exts = extensionPaths(result.args);
			const lspExt = exts.find(p => p.endsWith("lsp/extension.ts"));
			assert.ok(
				lspExt !== undefined,
				`Expected an --extension flag ending in 'lsp/extension.ts'; got extensions: ${JSON.stringify(exts)}`,
			);
		} finally {
			cleanup();
		}
	});

	it("all 7 LSP tools each produce --extension for lsp/extension.ts", () => {
		const lspTools = [
			"lsp_definition",
			"lsp_references",
			"lsp_hover",
			"lsp_diagnostics",
			"lsp_document_symbols",
			"lsp_workspace_symbol",
			"lsp_rename",
		];

		const { tm, cleanup } = realToolManager();
		try {
			for (const toolName of lspTools) {
				const result = computeToolActivationArgs(
					[{ kind: "yaml", name: toolName }],
					tm,
				);
				const exts = extensionPaths(result.args);
				const lspExt = exts.find(p => p.endsWith("lsp/extension.ts"));
				assert.ok(
					lspExt !== undefined,
					`Tool "${toolName}": expected --extension ending in 'lsp/extension.ts'; got: ${JSON.stringify(exts)}`,
				);
			}
		} finally {
			cleanup();
		}
	});

	it("no allowedTools (all tools) includes lsp/extension.ts in extensions", () => {
		const { tm, cleanup } = realToolManager();
		try {
			const result = computeToolActivationArgs(undefined, tm);
			const exts = extensionPaths(result.args);
			const lspExt = exts.find(p => p.endsWith("lsp/extension.ts"));
			assert.ok(
				lspExt !== undefined,
				`Expected lsp/extension.ts in --extension flags when all tools enabled; got: ${JSON.stringify(exts)}`,
			);
		} finally {
			cleanup();
		}
	});
});
