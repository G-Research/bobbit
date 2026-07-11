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
const PER_LANE_FORK_CAP = 2;

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

function runLane(name, projects, forks, files, parentRunId) {
	const startWall = performance.now();
	mkdirSync(LOG_DIR, { recursive: true });
	const logPath = join(LOG_DIR, `${name}.log`);
	const out = createWriteStream(logPath);
	const projectArgs = projects.flatMap((p) => ["--project", p]);
	const args = ["vitest", "run", "--config", "vitest.config.ts", "--silent=passed-only", "--reporter=dot", ...projectArgs, ...(files || [])];
	return new Promise((resolveRun) => {
		const child = spawn(vitestCmd(), args, {
			cwd: REPO_ROOT,
			// LEDGER-NATIVE: the orchestrator holds ONE reservation for the whole unit
			// run; each lane REUSES that grant via the parent-grant env (the same seam
			// run-v2 uses), so the config's reserveWorkerSlots() takes the managed,
			// no-op-release path and never registers a second ledger entry. This keeps
			// the Sigma(workers)<=cores invariant across concurrent goals: our total
			// forks = Sigma(lane shares) <= the single reserved grant. `forks` is this
			// lane's share (<= PER_LANE_FORK_CAP); the config still clamps to the
			// Windows-safe cap.
			env: { ...process.env, BOBBIT_V2_LEDGER_PARENT: parentRunId, BOBBIT_V2_SLOTS_VITEST: String(forks) },
			stdio: ["ignore", "pipe", "pipe"],
			shell: process.platform === "win32",
		});
		child.stdout.pipe(out);
		child.stderr.pipe(out);
		child.on("close", (code, signal) => {
			resolveRun({ name, projects, code: code ?? (signal ? 1 : 0), signal, wallMs: Math.round(performance.now() - startWall), logPath });
		});
		child.on("error", (error) => {
			resolveRun({ name, projects, code: 1, error: String(error), wallMs: Math.round(performance.now() - startWall), logPath });
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
	const results = [];
	const queue = [...jobs];
	const active = new Set();
	const launch = (j) => {
		if (!j.projects.length) {
			console.error(`[unit-lanes] unknown lane "${j.name}" (known: ${Object.keys(LANES).join(", ")})`);
			return Promise.resolve({ name: j.name, projects: [], code: 1, wallMs: 0, error: "unknown lane" });
		}
		return runLane(j.name, j.projects, perLane, j.files, reservation.parentRunId);
	};
	while (queue.length || active.size) {
		while (queue.length && active.size < maxConcurrent) {
			const j = queue.shift();
			const p = launch(j).then((r) => { active.delete(p); results.push(r); return r; });
			active.add(p);
		}
		if (active.size) await Promise.race(active);
	}
	reservation.release();
	const totalWallMs = Math.round(performance.now() - startWall);

	console.log("\n[unit-lanes] results:");
	for (const r of results.sort((a, b) => b.wallMs - a.wallMs)) {
		const status = r.code === 0 ? "PASS" : "FAIL";
		console.log(`  ${status}  ${r.name.padEnd(12)} ${(r.wallMs / 1000).toFixed(1)}s  [${r.projects.join(", ")}]${r.error ? ` — ${r.error}` : ""}  (log: ${r.logPath})`);
	}
	const slowest = results.reduce((a, r) => (r.wallMs > a ? r.wallMs : a), 0);
	const serialSum = results.reduce((a, r) => a + r.wallMs, 0);
	console.log(`\n[unit-lanes] total wall ${(totalWallMs / 1000).toFixed(1)}s (slowest lane ${(slowest / 1000).toFixed(1)}s; serial-sum would be ${(serialSum / 1000).toFixed(1)}s)`);

	const failed = results.filter((r) => r.code !== 0);
	if (failed.length) console.error(`[unit-lanes] FAIL — ${failed.map((r) => r.name).join(", ")}`);
	process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error("[unit-lanes] fatal:", e); process.exit(1); });
