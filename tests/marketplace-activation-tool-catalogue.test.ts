/**
 * Unit — marketplace activation uses concrete tool names, not manifest tool groups.
 *
 * Pack manifests keep declaring tool GROUP directories (`contents.tools`), but
 * `pack_activation.tools` is keyed by actual tool name. These tests pin the
 * server-side expansion and runtime root wiring that keeps Marketplace toggles,
 * ConfigCascade, and ToolManager on the same key space.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
	buildMarketToolRootsForProject,
	readConcretePackToolsFromGroups,
} from "../src/server/server.ts";
import { BuiltinConfigProvider } from "../src/server/agent/builtin-config.ts";
import { ConfigCascade } from "../src/server/agent/config-cascade.ts";
import { ToolManager, __resetToolScanCache } from "../src/server/agent/tool-manager.ts";
import { computeEffectiveAllowedTools } from "../src/server/agent/tool-activation.ts";
import type { PackEntry } from "../src/server/agent/pack-types.ts";

let tmp: string;

function w(file: string, content: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content, "utf-8");
}

function tool(packDir: string, groupDir: string, file: string, name: string, desc: string): void {
	w(path.join(packDir, "tools", groupDir, file),
		`name: ${name}\ngroup: PR Walkthrough\ndescription: ${JSON.stringify(desc)}\n`);
}

function manifest(packDir: string, name: string, groups: string[]): void {
	w(path.join(packDir, "pack.yaml"),
		`name: ${name}\ndescription: Test pack\nversion: 1.0.0\ncontents:\n  roles: []\n  tools: [${groups.join(", ")}]\n  skills: []\n  entrypoints: []\n`);
}

function entry(packDir: string, name: string): PackEntry {
	return {
		id: `market:server:${name}`,
		kind: "market",
		scope: "server",
		path: packDir,
		readOnly: true,
		layout: "defaults-tree",
		manifest: {
			name,
			description: "Test pack",
			version: "1.0.0",
			contents: { roles: [], tools: ["pr-walkthrough"], skills: [], entrypoints: [] },
		},
	};
}

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "marketplace-tool-catalogue-"));
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe("activation catalogue tool expansion", () => {
	it("expands manifest tool groups to concrete YAML tool names and descriptions", () => {
		const packDir = path.join(tmp, "market-packs", "pr-walkthrough");
		tool(packDir, "pr-walkthrough", "readonly_bash.yaml", "readonly_bash", "Run read-only commands");
		tool(packDir, "pr-walkthrough", "bundle.yml", "read_pr_walkthrough_bundle", "Read the bundle");
		tool(packDir, "other-group", "ignored.yaml", "not_declared", "Ignored");

		const result = readConcretePackToolsFromGroups(packDir, ["pr-walkthrough", "../unsafe"]);

		assert.deepEqual([...result.tools].sort(), ["read_pr_walkthrough_bundle", "readonly_bash"]);
		assert.deepEqual(result.descriptions, {
			readonly_bash: "Run read-only commands",
			read_pr_walkthrough_bundle: "Read the bundle",
		});
	});
});

describe("runtime market tool roots", () => {
	it("places built-in first-party pack tool roots before installed roots and applies server-scope disabled tools", () => {
		const builtin = path.join(tmp, "builtin-packs", "pr-walkthrough");
		const installed = path.join(tmp, ".bobbit", "config", "market-packs", "user-pack");
		const global = path.join(tmp, "home", ".bobbit", "config", "market-packs", "global-pack");
		const project = path.join(tmp, "project", ".bobbit", "config", "market-packs", "project-pack");

		const roots = buildMarketToolRootsForProject({
			projectId: "p1",
			builtinEntries: [entry(builtin, "pr-walkthrough")],
			marketEntries(scope) {
				if (scope === "server") return [entry(installed, "user-pack")];
				if (scope === "global-user") return [entry(global, "global-pack")];
				return [entry(project, "project-pack")];
			},
			disabledTools(scope, _projectId, packName) {
				return scope === "server" && packName === "pr-walkthrough" ? ["readonly_bash"] : undefined;
			},
		});

		assert.deepEqual(roots.map((r) => path.relative(tmp, r.dir)), [
			path.join("builtin-packs", "pr-walkthrough", "tools"),
			path.join(".bobbit", "config", "market-packs", "user-pack", "tools"),
			path.join("home", ".bobbit", "config", "market-packs", "global-pack", "tools"),
			path.join("project", ".bobbit", "config", "market-packs", "project-pack", "tools"),
		]);
		assert.deepEqual(roots[0].disabledTools, ["readonly_bash"]);
		assert.equal(roots[1].disabledTools, undefined);
	});
});

describe("ConfigCascade disabled tool filtering for built-in packs", () => {
	it("filters built-in first-party pack tools by concrete tool name so siblings remain", () => {
		const defaultsDir = path.join(tmp, "defaults");
		const builtinPacksDir = path.join(tmp, "builtin-packs");
		const packDir = path.join(builtinPacksDir, "pr-walkthrough");
		fs.mkdirSync(defaultsDir, { recursive: true });
		manifest(packDir, "pr-walkthrough", ["pr-walkthrough"]);
		tool(packDir, "pr-walkthrough", "readonly_bash.yaml", "readonly_bash", "Disabled");
		tool(packDir, "pr-walkthrough", "bundle.yaml", "read_pr_walkthrough_bundle", "Still enabled");

		const cascade = new ConfigCascade(
			new BuiltinConfigProvider(defaultsDir),
			{ getRoles: () => [], getTools: () => [], getToolGroupPolicies: () => ({}) },
			{ getOrCreate: () => null } as any,
			undefined,
			undefined,
			undefined,
			builtinPacksDir,
		);
		cascade.setPackActivationProvider({
			disabled(scope, _projectId, packName) {
				return scope === "server" && packName === "pr-walkthrough" ? { tools: ["readonly_bash"] } : {};
			},
		});

		const names = cascade.resolveTools().map((r) => r.item.name).sort();
		assert.deepEqual(names, ["read_pr_walkthrough_bundle"]);
	});

	it("role effective-tool resolution only sees enabled concrete pack tools", () => {
		const configDir = path.join(tmp, "config");
		const defaultsDir = path.join(tmp, "defaults");
		const packDir = path.join(tmp, "builtin-packs", "pr-walkthrough");
		fs.mkdirSync(path.join(configDir, "tools"), { recursive: true });
		fs.mkdirSync(defaultsDir, { recursive: true });
		tool(packDir, "pr-walkthrough", "readonly_bash.yaml", "readonly_bash", "Disabled");
		tool(packDir, "pr-walkthrough", "bundle.yaml", "read_pr_walkthrough_bundle", "Still enabled");

		__resetToolScanCache();
		const tm = new ToolManager(configDir, defaultsDir);
		tm.setMarketToolRootsProvider(() => [
			{ dir: path.join(packDir, "tools"), disabledTools: ["readonly_bash"] },
		]);
		const allowed = computeEffectiveAllowedTools(
			tm,
			{ toolPolicies: { "PR Walkthrough": "allow" } },
			{ getGroupPolicy: (group) => group === "PR Walkthrough" ? "never" : null, getAll: () => ({ "PR Walkthrough": "never" }) },
		).map((t) => t.name).sort();

		assert.deepEqual(allowed, ["read_pr_walkthrough_bundle"]);
	});
});
