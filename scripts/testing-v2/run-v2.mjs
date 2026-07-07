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
import { assertBudget, createCpuSampler } from "./assert-budget.mjs";

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

	// 3) Decide which tiers to run.
	const tierSpecs = [];
	if (scripts["test:v2:core"]) {
		tierSpecs.push(["test:v2:core", "tier1/vitest"]);
	} else {
		console.warn("[run-v2] SKIP tier-1: package.json has no `test:v2:core` script yet.");
	}
	const tier2Ready = scripts["test:v2:browser"] && hasPlaywrightConfig();
	if (tier2Ready) {
		tierSpecs.push(["test:v2:browser", "tier2/playwright"]);
	} else if (!scripts["test:v2:browser"]) {
		console.warn("[run-v2] SKIP tier-2: package.json has no `test:v2:browser` script yet.");
	} else {
		console.warn("[run-v2] SKIP tier-2: no playwright-v2 config found (migration in progress).");
	}
	if (tierSpecs.length === 0) {
		console.warn("[run-v2] nothing to run — neither tier script is available yet.");
	}

	// 4) Run the tiers.
	//
	// Under N-way concurrent load (BOBBIT_V2_CONCURRENCY_RUN=1, set by the
	// concurrency proof) run tier-1 and tier-2 SEQUENTIALLY: vitest's
	// gateway-booting integration tests and playwright's browser+gateway boots
	// otherwise STACK within each run, and across N runs that doubles the peak
	// concurrent gateway count — starving the heavy integration tests past their
	// 60 s timeout. Sequencing the tiers keeps peak gateway boots per run to one
	// tier at a time. An ISOLATED run (flag unset) keeps the tiers CONCURRENT so
	// the single-run wall stays under the 300 s D7 isolation cap.
	const sequentialTiers = process.env.BOBBIT_V2_CONCURRENCY_RUN && process.env.BOBBIT_V2_CONCURRENCY_RUN !== "0";
	let results;
	if (sequentialTiers) {
		console.log("[run-v2] under-load mode: running tiers SEQUENTIALLY (no tier-1/tier-2 gateway-boot overlap)");
		results = [];
		for (const [script, label] of tierSpecs) {
			results.push(await runScript(script, { ...reservation.childEnv }, label));
		}
	} else {
		results = await Promise.all(tierSpecs.map(([script, label]) => runScript(script, { ...reservation.childEnv }, label)));
	}
	const sample = sampler.stop();
	reservation.release();

	const wallMs = Math.round(performance.now() - startWall);

	// Persist a CPU sample artifact so a later `assert-budget full` can read it.
	mkdirSync(SAMPLE_DIR, { recursive: true });
	const samplePath = join(SAMPLE_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}-full.json`);
	writeFileSync(
		samplePath,
		`${JSON.stringify({ scope: "full", cpuMs: sample.cpuMs, peakProcesses: sample.peakProcesses, samples: sample.samples, wallMs, rootPid: process.pid, createdAt: new Date().toISOString() }, null, 2)}\n`,
	);

	for (const r of results) {
		const status = r.code === 0 ? "PASS" : "FAIL";
		console.log(`[run-v2] ${r.label} (${r.script}): ${status} in ${(r.wallMs / 1000).toFixed(1)}s${r.error ? ` — ${r.error}` : ""}`);
	}
	console.log(`[run-v2] total wall ${(wallMs / 1000).toFixed(1)}s, whole-tree CPU ${(sample.cpuMs / 60000).toFixed(2)} CPU-min (peak procs ${sample.peakProcesses})`);

	const anyFailed = results.some((r) => r.code !== 0);

	// 5) Enforce the FULL budget from the directly-measured whole-run CPU.
	let budgetFailed = false;
	if (results.length > 0) {
		const verdict = assertBudget({
			scope: "full",
			wallMs,
			cpuMs: sample.cpuMs,
			argv: process.argv.slice(2),
			rootPid: process.pid,
			processCount: sample.peakProcesses,
			reservations: ledgerSnapshot.reservations.map((r) => ({ kind: r.kind, workerSlots: r.workerSlots })),
			wallSource: "run-v2",
			cpuSource: "run-v2 sampler",
		});
		console.log(`[run-v2] budget artifact: ${verdict.artifactPath}`);
		if (!verdict.pass) {
			budgetFailed = true;
			console.error(`[run-v2] BUDGET FAIL — ${verdict.violations.join("; ")}`);
		} else {
			console.log("[run-v2] budget PASS (full ≤180s wall / ≤13 CPU-min)");
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
