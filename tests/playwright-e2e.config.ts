import path from "node:path";
import { defineConfig } from "@playwright/test";

const projectRoot = path.resolve(import.meta.dirname, "..");

/**
 * E2E config for tests that need a real LLM (session-rename, image-attachment,
 * compaction).
 *
 * Starts its own isolated gateway on port 3097 with BOBBIT_DIR set to
 * `.e2e-real-bobbit` so test state (sessions, goals, tokens) is fully separated
 * from the real dev-server's .bobbit/.
 *
 * The gateway must be built first: npm run build:server
 */

const E2E_REAL_BOBBIT_DIR = path.join(projectRoot, ".e2e-real-bobbit");

export default defineConfig({
	testDir: ".",
	testMatch: [
		"compaction.spec.ts",
	],
	timeout: 180_000,
	expect: { timeout: 30_000 },
	retries: 0,
	workers: 1, // serial — tests share the gateway
	use: {
		baseURL: "http://localhost:5174",
		headless: true,
		viewport: { width: 1280, height: 800 },
		actionTimeout: 15_000,
	},
	webServer: [
		{
			// Gateway on port 3097, isolated PI dir, no embedded UI
			command: "node dist/server/cli.js --host localhost --port 3097 --cwd . --no-ui",
			cwd: projectRoot,
			port: 3097,
			reuseExistingServer: false,
			timeout: 30_000,
			env: {
				...process.env,
				VITE_HOST: "localhost",
				BOBBIT_DIR: E2E_REAL_BOBBIT_DIR,
			},
		},
		{
			// Vite dev server on port 5174, proxying to the isolated gateway
			command: "npx vite --port 5174 --host localhost",
			cwd: projectRoot,
			port: 5174,
			reuseExistingServer: true,
			timeout: 15_000,
			env: {
				...process.env,
				VITE_HOST: "localhost",
				GATEWAY_URL: "http://localhost:3097",
			},
		},
	],
});
