/**
 * TDD reproducing test for the spurious "no provider" console.warn fired by
 * `computeToolActivationArgs()` for MCP meta-tool names (e.g. `mcp_playwright`).
 *
 * Today, `computeEffectiveAllowedTools()` returns a flat `string[]` mixing
 * YAML-backed tools with MCP meta-tools, and `computeToolActivationArgs()`
 * walks every name through the YAML provider registry — emitting a noisy
 * `console.warn("Tool \"mcp_playwright\" has no provider …")` per MCP
 * meta-tool per session spawn.
 *
 * The fix tags the producer's return as `EffectiveTool[]` where
 *   `EffectiveTool = { kind: "yaml" | "mcp"; name: string }`
 * and dispatches on `kind` in the consumer. This test is written against the
 * **post-refactor API** so it fails today (type error against `string[]`)
 * and passes once the refactor lands.
 *
 * See issue-analysis gate for full context.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

const { computeToolActivationArgs } = await import("../src/server/agent/tool-activation.ts");
import type { ToolProvider } from "../src/server/agent/tool-manager.ts";
import path from "node:path";

type ProviderWithGroup = ToolProvider & { groupDir: string; baseDir: string };
const MOCK_TOOLS_DIR = "/mock/tools";

function mockToolManager(providers: Map<string, ProviderWithGroup>) {
	return {
		getToolProviders: () => providers,
		getExtensionPath: (groupDir: string, filename: string) =>
			path.join(MOCK_TOOLS_DIR, groupDir, filename),
	} as any;
}

/**
 * Production reality: `mcp_playwright` is NOT in the YAML provider registry.
 * Only YAML-backed tools (`read`, `bash_bg`, `mcp_describe`, …) appear there.
 */
function providersWithoutMcpMeta(): Map<string, ProviderWithGroup> {
	return new Map<string, ProviderWithGroup>([
		["read", { type: "builtin", tool: "read", groupDir: "filesystem", baseDir: MOCK_TOOLS_DIR }],
		["bash_bg", { type: "bobbit-extension", extension: "extension.ts", groupDir: "shell", baseDir: MOCK_TOOLS_DIR }],
		["mcp_describe", { type: "bobbit-extension", extension: "extension.ts", groupDir: "mcp", baseDir: MOCK_TOOLS_DIR }],
	]);
}

/** Capture console.warn into a buffer; restore on teardown. */
function captureWarn() {
	const buf: string[] = [];
	const orig = console.warn;
	console.warn = (...args: unknown[]) => {
		buf.push(args.map(a => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
	};
	return {
		buf,
		restore: () => {
			console.warn = orig;
		},
	};
}

describe("computeToolActivationArgs — MCP meta-tool warn suppression", () => {
	it("does NOT warn 'has no provider' for MCP meta-tools (kind: 'mcp')", () => {
		const tm = mockToolManager(providersWithoutMcpMeta());
		const cap = captureWarn();
		try {
			// Post-refactor API: EffectiveTool[] with `kind: "mcp"` for meta-tools.
			// MCP meta-tools are satisfied externally via `mcpExtensionPaths` and
			// must NOT be looked up in the YAML provider registry.
			const result = computeToolActivationArgs(
				[{ kind: "mcp", name: "mcp_playwright" }],
				tm,
				undefined,
				["/tmp/fake-mcp-ext.ts"],
			);

			// MCP extension path should still be appended via --extension.
			const idx = result.args.indexOf("--extension");
			assert.ok(idx >= 0, "expected at least one --extension arg");
			assert.ok(
				result.args.includes("/tmp/fake-mcp-ext.ts"),
				`expected --extension /tmp/fake-mcp-ext.ts in args, got: ${JSON.stringify(result.args)}`,
			);
		} finally {
			cap.restore();
		}

		// Post-fix: MCP meta-tools never reach the YAML provider lookup, so NO
		// 'has no provider' warn should fire at all when only kind:'mcp' entries
		// are passed. (Today the consumer treats the union object as an unknown
		// string and warns with '[object Object]' — also caught by this assertion.)
		const offending = cap.buf.filter(line => /has no provider/.test(line));
		assert.deepEqual(
			offending,
			[],
			`expected no 'has no provider' warn for kind:'mcp' input — got: ${JSON.stringify(offending)}`,
		);
	});

	it("DOES warn 'has no provider' for genuinely unknown YAML tool names (kind: 'yaml')", () => {
		const tm = mockToolManager(providersWithoutMcpMeta());
		const cap = captureWarn();
		try {
			computeToolActivationArgs(
				[{ kind: "yaml", name: "totally_bogus_tool" }],
				tm,
			);
		} finally {
			cap.restore();
		}

		const matched = cap.buf.filter(line =>
			/has no provider/.test(line) && /totally_bogus_tool/.test(line),
		);
		assert.ok(
			matched.length >= 1,
			`expected a 'has no provider' warn mentioning 'totally_bogus_tool' — got: ${JSON.stringify(cap.buf)}`,
		);
	});
});
