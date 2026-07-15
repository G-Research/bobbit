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
 * processes. Wall becomes max(lanes) instead of sum(lanes). Each lane has an
 * isolated module registry, so node<->happy-dom environment bleed cannot cross
 * lane boundaries. Vitest 4 removes the worker-RPC timeout that previously capped
 * every lane at two workers; the orchestrator now distributes the full ledger
 * grant across all lanes in proportion to measured work.
 *
 * Concurrent full Vitest runs are an anticipated mode (see
 * docs/testing-v2/concurrency-proof.md). The ledger keeps their worker total
 * bounded; failures remain visible because Vitest retries are disabled.
 *
 * Usage:
 *   node scripts/testing-v2/run-unit-lanes.mjs [--lane core|integration|dom] [--list]
 */
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { reserveVitestLaneBudget, readLedger } from "./ledger.mjs";
import { ensureServerTestPrebundle } from "./server-prebundle.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const LOG_DIR = join(REPO_ROOT, ".profiles", "unit-lanes");

// Heartbeat cadence for the live progress line. Clamp to >=1s and reject
// non-numeric/zero/negative values so a bad override can't flood the console
// (setInterval(fn, 0|NaN) fires continuously).
const _heartbeatMs = Number(process.env.UNIT_LANES_HEARTBEAT_MS || "12000");
const HEARTBEAT_MS = Number.isFinite(_heartbeatMs) ? Math.max(1000, Math.floor(_heartbeatMs)) : 12000;

// Per-file completion line emitted by the vitest default reporter, e.g.
//   " ✓ |v2-core| tests2/core/foo.test.ts (12 tests) 340ms"
//   " ❯ tests2/core/bar.test.ts (5 tests | 1 failed) 200ms"
const FILE_LINE_RE = /(tests2\/[^\s]+\.(?:test|spec)\.ts)\b[^\n]*\((\d+)\s+tests?(?:\s*\|\s*(\d+)\s+failed)?[^)]*\)/;
// Lines worth surfacing to the console live (failures + the final tallies).
const FAIL_LINE_RE = /(^|\s)(FAIL|×|✗)\s|AssertionError|Unhandled (Error|Rejection)/;
// This signature should be impossible on Vitest 4. Keep it diagnostic: if it
// ever reappears, the lane fails normally rather than being downgraded to pass.
const WORKER_RPC_TIMEOUT_RE = /\[vitest-(worker|api)\]: Timeout calling "(onTaskUpdate|onUnhandledError|onCollected|fetch|transform|resolveId)"/;

// Integration carries the most work. Optional cost-balanced sharding remains an
// experimental lever, but the default weighted worker allocation already gives
// the unsharded integration lane half of an eight-worker suite grant.
const INTEGRATION_SHARDS = Math.max(1, Number(process.env.UNIT_LANES_INTEGRATION_SHARDS || "3"));

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
	core: { projects: ["v2-core", "v2-core-heavy", "v2-core-isolated"], weight: 2 },
	"core-fidelity": { projects: ["v2-core-fidelity"], weight: 1 },
	integration: { projects: ["v2-integration", "v2-integration-source", "v2-integration-isolated", "v2-integration-command", "v2-integration-fake"], weight: 3 },
	dom: { projects: ["v2-dom"], weight: 2 },
};

function parseArgs(argv) {
	const out = { lanes: null, list: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--lane") out.lanes = [String(argv[++i] || "").toLowerCase()];
		else if (a === "--list") out.list = true;
	}
	return out;
}

const VITEST_CLI = join(REPO_ROOT, "node_modules", "vitest", "vitest.mjs");

/**
 * Allocate a suite's ledger grant across weighted lanes. Every lane receives one
 * worker first; remaining workers go to the lane with the lowest
 * allocated/weight ratio. With the normal 24-core / three-suite grant of eight,
 * core:integration:dom weights 3:4:1 produce 3+4+1 workers and all lanes start
 * immediately. If a grant is smaller than the job count, one-worker lanes run in
 * waves, which is the only mathematically possible fallback.
 */
export function planLaneWorkers({ grant, jobs }) {
	const budget = Math.max(1, Math.floor(Number(grant)) || 1);
	const normalized = jobs.map((job, index) => ({
		name: String(job.name),
		weight: Math.max(Number(job.weight) || 1, Number.EPSILON),
		index,
	}));
	if (normalized.length === 0) return { workers: {}, maxConcurrent: 0, used: 0 };

	const workers = Object.fromEntries(normalized.map((job) => [job.name, 1]));
	if (budget < normalized.length) {
		return { workers, maxConcurrent: budget, used: budget };
	}
	let remaining = budget - normalized.length;
	while (remaining > 0) {
		const next = normalized.reduce((best, job) => {
			const ratio = workers[job.name] / job.weight;
			const bestRatio = workers[best.name] / best.weight;
			return ratio < bestRatio || (ratio === bestRatio && job.index < best.index) ? job : best;
		});
		workers[next.name] += 1;
		remaining -= 1;
	}
	return { workers, maxConcurrent: normalized.length, used: budget };
}

function runLane(name, projects, workers, files, parentRunId, stats, serverPrebundle) {
	const startWall = performance.now();
	mkdirSync(LOG_DIR, { recursive: true });
	const logPath = join(LOG_DIR, `${name}.log`);
	const out = createWriteStream(logPath);
	const st = stats[name];
	// The DEFAULT reporter prints one line per completed FILE (glyph + path +
	// "(N tests[ | M failed])"), which we parse for live counts + surface failures
	// immediately. Full detail still lands in the per-lane log.
	const projectArgs = projects.flatMap((p) => ["--project", p]);
	const args = [VITEST_CLI, "run", "--config", "vitest.config.ts", "--silent=passed-only", ...projectArgs, ...(files || [])];
	return new Promise((resolveRun) => {
		const child = spawn(process.execPath, args, {
			cwd: REPO_ROOT,
			// LEDGER-NATIVE: the orchestrator holds ONE reservation for the whole unit
			// run; each lane REUSES that grant via the parent-grant env (the same seam
			// run-v2 uses), so the config's reserveWorkerSlots() takes the managed,
			// no-op-release path and never registers a second ledger entry.
			env: {
				...process.env,
				BOBBIT_V2_LEDGER_PARENT: parentRunId,
				BOBBIT_V2_SLOTS_VITEST: String(workers),
				...(serverPrebundle ? { BOBBIT_V2_SERVER_PREBUNDLE: serverPrebundle } : {}),
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		const handleLine = (raw, isErr) => {
			out.write(raw + "\n");
			// Strip ANSI so detection works whether or not vitest emitted color.
			const line = raw.replace(/\x1b\[[0-9;]*m/g, "");
			// Count any unexpected regression of the removed Vitest 3 birpc timeout.
			if (WORKER_RPC_TIMEOUT_RE.test(line)) st.rpcTimeouts += 1;
			// Capture Vitest's authoritative final tally ("Tests N passed | M failed").
			if (/^\s*Test Files\s+\d/.test(line) && /(passed|failed)/.test(line)) {
				const f = /(\d+)\s+failed/.exec(line);
				st.summaryFailedSuites = f ? Number(f[1]) : 0;
			}
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
			console.log(`▸ [${name}] ${rawCode === 0 ? "PASS" : "FAIL"} — ${st.files} files, ${passedN} tests, ${realFailed} failed${st.rpcTimeouts ? `, ${st.rpcTimeouts} unexpected rpc-timeout` : ""} in ${(st.wallMs / 1000).toFixed(1)}s`);
			resolveRun({ name, projects, code: rawCode, signal, wallMs: st.wallMs, logPath, rpcTimeouts: st.rpcTimeouts });
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

	// Expand the integration lane into optional cost-balanced file shards.
	const jobs = [];
	for (const n of laneNames) {
		const lane = LANES[n];
		if (n === "integration" && INTEGRATION_SHARDS > 1) {
			const files = listTestFiles("tests2/integration");
			const shards = shardByCost(files, INTEGRATION_SHARDS);
			shards.forEach((s, i) => jobs.push({ name: `integration-${i + 1}`, projects: lane.projects, files: s.files, weight: lane.weight / shards.length }));
		} else {
			jobs.push({ name: n, projects: lane?.projects || [], files: undefined, weight: lane?.weight || 1 });
		}
	}

	if (args.list) {
		console.log(JSON.stringify(jobs.map((j) => ({ name: j.name, projects: j.projects, files: j.files?.length ?? "all" })), null, 2));
		return;
	}

	let serverPrebundle;
	if (jobs.some((job) => job.projects.some((project) => project.startsWith("v2-integration")))) {
		const prebundle = await ensureServerTestPrebundle();
		serverPrebundle = prebundle.bundlePath;
		console.log(`[unit-lanes] server prebundle ${prebundle.cacheHit ? "cache hit" : "built"}: ${prebundle.key}`);
	}

	// Reserve once for the whole unit run. Each child lane reuses this reservation;
	// no lane creates a second ledger entry.
	const reservation = reserveVitestLaneBudget();
	const grant = Math.max(1, reservation.workerSlots || 1);
	const plan = planLaneWorkers({ grant, jobs });
	const snap = readLedger();
	const sigma = snap.reservations.reduce((s, r) => s + (r.workerSlots || 0), 0);
	console.log(`[unit-lanes] ledger grant=${grant} (parent=${reservation.parentRunId}, managedByParent=${reservation.managedByParent}); ledger Σ=${sigma}/${snap.totalCores}`);
	console.log(`[unit-lanes] ${jobs.length} job(s), maxConcurrent=${plan.maxConcurrent}: ${jobs.map((j) => `${j.name}=${plan.workers[j.name]}w`).join(", ")}`);

	const startWall = performance.now();
	// Live per-lane counters (updated by runLane as the reporter emits file lines).
	const stats = {};
	for (const j of jobs) stats[j.name] = { files: 0, tests: 0, failedTests: 0, failedFiles: [], failNotes: [], rpcTimeouts: 0, summarySeen: false, summaryFailed: 0, summaryFailedSuites: 0, summaryPassed: 0, done: false, started: false, wallMs: 0 };

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
		const workers = plan.workers[j.name];
		console.log(`▸ [${j.name}] started (${workers} workers): ${j.projects.join(", ")}${j.files ? ` · ${j.files.length} files` : ""}`);
		return runLane(j.name, j.projects, workers, j.files, reservation.parentRunId, stats, serverPrebundle);
	};
	while (queue.length || active.size) {
		while (queue.length && active.size < plan.maxConcurrent) {
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
	console.log(`\n[unit-lanes] ${grandPassed} tests passed, ${grandFailed} failed across ${jobs.length} lane(s)${grandRpc ? ` · ${grandRpc} UNEXPECTED worker-RPC timeout(s)` : ""}`);
	console.log(`[unit-lanes] total wall ${(totalWallMs / 1000).toFixed(1)}s (slowest lane ${(slowest / 1000).toFixed(1)}s; serial-sum would be ${(serialSum / 1000).toFixed(1)}s)`);

	const realFailedLanes = results.filter((r) => r.code !== 0);
	if (realFailedLanes.length) {
		console.error(`\n[unit-lanes] FAILURES:`);
		for (const r of realFailedLanes) {
			const s = stats[r.name];
			console.error(`  ${r.name}: ${s.summaryFailed || s.failedTests} failed test(s), ${s.summaryFailedSuites || new Set(s.failedFiles).size} failed suite(s)`);
			for (const f of [...new Set(s.failedFiles)]) console.error(`    ✗ ${f}`);
			for (const note of s.failNotes.slice(0, 20)) console.error(`      ${note}`);
			console.error(`    (full detail: ${join(LOG_DIR, `${r.name}.log`)})`);
		}
	}

	if (realFailedLanes.length) console.error(`\n[unit-lanes] FAIL — lane(s): ${realFailedLanes.map((r) => r.name).join(", ")}`);
	else console.log(`\n[unit-lanes] PASS — ${grandPassed} tests, 0 real failures`);
	process.exit(realFailedLanes.length ? 1 : 0);
}

// Only run when invoked directly (`node run-unit-lanes.mjs`), so tests can import
// the pure `planLaneWorkers` helper without triggering a full unit run.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
	main().catch((e) => { console.error("[unit-lanes] fatal:", e); process.exit(1); });
}
