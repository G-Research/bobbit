import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const src = readFileSync(new URL("../scripts/run-unit.mjs", import.meta.url), "utf8");

test("run-unit runner has its own timeout below the gate watchdog", () => {
	assert.match(src, /BOBBIT_UNIT_RUNNER_TIMEOUT_MS/, "runner timeout env override is documented in the script");
	assert.match(src, /runnerTimeoutMs\s*=\s*Math\.max\(60_000,/, "timeout has a safe lower bound for legitimate unit runs");
	assert.match(src, /1050000/, "default timeout should be 1050s, below the 1200s implementation gate watchdog with cleanup headroom");
	assert.match(src, /timedOut \? 1/, "a timed-out runner must fail the unit phase even if it later exits 0");
});

test("run-unit timeout terminates Windows process trees and closes inherited stdio", () => {
	assert.match(src, /spawn\("taskkill", \["\/pid", String\(child\.pid\), "\/T", "\/F"\]/, "Windows timeout path kills the shell and descendants");
	assert.match(src, /child\.stdout\?\.destroy\(\);\s*\n\s*child\.stderr\?\.destroy\(\);\s*\n\s*settle\(1, null\);/, "timeout kill-grace path closes inherited stdio and settles the wrapper");
	assert.match(src, /process exited but stdio did not close/, "exit-before-close regression path remains covered by the wrapper");
});

test("run-unit bounds each node test so a single hang fails fast and names itself", () => {
	// The PRIMARY hung-test guard: --test-timeout makes node fail (and name) an
	// individual hung test/hook instead of pinning the whole runner until the
	// 1050s wrapper timeout. It must NOT merely raise the overall budget.
	assert.match(src, /BOBBIT_UNIT_NODE_TEST_TIMEOUT_MS/, "per-test timeout is env-overridable for stress runs");
	assert.match(src, /nodeTestTimeoutMs\s*=\s*Math\.max\(10_000,/, "per-test timeout keeps a safe lower bound");
	assert.match(src, /`--test-timeout=\$\{nodeTestTimeoutMs\}`/, "the node runner passes --test-timeout so hung tests self-identify");
	const testTimeout = Number((src.match(/BOBBIT_UNIT_NODE_TEST_TIMEOUT_MS \|\| "(\d+)"/) || [])[1]);
	const runnerTimeout = Number((src.match(/BOBBIT_UNIT_RUNNER_TIMEOUT_MS \|\| "(\d+)"/) || [])[1]);
	assert.ok(testTimeout > 0 && runnerTimeout > 0, "both timeouts have numeric defaults");
	assert.ok(testTimeout < runnerTimeout, "a hung test must time out (and name itself) well before the wrapper kills the runner");
});

test("run-unit attaches a hung-test heartbeat reporter without hiding tap output", () => {
	// Specifying any --test-reporter disables node's implicit default, so tap must
	// be named explicitly or human output would vanish.
	assert.match(src, /"--test-reporter=tap"/, "the default tap output is preserved explicitly");
	assert.match(src, /"--test-reporter-destination=stdout"/, "tap is routed to stdout");
	assert.match(src, /--test-reporter=\.\/tests\/helpers\/hung-test-reporter\.mjs/, "the heartbeat reporter is attached");
	assert.match(src, /BOBBIT_UNIT_NODE_HEARTBEAT_FILE: nodeHeartbeatFile/, "the reporter's heartbeat path is passed via env, not a CLI path arg");
	// The heartbeat reporter yields nothing, so its destination is the stderr
	// keyword — never a filesystem path that could contain spaces under shell:true.
	const reporterIdx = src.indexOf("--test-reporter=./tests/helpers/hung-test-reporter.mjs");
	const destIdx = src.indexOf("--test-reporter-destination=stderr");
	assert.ok(reporterIdx > 0 && destIdx > reporterIdx, "the heartbeat reporter destination is the stderr keyword, not a path arg");
});

test("run-unit timeout diagnostics name the in-flight/hung test file", () => {
	assert.match(src, /import \{ readHeartbeatDiagnostics \} from "\.\/lib\/unit-heartbeat\.mjs"/, "diagnostics logic is imported from the shared, unit-tested helper");
	// The heartbeat diagnostics must be emitted on the runner-timeout path.
	assert.match(src, /if \(opts\.heartbeatFile\) \{[\s\S]*readHeartbeatDiagnostics\(opts\.heartbeatFile\)/, "timeout path reads and replays heartbeat diagnostics");
	assert.match(src, /run\("node-logic", nodeArgs, \{ heartbeatFile: nodeHeartbeatFile \}\)/, "only the node-logic runner is given a heartbeat file");
});

test("run-unit preserves concurrent runners, artifact snapshot/restore and heartbeat cleanup", () => {
	assert.match(src, /Promise\.all\(\[\s*\n\s*run\("node-logic"/, "node + browser runners still run concurrently");
	assert.match(src, /run\("browser-fixtures", browserArgs\)/, "the browser fixtures runner is unchanged");
	assert.match(src, /restoreGeneratedArtifacts\(\)/, "generated artifacts are still restored in the finally block");
	assert.match(src, /rmSync\(heartbeatDir, \{ recursive: true, force: true \}\)/, "the heartbeat temp dir is cleaned up");
	// Heartbeat setup must precede testEnv so the env var is not read in its TDZ.
	const heartbeatDecl = src.indexOf("const heartbeatDir = mkdtempSync(");
	const testEnvDecl = src.indexOf("const testEnv = {");
	assert.ok(heartbeatDecl > 0 && testEnvDecl > 0 && heartbeatDecl < testEnvDecl, "heartbeat paths are declared before testEnv references them");
});
