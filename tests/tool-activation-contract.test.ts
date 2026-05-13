/**
 * Unit-level pin on the post-`fdfee7c5` `--tools` activation contract.
 *
 * Layer 4 of the hardened tool-use canary (see design-doc gate). The integration
 * canary (`tests/manual-integration/agent-tool-use.spec.ts`) is the end-to-end
 * proof; this file pins the same contract at unit speed so a future pi upgrade
 * that breaks the flag semantics fails CI in seconds instead of via a real LLM
 * run.
 *
 * The contract this test pins (established by `fdfee7c5`):
 *   1. `args` includes `--no-builtin-tools` (pi's internal builtins disabled).
 *   2. `args` includes `--no-extensions`     (pi's auto-loaded extensions disabled).
 *   3. `args` includes `--extension <…>/defaults/tools/_builtins/extension.ts`
 *      (Bobbit's re-registration shim for the desired file-tool builtins).
 *   4. `env.BOBBIT_BUILTIN_TOOLS` exactly equals the sorted, comma-joined list
 *      of pi file-tool builtins re-registered for this session.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

const { computeToolActivationArgs } = await import("../src/server/agent/tool-activation.ts");
import type { ToolProvider } from "../src/server/agent/tool-manager.ts";
import type { EffectiveTool } from "../src/server/agent/tool-activation.ts";

type ProviderWithGroup = ToolProvider & { groupDir: string; baseDir: string };

const MOCK_TOOLS_DIR = "/mock/tools";

function mockToolManager(providers: Map<string, ProviderWithGroup>) {
	return {
		getToolProviders: () => providers,
		getExtensionPath: (groupDir: string, filename: string) =>
			path.join(MOCK_TOOLS_DIR, groupDir, filename),
	} as any;
}

/** Representative provider map: pi file-builtins + pi shell-builtin + a Bobbit extension. */
function representativeProviders(): Map<string, ProviderWithGroup> {
	return new Map<string, ProviderWithGroup>([
		// pi file-tool builtins (re-registered via _builtins/extension.ts)
		["read", { type: "builtin", tool: "read", groupDir: "filesystem", baseDir: MOCK_TOOLS_DIR }],
		["edit", { type: "builtin", tool: "edit", groupDir: "filesystem", baseDir: MOCK_TOOLS_DIR }],
		// pi shell builtin (special-cased — comes from shell/extension.ts, NOT BOBBIT_BUILTIN_TOOLS)
		["bash", { type: "builtin", tool: "bash", groupDir: "shell", baseDir: MOCK_TOOLS_DIR }],
		// Bobbit extension tool — loaded via `--extension <baseDir>/<group>/extension.ts`
		["web_fetch", { type: "bobbit-extension", extension: "extension.ts", groupDir: "web", baseDir: MOCK_TOOLS_DIR }],
	]);
}

/** Extract the positional argument after each `--extension` flag. */
function extensionPaths(args: string[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--extension" && i + 1 < args.length) {
			out.push(args[i + 1].replace(/\\/g, "/"));
		}
	}
	return out;
}

describe("computeToolActivationArgs — post-fdfee7c5 activation contract", () => {
	it("emits --no-builtin-tools and --no-extensions for the canonical representative tool set", () => {
		const tm = mockToolManager(representativeProviders());
		const tools: EffectiveTool[] = [
			{ kind: "yaml", name: "read" },       // pi file-builtin
			{ kind: "yaml", name: "edit" },       // pi file-builtin
			{ kind: "yaml", name: "web_fetch" },  // Bobbit extension
		];

		const result = computeToolActivationArgs(tools, tm);

		// 1. pi's internal builtins must be fully disabled.
		assert.ok(
			result.args.includes("--no-builtin-tools"),
			`expected --no-builtin-tools in args, got: ${JSON.stringify(result.args)}`,
		);
		// 2. pi's auto-discovered extensions must be fully disabled.
		assert.ok(
			result.args.includes("--no-extensions"),
			`expected --no-extensions in args, got: ${JSON.stringify(result.args)}`,
		);
		// Belt-and-braces: the broken pre-fix flag must NOT reappear.
		assert.ok(
			!result.args.includes("--tools"),
			`expected no --tools flag (pi 0.70+ allowlist semantics), got: ${JSON.stringify(result.args)}`,
		);
	});

	it("loads _builtins/extension.ts via --extension to re-register file builtins", () => {
		const tm = mockToolManager(representativeProviders());
		const tools: EffectiveTool[] = [
			{ kind: "yaml", name: "read" },
			{ kind: "yaml", name: "web_fetch" },
		];

		const result = computeToolActivationArgs(tools, tm);

		const exts = extensionPaths(result.args);
		const builtinsExt = exts.find(p => p.endsWith("/defaults/tools/_builtins/extension.ts")
			|| p.endsWith("/_builtins/extension.ts"));
		assert.ok(
			builtinsExt,
			`expected an --extension path ending in _builtins/extension.ts, got extensions: ${JSON.stringify(exts)}`,
		);

		// Sanity: the --extension flag and its path argument must be adjacent.
		const idx = result.args.indexOf("--extension");
		assert.ok(idx >= 0 && idx + 1 < result.args.length, "expected --extension followed by a path");
	});

	it("env.BOBBIT_BUILTIN_TOOLS is the sorted, comma-joined set of file-builtins re-registered", () => {
		const tm = mockToolManager(representativeProviders());
		const tools: EffectiveTool[] = [
			{ kind: "yaml", name: "read" },       // contributes "read"
			{ kind: "yaml", name: "edit" },       // contributes "edit"
			{ kind: "yaml", name: "bash" },       // NOT in BOBBIT_BUILTIN_TOOLS — loaded via shell/extension.ts
			{ kind: "yaml", name: "web_fetch" },  // Bobbit extension — NOT a file builtin
		];

		const result = computeToolActivationArgs(tools, tm);

		assert.ok(
			typeof result.env.BOBBIT_BUILTIN_TOOLS === "string",
			"env.BOBBIT_BUILTIN_TOOLS must always be set (possibly empty)",
		);

		const value = result.env.BOBBIT_BUILTIN_TOOLS;
		const parts = value.length === 0 ? [] : value.split(",");

		// Sorted, no duplicates, no whitespace.
		assert.deepEqual(parts, [...parts].sort(), `BOBBIT_BUILTIN_TOOLS must be sorted, got: ${value}`);
		assert.deepEqual(parts, [...new Set(parts)], `BOBBIT_BUILTIN_TOOLS must have no duplicates, got: ${value}`);
		for (const p of parts) {
			assert.equal(p, p.trim(), `BOBBIT_BUILTIN_TOOLS entries must not have whitespace: ${JSON.stringify(p)}`);
		}

		// Must contain the file-builtins requested.
		assert.ok(parts.includes("read"), `expected 'read' in BOBBIT_BUILTIN_TOOLS, got: ${value}`);
		assert.ok(parts.includes("edit"), `expected 'edit' in BOBBIT_BUILTIN_TOOLS, got: ${value}`);

		// Must NOT contain 'bash' (special-cased — comes from shell/extension.ts).
		assert.ok(!parts.includes("bash"), `'bash' must not appear in BOBBIT_BUILTIN_TOOLS, got: ${value}`);
		// Must NOT contain Bobbit extensions.
		assert.ok(!parts.includes("web_fetch"), `'web_fetch' must not appear in BOBBIT_BUILTIN_TOOLS, got: ${value}`);

		// Exact-equality check via split-and-sort: pins the precise contract.
		assert.deepEqual(parts, ["edit", "read"], `BOBBIT_BUILTIN_TOOLS exact contents wrong, got: ${value}`);
	});

	it("Bobbit extension tools are loaded via --extension <baseDir>/<group>/extension.ts", () => {
		const tm = mockToolManager(representativeProviders());
		const tools: EffectiveTool[] = [
			{ kind: "yaml", name: "read" },
			{ kind: "yaml", name: "web_fetch" },
		];

		const result = computeToolActivationArgs(tools, tm);
		const exts = extensionPaths(result.args);

		const webExt = exts.find(p => p.endsWith("/web/extension.ts"));
		assert.ok(
			webExt,
			`expected web_fetch's extension path (…/web/extension.ts), got: ${JSON.stringify(exts)}`,
		);
	});
});
