import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { computeEffectiveAllowedTools, computeToolActivationArgs, computeToolPolicies } from "../src/server/agent/tool-activation.ts";
import { ToolManager, type PiExtensionExternalTool, type ScopedToolContext } from "../src/server/agent/tool-manager.ts";

function makeManager(): { root: string; tm: ToolManager } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-pi-scope-"));
	const configDir = path.join(root, "config");
	const builtinDir = path.join(root, "builtin-tools");
	fs.mkdirSync(path.join(configDir, "tools"), { recursive: true });
	fs.mkdirSync(path.join(builtinDir, "_builtins"), { recursive: true });
	return { root, tm: new ToolManager(configDir, builtinDir) };
}

function tool(name: string, packName: string, packId: string, listName: string, scope = "project"): PiExtensionExternalTool {
	return { name, description: `${packName} ${name}`, packName, packId, listName, scope };
}

const projectA: ScopedToolContext = { scopeKey: "project:a", projectId: "a" };
const projectB: ScopedToolContext = { scopeKey: "project:b", projectId: "b" };
const globalCtx: ScopedToolContext = { scopeKey: "default" };

describe("scoped pi-extension tool isolation", () => {
	it("does not leak project-scoped pi tools across project contexts", () => {
		const { root, tm } = makeManager();
		try {
			tm.setScopedPiExtensionTools(globalCtx, [tool("global_pi", "Global Pack", "global", "global", "global-user")]);
			tm.setScopedPiExtensionTools(projectA, [tool("only_a", "Project A Pack", "pack-a", "a"), tool("overlap", "Project A Pack", "pack-a", "a")]);
			tm.setScopedPiExtensionTools(projectB, [tool("only_b", "Project B Pack", "pack-b", "b"), tool("overlap", "Project B Pack", "pack-b", "b")]);

			const namesA = tm.getAvailableTools(projectA).map((row) => row.name).sort();
			const namesB = tm.getAvailableTools(projectB).map((row) => row.name).sort();

			assert.ok(namesA.includes("global_pi"));
			assert.ok(namesB.includes("global_pi"));
			assert.ok(namesA.includes("only_a"));
			assert.ok(!namesA.includes("only_b"));
			assert.ok(namesB.includes("only_b"));
			assert.ok(!namesB.includes("only_a"));

			assert.equal(tm.getToolByName("overlap", projectA)?.providers?.[0]?.packName, "Project A Pack");
			assert.equal(tm.getToolByName("overlap", projectB)?.providers?.[0]?.packName, "Project B Pack");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps prompt docs, policy rows, and activation scoped to the active project", () => {
		const { root, tm } = makeManager();
		try {
			tm.setScopedPiExtensionTools(projectA, [tool("only_a", "Project A Pack", "pack-a", "a")]);
			tm.setScopedPiExtensionTools(projectB, [tool("only_b", "Project B Pack", "pack-b", "b")]);

			const docsA = tm.getToolDocsForPrompt(undefined, undefined, projectA);
			const docsB = tm.getToolDocsForPrompt(undefined, undefined, projectB);
			assert.match(docsA, /only_a/);
			assert.doesNotMatch(docsA, /only_b/);
			assert.match(docsB, /only_b/);
			assert.doesNotMatch(docsB, /only_a/);

			const allowedA = computeEffectiveAllowedTools(tm, undefined, undefined, undefined, projectA);
			assert.ok(allowedA.some((entry) => entry.kind === "pi-extension" && entry.name === "only_a"));
			assert.ok(!allowedA.some((entry) => entry.name === "only_b"));

			const policiesA = computeToolPolicies(tm, undefined, { toolPolicies: { only_a: "ask", only_b: "never" } }, undefined, projectA);
			assert.equal(policiesA.only_a.policy, "ask");
			assert.equal(policiesA.only_b, undefined);

			const activation = computeToolActivationArgs(allowedA, tm, undefined, undefined, undefined, projectA);
			const extPaths = activation.args.filter((_arg, i, args) => i > 0 && args[i - 1] === "--extension").map((p) => p.replace(/\\/g, "/"));
			assert.equal(extPaths.filter((p) => !p.endsWith("/_builtins/extension.ts")).length, 0);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
