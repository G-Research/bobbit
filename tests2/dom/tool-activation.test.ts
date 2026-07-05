import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/tool-activation.spec.ts (v2-dom tier).
// Pure-logic port: computeToolActivationArgs maps role tool lists to
// pi-coding-agent CLI flags. No DOM — the mandatory bridge lines above are
// present for uniformity (harmless here). Same assertions as the legacy spec.
import { describe, expect, it } from "vitest";
import path from "node:path";
import { computeToolActivationArgs, type EffectiveTool } from "../../src/server/agent/tool-activation.js";
import type { ToolProvider } from "../../src/server/agent/tool-manager.js";

/** Tag flat names as `kind: "yaml"` — these tests don't exercise MCP meta-tools. */
function yamlTools(...names: string[]): EffectiveTool[] {
	return names.map(name => ({ kind: "yaml" as const, name }));
}

/** Provider with groupDir and baseDir — matches ToolManager.getToolProviders() return type */
type ProviderWithGroup = ToolProvider & { groupDir: string; baseDir: string };

/** Fake base dir for mock tool providers */
const MOCK_TOOLS_DIR = "/mock/tools";

/** Minimal mock that satisfies the ToolManager interface used by computeToolActivationArgs */
function mockToolManager(providers: Map<string, ProviderWithGroup>) {
	return {
		getToolProviders: () => providers,
		getExtensionPath: (groupDir: string, filename: string) => path.join(MOCK_TOOLS_DIR, groupDir, filename),
	} as any;
}

/** Standard provider map matching real tools/<group>/*.yaml definitions */
function standardProviders(): Map<string, ProviderWithGroup> {
	return new Map<string, ProviderWithGroup>([
		["read", { type: "builtin", tool: "read", groupDir: "filesystem", baseDir: MOCK_TOOLS_DIR }],
		["write", { type: "builtin", tool: "write", groupDir: "filesystem", baseDir: MOCK_TOOLS_DIR }],
		["edit", { type: "builtin", tool: "edit", groupDir: "filesystem", baseDir: MOCK_TOOLS_DIR }],
		["bash", { type: "builtin", tool: "bash", groupDir: "shell", baseDir: MOCK_TOOLS_DIR }],
		["grep", { type: "builtin", tool: "grep", groupDir: "filesystem", baseDir: MOCK_TOOLS_DIR }],
		["find", { type: "builtin", tool: "find", groupDir: "filesystem", baseDir: MOCK_TOOLS_DIR }],
		["ls", { type: "builtin", tool: "ls", groupDir: "filesystem", baseDir: MOCK_TOOLS_DIR }],
		["web_search", { type: "bobbit-extension", extension: "extension.ts", groupDir: "web", baseDir: MOCK_TOOLS_DIR }],
		["web_fetch", { type: "bobbit-extension", extension: "extension.ts", groupDir: "web", baseDir: MOCK_TOOLS_DIR }],
		["delegate", { type: "bobbit-extension", extension: "extension.ts", groupDir: "agent", baseDir: MOCK_TOOLS_DIR }],
		["browser_navigate", { type: "bobbit-extension", extension: "extension.ts", groupDir: "browser", baseDir: MOCK_TOOLS_DIR }],
		["browser_click", { type: "bobbit-extension", extension: "extension.ts", groupDir: "browser", baseDir: MOCK_TOOLS_DIR }],
		["task_create", { type: "bobbit-extension", extension: "extension.ts", groupDir: "tasks", baseDir: MOCK_TOOLS_DIR }],
		["team_spawn", { type: "bobbit-extension", extension: "extension.ts", groupDir: "team", baseDir: MOCK_TOOLS_DIR }],
		["bash_bg", { type: "bobbit-extension", extension: "extension.ts", groupDir: "shell", baseDir: MOCK_TOOLS_DIR }],
	]);
}

function extensionPaths(args: string[]): string[] {
	return args
		.filter((_a, i) => i > 0 && args[i - 1] === "--extension")
		.map(p => p.replace(/\\/g, "/"));
}

describe("computeToolActivationArgs", () => {
	it("no toolManager — fallback registers all file builtins via env, no extensions", () => {
		const result = computeToolActivationArgs(undefined, undefined);
		expect(result.args).toContain("--no-builtin-tools");
		expect(result.args).toContain("--no-extensions");
		expect(result.args).not.toContain("--tools");
		expect(result.args).not.toContain("--no-tools");
		expect(result.env.BOBBIT_BUILTIN_TOOLS).toBe("edit,find,grep,ls,read,write");
		// No --extension flags at all in the fallback (no toolManager → no resolved paths)
		expect(result.args.filter(a => a === "--extension").length).toBe(0);
	});

	it("no allowedTools — registers all file builtins and loads all bobbit extensions", () => {
		const tm = mockToolManager(standardProviders());
		const result = computeToolActivationArgs(undefined, tm);

		expect(result.args).toContain("--no-builtin-tools");
		expect(result.args).toContain("--no-extensions");
		expect(result.args).not.toContain("--tools");

		// All six file builtins re-registered via the env var
		expect(result.env.BOBBIT_BUILTIN_TOOLS).toBe("edit,find,grep,ls,read,write");

		const extPaths = extensionPaths(result.args);
		// _builtins extension is always loaded
		expect(extPaths.some(p => p.includes("/_builtins/extension.ts"))).toBe(true);
		// All bobbit-extension groups: shell, web, agent, browser, tasks, team
		expect(extPaths.some(p => p.includes("/shell/extension.ts"))).toBe(true);
		expect(extPaths.some(p => p.includes("/web/extension.ts"))).toBe(true);
		expect(extPaths.some(p => p.includes("/agent/extension.ts"))).toBe(true);
		expect(extPaths.some(p => p.includes("/browser/extension.ts"))).toBe(true);
		expect(extPaths.some(p => p.includes("/tasks/extension.ts"))).toBe(true);
		expect(extPaths.some(p => p.includes("/team/extension.ts"))).toBe(true);
	});

	it("empty allowedTools array — explicit empty allowlist registers NO tools (NOT all)", () => {
		const tm = mockToolManager(standardProviders());
		const withUndefined = computeToolActivationArgs(undefined, tm);
		const withEmpty = computeToolActivationArgs([] as EffectiveTool[], tm);

		// Unrestricted enables all six file builtins + every bobbit extension.
		expect(withUndefined.env.BOBBIT_BUILTIN_TOOLS).toBe("edit,find,grep,ls,read,write");
		expect(extensionPaths(withUndefined.args).some(p => p.includes("/web/extension.ts"))).toBe(true);

		// Explicit empty allowlist registers no builtins and no bobbit extensions.
		expect(withEmpty.env.BOBBIT_BUILTIN_TOOLS).toBe("");
		const emptyExtPaths = extensionPaths(withEmpty.args);
		// Only the always-on _builtins extension may appear; no functional tool groups.
		expect(emptyExtPaths.some(p => p.includes("/web/extension.ts"))).toBe(false);
		expect(emptyExtPaths.some(p => p.includes("/shell/extension.ts"))).toBe(false);
		expect(emptyExtPaths.some(p => p.includes("/browser/extension.ts"))).toBe(false);

		// They must therefore NOT be equal — the whole point of the distinction.
		expect(withEmpty.env.BOBBIT_BUILTIN_TOOLS).not.toEqual(withUndefined.env.BOBBIT_BUILTIN_TOOLS);
	});

	it("restricted to file builtins only — env lists them, no bobbit-extension paths", () => {
		const tm = mockToolManager(standardProviders());
		const result = computeToolActivationArgs(yamlTools("read", "write", "edit"), tm);

		expect(result.args).toContain("--no-builtin-tools");
		expect(result.env.BOBBIT_BUILTIN_TOOLS).toBe("edit,read,write");

		const extPaths = extensionPaths(result.args);
		// Only the _builtins extension; no bobbit feature extensions
		expect(extPaths.some(p => p.includes("/_builtins/extension.ts"))).toBe(true);
		expect(extPaths.some(p => p.includes("/web/"))).toBe(false);
		expect(extPaths.some(p => p.includes("/agent/"))).toBe(false);
		expect(extPaths.some(p => p.includes("/browser/"))).toBe(false);
	});

	it("restricted to bobbit extensions only — empty BOBBIT_BUILTIN_TOOLS, extensions loaded", () => {
		const tm = mockToolManager(standardProviders());
		const result = computeToolActivationArgs(yamlTools("web_search", "delegate"), tm);

		expect(result.args).toContain("--no-builtin-tools");
		// No file builtins requested → empty env
		expect(result.env.BOBBIT_BUILTIN_TOOLS).toBe("");

		const extPaths = extensionPaths(result.args);
		expect(extPaths.some(p => p.includes("/_builtins/extension.ts"))).toBe(true);
		expect(extPaths.some(p => p.includes("/web/extension.ts"))).toBe(true);
		expect(extPaths.some(p => p.includes("/agent/extension.ts"))).toBe(true);
		expect(extPaths.some(p => p.includes("/browser/extension.ts"))).toBe(false);
	});

	it("mixed builtins + bobbit extensions", () => {
		const tm = mockToolManager(standardProviders());
		const result = computeToolActivationArgs(yamlTools("read", "bash", "web_fetch", "browser_navigate"), tm);

		// `read` registered via _builtins; `bash` flows from shell/extension.ts (not the file-builtins set)
		expect(result.env.BOBBIT_BUILTIN_TOOLS).toBe("read");

		const extPaths = extensionPaths(result.args);
		expect(extPaths.some(p => p.includes("/_builtins/extension.ts"))).toBe(true);
		expect(extPaths.some(p => p.includes("/shell/extension.ts"))).toBe(true);
		expect(extPaths.some(p => p.includes("/web/extension.ts"))).toBe(true);
		expect(extPaths.some(p => p.includes("/browser/extension.ts"))).toBe(true);
	});

	it("deduplicates extension paths — web_search + web_fetch share web/extension.ts", () => {
		const tm = mockToolManager(standardProviders());
		const result = computeToolActivationArgs(yamlTools("web_search", "web_fetch"), tm);

		const extPaths = extensionPaths(result.args);
		const webExt = extPaths.filter(p => p.includes("/web/extension.ts"));
		expect(webExt.length).toBe(1); // deduplicated
	});

	it("unknown tools are skipped", () => {
		const tm = mockToolManager(standardProviders());
		const result = computeToolActivationArgs(yamlTools("read", "nonexistent_tool"), tm);

		expect(result.env.BOBBIT_BUILTIN_TOOLS).toBe("read");
		// Only _builtins extension — no extension for the unknown tool
		const extPaths = extensionPaths(result.args);
		const nonBuiltins = extPaths.filter(p => !p.includes("/_builtins/"));
		expect(nonBuiltins.length).toBe(0);
	});

	it("bobbit-extension tools are included as --extension flags", () => {
		const tm = mockToolManager(standardProviders());
		const result = computeToolActivationArgs(yamlTools("read", "task_create", "team_spawn"), tm);

		expect(result.env.BOBBIT_BUILTIN_TOOLS).toBe("read");
		const extPaths = extensionPaths(result.args);
		expect(extPaths.some(p => p.includes("/tasks/extension.ts"))).toBe(true);
		expect(extPaths.some(p => p.includes("/team/extension.ts"))).toBe(true);
	});

	it("shared extensions register all their tools — bash_bg pulls in shell/extension.ts (which provides bash)", () => {
		const tm = mockToolManager(standardProviders());
		const result = computeToolActivationArgs(yamlTools("read", "bash_bg"), tm);

		const extPaths = extensionPaths(result.args);
		expect(extPaths.some(p => p.includes("/shell/extension.ts"))).toBe(true);
	});

	it("shared extensions register all their tools — web_search includes web_fetch", () => {
		const tm = mockToolManager(standardProviders());
		const result = computeToolActivationArgs(yamlTools("read", "web_search"), tm);

		const extPaths = extensionPaths(result.args);
		expect(extPaths.some(p => p.includes("/web/extension.ts"))).toBe(true);
	});

	it("bash-only role — empty BOBBIT_BUILTIN_TOOLS, shell/extension.ts loaded", () => {
		const tm = mockToolManager(standardProviders());
		const result = computeToolActivationArgs(yamlTools("bash"), tm);

		// bash isn't a file builtin (it comes from shell/extension.ts), so the env var is empty
		expect(result.env.BOBBIT_BUILTIN_TOOLS).toBe("");
		const extPaths = extensionPaths(result.args);
		expect(extPaths.some(p => p.includes("/shell/extension.ts"))).toBe(true);
	});
});
