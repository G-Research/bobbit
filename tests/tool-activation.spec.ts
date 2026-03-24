import { test, expect } from "@playwright/test";
import { computeToolActivationArgs } from "../dist/server/agent/tool-activation.js";
import type { ToolProvider } from "../dist/server/agent/tool-manager.js";

/**
 * Unit tests for computeToolActivationArgs — the logic that maps role tool
 * lists to pi-coding-agent CLI flags.
 *
 * Uses a mock ToolManager to avoid filesystem dependency on tools/*.yaml.
 *
 * Run with:
 *   npx playwright test tests/tool-activation.spec.ts --config tests/playwright.config.ts
 */

/** Provider with groupDir — matches ToolManager.getToolProviders() return type */
type ProviderWithGroup = ToolProvider & { groupDir: string };

/** Minimal mock that satisfies the ToolManager interface used by computeToolActivationArgs */
function mockToolManager(providers: Map<string, ProviderWithGroup>) {
	return { getToolProviders: () => providers } as any;
}

/** Standard provider map matching real tools/<group>/*.yaml definitions */
function standardProviders(): Map<string, ProviderWithGroup> {
	return new Map<string, ProviderWithGroup>([
		["read", { type: "builtin", tool: "read", groupDir: "filesystem" }],
		["write", { type: "builtin", tool: "write", groupDir: "filesystem" }],
		["edit", { type: "builtin", tool: "edit", groupDir: "filesystem" }],
		["bash", { type: "builtin", tool: "bash", groupDir: "shell" }],
		["grep", { type: "builtin", tool: "grep", groupDir: "filesystem" }],
		["find", { type: "builtin", tool: "find", groupDir: "filesystem" }],
		["ls", { type: "builtin", tool: "ls", groupDir: "filesystem" }],
		["web_search", { type: "user-extension", extension: "web-research.ts", groupDir: "web" }],
		["web_fetch", { type: "user-extension", extension: "web-research.ts", groupDir: "web" }],
		["delegate", { type: "user-extension", extension: "delegate.ts", groupDir: "agent" }],
		["browser_navigate", { type: "user-extension", extension: "playwright/index.ts", groupDir: "browser" }],
		["browser_click", { type: "user-extension", extension: "playwright/index.ts", groupDir: "browser" }],
		["task_create", { type: "bobbit-extension", extension: "extension.ts", groupDir: "tasks" }],
		["team_spawn", { type: "bobbit-extension", extension: "extension.ts", groupDir: "team" }],
	]);
}

test.describe("computeToolActivationArgs", () => {
	test("no toolManager — fallback with all base tools and --no-extensions", () => {
		const result = computeToolActivationArgs(undefined, undefined);
		expect(result.args).toContain("--tools");
		expect(result.args).toContain("--no-extensions");
		const toolsIdx = result.args.indexOf("--tools");
		const toolsCsv = result.args[toolsIdx + 1];
		expect(toolsCsv).toContain("read");
		expect(toolsCsv).toContain("bash");
		expect(toolsCsv).toContain("edit");
		expect(toolsCsv).not.toContain("web_search"); // no extensions in fallback
	});

	test("no allowedTools — enables all builtins and all user extensions", () => {
		const tm = mockToolManager(standardProviders());
		const result = computeToolActivationArgs(undefined, tm);

		// Should have --tools with builtins (minus bash which is loaded separately)
		const toolsIdx = result.args.indexOf("--tools");
		expect(toolsIdx).toBeGreaterThanOrEqual(0);
		const toolsCsv = result.args[toolsIdx + 1];
		expect(toolsCsv).toContain("read");
		expect(toolsCsv).toContain("write");
		expect(toolsCsv).toContain("edit");
		expect(toolsCsv).not.toContain("bash"); // bash excluded — loaded by rpc-bridge

		// Should have --no-extensions (Bobbit controls loading)
		expect(result.args).toContain("--no-extensions");

		// User extensions should appear as --extension flags
		const extPaths = result.args
			.filter((_a, i) => i > 0 && result.args[i - 1] === "--extension")
			.map(p => p.replace(/\\/g, "/"));
		// web-research.ts (provides web_search + web_fetch), delegate.ts, playwright/index.ts
		expect(extPaths.some(p => p.endsWith("/extensions/web-research.ts"))).toBe(true);
		expect(extPaths.some(p => p.endsWith("/extensions/delegate.ts"))).toBe(true);
		expect(extPaths.some(p => p.endsWith("/extensions/playwright/index.ts"))).toBe(true);

		// Bobbit extensions (task_create, team_spawn) should NOT appear — handled by session-manager
		expect(extPaths.some(p => p.includes("tasks/extension"))).toBe(false);
		expect(extPaths.some(p => p.includes("team/extension"))).toBe(false);
	});

	test("empty allowedTools array — same as undefined (all tools)", () => {
		const tm = mockToolManager(standardProviders());
		const withUndefined = computeToolActivationArgs(undefined, tm);
		const withEmpty = computeToolActivationArgs([], tm);
		expect(withEmpty.args).toEqual(withUndefined.args);
	});

	test("restricted to builtins only — no extension flags", () => {
		const tm = mockToolManager(standardProviders());
		const result = computeToolActivationArgs(["read", "write", "edit"], tm);

		const toolsIdx = result.args.indexOf("--tools");
		expect(toolsIdx).toBeGreaterThanOrEqual(0);
		const toolsCsv = result.args[toolsIdx + 1];
		expect(toolsCsv).toBe("read,write,edit");

		expect(result.args).toContain("--no-extensions");
		// No --extension flags at all
		expect(result.args.filter(a => a === "--extension").length).toBe(0);
	});

	test("restricted to user extensions only — uses --no-tools", () => {
		const tm = mockToolManager(standardProviders());
		const result = computeToolActivationArgs(["web_search", "delegate"], tm);

		// No builtins requested → --no-tools
		expect(result.args).toContain("--no-tools");
		expect(result.args).not.toContain("--tools");

		const extPaths = result.args
			.filter((_a, i) => i > 0 && result.args[i - 1] === "--extension")
			.map(p => p.replace(/\\/g, "/"));
		expect(extPaths.some(p => p.endsWith("/extensions/web-research.ts"))).toBe(true);
		expect(extPaths.some(p => p.endsWith("/extensions/delegate.ts"))).toBe(true);
		// playwright not requested
		expect(extPaths.some(p => p.includes("playwright"))).toBe(false);
	});

	test("mixed builtins + user extensions", () => {
		const tm = mockToolManager(standardProviders());
		const result = computeToolActivationArgs(["read", "bash", "web_fetch", "browser_navigate"], tm);

		const toolsIdx = result.args.indexOf("--tools");
		expect(toolsIdx).toBeGreaterThanOrEqual(0);
		const toolsCsv = result.args[toolsIdx + 1];
		// bash is excluded (loaded by rpc-bridge), only read
		expect(toolsCsv).toBe("read");

		const extPaths = result.args
			.filter((_a, i) => i > 0 && result.args[i - 1] === "--extension")
			.map(p => p.replace(/\\/g, "/"));
		expect(extPaths.some(p => p.endsWith("/extensions/web-research.ts"))).toBe(true);
		expect(extPaths.some(p => p.endsWith("/extensions/playwright/index.ts"))).toBe(true);
	});

	test("deduplicates extension paths — web_search + web_fetch share web-research.ts", () => {
		const tm = mockToolManager(standardProviders());
		const result = computeToolActivationArgs(["web_search", "web_fetch"], tm);

		const extPaths = result.args
			.filter((_a, i) => i > 0 && result.args[i - 1] === "--extension")
			.map(p => p.replace(/\\/g, "/"));
		const webResearch = extPaths.filter(p => p.endsWith("/extensions/web-research.ts"));
		expect(webResearch.length).toBe(1); // deduplicated
	});

	test("unknown tools are skipped", () => {
		const tm = mockToolManager(standardProviders());
		const result = computeToolActivationArgs(["read", "nonexistent_tool"], tm);

		const toolsIdx = result.args.indexOf("--tools");
		const toolsCsv = result.args[toolsIdx + 1];
		expect(toolsCsv).toBe("read");
		// No extension for nonexistent tool
		expect(result.args.filter(a => a === "--extension").length).toBe(0);
	});

	test("bobbit-extension tools are silently skipped", () => {
		const tm = mockToolManager(standardProviders());
		const result = computeToolActivationArgs(["read", "task_create", "team_spawn"], tm);

		const toolsIdx = result.args.indexOf("--tools");
		const toolsCsv = result.args[toolsIdx + 1];
		expect(toolsCsv).toBe("read");
		// Bobbit extensions are not added as --extension flags
		const extPaths = result.args
			.filter((_a, i) => i > 0 && result.args[i - 1] === "--extension");
		expect(extPaths.length).toBe(0);
	});

	test("bash-only role — bash excluded from --tools, gets --no-tools", () => {
		const tm = mockToolManager(standardProviders());
		const result = computeToolActivationArgs(["bash"], tm);

		// bash is excluded (loaded by rpc-bridge), no other builtins → --no-tools
		expect(result.args).toContain("--no-tools");
		expect(result.args).not.toContain("--tools");
	});
});
