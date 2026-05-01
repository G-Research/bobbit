import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ProjectConfigStore } from "../src/server/agent/project-config-store.js";

describe("Component config (QA settings)", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ev-config-test-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns false from isQaConfiguredOnAnyComponent when no component has qa_start_command", () => {
		fs.writeFileSync(path.join(tmpDir, "project.yaml"), "name: test\n");
		const store = new ProjectConfigStore(tmpDir);
		assert.equal(store.isQaConfiguredOnAnyComponent(), false);
	});

	it("reads QA settings from components[].config", () => {
		const yaml = [
			"components:",
			"  - name: web",
			"    repo: .",
			"    commands:",
			"      build: npm run build",
			"    config:",
			"      qa_start_command: \"node server.js --port $PORT\"",
			"      qa_health_check: \"http://127.0.0.1:$PORT/health\"",
			"      qa_browser_entry: \"http://127.0.0.1:$PORT/?token=$TOKEN\"",
			"      qa_max_duration_minutes: \"15\"",
			"      qa_max_scenarios: \"3\"",
		].join("\n");
		fs.writeFileSync(path.join(tmpDir, "project.yaml"), yaml);
		const store = new ProjectConfigStore(tmpDir);
		assert.equal(store.isQaConfiguredOnAnyComponent(), true);
		const cfg = store.getComponentConfig("web");
		assert.equal(cfg.qa_start_command, "node server.js --port $PORT");
		assert.equal(cfg.qa_health_check, "http://127.0.0.1:$PORT/health");
		assert.equal(cfg.qa_browser_entry, "http://127.0.0.1:$PORT/?token=$TOKEN");
		assert.equal(cfg.qa_max_duration_minutes, "15");
		assert.equal(cfg.qa_max_scenarios, "3");
		assert.equal(store.getQaMaxDurationMinutes("web"), 15);
	});

	it("getQaMaxDurationMinutes falls back to 10 for missing/invalid values", () => {
		fs.writeFileSync(path.join(tmpDir, "project.yaml"), [
			"components:",
			"  - name: web",
			"    repo: .",
			"    config:",
			"      qa_start_command: \"node server.js\"",
		].join("\n"));
		const store = new ProjectConfigStore(tmpDir);
		assert.equal(store.getQaMaxDurationMinutes("web"), 10);
		assert.equal(store.getQaMaxDurationMinutes("nonexistent"), 10);
	});

	it("getComponentConfig returns empty object for unknown component", () => {
		fs.writeFileSync(path.join(tmpDir, "project.yaml"), "name: test\n");
		const store = new ProjectConfigStore(tmpDir);
		assert.deepEqual(store.getComponentConfig("missing"), {});
	});

	it("setComponents round-trips config map across reload", () => {
		fs.writeFileSync(path.join(tmpDir, "project.yaml"), "name: test\n");
		const store = new ProjectConfigStore(tmpDir);
		store.setComponents([{
			name: "api",
			repo: ".",
			commands: { build: "go build" },
			config: { qa_start_command: "./api", qa_max_scenarios: "5" },
		}]);
		const reloaded = new ProjectConfigStore(tmpDir);
		const cfg = reloaded.getComponentConfig("api");
		assert.equal(cfg.qa_start_command, "./api");
		assert.equal(cfg.qa_max_scenarios, "5");
	});

	it("does not serialise empty config: {}", () => {
		fs.writeFileSync(path.join(tmpDir, "project.yaml"), "name: test\n");
		const store = new ProjectConfigStore(tmpDir);
		store.setComponents([{ name: "web", repo: ".", config: {} }]);
		const written = fs.readFileSync(path.join(tmpDir, "project.yaml"), "utf-8");
		assert.ok(!written.includes("config:"), `config: should not be serialised when empty; got:\n${written}`);
	});
});
