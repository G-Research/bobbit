#!/usr/bin/env node
/**
 * Unit-phase runner — the command behind `npm run test:unit` and the workflow
 * `unit:` gate.
 *
 * The unit phase has TWO runners (see docs/testing-strategy.md):
 *   1. node:test logic suite  — tests/*.test.ts (+ tests/contract/*.test.ts)
 *   2. Playwright browser fixtures — tests/playwright.config.ts (file:// only)
 *
 * They were previously chained with `&&` (~135s total). This wrapper runs them
 * CONCURRENTLY so the wall time collapses toward max(node, browser) instead of
 * their sum — the first rung of the parallelism ladder toward the <60s target.
 * Both runners are CPU-bound and parallel internally, so on a many-core box the
 * concurrent wall time is dominated by whichever suite is slower, not the sum.
 *
 * The node globs come from scripts/test-phase-config.mjs (the single source of
 * truth shared with the phase-invariant guard) and are passed VERBATIM so node
 * expands them — never the shell (Windows command-line-length limit).
 */
import { spawn, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NODE_UNIT_GLOBS } from "./test-phase-config.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");

// Some node-logic tests import compiled server modules from dist/server.
if (!existsSync(join(projectRoot, "dist", "server"))) {
	execSync("npm run build:server", { cwd: projectRoot, stdio: "inherit" });
}

const isWin = process.platform === "win32";
const npx = isWin ? "npx.cmd" : "npx";

// The two runners are BOTH CPU-bound and each parallelises internally. Running
// them concurrently while each grabs all cores oversubscribes the box (node's
// availableParallelism()-wide run + Playwright's worker pool = ~2x cores) and
// the contention starves slow browser fixtures past their 15s timeout — i.e.
// full concurrency turns a green suite red. So we SPLIT the cores: each runner
// gets ~half, summing to the core count, so they run genuinely in parallel
// without oversubscription. Wall time then approaches max(node, browser)
// instead of their sum, with no contention-induced timeouts.
const cpus = availableParallelism();
const half = Math.max(2, Math.floor(cpus / 2));
const nodeConcurrency = process.env.BOBBIT_UNIT_NODE_CONCURRENCY || String(half);
// Passed to Playwright via --workers (CLI overrides the config's default).
const browserWorkers = process.env.BOBBIT_UNIT_BROWSER_WORKERS || String(half);

function run(label, args) {
	return new Promise((res) => {
		const start = Date.now();
		const child = spawn(npx, args, {
			cwd: projectRoot,
			stdio: ["ignore", "inherit", "inherit"],
			// npx is a .cmd shim on Windows → needs a shell. The args are short
			// (globs are NOT pre-expanded), so the shell command line stays tiny.
			shell: isWin,
			env: process.env,
		});
		child.on("exit", (code, signal) => {
			const secs = ((Date.now() - start) / 1000).toFixed(1);
			console.log(`\n[run-unit] ${label} finished in ${secs}s (exit ${code ?? signal ?? "?"})`);
			res({ label, code: code ?? (signal ? 1 : 0) });
		});
		child.on("error", (err) => {
			console.error(`[run-unit] ${label} failed to start:`, err);
			res({ label, code: 1 });
		});
	});
}

const nodeArgs = [
	"tsx",
	"--import", "./tests/helpers/css-stub-loader.mjs",
	"--test",
	"--test-force-exit",
	`--test-concurrency=${nodeConcurrency}`,
	...NODE_UNIT_GLOBS,
];
const browserArgs = ["playwright", "test", "--config", "tests/playwright.config.ts", "--workers", browserWorkers];

console.log(`[run-unit] ${cpus} cores → node --test-concurrency=${nodeConcurrency}, browser --workers=${browserWorkers}`);

const overallStart = Date.now();
const results = await Promise.all([
	run("node-logic", nodeArgs),
	run("browser-fixtures", browserArgs),
]);
const totalSecs = ((Date.now() - overallStart) / 1000).toFixed(1);
console.log(`\n[run-unit] total wall time ${totalSecs}s`);

process.exit(results.some((r) => r.code !== 0) ? 1 : 0);
