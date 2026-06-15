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
import { existsSync, realpathSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NODE_UNIT_GLOBS } from "./test-phase-config.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");

// Canonicalize TMPDIR so os.tmpdir() returns the REAL path in every spawned test
// worker. On macOS os.tmpdir() yields /var/folders/... which reaches /private/var
// through a symlink; node-logic tests that register a project under os.tmpdir()
// then trip the server's `symlink_root` guard (rootPath !== realpath(rootPath)).
// The E2E phase already canonicalizes rootPaths in tests/e2e/e2e-setup.ts; this is
// the node-logic-phase equivalent, applied once at the entry point and inherited
// by both spawned runners. Tests that deliberately exercise the symlink guard
// create their own explicit symlinks and are unaffected.
try { process.env.TMPDIR = realpathSync(tmpdir()); } catch { /* leave default */ }

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
// True half-core split: node + browser worker pools must sum to <= cpus so they
// never oversubscribe. `Math.floor(cpus / 2)` keeps the sum within budget on
// every box (e.g. 24 -> 12+12, 4 -> 2+2, 3 -> 1+1, 2 -> 1+1, 1 -> 1+1). The
// floor of 1 keeps each runner alive on tiny machines without exceeding cpus
// (a 2-core box runs 1+1, not the previous 2+2). The 24-core behaviour (12+12)
// is unchanged.
const half = Math.max(1, Math.floor(cpus / 2));
const nodeConcurrency = process.env.BOBBIT_UNIT_NODE_CONCURRENCY || String(half);
// Passed to Playwright via --workers (CLI overrides the config's default).
const browserWorkers = process.env.BOBBIT_UNIT_BROWSER_WORKERS || String(half);

const failureTailLines = Math.max(20, Number.parseInt(process.env.BOBBIT_UNIT_FAILURE_TAIL_LINES || "240", 10) || 240);

function appendTail(tail, chunk) {
	for (const line of String(chunk).split(/\r?\n/)) {
		if (!line) continue;
		tail.push(line);
		if (tail.length > failureTailLines) tail.shift();
	}
}

function run(label, args) {
	return new Promise((res) => {
		const start = Date.now();
		const tail = [];
		let settled = false;
		const child = spawn(npx, args, {
			cwd: projectRoot,
			stdio: ["ignore", "pipe", "pipe"],
			// npx is a .cmd shim on Windows → needs a shell. The args are short
			// (globs are NOT pre-expanded), so the shell command line stays tiny.
			shell: isWin,
			env: process.env,
		});
		child.stdout?.on("data", (chunk) => {
			process.stdout.write(chunk);
			appendTail(tail, chunk);
		});
		child.stderr?.on("data", (chunk) => {
			process.stderr.write(chunk);
			appendTail(tail, chunk);
		});
		child.on("close", (code, signal) => {
			if (settled) return;
			settled = true;
			const secs = ((Date.now() - start) / 1000).toFixed(1);
			console.log(`\n[run-unit] ${label} finished in ${secs}s (exit ${code ?? signal ?? "?"})`);
			res({ label, code: code ?? (signal ? 1 : 0), tail });
		});
		child.on("error", (err) => {
			if (settled) return;
			settled = true;
			console.error(`[run-unit] ${label} failed to start:`, err);
			res({ label, code: 1, tail: [String(err?.stack || err)] });
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
const failed = results.filter((r) => r.code !== 0);
console.log(`\n[run-unit] total wall time ${totalSecs}s`);
console.log(`[run-unit] result summary: ${results.map((r) => `${r.label}=${r.code === 0 ? "pass" : `fail(${r.code})`}`).join(", ")}`);

if (failed.length > 0) {
	console.error(`\n[run-unit] ${failed.length} runner(s) failed. Replaying last ${failureTailLines} non-empty output lines per failed runner so gate tails include the useful error:`);
	for (const result of failed) {
		console.error(`\n[run-unit] ---- ${result.label} failure output tail ----`);
		if (result.tail.length > 0) console.error(result.tail.join("\n"));
		else console.error("(no output captured)");
		console.error(`[run-unit] ---- end ${result.label} failure output tail ----`);
	}
}

process.exit(failed.length > 0 ? 1 : 0);
