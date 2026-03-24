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
		["web_search", { type: "bobbit-extension", extension: "extension.ts", groupDir: "web" }],
		["web_fetch", { type: "bobbit-extension", extension: "extension.ts", groupDir: "web" }],
		["delegate", { type: "bobbit-extension", extension: "extension.ts", groupDir: "agent" }],
		["browser_navigate", { type: "bobbit-extension", extension: "extension.ts", groupDir: "browser" }],
		["browser_click", { type: "bobbit-extension", extension: "extension.ts", groupDir: "browser" }],
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

	test("no allowedTools — enables all builtins and all bobbit extensions", () => {
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

		// Bobbit extensions should appear as --extension flags
		const extPaths = result.args
			.filter((_a, i) => i > 0 && result.args[i - 1] === "--extension")
			.map(p => p.replace(/\\/g, "/"));
		// All bobbit-extension groups: web, agent, browser, tasks, team
		expect(extPaths.some(p => p.includes("/web/extension.ts"))).toBe(true);
		expect(extPaths.some(p => p.includes("/agent/extension.ts"))).toBe(true);
		expect(extPaths.some(p => p.includes("/browser/extension.ts"))).toBe(true);
		expect(extPaths.some(p => p.includes("/tasks/extension.ts"))).toBe(true);
		expect(extPaths.some(p => p.includes("/team/extension.ts"))).toBe(true);
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

	test("restricted to bobbit extensions only — uses --no-tools", () => {
		const tm = mockToolManager(standardProviders());
		const result = computeToolActivationArgs(["web_search", "delegate"], tm);

		// No builtins requested → --no-tools
		expect(result.args).toContain("--no-tools");
		expect(result.args).not.toContain("--tools");

		const extPaths = result.args
			.filter((_a, i) => i > 0 && result.args[i - 1] === "--extension")
			.map(p => p.replace(/\\/g, "/"));
		expect(extPaths.some(p => p.includes("/web/extension.ts"))).toBe(true);
		expect(extPaths.some(p => p.includes("/agent/extension.ts"))).toBe(true);
		// browser not requested
		expect(extPaths.some(p => p.includes("/browser/extension.ts"))).toBe(false);
	});

	test("mixed builtins + bobbit extensions", () => {
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
		expect(extPaths.some(p => p.includes("/web/extension.ts"))).toBe(true);
		expect(extPaths.some(p => p.includes("/browser/extension.ts"))).toBe(true);
	});

	test("deduplicates extension paths — web_search + web_fetch share web/extension.ts", () => {
		const tm = mockToolManager(standardProviders());
		const result = computeToolActivationArgs(["web_search", "web_fetch"], tm);

		const extPaths = result.args
			.filter((_a, i) => i > 0 && result.args[i - 1] === "--extension")
			.map(p => p.replace(/\\/g, "/"));
		const webExt = extPaths.filter(p => p.includes("/web/extension.ts"));
		expect(webExt.length).toBe(1); // deduplicated
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

	test("bobbit-extension tools are included as --extension flags", () => {
		const tm = mockToolManager(standardProviders());
		const result = computeToolActivationArgs(["read", "task_create", "team_spawn"], tm);

		const toolsIdx = result.args.indexOf("--tools");
		const toolsCsv = result.args[toolsIdx + 1];
		expect(toolsCsv).toBe("read");
		// Bobbit extensions are added as --extension flags
		const extPaths = result.args
			.filter((_a, i) => i > 0 && result.args[i - 1] === "--extension")
			.map(p => p.replace(/\\/g, "/"));
		expect(extPaths.some(p => p.includes("/tasks/extension.ts"))).toBe(true);
		expect(extPaths.some(p => p.includes("/team/extension.ts"))).toBe(true);
	});

	test("bash-only role — bash excluded from --tools, gets --no-tools", () => {
		const tm = mockToolManager(standardProviders());
		const result = computeToolActivationArgs(["bash"], tm);

		// bash is excluded (loaded by rpc-bridge), no other builtins → --no-tools
		expect(result.args).toContain("--no-tools");
		expect(result.args).not.toContain("--tools");
	});
});
