import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ProjectConfigStore } from "../src/server/agent/project-config-store.js";

describe("ExploratoryValidationConfig", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ev-config-test-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns null when no ev_start_command configured", () => {
		fs.writeFileSync(path.join(tmpDir, "project.yaml"), "name: test\n");
		const store = new ProjectConfigStore(tmpDir);
		assert.equal(store.getExploratoryValidationConfig(), null);
	});

	it("parses ev_* keys into typed config", () => {
		const yaml = [
			"name: test",
			"build_command: npm run build",
			'ev_build_command: "npm run build:prod"',
			'ev_start_command: "node server.js --port $PORT"',
			'ev_health_check: "http://127.0.0.1:$PORT/health"',
			'ev_browser_entry: "http://127.0.0.1:$PORT/?token=$TOKEN"',
			"ev_env: '{\"FOO\":\"bar\"}'",
			'ev_max_duration_minutes: "15"',
			'ev_max_scenarios: "3"',
		].join("\n");
		fs.writeFileSync(path.join(tmpDir, "project.yaml"), yaml);
		const store = new ProjectConfigStore(tmpDir);
		const config = store.getExploratoryValidationConfig();
		assert.ok(config);
		assert.equal(config.buildCommand, "npm run build:prod");
		assert.equal(config.startCommand, "node server.js --port $PORT");
		assert.equal(config.healthCheck, "http://127.0.0.1:$PORT/health");
		assert.equal(config.browserEntry, "http://127.0.0.1:$PORT/?token=$TOKEN");
		assert.deepEqual(config.env, { FOO: "bar" });
		assert.equal(config.maxDurationMinutes, 15);
		assert.equal(config.maxScenarios, 3);
	});

	it("falls back to build_command when ev_build_command not set", () => {
		const yaml = [
			"build_command: npm run mybuild",
			'ev_start_command: "node server.js"',
		].join("\n");
		fs.writeFileSync(path.join(tmpDir, "project.yaml"), yaml);
		const store = new ProjectConfigStore(tmpDir);
		const config = store.getExploratoryValidationConfig();
		assert.ok(config);
		assert.equal(config.buildCommand, "npm run mybuild");
	});

	it("uses defaults for optional fields", () => {
		const yaml = 'ev_start_command: "node server.js"\n';
		fs.writeFileSync(path.join(tmpDir, "project.yaml"), yaml);
		const store = new ProjectConfigStore(tmpDir);
		const config = store.getExploratoryValidationConfig();
		assert.ok(config);
		assert.equal(config.maxDurationMinutes, 10);
		assert.equal(config.maxScenarios, 5);
		assert.deepEqual(config.env, {});
		assert.equal(config.healthCheck, "");
		assert.equal(config.browserEntry, "");
	});
});
