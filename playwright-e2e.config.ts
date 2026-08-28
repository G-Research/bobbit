import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { captureMachineGlobalLedgerDirectory } from "./scripts/run-playwright-e2e.mjs";
import { createE2EPhaseSelection } from "./scripts/test-phase-config.mjs";
import { capturePlaywrightBrowserRegistry, getRunRoot, installRunIsolation, isOwnedRunPath } from "./tests2/harness/run-isolation.js";

const phaseSelection = createE2EPhaseSelection();

export function resolveE2EOutputDir(runRoot = getRunRoot()): string {
	return join(runRoot, "playwright-e2e-results");
}

// Config evaluation precedes isolated E2E worker imports. Preserve host-only
// runtime inputs before the harness redirects HOME and TMPDIR for Bobbit discovery.
process.env.BOBBIT_V2_LEDGER_DIR = captureMachineGlobalLedgerDirectory();
capturePlaywrightBrowserRegistry();
// Direct Playwright invocations do not pass through the E2E coordinator.
// Apply the same ambient-runtime scrub before workers import test harnesses.
installRunIsolation();

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
	const runRoot = getRunRoot();
	const ownedCacheRoot = join(runRoot, "pwtest-transform-cache");
	// The legacy Docker sandbox namespace is owned by this coordinator's root,
	// never an inherited value from a concurrent host run.
	process.env.BOBBIT_E2E_RUN_ID = basename(runRoot);
	process.env.BOBBIT_E2E_TMP_ROOT = join(runRoot, "tmp", "bobbit-e2e");
	if (!process.env.PWTEST_CACHE_DIR || !isOwnedRunPath(process.env.PWTEST_CACHE_DIR))
		process.env.PWTEST_CACHE_DIR = ownedCacheRoot;
	if (!process.env.BOBBIT_E2E_PWTEST_RUN_CACHE_ROOT || !isOwnedRunPath(process.env.BOBBIT_E2E_PWTEST_RUN_CACHE_ROOT))
		process.env.BOBBIT_E2E_PWTEST_RUN_CACHE_ROOT = process.env.PWTEST_CACHE_DIR;
	process.env.BOBBIT_E2E_PWTEST_CACHE_ROOT = process.env.BOBBIT_E2E_PWTEST_RUN_CACHE_ROOT;
	process.env.BOBBIT_E2E_PWTEST_CACHE_OWNED = "1";
	const transformCacheDir = process.env.PWTEST_CACHE_DIR!;
	const runCacheRoot = process.env.BOBBIT_E2E_PWTEST_RUN_CACHE_ROOT!;
	process.env.BOBBIT_E2E_PWTEST_CACHE_DIR = runCacheRoot;
	const secretsDir = process.env.BOBBIT_SECRETS_DIR ||= join(runRoot, "e2e-server-secrets");
	mkdirSync(runCacheRoot, { recursive: true });
	mkdirSync(transformCacheDir, { recursive: true });
	mkdirSync(process.env.BOBBIT_E2E_TMP_ROOT!, { recursive: true });
	mkdirSync(secretsDir, { recursive: true });
}

prepareE2ERuntimeCaches();

// Tier 2.5 video reporter — opt-in via RECORDSCREEN=1. When unset, the
// reporter file is never loaded → zero overhead. See docs/testing-tier-2-5.md.
const recordScreenReporters: Array<[string]> = process.env.RECORDSCREEN === "1"
	? [["./tests/e2e/report/tier-2-5-reporter.ts"]]
	: [];

// Workflow retries protect developer productivity after isolated transients.
// Retry-free qualification sets BOBBIT_V2_RETRY_FREE=1 and remains the only
// evidence of first-attempt stability.
export default {
	timeout: 30_000,
	retries: process.env.BOBBIT_V2_RETRY_FREE === "1" ? 0 : 3,
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
	// Playwright otherwise writes test-results/.last-run.json in the checkout,
	// allowing simultaneous coordinators to overwrite one another's artifacts.
	outputDir: resolveE2EOutputDir(),
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
			...phaseSelection.api,
			// In-process API workers still boot a full gateway and shell out to git in
			// several specs. On Windows, 4 concurrent gateways under verification load
			// produced fixture setup retries and 900s broad-suite timeouts; 2 preserves
			// parallelism while avoiding the hot contention cluster.
			workers: 2,
		},
		{
			...phaseSelection.apiCanonical,
			workers: 2,
		},
		{
			...phaseSelection.browserCanonical,
			workers: 3,
			fullyParallel: false,
		},
		{
			// Real-push variant of the in-process harness — isolated project so it
			// doesn't share env (BOBBIT_TEST_NO_PUSH) with the main API project.
			// See tests/e2e/in-process-harness-realpush.ts.
			...phaseSelection.apiRealpush,
			workers: 1,
			fullyParallel: false,
		},
		{
			...phaseSelection.browser,
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
