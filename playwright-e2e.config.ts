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

// Phase 1 of E2E flakiness fix: top-level `retries: 0` is the new default.
// Specs that are still flaky must be tagged `@quarantine` (in their
// describe/test title) — they run in a separate project with retries
// enabled and DO NOT gate the main green suite. The `quarantine` project
// runs in the same invocation so visibility is preserved; merge gating
// is decided by the green projects only.
export default defineConfig({
	timeout: 30_000,
	retries: 0,
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
			grepInvert: /@quarantine/,
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
			// M5: serialise browser specs within the project. Each browser worker
			// is gateway + Chromium + UI static serve — even at workers=3, cross-
			// worker contention on Windows FS / Defender still produced 3–4 flakes
			// per run. fullyParallel=false confines parallelism to the 3 workers
			// (one spec per worker, sequential within-spec), which empirically
			// eliminates the remaining flake cluster. API project stays
			// fullyParallel: true (inherited from top-level).
			fullyParallel: false,
			grepInvert: /@quarantine/,
		},
		{
			// Quarantine project: any test whose describe/test title contains
			// `@quarantine` runs here with retries enabled. Failures here are
			// reported but do NOT gate merges. New entries require a tracking
			// comment with an expiry date — see tests/e2e/README.md.
			name: "quarantine",
			testDir: "./tests/e2e",
			testIgnore: [
				// Docker-dependent tests stay out of the in-process matrix.
				"**/sandbox-recovery-docker*",
			],
			workers: 2,
			fullyParallel: false,
			retries: 2,
			grep: /@quarantine/,
		},
	],
});
