/**
 * E2E test config: each worker spawns its own isolated gateway.
 *
 * Workers run in parallel, each with a dedicated gateway instance (unique
 * port, unique BOBBIT_DIR, mock agent). This provides full isolation —
 * tests never interfere with each other or the real app.
 *
 * Prerequisites: `npm run build` (both server and UI).
 */
import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./tests/e2e",
	testIgnore: [
		"**/session-rename*",      // needs real LLM for title generation
		"**/image-attachment*",    // needs real LLM vision
		"**/compaction*",          // needs mock agent compaction support
		"**/delegate-reconnect*",  // needs mock agent delegate support
		"**/delegate-ui*",         // needs mock agent delegate support
		"**/team-lifecycle*",      // needs real agent processes
	],
	timeout: 30_000,
	workers: 4,
	// No webServer — each worker spawns its own via gateway-harness.ts
	globalTeardown: "./tests/e2e/e2e-teardown.ts",
});
