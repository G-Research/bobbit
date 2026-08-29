#!/usr/bin/env node
/**
 * run-e2e-v2.mjs — the v2 "e2e" real-fidelity tier (task 7862db76).
 *
 * This is the per-workflow real-fidelity remainder that stays out of tier-1/2
 * (`test:v2`): the convention-owned real-fidelity specs discovered from their
 * paths and semantic filename suffixes, MINUS
 *   - manual-integration specs (real-agent / real-LLM / real-Docker — that
 *     is the tier-3 `test:manual` lane, never here).
 *
 * Everything in the E2E tier normally runs at retries:3 for developer workflow
 * resilience. Set BOBBIT_V2_RETRY_FREE=1 to qualify Groups B/C/D with retries
 * disabled; Group A completes through its owning fixture teardowns and has no
 * retry knob wired here. The groups come from shared filesystem discovery:
 *
 *   Group A — node real-fidelity specs (top-level tests/*.e2e.test.ts): real git
 *             worktree / sweeper / sandbox-mount / spawn-tree fidelity. Run via
 *             `tsx --test`.
 *   Group B — API/process Playwright E2E specs, including canonical api-e2e.
 *             Run via the legacy playwright-e2e config at retries:3 (or 0 when qualifying).
 *   Group C — real-browser fidelity: transitional tests2/browser/e2e specs use
 *             playwright-v2 project `browser-v2-e2e`; canonical browser-e2e specs
 *             use playwright-e2e project `browser-canonical`.
 *   Group D — Vitest real-fidelity suites explicitly classified `vitest-e2e`;
 *             run in the isolated `v2-e2e-vitest` project.
 *
 * External-service-free guarantee: every group runs with BOBBIT_TEST_NO_EXTERNAL
 * / BOBBIT_TEST_NO_REMOTE set (fail-closed on non-loopback fetch + no real git
 * remote / gh), and uses the in-process mock agent bridge. Docker specs are
 * detected and, if the daemon or local sandbox image is unavailable, reported
 * (never silently dropped).
 *
 * CPU is sampled over this process' subtree (createCpuSampler), matching the
 * head-to-head methodology, and reported per group + total.
 *
 * Usage:
 *   node scripts/testing-v2/run-e2e-v2.mjs [--group A|B|C|D] [--list] [--json <path>]
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { createCpuSampler } from "./assert-budget.mjs";
import { coordinatorTempDirectory, createE2ERunPaths, createIsolatedE2EEnvironment } from "../run-playwright-e2e.mjs";
import { copyEnvironment, deleteEnvironmentValue } from "./environment-policy.mjs";
import { discoverTests } from "./test-discovery.mjs";

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

/** Discover convention-owned E2E groups while retaining the list/report shape. */
function classifyE2E() {
	const discovery = discoverTests();
	const { A, B, C, D } = discovery.e2eGroups;
	return {
		A,
		B,
		C,
		D,
		excluded: { manualIntegration: discovery.manual, missing: [] },
	};
}

const SANDBOX_IMAGE = "bobbit-agent";

function probeDocker(args, timeoutMs) {
	try {
		execFileSync("docker", args, { stdio: "ignore", timeout: timeoutMs });
		return true;
	} catch {
		return false;
	}
}

/** Classify the exact local capability required by image-backed sandbox tests. */
export function detectDockerSandboxCapability(probe = probeDocker) {
	if (!probe(["info"], 5_000)) return "daemon-unavailable";
	if (!probe(["image", "inspect", SANDBOX_IMAGE], 10_000)) return "image-unavailable";
	return "available";
}

/** Specs whose Docker-backed cases require the local sandbox image. */
const DOCKER_GATED = ["tests/e2e/sandbox-recovery.e2e.spec.ts"];
const TSX_CLI = join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const PLAYWRIGHT_CLI = join(REPO_ROOT, "node_modules", "playwright", "cli.js");
const PLAYWRIGHT_E2E_WRAPPER = join(REPO_ROOT, "scripts", "run-playwright-e2e.mjs");

function localNodeInvocation(entryPoint, args, dependency, {
	exists = existsSync,
	execPath = process.execPath,
} = {}) {
	if (!exists(entryPoint)) {
		throw new Error(`[e2e-v2] ${dependency} is unavailable at ${entryPoint}. Install local dependencies with npm ci.`);
	}
	return Object.freeze({ command: execPath, args: Object.freeze([entryPoint, ...args]), shell: false });
}

/** Build Group A's shell-free local tsx invocation. */
export function createGroupAInvocation(specs, {
	nodeConcurrency = "2",
	tsxCli = TSX_CLI,
	exists,
	execPath,
} = {}) {
	return localNodeInvocation(tsxCli, ["--test", `--test-concurrency=${nodeConcurrency}`, ...specs], "tsx CLI", { exists, execPath });
}

/** Build Group B's shell-free invocation of the cache-isolating Playwright wrapper. */
export function createGroupBInvocation(specs, {
	workers = 2,
	retries = 3,
	wrapper = PLAYWRIGHT_E2E_WRAPPER,
	exists,
	execPath,
} = {}) {
	return localNodeInvocation(wrapper, [...specs, `--workers=${workers}`, `--retries=${retries}`], "Playwright E2E wrapper", { exists, execPath });
}

/** Build transitional Group C's shell-free local Playwright invocation. */
export function createTransitionalGroupCInvocation({
	workers = 2,
	retryFree = false,
	playwrightCli = PLAYWRIGHT_CLI,
	exists,
	execPath,
} = {}) {
	return localNodeInvocation(playwrightCli, [
		"test", "--config", "playwright-v2.config.ts", "--project", "browser-v2-e2e",
		`--workers=${workers}`, ...(retryFree ? ["--retries=0"] : []),
	], "Playwright CLI", { exists, execPath });
}

/** Build canonical Group C's shell-free wrapper invocation. */
export function createCanonicalGroupCInvocation(specs, {
	workers = 2,
	retryFree = false,
	wrapper = PLAYWRIGHT_E2E_WRAPPER,
	exists,
	execPath,
} = {}) {
	return localNodeInvocation(wrapper, [
		...specs, "--project=browser-canonical", `--workers=${workers}`,
		...(retryFree ? ["--retries=0"] : []),
	], "Playwright E2E wrapper", { exists, execPath });
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

function run(command, args, { env = {}, label } = {}) {
	const startWall = performance.now();
	return new Promise((resolveRun) => {
		const child = spawn(command, args, {
			cwd: REPO_ROOT,
			// `env` is already built from the coordinator's sanitized environment.
			// Re-merging process.env here would restore deleted credentials/cache roots.
			env: composeE2EChildEnvironment(env),
			stdio: "inherit",
			// Discovered paths are always argv data, never shell program text.
			shell: false,
		});

		let settled = false;
		const finishRun = (result) => {
			if (settled) return;
			settled = true;
			resolveRun({
				...result,
				label,
				wallMs: Math.round(performance.now() - startWall),
			});
		};
		child.on("close", (code, signal) => {
			finishRun({ code: code ?? (signal ? 1 : 0), signal });
		});
		child.on("error", (error) => {
			finishRun({ code: 1, error: String(error) });
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
//
// Git isolation is deliberately NOT repeated here: every group's environment
// descends from createIsolatedE2EEnvironment(), which sets GIT_CONFIG_NOSYSTEM
// (see GIT_ISOLATION_ENV in environment-policy.mjs) alongside the redirected
// HOME. One owner, so the two tiers cannot drift apart.
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
	const invocation = createGroupAInvocation(specs, { nodeConcurrency: nodeConc });
	return run(invocation.command, invocation.args, {
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
	const invocation = createGroupBInvocation(specs, { workers: pwWorkers, retries });
	return run(invocation.command, invocation.args, {
		env: composeE2EChildEnvironment(nestedEnv, EXTERNAL_FREE_ENV),
		label: "B/e2e-relocate",
	});
}

async function runGroupC(specs, coordinatorEnv) {
	if (specs.length === 0) return { label: "C/browser", code: 0, wallMs: 0, skipped: true };
	const transitionalSpecs = specs.filter((spec) => spec.startsWith("tests2/browser/e2e/"));
	const canonicalSpecs = specs.filter((spec) => spec.startsWith("tests/e2e/browser/"));
	if (transitionalSpecs.length + canonicalSpecs.length !== specs.length) {
		return { label: "C/browser-fidelity", code: 1, wallMs: 0, error: "Group C contains a path outside its browser E2E conventions" };
	}

	const pwWorkersC = resolveE2ePlaywrightWorkers();
	const retryArgs = isRetryFreeQualification(coordinatorEnv) ? ["--retries=0"] : [];
	let wallMs = 0;

	if (transitionalSpecs.length > 0) {
		// Keep the transitional project invocation whole: Playwright's variadic
		// --project option would otherwise consume positional file filters.
		const invocation = createTransitionalGroupCInvocation({
			workers: pwWorkersC,
			retryFree: retryArgs.length > 0,
		});
		const transitional = await run(invocation.command, invocation.args, {
			env: composeE2EChildEnvironment(coordinatorEnv, EXTERNAL_FREE_ENV),
			label: "C/adapter-browser",
		});
		wallMs += transitional.wallMs;
		if (transitional.code !== 0) return { ...transitional, wallMs };
	}

	if (canonicalSpecs.length > 0) {
		const nestedEnv = createNestedE2EEnvironment(coordinatorEnv);
		const invocation = createCanonicalGroupCInvocation(canonicalSpecs, {
			workers: pwWorkersC,
			retryFree: retryArgs.length > 0,
		});
		const canonical = await run(invocation.command, invocation.args, {
			env: composeE2EChildEnvironment(nestedEnv, EXTERNAL_FREE_ENV),
			label: "C/canonical-browser",
		});
		wallMs += canonical.wallMs;
		if (canonical.code !== 0) return { ...canonical, wallMs };
	}

	return { label: "C/browser-fidelity", code: 0, wallMs };
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

async function runGroupD(specs, { coordinatorEnv } = {}) {
	if (specs.length === 0) return { label: "D/vitest", code: 0, wallMs: 0, skipped: true };
	const vitestCli = join(REPO_ROOT, "node_modules", "vitest", "vitest.mjs");
	return run(process.execPath, [vitestCli, ...groupDVitestArgs(coordinatorEnv)], {
		env: composeE2EChildEnvironment(coordinatorEnv, {
			...EXTERNAL_FREE_ENV,
			BOBBIT_V2_E2E_VITEST: "1",
			VITEST_MAX_WORKERS: "1",
		}),
		label: "D/vitest-real-fidelity",
	});
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const { A, B, C, D, excluded } = classifyE2E();

	if (args.list) {
		console.log(JSON.stringify({ A, B, C, D, excluded }, null, 2));
		return;
	}

	console.log(`[e2e-v2] e2e:v2 real-fidelity tier — A(node)=${A.length} B(e2e)=${B.length} C(browser)=${C.length} D(vitest)=${D.length}`);
	console.log(`[e2e-v2] excluded: manual-integration=${excluded.manualIntegration.length}${excluded.missing.length ? `, MISSING=${excluded.missing.length} (${excluded.missing.join(", ")})` : ""}`);

	const dockerCapability = detectDockerSandboxCapability();
	const docker = dockerCapability === "available";
	const dockerGatedPresent = DOCKER_GATED.filter((f) => B.includes(f));
	if (dockerGatedPresent.length) {
		const unavailableReason = dockerCapability === "daemon-unavailable"
			? "daemon unreachable"
			: "bobbit-agent image missing";
		console.log(`[e2e-v2] Docker sandbox ${docker ? "AVAILABLE" : `UNAVAILABLE (${unavailableReason})`} — image-backed specs: ${dockerGatedPresent.join(", ")}${docker ? "" : " (Docker paths will self-skip; non-Docker paths still run)"}`);
	}

	const paths = createE2ERunPaths(coordinatorTempDirectory());
	const coordinatorEnv = createE2EV2CoordinatorEnvironment(paths);
	const sampler = createCpuSampler(process.pid, { intervalMs: 1000 });
	const startWall = performance.now();

	const only = args.group;
	const results = [];
	if (only) {
		// Focused group runs retain their existing single-group behavior.
		if (only === "A") results.push(await runGroupA(A, coordinatorEnv));
		if (only === "B") results.push(await runGroupB(B, coordinatorEnv));
		if (only === "C") results.push(await runGroupC(C, coordinatorEnv));
		if (only === "D") results.push(await runGroupD(D, { coordinatorEnv }));
	} else {
		// Hosted runners cannot reliably absorb a second process-heavy coordinator
		// alongside the gateway/worktree/browser phases. Preserve each group's own
		// retries and worker controls, but do not overlap their process trees.
		console.log("[e2e-v2] schedule: A → B → C → D (serialized)");
		results.push(await runGroupA(A, coordinatorEnv));
		results.push(await runGroupB(B, coordinatorEnv));
		results.push(await runGroupC(C, coordinatorEnv));
		results.push(await runGroupD(D, { coordinatorEnv }));
	}

	const sample = sampler.stop();
	const wallMs = Math.round(performance.now() - startWall);

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
		dockerCapability,
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
