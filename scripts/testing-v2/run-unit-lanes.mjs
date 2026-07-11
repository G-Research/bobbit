#!/usr/bin/env node
/**
 * run-unit-lanes.mjs — lane-parallel driver for the `unit` verification stage.
 *
 * WHY: `test:v2:core` runs every vitest project (core / heavy / isolated / dom /
 * integration / fake) inside ONE `vitest run`, sequenced by `sequence.groupOrder`.
 * That serialises the lanes (core-window THEN integration+dom-window), so the
 * wall is sum(lanes). Profiling shows integration carries ~2x core's work, so the
 * serial sum (~core + ~integration + ~dom) is dominated by two big independent
 * lanes that could overlap.
 *
 * WHAT: spawn the lanes as SEPARATE concurrent `vitest run --project ...`
 * processes. Wall becomes max(lanes) instead of sum(lanes). Because each lane is
 * its own OS process:
 *   - it has an isolated module registry, so the node<->happy-dom environment
 *     bleed that forces `groupOrder`/single-fork hacks in the shared run does not
 *     apply across lanes;
 *   - it keeps its OWN 2-fork pool (VITEST_MAX_FORKS=2), so no single process ever
 *     exceeds the Windows-safe fork count that trips the Vitest 3.2 onTaskUpdate
 *     RPC bug (#8164/#6511). Parallelism comes from running lanes side by side
 *     (2 forks x 3 lanes = 6 forks total), NOT from raising per-process forks.
 *
 * This deliberately does NOT touch the RPC bug or raise the per-process cap — it
 * is the SAFE parallelism lever. Raising forks-per-process is a separate, larger
 * change (Vitest 4.x upgrade for the full #8297 fix).
 *
 * Concurrent full vitest runs are an anticipated mode (see
 * docs/testing-v2/concurrency-proof.md and the retry bridge in vitest.config.ts),
 * so running lanes concurrently is within the harness's designed envelope.
 *
 * Usage:
 *   node scripts/testing-v2/run-unit-lanes.mjs [--lane core|integration|dom] [--forks N] [--list]
 */
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { reserveWorkerSlots, readLedger } from "./ledger.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const LOG_DIR = join(REPO_ROOT, ".profiles", "unit-lanes");

// RPC-safety cap: no single vitest process may exceed this many forks or it
// risks the Vitest 3.2 onTaskUpdate/onUnhandledError 60s-RPC-timeout bug
// (#8164/#6511) under load. Lane parallelism buys throughput by running MULTIPLE
// 2-fork processes, never by raising a single process past this.
// Per-lane fork cap. Default 2 (Windows-RPC-safe under v3). Overridable via
// UNIT_LANES_FORK_CAP for experiments (e.g. testing whether a single lane's
// smaller onTaskUpdate backlog tolerates more forks than the full suite).
const PER_LANE_FORK_CAP = Math.max(1, Number(process.env.UNIT_LANES_FORK_CAP || "2"));

// Heartbeat cadence for the live progress line.
const HEARTBEAT_MS = Number(process.env.UNIT_LANES_HEARTBEAT_MS || "12000");

// Per-file completion line emitted by the vitest default reporter, e.g.
//   " ✓ |v2-core| tests2/core/foo.test.ts (12 tests) 340ms"
//   " ❯ tests2/core/bar.test.ts (5 tests | 1 failed) 200ms"
const FILE_LINE_RE = /(tests2\/[^\s]+\.(?:test|spec)\.ts)\b[^\n]*\((\d+)\s+tests?(?:\s*\|\s*(\d+)\s+failed)?[^)]*\)/;
// Lines worth surfacing to the console live (failures + the final tallies).
const FAIL_LINE_RE = /(^|\s)(FAIL|×|✗)\s|AssertionError|Unhandled (Error|Rejection)/;
// The [vitest-worker] birpc timeout signature — the documented CPU-starvation
// reporter-RPC flake (onTaskUpdate/onUnhandledError/fetch/transform/resolveId),
// which is a transport artifact under load, NOT a test result.
const WORKER_RPC_TIMEOUT_RE = /\[vitest-(worker|api)\]: Timeout calling "(onTaskUpdate|onUnhandledError|onCollected|fetch|transform|resolveId)"/;

// integration (~600s of work) is the pole. At 2 forks it is a ~478s single lane.
// It CAN be cost-balance-sharded across N concurrent 2-fork processes, but
// MEASUREMENT SHOWS DIMINISHING-THEN-NEGATIVE RETURNS on this box: at 3 shards
// (=> 5 concurrent jobs / 10 forks) the total only improved 478s->429s because
// core became the pole, per-lane times got WORSE from contention, and dom
// re-triggered the very Vitest RPC timeout bug (onUnhandledError) under CPU
// starvation. The safe validated sweet spot is 1 (the 3-lane config: 6 forks,
// all-green). Raise UNIT_LANES_INTEGRATION_SHARDS only with the RPC fix in place
// (Vitest 4.x) or after cutting integration's real per-test work.
const INTEGRATION_SHARDS = Math.max(1, Number(process.env.UNIT_LANES_INTEGRATION_SHARDS || "1"));

function listTestFiles(rel) {
	const root = join(REPO_ROOT, rel);
	const out = [];
	const walk = (d) => {
		for (const e of readdirSync(d, { withFileTypes: true })) {
			const p = join(d, e.name);
			if (e.isDirectory()) walk(p);
			else if (/\.test\.ts$/.test(e.name)) out.push(p.split(/[\\/]/).join("/"));
		}
	};
	walk(root);
	return out;
}

// Cost weights from the latest profile (runMs), so shards get balanced WORK, not
// balanced file counts. Falls back to equal weights if no profile exists.
function costMap() {
	const candidates = [".profiles/unit-postmerge/vitest-hooks.json", ".profiles/unit-setup-teardown-latest/vitest-hooks.json"];
	for (const c of candidates) {
		const fp = join(REPO_ROOT, c);
		if (!existsSync(fp)) continue;
		try {
			const j = JSON.parse(readFileSync(fp, "utf8"));
			const arr = Array.isArray(j.modules) ? j.modules : Object.entries(j.modules).map(([file, v]) => ({ file, ...v }));
			const m = new Map();
			for (const x of arr) {
				const s = String(x.file).replace(/\\/g, "/");
				const i = s.indexOf("tests2/");
				if (i >= 0) m.set(s.slice(i), x.runMs || 0);
			}
			return m;
		} catch { /* ignore */ }
	}
	return new Map();
}

// Greedy longest-processing-time bin packing into `shards` balanced groups.
function shardByCost(files, shards) {
	const cost = costMap();
	const weighted = files.map((f) => ({ f, w: cost.get(f) ?? 1000 })).sort((a, b) => b.w - a.w);
	const bins = Array.from({ length: shards }, () => ({ files: [], w: 0 }));
	for (const item of weighted) {
		const bin = bins.reduce((a, b) => (b.w < a.w ? b : a));
		bin.files.push(item.f);
		bin.w += item.w;
	}
	return bins.filter((b) => b.files.length);
}

// Disjoint lane -> project sets. Together they cover every project defined in
// vitest.config.ts. `v2-core` first in the core lane triggers the config's
// cliSelectsProject("v2-core") path (no broad-core sharding — one unsharded
// project), while heavy/isolated ride along as their own sequenced sub-projects.
const LANES = {
	core: ["v2-core", "v2-core-heavy", "v2-core-isolated"],
	integration: ["v2-integration", "v2-integration-fake"],
	dom: ["v2-dom", "v2-dom-isolated"],
};

function parseArgs(argv) {
	const out = { lanes: null, forks: "2", list: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--lane") out.lanes = [String(argv[++i] || "").toLowerCase()];
		else if (a === "--forks") out.forks = String(argv[++i] || "2");
		else if (a === "--list") out.list = true;
	}
	return out;
}

function vitestCmd() {
	return process.platform === "win32" ? "npx.cmd" : "npx";
}

function runLane(name, projects, forks, files, parentRunId, stats) {
	const startWall = performance.now();
	mkdirSync(LOG_DIR, { recursive: true });
	const logPath = join(LOG_DIR, `${name}.log`);
	const out = createWriteStream(logPath);
	const st = stats[name];
	// The DEFAULT reporter prints one line per completed FILE (glyph + path +
	// "(N tests[ | M failed])"), which we parse for live counts + surface failures
	// immediately. Full detail still lands in the per-lane log.
	const projectArgs = projects.flatMap((p) => ["--project", p]);
	const args = ["vitest", "run", "--config", "vitest.config.ts", "--silent=passed-only", ...projectArgs, ...(files || [])];
	return new Promise((resolveRun) => {
		const child = spawn(vitestCmd(), args, {
			cwd: REPO_ROOT,
			// LEDGER-NATIVE: the orchestrator holds ONE reservation for the whole unit
			// run; each lane REUSES that grant via the parent-grant env (the same seam
			// run-v2 uses), so the config's reserveWorkerSlots() takes the managed,
			// no-op-release path and never registers a second ledger entry.
			env: { ...process.env, BOBBIT_V2_LEDGER_PARENT: parentRunId, BOBBIT_V2_SLOTS_VITEST: String(forks) },
			stdio: ["ignore", "pipe", "pipe"],
			shell: process.platform === "win32",
		});
		const handleLine = (raw, isErr) => {
			out.write(raw + "\n");
			// Strip ANSI so detection works whether or not vitest emitted color.
			const line = raw.replace(/\x1b\[[0-9;]*m/g, "");
			// Count [vitest-worker] birpc timeouts (onTaskUpdate/onUnhandledError/fetch/
			// transform/resolveId) — the documented CPU-starvation reporter-RPC flake,
			// NOT a test result.
			if (WORKER_RPC_TIMEOUT_RE.test(line)) st.rpcTimeouts += 1;
			// Capture vitest's authoritative final tally ("Tests N passed | M failed").
			// This survives per-file RPC timeouts, so it's more trustworthy than the
			// exit code (which the unhandled RPC-timeout errors pollute).
			if (/^\s*Tests\s+\d/.test(line) && /(passed|failed)/.test(line)) {
				const f = /(\d+)\s+failed/.exec(line);
				const p = /(\d+)\s+passed/.exec(line);
				st.summarySeen = true;
				st.summaryFailed = f ? Number(f[1]) : 0;
				st.summaryPassed = p ? Number(p[1]) : 0;
			}
			const m = FILE_LINE_RE.exec(line);
			if (m) {
				st.files += 1;
				st.tests += Number(m[2]) || 0;
				const failed = Number(m[3]) || 0;
				if (failed > 0) {
					st.failedTests += failed;
					st.failedFiles.push(m[1]);
					console.log(`  \u2717 [${name}] ${m[1]} — ${failed} failed`);
				}
				return;
			}
			// Surface assertion / unhandled-error / RPC-timeout lines live (deduped-ish).
			if (isErr && FAIL_LINE_RE.test(line) && !/\.test\.ts/.test(line)) {
				const trimmed = line.trim();
				if (trimmed && st.failNotes.length < 200) st.failNotes.push(trimmed);
			}
		};
		createInterface({ input: child.stdout }).on("line", (l) => handleLine(l, false));
		createInterface({ input: child.stderr }).on("line", (l) => handleLine(l, true));
		child.on("close", (code, signal) => {
			st.done = true;
			st.wallMs = Math.round(performance.now() - startWall);
			const rawCode = code ?? (signal ? 1 : 0);
			const realFailed = st.summarySeen ? st.summaryFailed : st.failedTests;
			const passedN = st.summarySeen ? st.summaryPassed : st.tests;
			// KNOWN infra flake (docs/testing-strategy.md, docs/testing-v2/concurrency-proof.md):
			// under N-way CPU starvation a worker's event loop stalls >60s and the birpc
			// onTaskUpdate/fetch call times out, exiting the run NONZERO even though every
			// test passed. We downgrade to PASS only when ALL of: vitest printed its final
			// tally, that tally shows 0 failed tests, and >=1 [vitest-worker] RPC timeout
			// occurred. Any real failed test (summaryFailed>0), a missing tally, or a
			// nonzero exit WITHOUT an RPC timeout (some other unhandled error) still FAILS
			// — so this never masks a genuine regression.
			st.infraFlake = rawCode !== 0 && realFailed === 0 && st.summarySeen && st.rpcTimeouts > 0;
			const c = st.infraFlake ? 0 : rawCode;
			if (st.infraFlake) {
				console.log(`⚠ [${name}] all ${passedN} tests PASSED, but ${st.rpcTimeouts} [vitest-worker] RPC timeout(s) under load — known CPU-starvation infra flake (docs/testing-strategy.md); treating lane as PASS.`);
			}
			console.log(`▸ [${name}] ${c === 0 ? "PASS" : "FAIL"} — ${st.files} files, ${passedN} tests, ${realFailed} failed${st.rpcTimeouts ? `, ${st.rpcTimeouts} rpc-timeout` : ""} in ${(st.wallMs / 1000).toFixed(1)}s`);
			resolveRun({ name, projects, code: c, signal, wallMs: st.wallMs, logPath, infraFlake: st.infraFlake, rpcTimeouts: st.rpcTimeouts });
		});
		child.on("error", (error) => {
			st.done = true;
			st.wallMs = Math.round(performance.now() - startWall);
			resolveRun({ name, projects, code: 1, error: String(error), wallMs: st.wallMs, logPath });
		});
	});
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const laneNames = args.lanes ?? Object.keys(LANES);

	// Expand the integration lane into cost-balanced file shards (each its own
	// 2-fork process). The fake project stays whole (single-fork by config).
	const jobs = [];
	for (const n of laneNames) {
		if (n === "integration" && INTEGRATION_SHARDS > 1) {
			const files = listTestFiles("tests2/integration");
			const shards = shardByCost(files, INTEGRATION_SHARDS);
			shards.forEach((s, i) => jobs.push({ name: `integration-${i + 1}`, projects: ["v2-integration", "v2-integration-fake"], files: s.files }));
		} else {
			jobs.push({ name: n, projects: LANES[n] || [], files: undefined });
		}
	}

	if (args.list) {
		console.log(JSON.stringify(jobs.map((j) => ({ name: j.name, projects: j.projects, files: j.files?.length ?? "all" })), null, 2));
		return;
	}

	// Reserve ONCE for the whole unit run. reserveWorkerSlots("vitest") returns the
	// ledger's fair grant W (shrinks as concurrent goals appear via pending/committed
	// accounting), OR — when spawned under run-v2 — the pre-committed parent grant
	// with a no-op release. Either way this is the ONLY ledger entry for the run.
	const reservation = reserveWorkerSlots("vitest");
	const grant = Math.max(1, reservation.workerSlots || 1);
	const perLane = Math.min(PER_LANE_FORK_CAP, grant);
	// Distribute the grant across lanes: at most floor(grant/perLane) lanes run
	// CONCURRENTLY (each `perLane` forks), so instantaneous forks = inFlight*perLane
	// <= grant. Extra jobs queue and run in waves. This is what keeps us inside the
	// reservation under concurrent goals instead of oversubscribing the box.
	const maxConcurrent = Math.max(1, Math.floor(grant / perLane));
	const snap = readLedger();
	const sigma = snap.reservations.reduce((s, r) => s + (r.workerSlots || 0), 0);
	console.log(`[unit-lanes] ledger grant=${grant} (parent=${reservation.parentRunId}, managedByParent=${reservation.managedByParent}); ledger Σ=${sigma}/${snap.totalCores}`);
	console.log(`[unit-lanes] ${jobs.length} job(s), perLane=${perLane} forks, maxConcurrent=${maxConcurrent} (waves if jobs>maxConcurrent): ${jobs.map((j) => j.name).join(", ")}`);

	const startWall = performance.now();
	// Live per-lane counters (updated by runLane as the reporter emits file lines).
	const stats = {};
	for (const j of jobs) stats[j.name] = { files: 0, tests: 0, failedTests: 0, failedFiles: [], failNotes: [], rpcTimeouts: 0, summarySeen: false, summaryFailed: 0, summaryPassed: 0, infraFlake: false, done: false, started: false, wallMs: 0 };

	// Heartbeat: a compact progress line so the run is never silent and early
	// feedback (counts + failures-so-far) is visible while work is in flight.
	const heartbeat = setInterval(() => {
		const el = ((performance.now() - startWall) / 1000).toFixed(0);
		const parts = jobs.map((j) => {
			const s = stats[j.name];
			if (!s.started) return `${j.name} · queued`;
			const mark = s.done ? "✓done" : "…";
			return `${j.name} ${mark} ${s.files}f/${s.tests}t${s.failedTests ? ` ✗${s.failedTests}` : ""}`;
		});
		const totT = jobs.reduce((a, j) => a + stats[j.name].tests, 0);
		const totF = jobs.reduce((a, j) => a + stats[j.name].failedTests, 0);
		console.log(`[unit-lanes +${el}s] ${totT} tests${totF ? `, ${totF} FAILED` : ""} | ${parts.join("  |  ")}`);
	}, HEARTBEAT_MS);
	if (typeof heartbeat.unref === "function") heartbeat.unref();

	const results = [];
	const queue = [...jobs];
	const active = new Set();
	const launch = (j) => {
		if (!j.projects.length) {
			console.error(`[unit-lanes] unknown lane "${j.name}" (known: ${Object.keys(LANES).join(", ")})`);
			return Promise.resolve({ name: j.name, projects: [], code: 1, wallMs: 0, error: "unknown lane" });
		}
		stats[j.name].started = true;
		console.log(`▸ [${j.name}] started (${perLane} forks): ${j.projects.join(", ")}${j.files ? ` · ${j.files.length} files` : ""}`);
		return runLane(j.name, j.projects, perLane, j.files, reservation.parentRunId, stats);
	};
	while (queue.length || active.size) {
		while (queue.length && active.size < maxConcurrent) {
			const j = queue.shift();
			const p = launch(j).then((r) => { active.delete(p); results.push(r); return r; });
			active.add(p);
		}
		if (active.size) await Promise.race(active);
	}
	clearInterval(heartbeat);
	reservation.release();
	const totalWallMs = Math.round(performance.now() - startWall);

	console.log("\n[unit-lanes] results:");
	for (const r of results.sort((a, b) => b.wallMs - a.wallMs)) {
		const status = r.code === 0 ? "PASS" : "FAIL";
		console.log(`  ${status}  ${r.name.padEnd(12)} ${(r.wallMs / 1000).toFixed(1)}s  [${r.projects.join(", ")}]${r.error ? ` — ${r.error}` : ""}  (log: ${r.logPath})`);
	}
	const slowest = results.reduce((a, r) => (r.wallMs > a ? r.wallMs : a), 0);
	const serialSum = results.reduce((a, r) => a + r.wallMs, 0);
	const grandPassed = jobs.reduce((a, j) => a + (stats[j.name].summarySeen ? stats[j.name].summaryPassed : stats[j.name].tests), 0);
	const grandFailed = jobs.reduce((a, j) => a + (stats[j.name].summarySeen ? stats[j.name].summaryFailed : stats[j.name].failedTests), 0);
	const grandRpc = jobs.reduce((a, j) => a + stats[j.name].rpcTimeouts, 0);
	console.log(`\n[unit-lanes] ${grandPassed} tests passed, ${grandFailed} failed across ${jobs.length} lane(s)${grandRpc ? ` · ${grandRpc} worker-RPC timeout(s) under load` : ""}`);
	console.log(`[unit-lanes] total wall ${(totalWallMs / 1000).toFixed(1)}s (slowest lane ${(slowest / 1000).toFixed(1)}s; serial-sum would be ${(serialSum / 1000).toFixed(1)}s)`);

	// Real failures = lanes that failed AFTER the infra-flake downgrade.
	const realFailedLanes = results.filter((r) => r.code !== 0);
	if (realFailedLanes.length) {
		console.error(`\n[unit-lanes] FAILURES:`);
		for (const r of realFailedLanes) {
			const s = stats[r.name];
			console.error(`  ${r.name}: ${s.summaryFailed || s.failedTests} failed test(s) in ${new Set(s.failedFiles).size} file(s)`);
			for (const f of [...new Set(s.failedFiles)]) console.error(`    ✗ ${f}`);
			for (const note of s.failNotes.slice(0, 20)) console.error(`      ${note}`);
			console.error(`    (full detail: ${join(LOG_DIR, `${r.name}.log`)})`);
		}
	}

	// Infra-flake lanes: all tests passed, downgraded from a nonzero exit caused
	// only by worker-RPC timeouts. Surfaced loudly but do NOT fail the gate.
	const flakeLanes = results.filter((r) => r.infraFlake);
	if (flakeLanes.length) {
		console.warn(`\n[unit-lanes] ⚠ INFRA-FLAKE (passed, not gating): ${flakeLanes.map((r) => `${r.name} (${r.rpcTimeouts} RPC timeout${r.rpcTimeouts === 1 ? "" : "s"})`).join(", ")}`);
		console.warn(`    Known CPU-starvation reporter-RPC timeout under N-way load — see docs/testing-strategy.md. All tests passed; re-run on a quiet box to confirm.`);
	}

	if (realFailedLanes.length) console.error(`\n[unit-lanes] FAIL — lane(s): ${realFailedLanes.map((r) => r.name).join(", ")}`);
	else console.log(`\n[unit-lanes] PASS — ${grandPassed} tests, 0 real failures${grandRpc ? ` (${grandRpc} worker-RPC timeout(s) tolerated as infra flake)` : ""}`);
	process.exit(realFailedLanes.length ? 1 : 0);
}

main().catch((e) => { console.error("[unit-lanes] fatal:", e); process.exit(1); });
