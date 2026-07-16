#!/usr/bin/env node
/**
 * run-e2e-v2.mjs — the v2 "e2e" real-fidelity tier (task 7862db76).
 *
 * This is the per-workflow real-fidelity remainder that stays out of tier-1/2
 * (`test:v2`): the real-fidelity specs from tests2/tests-map.json (carried under
 * the tests-map `daily` bucket string — an internal taxonomy label, NOT a
 * scheduled lane; there is no `test:daily` script), MINUS
 *   - manual-integration specs (real-agent / real-LLM / real-Docker — that
 *     is the tier-3 `test:manual` lane, never here).
 *
 * Everything else in that bucket runs here at retries:3 (a TEMPORARY
 * concurrency bridge — see docs/testing-strategy.md "Concurrency & budgets" and
 * the Group B/C notes below; Group A uses node:test's --test-force-exit and has
 * no retry knob wired here), in four groups
 * derived mechanically from tests-map.json (so this is reusable, not
 * hand-assembled — it tracks the map, not a frozen list):
 *
 *   Group A — node relocate specs (tests node .test.ts): real git worktree /
 *             sweeper / sandbox-mount / spawn-tree fidelity. Run via `tsx --test`.
 *   Group B — playwright e2e relocate specs (tests/e2e .spec.ts): real
 *             worktree pool / MCP subprocess / port / restart. Run via the legacy
 *             playwright-e2e config at --retries=2 (concurrency bridge).
 *   Group C — adapter browser specs: the geometry/journey specs migrated into
 *             tests2/browser/e2e/. Run via playwright-v2 config, project
 *             `browser-v2-e2e` (retries:3 inherited from the v2 config).
 *   Group D — Vitest real-fidelity suites explicitly classified `vitest-e2e`;
 *             run in the isolated `v2-e2e-vitest` project.
 *
 * External-service-free guarantee: every group runs with BOBBIT_TEST_NO_EXTERNAL
 * / BOBBIT_TEST_NO_REMOTE set (fail-closed on non-loopback fetch + no real git
 * remote / gh), and uses the in-process mock agent bridge. Docker specs are
 * detected and, if the daemon is down, reported (never silently dropped).
 *
 * CPU is sampled over this process' subtree (createCpuSampler), matching the
 * head-to-head methodology, and reported per group + total.
 *
 * Usage:
 *   node scripts/testing-v2/run-e2e-v2.mjs [--group A|B|C|D] [--list] [--json <path>]
 */
import { spawn } from "node:child_process";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname, resolve, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { execFileSync } from "node:child_process";
import { createCpuSampler } from "./assert-budget.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const SAMPLE_DIR = join(REPO_ROOT, ".profiles", "testing-v2", "samples");

function parseArgs(argv) {
	const out = { group: null, list: false, json: null };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--group") out.group = String(argv[++i] || "").toUpperCase();
		else if (a === "--list") out.list = true;
		else if (a === "--json") out.json = argv[++i];
	}
	return out;
}

/** Categorize daily-bucket entries and native real-fidelity owners (excluding manual-integration). */
function classifyDaily() {
	const map = JSON.parse(readFileSync(join(REPO_ROOT, "tests2", "tests-map.json"), "utf8"));
	const daily = (map.entries || []).filter((e) => (e.tier || e.bucket) === "daily");
	const A = []; // node relocate .test.ts
	const B = []; // playwright e2e relocate .spec.ts
	const C = []; // adapter browser specs -> tests2/browser/e2e/<basename>
	const D = []; // isolated Vitest real-fidelity suites
	const excluded = { manualIntegration: [], missing: [] };
	for (const e of daily) {
		const f = e.file;
		if (f.startsWith("tests/manual-integration/")) {
			excluded.manualIntegration.push(f);
			continue;
		}
		if (e.method === "vitest-e2e") {
			const dest = e.v2Path || f;
			if (existsSync(join(REPO_ROOT, dest))) D.push(dest.replace(/\\/g, "/"));
			else excluded.missing.push(dest.replace(/\\/g, "/"));
			continue;
		}
		if (e.method === "adapter") {
			// The physical migrated spec lives in tests2/browser/e2e/<basename>.
			const dest = join("tests2", "browser", "e2e", basename(f));
			if (existsSync(join(REPO_ROOT, dest))) C.push(dest.replace(/\\/g, "/"));
			else excluded.missing.push(dest.replace(/\\/g, "/"));
			continue;
		}
		// relocate
		if (f.startsWith("tests/e2e/") && f.endsWith(".spec.ts")) B.push(f);
		else if (f.endsWith(".test.ts")) A.push(f);
		else excluded.missing.push(f); // unexpected shape
	}
	// Native tests do not have legacy daily-bucket records. Their explicit path
	// and execution ownership place browser/e2e specs in Group C and approved
	// Vitest real-filesystem suites in Group D.
	for (const entry of map.v2Native || []) {
		const dest = String(entry.path || "").replace(/\\/g, "/");
		if (!dest || !existsSync(join(REPO_ROOT, dest))) {
			if (dest) excluded.missing.push(dest);
			continue;
		}
		if (dest.startsWith("tests2/browser/e2e/") && entry.execution?.runner === "playwright") C.push(dest);
		if (entry.execution?.runner === "vitest" && entry.execution?.tier === "e2e" && entry.execution?.project === "e2e") D.push(dest);
	}
	return { A: [...new Set(A)], B: [...new Set(B)], C: [...new Set(C)], D: [...new Set(D)], excluded };
}

function dockerAvailable() {
	try {
		execFileSync("docker", ["ps"], { stdio: "pipe", timeout: 15_000 });
		return true;
	} catch {
		return false;
	}
}

/** Specs known to require a live Docker daemon (their Docker paths skip otherwise). */
const DOCKER_GATED = ["tests/e2e/sandbox-recovery.spec.ts"];

function npmCmd() {
	return process.platform === "win32" ? "npm.cmd" : "npm";
}

function run(command, args, { env = {}, label, shell } = {}) {
	const startWall = performance.now();
	return new Promise((resolveRun) => {
		const child = spawn(command, args, {
			cwd: REPO_ROOT,
			env: { ...process.env, ...env },
			stdio: "inherit",
			// Default: shell on Windows (needed for npm.cmd/npx.cmd). Callers that
			// spawn an absolute exe with spaces (e.g. process.execPath under
			// "C:\Program Files\…") pass shell:false so the path isn't word-split.
			shell: shell ?? (process.platform === "win32"),
		});
		child.on("close", (code, signal) => {
			resolveRun({ label, code: code ?? (signal ? 1 : 0), signal, wallMs: Math.round(performance.now() - startWall) });
		});
		child.on("error", (error) => {
			resolveRun({ label, code: 1, error: String(error), wallMs: Math.round(performance.now() - startWall) });
		});
	});
}

// Fail-closed external-service env for ALL groups (belt-and-braces on top of the
// e2e config's own defaults; the browser-v2-e2e config does not set them itself).
//
// NO_EXTERNAL + NO_REMOTE => skipNonLocalRemoteGit: any git op against a
// NON-local remote (real origin / GitHub) and all outbound non-loopback HTTP are
// rejected. This is the external-service-free guarantee.
//
// We deliberately DO NOT set BOBBIT_TEST_NO_PUSH: the realpush-fidelity specs
// (e.g. goal-archive-branch-cleanup) push to a LOCAL BARE repo on disk (a file
// path, never a network remote) — that is exactly the real-fidelity behaviour
// this tier exists to cover, and it is still external-free. NO_PUSH would
// wrongly disable it and mask the very fidelity we want.
const EXTERNAL_FREE_ENV = {
	BOBBIT_TEST_NO_EXTERNAL: "1",
	BOBBIT_TEST_NO_REMOTE: "1",
};

async function runGroupA(specs) {
	if (specs.length === 0) return { label: "A/node", code: 0, wallMs: 0, skipped: true };
	// tsx --test, force-exit so lingering handles never hang the lane.
	// RESOURCE CAP: node:test defaults to ~CPU-count concurrent FILES. These are
	// worktree/pool/sandbox specs that each boot a gateway AND create git worktrees
	// whose setup runs `npm ci` — running many at once spawns a SWARM of concurrent
	// npm ci + gateway boots that can exhaust the box (suspected cause of the
	// crash + interrupted-npm-ci node_modules corruption on 2026-07-08). Serialise
	// by default (override with E2E_V2_NODE_CONCURRENCY).
	const nodeConc = process.env.E2E_V2_NODE_CONCURRENCY || "1";
	const args = ["--test", "--test-force-exit", `--test-concurrency=${nodeConc}`, ...specs];
	return run(process.platform === "win32" ? "npx.cmd" : "npx", ["tsx", ...args], {
		env: { ...EXTERNAL_FREE_ENV, NODE_ENV: "test" },
		label: "A/node-relocate",
	});
}

async function runGroupB(specs) {
	if (specs.length === 0) return { label: "B/e2e", code: 0, wallMs: 0, skipped: true };
	// Reuse the project's playwright-e2e runner (cache isolation + external-free
	// env baked in) at retries:3 — TEMPORARY concurrency bridge (see file header +
	// docs/testing-strategy.md "Concurrency & budgets"; restore 0 when the higher-N
	// server-throughput fix lands).
	// RESOURCE CAP: bound Playwright workers so the e2e browser swarm can't
	// oversubscribe the box (override with E2E_V2_PW_WORKERS).
	const pwWorkers = process.env.E2E_V2_PW_WORKERS || "2";
	return run(npmCmd(), ["run", "test:e2e:run", "--", ...specs, `--workers=${pwWorkers}`, "--retries=3"], {
		env: { ...EXTERNAL_FREE_ENV },
		label: "B/e2e-relocate",
	});
}

async function runGroupC(specs) {
	if (specs.length === 0) return { label: "C/browser", code: 0, wallMs: 0, skipped: true };
	// playwright-v2 config, browser-v2-e2e project (retries:3 from config —
	// the concurrency bridge; we intentionally do NOT pass --retries here so the
	// config's value governs).
	// We run the WHOLE project (its testDir IS tests2/browser/e2e — the physical
	// real-fidelity browser bucket) rather than passing individual spec paths:
	// Playwright's `--project` is variadic and would swallow trailing positional
	// file filters as extra project names. The e2e dir is the source of truth for
	// this bucket (it also carries crash-restart.journey, which tier-2 `test:v2`
	// ignores).
	const localCli = join(REPO_ROOT, "node_modules", "playwright", "cli.js");
	const usesLocal = existsSync(localCli);
	const cmd = usesLocal ? process.execPath : (process.platform === "win32" ? "npx.cmd" : "npx");
	const pre = usesLocal ? [localCli] : ["playwright"];
	// RESOURCE CAP: bound Playwright workers (override with E2E_V2_PW_WORKERS).
	const pwWorkersC = process.env.E2E_V2_PW_WORKERS || "2";
	return run(cmd, [...pre, "test", "--config", "playwright-v2.config.ts", "--project", "browser-v2-e2e", `--workers=${pwWorkersC}`], {
		env: { ...EXTERNAL_FREE_ENV },
		label: "C/adapter-browser",
		// node.exe path may contain spaces (C:\Program Files\nodejs); spawn it
		// directly without a shell so the path isn't word-split.
		shell: usesLocal ? false : (process.platform === "win32"),
	});
}

async function runGroupD(specs) {
	if (specs.length === 0) return { label: "D/vitest", code: 0, wallMs: 0, skipped: true };
	const vitestCli = join(REPO_ROOT, "node_modules", "vitest", "vitest.mjs");
	return run(process.execPath, [
		vitestCli,
		"run",
		"--config", "vitest.config.ts",
		"--project", "v2-e2e-vitest",
		"--silent=passed-only",
	], {
		env: {
			...EXTERNAL_FREE_ENV,
			BOBBIT_V2_E2E_VITEST: "1",
			VITEST_MAX_WORKERS: "1",
		},
		label: "D/vitest-real-fidelity",
		shell: false,
	});
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const { A, B, C, D, excluded } = classifyDaily();

	if (args.list) {
		console.log(JSON.stringify({ A, B, C, D, excluded }, null, 2));
		return;
	}

	console.log(`[e2e-v2] e2e:v2 real-fidelity tier — A(node)=${A.length} B(e2e)=${B.length} C(browser)=${C.length} D(vitest)=${D.length}`);
	console.log(`[e2e-v2] excluded: manual-integration=${excluded.manualIntegration.length}${excluded.missing.length ? `, MISSING=${excluded.missing.length} (${excluded.missing.join(", ")})` : ""}`);

	const docker = dockerAvailable();
	const dockerGatedPresent = DOCKER_GATED.filter((f) => B.includes(f));
	if (dockerGatedPresent.length) {
		console.log(`[e2e-v2] Docker ${docker ? "AVAILABLE" : "UNAVAILABLE"} — Docker-gated specs: ${dockerGatedPresent.join(", ")}${docker ? "" : " (Docker paths will self-skip; non-Docker paths still run)"}`);
	}

	const sampler = createCpuSampler(process.pid, { intervalMs: 1000 });
	const startWall = performance.now();

	const only = args.group;
	const results = [];
	if (!only || only === "A") results.push(await runGroupA(A));
	if (!only || only === "B") results.push(await runGroupB(B));
	if (!only || only === "C") results.push(await runGroupC(C));
	if (!only || only === "D") results.push(await runGroupD(D));

	const sample = sampler.stop();
	const wallMs = Math.round(performance.now() - startWall);

	mkdirSync(SAMPLE_DIR, { recursive: true });
	const samplePath = join(SAMPLE_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}-e2e-v2.json`);
	const report = {
		scope: "e2e-v2",
		cpuMin: +(sample.cpuMs / 60000).toFixed(3),
		cpuMs: sample.cpuMs,
		wallMs,
		wallSec: +(wallMs / 1000).toFixed(1),
		peakProcesses: sample.peakProcesses,
		docker,
		groups: results.map((r) => ({ label: r.label, code: r.code, wallSec: +(r.wallMs / 1000).toFixed(1), skipped: !!r.skipped, error: r.error })),
		counts: { A: A.length, B: B.length, C: C.length, D: D.length },
		excluded,
		createdAt: new Date().toISOString(),
	};
	writeFileSync(samplePath, `${JSON.stringify(report, null, 2)}\n`);
	if (args.json) writeFileSync(args.json, `${JSON.stringify(report, null, 2)}\n`);

	for (const r of results) {
		const status = r.skipped ? "SKIP" : r.code === 0 ? "PASS" : "FAIL";
		console.log(`[e2e-v2] ${r.label}: ${status} in ${(r.wallMs / 1000).toFixed(1)}s${r.error ? ` — ${r.error}` : ""}`);
	}
	console.log(`[e2e-v2] total wall ${(wallMs / 1000).toFixed(1)}s, subtree CPU ${(sample.cpuMs / 60000).toFixed(2)} CPU-min (peak procs ${sample.peakProcesses})`);
	console.log(`[e2e-v2] report: ${samplePath}`);

	const anyFailed = results.some((r) => r.code !== 0);
	process.exit(anyFailed ? 1 : 0);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
	main().catch((e) => {
		console.error("[e2e-v2] fatal:", e);
		process.exit(1);
	});
}
