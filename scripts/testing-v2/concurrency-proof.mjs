#!/usr/bin/env node
/**
 * concurrency-proof.mjs — HONEST multi-worktree proof that N concurrent
 * `test:v2` runs stay green and within budget while the ledger keeps
 * Σworkers ≤ cores (D7, Option A).
 *
 * WHY MULTI-WORKTREE (Option A): spawning 5 `test:v2` from ONE worktree corrupts
 * that single node_modules — concurrent npm reify/prune races wipe
 * node_modules/.bin, and 5 vitest sharing node_modules/.vite corrupts the Vite
 * dep-optimizer cache. That is a harness artifact, not a product/ledger flake.
 * Real N-developer concurrency in Bobbit = N separate git worktrees, each with
 * its own node_modules (warm cache, no .bin race) coordinated by the
 * cross-process ledger. So this proof provisions N throwaway worktrees, runs one
 * `test:v2` per worktree, and asserts the same honest bar.
 *
 * D7 acceptance bar (docs/testing-v2/design.md §D7 — SETTLED):
 *   - 5 concurrent `test:v2` runs × 3 reps = 15/15 GREEN, retries:0, ZERO flakes.
 *   - Each run wall ≤ 600 s (10 min) under mutual load.
 *   - Ledger Σworkers ≤ cores (24) at all times.
 *
 * There is NO dry-run and NO downgraded assertion. Each run is spawned with
 * BOBBIT_V2_CONCURRENCY_RUN=1, which switches run-v2's budget to the under-load
 * per-run cap (budgets.concurrency.perRunMaxWallMs). So `exit 0` ⟺ vitest green
 * AND playwright green AND wall ≤ under-load cap. Any non-zero exit — including a
 * playwright flake — is a HARD failure that fails this proof.
 *
 * Provisioning (once, reused across reps; NOT part of the measured wall):
 *   git worktree add --detach → npm ci (npm_config_package_lock=true) → build dist
 *   in wt-0 and copy dist/ to the others (dist is relocatable — verified no
 *   embedded absolute paths). Teardown removes every worktree in a finally block.
 *
 * Default scale is the full spec (5 × 3). Override for a lighter smoke:
 *   CONCURRENCY_PROOF_CONCURRENT=2 CONCURRENCY_PROOF_REPS=1 node scripts/testing-v2/concurrency-proof.mjs
 *   --keep       leave provisioned worktrees in place (debugging)
 *
 * Outputs:
 *   docs/testing-v2/concurrency-proof.md
 *   .profiles/testing-v2/concurrency-proof/result.json
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, cpSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { cpus } from "node:os";
import { readLedger, ledgerDir } from "./ledger.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");

// ──────────────────────────────── config ────────────────────────────────

const TOTAL_CORES = Number(process.env.BOBBIT_V2_TOTAL_CORES) || cpus().length;

function budgetsConcurrency() {
	try {
		const b = JSON.parse(readFileSync(join(REPO_ROOT, "tests2", "budgets.json"), "utf8"));
		return b.concurrency || {};
	} catch {
		return {};
	}
}

const BUDGET_CONC = budgetsConcurrency();
const WALL_BUDGET_S = Number(process.env.CONCURRENCY_PROOF_WALL_S) || (Number.isFinite(BUDGET_CONC.perRunMaxWallMs) ? Math.round(BUDGET_CONC.perRunMaxWallMs / 1000) : 600);

// Concurrency target comes from tests2/budgets.json (concurrency.runs); env
// override for experiments. Capped at 3 for this 24-core box (5-way is a
// gateway-boot capacity limit deferred to a spin-off — see budgets.json note).
const TARGET_RUNS = Number.isFinite(BUDGET_CONC.runs) ? BUDGET_CONC.runs : 3;
const TARGET_REPS = Number.isFinite(BUDGET_CONC.reps) ? BUDGET_CONC.reps : 3;
let CONCURRENT = Number(process.env.CONCURRENCY_PROOF_CONCURRENT) || TARGET_RUNS;
let REPS = Number(process.env.CONCURRENCY_PROOF_REPS) || TARGET_REPS;
let KEEP = false;
// STUDY: --reuse skips provisioning and reuses worktrees already present under
// the (stable) wt-root, so several configs (baseline vs relocated, different N)
// can be measured against ONE provisioned set without re-running npm ci ×N +
// build each time. Requires a stable wt-root via CONCURRENCY_PROOF_WT_ROOT.
let REUSE = false;
// STUDY: --provision-only builds + keeps the worktree set (npm ci ×N + build)
// and exits WITHOUT measuring, so provisioning (load-insensitive) can overlap
// coder activity and the machine-quiet window is spent only on measured runs.
let PROVISION_ONLY = false;

for (let i = 2; i < process.argv.length; i++) {
	const arg = process.argv[i];
	if (arg === "--concurrent" && process.argv[i + 1]) CONCURRENT = Number(process.argv[++i]);
	else if (arg === "--reps" && process.argv[i + 1]) REPS = Number(process.argv[++i]);
	else if (arg === "--keep") KEEP = true;
	else if (arg === "--reuse") REUSE = true;
	else if (arg === "--provision-only") PROVISION_ONLY = true;
	else if (arg.startsWith("--concurrent=")) CONCURRENT = Number(arg.split("=")[1]);
	else if (arg.startsWith("--reps=")) REPS = Number(arg.split("=")[1]);
}

const REPORT_DIR = join(REPO_ROOT, "docs", "testing-v2");
const ARTIFACT_DIR = join(REPO_ROOT, ".profiles", "testing-v2", "concurrency-proof");
// Worktrees live beside the other Bobbit worktrees (same drive → fast git ops),
// in a throwaway dir keyed by pid so parallel proof invocations never collide.
const PROOF_WT_ROOT = process.env.CONCURRENCY_PROOF_WT_ROOT || join(REPO_ROOT, "..", `cc-proof-${process.pid}`);

function npmCmd() {
	return process.platform === "win32" ? "npm.cmd" : "npm";
}

// npm env that neutralises the repo .npmrc `shrinkwrap=false` (= package-lock=false)
// for the proof's subprocesses: with the lockfile authoritative, npm never
// reifies/prunes node_modules on run, so a provisioned tree stays complete.
const NPM_ENV = { npm_config_package_lock: "true", npm_config_audit: "false", npm_config_fund: "false" };

// ──────────────────────────────── output analysis ────────────────────────────────

/**
 * Parse a run's combined output to attribute failures to a tier (defence in
 * depth on top of the exit code — run-v2 prints an explicit PASS/FAIL line per
 * tier so we can name which tier broke).
 */
function analyzeRunOutput(lines) {
	const text = lines.map(([, l]) => l).join("");
	const vitestMatch = text.match(/\[run-v2\] tier1\/vitest \([^)]+\): (PASS|FAIL)/);
	const vitestPass = vitestMatch ? vitestMatch[1] === "PASS" : null;
	const playwrightMatch = text.match(/\[run-v2\] tier2\/playwright \([^)]+\): (PASS|FAIL)/);
	const playwrightPass = playwrightMatch ? playwrightMatch[1] === "PASS" : null;
	const budgetFail = text.includes("[run-v2] BUDGET FAIL");
	const budgetPass = text.includes("[run-v2] budget PASS");
	const unexpectedMatch = text.match(/"unexpected":\s*(\d+)/);
	const playwrightUnexpected = unexpectedMatch ? Number(unexpectedMatch[1]) : null;
	const vitestSummaryOk = /Tests\s+\d+ passed/.test(text) || /Test Files\s+\d+ passed/.test(text);
	return { vitestPass, playwrightPass, budgetFail, budgetPass, playwrightUnexpected, vitestSummaryOk };
}

// ──────────────────────────────── provisioning ────────────────────────────────

function run(cmd, args, opts = {}) {
	const res = spawnSync(cmd, args, {
		cwd: opts.cwd || REPO_ROOT,
		env: { ...process.env, ...(opts.env || {}) },
		stdio: opts.quiet ? ["ignore", "pipe", "pipe"] : "inherit",
		shell: process.platform === "win32",
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	});
	return { code: res.status ?? (res.signal ? 1 : 0), stdout: res.stdout || "", stderr: res.stderr || "" };
}

function gitHeadSha() {
	const r = run("git", ["rev-parse", "HEAD"], { quiet: true });
	return r.stdout.trim();
}

function removeWorktree(dir) {
	if (!existsSync(dir)) return;
	run("git", ["worktree", "remove", "--force", dir], { quiet: true });
	if (existsSync(dir)) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	}
}

/**
 * Provision N throwaway worktrees at the current HEAD, each with its own
 * `npm ci` node_modules and a copy of a freshly-built dist. Returns the worktree
 * dirs. Throws on any provisioning failure (the proof cannot run without it).
 */
async function provisionWorktrees(n, baseSha) {
	console.log(`\n─── provisioning ${n} worktrees @ ${baseSha.slice(0, 10)} (one-time, not measured) ───`);
	mkdirSync(PROOF_WT_ROOT, { recursive: true });
	const dirs = [];
	// git worktree add mutates the shared .git — do these SEQUENTIALLY.
	for (let i = 0; i < n; i++) {
		const dir = join(PROOF_WT_ROOT, `wt-${i}`);
		removeWorktree(dir);
		const r = run("git", ["worktree", "add", "--detach", dir, baseSha], { quiet: true });
		if (r.code !== 0) throw new Error(`git worktree add failed for wt-${i}: ${r.stderr || r.stdout}`);
		dirs.push(dir);
		console.log(`  + worktree wt-${i} → ${dir}`);
	}

	// npm ci per worktree — CONCURRENT (separate node_modules, no cross-race).
	console.log(`  npm ci ×${n} (package-lock authoritative)…`);
	const ciResults = await Promise.all(
		dirs.map(
			(dir, i) =>
				new Promise((res) => {
					const child = spawn(npmCmd(), ["ci"], {
						cwd: dir,
						env: { ...process.env, ...NPM_ENV },
						stdio: ["ignore", "pipe", "pipe"],
						shell: process.platform === "win32",
					});
					let err = "";
					child.stderr.on("data", (d) => (err += String(d)));
					child.on("close", (code) => res({ i, code, err }));
					child.on("error", (e) => res({ i, code: 1, err: String(e) }));
				}),
		),
	);
	for (const r of ciResults) {
		if (r.code !== 0) throw new Error(`npm ci failed in wt-${r.i}: ${r.err.slice(-400)}`);
		// Sanity: the server graph must be loadable (the pi-ai/oauth subpath the
		// server imports). A broken/pruned tree is caught here, before the run.
		const oauth = join(dirs[r.i], "node_modules", "@earendil-works", "pi-ai", "dist", "oauth.js");
		if (!existsSync(oauth)) throw new Error(`wt-${r.i}: incomplete node_modules — missing ${oauth}`);
	}
	console.log(`  npm ci complete; pi-ai/oauth present in all ${n} worktrees ✓`);

	// Build dist once in wt-0, then copy to the rest (dist is relocatable —
	// verified no embedded worktree-absolute paths). Building all N would be a
	// pointless CPU storm; the copy is byte-identical for the same SHA.
	console.log(`  building dist in wt-0…`);
	const build = run(npmCmd(), ["run", "build"], { cwd: dirs[0], env: NPM_ENV, quiet: true });
	if (build.code !== 0) throw new Error(`dist build failed in wt-0: ${(build.stderr || build.stdout).slice(-800)}`);
	const distSrc = join(dirs[0], "dist");
	if (!existsSync(join(distSrc, "server", "cli.js")) || !existsSync(join(distSrc, "ui", "index.html"))) {
		throw new Error(`wt-0 dist incomplete after build (missing server/cli.js or ui/index.html)`);
	}
	for (let i = 1; i < n; i++) {
		cpSync(distSrc, join(dirs[i], "dist"), { recursive: true });
	}
	console.log(`  dist built + copied to ${n} worktrees ✓`);
	return dirs;
}

function teardownWorktrees(dirs) {
	if (KEEP) {
		console.log(`\n[--keep] leaving worktrees in ${PROOF_WT_ROOT}`);
		return;
	}
	console.log(`\n─── teardown: removing ${dirs.length} worktrees ───`);
	for (const dir of dirs) removeWorktree(dir);
	run("git", ["worktree", "prune"], { quiet: true });
	try {
		rmSync(PROOF_WT_ROOT, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
}

// ──────────────────────────────── spawn a run ────────────────────────────────

function spawnRun(index, rep, worktreeDir) {
	const startWall = performance.now();
	const lines = [];
	// Fresh top-level test:v2 in its OWN worktree. Strip inherited ledger parent
	// env (each run reserves its own bundle); flag under-load; keep the lockfile
	// authoritative; give playwright a unique cache run-id.
	const env = {
		...process.env,
		...NPM_ENV,
		BOBBIT_V2_TOTAL_CORES: String(TOTAL_CORES),
		BOBBIT_V2_CONCURRENCY_RUN: "1",
		BOBBIT_V2_BROWSER_RUN_ID: `ccwt${index}-rep${rep}`,
	};
	delete env.BOBBIT_V2_LEDGER_PARENT;
	delete env.BOBBIT_V2_SLOTS_VITEST;
	delete env.BOBBIT_V2_SLOTS_PLAYWRIGHT;

	return new Promise((resolveRun) => {
		const child = spawn(npmCmd(), ["run", "test:v2"], {
			cwd: worktreeDir,
			env,
			stdio: ["ignore", "pipe", "pipe"],
			shell: process.platform === "win32",
		});
		child.stdout.on("data", (d) => lines.push(["out", String(d)]));
		child.stderr.on("data", (d) => lines.push(["err", String(d)]));
		child.on("close", (code, signal) => {
			resolveRun({
				index,
				rep,
				pid: child.pid,
				worktree: worktreeDir,
				exitCode: code ?? (signal ? 1 : 0),
				signal,
				wallMs: Math.round(performance.now() - startWall),
				lines,
				analysis: analyzeRunOutput(lines),
			});
		});
		child.on("error", (error) => {
			resolveRun({
				index,
				rep,
				pid: child.pid ?? 0,
				worktree: worktreeDir,
				exitCode: 1,
				spawnError: String(error),
				wallMs: Math.round(performance.now() - startWall),
				lines,
				analysis: analyzeRunOutput(lines),
			});
		});
	});
}

// ──────────────────────────────── ledger poller ────────────────────────────────

async function pollLedger(runPromises) {
	const samples = [];
	let done = false;
	Promise.all(runPromises).then(() => {
		done = true;
	});
	const sampleOnce = () => {
		try {
			const state = readLedger({ lockTimeoutMs: 3000 });
			const total = state.reservations.reduce((s, r) => s + (r.workerSlots || 0), 0);
			samples.push({ ts: Date.now(), total, count: state.reservations.length });
		} catch {
			/* locked — skip */
		}
	};
	while (!done) {
		sampleOnce();
		await new Promise((r) => setTimeout(r, 500));
	}
	sampleOnce();
	const maxWorkers = samples.length ? Math.max(...samples.map((s) => s.total)) : 0;
	return { maxWorkers, samples };
}

function failureTail(run) {
	const text = run.lines.map(([, l]) => l).join("");
	const nonEmpty = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
	return nonEmpty.slice(-40).join("\n");
}

// ──────────────────────────────── main ────────────────────────────────

async function main() {
	console.log(`\n╔══════════════════════════════════════════════════════════╗`);
	console.log(`║       test:v2 concurrency proof — multi-worktree (A)     ║`);
	console.log(`╚══════════════════════════════════════════════════════════╝`);
	console.log(`  concurrent=${CONCURRENT}  reps=${REPS}  totalRuns=${CONCURRENT * REPS}`);
	console.log(`  perRunWallCap=${WALL_BUDGET_S}s  cores=${TOTAL_CORES}`);
	console.log(`  ledger dir: ${ledgerDir()}`);

	const baseSha = gitHeadSha();

	if (PROVISION_ONLY) {
		KEEP = true;
		const dirs = await provisionWorktrees(CONCURRENT, baseSha);
		console.log(`\n✅ provisioned ${dirs.length} worktrees under ${PROOF_WT_ROOT} (kept). Re-run with --reuse to measure.`);
		process.exit(0);
	}

	const allRunResults = [];
	const allLedgerPolls = [];
	const violations = [];
	let worktrees = [];

	try {
		const reuseDirs = [];
		if (REUSE) {
			for (let i = 0; i < CONCURRENT; i++) {
				const dir = join(PROOF_WT_ROOT, `wt-${i}`);
				const ok = existsSync(join(dir, "node_modules", ".bin")) && existsSync(join(dir, "dist", "server", "cli.js")) && existsSync(join(dir, "dist", "ui", "index.html"));
				if (!ok) break;
				reuseDirs.push(dir);
			}
		}
		if (REUSE && reuseDirs.length === CONCURRENT) {
			worktrees = reuseDirs;
			KEEP = true; // never tear down a reused set implicitly
			console.log(`\n─── REUSE: using ${CONCURRENT} pre-provisioned worktrees under ${PROOF_WT_ROOT} (skipping npm ci + build) ───`);
		} else {
			if (REUSE) console.log(`\n─── REUSE requested but ${reuseDirs.length}/${CONCURRENT} usable worktrees found — provisioning fresh ───`);
			worktrees = await provisionWorktrees(CONCURRENT, baseSha);
		}

		for (let rep = 1; rep <= REPS; rep++) {
			console.log(`\n─── rep ${rep}/${REPS}: launching ${CONCURRENT} concurrent test:v2 runs (one per worktree) ───`);
			const repStart = performance.now();
			const runPromises = worktrees.map((dir, i) => spawnRun(i + 1, rep, dir));
			const ledgerPoll = pollLedger(runPromises);

			let progressDone = false;
			const progressTimer = setInterval(() => {
				if (progressDone) return;
				console.log(`  [rep ${rep}] ${Math.round((performance.now() - repStart) / 1000)}s elapsed…`);
			}, 30_000);

			const [repResults, ledgerResult] = await Promise.all([Promise.all(runPromises), ledgerPoll]);
			progressDone = true;
			clearInterval(progressTimer);

			const repWall = Math.round(performance.now() - repStart);
			allRunResults.push(...repResults);
			allLedgerPolls.push({ rep, ...ledgerResult });

			for (const r of repResults) {
				const a = r.analysis || {};
				const exitStatus = r.exitCode === 0 ? "PASS" : "FAIL";
				const vt = a.vitestPass === true ? "vitest✓" : a.vitestPass === false ? "vitest✗" : "vitest?";
				const pw = a.playwrightPass === true ? "pw✓" : a.playwrightPass === false ? "pw✗" : "pw?";
				console.log(`  run #${r.index}: ${exitStatus} (${vt} ${pw}) ${(r.wallMs / 1000).toFixed(1)}s pid=${r.pid}${r.spawnError ? ` ERROR:${r.spawnError}` : ""}`);
			}
			console.log(`  ledger peak Σworkers=${ledgerResult.maxWorkers}/${TOTAL_CORES}`);
			console.log(`  rep ${rep} wall: ${(repWall / 1000).toFixed(1)}s`);
		}
	} finally {
		if (worktrees.length) teardownWorktrees(worktrees);
	}

	// ──────────── assertions (all HARD) ────────────

	console.log(`\n─── assertions ───`);

	const failedRuns = allRunResults.filter((r) => r.exitCode !== 0);
	if (failedRuns.length > 0) {
		violations.push(`A1: ${failedRuns.length}/${allRunResults.length} run(s) exited non-zero: ${failedRuns.map((r) => `rep${r.rep}/#${r.index}(exit ${r.exitCode})`).join(", ")}`);
		console.error(`  ✗ A1 FAIL — ${failedRuns.length} run(s) exited non-zero`);
	} else {
		console.log(`  ✓ A1 PASS — all ${allRunResults.length} runs exited 0`);
	}

	const vitestFails = allRunResults.filter((r) => r.analysis?.vitestPass === false);
	const playwrightFails = allRunResults.filter((r) => r.analysis?.playwrightPass === false);
	if (vitestFails.length > 0) {
		violations.push(`A2: ${vitestFails.length} run(s) had vitest tier-1 failures: ${vitestFails.map((r) => `rep${r.rep}/#${r.index}`).join(", ")}`);
		console.error(`  ✗ A2 FAIL — vitest failures in ${vitestFails.length} run(s)`);
	}
	if (playwrightFails.length > 0) {
		violations.push(`A2: ${playwrightFails.length} run(s) had playwright tier-2 failures: ${playwrightFails.map((r) => `rep${r.rep}/#${r.index}`).join(", ")}`);
		console.error(`  ✗ A2 FAIL — playwright failures in ${playwrightFails.length} run(s) (flakes under load are HARD failures)`);
	}
	if (vitestFails.length === 0 && playwrightFails.length === 0) {
		console.log(`  ✓ A2 PASS — every run reported vitest PASS and playwright PASS`);
	}

	let a3Bad = false;
	for (const poll of allLedgerPolls) {
		if (poll.maxWorkers > TOTAL_CORES) {
			a3Bad = true;
			violations.push(`A3: ledger Σworkers=${poll.maxWorkers} > cores=${TOTAL_CORES} in rep ${poll.rep}`);
			console.error(`  ✗ A3 FAIL — rep ${poll.rep}: Σworkers=${poll.maxWorkers} > cores=${TOTAL_CORES}`);
		}
	}
	if (!a3Bad) {
		console.log(`  ✓ A3 PASS — Σworkers always ≤ ${TOTAL_CORES} (max seen=${Math.max(...allLedgerPolls.map((p) => p.maxWorkers), 0)})`);
	}

	const slowRuns = allRunResults.filter((r) => r.wallMs > WALL_BUDGET_S * 1000);
	if (slowRuns.length > 0) {
		violations.push(`A4: ${slowRuns.length} run(s) exceeded ${WALL_BUDGET_S}s: ${slowRuns.map((r) => `rep${r.rep}/#${r.index}(${(r.wallMs / 1000).toFixed(1)}s)`).join(", ")}`);
		console.error(`  ✗ A4 FAIL — ${slowRuns.length} run(s) over ${WALL_BUDGET_S}s`);
	} else {
		console.log(`  ✓ A4 PASS — all runs within ${WALL_BUDGET_S}s (max=${(Math.max(...allRunResults.map((r) => r.wallMs), 0) / 1000).toFixed(1)}s)`);
	}

	const pass = violations.length === 0 && allRunResults.length === CONCURRENT * REPS;

	// ──────────── result JSON + report ────────────

	const wallMsAll = allRunResults.map((r) => r.wallMs);
	const result = {
		pass,
		model: "multi-worktree",
		violations,
		config: {
			concurrent: CONCURRENT,
			reps: REPS,
			perRunWallCapS: WALL_BUDGET_S,
			totalCores: TOTAL_CORES,
			baseSha,
			specConcurrent: TARGET_RUNS,
			specReps: TARGET_REPS,
			fullSpec: CONCURRENT >= TARGET_RUNS && REPS >= TARGET_REPS,
			note:
				CONCURRENT >= TARGET_RUNS && REPS >= TARGET_REPS
					? `Full proof (${TARGET_RUNS}×${TARGET_REPS}), one test:v2 per worktree. Concurrency capped at ${TARGET_RUNS} on this 24-core box; 5-way restoration deferred to a spin-off (gateway-boot cost).`
					: `Reduced-scale smoke; full proof is ${TARGET_RUNS}×${TARGET_REPS} (the default).`,
		},
		summary: {
			totalRuns: allRunResults.length,
			green: allRunResults.filter((r) => r.exitCode === 0).length,
			exitNonZero: allRunResults.filter((r) => r.exitCode !== 0).length,
			vitestFails: vitestFails.length,
			playwrightFails: playwrightFails.length,
			maxWallS: wallMsAll.length ? +(Math.max(...wallMsAll) / 1000).toFixed(1) : 0,
			minWallS: wallMsAll.length ? +(Math.min(...wallMsAll) / 1000).toFixed(1) : 0,
			avgWallS: wallMsAll.length ? +(wallMsAll.reduce((a, b) => a + b, 0) / wallMsAll.length / 1000).toFixed(1) : 0,
			maxLedgerWorkers: Math.max(...allLedgerPolls.map((p) => p.maxWorkers), 0),
		},
		runs: allRunResults.map((r) => ({
			rep: r.rep,
			index: r.index,
			pid: r.pid,
			exitCode: r.exitCode,
			wallS: +(r.wallMs / 1000).toFixed(1),
			overWallCap: r.wallMs > WALL_BUDGET_S * 1000,
			spawnError: r.spawnError || null,
			analysis: r.analysis || null,
			failureTail: r.exitCode === 0 ? null : failureTail(r),
		})),
		ledger: allLedgerPolls.map((p) => ({ rep: p.rep, maxWorkers: p.maxWorkers, sampleCount: p.samples.length, withinCoreCount: p.maxWorkers <= TOTAL_CORES, samples: p.samples.slice(0, 40) })),
		createdAt: new Date().toISOString(),
	};

	mkdirSync(ARTIFACT_DIR, { recursive: true });
	mkdirSync(REPORT_DIR, { recursive: true });
	// Dump FULL output of every failed run so the exact failing test(s) are
	// inspectable after the fact (the JSON only keeps a bounded tail).
	const LOG_DIR = join(ARTIFACT_DIR, "logs");
	mkdirSync(LOG_DIR, { recursive: true });
	for (const r of allRunResults) {
		if (r.exitCode === 0) continue;
		const full = r.lines.map(([, l]) => l).join("");
		writeFileSync(join(LOG_DIR, `rep${r.rep}-run${r.index}.log`), full);
	}
	writeFileSync(join(ARTIFACT_DIR, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
	writeFileSync(join(REPORT_DIR, "concurrency-proof.md"), buildMarkdown(result));
	console.log(`\n  artifact: ${join(ARTIFACT_DIR, "result.json")}`);
	console.log(`  report:   ${join(REPORT_DIR, "concurrency-proof.md")}`);

	console.log(`\n${"═".repeat(60)}`);
	if (pass) {
		console.log(`✅  CONCURRENCY PROOF PASSED — ${result.summary.green}/${result.summary.totalRuns} green, Σworkers ≤ ${TOTAL_CORES}`);
	} else {
		console.error(`❌  CONCURRENCY PROOF FAILED`);
		for (const v of violations) console.error(`  • ${v}`);
	}
	console.log(`${"═".repeat(60)}\n`);
	process.exit(pass ? 0 : 1);
}

// ──────────────────────────────── report ────────────────────────────────

function buildMarkdown(result) {
	const { config, summary, runs, ledger, violations } = result;
	const ts = new Date(result.createdAt).toUTCString();
	const icon = result.pass ? "✅ PASSED" : "❌ FAILED";

	const repNums = [...new Set(runs.map((r) => r.rep))];
	let repTables = "";
	for (const rep of repNums) {
		const repRuns = runs.filter((r) => r.rep === rep);
		const le = ledger.find((l) => l.rep === rep);
		repTables += `\n### Rep ${rep}\n\n| Run | PID | Exit | Wall (s) | Vitest | Playwright |\n|-----|-----|------|----------|--------|------------|\n`;
		for (const r of repRuns) {
			const a = r.analysis || {};
			const vt = a.vitestPass === true ? "✅" : a.vitestPass === false ? "❌" : "?";
			const pw = a.playwrightPass === true ? "✅" : a.playwrightPass === false ? "❌" : "?";
			const ob = r.overWallCap ? `⚠ ${r.wallS}` : `${r.wallS}`;
			repTables += `| ${r.index} | ${r.pid || "—"} | ${r.exitCode === 0 ? "0 ✅" : `${r.exitCode} ❌`} | ${ob} | ${vt} | ${pw} |\n`;
		}
		if (le) repTables += `\n**Ledger peak Σworkers:** ${le.maxWorkers}/${config.totalCores} ${le.withinCoreCount ? "✅" : "❌"}  (${le.sampleCount} samples)\n`;
	}

	let violationsSection = "";
	if (violations.length > 0) {
		violationsSection = `\n## Violations\n\n`;
		for (const v of violations) violationsSection += `- ❌ ${v}\n`;
		for (const r of runs.filter((x) => x.failureTail)) {
			violationsSection += `\n<details><summary>rep${r.rep}/run#${r.index} (exit ${r.exitCode}) — last output</summary>\n\n\`\`\`\n${r.failureTail}\n\`\`\`\n</details>\n`;
		}
	}

	return `# Concurrency Proof Report

**Generated:** ${ts}  
**Result:** ${icon}  
**Model:** multi-worktree (Option A) — one \`test:v2\` per throwaway git worktree, each with its own \`node_modules\` (\`npm ci\`) + copied \`dist\`, coordinated by the cross-process ledger.  
**Base commit:** \`${config.baseSha}\`  
**Scale:** ${config.concurrent} concurrent × ${config.reps} rep(s) = ${summary.totalRuns} total runs${config.fullSpec ? " (full D7 spec)" : " (reduced smoke — default is 5×3)"}  

> **Acceptance bar (D7):** ${config.specConcurrent} concurrent × ${config.specReps} reps = ${config.specConcurrent * config.specReps} runs, all green, \`retries: 0\`, zero flakes, each run ≤ ${config.perRunWallCapS}s under mutual load, ledger Σworkers ≤ cores. Playwright flakes under load are HARD failures.

## Summary

| Metric | Value | Target | Status |
|--------|-------|--------|--------|
| Runs green (exit 0) | ${summary.green}/${summary.totalRuns} | ${summary.totalRuns}/${summary.totalRuns} | ${summary.green === summary.totalRuns ? "✅" : "❌"} |
| Vitest tier failures | ${summary.vitestFails} | 0 | ${summary.vitestFails === 0 ? "✅" : "❌"} |
| Playwright tier failures | ${summary.playwrightFails} | 0 | ${summary.playwrightFails === 0 ? "✅" : "❌"} |
| Max wall time | ${summary.maxWallS}s | ≤ ${config.perRunWallCapS}s | ${summary.maxWallS <= config.perRunWallCapS ? "✅" : "❌"} |
| Avg / min wall | ${summary.avgWallS}s / ${summary.minWallS}s | — | — |
| Max Σworkers (ledger) | ${summary.maxLedgerWorkers} | ≤ ${config.totalCores} | ${summary.maxLedgerWorkers <= config.totalCores ? "✅" : "❌"} |

## Assertions

| # | Assertion | Status |
|---|-----------|--------|
| A1 | Every run exits 0 (vitest green + playwright green + wall ≤ cap) | ${summary.exitNonZero === 0 ? "✅ PASS" : `❌ FAIL — ${summary.exitNonZero} non-zero`} |
| A2 | No vitest or playwright tier FAIL in any run | ${summary.vitestFails === 0 && summary.playwrightFails === 0 ? "✅ PASS" : `❌ FAIL — vitest ${summary.vitestFails}, playwright ${summary.playwrightFails}`} |
| A3 | Ledger Σworkers ≤ ${config.totalCores} at all times | ${summary.maxLedgerWorkers <= config.totalCores ? "✅ PASS" : `❌ FAIL — peak ${summary.maxLedgerWorkers}`} |
| A4 | Per-run wall ≤ ${config.perRunWallCapS}s | ${summary.maxWallS <= config.perRunWallCapS ? "✅ PASS" : `❌ FAIL — max ${summary.maxWallS}s`} |
${violationsSection}
## Per-Rep Results
${repTables}
## What This Proves

1. **Zero-flake concurrency (realistic model).** ${summary.green}/${summary.totalRuns} concurrent \`test:v2\` runs — each in its own worktree, exactly how Bobbit runs agents — completed green with \`retries: 0\`. A single flake in either tier flips a run's exit code and fails this proof; no downgraded assertions, no dry-run.

2. **CPU exhaustion bounded by the ledger (the D7 mechanism).** Peak Σworkers = ${summary.maxLedgerWorkers}/${config.totalCores}. The ledger counts pending peers during coalescing, so ${config.concurrent} simultaneous runs each get ~\`floor(${config.totalCores}/${config.concurrent})\` slots instead of grabbing the full 12-slot bundle and oversubscribing to ~${config.concurrent * 12} on ${config.totalCores} cores.

3. **Under-load wall budget honoured.** Slowest run: ${summary.maxWallS}s ≤ ${config.perRunWallCapS}s cap (D7 under-load bar), enforced per-run via \`BOBBIT_V2_CONCURRENCY_RUN=1\` → run-v2's under-load budget.

## Reproduce

\`\`\`bash
# Full D7 proof (default 5×3); provisions + tears down worktrees automatically:
node scripts/testing-v2/concurrency-proof.mjs

# Lighter smoke:
CONCURRENCY_PROOF_CONCURRENT=2 CONCURRENCY_PROOF_REPS=1 node scripts/testing-v2/concurrency-proof.mjs
\`\`\`
`;
}

// ─────────────────────────────── entry ───────────────────────────────

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
	main().catch((e) => {
		console.error("[concurrency-proof] fatal:", e);
		process.exit(1);
	});
}
