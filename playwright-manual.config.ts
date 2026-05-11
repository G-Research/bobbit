/**
 * Manual integration test config.
 *
 * These tests use real agents (not mocks) and real Docker containers.
 * They are NOT included in `npm test`, `npm run test:unit`, or `npm run test:e2e`.
 *
 * Run:  npm run test:manual
 */
import { defineConfig } from "@playwright/test";

// Opt-in per-test video capture. Tier-2.5-style — always-off by default,
// enable with RECORDVIDEO=1 to get a webm per test under test-results/.
// The Tier 2.5 reporter (`./tests/e2e/report/tier-2-5-reporter.ts`) is not
// used here — manual specs talk to real agents, not the mock-agent contract
// the reporter assumes; Playwright's built-in recorder is sufficient.
const WANT_VIDEO = !!process.env.RECORDVIDEO;

export default defineConfig({
	timeout: 300_000,     // 5 minutes per test — real LLM calls are slow
	retries: 0,           // no retries — manual tests should be deterministic
	workers: 1,           // serial — one gateway at a time
	use: {
		headless: true,
		screenshot: "off",    // we capture manually
		video: WANT_VIDEO ? { mode: "on", size: { width: 1280, height: 720 } } : "off",
		trace: WANT_VIDEO ? "on" : "off",
	},
	projects: [
		{
			name: "manual-integration",
			testDir: "./tests/manual-integration",
		},
		{
			name: "docker-e2e",
			testDir: "./tests/e2e",
			testMatch: [
				"**/sandbox-recovery-docker*.spec.ts",
			],
		},
	],
});
