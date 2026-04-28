/**
 * Unit tests for migrateProjectYaml — see docs/design/multi-repo-components.md §1.3.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "yaml";

import { migrateProjectYaml } from "../src/server/state-migration/migrate-project-yaml.ts";

let tmpRoot: string;
let configDir: string;

function readYaml(file: string): Record<string, unknown> {
	return yaml.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
}

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "migrate-yaml-test-"));
	configDir = path.join(tmpRoot, ".bobbit", "config");
	fs.mkdirSync(configDir, { recursive: true });
});

describe("migrateProjectYaml", () => {
	it("synthesizes default component named after project from legacy keys", () => {
		const yamlFile = path.join(configDir, "project.yaml");
		fs.writeFileSync(yamlFile, yaml.stringify({
			build_command: "npm run build",
			test_command: "npm test",
			typecheck_command: "npm run check",
			test_unit_command: "npm run test:unit",
			test_e2e_command: "npm run test:e2e",
			worktree_setup_command: "npm ci",
			qa_start_command: "node server.js",  // project-level, must NOT move
			sandbox: "docker",
		}));

		const result = migrateProjectYaml({ configDir, projectName: "myapp" });

		assert.equal(result.migrated, true);
		assert.equal(result.componentName, "myapp");

		const out = readYaml(yamlFile);
		assert.ok(Array.isArray(out.components));
		const components = out.components as Array<Record<string, unknown>>;
		assert.equal(components.length, 1);
		const c = components[0];
		assert.equal(c.name, "myapp", "default component name MUST equal project name");
		assert.equal(c.repo, ".");
		assert.equal(c.worktree_setup_command, "npm ci");
		const cmds = c.commands as Record<string, string>;
		assert.equal(cmds.build, "npm run build");
		assert.equal(cmds.test, "npm test");
		assert.equal(cmds.check, "npm run check");
		assert.equal(cmds.unit, "npm run test:unit");
		assert.equal(cmds.e2e, "npm run test:e2e");

		// Project-level fields preserved.
		assert.equal(out.qa_start_command, "node server.js");
		assert.equal(out.sandbox, "docker");

		// Legacy command keys stripped.
		assert.equal(out.build_command, undefined);
		assert.equal(out.test_command, undefined);
		assert.equal(out.worktree_setup_command, undefined,
			"top-level worktree_setup_command should move onto the component");
	});

	it("drops empty/whitespace command values", () => {
		const yamlFile = path.join(configDir, "project.yaml");
		fs.writeFileSync(yamlFile, yaml.stringify({
			build_command: "npm run build",
			test_command: "",
			typecheck_command: "   ",
			test_unit_command: "npm run test:unit",
		}));

		migrateProjectYaml({ configDir, projectName: "x" });

		const out = readYaml(yamlFile);
		const c = (out.components as any[])[0];
		const cmds = c.commands as Record<string, string>;
		assert.deepEqual(Object.keys(cmds).sort(), ["build", "unit"]);
	});

	it("is idempotent — second run is a no-op", () => {
		const yamlFile = path.join(configDir, "project.yaml");
		fs.writeFileSync(yamlFile, yaml.stringify({
			build_command: "npm run build",
		}));

		const r1 = migrateProjectYaml({ configDir, projectName: "p" });
		assert.equal(r1.migrated, true);
		const after1 = fs.readFileSync(yamlFile, "utf-8");

		const r2 = migrateProjectYaml({ configDir, projectName: "p" });
		assert.equal(r2.migrated, false, "second run must not migrate again");
		const after2 = fs.readFileSync(yamlFile, "utf-8");
		assert.equal(after1, after2, "file must be byte-identical after no-op migration");
	});

	it("skips when components: already present", () => {
		const yamlFile = path.join(configDir, "project.yaml");
		fs.writeFileSync(yamlFile, yaml.stringify({
			components: [{ name: "preset", repo: "." }],
			build_command: "should-not-move",
		}));

		const result = migrateProjectYaml({ configDir, projectName: "different-name" });
		assert.equal(result.migrated, false);

		const out = readYaml(yamlFile);
		const components = out.components as any[];
		assert.equal(components[0].name, "preset", "existing components[] must be left alone");
		assert.equal(out.build_command, "should-not-move", "legacy keys preserved when skipping");
	});

	it("migrates .bobbit/config/workflows/*.yaml into inline workflows: block and removes the dir", () => {
		const yamlFile = path.join(configDir, "project.yaml");
		fs.writeFileSync(yamlFile, yaml.stringify({ build_command: "npm run build" }));

		const wfDir = path.join(configDir, "workflows");
		fs.mkdirSync(wfDir, { recursive: true });
		fs.writeFileSync(path.join(wfDir, "general.yaml"), yaml.stringify({
			id: "general",
			name: "General",
			gates: [{ id: "implementation", name: "Implementation" }],
		}));
		fs.writeFileSync(path.join(wfDir, "feature.yaml"), yaml.stringify({
			id: "feature",
			name: "Feature",
			gates: [{ id: "design-doc", name: "Design Document" }],
		}));

		const result = migrateProjectYaml({ configDir, projectName: "p" });
		assert.equal(result.migrated, true);
		assert.equal(result.workflowsMigrated, 2);
		assert.equal(result.workflowsDirRemoved, true);

		const out = readYaml(yamlFile);
		const wf = out.workflows as Record<string, any>;
		assert.equal(wf.general.id, "general");
		assert.equal(wf.feature.name, "Feature");
		assert.equal(fs.existsSync(wfDir), false, "workflows directory must be removed after migration");
	});

	it("passes through extra *_command keys with suffix stripped", () => {
		const yamlFile = path.join(configDir, "project.yaml");
		fs.writeFileSync(yamlFile, yaml.stringify({
			build_command: "npm run build",
			migrate_command: "npm run db:migrate",
			seed_command: "npm run seed",
		}));

		migrateProjectYaml({ configDir, projectName: "p" });

		const out = readYaml(yamlFile);
		const cmds = (out.components as any[])[0].commands as Record<string, string>;
		assert.equal(cmds.migrate, "npm run db:migrate");
		assert.equal(cmds.seed, "npm run seed");
		assert.equal(out.migrate_command, undefined, "extra *_command keys should be moved, not duplicated");
	});

	it("handles empty file with no legacy commands by writing a data-only default component", () => {
		const yamlFile = path.join(configDir, "project.yaml");
		fs.writeFileSync(yamlFile, "");

		const result = migrateProjectYaml({ configDir, projectName: "bare" });
		assert.equal(result.migrated, true);

		const out = readYaml(yamlFile);
		const components = out.components as any[];
		assert.equal(components[0].name, "bare");
		assert.equal(components[0].repo, ".");
		assert.equal(components[0].commands, undefined, "no commands when none were detected (data-only)");
	});
});
