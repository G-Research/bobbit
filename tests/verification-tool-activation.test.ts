import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { buildVerificationToolActivation } = await import("../src/server/agent/verification-harness.ts");
import type { ToolProvider } from "../src/server/agent/tool-manager.ts";

type ProviderWithPath = ToolProvider & { groupDir: string; baseDir: string };

const MOCK_TOOLS_DIR = "/mock/tools";

function providerMap(): Map<string, ProviderWithPath> {
	return new Map<string, ProviderWithPath>([
		["read", { type: "builtin", tool: "read", groupDir: "filesystem", baseDir: MOCK_TOOLS_DIR }],
		["edit", { type: "builtin", tool: "edit", groupDir: "filesystem", baseDir: MOCK_TOOLS_DIR }],
		["bash", { type: "builtin", tool: "bash", groupDir: "shell", baseDir: MOCK_TOOLS_DIR }],
		["web_fetch", { type: "bobbit-extension", extension: "extension.ts", groupDir: "web", baseDir: MOCK_TOOLS_DIR }],
		["browser_click", { type: "bobbit-extension", extension: "extension.ts", groupDir: "browser", baseDir: MOCK_TOOLS_DIR }],
		["dangerous_extension", { type: "bobbit-extension", extension: "extension.ts", groupDir: "danger", baseDir: MOCK_TOOLS_DIR }],
	]);
}

function mockToolManager() {
	const providers = providerMap();
	const groups: Record<string, string> = {
		read: "File System",
		edit: "File System",
		bash: "Shell",
		web_fetch: "Web",
		browser_click: "Browser",
		dangerous_extension: "Danger",
	};
	return {
		getToolProviders: () => providers,
		getAvailableTools: () => [...providers.keys()].map(name => ({ name, group: groups[name] ?? "Other" })),
		getToolByName: (name: string) => providers.has(name) ? { name, group: groups[name] ?? "Other" } : undefined,
		getExtensionPath: (groupDir: string, filename: string) => path.join(MOCK_TOOLS_DIR, groupDir, filename),
	} as any;
}

function extensionPaths(args: string[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--extension" && i + 1 < args.length) out.push(args[i + 1].replace(/\\/g, "/"));
	}
	return out;
}

beforeEach(() => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-verification-tools-"));
	process.env.BOBBIT_DIR = path.join(dir, ".bobbit");
});

describe("verification direct sub-session tool activation", () => {
	it("uses the safe activation contract instead of Pi's unified --tools allowlist", () => {
		const result = buildVerificationToolActivation("review-session", process.cwd(), {
			toolPolicies: {
				read: "allow",
				bash: "allow",
				web_fetch: "allow",
			},
		}, { toolManager: mockToolManager() });

		assert.ok(result.args.includes("--no-builtin-tools"), `expected --no-builtin-tools, got ${JSON.stringify(result.args)}`);
		assert.ok(result.args.includes("--no-extensions"), `expected --no-extensions, got ${JSON.stringify(result.args)}`);
		assert.ok(!result.args.includes("--tools"), `verification sub-sessions must not use --tools, got ${JSON.stringify(result.args)}`);
		assert.deepEqual(result.env.BOBBIT_BUILTIN_TOOLS.split(","), ["edit", "read"]);

		const exts = extensionPaths(result.args);
		assert.ok(exts.some(p => p.endsWith("/_builtins/extension.ts")), `expected _builtins extension, got ${JSON.stringify(exts)}`);
		assert.ok(exts.some(p => p.endsWith("/shell/extension.ts")), `expected shell extension for bash, got ${JSON.stringify(exts)}`);
		assert.ok(exts.some(p => p.endsWith("/web/extension.ts")), `expected Bobbit web extension to survive, got ${JSON.stringify(exts)}`);
	});

	it("adds the guard extension and omits never-policy tools without stripping allowed Bobbit extensions", () => {
		const result = buildVerificationToolActivation("review-session-guarded", process.cwd(), {
			toolPolicies: {
				read: "allow",
				web_fetch: "allow",
				browser_click: "ask",
				dangerous_extension: "never",
			},
		}, { toolManager: mockToolManager() });

		assert.ok(!result.args.includes("--tools"), `verification sub-sessions must not use --tools, got ${JSON.stringify(result.args)}`);
		const allowed = result.allowedTools?.sort() ?? [];
		assert.ok(allowed.includes("browser_click"), `expected ask-policy browser tool to remain registered, got ${JSON.stringify(allowed)}`);
		assert.ok(allowed.includes("web_fetch"), `expected allowed Bobbit extension to remain registered, got ${JSON.stringify(allowed)}`);
		assert.ok(!allowed.includes("dangerous_extension"), `never-policy tool must be omitted, got ${JSON.stringify(allowed)}`);

		const exts = extensionPaths(result.args);
		assert.ok(exts.some(p => p.endsWith("/web/extension.ts")), `expected web extension, got ${JSON.stringify(exts)}`);
		assert.ok(exts.some(p => p.endsWith("/browser/extension.ts")), `expected browser extension for ask tool, got ${JSON.stringify(exts)}`);
		assert.ok(exts.some(p => p.includes("/tool-guard/") && p.endsWith("/guard.ts")), `expected guard extension, got ${JSON.stringify(exts)}`);
		assert.ok(!exts.some(p => p.endsWith("/danger/extension.ts")), `never-policy extension must not load, got ${JSON.stringify(exts)}`);
	});
});
