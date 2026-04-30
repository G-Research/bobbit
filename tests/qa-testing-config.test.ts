import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ProjectConfigStore } from "../src/server/agent/project-config-store.js";

describe("QaTestingConfig", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ev-config-test-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns null when no qa_start_command configured", () => {
		fs.writeFileSync(path.join(tmpDir, "project.yaml"), "name: test\n");
		const store = new ProjectConfigStore(tmpDir);
		assert.equal(store.getQaTestingConfig(), null);
	});

	it("parses qa_* keys into typed config", () => {
		const yaml = [
			"name: test",
			"build_command: npm run build",
			'qa_build_command: "npm run build:prod"',
			'qa_start_command: "node server.js --port $PORT"',
			'qa_health_check: "http://127.0.0.1:$PORT/health"',
			'qa_browser_entry: "http://127.0.0.1:$PORT/?token=$TOKEN"',
			"qa_env: '{\"FOO\":\"bar\"}'",
			'qa_max_duration_minutes: "15"',
			'qa_max_scenarios: "3"',
		].join("\n");
		fs.writeFileSync(path.join(tmpDir, "project.yaml"), yaml);
		const store = new ProjectConfigStore(tmpDir);
		const config = store.getQaTestingConfig();
		assert.ok(config);
		assert.equal(config.buildCommand, "npm run build:prod");
		assert.equal(config.startCommand, "node server.js --port $PORT");
		assert.equal(config.healthCheck, "http://127.0.0.1:$PORT/health");
		assert.equal(config.browserEntry, "http://127.0.0.1:$PORT/?token=$TOKEN");
		assert.deepEqual(config.env, { FOO: "bar" });
		assert.equal(config.maxDurationMinutes, 15);
		assert.equal(config.maxScenarios, 3);
	});

	it("falls back to build_command when qa_build_command not set", () => {
		const yaml = [
			"build_command: npm run mybuild",
			'qa_start_command: "node server.js"',
		].join("\n");
		fs.writeFileSync(path.join(tmpDir, "project.yaml"), yaml);
		const store = new ProjectConfigStore(tmpDir);
		const config = store.getQaTestingConfig();
		assert.ok(config);
		assert.equal(config.buildCommand, "npm run mybuild");
	});

	it("falls back to components[0].commands.build when qa_build_command and legacy build_command not set", () => {
		const yaml = [
			"components:",
			"  - name: myapp",
			"    repo: .",
			"    commands:",
			"      build: npm run component-build",
			'qa_start_command: "node server.js"',
		].join("\n");
		fs.writeFileSync(path.join(tmpDir, "project.yaml"), yaml);
		const store = new ProjectConfigStore(tmpDir);
		const config = store.getQaTestingConfig();
		assert.ok(config);
		assert.equal(config.buildCommand, "npm run component-build");
	});

	it("prefers component build over default `build_command` from DEFAULTS map", () => {
		// With Follow-up A landed, top-level build_command no longer exists in user yaml,
		// but the DEFAULTS map still defines it as `npm run build`. The new fallback chain
		// must prefer a real component-defined build over the inert default.
		const yaml = [
			"components:",
			"  - name: api",
			"    repo: .",
			"    commands:",
			"      build: cargo build --release",
			'qa_start_command: "./target/release/api"',
		].join("\n");
		fs.writeFileSync(path.join(tmpDir, "project.yaml"), yaml);
		const store = new ProjectConfigStore(tmpDir);
		const config = store.getQaTestingConfig();
		assert.ok(config);
		assert.equal(config.buildCommand, "cargo build --release");
	});

	it("parses native-YAML qa_* keys (post-migration)", () => {
		const yaml = [
			"name: test",
			"build_command: npm run build",
			'qa_start_command: "node server.js"',
			"qa_env:",
			"  FOO: bar",
			"  BAZ: qux",
			"qa_max_duration_minutes: 15",
			"qa_max_scenarios: 3",
		].join("\n");
		fs.writeFileSync(path.join(tmpDir, "project.yaml"), yaml);
		const store = new ProjectConfigStore(tmpDir);
		const config = store.getQaTestingConfig();
		assert.ok(config);
		assert.deepEqual(config.env, { FOO: "bar", BAZ: "qux" });
		assert.equal(config.maxDurationMinutes, 15);
		assert.equal(config.maxScenarios, 3);
	});

	it("uses defaults for optional fields", () => {
		const yaml = 'qa_start_command: "node server.js"\n';
		fs.writeFileSync(path.join(tmpDir, "project.yaml"), yaml);
		const store = new ProjectConfigStore(tmpDir);
		const config = store.getQaTestingConfig();
		assert.ok(config);
		assert.equal(config.maxDurationMinutes, 10);
		assert.equal(config.maxScenarios, 5);
		assert.deepEqual(config.env, {});
		assert.equal(config.healthCheck, "");
		assert.equal(config.browserEntry, "");
	});
});
