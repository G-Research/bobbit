/**
 * Standard E2E config: API-only, in-process, designed for gate verification.
 *
 * Runs during implementation gate verification. Designed so 6+ verifications
 * can run concurrently without resource contention:
 *   - In-process gateway only (no spawned processes, no browsers)
 *   - 2 workers per run → 6 verifications = 12 lightweight Node workers
 *   - Excludes slow verification-lifecycle tests (those run in full suite)
 *   - Target: ≤90s wall time
 *
 * Browser E2E and slow integration tests run in the full suite at
 * ready-to-merge (1-2 concurrent max).
 */
import { defineConfig } from "@playwright/test";

export default defineConfig({
	timeout: 15_000,
	retries: 1,
	fullyParallel: true,
	globalSetup: "./tests/e2e/e2e-global-setup.ts",
	globalTeardown: "./tests/e2e/e2e-teardown.ts",
	projects: [
		{
			name: "api",
			testDir: "./tests/e2e",
			testIgnore: [
				// Browser tests — only in full suite
				"**/ui/**",
				"**/session-lifecycle-ui*",
				"**/mcp-tool-permission*",
				"**/mcp-integration*",
				"**/per-project-config-dirs*",
				"**/port-auto-increment*",
				"**/localhost-auth*",
				// Docker-dependent
				"**/sandbox-recovery-docker*",
				// Slow verification-lifecycle tests (>10s each) — full suite only
				"**/verification-core*",
				"**/gates-api-heavy*",
				"**/gate-resign-cancel*",
				// Slow integration tests — full suite only
				"**/tools-e2e*",
				"**/queue-e2e*",
				"**/staff*",
				"**/review-annotations-api*",
				"**/project-isolation*",
				"**/sandbox-delegate*",
			],
			workers: 2,
		},
	],
});
