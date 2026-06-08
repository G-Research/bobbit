import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * E2E test config: split into API (in-process) and browser (process-spawned) projects.
 *
 * API tests use in-process-harness.ts — the gateway runs in the same Node
 * process, eliminating ~5-8s of process spawn overhead per worker.
 *
 * Browser tests use gateway-harness.ts — they need a real spawned process
 * to serve static UI files and test process-level behaviors.
 *
 * Global setup ensures both server and UI are built (builds only what's missing).
 */
function e2eTempRoot(): string {
	if (existsSync("/.dockerenv")) return "/tmp";
	return process.platform === "win32"
		? (process.env.BOBBIT_E2E_TMP_ROOT || "C:\\bobbit-e2e")
		: join(tmpdir(), "bobbit-e2e");
}

function sanitizeCacheSegment(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80) || "run";
}

function e2ePwtestCacheBaseRoot(): string {
	// Canonical external override. BOBBIT_PWTEST_CACHE_ROOT is a legacy alias
	// accepted for older local wrappers.
	return process.env.BOBBIT_E2E_PWTEST_CACHE_ROOT?.trim()
		|| process.env.BOBBIT_PWTEST_CACHE_ROOT?.trim()
		|| e2eTempRoot();
}

function prepareE2ERuntimeCaches(): void {
	// Must run in the Playwright config process before test workers spawn.
	// A host-level NODE_COMPILE_CACHE caused false ESM "missing export" errors
	// when multiple Windows workers cold-imported dist/server concurrently.
	process.env.NODE_DISABLE_COMPILE_CACHE = "1";
	delete process.env.NODE_COMPILE_CACHE;

	// npm run test:e2e launches through scripts/run-playwright-e2e.mjs, which
	// sets PWTEST_CACHE_DIR before Playwright imports its transform cache. This
	// fallback protects direct `npx playwright ... --config playwright-e2e.config.ts`
	// runs before worker startup, even though the runner process may already have
	// loaded Playwright's default transform-cache module while loading this config.
	if (!process.env.PWTEST_CACHE_DIR) {
		const runId = sanitizeCacheSegment(
			process.env.BOBBIT_E2E_RUN_ID?.trim()
				|| `direct-${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`,
		);
		const runCacheRoot = join(resolve(e2ePwtestCacheBaseRoot()), "pwtest-transform-cache", runId);
		process.env.BOBBIT_E2E_PWTEST_RUN_CACHE_ROOT = runCacheRoot;
		process.env.PWTEST_CACHE_DIR = runCacheRoot;
		process.env.BOBBIT_E2E_PWTEST_CACHE_OWNED = "1";
	}
	const transformCacheDir = process.env.PWTEST_CACHE_DIR!;
	const runCacheRoot = process.env.BOBBIT_E2E_PWTEST_RUN_CACHE_ROOT?.trim() || transformCacheDir;
	process.env.BOBBIT_E2E_PWTEST_CACHE_DIR = runCacheRoot;
	mkdirSync(runCacheRoot, { recursive: true });
	mkdirSync(transformCacheDir, { recursive: true });
}

prepareE2ERuntimeCaches();

// Tier 2.5 video reporter — opt-in via RECORDSCREEN=1. When unset, the
// reporter file is never loaded → zero overhead. See docs/testing-tier-2-5.md.
const recordScreenReporters: Array<[string]> = process.env.RECORDSCREEN === "1"
	? [["./tests/e2e/report/tier-2-5-reporter.ts"]]
	: [];

// Retries policy: 3 everywhere for now. Real bugs fail all 4 attempts;
// flakes (Windows-FS races, goal-assistant cold-start timeouts) absorb
// the retry. Will tighten back to 0 once the flake floor is fully fixed.
export default {
	timeout: 30_000,
	retries: 3,
	fullyParallel: true,
	// Top-level cap. Playwright treats this as the max parallelism across
	// all projects. Per-project `workers` fields below further constrain
	// individual projects — the browser project needs fewer workers than
	// the API project because each Chromium instance is CPU-heavy.
	//
	// Lowered from 6 to 4: empirically, 6 workers triggered FS-contention
	// flakes (POST /api/sessions → 500 under worktree setup races) without
	// providing a meaningful wall-clock win once browser project is capped
	// at 3 anyway.
	workers: 4,
	// `line` reporter streams one line per test completion to stdout, with
	// no batching — unlike `list` which redraws in place and buffers heavily
	// when stdout is not a TTY (the verification-harness tailer sees nothing
	// for the full ~5 min run). `line` works correctly under file/pipe stdio.
	reporter: [
		[process.stdout.isTTY ? "list" : "line"],
		...recordScreenReporters,
	],
	globalSetup: "./tests/e2e/e2e-global-setup.ts",
	globalTeardown: "./tests/e2e/e2e-teardown.ts",
	// Default artifact / launch settings. Chromium's GPU process, prerenderer,
	// background timers, and BFCache consume ~1 core per worker when idle.
	// Disabling them has no effect on test semantics for headless runs.
	use: {
		video: "off",
		trace: "off",
		screenshot: "off",
		launchOptions: {
			args: [
				"--disable-gpu",
				"--disable-dev-shm-usage",
				"--disable-background-timer-throttling",
				"--disable-renderer-backgrounding",
				"--disable-backgrounding-occluded-windows",
				"--disable-features=TranslateUI,BackForwardCache,CalculateNativeWinOcclusion",
			],
		},
	},
	projects: [
		{
			name: "api",
			testDir: "./tests/e2e",
			testIgnore: [
				"**/ui/**",
				"**/session-lifecycle-ui*",
				"**/mcp-tool-permission*",
				"**/mcp-integration*",
				"**/per-project-config-dirs*",
				"**/port-auto-increment*",
				// Owned by the api-realpush project (different env).
				"**/goal-archive-branch-cleanup*",
			],
			workers: 4,
		},
		{
			// Real-push variant of the in-process harness — isolated project so it
			// doesn't share env (BOBBIT_TEST_NO_PUSH) with the main API project.
			// See tests/e2e/in-process-harness-realpush.ts.
			name: "api-realpush",
			testDir: "./tests/e2e",
			testMatch: ["**/goal-archive-branch-cleanup.spec.ts"],
			workers: 1,
			fullyParallel: false,
		},
		{
			name: "browser",
			testDir: "./tests/e2e",
			testMatch: [
				"**/ui/*.spec.ts",
				"**/session-lifecycle-ui*.spec.ts",
				"**/mcp-tool-permission*.spec.ts",
				"**/mcp-integration*.spec.ts",
				"**/per-project-config-dirs*.spec.ts",
				"**/port-auto-increment*.spec.ts",
			],
			workers: 3,
			// Serialise browser specs within the project. Each browser worker
			// is gateway + Chromium + UI static serve — even at workers=3, cross-
			// worker contention on Windows FS / Defender still produced 3–4 flakes
			// per run. fullyParallel=false confines parallelism to the 3 workers
			// (one spec per worker, sequential within-spec), which empirically
			// eliminates a flake cluster. API project stays fullyParallel: true
			// (inherited from top-level).
			fullyParallel: false,
		},
	],
};
