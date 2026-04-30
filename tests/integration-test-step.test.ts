/**
 * Unit tests for `runIntegrationTestStep` (the integration-test verify-step
 * runner used by the implementation gate).
 *
 * Coverage:
 *   (a) skipped-as-passed when no qa_start_command is configured
 *   (b) starts and tears down the stack cleanly when a server announces a
 *       port and a healthcheck responds 200
 *   (c) propagates HTTP failures (wrong status / missing endpoint) as a gate
 *       failure
 *   (d) timeout on a hung qa_start_command kills the process and fails the
 *       step
 *   (e) loads scenarios from a project override file in preference to the
 *       built-in defaults
 *   (f) jsonShapeMatches partial-match semantics
 *   (g) detectPort recognises common "listening on …" log forms
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
	runIntegrationTestStep,
	loadScenarios,
	detectPort,
	jsonShapeMatches,
} from "../src/server/agent/integration-test-runner.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function mkTempDir(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeYaml(file: string, contents: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, contents, "utf-8");
}

/**
 * Start a tiny HTTP server in-process. Returns the port and a stop fn.
 * The handler controls per-route status + body.
 */
async function startProbeServer(handler: http.RequestListener): Promise<{ port: number; stop: () => Promise<void> }> {
	const server = http.createServer(handler);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as { port: number }).port;
	return {
		port,
		stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

/**
 * Build a minimal defaults-root with the given workflow files for tests that
 * want to exercise the per-workflow fallback chain.
 */
function makeDefaultsRoot(workflows: Record<string, string>): string {
	const root = mkTempDir("itest-defaults-");
	for (const [wf, content] of Object.entries(workflows)) {
		writeYaml(path.join(root, `${wf}.yaml`), content);
	}
	return root;
}

// ---------------------------------------------------------------------------
// (a) skipped when no qa_start_command
// ---------------------------------------------------------------------------

test("runIntegrationTestStep: skipped-as-passed when qa_start_command is empty", async () => {
	const cwd = mkTempDir("itest-skip-");
	const defaultsRoot = makeDefaultsRoot({ feature: "scenarios:\n  - name: x\n    type: http\n    url: http://127.0.0.1:1/health\n" });
	const r = await runIntegrationTestStep({
		qaStartCommand: "",
		cwd,
		workflowId: "feature",
		defaultsRoot,
	});
	assert.equal(r.skipped, true);
	assert.equal(r.passed, true);
	assert.match(r.output, /no qa_start_command/i);
});

test("runIntegrationTestStep: skipped-as-passed when qa_start_command is whitespace", async () => {
	const cwd = mkTempDir("itest-ws-");
	const defaultsRoot = makeDefaultsRoot({ feature: "scenarios: []\n" });
	const r = await runIntegrationTestStep({
		qaStartCommand: "   ",
		cwd,
		workflowId: "feature",
		defaultsRoot,
	});
	assert.equal(r.skipped, true);
	assert.equal(r.passed, true);
});

// ---------------------------------------------------------------------------
// (b) happy path: stack starts, healthcheck passes, scenarios pass
// ---------------------------------------------------------------------------

test("runIntegrationTestStep: starts stack, runs healthcheck + scenarios, tears down cleanly", async () => {
	const probe = await startProbeServer((req, res) => {
		if (req.url === "/api/health") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ status: "ok" }));
			return;
		}
		if (req.url === "/api/version") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ version: "1.2.3" }));
			return;
		}
		res.writeHead(404);
		res.end("nf");
	});
	try {
		const cwd = mkTempDir("itest-happy-");
		const defaultsRoot = makeDefaultsRoot({
			feature: [
				"scenarios:",
				"  - name: health-endpoint",
				"    type: http",
				"    method: GET",
				`    url: "http://127.0.0.1:${probe.port}/api/health"`,
				"    expect_status: 200",
				"    expect_json:",
				"      status: ok",
				"    timeout: 5",
				"  - name: version-endpoint",
				"    type: http",
				"    method: GET",
				`    url: "http://127.0.0.1:${probe.port}/api/version"`,
				"    expect_status: 200",
				"    expect_body_contains: \"1.2.3\"",
				"    timeout: 5",
				"",
			].join("\n"),
		});

		// qa_start_command: a tiny shell that prints a port-announcement and
		// stays running for ~5s. The runner kills it on teardown.
		const startCmd = `printf 'listening on http://127.0.0.1:${probe.port}\\n' && sleep 5`;

		const r = await runIntegrationTestStep({
			qaStartCommand: startCmd,
			qaHealthCheck: `http://127.0.0.1:${probe.port}/api/health`,
			cwd,
			workflowId: "feature",
			defaultsRoot,
			overallTimeoutMs: 30_000,
			healthcheckTimeoutMs: 8_000,
		});
		assert.equal(r.skipped, false, `unexpected skip: ${r.output}`);
		assert.equal(r.passed, true, `unexpected fail: ${r.output}`);
		assert.match(r.output, /Healthcheck OK/);
		assert.match(r.output, /\[PASS\] health-endpoint/);
		assert.match(r.output, /\[PASS\] version-endpoint/);
	} finally {
		await probe.stop();
	}
});

// ---------------------------------------------------------------------------
// (c) HTTP failure surfaces as gate failure
// ---------------------------------------------------------------------------

test("runIntegrationTestStep: HTTP scenario failure fails the gate step", async () => {
	const probe = await startProbeServer((req, res) => {
		if (req.url === "/api/health") {
			res.writeHead(200);
			res.end("ok");
			return;
		}
		res.writeHead(500, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: "kaboom" }));
	});
	try {
		const cwd = mkTempDir("itest-fail-");
		const defaultsRoot = makeDefaultsRoot({
			feature: [
				"scenarios:",
				"  - name: explodes",
				"    type: http",
				`    url: "http://127.0.0.1:${probe.port}/explode"`,
				"    expect_status: 200",
				"    timeout: 5",
				"",
			].join("\n"),
		});
		const startCmd = `printf 'listening on http://127.0.0.1:${probe.port}\\n' && sleep 5`;
		const r = await runIntegrationTestStep({
			qaStartCommand: startCmd,
			qaHealthCheck: `http://127.0.0.1:${probe.port}/api/health`,
			cwd,
			workflowId: "feature",
			defaultsRoot,
			overallTimeoutMs: 30_000,
			healthcheckTimeoutMs: 8_000,
		});
		assert.equal(r.passed, false, `expected fail, got: ${r.output}`);
		assert.match(r.output, /\[FAIL\] explodes/);
		assert.match(r.output, /Expected status 200, got 500/);
	} finally {
		await probe.stop();
	}
});

// ---------------------------------------------------------------------------
// (d) hung qa_start_command (no port emitted, no healthcheck) — fails fast
// ---------------------------------------------------------------------------

test("runIntegrationTestStep: hung qa_start_command without health endpoint fails the step", async () => {
	const cwd = mkTempDir("itest-hung-");
	const defaultsRoot = makeDefaultsRoot({
		feature: [
			"scenarios:",
			"  - name: never-runs",
			"    type: http",
			"    url: \"http://127.0.0.1:${PORT}/api/health\"",
			"    expect_status: 200",
			"",
		].join("\n"),
	});
	// Dead-but-running shell: no output, sleeps. Health probe will fail fast.
	const startCmd = "sleep 30";
	const r = await runIntegrationTestStep({
		qaStartCommand: startCmd,
		qaHealthCheck: "http://127.0.0.1:65530/api/health", // nothing listening
		cwd,
		workflowId: "feature",
		defaultsRoot,
		overallTimeoutMs: 8_000,
		healthcheckTimeoutMs: 2_000,
	});
	assert.equal(r.passed, false, `expected fail for hung server, got: ${r.output}`);
	assert.match(r.output, /Healthcheck failed/);
});

// ---------------------------------------------------------------------------
// (e) project override beats per-workflow defaults
// ---------------------------------------------------------------------------

test("loadScenarios: project override beats per-workflow defaults", () => {
	const cwd = mkTempDir("itest-override-cwd-");
	const configDir = mkTempDir("itest-override-cfg-");
	const defaultsRoot = makeDefaultsRoot({ feature: "scenarios:\n  - name: default-only\n    type: command\n    command: \"true\"\n" });
	writeYaml(path.join(configDir, "qa-scenarios.yaml"),
		"scenarios:\n  - name: project-only\n    type: command\n    command: \"true\"\n");
	const r = loadScenarios({ cwd, workflowId: "feature", defaultsRoot, configDir });
	assert.equal(r.scenarios.length, 1);
	assert.equal(r.scenarios[0].name, "project-only");
});

test("loadScenarios: falls back from per-workflow file to feature.yaml when missing", () => {
	const cwd = mkTempDir("itest-fallback-cwd-");
	const defaultsRoot = makeDefaultsRoot({ feature: "scenarios:\n  - name: fallback\n    type: command\n    command: \"true\"\n" });
	const r = loadScenarios({ cwd, workflowId: "non-existent", defaultsRoot });
	assert.equal(r.scenarios[0].name, "fallback");
});

// ---------------------------------------------------------------------------
// (f) jsonShapeMatches semantics
// ---------------------------------------------------------------------------

test("jsonShapeMatches: partial-match passes, mismatch fails", () => {
	assert.equal(jsonShapeMatches({ a: 1, b: 2 }, { a: 1 }), true);
	assert.equal(jsonShapeMatches({ a: 1 }, { a: 1, b: 2 }), false);
	assert.equal(jsonShapeMatches({ status: "ok" }, { status: "ok" }), true);
	assert.equal(jsonShapeMatches({ status: "fail" }, { status: "ok" }), false);
	assert.equal(jsonShapeMatches([1, 2, 3], [1, 2]), true);
	assert.equal(jsonShapeMatches([1, 2], [1, 2, 3]), false);
	assert.equal(jsonShapeMatches({ nested: { x: 1, y: 2 } }, { nested: { x: 1 } }), true);
});

// ---------------------------------------------------------------------------
// (g) detectPort recognises common "listening on" forms
// ---------------------------------------------------------------------------

test("detectPort: recognises common log forms", () => {
	assert.equal(detectPort("Server listening on http://127.0.0.1:3001\n"), 3001);
	assert.equal(detectPort("Server listening on :8080\n"), 8080);
	assert.equal(detectPort("listening on port 4000"), 4000);
	assert.equal(detectPort("ready on http://localhost:5173/\n"), 5173);
	assert.equal(detectPort("nothing here"), null);
});
