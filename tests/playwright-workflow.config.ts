import { defineConfig } from "@playwright/test";

/**
 * ⚠️  MANUAL TESTING ONLY — DO NOT use in CI or automated test runs.
 *
 * This config connects to an already-running dev server (started via
 * `npm run dev:harness`). It has NO webServer isolation — it talks to
 * whatever is running on the configured URLs, using the real ~/.pi
 * token and state directory.
 *
 * For automated / CI testing, use playwright-e2e.config.ts instead,
 * which spins up an isolated sandboxed gateway on port 3099 with
 * BOBBIT_DIR set to .e2e-bobbit/.
 *
 * Usage:
 *   1. Start the dev server:  npm run dev:harness
 *   2. Set env vars if needed:
 *        FRONTEND_URL  (default: https://localhost:5173)
 *        GATEWAY_URL   (default: https://localhost:3001)
 *   3. Run:  npx playwright test --config tests/playwright-workflow.config.ts
 */
export default defineConfig({
	testDir: ".",
	testMatch: ["workflow-status.spec.ts", "delegate-ui.spec.ts", "delegate-reconnect.spec.ts"],
	timeout: 120_000,
	expect: { timeout: 15_000 },
	retries: 0,
	workers: 1,
	use: {
		baseURL: process.env.FRONTEND_URL || "https://localhost:5173",
		headless: true,
		viewport: { width: 1280, height: 800 },
		actionTimeout: 15_000,
		ignoreHTTPSErrors: true,
	},
	// No webServer — uses the already-running dev:harness servers
});
