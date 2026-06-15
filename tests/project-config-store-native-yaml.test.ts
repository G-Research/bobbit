/**
 * Unit tests for native-YAML migration in ProjectConfigStore.
 *
 * Verifies that the remaining two migrated fields:
 *   - config_directories
 *   - sandbox_tokens
 *
 * are stored as native YAML on disk; legacy JSON-string forms are still
 * accepted on load and lazily rewritten on next save.
 *
 * (qa_env / qa_max_duration_minutes / qa_max_scenarios used to be migrated
 *  fields but moved into per-component `config:` maps — see qa-testing-config.test.ts.)
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import yaml from "yaml";
import { ProjectConfigStore } from "../src/server/agent/project-config-store.js";
import { makeTmpDir } from "./helpers/tmp.ts";

let tmpDir: string;

function yamlPath(): string { return path.join(tmpDir, "project.yaml"); }
function readYaml(): Record<string, unknown> {
	return yaml.parse(fs.readFileSync(yamlPath(), "utf-8")) as Record<string, unknown>;
}
function writeYaml(content: string) {
	fs.writeFileSync(yamlPath(), content);
}

describe("ProjectConfigStore — native-YAML migrated fields", () => {
	beforeEach(() => {
		tmpDir = makeTmpDir("pcs-native-");
	});
	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	describe("pack_activation (pack-schema-v1 §6.7)", () => {
		it("round-trips disabled refs by scope + packName and emits native YAML", () => {
			const store = new ProjectConfigStore(tmpDir);
			store.setPackActivation("project", "artifacts", { tools: ["artifact_demo"], entrypoints: ["artifacts-deeplink"] });
			assert.deepEqual(store.getPackActivation("project", "artifacts"), { tools: ["artifact_demo"], entrypoints: ["artifacts-deeplink"] });
			// On-disk native YAML (NOT a JSON string).
			const onDisk = readYaml().pack_activation as Record<string, unknown>;
			assert.deepEqual(onDisk, { project: { artifacts: { tools: ["artifact_demo"], entrypoints: ["artifacts-deeplink"] } } });
			// Reload picks it up.
			const reloaded = new ProjectConfigStore(tmpDir);
			assert.deepEqual(reloaded.getPackActivation("project", "artifacts"), { tools: ["artifact_demo"], entrypoints: ["artifacts-deeplink"] });
		});

		it("an empty disabled set clears the pack override", () => {
			const store = new ProjectConfigStore(tmpDir);
			store.setPackActivation("server", "p", { roles: ["r"] });
			store.setPackActivation("server", "p", {});
			assert.deepEqual(store.getPackActivation("server", "p"), {});
			assert.equal(readYaml().pack_activation, undefined);
		});

		it("a default (unset) pack reads as all-enabled ({})", () => {
			const store = new ProjectConfigStore(tmpDir);
			assert.deepEqual(store.getPackActivation("project", "never-set"), {});
		});
	});

	describe("config_directories", () => {
		it("loads native YAML form", () => {
			writeYaml([
				"config_directories:",
				"  - path: /shared/skills",
				"    types:",
				"      - skills",
				"  - path: /team/tools",
				"    types: [tools, mcp]",
			].join("\n") + "\n");
			const store = new ProjectConfigStore(tmpDir);
			const dirs = store.getConfigDirectories();
			assert.equal(dirs.length, 2);
			assert.equal(dirs[0].path, "/shared/skills");
			assert.deepEqual(dirs[0].types, ["skills"]);
			assert.deepEqual(dirs[1].types, ["tools", "mcp"]);
			assert.equal(store.isDirty(), false);
		});

		it("loads legacy JSON-string form, then rewrites native on save", () => {
			const legacy = JSON.stringify([{ path: "/legacy", types: ["skills"] }]);
			writeYaml(`config_directories: '${legacy}'\n`);
			const store = new ProjectConfigStore(tmpDir);
			assert.equal(store.isDirty(), true);
			const dirs = store.getConfigDirectories();
			assert.equal(dirs.length, 1);
			assert.equal(dirs[0].path, "/legacy");

			// Trigger save by setting a directory.
			store.setConfigDirectories(dirs);
			const reloaded = readYaml();
			assert.ok(Array.isArray(reloaded.config_directories), "expected native array on disk");
			const written = JSON.stringify(reloaded);
			assert.equal(/\[\{\\"path\\"/.test(written), false, "no escaped JSON in YAML");
		});

		it("malformed legacy form falls back to default + warns", () => {
			writeYaml("config_directories: 'not-json'\n");
			const store = new ProjectConfigStore(tmpDir);
			assert.deepEqual(store.getConfigDirectories(), []);
		});

		it("round-trip set/save/load", () => {
			const store = new ProjectConfigStore(tmpDir);
			store.setConfigDirectories([{ path: "/a", types: ["skills", "mcp"] }]);
			const reloaded = new ProjectConfigStore(tmpDir);
			assert.deepEqual(reloaded.getConfigDirectories(), [{ path: "/a", types: ["skills", "mcp"] }]);
			assert.equal(reloaded.isDirty(), false);
		});
	});

	describe("sandbox_tokens", () => {
		it("loads native YAML form", () => {
			writeYaml([
				"sandbox_tokens:",
				"  - key: GITHUB_TOKEN",
				"    enabled: true",
				"  - key: NPM_TOKEN",
				"    enabled: false",
			].join("\n") + "\n");
			const store = new ProjectConfigStore(tmpDir);
			assert.deepEqual(store.getSandboxTokens(), [
				{ key: "GITHUB_TOKEN", enabled: true },
				{ key: "NPM_TOKEN", enabled: false },
			]);
			assert.equal(store.isDirty(), false);
		});

		it("loads legacy JSON-string form, marks dirty, native after save", () => {
			const legacy = JSON.stringify([{ key: "GITHUB_TOKEN", enabled: true }]);
			writeYaml(`sandbox_tokens: '${legacy}'\n`);
			const store = new ProjectConfigStore(tmpDir);
			assert.equal(store.isDirty(), true);
			store.setSandboxTokens(store.getSandboxTokens());
			const reloaded = readYaml();
			assert.ok(Array.isArray(reloaded.sandbox_tokens));
			const arr = reloaded.sandbox_tokens as any[];
			assert.equal(arr[0].key, "GITHUB_TOKEN");
			assert.equal(arr[0].enabled, true);
			assert.equal("value" in arr[0], false, "value field must not be persisted");
		});

		it("never persists `value` field to disk", () => {
			const store = new ProjectConfigStore(tmpDir);
			store.setSandboxTokens([{ key: "FOO", enabled: true, value: "secret-shouldnt-persist" }]);
			const reloaded = readYaml();
			const arr = reloaded.sandbox_tokens as any[];
			assert.equal(arr[0].value, undefined);
		});

		it("malformed legacy form falls back to default", () => {
			writeYaml("sandbox_tokens: '{nope'\n");
			const store = new ProjectConfigStore(tmpDir);
			assert.deepEqual(store.getSandboxTokens(), []);
		});
	});

	describe("back-compat surface (get/getAll)", () => {
		it("get('config_directories') returns JSON-stringified form", () => {
			const store = new ProjectConfigStore(tmpDir);
			store.setConfigDirectories([{ path: "/a", types: ["skills"] }]);
			const raw = store.get("config_directories");
			assert.equal(typeof raw, "string");
			assert.deepEqual(JSON.parse(raw!), [{ path: "/a", types: ["skills"] }]);
		});

		it("set('config_directories', JSON.stringify(...)) routes to typed setter", () => {
			const store = new ProjectConfigStore(tmpDir);
			store.set("config_directories", JSON.stringify([{ path: "/x", types: ["mcp"] }]));
			assert.deepEqual(store.getConfigDirectories(), [{ path: "/x", types: ["mcp"] }]);
			const onDisk = readYaml();
			assert.ok(Array.isArray(onDisk.config_directories));
		});
	});

	describe("on-disk integrity", () => {
		it("native YAML output contains zero JSON-encoded strings for migrated fields", () => {
			const store = new ProjectConfigStore(tmpDir);
			store.setConfigDirectories([{ path: "/a", types: ["skills"] }]);
			store.setSandboxTokens([{ key: "GITHUB_TOKEN", enabled: true }]);
			const text = fs.readFileSync(yamlPath(), "utf-8");
			// No escaped JSON: e.g. `"[{\"path\":...}]"`
			assert.equal(/\[\{\\"/.test(text), false, "no escaped JSON found in YAML");
			assert.equal(/'\{\\"/.test(text), false, "no escaped JSON found in YAML");
		});
	});
});
