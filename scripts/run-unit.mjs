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
 *
 * `npm run test:unit -- <paths...>` (TEST-01) filters to just the given test
 * files: each path is routed to its owning sub-phase (a *.test.ts under the
 * node globs → node phase; a *.spec.ts fixture → browser phase) and the OTHER
 * phase is skipped entirely when it has no matching args. An arg that matches
 * neither phase's membership (e.g. tests/e2e/**) is a hard error, not a
 * silent no-op. Zero args is unchanged: both phases run their full default
 * glob/suite. See scripts/test-unit-args.mjs for the pure selection logic and
 * tests/test-unit-args.test.ts for the pinned seam.
 */
import { spawn, execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, loadavg, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveUnitSelection } from "./test-unit-args.mjs";
import { computeUnitSummary, detectMaskedFailureCount, formatUnitSummaryLine } from "./unit-summary.mjs";
import { readHeartbeatDiagnostics } from "./lib/unit-heartbeat.mjs";
import { computeAdaptiveConcurrency } from "./lib/adaptive-concurrency.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");

const selection = resolveUnitSelection(process.argv.slice(2), { projectRoot });
if (selection.error) {
	console.error(`[run-unit] ${selection.error}`);
	process.exit(1);
}
if (selection.nodeTestArgs === null && selection.browserTestArgs === null) {
	// Unreachable given resolveUnitSelection's contract, but guards against a
	// future selection bug silently skipping the entire unit phase.
	console.error("[run-unit] internal error: no sub-phase selected and no error reported.");
	process.exit(1);
}

// Canonicalize TMPDIR so os.tmpdir() returns the REAL path in every spawned test
// worker. On macOS os.tmpdir() yields /var/folders/... which reaches /private/var
// through a symlink; node-logic tests that register a project under os.tmpdir()
// then trip the server's `symlink_root` guard (rootPath !== realpath(rootPath)).
// The E2E phase already canonicalizes rootPaths in tests/e2e/e2e-setup.ts; this is
// the node-logic-phase equivalent, applied once at the entry point and inherited
// by both spawned runners. Tests that deliberately exercise the symlink guard
// create their own explicit symlinks and are unaffected.
try { process.env.TMPDIR = realpathSync(tmpdir()); } catch { /* leave default */ }

const GENERATED_ARTIFACTS = [
	"market-packs/artifacts/lib/ArtifactViewerPanel.js",
	"market-packs/pr-walkthrough/lib/yaml-to-cards.mjs",
	"tests/fixtures/message-editor-pack-slash-bundle.css",
];

function snapshotGeneratedArtifacts() {
	const snapshots = GENERATED_ARTIFACTS.map((rel) => {
		const file = join(projectRoot, rel);
		return { file, rel, existed: existsSync(file), bytes: existsSync(file) ? readFileSync(file) : undefined };
	});
	return () => {
		for (const snap of snapshots) {
			try {
				if (snap.existed) {
					mkdirSync(dirname(snap.file), { recursive: true });
					writeFileSync(snap.file, snap.bytes);
				} else {
					rmSync(snap.file, { force: true });
				}
			} catch (err) {
				console.warn(`[run-unit] warning: could not restore generated artifact ${snap.rel}: ${err?.message || err}`);
			}
		}
	};
}

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
// Live server secrets (token / TLS / sandbox-agent auth) resolve to an OS
// user-level directory via serverSecretsDir(). Pin BOBBIT_SECRETS_DIR to an
// isolated temp dir for the whole unit phase so no test can ever write real
// admin secrets into the developer's home dir.
const unitSecretsDir = process.env.BOBBIT_SECRETS_DIR
	|| join(realpathSync(tmpdir()), `bobbit-unit-secrets-${process.pid}`);
mkdirSync(unitSecretsDir, { recursive: true });

// Live heartbeat sink for the node-logic runner. The hung-test reporter (paired
// with the normal tap reporter) writes the set of test files still in flight to
// this file so the wrapper's timeout path can NAME the hung file(s) — the
// backstop for `--test-timeout` when a leaked/detached child survives per-test
// timeouts and pins the runner outside any single test.
const heartbeatDir = mkdtempSync(join(realpathSync(tmpdir()), "bobbit-unit-hb-"));
const nodeHeartbeatFile = join(heartbeatDir, "node-heartbeat.json");
const testEnv = {
	...process.env,
	NODE_ENV: "test",
	BOBBIT_TEST_NO_EXTERNAL: process.env.BOBBIT_TEST_NO_EXTERNAL || "1",
	BOBBIT_TEST_NO_REMOTE: process.env.BOBBIT_TEST_NO_REMOTE || "1",
	BOBBIT_SECRETS_DIR: unitSecretsDir,
	// Consumed by tests/helpers/hung-test-reporter.mjs (node runner only).
	BOBBIT_UNIT_NODE_HEARTBEAT_FILE: nodeHeartbeatFile,
	// Reduce post-exit stdio flush grace so fast commands (e.g. `echo ok`) in
	// contract and lifecycle tests complete their verification step in ~100ms
	// instead of the default 2000ms. Without this, sequential gate verifications
	// in tests/contract/gate-verification.test.ts exceed waitForGateStatus's
	// 15s internal timeout under concurrent test-suite load.
	BOBBIT_VERIFICATION_EXIT_CLOSE_GRACE_MS: process.env.BOBBIT_VERIFICATION_EXIT_CLOSE_GRACE_MS || "100",
};

// V8 code cache (NODE_COMPILE_CACHE, Node >= 22.1) for the node-logic runner
// AND every child process it spawns — it's set on testEnv, which every
// spawned runner (and anything THEY spawn via `...process.env`) inherits.
// Node reads this env var at startup and transparently persists/reuses
// compiled bytecode across runs; no code changes needed beyond pointing it
// at a cache dir. Opt-in via BOBBIT_TEST_COMPILE_CACHE=1 rather than default:
// measured cold/warm/baseline wall time for the node-logic phase (tsx +
// ~1540 tests under node --test) on this machine and found no measurable win
// — run-to-run variance from background load (12-20+ loadavg on this shared
// box) was consistently larger (tens of seconds) than any plausible V8
// compile-cache effect. Kept available because it may help more on a quiet,
// cold-disk, or much larger CI machine — re-measure before flipping the
// default. See docs/testing-strategy.md for the raw numbers.
if (process.env.BOBBIT_TEST_COMPILE_CACHE === "1") {
	const compileCacheDir = process.env.BOBBIT_TEST_COMPILE_CACHE_DIR || join(projectRoot, ".cache", "node-compile");
	mkdirSync(compileCacheDir, { recursive: true });
	testEnv.NODE_COMPILE_CACHE = compileCacheDir;
}

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
// never oversubscribe. On large Windows hosts, 12+ node/browser workers can
// still starve file:// browser fixtures badly enough to flake or hit the 300s gate
// timeout, so cap each runner at 6 by default. Env overrides remain available for
// intentional local stress runs.
const half = Math.max(1, Math.floor(cpus / 2));
const defaultConcurrency = Math.min(6, half);

// Adaptive scale-down: on a machine also running other test lanes (e.g. this
// repo's merge-gate conveyor, scripts/gate-pr.sh in the sibling
// bobbit-fable-refactor checkout), the half-core split above still assumes
// the box is idle. Scale defaultConcurrency down using the 1-minute load
// average so a busy box doesn't oversubscribe further — see
// scripts/lib/adaptive-concurrency.mjs for the formula and its unit test.
// BOBBIT_TEST_CONCURRENCY (both runners) and the existing per-runner
// overrides (BOBBIT_UNIT_NODE_CONCURRENCY / BOBBIT_UNIT_BROWSER_WORKERS,
// most specific first) always win over this calculation.
const [load1] = loadavg();
const adaptiveConcurrency = computeAdaptiveConcurrency({ base: defaultConcurrency, cores: cpus, load1 });
const nodeConcurrency = process.env.BOBBIT_UNIT_NODE_CONCURRENCY || process.env.BOBBIT_TEST_CONCURRENCY || String(adaptiveConcurrency);
// Passed to Playwright via --workers (CLI overrides the config's default).
const browserWorkers = process.env.BOBBIT_UNIT_BROWSER_WORKERS || process.env.BOBBIT_TEST_CONCURRENCY || String(adaptiveConcurrency);

const failureTailLines = Math.max(20, Number.parseInt(process.env.BOBBIT_UNIT_FAILURE_TAIL_LINES || "240", 10) || 240);
const exitCloseGraceMs = Math.max(1000, Number.parseInt(process.env.BOBBIT_UNIT_EXIT_CLOSE_GRACE_MS || "5000", 10) || 5000);
// Keep the unit wrapper inside the workflow/gate timeout even when a child runner
// never exits (for example a leaked handle that survives --test-force-exit). The
// default is 17.5 minutes: long enough for legitimate slow Windows/gate runs
// under heavy contention, but still below the gate's 1200s watchdog with ~150s
// left for npm pretest/build overhead, process-tree cleanup, and failure-tail
// replay. BOBBIT_UNIT_RUNNER_TIMEOUT_MS remains the explicit override for local
// stress runs or temporary CI tuning.
const runnerTimeoutMs = Math.max(60_000, Number.parseInt(process.env.BOBBIT_UNIT_RUNNER_TIMEOUT_MS || "1050000", 10) || 1_050_000);
const runnerKillGraceMs = Math.max(1000, Number.parseInt(process.env.BOBBIT_UNIT_RUNNER_KILL_GRACE_MS || "10000", 10) || 10_000);
// Per-test timeout for the node-logic runner. This is the PRIMARY hung-test
// guard: node fails an individual test/hook that exceeds it and names the test
// + file + line, so a single hang no longer silently pins the whole runner
// until the 1050s wrapper timeout. It is NOT the overall budget increase the
// task forbids — it bounds each test, not the phase. The default 120s is far
// above any real unit test (the entire node suite finishes in ~90-210s wall)
// yet fails a hang with named diagnostics with ~15min of gate headroom left.
// BOBBIT_UNIT_NODE_TEST_TIMEOUT_MS overrides it for local stress runs.
const nodeTestTimeoutMs = Math.max(10_000, Number.parseInt(process.env.BOBBIT_UNIT_NODE_TEST_TIMEOUT_MS || "120000", 10) || 120_000);

function appendTail(tail, chunk) {
	for (const line of String(chunk).split(/\r?\n/)) {
		if (!line) continue;
		tail.push(line);
		if (tail.length > failureTailLines) tail.shift();
	}
}

function run(label, args, opts = {}) {
	return new Promise((res) => {
		const start = Date.now();
		const tail = [];
		let settled = false;
		let exitCode = null;
		let exitSignal = null;
		let closeGraceTimer;
		let runnerTimeoutTimer;
		let runnerKillGraceTimer;
		let timedOut = false;
		const child = spawn(npx, args, {
			cwd: projectRoot,
			stdio: ["ignore", "pipe", "pipe"],
			// npx is a .cmd shim on Windows → needs a shell. The args are short
			// (globs are NOT pre-expanded), so the shell command line stays tiny.
			shell: isWin,
			env: testEnv,
		});

		const settle = (code, signal) => {
			if (settled) return;
			settled = true;
			if (closeGraceTimer) clearTimeout(closeGraceTimer);
			if (runnerTimeoutTimer) clearTimeout(runnerTimeoutTimer);
			if (runnerKillGraceTimer) clearTimeout(runnerKillGraceTimer);
			const secs = ((Date.now() - start) / 1000).toFixed(1);
			let resultCode = timedOut ? 1 : (code ?? (signal ? 1 : 0));
			const exitLabel = timedOut ? `timeout/${code ?? signal ?? "?"}` : (code ?? signal ?? "?");
			// Masked-failure cross-check: a runner reporting a successful (0) exit
			// code is not trusted blindly — its own output is scanned for an
			// unambiguous failure count (node's `# fail N`, Playwright's `N failed`)
			// and a reported-0 result is promoted to failing if one is found. See
			// detectMaskedFailureCount's doc comment (scripts/unit-summary.mjs) for
			// why: this exact class of bug (13 real browser-fixture failures
			// alongside a 0 exit code) was observed on a loaded shared machine.
			// Never overrides an already-failing code.
			if (resultCode === 0) {
				const maskedFailures = detectMaskedFailureCount(label, tail.join("\n"));
				if (maskedFailures > 0) {
					resultCode = 1;
					const warning = `[run-unit] ${label} reported exit 0 but its own output shows ${maskedFailures} failure(s) — overriding to a failing exit code (masked-failure guard).`;
					console.error(`\n${warning}`);
					appendTail(tail, warning);
				}
			}
			console.log(`\n[run-unit] ${label} finished in ${secs}s (exit ${exitLabel})`);
			res({ label, code: resultCode, tail });
		};

		const terminateTimedOutRunner = () => {
			if (!child.pid) return;
			if (isWin) {
				try {
					spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
				} catch {
					try { child.kill("SIGTERM"); } catch { /* ignore */ }
				}
			} else {
				try { child.kill("SIGTERM"); } catch { /* ignore */ }
			}
		};

		runnerTimeoutTimer = setTimeout(() => {
			if (settled) return;
			timedOut = true;
			const warning = `[run-unit] ${label} timed out after ${runnerTimeoutMs}ms; terminating the runner so the unit phase reports diagnostics before the outer gate timeout.`;
			console.error(`\n${warning}`);
			appendTail(tail, warning);
			if (opts.heartbeatFile) {
				for (const line of readHeartbeatDiagnostics(opts.heartbeatFile)) {
					console.error(line);
					appendTail(tail, line);
				}
			}
			terminateTimedOutRunner();
			runnerKillGraceTimer = setTimeout(() => {
				if (settled) return;
				const killWarning = `[run-unit] ${label} did not exit within ${runnerKillGraceMs}ms after timeout termination; closing stdio readers and failing the runner.`;
				console.error(killWarning);
				appendTail(tail, killWarning);
				child.stdout?.destroy();
				child.stderr?.destroy();
				settle(1, null);
			}, runnerKillGraceMs);
		}, runnerTimeoutMs);

		child.stdout?.on("data", (chunk) => {
			process.stdout.write(chunk);
			appendTail(tail, chunk);
		});
		child.stderr?.on("data", (chunk) => {
			process.stderr.write(chunk);
			appendTail(tail, chunk);
		});
		child.on("exit", (code, signal) => {
			exitCode = code;
			exitSignal = signal;
			// `close` normally follows `exit` once stdio pipes close. Under Windows gate
			// load, leaked descendants can inherit the node runner's stdout/stderr pipe:
			// node:test has exited (and --test-force-exit has done its job), but `close`
			// never arrives, so the wrapper waits until the outer gate timeout. Keep the
			// child exit code authoritative, wait briefly for trailing output, then close
			// our pipe readers and finish instead of hanging the whole unit phase.
			closeGraceTimer = setTimeout(() => {
				if (settled) return;
				const warning = `[run-unit] ${label} process exited but stdio did not close within ${exitCloseGraceMs}ms; treating the process exit as authoritative. A descendant likely inherited stdout/stderr.`;
				console.warn(`\n${warning}`);
				appendTail(tail, warning);
				child.stdout?.destroy();
				child.stderr?.destroy();
				settle(exitCode, exitSignal);
			}, exitCloseGraceMs);
		});
		child.on("close", (code, signal) => {
			settle(code ?? exitCode, signal ?? exitSignal);
		});
		child.on("error", (err) => {
			if (settled) return;
			settled = true;
			if (closeGraceTimer) clearTimeout(closeGraceTimer);
			if (runnerTimeoutTimer) clearTimeout(runnerTimeoutTimer);
			if (runnerKillGraceTimer) clearTimeout(runnerKillGraceTimer);
			console.error(`[run-unit] ${label} failed to start:`, err);
			res({ label, code: 1, tail: [String(err?.stack || err)] });
		});
	});
}

// Per-test timeout for node-logic. node's default is Infinity, so a single test
// whose body awaits something that never resolves hangs the ENTIRE phase until
// the outer runner kill (~1050s) — an opaque, unactionable gate timeout. Bound
// it generously: the slowest real node-logic test is ~1s, so 120s never flakes a
// legitimate test even under heavy gate contention, but converts an infinite
// hang into a named `test timed out` failure that points straight at the culprit.
const nodeArgs = selection.nodeTestArgs === null ? null : [
	"tsx",
	"--import", "./tests/helpers/css-stub-loader.mjs",
	"--test",
	"--test-force-exit",
	`--test-timeout=${nodeTestTimeoutMs}`,
	`--test-concurrency=${nodeConcurrency}`,
	// Keep the normal tap output on stdout (node's default when piped) AND
	// attach the hung-test heartbeat reporter. Explicitly naming tap is required:
	// specifying any --test-reporter disables node's implicit default reporter, so
	// human output would otherwise disappear.
	"--test-reporter=tap",
	"--test-reporter-destination=stdout",
	"--test-reporter=./tests/helpers/hung-test-reporter.mjs",
	// The heartbeat reporter yields nothing (its real output is the JSON heartbeat
	// written via BOBBIT_UNIT_NODE_HEARTBEAT_FILE), so routing it to the stderr
	// keyword adds no output while avoiding a filesystem-path CLI arg that could
	// contain spaces under `shell: true` on Windows.
	"--test-reporter-destination=stderr",
	...selection.nodeTestArgs,
];
const browserArgs = selection.browserTestArgs === null ? null : [
	"playwright", "test", "--config", "tests/playwright.config.ts", "--workers", browserWorkers,
	...selection.browserTestArgs,
];

console.log(`[run-unit] ${cpus} cores, load1=${load1.toFixed(2)} (base ${defaultConcurrency} → adaptive ${adaptiveConcurrency}) → node --test-concurrency=${nodeConcurrency} --test-timeout=${nodeTestTimeoutMs}ms, browser --workers=${browserWorkers}`);
if (nodeArgs === null) console.log("[run-unit] node-logic phase skipped (no matching args)");
if (browserArgs === null) console.log("[run-unit] browser-fixtures phase skipped (no matching args)");

const overallStart = Date.now();
const restoreGeneratedArtifacts = snapshotGeneratedArtifacts();
let results;
try {
	results = await Promise.all([
		...(nodeArgs === null ? [] : [run("node-logic", nodeArgs, { heartbeatFile: nodeHeartbeatFile })]),
		...(browserArgs === null ? [] : [run("browser-fixtures", browserArgs)]),
	]);
} finally {
	restoreGeneratedArtifacts();
	try { rmSync(heartbeatDir, { recursive: true, force: true }); } catch { /* best effort */ }
}
const totalSecs = ((Date.now() - overallStart) / 1000).toFixed(1);
const failed = results.filter((r) => r.code !== 0);
console.log(`\n[run-unit] total wall time ${totalSecs}s`);
console.log(`[run-unit] result summary: ${results.map((r) => `${r.label}=${r.code === 0 ? "pass" : `fail(${r.code})`}`).join(", ")}`);
// Plain, ANSI-free, machine-parseable line for gate orchestration — see
// scripts/unit-summary.mjs. Deliberately separate from the two lines above,
// which are for human eyes and may grow free-text in the future.
console.log(formatUnitSummaryLine(computeUnitSummary(results)));

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
