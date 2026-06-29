import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const src = readFileSync(new URL("../scripts/run-unit.mjs", import.meta.url), "utf8");

test("run-unit runner has its own timeout below the gate watchdog", () => {
	assert.match(src, /BOBBIT_UNIT_RUNNER_TIMEOUT_MS/, "runner timeout env override is documented in the script");
	assert.match(src, /runnerTimeoutMs\s*=\s*Math\.max\(60_000,/, "timeout has a safe lower bound for legitimate unit runs");
	assert.match(src, /900000/, "default timeout should be 900s, below the 1200s implementation gate watchdog");
	assert.match(src, /timedOut \? 1/, "a timed-out runner must fail the unit phase even if it later exits 0");
});

test("run-unit timeout terminates Windows process trees and closes inherited stdio", () => {
	assert.match(src, /spawn\("taskkill", \["\/pid", String\(child\.pid\), "\/T", "\/F"\]/, "Windows timeout path kills the shell and descendants");
	assert.match(src, /child\.stdout\?\.destroy\(\);\s*\n\s*child\.stderr\?\.destroy\(\);\s*\n\s*settle\(1, null\);/, "timeout kill-grace path closes inherited stdio and settles the wrapper");
	assert.match(src, /process exited but stdio did not close/, "exit-before-close regression path remains covered by the wrapper");
});
