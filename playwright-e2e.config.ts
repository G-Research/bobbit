/**
 * E2E test config: each worker spawns its own isolated gateway.
 *
 * Workers run in parallel, each with a dedicated gateway instance (unique
 * port, unique BOBBIT_DIR, mock agent). This provides full isolation —
 * tests never interfere with each other or the real app.
 *
 * Global setup ensures both server and UI are built (builds only what's missing).
 */
import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./tests/e2e",
	testIgnore: [],
	timeout: 30_000,
	workers: 4,
	// No webServer — each worker spawns its own via gateway-harness.ts
	globalSetup: "./tests/e2e/e2e-global-setup.ts",
	globalTeardown: "./tests/e2e/e2e-teardown.ts",
});
