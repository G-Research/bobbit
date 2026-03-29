/**
 * Full-stack E2E config: gateway + built UI + mock agent.
 *
 * Unlike playwright-e2e.config.ts (API-only, --no-ui), this serves
 * the real Vite-built frontend so tests can interact with the actual UI
 * in a Playwright browser context.
 *
 * Prerequisites: `npm run build` (both server and UI).
 *
 * Run:
 *   npm run build && npx playwright test --config playwright-fullstack.config.ts --reporter=json 2>/dev/null | node scripts/test-filter.mjs
 */
import { defineConfig } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Unique run ID so parallel invocations never collide.
const RUN_ID = (process.env._FS_RUN_ID ??= crypto.randomBytes(4).toString("hex"));
const PORT = 4100 + (parseInt(RUN_ID, 16) % 900);
const BOBBIT_DIR = path.join(__dirname, `.e2e-fullstack-${RUN_ID}`);
const MOCK_AGENT = path.join(__dirname, "tests/e2e/mock-agent.mjs");

// Expose to test helpers.
process.env.E2E_PORT = String(PORT);
process.env.BOBBIT_DIR = BOBBIT_DIR;

export default defineConfig({
	testDir: "./tests/fullstack",
	timeout: 60_000,
	workers: 1,
	webServer: {
		// Serve the real embedded UI (no --no-ui).
		command: `node dist/server/cli.js --host 127.0.0.1 --port ${PORT} --no-tls --auth --agent-cli ${MOCK_AGENT}`,
		url: `http://127.0.0.1:${PORT}/api/sessions`,
		reuseExistingServer: false,
		timeout: 30_000,
		stdout: "ignore",
		stderr: "pipe",
		env: {
			...process.env,
			BOBBIT_DIR,
			BOBBIT_LLM_REVIEW_SKIP: "1",
			BOBBIT_SKIP_NPM_CI: "1",
			BOBBIT_SKIP_MCP: "1",
			BOBBIT_NO_OPEN: "1",
		},
	},
	globalTeardown: "./tests/fullstack/fullstack-teardown.ts",
	use: {
		baseURL: `http://127.0.0.1:${PORT}`,
		trace: "retain-on-failure",
		screenshot: "only-on-failure",
	},
});
