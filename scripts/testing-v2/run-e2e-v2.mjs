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
 * Everything else in that bucket normally runs at retries:3 for developer
 * workflow resilience. Set BOBBIT_V2_RETRY_FREE=1 to qualify Groups B/C/D with
 * retries disabled; Group A completes through its owning fixture teardowns and
 * has no retry knob wired here. The groups are derived mechanically from tests-map.json (so this is reusable, not
 * hand-assembled — it tracks the map, not a frozen list):
 *
 *   Group A — node relocate specs (tests node .test.ts): real git worktree /
 *             sweeper / sandbox-mount / spawn-tree fidelity. Run via `tsx --test`.
 *   Group B — playwright e2e relocate specs (tests/e2e .spec.ts): real
 *             worktree pool / MCP subprocess / port / restart. Run via the legacy
 *             playwright-e2e config at retries:3 (or 0 when qualifying).
 *   Group C — adapter browser specs: the geometry/journey specs migrated into
 *             tests2/browser/e2e/. Run via playwright-v2 config, project
 *             `browser-v2-e2e` (retries:3 normally, 0 when qualifying).
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
import { once } from "node:events";
import { createReadStream, createWriteStream, readFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname, resolve, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { finished } from "node:stream/promises";
import { execFileSync } from "node:child_process";
import { createCpuSampler } from "./assert-budget.mjs";
import { coordinatorTempDirectory, createE2ERunPaths, createIsolatedE2EEnvironment } from "../run-playwright-e2e.mjs";
import { copyEnvironment, deleteEnvironmentValue } from "./environment-policy.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const PERFORMANCE_REPORT_DIR = join(REPO_ROOT, ".profiles", "testing-v2", "samples");

/**
 * Give the top-level E2E coordinator its own environment before it starts any
 * group. Group B's legacy wrapper receives this environment and allocates a
 * nested root; Groups A/C/D share only this coordinator-owned root.
 */
export function createE2EV2CoordinatorEnvironment(paths, inheritedEnv = process.env, platform = process.platform) {
	const env = createIsolatedE2EEnvironment(paths, inheritedEnv, platform);
	return copyEnvironment(env, {
		BOBBIT_V2_RUN_ROOT: paths.root,
		BOBBIT_V2_RUN_ROOT_OWNER_PID: String(process.pid),
		BOBBIT_E2E_RUN_ID: paths.runId,
		BOBBIT_E2E_TMP_ROOT: paths.legacyTempParent,
		BOBBIT_E2E_PWTEST_CACHE_ROOT: paths.cacheRoot,
		BOBBIT_E2E_PWTEST_RUN_CACHE_ROOT: paths.cacheRoot,
		PWTEST_CACHE_DIR: paths.cacheRoot,
		BOBBIT_E2E_PWTEST_CACHE_DIR: paths.cacheRoot,
		BOBBIT_E2E_PWTEST_CACHE_OWNED: "1",
		BOBBIT_E2E_V8CACHE_ROOT: paths.v8CacheRoot,
		NODE_DISABLE_COMPILE_CACHE: "1",
	}, platform);
}

function cleanup(root) {
	try {
		// Windows can briefly retain Playwright output handles after its child
		// exits. Keep retries bounded while tolerating transient EPERM/ENOTEMPTY.
		rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
		return true;
	} catch {
		return false;
	}
}

/** Copy a fully prepared environment without resurrecting ambient host values. */
export function composeE2EChildEnvironment(environment, additions = {}, platform = process.platform) {
	return copyEnvironment(environment, additions, platform);
}

/** Remove coordinator cache settings before invoking the nested legacy runner. */
export function createNestedE2EEnvironment(coordinatorEnv, platform = process.platform) {
	const nestedEnv = { ...coordinatorEnv };
	for (const key of [
		"PWTEST_CACHE_DIR",
		"BOBBIT_E2E_PWTEST_CACHE_ROOT",
		"BOBBIT_E2E_PWTEST_RUN_CACHE_ROOT",
		"BOBBIT_E2E_PWTEST_CACHE_DIR",
		"BOBBIT_E2E_PWTEST_CACHE_OWNED",
		"BOBBIT_PWTEST_CACHE_ROOT",
		"BOBBIT_E2E_V8CACHE_ROOT",
	]) deleteEnvironmentValue(nestedEnv, key, platform);
	return nestedEnv;
}

/** Persist the default report outside the disposable run root, uniquely per run. */
export function defaultPerformanceReportPath(paths) {
	return join(PERFORMANCE_REPORT_DIR, `${paths.runId}-e2e-v2.json`);
}

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
const DOCKER_GATED = [
	"tests/e2e/pinned-verification-sidecar.spec.ts",
	"tests/e2e/sandbox-recovery.spec.ts",
];

function npmCmd() {
	return process.platform === "win32" ? "npm.cmd" : "npm";
}

// The E2E runner intentionally defaults Groups B/C to two workers. It is a
// conservative cross-platform baseline; workflow callers can opt into more
// parallelism with E2E_V2_PW_WORKERS=1..4 (Git Bash supports the same prefix on
// Windows). Keep the bound aligned with the global browser-render lease cap.
export function resolveE2ePlaywrightWorkers(env = process.env) {
	const requested = Number(env.E2E_V2_PW_WORKERS);
	if (!Number.isInteger(requested) || requested < 1) return 2;
	return Math.min(4, requested);
}

function run(command, args, { env = {}, label, shell, captureOutputDir } = {}) {
	const startWall = performance.now();
	return new Promise((resolveRun) => {
		const capturedOutput = captureOutputDir ? {
			dir: captureOutputDir,
			stdout: join(captureOutputDir, "stdout.log"),
			stderr: join(captureOutputDir, "stderr.log"),
		} : undefined;
		if (capturedOutput) mkdirSync(capturedOutput.dir, { recursive: true });

		const child = spawn(command, args, {
			cwd: REPO_ROOT,
			// `env` is already built from the coordinator's sanitized environment.
			// Re-merging process.env here would restore deleted credentials/cache roots.
			env: composeE2EChildEnvironment(env),
			stdio: capturedOutput ? ["inherit", "pipe", "pipe"] : "inherit",
			// Default: shell on Windows (needed for npm.cmd/npx.cmd). Callers that
			// spawn an absolute exe with spaces (e.g. process.execPath under
			// "C:\Program Files\…") pass shell:false so the path isn't word-split.
			shell: shell ?? (process.platform === "win32"),
		});

		// Pipe continuously into live spool files. Node's pipe backpressure keeps
		// both child streams drained without an exec-style maxBuffer, while the
		// files retain failure output if the outer gate kills this runner before
		// the deterministic replay point.
		let captureCompletion = Promise.resolve(null);
		if (capturedOutput) {
			const stdoutSink = createWriteStream(capturedOutput.stdout);
			const stderrSink = createWriteStream(capturedOutput.stderr);
			child.stdout.pipe(stdoutSink);
			child.stderr.pipe(stderrSink);
			captureCompletion = Promise.all([finished(stdoutSink), finished(stderrSink)])
				.then(() => null, (error) => error);
		}

		let settled = false;
		const finishRun = async (result) => {
			if (settled) return;
			settled = true;
			const captureError = await captureCompletion;
			resolveRun({
				...result,
				label,
				code: captureError ? 1 : result.code,
				error: result.error ?? (captureError ? `Failed to capture output: ${captureError}` : undefined),
				wallMs: Math.round(performance.now() - startWall),
				capturedOutput,
			});
		};
		child.on("close", (code, signal) => {
			void finishRun({ code: code ?? (signal ? 1 : 0), signal });
		});
		child.on("error", (error) => {
			void finishRun({ code: 1, error: String(error) });
		});
	});
}

async function replayCapturedOutput(capturedOutput) {
	if (!capturedOutput) return;
	// Replay raw Buffers so ANSI/control bytes are unchanged. Stream the files
	// instead of reading them wholesale, and honor destination backpressure so
	// replay completes before the deterministic Group D summary.
	for (const [file, destination] of [
		[capturedOutput.stdout, process.stdout],
		[capturedOutput.stderr, process.stderr],
	]) {
		for await (const chunk of createReadStream(file)) {
			if (!destination.write(chunk)) await once(destination, "drain");
		}
	}
	// Keep the live spool intact if replay throws so failure detail is not lost.
	rmSync(capturedOutput.dir, { recursive: true, force: true });
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

async function runGroupA(specs, coordinatorEnv) {
	if (specs.length === 0) return { label: "A/node", code: 0, wallMs: 0, skipped: true };
	// tsx --test lets node exit only after each fixture has completed its teardown.
	// RESOURCE CAP: node:test defaults to ~CPU-count concurrent FILES. These are
	// worktree/pool/sandbox specs that each boot a gateway AND create git worktrees.
	// Worktree setup does NOT run `npm ci` here (verified 2026-07-16): every
	// worktree-provisioning Group A test sets BOBBIT_SKIP_NPM_CI=1, and the rest
	// never configure an npm-ci setup command — so the per-file cost is a gateway
	// boot plus git worktree creation, not an npm-ci swarm. Default to 2 concurrent
	// files to cut wall time while keeping gateway-boot load modest (override with
	// E2E_V2_NODE_CONCURRENCY).
	const nodeConc = process.env.E2E_V2_NODE_CONCURRENCY || "2";
	const args = ["--test", `--test-concurrency=${nodeConc}`, ...specs];
	return run(process.platform === "win32" ? "npx.cmd" : "npx", ["tsx", ...args], {
		env: composeE2EChildEnvironment(coordinatorEnv, { ...EXTERNAL_FREE_ENV, NODE_ENV: "test" }),
		label: "A/node-relocate",
	});
}

export function resolveE2ERetryCount(env = process.env) {
	return env.BOBBIT_V2_RETRY_FREE === "1" ? 0 : 3;
}

function isRetryFreeQualification(env = process.env) {
	return resolveE2ERetryCount(env) === 0;
}

async function runGroupB(specs, coordinatorEnv) {
	if (specs.length === 0) return { label: "B/e2e", code: 0, wallMs: 0, skipped: true };
	// The legacy wrapper must allocate its own nested Playwright cache rather
	// than inheriting this coordinator's cache settings. It still inherits the
	// owned temp directory, so its `createE2ERunPaths()` child is contained here.
	const nestedEnv = createNestedE2EEnvironment(coordinatorEnv);
	const retries = resolveE2ERetryCount(coordinatorEnv);
	// Preserve retries:3 for ordinary workflow use. Retry-free qualification
	// explicitly passes 0 so no first-attempt failure can be hidden.
	const pwWorkers = resolveE2ePlaywrightWorkers();
	return run(npmCmd(), ["run", "test:e2e:run", "--", ...specs, `--workers=${pwWorkers}`, `--retries=${retries}`], {
		env: composeE2EChildEnvironment(nestedEnv, EXTERNAL_FREE_ENV),
		label: "B/e2e-relocate",
	});
}

async function runGroupC(specs, coordinatorEnv) {
	if (specs.length === 0) return { label: "C/browser", code: 0, wallMs: 0, skipped: true };
	// playwright-v2 config, browser-v2-e2e project. The config's retry-free
	// override is inherited through coordinatorEnv when qualifying.
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
	const pwWorkersC = resolveE2ePlaywrightWorkers();
	const retryArgs = isRetryFreeQualification(coordinatorEnv) ? ["--retries=0"] : [];
	return run(cmd, [...pre, "test", "--config", "playwright-v2.config.ts", "--project", "browser-v2-e2e", `--workers=${pwWorkersC}`, ...retryArgs], {
		env: composeE2EChildEnvironment(coordinatorEnv, EXTERNAL_FREE_ENV),
		label: "C/adapter-browser",
		// node.exe path may contain spaces (C:\Program Files\nodejs); spawn it
		// directly without a shell so the path isn't word-split.
		shell: usesLocal ? false : (process.platform === "win32"),
	});
}

export function groupDVitestArgs(env = process.env) {
	return [
		"run",
		"--config", "vitest.config.ts",
		"--project", "v2-e2e-vitest",
		"--silent=passed-only",
		...(isRetryFreeQualification(env) ? ["--retry=0"] : []),
	];
}

async function runGroupD(specs, { captureOutputDir, coordinatorEnv } = {}) {
	if (specs.length === 0) return { label: "D/vitest", code: 0, wallMs: 0, skipped: true };
	const vitestCli = join(REPO_ROOT, "node_modules", "vitest", "vitest.mjs");
	return run(process.execPath, [vitestCli, ...groupDVitestArgs(coordinatorEnv)], {
		env: composeE2EChildEnvironment(coordinatorEnv, {
			...EXTERNAL_FREE_ENV,
			BOBBIT_V2_E2E_VITEST: "1",
			VITEST_MAX_WORKERS: "1",
		}),
		label: "D/vitest-real-fidelity",
		shell: false,
		captureOutputDir,
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

	const paths = createE2ERunPaths(coordinatorTempDirectory());
	const coordinatorEnv = createE2EV2CoordinatorEnvironment(paths);
	const sampler = createCpuSampler(process.pid, { intervalMs: 1000 });
	const startWall = performance.now();

	const only = args.group;
	const results = [];
	let groupDResult;
	if (only) {
		// Focused group runs retain their existing single-group behavior.
		if (only === "A") results.push(await runGroupA(A, coordinatorEnv));
		if (only === "B") results.push(await runGroupB(B, coordinatorEnv));
		if (only === "C") results.push(await runGroupC(C, coordinatorEnv));
		if (only === "D") results.push(await runGroupD(D, { coordinatorEnv }));
	} else {
		// Keep the gateway/worktree/browser-heavy A → B → C lane serialized. Group D
		// is independent: it owns a separate Vitest coordinator and PID-scoped cache,
		// uses isolated temp fixture roots, and is already capped at one worker. Start
		// only that bounded lane concurrently, then await it so cleanup, reporting,
		// failure aggregation, and result ordering remain unchanged.
		console.log("[e2e-v2] schedule: A → B → C; isolated single-worker D runs concurrently");
		const groupDCaptureDir = join(paths.root, "e2e-captures", "group-d");
		console.log(`[e2e-v2] Group D output captured live at ${groupDCaptureDir} until replay`);
		const groupDRun = runGroupD(D, { captureOutputDir: groupDCaptureDir, coordinatorEnv });
		results.push(await runGroupA(A, coordinatorEnv));
		results.push(await runGroupB(B, coordinatorEnv));
		results.push(await runGroupC(C, coordinatorEnv));
		groupDResult = await groupDRun;
		results.push(groupDResult);
	}

	// Stop execution sampling as soon as both lanes settle, matching the original
	// CPU/wall accounting. Deferred log replay is reporting overhead, not test work.
	const sample = sampler.stop();
	const wallMs = Math.round(performance.now() - startWall);

	if (groupDResult?.capturedOutput) {
		console.log("[e2e-v2] replaying captured Group D output");
		try {
			await replayCapturedOutput(groupDResult.capturedOutput);
		} catch (error) {
			groupDResult.code = 1;
			groupDResult.error ??= `Failed to replay captured output: ${error}; retained at ${groupDResult.capturedOutput.dir}`;
		}
	}

	const samplePath = defaultPerformanceReportPath(paths);
	mkdirSync(dirname(samplePath), { recursive: true });
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
	if (anyFailed) {
		console.error(`[e2e-v2] retained failure diagnostics: ${paths.root}`);
		process.exit(1);
	}
	if (!cleanup(paths.root)) {
		console.error(`[e2e-v2] could not remove successful run root: ${paths.root}`);
		process.exit(1);
	}
	process.exit(0);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
	main().catch((e) => {
		console.error("[e2e-v2] fatal:", e);
		process.exit(1);
	});
}
