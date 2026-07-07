#!/usr/bin/env node
/**
 * concurrency-proof.mjs — HONEST proof that N concurrent `test:v2` runs stay
 * green and within budget while the ledger keeps Σworkers ≤ cores (D7).
 *
 * D7 acceptance bar (docs/testing-v2/design.md §D7 — SETTLED):
 *   - 5 concurrent `test:v2` runs × 3 reps = 15/15 GREEN, retries:0, ZERO flakes.
 *   - Each run wall ≤ 600 s (10 min) under mutual load.
 *   - Ledger Σworkers ≤ cores (24) at all times.
 *
 * There is NO dry-run and NO downgraded assertion. A run's exit code is the
 * primary signal: each run is spawned with BOBBIT_V2_CONCURRENCY_RUN=1, which
 * switches run-v2's full-scope budget to the under-load per-run cap
 * (budgets.concurrency.perRunMaxWallMs). Therefore `exit 0` ⟺ vitest green AND
 * playwright green AND wall ≤ under-load cap. Any non-zero exit — including a
 * playwright flake — is a HARD failure that fails this proof.
 *
 * Default scale is the full spec (5 × 3). Override for a lighter smoke:
 *   CONCURRENCY_PROOF_CONCURRENT=2 CONCURRENCY_PROOF_REPS=1 node scripts/testing-v2/concurrency-proof.mjs
 *
 * Outputs:
 *   docs/testing-v2/concurrency-proof.md
 *   .profiles/testing-v2/concurrency-proof/result.json
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { cpus } from "node:os";
import { readLedger, ledgerDir } from "./ledger.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");

// ──────────────────────────────── config ────────────────────────────────

const TOTAL_CORES = Number(process.env.BOBBIT_V2_TOTAL_CORES) || cpus().length;

function budgetsPerRunWallS() {
	try {
		const b = JSON.parse(readFileSync(join(REPO_ROOT, "tests2", "budgets.json"), "utf8"));
		if (b.concurrency && Number.isFinite(b.concurrency.perRunMaxWallMs)) return Math.round(b.concurrency.perRunMaxWallMs / 1000);
	} catch {
		/* fall through to default */
	}
	return 600;
}

// Under-load per-run wall cap (D7 = 600 s). Env override for experiments only.
const WALL_BUDGET_S = Number(process.env.CONCURRENCY_PROOF_WALL_S) || budgetsPerRunWallS();

let CONCURRENT = Number(process.env.CONCURRENCY_PROOF_CONCURRENT) || 5;
let REPS = Number(process.env.CONCURRENCY_PROOF_REPS) || 3;

for (let i = 2; i < process.argv.length; i++) {
	const arg = process.argv[i];
	if (arg === "--concurrent" && process.argv[i + 1]) CONCURRENT = Number(process.argv[++i]);
	else if (arg === "--reps" && process.argv[i + 1]) REPS = Number(process.argv[++i]);
	else if (arg.startsWith("--concurrent=")) CONCURRENT = Number(arg.split("=")[1]);
	else if (arg.startsWith("--reps=")) REPS = Number(arg.split("=")[1]);
}

const REPORT_DIR = join(REPO_ROOT, "docs", "testing-v2");
const ARTIFACT_DIR = join(REPO_ROOT, ".profiles", "testing-v2", "concurrency-proof");

function npmCmd() {
	return process.platform === "win32" ? "npm.cmd" : "npm";
}

// ──────────────────────────────── output analysis ────────────────────────────────

/**
 * Parse a run's combined output to attribute failures to a tier. This is
 * DEFENCE-IN-DEPTH on top of the exit code: run-v2 prints an explicit PASS/FAIL
 * line per tier, so we can name which tier broke instead of only "exit 1".
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

// ──────────────────────────────── spawn ────────────────────────────────

function spawnRun(index, rep, cleanEnv) {
	const startWall = performance.now();
	const lines = [];
	return new Promise((resolveRun) => {
		const child = spawn(npmCmd(), ["run", "test:v2"], {
			cwd: REPO_ROOT,
			env: cleanEnv,
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
			/* ledger locked — skip sample */
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

// ──────────────────────────────── failure tail ────────────────────────────────

/** Last ~40 non-empty output lines from a failed run, for the report. */
function failureTail(run) {
	const text = run.lines.map(([, l]) => l).join("");
	const nonEmpty = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
	return nonEmpty.slice(-40).join("\n");
}

// ──────────────────────────────── main ────────────────────────────────

async function main() {
	console.log(`\n╔══════════════════════════════════════════════════════════╗`);
	console.log(`║            test:v2 concurrency proof (HONEST)            ║`);
	console.log(`╚══════════════════════════════════════════════════════════╝`);
	console.log(`  concurrent=${CONCURRENT}  reps=${REPS}  totalRuns=${CONCURRENT * REPS}`);
	console.log(`  perRunWallCap=${WALL_BUDGET_S}s  cores=${TOTAL_CORES}`);
	console.log(`  ledger dir: ${ledgerDir()}\n`);

	// Each spawned run is a fresh top-level `test:v2` — strip any inherited ledger
	// parent env so every run performs its own parent reservation, and flag it as
	// an under-load run so run-v2 enforces the under-load per-run budget.
	const cleanEnv = { ...process.env, BOBBIT_V2_CONCURRENCY_RUN: "1" };
	delete cleanEnv.BOBBIT_V2_LEDGER_PARENT;
	delete cleanEnv.BOBBIT_V2_SLOTS_VITEST;
	delete cleanEnv.BOBBIT_V2_SLOTS_PLAYWRIGHT;

	const allRunResults = [];
	const allLedgerPolls = [];
	const violations = [];

	for (let rep = 1; rep <= REPS; rep++) {
		console.log(`\n─── rep ${rep}/${REPS}: launching ${CONCURRENT} concurrent test:v2 runs ───`);

		const repStart = performance.now();
		const runPromises = Array.from({ length: CONCURRENT }, (_, i) => spawnRun(i + 1, rep, cleanEnv));
		const ledgerPoll = pollLedger(runPromises);

		let progressDone = false;
		const progressTimer = setInterval(() => {
			if (progressDone) return;
			const elapsed = Math.round((performance.now() - repStart) / 1000);
			console.log(`  [rep ${rep}] ${elapsed}s elapsed…`);
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
			const wallS = (r.wallMs / 1000).toFixed(1);
			console.log(`  run #${r.index}: ${exitStatus} (${vt} ${pw}) ${wallS}s pid=${r.pid}${r.spawnError ? ` ERROR:${r.spawnError}` : ""}`);
		}
		console.log(`  ledger peak Σworkers=${ledgerResult.maxWorkers}/${TOTAL_CORES}`);
		console.log(`  rep ${rep} wall: ${(repWall / 1000).toFixed(1)}s`);
	}

	// ──────────── assertions (all HARD) ────────────

	console.log(`\n─── assertions ───`);

	// A1: every run exits 0 (⟺ vitest green + playwright green + wall ≤ under-load cap).
	const failedRuns = allRunResults.filter((r) => r.exitCode !== 0);
	if (failedRuns.length > 0) {
		violations.push(`A1: ${failedRuns.length}/${allRunResults.length} run(s) exited non-zero: ${failedRuns.map((r) => `rep${r.rep}/#${r.index}(exit ${r.exitCode})`).join(", ")}`);
		console.error(`  ✗ A1 FAIL — ${failedRuns.length} run(s) exited non-zero`);
	} else {
		console.log(`  ✓ A1 PASS — all ${allRunResults.length} runs exited 0`);
	}

	// A2: tier attribution — no run may report a vitest or playwright FAIL line.
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

	// A3: ledger Σworkers ≤ cores at all times.
	let a3Bad = false;
	for (const poll of allLedgerPolls) {
		if (poll.maxWorkers > TOTAL_CORES) {
			a3Bad = true;
			violations.push(`A3: ledger Σworkers=${poll.maxWorkers} > cores=${TOTAL_CORES} in rep ${poll.rep}`);
			console.error(`  ✗ A3 FAIL — rep ${poll.rep}: Σworkers=${poll.maxWorkers} > cores=${TOTAL_CORES}`);
		}
	}
	if (!a3Bad) {
		const maxSeen = Math.max(...allLedgerPolls.map((p) => p.maxWorkers), 0);
		console.log(`  ✓ A3 PASS — Σworkers always ≤ ${TOTAL_CORES} (max seen=${maxSeen})`);
	}

	// A4: per-run wall ≤ under-load cap (belt & suspenders on top of run-v2's own gate).
	const slowRuns = allRunResults.filter((r) => r.wallMs > WALL_BUDGET_S * 1000);
	if (slowRuns.length > 0) {
		violations.push(`A4: ${slowRuns.length} run(s) exceeded ${WALL_BUDGET_S}s: ${slowRuns.map((r) => `rep${r.rep}/#${r.index}(${(r.wallMs / 1000).toFixed(1)}s)`).join(", ")}`);
		console.error(`  ✗ A4 FAIL — ${slowRuns.length} run(s) over ${WALL_BUDGET_S}s`);
	} else {
		const maxWall = Math.max(...allRunResults.map((r) => r.wallMs), 0);
		console.log(`  ✓ A4 PASS — all runs within ${WALL_BUDGET_S}s (max=${(maxWall / 1000).toFixed(1)}s)`);
	}

	const pass = violations.length === 0;

	// ──────────── result JSON ────────────

	const wallMsAll = allRunResults.map((r) => r.wallMs);
	const result = {
		pass,
		violations,
		config: {
			concurrent: CONCURRENT,
			reps: REPS,
			perRunWallCapS: WALL_BUDGET_S,
			totalCores: TOTAL_CORES,
			specConcurrent: 5,
			specReps: 3,
			fullSpec: CONCURRENT >= 5 && REPS >= 3,
			note: CONCURRENT >= 5 && REPS >= 3 ? "Full D7 spec proof (5×3)." : "Reduced-scale smoke; full proof is 5×3 (the default).",
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
		ledger: allLedgerPolls.map((p) => ({
			rep: p.rep,
			maxWorkers: p.maxWorkers,
			sampleCount: p.samples.length,
			withinCoreCount: p.maxWorkers <= TOTAL_CORES,
			samples: p.samples.slice(0, 40),
		})),
		createdAt: new Date().toISOString(),
	};

	// ──────────── write artifacts ────────────

	mkdirSync(ARTIFACT_DIR, { recursive: true });
	mkdirSync(REPORT_DIR, { recursive: true });

	const resultJsonPath = join(ARTIFACT_DIR, "result.json");
	writeFileSync(resultJsonPath, `${JSON.stringify(result, null, 2)}\n`);
	console.log(`\n  artifact: ${resultJsonPath}`);

	const mdPath = join(REPORT_DIR, "concurrency-proof.md");
	writeFileSync(mdPath, buildMarkdown(result));
	console.log(`  report:   ${mdPath}`);

	// ──────────── final verdict ────────────

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
		repTables += `\n### Rep ${rep}\n\n`;
		repTables += `| Run | PID | Exit | Wall (s) | Vitest | Playwright |\n`;
		repTables += `|-----|-----|------|----------|--------|------------|\n`;
		for (const r of repRuns) {
			const a = r.analysis || {};
			const vt = a.vitestPass === true ? "✅" : a.vitestPass === false ? "❌" : "?";
			const pw = a.playwrightPass === true ? "✅" : a.playwrightPass === false ? "❌" : "?";
			const ob = r.overWallCap ? `⚠ ${r.wallS}` : `${r.wallS}`;
			const exit = r.exitCode === 0 ? "0 ✅" : `${r.exitCode} ❌`;
			repTables += `| ${r.index} | ${r.pid || "—"} | ${exit} | ${ob} | ${vt} | ${pw} |\n`;
		}
		if (le) {
			const ledgerIcon = le.withinCoreCount ? "✅" : "❌";
			repTables += `\n**Ledger peak Σworkers:** ${le.maxWorkers}/${config.totalCores} ${ledgerIcon}  (${le.sampleCount} samples)\n`;
		}
	}

	let violationsSection = "";
	if (violations.length > 0) {
		violationsSection = `\n## Violations\n\n`;
		for (const v of violations) violationsSection += `- ❌ ${v}\n`;
		// Attach failure tails for any failed run.
		const failed = runs.filter((r) => r.failureTail);
		for (const r of failed) {
			violationsSection += `\n<details><summary>rep${r.rep}/run#${r.index} (exit ${r.exitCode}) — last output</summary>\n\n\`\`\`\n${r.failureTail}\n\`\`\`\n</details>\n`;
		}
	}

	return `# Concurrency Proof Report

**Generated:** ${ts}  
**Result:** ${icon}  
**Scale:** ${config.concurrent} concurrent × ${config.reps} rep(s) = ${summary.totalRuns} total runs${config.fullSpec ? " (full D7 spec)" : " (reduced smoke — default is 5×3)"}  

> **Acceptance bar (D7):** ${config.specConcurrent} concurrent × ${config.specReps} reps = ${config.specConcurrent * config.specReps} runs, all green, \`retries: 0\`, zero flakes, each run ≤ ${config.perRunWallCapS}s under mutual load, ledger Σworkers ≤ cores. Playwright flakes under load are HARD failures.

## Summary

| Metric | Value | Target | Status |
|--------|-------|--------|--------|
| Runs green (exit 0) | ${summary.green}/${summary.totalRuns} | ${summary.totalRuns}/${summary.totalRuns} | ${summary.green === summary.totalRuns ? "✅" : "❌"} |
| Runs exit non-zero | ${summary.exitNonZero} | 0 | ${summary.exitNonZero === 0 ? "✅" : "❌"} |
| Vitest tier failures | ${summary.vitestFails} | 0 | ${summary.vitestFails === 0 ? "✅" : "❌"} |
| Playwright tier failures | ${summary.playwrightFails} | 0 | ${summary.playwrightFails === 0 ? "✅" : "❌"} |
| Max wall time | ${summary.maxWallS}s | ≤ ${config.perRunWallCapS}s | ${summary.maxWallS <= config.perRunWallCapS ? "✅" : "❌"} |
| Avg wall time | ${summary.avgWallS}s | — | — |
| Min wall time | ${summary.minWallS}s | — | — |
| Max Σworkers (ledger) | ${summary.maxLedgerWorkers} | ≤ ${config.totalCores} | ${summary.maxLedgerWorkers <= config.totalCores ? "✅" : "❌"} |

## Assertions

| # | Assertion | Status |
|---|-----------|--------|
| A1 | Every run exits 0 (vitest green + playwright green + wall ≤ cap) | ${summary.exitNonZero === 0 ? "✅ PASS" : `❌ FAIL — ${summary.exitNonZero} non-zero`} |
| A2 | No vitest or playwright tier FAIL line in any run | ${summary.vitestFails === 0 && summary.playwrightFails === 0 ? "✅ PASS" : `❌ FAIL — vitest ${summary.vitestFails}, playwright ${summary.playwrightFails}`} |
| A3 | Ledger Σworkers ≤ ${config.totalCores} at all times | ${summary.maxLedgerWorkers <= config.totalCores ? "✅ PASS" : `❌ FAIL — peak ${summary.maxLedgerWorkers}`} |
| A4 | Per-run wall ≤ ${config.perRunWallCapS}s | ${summary.maxWallS <= config.perRunWallCapS ? "✅ PASS" : `❌ FAIL — max ${summary.maxWallS}s`} |
${violationsSection}
## Per-Rep Results
${repTables}
## What This Proves

1. **Zero-flake concurrency.** ${summary.green}/${summary.totalRuns} concurrent \`test:v2\` runs completed green with \`retries: 0\`. A single flake — in either tier — would flip a run's exit code and fail this proof; there are no downgraded assertions and no dry-run.

2. **CPU exhaustion is bounded by the ledger (the D7 mechanism).** Peak Σworkers across all concurrent runs was ${summary.maxLedgerWorkers}/${config.totalCores}. The ledger counts pending peers during the coalescing window, so ${config.concurrent} simultaneous runs each receive ~\`floor(${config.totalCores}/${config.concurrent})\` slots instead of grabbing the full 12-slot bundle and oversubscribing to ~${config.concurrent * 12} on ${config.totalCores} cores.

3. **Under-load wall budget honoured.** Slowest run: ${summary.maxWallS}s ≤ ${config.perRunWallCapS}s cap (D7 under-load bar). Each run enforces this itself via \`BOBBIT_V2_CONCURRENCY_RUN=1\` → run-v2's under-load full-scope budget.

## Reproduce

\`\`\`bash
# Full D7 proof (default scale):
node scripts/testing-v2/concurrency-proof.mjs

# Lighter smoke:
CONCURRENCY_PROOF_CONCURRENT=2 CONCURRENCY_PROOF_REPS=1 node scripts/testing-v2/concurrency-proof.mjs
\`\`\`

## Configuration

\`\`\`json
${JSON.stringify(config, null, 2)}
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
