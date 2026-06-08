#!/usr/bin/env node
/**
 * Cross-platform merged-coverage runner — the command behind `npm run test:coverage`.
 *
 * Why a wrapper: the previous script used a POSIX inline env assignment
 * (`NODE_V8_COVERAGE=coverage/tmp npm run ...`) which cmd.exe does not
 * understand (`'NODE_V8_COVERAGE' is not recognized`), so it failed on Windows
 * — the platform this repo is developed on. We set the env in-process instead
 * and spawn each step, mirroring scripts/run-playwright-e2e.mjs / run-unit.mjs.
 *
 * Steps (each must succeed before the next):
 *   1. e2e `api` project with NODE_V8_COVERAGE set — the api project runs the
 *      gateway IN-PROCESS, so V8 natively writes that process's coverage to
 *      coverage/tmp on exit.
 *   2. c8-wrapped node unit run over a representative server-logic subset —
 *      writes additional V8 coverage into the same coverage/tmp.
 *   3. c8 report — merges everything in coverage/tmp into html + lcov + text.
 *
 * See docs/coverage.md.
 */
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");

const isWin = process.platform === "win32";
const npx = isWin ? "npx.cmd" : "npx";

// V8 writes raw coverage here on process exit; c8 reads from the same dir.
const COVERAGE_TMP = join(projectRoot, "coverage", "tmp");
process.env.NODE_V8_COVERAGE = COVERAGE_TMP;

// Representative server-logic node tests for the c8-wrapped pass (unchanged set).
const NODE_COVERAGE_TESTS = [
	"tests/workflow-manager-logic.test.ts",
	"tests/task-state-machine.test.ts",
	"tests/name-validation.test.ts",
	"tests/gate-store-logic.test.ts",
	"tests/system-prompt.test.ts",
	"tests/session-store.test.ts",
	"tests/cost-tracker.test.ts",
	"tests/event-buffer.test.ts",
	"tests/staff-trigger-engine.test.ts",
];

/**
 * Run a step synchronously; abort the whole command on the first failure.
 * `node` is a real executable (spawn it directly, no shell — its path may
 * contain spaces, e.g. "C:\Program Files\nodejs\node.exe"). `npx` is a .cmd
 * shim on Windows and needs a shell; its args here are short and fixed, so the
 * shell command line stays well within limits.
 */
function step(label, cmd, args, { shell }) {
	console.log(`\n[run-coverage] ${label}: ${cmd} ${args.join(" ")}`);
	const res = spawnSync(cmd, args, {
		cwd: projectRoot,
		stdio: "inherit",
		shell,
		env: process.env,
	});
	if (res.error) {
		console.error(`[run-coverage] ${label} failed to start:`, res.error);
		process.exit(1);
	}
	if ((res.status ?? 1) !== 0) {
		console.error(`[run-coverage] ${label} exited with ${res.status ?? res.signal}`);
		process.exit(res.status ?? 1);
	}
}

// 1. E2E api project (in-process gateway) with NODE_V8_COVERAGE inherited. This
//    is exactly what `npm run test:e2e:run -- --project api` ran, invoked
//    directly so the env propagates to the in-process gateway workers.
step("e2e api coverage", process.execPath, ["scripts/run-playwright-e2e.mjs", "--project", "api"], { shell: false });

// 2. c8-wrapped node unit subset → coverage/tmp.
step("node unit coverage", npx, [
	"c8",
	`--temp-directory=${COVERAGE_TMP}`,
	"--src=src/server",
	"npx", "tsx", "--test", "--test-force-exit",
	...NODE_COVERAGE_TESTS,
], { shell: isWin });

// 3. Merge into html + lcov + text.
step("c8 report", npx, [
	"c8", "report",
	`--temp-directory=${COVERAGE_TMP}`,
	"--reports-dir=coverage",
	"--reporter=html", "--reporter=lcov", "--reporter=text",
], { shell: isWin });

console.log("\n[run-coverage] done — see coverage/index.html");
