import { defineConfig } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Each test run gets a unique port (3100–3999) and state directory so
// parallel invocations never collide on the same machine.
//
// The config is evaluated in both the main coordinator process AND each
// worker process. We pin the run ID in an env var on first evaluation so
// all processes in the same run agree on the same port and PI dir.
const RUN_ID = process.env._E2E_RUN_ID ??= crypto.randomBytes(4).toString('hex');
const E2E_PORT = 3100 + (parseInt(RUN_ID, 16) % 900);
const E2E_BOBBIT_DIR = path.join(__dirname, `.e2e-bobbit-${RUN_ID}`);

// Mock agent: lightweight JSONL stub that replaces pi-coding-agent in tests.
// Responds instantly with deterministic tool calls — no API key needed.
const MOCK_AGENT = path.join(__dirname, 'tests/e2e/mock-agent.mjs');

// Expose to e2e-setup.ts (loaded by test files in the same worker process).
process.env.E2E_PORT = String(E2E_PORT);
process.env.BOBBIT_DIR = E2E_BOBBIT_DIR;

export default defineConfig({
	testDir: './tests/e2e',
	testIgnore: [
		'**/mobile-header-race-e2e*',
		'**/session-rename*',
		'**/image-attachment*',
		'**/compaction*',
		'**/delegate-reconnect*',
		'**/delegate-ui*',       // reads .pi/extensions/ source files; needs workflow config
		'**/goals*',             // UI tests need Vite frontend (server runs --no-ui)
		'**/team-lifecycle*',    // spawns real agents; needs long timeouts + real config
		'**/real-app-mobile*',   // needs Vite UI (server runs --no-ui)
	],
	timeout: 30_000,
	workers: 1, // serial — all tests share a single gateway instance
	webServer: {
		command: `node dist/server/cli.js --host 127.0.0.1 --port ${E2E_PORT} --no-tls --no-ui --auth --agent-cli ${MOCK_AGENT}`,
		url: `http://127.0.0.1:${E2E_PORT}/api/sessions`,
		reuseExistingServer: false,
		timeout: 30_000,
		stdout: 'ignore',
		stderr: 'pipe',
		env: {
			...process.env,
			BOBBIT_DIR: E2E_BOBBIT_DIR,
			BOBBIT_LLM_REVIEW_SKIP: "1",
			BOBBIT_SKIP_NPM_CI: "1",
			BOBBIT_SKIP_MCP: "1",
		},
	},
	globalTeardown: './tests/e2e/e2e-teardown.ts',
	use: { baseURL: `http://127.0.0.1:${E2E_PORT}` },
});
