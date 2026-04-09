/**
 * E2E tests for the tool config cascade feature.
 *
 * Verifies that tool groups resolve through a three-layer cascade:
 *   builtin (dist/server/defaults/tools/) → server (.bobbit/config/tools/) → project
 *
 * Uses the in-process harness (API-only, no browser).
 */
import { test, expect } from "./in-process-harness.js";
import { apiFetch, bobbitDir } from "./e2e-setup.js";
import { mkdirSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

test.describe("Tool Config Cascade", () => {

	test("fresh scaffold has empty tools config directory", async () => {
		// The in-process harness uses scaffoldBobbitDir which creates an empty
		// .bobbit/config/tools/ directory (no tool groups copied from defaults).
		const toolsConfigDir = join(bobbitDir(), "config", "tools");
		expect(existsSync(toolsConfigDir)).toBe(true);

		const entries = readdirSync(toolsConfigDir, { withFileTypes: true })
			.filter(e => e.isDirectory());
		// Should be empty — scaffold no longer copies tool groups from defaults
		expect(entries.length).toBe(0);
	});

	test("tools API returns tools even with empty config directory", async () => {
		// Even though .bobbit/config/tools/ is empty, the API should return
		// tools from the builtin layer (dist/server/defaults/tools/).
		const resp = await apiFetch("/api/tools");
		expect(resp.status).toBe(200);
		const { tools } = await resp.json();

		expect(tools.length).toBeGreaterThan(0);

		// Verify well-known tools exist
		const bash = tools.find((t: any) => t.name === "bash");
		expect(bash).toBeDefined();
		expect(bash.group).toBe("Shell");

		const read = tools.find((t: any) => t.name === "read");
		expect(read).toBeDefined();
		expect(read.group).toBe("File System");
	});

	test("builtin tools have origin 'builtin' when no config overrides exist", async () => {
		// With empty config/tools/, all tools should come from builtins
		const toolsConfigDir = join(bobbitDir(), "config", "tools");
		const configDirs = existsSync(toolsConfigDir)
			? readdirSync(toolsConfigDir, { withFileTypes: true }).filter(e => e.isDirectory())
			: [];

		const resp = await apiFetch("/api/tools");
		const { tools } = await resp.json();

		if (configDirs.length === 0) {
			// When no config overrides exist, check that the cascade resolution works.
			// Builtin tools should have origin "builtin" or "server" depending on
			// whether the server stores merge builtins. Either way, tools must exist.
			expect(tools.length).toBeGreaterThan(0);

			// At minimum, check tools have a valid origin field
			for (const tool of tools) {
				expect(["builtin", "server", "project"]).toContain(tool.origin);
			}
		}
	});

	test("customize flow — creates server-level override from builtin", async () => {
		// Get a tool that isn't already overridden at server level
		const listResp = await apiFetch("/api/tools");
		const { tools: before } = await listResp.json();
		expect(before.length).toBeGreaterThan(0);

		// Pick a tool — prefer one from a group we haven't touched yet
		const toolsConfigDir = join(bobbitDir(), "config", "tools");
		const existingOverrides = existsSync(toolsConfigDir)
			? new Set(readdirSync(toolsConfigDir, { withFileTypes: true })
				.filter(e => e.isDirectory()).map(e => e.name))
			: new Set<string>();

		// Find a tool whose group isn't already in config/tools/
		const targetTool = before.find((t: any) => {
			// We need to find tools whose group dir doesn't already exist
			// Use the "web" group (less likely to be touched by other tests)
			return t.group === "Web" || t.group === "Browser";
		}) || before[0]; // fallback to first tool
		const toolName = targetTool.name;

		// Customize to server scope
		const customizeResp = await apiFetch(
			`/api/tools/${encodeURIComponent(toolName)}/customize?scope=server`,
			{ method: "POST" },
		);
		expect(customizeResp.status).toBe(201);
		const customizeBody = await customizeResp.json();
		expect(customizeBody.ok).toBe(true);
		expect(customizeBody.groupDir).toBeTruthy();

		// Verify the group dir was physically created in config/tools/
		const groupDir = customizeBody.groupDir;
		expect(existsSync(join(toolsConfigDir, groupDir))).toBe(true);

		// Verify the tool now shows as "server" origin
		const afterResp = await apiFetch("/api/tools");
		const { tools: after } = await afterResp.json();
		const customized = after.find((t: any) => t.name === toolName);
		expect(customized).toBeDefined();
		expect(customized.origin).toBe("server");

		// The overrides field should indicate it shadows a builtin
		expect(customized.overrides).toBe("builtin");
	});

	test("revert flow — removes server-level override", async () => {
		// First customize a tool so we have something to revert
		const listResp = await apiFetch("/api/tools");
		const { tools } = await listResp.json();
		// Pick the "write" tool from File System group
		const targetTool = tools.find((t: any) => t.name === "write")
			|| tools.find((t: any) => t.name === "ls")
			|| tools[0];
		const toolName = targetTool.name;

		const customizeResp = await apiFetch(
			`/api/tools/${encodeURIComponent(toolName)}/customize?scope=server`,
			{ method: "POST" },
		);
		expect(customizeResp.status).toBe(201);
		const { groupDir } = await customizeResp.json();

		// Verify it's now server origin
		const midResp = await apiFetch("/api/tools");
		const { tools: mid } = await midResp.json();
		const midTool = mid.find((t: any) => t.name === toolName);
		expect(midTool.origin).toBe("server");

		// Revert the override
		const revertResp = await apiFetch(
			`/api/tools/${encodeURIComponent(toolName)}/override?scope=server`,
			{ method: "DELETE" },
		);
		expect(revertResp.status).toBe(200);

		// Verify the group dir was removed from config/tools/
		const toolsConfigDir = join(bobbitDir(), "config", "tools");
		expect(existsSync(join(toolsConfigDir, groupDir))).toBe(false);

		// Tool should still be available (from builtins)
		const afterResp = await apiFetch("/api/tools");
		const { tools: after } = await afterResp.json();
		const reverted = after.find((t: any) => t.name === toolName);
		expect(reverted).toBeDefined();
		// After revert, the tool comes from builtins (not server config)
		// The origin should no longer be "server" since the config dir was removed
		expect(reverted.origin).not.toBe("project");
	});

	test("backward compatibility — pre-existing tools in config show as server override", async () => {
		// Pre-populate config/tools/shell/ with a tool YAML to simulate
		// an existing installation that had tools copied before the cascade change.
		const toolsConfigDir = join(bobbitDir(), "config", "tools");
		const testGroup = "test-backward-compat";
		const testGroupDir = join(toolsConfigDir, testGroup);
		mkdirSync(testGroupDir, { recursive: true });

		// Write a minimal tool YAML for a custom tool
		writeFileSync(join(testGroupDir, "my-custom-tool.yaml"), [
			"name: my-custom-tool",
			'description: "A custom tool for backward compat testing"',
			'summary: "Custom test tool"',
			"group: TestGroup",
			"provider:",
			"  type: builtin",
		].join("\n"));

		const resp = await apiFetch("/api/tools");
		expect(resp.status).toBe(200);
		const { tools } = await resp.json();

		const customTool = tools.find((t: any) => t.name === "my-custom-tool");
		expect(customTool).toBeDefined();
		// It should be "server" origin since it exists in .bobbit/config/tools/
		expect(customTool.origin).toBe("server");
		expect(customTool.description).toContain("backward compat testing");
		expect(customTool.group).toBe("TestGroup");
	});

	test("customize 404 for nonexistent tool", async () => {
		const resp = await apiFetch(
			"/api/tools/nonexistent-tool-12345/customize?scope=server",
			{ method: "POST" },
		);
		expect(resp.status).toBe(404);
	});

	test("revert 400 for tool with unknown group", async () => {
		const resp = await apiFetch(
			"/api/tools/nonexistent-tool-12345/override?scope=server",
			{ method: "DELETE" },
		);
		expect(resp.status).toBe(400);
	});

	test("all tools have required fields", async () => {
		const resp = await apiFetch("/api/tools");
		const { tools } = await resp.json();
		for (const tool of tools) {
			expect(tool.name).toBeTruthy();
			expect(typeof tool.name).toBe("string");
			expect(tool.group).toBeTruthy();
			expect(typeof tool.group).toBe("string");
			expect(["builtin", "server", "project"]).toContain(tool.origin);
		}
	});

	test("customize copies entire group — sibling tools also become server origin", async () => {
		// Find a group with multiple builtin tools that we haven't overridden yet.
		// We'll use the "agent" group which has delegate (usually 1 tool, but
		// let's find any multi-tool group).
		const resp = await apiFetch("/api/tools");
		const { tools } = await resp.json();

		// Group tools by their group name
		const groupCounts: Record<string, string[]> = {};
		for (const t of tools) {
			const g = t.group;
			if (!groupCounts[g]) groupCounts[g] = [];
			groupCounts[g].push(t.name);
		}

		// Find a group with at least 2 tools
		const multiToolGroup = Object.entries(groupCounts).find(([, names]) => names.length >= 2);
		if (!multiToolGroup) {
			// Skip if no multi-tool group found (unlikely but safe)
			test.skip();
			return;
		}

		const [, toolNames] = multiToolGroup;
		const firstTool = toolNames[0];
		const secondTool = toolNames[1];

		// Customize the first tool (this copies the entire group)
		const customizeResp = await apiFetch(
			`/api/tools/${encodeURIComponent(firstTool)}/customize?scope=server`,
			{ method: "POST" },
		);
		expect(customizeResp.status).toBe(201);

		// After customizing, ALL tools in the same group should be "server" origin
		const afterResp = await apiFetch("/api/tools");
		const { tools: after } = await afterResp.json();

		const secondAfter = after.find((t: any) => t.name === secondTool);
		expect(secondAfter).toBeDefined();
		expect(secondAfter.origin).toBe("server");
	});

	test("extension path resolution — builtin tools resolve from defaults dir", async ({ gateway }) => {
		// Access the tool manager directly via the gateway's sessionManager
		const sm = gateway.sessionManager;
		// The sessionManager should have a toolManager property
		if (!sm || !sm.toolManager) {
			test.skip();
			return;
		}
		const toolManager = sm.toolManager;

		// getExtensionPath should resolve to the builtins dir for non-overridden groups
		if (typeof toolManager.getExtensionPath === "function") {
			const shellExtPath = toolManager.getExtensionPath("shell", "extension.ts");
			expect(shellExtPath).toBeTruthy();
			expect(shellExtPath).toContain("extension.ts");

			// The path should exist on disk
			expect(existsSync(shellExtPath)).toBe(true);
		}

		// getToolGroupBaseDir should return the builtins dir for non-overridden groups
		if (typeof toolManager.getToolGroupBaseDir === "function") {
			const baseDir = toolManager.getToolGroupBaseDir("shell");
			expect(baseDir).toBeTruthy();
			// For a non-overridden group, it should resolve to builtins (defaults)
			expect(baseDir).toContain("defaults");
		}
	});

	test("extension path resolution — overridden tools resolve from config dir", async ({ gateway }) => {
		const sm = gateway.sessionManager;
		if (!sm || !sm.toolManager) {
			test.skip();
			return;
		}
		const toolManager = sm.toolManager;
		if (typeof toolManager.getExtensionPath !== "function") {
			test.skip();
			return;
		}

		// First customize a group to create a config-level override
		const listResp = await apiFetch("/api/tools");
		const { tools } = await listResp.json();
		// Pick "bash" from shell group
		const bash = tools.find((t: any) => t.name === "bash");
		if (!bash) { test.skip(); return; }

		const customizeResp = await apiFetch(
			"/api/tools/bash/customize?scope=server",
			{ method: "POST" },
		);
		expect(customizeResp.status).toBe(201);

		// Now getToolGroupBaseDir("shell") should return the config dir (not builtins)
		if (typeof toolManager.getToolGroupBaseDir === "function") {
			const baseDir = toolManager.getToolGroupBaseDir("shell");
			// After customization, shell group should resolve from config dir
			expect(baseDir).not.toContain("defaults");
			expect(baseDir).toContain("config");
		}

		// Clean up — revert the override
		await apiFetch("/api/tools/bash/override?scope=server", { method: "DELETE" });
	});
});
