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
import { defineConfig } from "@playwright/test";

// Tier 2.5 video reporter — opt-in via RECORDSCREEN=1. When unset, the
// reporter file is never loaded → zero overhead. See docs/testing-tier-2-5.md.
const recordScreenReporters: Array<[string]> = process.env.RECORDSCREEN === "1"
	? [["./tests/e2e/report/tier-2-5-reporter.ts"]]
	: [];

// Retries policy: 1 retry. Previously 3 — with ~1200 tests and a 900s
// wall-clock verification gate cap, each retry on a real failure cost up
// to 4× test duration; even a small persistent flake cluster could push
// the suite past the gate (the locally-observed 1050/1234 in ~17min that
// motivated this change). With retries=1 a single transient flake is still
// absorbed (the original reason for >0), but the worst-case multiplier is
// halved. Tighten to 0 once the flake floor is fully fixed.
export default defineConfig({
	timeout: 30_000,
	retries: 1,
	fullyParallel: true,
	// Top-level cap. Playwright treats this as the max parallelism across
	// all projects. Per-project `workers` fields below further constrain
	// individual projects — the browser project needs fewer workers than
	// the API project because each Chromium instance is CPU-heavy.
	//
	// Lowered from 6 to 4: empirically, 6 workers triggered FS-contention
	// flakes (POST /api/sessions → 500 under worktree setup races) without
	// providing a meaningful wall-clock win once browser project is capped
	// at 3 anyway. Per-project caps (api=4, browser=3) still apply, so the
	// FS-contention regime is not re-entered; the top-level cap of 5 only
	// matters at the project boundary where api and browser briefly
	// interleave during teardown/spinup of the next project.
	workers: 5,
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
				// Docker-dependent tests — run via test:manual instead
				"**/sandbox-recovery-docker*",
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
			testIgnore: [
				// Docker-dependent tests — run via test:manual instead
				"**/sandbox-recovery-docker*",
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
});
