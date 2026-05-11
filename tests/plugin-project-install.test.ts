/**
 * Unit tests for installing/uninstalling plugins into a project.
 *
 * Builds a tmpdir project config, points a synthetic DiscoveredPlugin at
 * workflow YAMLs in a tmpdir plugin, runs install/uninstall through the
 * ProjectConfigStore, and verifies:
 *   - plugin_workflows entries land with namespaced ids
 *   - re-install replaces the snapshot (idempotent)
 *   - uninstall drops snapshots
 *   - manifest errors block install
 *   - workflow files outside the plugin root are rejected
 *   - WorkflowStore.getAll() surfaces plugin workflows with namespaced ids and pluginSource set
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { ProjectConfigStore } from "../src/server/agent/project-config-store.ts";
import { InlineWorkflowStore } from "../src/server/agent/workflow-store.ts";
import { installPluginIntoProject, uninstallPluginFromProject } from "../src/server/plugins/project-install.ts";
import { readManifest } from "../src/server/plugins/plugin-manifest.ts";
import type { DiscoveredPlugin } from "../src/server/plugins/plugin-loader.ts";

let tmpRoot: string;

before(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-install-test-"));
});

after(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function newProject(): { cfg: ProjectConfigStore; configDir: string } {
	const configDir = fs.mkdtempSync(path.join(tmpRoot, "proj-"));
	const cfg = new ProjectConfigStore(configDir);
	return { cfg, configDir };
}

function makePlugin(opts: {
	name: string;
	version?: string;
	workflows?: { file: string; body: string }[];
	manifestExtra?: string;
}): DiscoveredPlugin {
	const root = fs.mkdtempSync(path.join(tmpRoot, `plug-${opts.name}-`));
	const workflowPaths: string[] = [];
	for (const w of opts.workflows ?? []) {
		const abs = path.join(root, w.file);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, w.body);
		workflowPaths.push(w.file);
	}
	const manifestYaml = [
		`name: ${opts.name}`,
		`version: ${opts.version ?? "1.0.0"}`,
		workflowPaths.length > 0 ? `contributes:\n  workflows: [${workflowPaths.join(", ")}]` : "",
		opts.manifestExtra ?? "",
	].filter(Boolean).join("\n");
	fs.writeFileSync(path.join(root, "plugin.yaml"), manifestYaml);
	const { manifest, errors } = readManifest(root);
	return {
		name: opts.name,
		path: path.resolve(root),
		source: "user",
		manifest,
		manifestErrors: errors,
	};
}

describe("installPluginIntoProject", () => {
	it("installs a plugin's workflow as a namespaced plugin_workflows entry", () => {
		const { cfg } = newProject();
		const plugin = makePlugin({
			name: "autoresearch",
			version: "0.1.0",
			workflows: [{
				file: "workflows/main.yaml",
				body: [
					"id: feature",
					"name: Autoresearch feature",
					"description: Idea → review → experiment",
					"gates:",
					"  - id: idea",
					"    name: Idea",
					"    content: true",
				].join("\n"),
			}],
		});

		const result = installPluginIntoProject(cfg, plugin);
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.deepEqual(result.workflowsInstalled, ["autoresearch::feature"]);
		}

		// Persistence check: re-load and confirm both records survive a round-trip.
		const fresh = new ProjectConfigStore(path.dirname((cfg as any).configFile));
		assert.equal(fresh.isPluginInstalled("autoresearch"), true);
		const installed = fresh.getInstalledPlugins();
		assert.equal(installed.length, 1);
		assert.equal(installed[0].version, "0.1.0");
		const wf = fresh.getPluginWorkflows();
		assert.equal(wf.length, 1);
		assert.equal(wf[0].source, "autoresearch");
		assert.equal(wf[0].id, "feature");
		assert.equal((wf[0].snapshot as any).name, "Autoresearch feature");
	});

	it("rejects install when the manifest has validation errors", () => {
		const { cfg } = newProject();
		// Force a manifest error via a malformed name.
		const plugin = makePlugin({ name: "ok-name" });
		plugin.manifestErrors = [{ field: "name", message: "must match ..." }];
		const result = installPluginIntoProject(cfg, plugin);
		assert.equal(result.ok, false);
		assert.match(result.ok === false ? result.error : "", /manifest has errors/);
		assert.equal(cfg.isPluginInstalled("ok-name"), false);
	});

	it("rejects workflow paths that escape the plugin root", () => {
		const { cfg } = newProject();
		// Hand-build a discovered plugin claiming to ship a workflow outside its root.
		// We can't write `../escape.yaml` through makePlugin's manifest builder safely,
		// so we doctor the manifest object directly.
		const plugin = makePlugin({ name: "evil" });
		plugin.manifest.contributes = { workflows: ["../escape.yaml"] };
		const result = installPluginIntoProject(cfg, plugin);
		assert.equal(result.ok, false);
		assert.match(result.ok === false ? result.error : "", /escapes plugin root/);
	});

	it("re-install replaces the prior install record and snapshot", () => {
		const { cfg } = newProject();
		const v1 = makePlugin({
			name: "ar",
			version: "0.1.0",
			workflows: [{ file: "w.yaml", body: "id: feature\nname: v1\ngates: []\n" }],
		});
		installPluginIntoProject(cfg, v1);
		assert.equal(cfg.getInstalledPlugins()[0].version, "0.1.0");
		assert.equal((cfg.getPluginWorkflows()[0].snapshot as any).name, "v1");

		const v2 = makePlugin({
			name: "ar",
			version: "0.2.0",
			workflows: [{ file: "w.yaml", body: "id: feature\nname: v2\ngates: []\n" }],
		});
		installPluginIntoProject(cfg, v2);
		assert.equal(cfg.getInstalledPlugins().length, 1);
		assert.equal(cfg.getInstalledPlugins()[0].version, "0.2.0");
		assert.equal((cfg.getPluginWorkflows()[0].snapshot as any).name, "v2");
	});

	it("rejects a plugin that ships duplicate workflow ids", () => {
		const { cfg } = newProject();
		const plugin = makePlugin({
			name: "dup",
			workflows: [
				{ file: "a.yaml", body: "id: same\nname: A\ngates: []\n" },
				{ file: "b.yaml", body: "id: same\nname: B\ngates: []\n" },
			],
		});
		const result = installPluginIntoProject(cfg, plugin);
		assert.equal(result.ok, false);
		assert.match(result.ok === false ? result.error : "", /duplicate workflow id/);
	});

	it("supports a single YAML file containing a map of id → workflow", () => {
		const { cfg } = newProject();
		const plugin = makePlugin({
			name: "multi",
			workflows: [{
				file: "bundle.yaml",
				body: [
					"feature:",
					"  name: Feature",
					"  gates: []",
					"bugfix:",
					"  name: Bugfix",
					"  gates: []",
				].join("\n"),
			}],
		});
		const result = installPluginIntoProject(cfg, plugin);
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.deepEqual(result.workflowsInstalled.sort(), ["multi::bugfix", "multi::feature"]);
		}
	});
});

describe("uninstallPluginFromProject", () => {
	it("removes the install record and snapshots; returns removed=true", () => {
		const { cfg } = newProject();
		const plugin = makePlugin({
			name: "plug",
			workflows: [{ file: "w.yaml", body: "id: x\nname: X\ngates: []\n" }],
		});
		installPluginIntoProject(cfg, plugin);
		assert.equal(cfg.isPluginInstalled("plug"), true);

		const r = uninstallPluginFromProject(cfg, "plug");
		assert.deepEqual(r, { ok: true, removed: true });
		assert.equal(cfg.isPluginInstalled("plug"), false);
		assert.equal(cfg.getPluginWorkflows().length, 0);
	});

	it("returns removed=false when nothing was installed under that name", () => {
		const { cfg } = newProject();
		const r = uninstallPluginFromProject(cfg, "unknown");
		assert.deepEqual(r, { ok: true, removed: false });
	});
});

describe("WorkflowStore merges plugin_workflows with namespaced ids", () => {
	it("getAll() returns user workflows + plugin workflows with pluginSource set", () => {
		const { cfg } = newProject();
		// User workflow (hand-authored in workflows: block).
		cfg.setWorkflows({
			mine: { name: "Mine", description: "", gates: [] } as any,
		});
		// Install a plugin workflow.
		const plugin = makePlugin({
			name: "ar",
			version: "0.1.0",
			workflows: [{ file: "w.yaml", body: "id: feature\nname: Plugin feature\ngates: []\n" }],
		});
		installPluginIntoProject(cfg, plugin);

		const wfStore = new InlineWorkflowStore(cfg);
		const all = wfStore.getAll();
		const byId = new Map(all.map(w => [w.id, w]));
		assert.ok(byId.has("mine"));
		assert.equal(byId.get("mine")?.pluginSource, undefined);
		assert.ok(byId.has("ar::feature"));
		assert.equal(byId.get("ar::feature")?.pluginSource?.name, "ar");
		assert.equal(byId.get("ar::feature")?.pluginSource?.version, "0.1.0");
		assert.equal(byId.get("ar::feature")?.pluginSource?.originalId, "feature");
	});

	it("after uninstall, plugin workflows no longer appear in getAll()", () => {
		const { cfg } = newProject();
		const plugin = makePlugin({
			name: "ar",
			workflows: [{ file: "w.yaml", body: "id: feature\nname: P\ngates: []\n" }],
		});
		installPluginIntoProject(cfg, plugin);
		const wfStore = new InlineWorkflowStore(cfg);
		assert.equal(wfStore.getAll().some(w => w.id === "ar::feature"), true);

		uninstallPluginFromProject(cfg, "ar");
		assert.equal(wfStore.getAll().some(w => w.id === "ar::feature"), false);
	});
});
