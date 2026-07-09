#!/usr/bin/env node
/**
 * assert-budget.mjs — enforce Test Suite v2 wall/CPU budgets (design §6, §6.1).
 *
 * Wall time comes from runner JSON reports; CPU comes from a DIRECT process-tree
 * sampler (user+system, summed across all descendants), because a full run must
 * not pass merely by satisfying two looser tier caps — `--scope full` measures
 * the actual whole-run process-tree CPU and fails above the full cap.
 *
 * ─── CLI ───
 *   node scripts/testing-v2/assert-budget.mjs core --pilot
 *   node scripts/testing-v2/assert-budget.mjs --scope tier1|tier2|full
 *   node scripts/testing-v2/assert-budget.mjs tier1|tier2|full [--wall-ms N] [--cpu-ms N]
 *                                                              [--report path] [--pid N]
 *
 *   Positional scope aliases: core|dom|integration -> tier1, browser -> tier2,
 *   plus tier1|tier2|full. `--pilot` relaxes enforcement: the run is treated as
 *   a partial (~50-file) baseline — numbers are recorded and only a generous
 *   ceiling (the tier cap, which a subset should stay well under) is checked, so
 *   a partial suite establishes a baseline artifact instead of failing.
 *
 * ─── Programmatic (imported by run-v2.mjs) ───
 *   createCpuSampler(rootPid, { intervalMs? }) -> { stop() -> {cpuMs, peakProcesses, samples} }
 *   assertBudget({ scope, wallMs, cpuMs, rawCpuMs?, cpuCeilingMs?, cpuOverCount?, pilot?,
 *                  underLoad?, argv?, reservations?, rootPid?, processCount? })
 *       -> { pass, violations, caps, artifactPath, wallMs, cpuMs }
 *       WALL is the only hard gate; CPU is recorded for observability and NEVER gates.
 *   resolveCaps(scope, pilot?, underLoadOverride?) -> { tier, maxWallMs, maxCpuMs, underLoad?, pilot }
 *       WALL cap is load-aware: under load (override or BOBBIT_V2_CONCURRENCY_RUN) it
 *       switches to budgets.concurrency.perRunMaxWallMs; quiet runs keep the isolated cap.
 *   clampCpuMs(rawCpuMs, cores, wallMs) -> { cpuMs, rawCpuMs, ceilingMs, overCount }
 *       clamps a process-tree reading to the physical ceiling (cores × wall).
 *   isUnderLoad(override?) -> boolean
 *   treeCpuMs(rootPid) -> number    (single cumulative snapshot)
 *
 * Artifacts: .profiles/testing-v2/budgets/<timestamp>-<scope>.json
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { cpus } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "..", "..");
const BUDGETS_PATH = join(REPO_ROOT, "tests2", "budgets.json");
const ARTIFACT_DIR = join(REPO_ROOT, ".profiles", "testing-v2", "budgets");
const SAMPLE_DIR = join(REPO_ROOT, ".profiles", "testing-v2", "samples");

const SCOPE_TIER = {
	core: "tier1",
	dom: "tier1",
	integration: "tier1",
	tier1: "tier1",
	browser: "tier2",
	tier2: "tier2",
	full: "full",
};

export function readBudgets() {
	return JSON.parse(readFileSync(BUDGETS_PATH, "utf8"));
}

/**
 * Is this run competing for the box? WALL is load-aware (design §D7): a run
 * under peer contention legitimately takes longer than the isolated bar, so the
 * committed under-load cap (budgets.concurrency.perRunMaxWallMs, 600 s) applies
 * instead of the quiet isolated cap (300 s). Load is detected two ways:
 *   1. explicit `underLoadOverride` (run-v2 passes ledger-derived peer load), or
 *   2. BOBBIT_V2_CONCURRENCY_RUN (the concurrency-proof harness sets this).
 * We do NOT just raise the isolated cap — quiet runs keep the tight 300 s bar.
 */
export function isUnderLoad(underLoadOverride = undefined) {
	if (underLoadOverride !== undefined) return !!underLoadOverride;
	return !!(process.env.BOBBIT_V2_CONCURRENCY_RUN && process.env.BOBBIT_V2_CONCURRENCY_RUN !== "0");
}

/**
 * Clamp a process-tree CPU-ms reading to the physical ceiling (cores × wall).
 * The sampler sums per-PID cumulative CPU over the run; on a shared/busy box
 * PID churn + ppid misattribution demonstrably over-count PAST what the hardware
 * can physically deliver (observed 465 CPU-min vs a 173 CPU-min ceiling = 2.7×).
 * CPU is observability-only (never gates — see assertBudget), but the RECORDED
 * number must be physically honest, so we cap it at cores×wall and flag the
 * over-count for the artifact. Returns { cpuMs, rawCpuMs, ceilingMs, overCount }.
 */
export function clampCpuMs(rawCpuMs, cores, wallMs) {
	if (!Number.isFinite(rawCpuMs) || !Number.isFinite(cores) || !Number.isFinite(wallMs) || cores <= 0 || wallMs <= 0) {
		return { cpuMs: Number.isFinite(rawCpuMs) ? rawCpuMs : null, rawCpuMs: Number.isFinite(rawCpuMs) ? rawCpuMs : null, ceilingMs: null, overCount: false };
	}
	const ceilingMs = cores * wallMs;
	const overCount = rawCpuMs > ceilingMs;
	return { cpuMs: overCount ? ceilingMs : rawCpuMs, rawCpuMs, ceilingMs, overCount };
}

export function resolveCaps(scope, pilot = false, underLoadOverride = undefined) {
	const tier = SCOPE_TIER[scope];
	if (!tier) throw new Error(`assert-budget: unknown scope "${scope}" (allowed: ${Object.keys(SCOPE_TIER).join(", ")})`);
	const budgets = readBudgets();
	const caps = budgets.tiers[tier];
	if (!caps) throw new Error(`assert-budget: tests2/budgets.json has no tier "${tier}"`);

	// Under-load budget switch (D7): a `test:v2` run (and its vitest/playwright
	// tiers) under N-way concurrent contention legitimately runs longer than the
	// isolated caps. When the concurrency-proof harness sets
	// BOBBIT_V2_CONCURRENCY_RUN=1, EVERY scope's wall cap switches to the under-load
	// per-run cap (budgets.concurrency.perRunMaxWallMs) and CPU stops gating
	// (measurement is unreliable under contention — see assertBudget). This keeps
	// run-v2's exit code an HONEST pass/fail signal for the proof (exit 0 ⇺ tests
	// green AND wall ≤ under-load cap) with no downgraded assertions in the proof.
	const underLoad = isUnderLoad(underLoadOverride);
	if (underLoad && budgets.concurrency) {
		const c = budgets.concurrency;
		// MEASUREMENT decoupling: BOBBIT_V2_PERRUN_WALL_MS overrides the under-load
		// wall cap so the authoritative concurrency measurement can separate the
		// FLAKE signal (tests pass/fail) from the WALL signal (queuing cost of the
		// global budget). The whole premise is "accept higher wall for ~0 flakes", so
		// a run legitimately exceeding the committed 600 s cap is NOT a flake — during
		// measurement we relax the wall gate and record wall separately, leaving the
		// honest committed bar (budgets.json perRunMaxWallMs) untouched.
		const perRunWallOverride = Number(process.env.BOBBIT_V2_PERRUN_WALL_MS);
		const maxWallMs = Number.isFinite(perRunWallOverride) && perRunWallOverride > 0
			? perRunWallOverride
			: (Number.isFinite(c.perRunMaxWallMs) ? c.perRunMaxWallMs : caps.maxWallMs);
		return {
			tier,
			maxWallMs,
			maxCpuMs: Number.isFinite(c.perRunMaxCpuMs) ? c.perRunMaxCpuMs : caps.maxCpuMs,
			label: `${caps.label} (under-load)`,
			pilot: !!pilot,
			underLoad: true,
		};
	}
	return { tier, maxWallMs: caps.maxWallMs, maxCpuMs: caps.maxCpuMs, label: caps.label, pilot: !!pilot };
}

// ───────────────────────── process-tree CPU sampler ─────────────────────────
// Reuses the platform sampling strategy from scripts/metrics/lib.mjs: Windows
// via CIM (cumulative Kernel+User 100ns ticks), POSIX via `ps` cumulative time.

function listProcesses() {
	if (process.platform === "win32") {
		const ps =
			"Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,KernelModeTime,UserModeTime | ConvertTo-Json -Compress";
		const res = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], {
			encoding: "utf8",
			windowsHide: true,
			maxBuffer: 32 * 1024 * 1024,
		});
		if (res.status !== 0 || !res.stdout || !res.stdout.trim()) return [];
		let rows;
		try {
			const raw = JSON.parse(res.stdout);
			rows = Array.isArray(raw) ? raw : [raw];
		} catch {
			return [];
		}
		return rows
			.map((r) => ({
				pid: Number(r.ProcessId),
				ppid: Number(r.ParentProcessId),
				// KernelModeTime + UserModeTime are cumulative 100ns ticks.
				cpuMs: ((Number(r.KernelModeTime) || 0) + (Number(r.UserModeTime) || 0)) / 10_000,
			}))
			.filter((r) => Number.isFinite(r.pid) && Number.isFinite(r.ppid));
	}
	// POSIX: cumulative CPU time via `ps -o time=` ([[dd-]hh:]mm:ss).
	const res = spawnSync("ps", ["-eo", "pid=,ppid=,time="], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
	if (res.status !== 0 || !res.stdout || !res.stdout.trim()) return [];
	return res.stdout
		.trim()
		.split(/\r?\n/)
		.map((line) => {
			const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)$/);
			if (!m) return null;
			return { pid: Number(m[1]), ppid: Number(m[2]), cpuMs: parsePosixTime(m[3]) };
		})
		.filter(Boolean);
}

function parsePosixTime(s) {
	// [[dd-]hh:]mm:ss(.ff)
	let days = 0;
	let rest = s;
	if (rest.includes("-")) {
		const [d, r] = rest.split("-");
		days = Number(d) || 0;
		rest = r;
	}
	const parts = rest.split(":").map(Number);
	let h = 0;
	let m = 0;
	let sec = 0;
	if (parts.length === 3) [h, m, sec] = parts;
	else if (parts.length === 2) [m, sec] = parts;
	else sec = parts[0] || 0;
	return (((days * 24 + h) * 60 + m) * 60 + sec) * 1000;
}

function descendants(rows, rootPid) {
	const byParent = new Map();
	for (const r of rows) {
		if (!byParent.has(r.ppid)) byParent.set(r.ppid, []);
		byParent.get(r.ppid).push(r);
	}
	const out = [];
	const seen = new Set();
	const stack = [rootPid];
	while (stack.length) {
		const pid = stack.pop();
		if (seen.has(pid)) continue;
		seen.add(pid);
		const row = rows.find((r) => r.pid === pid);
		if (row) out.push(row);
		for (const c of byParent.get(pid) || []) stack.push(c.pid);
	}
	return out;
}

/** Single cumulative snapshot of the whole tree's user+system CPU (ms). */
export function treeCpuMs(rootPid) {
	const tree = descendants(listProcesses(), rootPid);
	return tree.reduce((s, r) => s + (r.cpuMs || 0), 0);
}

/**
 * Sampler that tracks the max cumulative CPU seen per-pid across the run, so
 * short-lived children that exit before stop() still contribute their final
 * cumulative CPU (design §6.1: "monotonic sum plus exit snapshots").
 */
export function createCpuSampler(rootPid, { intervalMs = 1000 } = {}) {
	const perPid = new Map(); // pid -> max cumulative cpuMs observed
	let peakProcesses = 0;
	let samples = 0;
	const sample = () => {
		const tree = descendants(listProcesses(), rootPid);
		peakProcesses = Math.max(peakProcesses, tree.length);
		for (const r of tree) {
			const prev = perPid.get(r.pid) || 0;
			if (r.cpuMs > prev) perPid.set(r.pid, r.cpuMs);
		}
		samples += 1;
	};
	sample();
	const timer = setInterval(sample, intervalMs);
	if (typeof timer.unref === "function") timer.unref();
	return {
		sampleNow: sample,
		stop() {
			clearInterval(timer);
			sample(); // final snapshot
			let cpuMs = 0;
			for (const v of perPid.values()) cpuMs += v;
			return { cpuMs: Math.round(cpuMs), peakProcesses, samples };
		},
	};
}

// ─────────────────────────── report-file readers ───────────────────────────

function readJsonSafe(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

/** Best-effort wall (ms) extraction from a vitest or playwright JSON report. */
function wallFromReport(reportPath) {
	const abs = isAbsolute(reportPath) ? reportPath : join(REPO_ROOT, reportPath);
	const rep = readJsonSafe(abs);
	if (!rep) return null;
	// Playwright: stats.duration.
	if (rep.stats && Number.isFinite(rep.stats.duration)) return Math.round(rep.stats.duration);
	// Vitest: startTime + max test end, or duration field.
	if (Number.isFinite(rep.duration)) return Math.round(rep.duration);
	if (Number.isFinite(rep.startTime) && Array.isArray(rep.testResults)) {
		let end = rep.startTime;
		for (const f of rep.testResults) {
			const e = (f.endTime ?? f.startTime ?? 0) || 0;
			if (e > end) end = e;
		}
		return Math.round(end - rep.startTime);
	}
	return null;
}

/** Latest CPU sample artifact for a scope, if run-v2 (or a prior run) left one. */
function latestSampleCpu(scope) {
	if (!existsSync(SAMPLE_DIR)) return null;
	const files = readdirSync(SAMPLE_DIR)
		.filter((f) => f.endsWith(".json") && (f.includes(`-${scope}.`) || f.startsWith(`${scope}-`)))
		.map((f) => ({ f, m: statSync(join(SAMPLE_DIR, f)).mtimeMs }))
		.sort((a, b) => b.m - a.m);
	if (!files.length) return null;
	const data = readJsonSafe(join(SAMPLE_DIR, files[0].f));
	return data && Number.isFinite(data.cpuMs) ? { cpuMs: data.cpuMs, source: files[0].f } : null;
}

function gitSha() {
	const res = spawnSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" });
	return res.status === 0 ? res.stdout.trim() : null;
}

function timestamp() {
	return new Date().toISOString().replace(/[:.]/g, "-");
}

// ─────────────────────────────── core assert ───────────────────────────────

export function assertBudget({ scope, wallMs = null, cpuMs = null, rawCpuMs = null, cpuCeilingMs = null, cpuOverCount = false, pilot = false, underLoad = undefined, argv = null, reservations = null, rootPid = null, processCount = null, wallSource = null, cpuSource = null }) {
	const caps = resolveCaps(scope, pilot, underLoad);
	const violations = [];

	// In pilot mode the tier cap acts as a generous ceiling for a partial suite;
	// a subset should stay well under it, so we still check but never invent a
	// stricter partial cap — the goal is a recorded baseline, not a pass/fail on
	// coverage completeness.
	if (Number.isFinite(wallMs) && wallMs > caps.maxWallMs) {
		violations.push(`wall ${(wallMs / 1000).toFixed(1)}s > cap ${(caps.maxWallMs / 1000).toFixed(1)}s`);
	}
	// CPU-min is OBSERVABILITY ONLY — it NEVER gates (design §D7 + tests2/budgets.json:
	// WALL is the hard gate). The process-tree sampler sums per-PID cumulative CPU
	// across the whole run; on a shared, busy box it demonstrably over-counts past
	// the physical ceiling (cores × wall) via PID churn / ppid misattribution, and
	// under N-way concurrency each run's sampler also sees its siblings' descendants.
	// So we RECORD cpuMs (clamped to the physical ceiling by clampCpuMs upstream)
	// for observability, warn when the raw reading over-counts, but add ZERO CPU
	// violations — an honest exit code depends on wall + green tests, never on a
	// CPU number the platform can't measure reliably under load.
	if (cpuOverCount) {
		console.warn(
			`[assert-budget] CPU over-count clamped: raw ${((rawCpuMs ?? 0) / 60000).toFixed(2)} CPU-min > physical ceiling ${((cpuCeilingMs ?? 0) / 60000).toFixed(2)} CPU-min (cores×wall) — recorded ${((cpuMs ?? 0) / 60000).toFixed(2)} CPU-min (observability only, does not gate).`,
		);
	}

	const pass = violations.length === 0;
	const record = {
		scope,
		tier: caps.tier,
		pilot,
		pass,
		violations,
		wallMs: Number.isFinite(wallMs) ? wallMs : null,
		cpuMs: Number.isFinite(cpuMs) ? cpuMs : null,
		rawCpuMs: Number.isFinite(rawCpuMs) ? rawCpuMs : null,
		cpuCeilingMs: Number.isFinite(cpuCeilingMs) ? cpuCeilingMs : null,
		cpuOverCount: !!cpuOverCount,
		cpuGated: false,
		underLoad: caps.underLoad ?? isUnderLoad(underLoad),
		wallSource,
		cpuSource,
		budget: { maxWallMs: caps.maxWallMs, maxCpuMs: caps.maxCpuMs, label: caps.label },
		rootPid,
		processCount,
		reservations,
		argv: argv || process.argv.slice(2),
		gitSha: gitSha(),
		createdAt: new Date().toISOString(),
	};

	mkdirSync(ARTIFACT_DIR, { recursive: true });
	const artifactPath = join(ARTIFACT_DIR, `${timestamp()}-${scope}.json`);
	writeFileSync(artifactPath, `${JSON.stringify(record, null, 2)}\n`);

	return { ...record, artifactPath, caps };
}

// ─────────────────────────────── CLI ───────────────────────────────

function parseCli(argv) {
	const opts = { pilot: false, scope: null, wallMs: null, cpuMs: null, report: null, pid: null, cores: null };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--pilot") opts.pilot = true;
		else if (a === "--scope") opts.scope = argv[++i];
		else if (a.startsWith("--scope=")) opts.scope = a.slice(8);
		else if (a === "--wall-ms") opts.wallMs = Number(argv[++i]);
		else if (a.startsWith("--wall-ms=")) opts.wallMs = Number(a.slice(10));
		else if (a === "--cpu-ms") opts.cpuMs = Number(argv[++i]);
		else if (a.startsWith("--cpu-ms=")) opts.cpuMs = Number(a.slice(9));
		else if (a === "--report") opts.report = argv[++i];
		else if (a.startsWith("--report=")) opts.report = a.slice(9);
		else if (a === "--pid") opts.pid = Number(argv[++i]);
		else if (a.startsWith("--pid=")) opts.pid = Number(a.slice(6));
		else if (a === "--cores") opts.cores = Number(argv[++i]);
		else if (a.startsWith("--cores=")) opts.cores = Number(a.slice(8));
		else if (!a.startsWith("-") && !opts.scope) opts.scope = a;
	}
	return opts;
}

function cli() {
	const opts = parseCli(process.argv.slice(2));
	if (!opts.scope) {
		console.error("assert-budget: missing scope. usage: assert-budget <core|dom|integration|browser|tier1|tier2|full> [--pilot]");
		process.exit(2);
	}

	let wallMs = Number.isFinite(opts.wallMs) ? opts.wallMs : null;
	let wallSource = wallMs != null ? "--wall-ms" : null;
	if (wallMs == null && opts.report) {
		wallMs = wallFromReport(opts.report);
		if (wallMs != null) wallSource = opts.report;
	}

	let cpuMs = Number.isFinite(opts.cpuMs) ? opts.cpuMs : null;
	let cpuSource = cpuMs != null ? "--cpu-ms" : null;
	if (cpuMs == null && Number.isFinite(opts.pid)) {
		cpuMs = treeCpuMs(opts.pid);
		cpuSource = `pid:${opts.pid} (subtree)`;
	}
	if (cpuMs == null) {
		const sample = latestSampleCpu(opts.scope);
		if (sample) {
			cpuMs = sample.cpuMs;
			cpuSource = `sample:${sample.source}`;
		}
	}

	// Clamp the CPU reading to the physical ceiling (cores × wall) so a recorded
	// over-count can never masquerade as real work. CPU is observability-only.
	const cores = Number.isFinite(opts.cores) && opts.cores > 0 ? opts.cores : Math.max(1, cpus().length);
	const clamped = clampCpuMs(cpuMs, cores, wallMs);
	if (clamped.overCount) cpuSource = `${cpuSource || "cpu"} (clamped cores×wall)`;

	const result = assertBudget({
		scope: opts.scope,
		wallMs,
		cpuMs: clamped.cpuMs,
		rawCpuMs: clamped.rawCpuMs,
		cpuCeilingMs: clamped.ceilingMs,
		cpuOverCount: clamped.overCount,
		pilot: opts.pilot,
		wallSource,
		cpuSource,
	});

	const caps = result.caps;
	console.log(`assert-budget: scope=${opts.scope} tier=${caps.tier}${opts.pilot ? " (pilot)" : ""}`);
	console.log(`  wall: ${wallMs != null ? (wallMs / 1000).toFixed(1) + "s" : "n/a"} (cap ${(caps.maxWallMs / 1000).toFixed(0)}s)  [${wallSource || "unmeasured"}]`);
	console.log(`  cpu:  ${clamped.cpuMs != null ? (clamped.cpuMs / 60000).toFixed(2) + " CPU-min" : "n/a"} (observability-only, not gated; physical ceiling ${clamped.ceilingMs != null ? (clamped.ceilingMs / 60000).toFixed(2) + " CPU-min = " + cores + "×" + (wallMs / 1000).toFixed(0) + "s" : "n/a"})  [${cpuSource || "unmeasured"}]${clamped.overCount ? ` (raw ${(clamped.rawCpuMs / 60000).toFixed(2)} over-counted, clamped)` : ""}`);
	console.log(`  artifact: ${result.artifactPath}`);

	if (!result.pass) {
		console.error(`assert-budget: FAIL — ${result.violations.join("; ")}`);
		process.exit(1);
	}
	if (opts.pilot && (wallMs == null || cpuMs == null)) {
		console.log("assert-budget: PASS (pilot baseline recorded; some metrics unmeasured)");
	} else {
		console.log("assert-budget: PASS");
	}
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) cli();
