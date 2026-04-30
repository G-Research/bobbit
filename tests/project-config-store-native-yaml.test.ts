/**
 * Unit tests for native-YAML migration in ProjectConfigStore.
 *
 * Verifies that the five migrated fields:
 *   - config_directories
 *   - qa_env
 *   - sandbox_tokens
 *   - qa_max_duration_minutes
 *   - qa_max_scenarios
 *
 * are stored as native YAML on disk; legacy JSON-string / numeric-string
 * forms are still accepted on load and lazily rewritten on next save.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import yaml from "yaml";
import { ProjectConfigStore } from "../src/server/agent/project-config-store.js";

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
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pcs-native-"));
	});
	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
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

	describe("qa_env", () => {
		it("loads native YAML form", () => {
			writeYaml(["qa_env:", "  FOO: bar", "  BAZ: qux"].join("\n") + "\n");
			const store = new ProjectConfigStore(tmpDir);
			assert.deepEqual(store.getQaEnv(), { FOO: "bar", BAZ: "qux" });
			assert.equal(store.isDirty(), false);
		});

		it("loads legacy JSON-string form, then rewrites native", () => {
			writeYaml(`qa_env: '{"FOO":"bar"}'\n`);
			const store = new ProjectConfigStore(tmpDir);
			assert.equal(store.isDirty(), true);
			assert.deepEqual(store.getQaEnv(), { FOO: "bar" });
			store.setQaEnv(store.getQaEnv());
			const reloaded = readYaml();
			assert.ok(reloaded.qa_env && typeof reloaded.qa_env === "object" && !Array.isArray(reloaded.qa_env));
		});

		it("malformed legacy form falls back to default", () => {
			writeYaml("qa_env: '{not json'\n");
			const store = new ProjectConfigStore(tmpDir);
			assert.deepEqual(store.getQaEnv(), {});
		});

		it("round-trip set/save/load", () => {
			const store = new ProjectConfigStore(tmpDir);
			store.setQaEnv({ FOO: "bar" });
			const reloaded = new ProjectConfigStore(tmpDir);
			assert.deepEqual(reloaded.getQaEnv(), { FOO: "bar" });
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

	describe("qa_max_duration_minutes / qa_max_scenarios", () => {
		it("loads native number form", () => {
			writeYaml("qa_max_duration_minutes: 15\nqa_max_scenarios: 7\n");
			const store = new ProjectConfigStore(tmpDir);
			assert.equal(store.getQaMaxDurationMinutes(), 15);
			assert.equal(store.getQaMaxScenarios(), 7);
			assert.equal(store.isDirty(), false);
		});

		it("loads legacy quoted-numeric form, marks dirty, native after save", () => {
			writeYaml(`qa_max_duration_minutes: "20"\nqa_max_scenarios: "3"\n`);
			const store = new ProjectConfigStore(tmpDir);
			assert.equal(store.getQaMaxDurationMinutes(), 20);
			assert.equal(store.getQaMaxScenarios(), 3);
			assert.equal(store.isDirty(), true);
			store.setQaMaxDurationMinutes(store.getQaMaxDurationMinutes());
			const reloaded = readYaml();
			assert.equal(typeof reloaded.qa_max_duration_minutes, "number");
		});

		it("malformed legacy form falls back to default", () => {
			writeYaml("qa_max_duration_minutes: notanumber\n");
			const store = new ProjectConfigStore(tmpDir);
			assert.equal(store.getQaMaxDurationMinutes(), 10); // default
		});

		it("does NOT emit defaults on save when never explicitly set", () => {
			const store = new ProjectConfigStore(tmpDir);
			store.set("build_command", "npm run build"); // triggers save
			const written = readYaml();
			assert.equal(written.qa_max_duration_minutes, undefined);
			assert.equal(written.qa_max_scenarios, undefined);
		});

		it("round-trip", () => {
			const store = new ProjectConfigStore(tmpDir);
			store.setQaMaxDurationMinutes(42);
			store.setQaMaxScenarios(9);
			const reloaded = new ProjectConfigStore(tmpDir);
			assert.equal(reloaded.getQaMaxDurationMinutes(), 42);
			assert.equal(reloaded.getQaMaxScenarios(), 9);
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

		it("getWithDefaults() includes JSON-stringified migrated values for legacy callers", () => {
			const store = new ProjectConfigStore(tmpDir);
			store.setQaMaxDurationMinutes(15);
			const all = store.getWithDefaults();
			assert.equal(all.qa_max_duration_minutes, "15");
		});

		it("set('qa_max_duration_minutes', '15') accepts numeric string", () => {
			const store = new ProjectConfigStore(tmpDir);
			store.set("qa_max_duration_minutes", "15");
			assert.equal(store.getQaMaxDurationMinutes(), 15);
		});
	});

	describe("on-disk integrity", () => {
		it("native YAML output contains zero JSON-encoded strings for migrated fields", () => {
			const store = new ProjectConfigStore(tmpDir);
			store.setConfigDirectories([{ path: "/a", types: ["skills"] }]);
			store.setQaEnv({ FOO: "bar" });
			store.setSandboxTokens([{ key: "GITHUB_TOKEN", enabled: true }]);
			store.setQaMaxDurationMinutes(15);
			store.setQaMaxScenarios(3);
			const text = fs.readFileSync(yamlPath(), "utf-8");
			// No escaped JSON: e.g. `"[{\"path\":...}]"`
			assert.equal(/\[\{\\"/.test(text), false, "no escaped JSON found in YAML");
			assert.equal(/'\{\\"/.test(text), false, "no escaped JSON found in YAML");
			// qa_max_duration_minutes is NOT a quoted string
			assert.equal(/qa_max_duration_minutes:\s*"\d+"/.test(text), false, "numeric must not be quoted");
			assert.equal(/qa_max_duration_minutes:\s*\d+/.test(text), true, "numeric must be a real number");
		});
	});
});
