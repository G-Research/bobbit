/**
 * Manual integration test config.
 *
 * These tests use real agents (not mocks) and real Docker containers.
 * They are NOT included in `npm test`, `npm run test:unit`, or `npm run test:e2e`.
 *
 * Run:  npm run test:manual
 */
import { defineConfig } from "@playwright/test";

export default defineConfig({
	timeout: 300_000,     // 5 minutes per test — real LLM calls are slow
	retries: 0,           // no retries — manual tests should be deterministic
	workers: 1,           // serial — one gateway at a time
	projects: [
		{
			name: "manual-integration",
			testDir: "./tests/manual-integration",
		},
	],
});
