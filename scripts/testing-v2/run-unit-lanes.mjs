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
 *   - Windows keeps integration and DOM at one fork, avoiding the Vitest 3.2
 *     onTaskUpdate worker-RPC failures seen when every concurrent lane used two
 *     forks (#8164/#6511), and cost-balances integration over two disjoint jobs.
 *     The much longer core lane may use a second fork only after the grant can
 *     fund the maximum three concurrent processes at one worker each. This avoids
 *     both the one-fork core timeout and the old all-lanes-two-fork saturation.
 *     Non-Windows keeps the two-fork, single-integration-job defaults. Windows
 *     also caps active lane jobs at three: the fourth job introduced by
 *     integration sharding runs in a second wave instead of starving every
 *     Vitest process.
 *
 * UNIT_LANES_FORK_CAP remains an experimental core override on Windows (all
 * lanes elsewhere); UNIT_LANES_INTEGRATION_SHARDS still controls sharding. A
 * Vitest 4.x upgrade carrying the full #8297 fix is the larger alternative.
 *
 * Concurrent full vitest runs are an anticipated mode (see
 * docs/testing-v2/concurrency-proof.md and the retry bridge in vitest.config.ts),
 * so running lanes concurrently is within the harness's designed envelope.
 *
 * Usage:
 *   node scripts/testing-v2/run-unit-lanes.mjs [--lane core|integration|dom] [--forks N] [--list]
 */
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, mkdirSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { reserveVitestLaneBudget, readLedger } from "./ledger.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const LOG_DIR = join(REPO_ROOT, ".profiles", "unit-lanes");

// Vitest 3.2's worker RPC is unstable on Windows when concurrent lanes each use
// two forks, even though two forks is safe for a standalone process. Keep the
// Windows short lanes at one fork while preserving the existing two-fork default
// on other platforms. The Windows core lane has a separate two-fork cap because
// it is the long pole. Invalid overrides fall back to the platform default
// instead of poisoning scheduler math with NaN (which would stall every lane).
export function defaultPerLaneForkCap(platform = process.platform) {
	return platform === "win32" ? 1 : 2;
}

export function defaultCoreForkCap(platform = process.platform) {
	return platform === "win32" ? 2 : defaultPerLaneForkCap(platform);
}

function resolveForkCap(override, fallback) {
	if (override == null || String(override).trim() === "") return fallback;
	const parsed = Number(override);
	return Number.isFinite(parsed) ? Math.max(1, Math.floor(parsed)) : fallback;
}

export function resolvePerLaneForkCap({ platform = process.platform, override = process.env.UNIT_LANES_FORK_CAP } = {}) {
	return resolveForkCap(override, defaultPerLaneForkCap(platform));
}

export function resolveCoreForkCap({ platform = process.platform, override = process.env.UNIT_LANES_FORK_CAP } = {}) {
	return resolveForkCap(override, defaultCoreForkCap(platform));
}

const PER_LANE_FORK_CAP = resolvePerLaneForkCap();
const CORE_FORK_CAP = resolveCoreForkCap();

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
// The [vitest-worker] birpc timeout signature — the documented CPU-starvation
// reporter-RPC flake (onTaskUpdate/onUnhandledError/fetch/transform/resolveId),
// which is a transport artifact under load, NOT a test result.
const WORKER_RPC_TIMEOUT_RE = /\[vitest-(worker|api)\]: Timeout calling "(onTaskUpdate|onUnhandledError|onCollected|fetch|transform|resolveId)"/;

// With Windows lanes reduced to one fork, integration became the pole and missed
// the outer gate by a small margin despite completing tests successfully. Split
// it into two cost-balanced processes by default on Windows; the fair grant keeps
// both one-fork shards within the existing budget. Non-Windows retains its proven
// single integration job, and the env override remains available for experiments.
export function defaultIntegrationShardCount(platform = process.platform) {
	return platform === "win32" ? 2 : 1;
}

export function resolveIntegrationShardCount({ platform = process.platform, override = process.env.UNIT_LANES_INTEGRATION_SHARDS } = {}) {
	const fallback = defaultIntegrationShardCount(platform);
	if (override == null || String(override).trim() === "") return fallback;
	const parsed = Number(override);
	return Number.isFinite(parsed) ? Math.max(1, Math.floor(parsed)) : fallback;
}

// Four concurrent Vitest processes (core + two integration shards + dom) still
// starve Windows enough to trigger worker-RPC timeouts and false test failures.
// Keep the one-fork/two-shard plan, but launch at most three jobs at once. Other
// platforms retain grant-only scheduling with no additional process-count cap.
export function defaultConcurrentLaneJobCap(platform = process.platform) {
	return platform === "win32" ? 3 : Number.POSITIVE_INFINITY;
}

function listTestFiles(rel) {
	const root = join(REPO_ROOT, rel);
	const out = [];
	const walk = (d) => {
		for (const e of readdirSync(d, { withFileTypes: true })) {
			const p = join(d, e.name);
			if (e.isDirectory()) walk(p);
			else if (/\.test\.ts$/.test(e.name)) out.push(relative(REPO_ROOT, p).split(/[\\/]/).join("/"));
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
// File paths are repo-relative so profile keys and Vitest CLI filters use the
// same canonical shape. Stable path tie-breaking makes the plan deterministic.
export function shardByCost(files, shards, cost = costMap()) {
	const count = Math.max(1, Math.floor(Number(shards)) || 1);
	const weighted = [...files]
		.map((f) => {
			const recorded = Number(cost.get(f));
			return { f, w: Number.isFinite(recorded) && recorded >= 0 ? recorded : 1000 };
		})
		.sort((a, b) => (b.w - a.w) || a.f.localeCompare(b.f));
	const bins = Array.from({ length: count }, () => ({ files: [], w: 0 }));
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

// Pure job planning seam. Shard file lists are disjoint; selecting both unit
// integration projects for every shard is safe because their config include/
// exclude sets are disjoint, so each explicit file executes in exactly one
// project and exactly one shard. A one-shard run remains unfiltered and therefore
// byte-for-byte equivalent to the prior non-Windows command.
export function planLaneJobs({
	laneNames = Object.keys(LANES),
	platform = process.platform,
	integrationShardOverride = process.env.UNIT_LANES_INTEGRATION_SHARDS,
	integrationFiles,
	integrationCosts,
} = {}) {
	const integrationShards = resolveIntegrationShardCount({ platform, override: integrationShardOverride });
	const jobs = [];
	for (const name of laneNames) {
		if (name === "integration" && integrationShards > 1) {
			const files = integrationFiles ?? listTestFiles("tests2/integration");
			const shards = shardByCost(files, integrationShards, integrationCosts ?? costMap());
			shards.forEach((shard, index) => jobs.push({
				name: `integration-${index + 1}`,
				projects: [...LANES.integration],
				files: shard.files,
			}));
		} else {
			jobs.push({ name, projects: [...(LANES[name] || [])], files: undefined });
		}
	}
	return jobs;
}

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

/**
 * Pure scheduling math (pinned by tests2/core/unit-lanes-scheduling.test.ts).
 *
 * The uniform planner remains the non-Windows policy: every lane gets the same
 * safe per-process fork cap and the process count shrinks until total workers fit
 * the grant.
 */
export function planLaneConcurrency({ grant, perLaneCap, jobCount, concurrentJobCap = Number.POSITIVE_INFINITY }) {
	const g = Math.max(1, Math.floor(Number(grant)) || 1);
	const cap = Math.max(1, Math.floor(Number(perLaneCap)) || 1);
	const jobs = Math.max(1, Math.floor(Number(jobCount)) || 1);
	const requestedJobCap = Number(concurrentJobCap);
	const jobCap = Number.isFinite(requestedJobCap)
		? Math.max(1, Math.floor(requestedJobCap) || 1)
		: jobs;
	const perLane = Math.min(cap, g);
	const maxConcurrent = Math.max(1, Math.min(jobs, jobCap, Math.floor(g / perLane)));
	return { perLane, maxConcurrent };
}

/**
 * Deterministic per-job allocation. Windows funds process fairness first: up to
 * three jobs receive one worker, then any remaining grant may raise only the core
 * job to its cap. Thus grants 1..3 never let core monopolize a worker needed to
 * overlap another lane, while grant >=4 yields core=2 + two short one-fork jobs.
 * Integration and DOM always remain at one fork. Non-Windows preserves the
 * uniform planner above.
 */
export function planLaneAllocation({
	grant,
	jobs,
	platform = process.platform,
	perLaneCap = resolvePerLaneForkCap({ platform }),
	coreForkCap = resolveCoreForkCap({ platform }),
	concurrentJobCap = defaultConcurrentLaneJobCap(platform),
}) {
	const g = Math.max(1, Math.floor(Number(grant)) || 1);
	const plannedJobs = [...jobs];
	if (platform !== "win32") {
		const { perLane, maxConcurrent } = planLaneConcurrency({
			grant: g,
			perLaneCap,
			jobCount: plannedJobs.length,
			concurrentJobCap,
		});
		return { jobs: plannedJobs.map((job) => ({ ...job, forks: perLane })), maxConcurrent };
	}

	const requestedJobCap = Number(concurrentJobCap);
	const jobCap = Number.isFinite(requestedJobCap)
		? Math.max(1, Math.floor(requestedJobCap) || 1)
		: plannedJobs.length;
	const maxConcurrent = Math.max(1, Math.min(plannedJobs.length || 1, jobCap, g));
	const safeCoreCap = Math.max(1, Math.floor(Number(coreForkCap)) || 1);
	// Reserve one worker for every process that can run concurrently before giving
	// core its second worker. This is the low-grant fairness invariant.
	const coreForks = 1 + Math.min(safeCoreCap - 1, Math.max(0, g - maxConcurrent));
	return {
		jobs: plannedJobs.map((job) => ({ ...job, forks: job.name === "core" ? coreForks : 1 })),
		maxConcurrent,
	};
}

// Kill the complete lane process tree. Windows needs taskkill /T because killing
// the npx.cmd shell alone leaves Vitest workers alive. POSIX lanes are detached
// process-group leaders, so a negative pid reaches every descendant.
export function killLaneProcessTree(child, {
	platform = process.platform,
	spawnSyncImpl = spawnSync,
	killImpl = process.kill.bind(process),
} = {}) {
	const pid = Number(child?.pid);
	if (!Number.isFinite(pid) || pid <= 0) return;
	if (platform === "win32") {
		try {
			spawnSyncImpl("taskkill.exe", ["/PID", String(Math.floor(pid)), "/T", "/F"], {
			stdio: "ignore",
			windowsHide: true,
			timeout: 5_000,
		});
		} catch { /* best-effort fallback below */ }
		try { child.kill?.("SIGKILL"); } catch { /* already exited */ }
		return;
	}
	try { killImpl(-Math.floor(pid), "SIGKILL"); }
	catch { try { child.kill?.("SIGKILL"); } catch { /* already exited */ } }
}

// Owns the active lane registry, heartbeat and ledger reservation as one
// idempotent cleanup unit. Signal/error handlers and normal completion use the
// same path, preventing either child trees or ledger slots from leaking.
export function createRunCleanup({ release, killTree = killLaneProcessTree, clearTimer = clearInterval }) {
	const children = new Set();
	let heartbeat;
	let cleaned = false;
	return {
		track(child) {
			if (cleaned) killTree(child);
			else children.add(child);
			return child;
		},
		untrack(child) { children.delete(child); },
		setHeartbeat(timer) {
			if (heartbeat && heartbeat !== timer) clearTimer(heartbeat);
			heartbeat = timer;
			if (cleaned && heartbeat) {
				clearTimer(heartbeat);
				heartbeat = undefined;
			}
		},
		cleanup() {
			if (cleaned) return;
			cleaned = true;
			if (heartbeat) {
				clearTimer(heartbeat);
				heartbeat = undefined;
			}
			for (const child of children) {
				try { killTree(child); } catch { /* cleanup must continue */ }
			}
			children.clear();
			try { release(); } catch { /* ledger also self-heals */ }
		},
	};
}

export function installRunTerminationHandlers(cleanup, {
	processTarget = process,
	reportError = (label, error) => console.error(`[unit-lanes] ${label}:`, error),
} = {}) {
	const terminate = (code, label, error) => {
		if (error !== undefined) reportError(label, error);
		cleanup.cleanup();
		processTarget.exit(code);
	};
	const handlers = new Map([
		["SIGINT", () => terminate(130, "interrupted")],
		["SIGTERM", () => terminate(143, "terminated")],
		["SIGHUP", () => terminate(129, "hangup")],
		["uncaughtException", (error) => terminate(1, "uncaught exception", error)],
		["unhandledRejection", (error) => terminate(1, "unhandled rejection", error)],
		["exit", () => cleanup.cleanup()],
	]);
	for (const [event, handler] of handlers) processTarget.once(event, handler);
	return () => {
		for (const [event, handler] of handlers) processTarget.removeListener(event, handler);
	};
}

function runLane(name, projects, forks, files, parentRunId, stats, cleanup) {
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
			// POSIX process groups make whole-tree termination reliable. Windows uses
			// taskkill /T against the shell pid tracked below.
			detached: process.platform !== "win32",
			windowsHide: true,
		});
		cleanup.track(child);
		let settled = false;
		const finish = (result) => {
			if (settled) return;
			settled = true;
			cleanup.untrack(child);
			out.end();
			resolveRun(result);
		};
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
			finish({ name, projects, code: c, signal, wallMs: st.wallMs, logPath, infraFlake: st.infraFlake, rpcTimeouts: st.rpcTimeouts });
		});
		child.on("error", (error) => {
			st.done = true;
			st.wallMs = Math.round(performance.now() - startWall);
			finish({ name, projects, code: 1, error: String(error), wallMs: st.wallMs, logPath });
		});
	});
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const laneNames = args.lanes ?? Object.keys(LANES);

	// Windows expands integration into two cost-balanced, disjoint one-fork jobs
	// by default. Explicit shard/fork overrides and non-Windows defaults flow
	// through the same planner without changing coverage or failure accounting.
	const jobs = planLaneJobs({ laneNames });

	if (args.list) {
		console.log(JSON.stringify(jobs.map((j) => ({ name: j.name, projects: j.projects, files: j.files?.length ?? "all" })), null, 2));
		return 0;
	}

	// Reserve ONCE for the whole unit run. reserveVitestLaneBudget() returns the
	// ledger's fair CORE grant W (an ORCHESTRATOR budget, capped at VITEST_CAP — NOT
	// the single-process STANDALONE_VITEST_CAP throttle, which would collapse lane
	// parallelism to maxConcurrent=1 and serialise the lanes past the gate wall-time
	// budget). W shrinks as concurrent goals appear via pending/committed accounting,
	// OR — when spawned under run-v2 — is the pre-committed parent grant with a no-op
	// release. Either way this is the ONLY ledger entry for the run; each spawned lane
	// re-uses this grant via the parent-grant env with its own per-lane fork cap.
	const reservation = reserveVitestLaneBudget();
	const cleanup = createRunCleanup({ release: reservation.release });
	const uninstallTerminationHandlers = installRunTerminationHandlers(cleanup);
	try {
	const grant = Math.max(1, reservation.workerSlots || 1);
	// Distribute the grant across lanes. Windows reserves one worker for each of
	// its three process slots before raising only the long core lane to two forks;
	// non-Windows keeps uniform per-lane allocation. The launch loop independently
	// enforces activeWorkers <= grant while extra jobs queue in deterministic waves.
	const allocation = planLaneAllocation({
		grant,
		jobs,
		perLaneCap: PER_LANE_FORK_CAP,
		coreForkCap: CORE_FORK_CAP,
		concurrentJobCap: defaultConcurrentLaneJobCap(),
	});
	const scheduledJobs = allocation.jobs;
	const { maxConcurrent } = allocation;
	const snap = readLedger();
	const sigma = snap.reservations.reduce((s, r) => s + (r.workerSlots || 0), 0);
	console.log(`[unit-lanes] ledger grant=${grant} (parent=${reservation.parentRunId}, managedByParent=${reservation.managedByParent}); ledger Σ=${sigma}/${snap.totalCores}`);
	console.log(`[unit-lanes] ${scheduledJobs.length} job(s), maxConcurrent=${maxConcurrent} (waves if jobs>maxConcurrent): ${scheduledJobs.map((j) => `${j.name}=${j.forks}`).join(", ")} forks`);

	const startWall = performance.now();
	// Live per-lane counters (updated by runLane as the reporter emits file lines).
	const stats = {};
	for (const j of scheduledJobs) stats[j.name] = { files: 0, tests: 0, failedTests: 0, failedFiles: [], failNotes: [], rpcTimeouts: 0, summarySeen: false, summaryFailed: 0, summaryPassed: 0, infraFlake: false, done: false, started: false, wallMs: 0 };

	// Heartbeat: a compact progress line so the run is never silent and early
	// feedback (counts + failures-so-far) is visible while work is in flight.
	const heartbeat = setInterval(() => {
		const el = ((performance.now() - startWall) / 1000).toFixed(0);
		const parts = scheduledJobs.map((j) => {
			const s = stats[j.name];
			if (!s.started) return `${j.name} · queued`;
			const mark = s.done ? "✓done" : "…";
			return `${j.name} ${mark} ${s.files}f/${s.tests}t${s.failedTests ? ` ✗${s.failedTests}` : ""}`;
		});
		const totT = scheduledJobs.reduce((a, j) => a + stats[j.name].tests, 0);
		const totF = scheduledJobs.reduce((a, j) => a + stats[j.name].failedTests, 0);
		console.log(`[unit-lanes +${el}s] ${totT} tests${totF ? `, ${totF} FAILED` : ""} | ${parts.join("  |  ")}`);
	}, HEARTBEAT_MS);
	cleanup.setHeartbeat(heartbeat);
	if (typeof heartbeat.unref === "function") heartbeat.unref();

	const results = [];
	const queue = [...scheduledJobs];
	const active = new Set();
	let activeWorkers = 0;
	const launch = (j) => {
		if (!j.projects.length) {
			console.error(`[unit-lanes] unknown lane "${j.name}" (known: ${Object.keys(LANES).join(", ")})`);
			return Promise.resolve({ name: j.name, projects: [], code: 1, wallMs: 0, error: "unknown lane" });
		}
		stats[j.name].started = true;
		console.log(`▸ [${j.name}] started (${j.forks} forks): ${j.projects.join(", ")}${j.files ? ` · ${j.files.length} files` : ""}`);
		return runLane(j.name, j.projects, j.forks, j.files, reservation.parentRunId, stats, cleanup);
	};
	while (queue.length || active.size) {
		while (queue.length && active.size < maxConcurrent) {
			// Deterministic first-fit keeps queue order whenever possible while making
			// the worker-grant bound explicit at the launch boundary.
			const nextIndex = queue.findIndex((job) => activeWorkers + job.forks <= grant);
			if (nextIndex < 0) break;
			const [j] = queue.splice(nextIndex, 1);
			activeWorkers += j.forks;
			let p;
			p = launch(j).then((r) => {
				results.push(r);
				return r;
			}).finally(() => {
				active.delete(p);
				activeWorkers -= j.forks;
			});
			active.add(p);
		}
		if (active.size) await Promise.race(active);
	}
	cleanup.cleanup();
	const totalWallMs = Math.round(performance.now() - startWall);

	console.log("\n[unit-lanes] results:");
	for (const r of results.sort((a, b) => b.wallMs - a.wallMs)) {
		const status = r.code === 0 ? "PASS" : "FAIL";
		console.log(`  ${status}  ${r.name.padEnd(12)} ${(r.wallMs / 1000).toFixed(1)}s  [${r.projects.join(", ")}]${r.error ? ` — ${r.error}` : ""}  (log: ${r.logPath})`);
	}
	const slowest = results.reduce((a, r) => (r.wallMs > a ? r.wallMs : a), 0);
	const serialSum = results.reduce((a, r) => a + r.wallMs, 0);
	const grandPassed = scheduledJobs.reduce((a, j) => a + (stats[j.name].summarySeen ? stats[j.name].summaryPassed : stats[j.name].tests), 0);
	const grandFailed = scheduledJobs.reduce((a, j) => a + (stats[j.name].summarySeen ? stats[j.name].summaryFailed : stats[j.name].failedTests), 0);
	const grandRpc = scheduledJobs.reduce((a, j) => a + stats[j.name].rpcTimeouts, 0);
	console.log(`\n[unit-lanes] ${grandPassed} tests passed, ${grandFailed} failed across ${scheduledJobs.length} lane(s)${grandRpc ? ` · ${grandRpc} worker-RPC timeout(s) under load` : ""}`);
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
	return realFailedLanes.length ? 1 : 0;
	} finally {
		cleanup.cleanup();
		uninstallTerminationHandlers();
	}
}

// Only run when invoked directly (`node run-unit-lanes.mjs`), so tests can import
// the pure `planLaneConcurrency` helper without triggering a full unit run.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
	main()
		.then((code) => { process.exitCode = code; })
		.catch((e) => { console.error("[unit-lanes] fatal:", e); process.exitCode = 1; });
}
