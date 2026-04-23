/**
 * Profiling-only Playwright config.
 *
 * Used by the overnight perf-improvement loop to generate per-test trace
 * artefacts for the slowest tests. Does NOT run the full suite — pair with
 * --grep or a specific testfile.
 *
 * Design goals:
 * - Single worker per project so traces aren't noisy with cross-test contention.
 * - Traces ON, recording every action + API + network activity.
 * - No retries — we want to see the actual slow path, not a successful retry.
 * - Output traces and test-results under reports/profiles/.
 */
import { defineConfig } from "@playwright/test";

export default defineConfig({
	timeout: 60_000,
	retries: 0,
	fullyParallel: false,
	workers: 1,
	globalSetup: "./tests/e2e/e2e-global-setup.ts",
	globalTeardown: "./tests/e2e/e2e-teardown.ts",
	outputDir: "reports/profiles/test-results",
	reporter: [
		["list"],
		["json", { outputFile: "reports/profiles/report.json" }],
	],
	use: {
		video: "off",
		screenshot: "off",
		trace: "on", // Full trace — viewable via `npx playwright show-trace <zip>`
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
			testIgnore: ["**/ui/**", "**/sandbox-recovery-docker*"],
		},
		{
			name: "browser",
			testDir: "./tests/e2e",
			testMatch: ["**/ui/*.spec.ts"],
		},
	],
});
