import { afterEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ConfigCascade } from "../../../src/server/agent/config-cascade.js";
import { resolveGrantPolicy } from "../../../src/server/agent/tool-activation.js";
import { ToolManager, __resetToolScanCache } from "../../../src/server/agent/tool-manager.js";
import type { BuiltinConfigProvider } from "../../../src/server/agent/builtin-config.js";

const cleanupRoots: string[] = [];

afterEach(() => {
	for (const root of cleanupRoots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true });
	}
	__resetToolScanCache();
});

function writeSessionPrompt(configDir: string, policy: "ask" | "never", description: string): void {
	const groupDir = path.join(configDir, "tools", "agent");
	fs.mkdirSync(groupDir, { recursive: true });
	fs.writeFileSync(path.join(groupDir, "session_prompt.yaml"), [
		"name: session_prompt",
		`description: ${description}`,
		"summary: Prompt any live session",
		"params: [session_id, message]",
		"provider:",
		"  type: bobbit-extension",
		"  extension: extension.ts",
		"group: Agent",
		`grantPolicy: ${policy}`,
		"",
	].join("\n"));
	fs.writeFileSync(path.join(groupDir, "extension.ts"), "export default function extension() { return {}; }\n");
}

function createFixture(options: { projectOverride?: boolean } = {}) {
	__resetToolScanCache();
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "tool-resolution-parity-"));
	cleanupRoots.push(root);

	const builtinConfigDir = path.join(root, "builtin-config");
	const serverConfigDir = path.join(root, "server-config");
	const projectConfigDir = path.join(root, "project-config");
	const globalUserBase = path.join(root, "global-user");
	const builtinPacksDir = path.join(root, "builtin-packs");
	for (const dir of [builtinConfigDir, serverConfigDir, projectConfigDir, globalUserBase, builtinPacksDir]) {
		fs.mkdirSync(dir, { recursive: true });
	}

	writeSessionPrompt(builtinConfigDir, "never", "builtin session prompt");
	writeSessionPrompt(serverConfigDir, "ask", "server session prompt");
	if (options.projectOverride) {
		writeSessionPrompt(projectConfigDir, "ask", "project session prompt");
	}

	const builtinToolsDir = path.join(builtinConfigDir, "tools");
	const builtinManager = new ToolManager(path.join(root, "empty-builtin-config"), builtinToolsDir);
	const serverManager = new ToolManager(serverConfigDir, builtinToolsDir);
	const projectManager = new ToolManager(projectConfigDir, builtinToolsDir);
	const builtins = {
		getRoles: () => [],
		getTools: () => builtinManager.getAvailableTools(),
		getToolGroupPolicies: () => ({}),
	} as unknown as BuiltinConfigProvider;
	const serverStores = {
		getRoles: () => [],
		getTools: () => serverManager.getLocalTools(),
		getToolGroupPolicies: () => ({}),
	};
	const projectContextManager = {
		getOrCreate: (projectId: string) => projectId === "normal-project"
			? { toolManager: projectManager }
			: undefined,
	} as never;
	const cascade = new ConfigCascade(
		builtins,
		serverStores,
		projectContextManager,
		undefined,
		undefined,
		globalUserBase,
		builtinPacksDir,
	);

	return { builtinManager, cascade, projectManager };
}

describe("tool resolution parity", () => {
	it("uses an ordinary server user override as the project catalogue and runtime winner", () => {
		const { builtinManager, cascade, projectManager } = createFixture();
		const builtin = builtinManager.getToolByName("session_prompt");
		const catalogue = cascade.resolveTools("normal-project")
			.find((entry) => entry.item.name === "session_prompt");
		const runtime = projectManager.getToolByName("session_prompt");

		assert.equal(builtin?.grantPolicy, "never", "fixture must preserve the shipped default policy");
		assert.ok(catalogue, "catalogue fixture must resolve session_prompt");
		assert.equal(catalogue.origin, "server", "ordinary server user override must win the catalogue");
		assert.equal(catalogue.item.grantPolicy, "ask", "server fixture must explicitly elevate the policy");
		assert.ok(runtime, "project runtime fixture must resolve session_prompt");

		assert.deepEqual(
			{
				grantPolicy: runtime.grantPolicy,
				description: runtime.description,
				effectivePolicy: resolveGrantPolicy(runtime.name, runtime.group, undefined, projectManager),
			},
			{
				grantPolicy: catalogue.item.grantPolicy,
				description: catalogue.item.description,
				effectivePolicy: catalogue.item.grantPolicy,
			},
			"TOOL_RESOLUTION_PARITY_SERVER_OVERRIDE: project runtime must use the catalogue's server winner",
		);
	});

	it("keeps catalogue and runtime aligned when the same override is project-local", () => {
		const { cascade, projectManager } = createFixture({ projectOverride: true });
		const catalogue = cascade.resolveTools("normal-project")
			.find((entry) => entry.item.name === "session_prompt");
		const runtime = projectManager.getToolByName("session_prompt");

		assert.ok(catalogue);
		assert.ok(runtime);
		assert.equal(catalogue.origin, "project");
		assert.deepEqual(
			{ grantPolicy: runtime.grantPolicy, description: runtime.description },
			{ grantPolicy: catalogue.item.grantPolicy, description: catalogue.item.description },
		);
	});
});
