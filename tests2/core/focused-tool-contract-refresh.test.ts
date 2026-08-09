// v2-native — focused runtime contract regression. Listed in tests-map.json `v2Native`.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Value } from "@sinclair/typebox/value";
import { afterEach, describe, it } from "vitest";

import { ToolManager, __resetToolScanCache } from "../../src/server/agent/tool-manager.ts";
import { loadBobbitTools } from "./helpers/bobbit-harness.ts";
import { guardProcessEnv } from "./helpers/env-guard.ts";

guardProcessEnv();

const roots: string[] = [];

function writeDefinition(file: string, params: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, [
		"name: bobbit_read",
		"description: Read gateway state",
		"summary: Read gateway state",
		`params: [${params}]`,
		"provider:",
		"  type: bobbit-extension",
		"  extension: extension.ts",
		"group: Bobbit",
		"",
	].join("\n"), "utf8");
}

function restoreDirectoryTimes(dir: string, stat: fs.Stats): void {
	fs.utimesSync(dir, stat.atime, stat.mtime);
}

afterEach(() => {
	__resetToolScanCache();
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("focused tool contract refresh", () => {
	it("invalidates warmed prompt docs when a nested tool YAML contract changes", () => {
		process.env.BOBBIT_TOKEN = "focused-contract-token";
		process.env.BOBBIT_GATEWAY_URL = "https://focused-contract.invalid";
		const runtimeSchema = loadBobbitTools().get("bobbit_read")!.parameters;
		assert.equal(Value.Check(runtimeSchema, { operation: "health" }), true);
		assert.equal(Value.Check(runtimeSchema, { operation: "health", verbose: true }), false);

		const root = fs.mkdtempSync(path.join(os.tmpdir(), "focused-tool-contract-"));
		roots.push(root);
		const configDir = path.join(root, "config");
		const toolsDir = path.join(configDir, "tools");
		const builtinToolsDir = path.join(root, "defaults", "tools");
		const bobbitDir = path.join(builtinToolsDir, "bobbit");
		const definition = path.join(bobbitDir, "bobbit_read.yaml");
		fs.mkdirSync(toolsDir, { recursive: true });
		writeDefinition(definition, "operation, verbose?");
		const stableDirectoryTime = new Date("2020-01-02T03:04:05.000Z");
		fs.utimesSync(bobbitDir, stableDirectoryTime, stableDirectoryTime);
		fs.utimesSync(builtinToolsDir, stableDirectoryTime, stableDirectoryTime);

		__resetToolScanCache();
		const warmManager = new ToolManager(configDir, builtinToolsDir);
		const staleDocs = warmManager.getToolDocsForPrompt(["bobbit_read"]);
		assert.match(staleDocs, /bobbit_read\(operation, verbose\?\)/);

		const rootStat = fs.statSync(builtinToolsDir);
		const groupStat = fs.statSync(bobbitDir);
		writeDefinition(definition, "operation, goalId?");
		// A nested file replacement does not reliably change either parent directory
		// timestamp (and coarse filesystems can preserve it). Reproduce that upgrade
		// boundary explicitly while leaving the nested file's own metadata current.
		restoreDirectoryTimes(bobbitDir, groupStat);
		restoreDirectoryTimes(builtinToolsDir, rootStat);
		assert.equal(fs.statSync(bobbitDir).mtimeMs, groupStat.mtimeMs);
		assert.equal(fs.statSync(builtinToolsDir).mtimeMs, rootStat.mtimeMs);

		// Session refresh/reattach constructs a new manager in the same server process;
		// the process-wide scan cache must not preserve the old injected contract.
		const refreshedManager = new ToolManager(configDir, builtinToolsDir);
		const refreshedDocs = refreshedManager.getToolDocsForPrompt(["bobbit_read"]);
		assert.match(
			refreshedDocs,
			/bobbit_read\(operation, goalId\?\)/,
			"FOCUSED_TOOL_CONTRACT_CACHE_STALE: refreshed prompt still advertises the warmed nested YAML contract",
		);
		assert.doesNotMatch(refreshedDocs, /verbose/);
	});
});
