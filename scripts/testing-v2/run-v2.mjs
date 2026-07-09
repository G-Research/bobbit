#!/usr/bin/env node
/**
 * run-v2.mjs — parent orchestrator for `npm run test:v2` (design §6, §6.1).
 *
 * Responsibilities:
 *   1. Reserve a parent-suite bundle from the atomic ledger and split it into
 *      vitest + playwright worker counts (invariant: sum(workerSlots) <= cores).
 *   2. Start a process-tree CPU sampler on this process (root of the whole run).
 *   3. Spawn tier-1 (vitest via `test:v2:core`) and tier-2 (playwright via
 *      `test:v2:browser`) children, passing the ledger-granted worker counts via
 *      env so their configs re-use the grant (no double reservation).
 *   4. Wait for all children, stop the sampler, write a CPU sample artifact, then
 *      enforce the FULL budget via assert-budget (--scope full).
 *
 * Tier-2 is guarded: if no playwright-v2 config exists yet, tier-2 is skipped
 * with a notice so run-v2 is usable during migration and complete later.
 *
 * Exit code is non-zero if any child fails or the full budget is exceeded.
 */
import { spawn } from "node:child_process";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { reserveParentBundle, readLedger } from "./ledger.mjs";
import { assertBudget, createCpuSampler, clampCpuMs } from "./assert-budget.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const SAMPLE_DIR = join(REPO_ROOT, ".profiles", "testing-v2", "samples");

function pkgScripts() {
	try {
		return JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).scripts || {};
	} catch {
		return {};
	}
}

function hasPlaywrightConfig() {
	return ["playwright-v2.config.ts", "playwright-v2.config.mjs", "playwright-v2.config.js"].some((f) => existsSync(join(REPO_ROOT, f)));
}

function npmCmd() {
	return process.platform === "win32" ? "npm.cmd" : "npm";
}

function runScript(script, env, label) {
	const startWall = performance.now();
	return new Promise((resolveRun) => {
		const child = spawn(npmCmd(), ["run", script], {
			cwd: REPO_ROOT,
			env: { ...process.env, ...env },
			stdio: "inherit",
			shell: process.platform === "win32",
		});
		child.on("close", (code, signal) => {
			resolveRun({ label, script, code: code ?? (signal ? 1 : 0), signal, wallMs: Math.round(performance.now() - startWall) });
		});
		child.on("error", (error) => {
			resolveRun({ label, script, code: 1, error: String(error), wallMs: Math.round(performance.now() - startWall) });
		});
	});
}

async function main() {
	const scripts = pkgScripts();
	const startWall = performance.now();

	// 1) Reserve a parent bundle (coalescing window lets peers appear first).
	const reservation = reserveParentBundle();
	console.log(`[run-v2] ledger grant: vitest=${reservation.vitest} playwright=${reservation.playwright} (total=${reservation.total}) parent=${reservation.parentRunId}`);
	const ledgerSnapshot = readLedger();
	const reservedTotal = ledgerSnapshot.reservations.reduce((s, r) => s + r.workerSlots, 0);
	console.log(`[run-v2] ledger reserved ${reservedTotal}/${ledgerSnapshot.totalCores} cores across ${ledgerSnapshot.reservations.length} reservation(s)`);

	// 2) Start the whole-run CPU sampler.
	const sampler = createCpuSampler(process.pid, { intervalMs: 1000 });

	// 3) Spawn tier children with ledger-granted worker counts.
	const runs = [];

	if (scripts["test:v2:core"]) {
		runs.push(runScript("test:v2:core", { ...reservation.childEnv }, "tier1/vitest"));
	} else {
		console.warn("[run-v2] SKIP tier-1: package.json has no `test:v2:core` script yet.");
	}

	const tier2Ready = scripts["test:v2:browser"] && hasPlaywrightConfig();
	if (tier2Ready) {
		runs.push(runScript("test:v2:browser", { ...reservation.childEnv }, "tier2/playwright"));
	} else if (!scripts["test:v2:browser"]) {
		console.warn("[run-v2] SKIP tier-2: package.json has no `test:v2:browser` script yet.");
	} else {
		console.warn("[run-v2] SKIP tier-2: no playwright-v2 config found (migration in progress).");
	}

	if (runs.length === 0) {
		console.warn("[run-v2] nothing to run — neither tier script is available yet.");
	}

	// 4) Wait for all children.
	const results = await Promise.all(runs);
	const sample = sampler.stop();
	reservation.release();

	const wallMs = Math.round(performance.now() - startWall);

	// Load-awareness (design §D7): a run competing with peers legitimately takes
	// longer, so the WALL gate switches from the 300 s isolated cap to the 600 s
	// under-load cap. Detect peers from the ledger snapshot — any reservation owned
	// by a DIFFERENT parent run means we are not alone on the box. (The
	// concurrency-proof harness also forces this via BOBBIT_V2_CONCURRENCY_RUN,
	// honoured downstream by isUnderLoad.)
	const peerReservations = ledgerSnapshot.reservations.filter((r) => r.parentRunId !== reservation.parentRunId);
	const envConcurrency = !!(process.env.BOBBIT_V2_CONCURRENCY_RUN && process.env.BOBBIT_V2_CONCURRENCY_RUN !== "0");
	const underLoad = envConcurrency || peerReservations.length > 0;

	// Clamp the whole-run CPU sample to the physical ceiling (cores × wall). The
	// sampler scopes to THIS run's own process subtree (rootPid = process.pid), but
	// PID churn / ppid misattribution on a busy Windows box still over-counts past
	// what the hardware can deliver. CPU is observability-only and never gates; we
	// only keep the recorded number physically honest.
	const cores = ledgerSnapshot.totalCores || 1;
	const clampedCpu = clampCpuMs(sample.cpuMs, cores, wallMs);
	if (clampedCpu.overCount) {
		console.warn(
			`[run-v2] CPU over-count: sampler read ${(clampedCpu.rawCpuMs / 60000).toFixed(2)} CPU-min > physical ceiling ${(clampedCpu.ceilingMs / 60000).toFixed(2)} CPU-min (${cores} cores × ${(wallMs / 1000).toFixed(0)}s) — clamping to ceiling (observability only; CPU never gates).`,
		);
	}

	// Persist a CPU sample artifact so a later `assert-budget full` can read it.
	mkdirSync(SAMPLE_DIR, { recursive: true });
	const samplePath = join(SAMPLE_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}-full.json`);
	writeFileSync(
		samplePath,
		`${JSON.stringify({ scope: "full", cpuMs: clampedCpu.cpuMs, rawCpuMs: clampedCpu.rawCpuMs, cpuCeilingMs: clampedCpu.ceilingMs, cpuOverCount: clampedCpu.overCount, peakProcesses: sample.peakProcesses, samples: sample.samples, wallMs, underLoad, rootPid: process.pid, createdAt: new Date().toISOString() }, null, 2)}\n`,
	);

	for (const r of results) {
		const status = r.code === 0 ? "PASS" : "FAIL";
		console.log(`[run-v2] ${r.label} (${r.script}): ${status} in ${(r.wallMs / 1000).toFixed(1)}s${r.error ? ` — ${r.error}` : ""}`);
	}
	console.log(`[run-v2] total wall ${(wallMs / 1000).toFixed(1)}s${underLoad ? " (under peer load)" : " (isolated)"}, whole-tree CPU ${(clampedCpu.cpuMs / 60000).toFixed(2)} CPU-min${clampedCpu.overCount ? ` (raw ${(clampedCpu.rawCpuMs / 60000).toFixed(2)} clamped to cores\u00d7wall)` : ""} [observability only] (peak procs ${sample.peakProcesses})`);

	const anyFailed = results.some((r) => r.code !== 0);

	// 5) Enforce the FULL budget from the directly-measured whole-run CPU.
	let budgetFailed = false;
	if (results.length > 0) {
		const verdict = assertBudget({
			scope: "full",
			wallMs,
			cpuMs: clampedCpu.cpuMs,
			rawCpuMs: clampedCpu.rawCpuMs,
			cpuCeilingMs: clampedCpu.ceilingMs,
			cpuOverCount: clampedCpu.overCount,
			underLoad,
			argv: process.argv.slice(2),
			rootPid: process.pid,
			processCount: sample.peakProcesses,
			reservations: ledgerSnapshot.reservations.map((r) => ({ kind: r.kind, workerSlots: r.workerSlots })),
			wallSource: "run-v2",
			cpuSource: "run-v2 sampler (subtree)",
		});
		console.log(`[run-v2] budget artifact: ${verdict.artifactPath}`);
		if (!verdict.pass) {
			budgetFailed = true;
			console.error(`[run-v2] BUDGET FAIL — ${verdict.violations.join("; ")}`);
		} else {
			console.log(`[run-v2] budget PASS (WALL-only gate: ${(wallMs / 1000).toFixed(1)}s ≤ ${(verdict.caps.maxWallMs / 1000).toFixed(0)}s ${underLoad ? "under-load" : "isolated"} cap; CPU observability-only)`);
		}
	} else {
		console.log(`[run-v2] budget check skipped (no tiers ran). CPU sample: ${samplePath}`);
	}

	process.exit(anyFailed || budgetFailed ? 1 : 0);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
	main().catch((e) => {
		console.error("[run-v2] fatal:", e);
		process.exit(1);
	});
}
