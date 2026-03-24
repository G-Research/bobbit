/**
 * Playwright E2E config with c8 code coverage collection.
 *
 * Identical to playwright-e2e.config.ts except the webServer command is
 * wrapped with c8 so V8 coverage is collected from the gateway process.
 *
 * Usage: npm run test:coverage
 */
import { defineConfig } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const RUN_ID = process.env._E2E_RUN_ID ??= crypto.randomBytes(4).toString('hex');
const E2E_PORT = 3100 + (parseInt(RUN_ID, 16) % 900);
const E2E_BOBBIT_DIR = path.join(__dirname, `.e2e-bobbit-${RUN_ID}`);

const MOCK_AGENT = path.join(__dirname, 'tests/e2e/mock-agent.mjs');

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
		'**/delegate-ui*',
		'**/goals*',
		'**/team-lifecycle*',
		'**/real-app-mobile*',
	],
	timeout: 45_000, // slightly higher — c8 adds overhead
	workers: 1,
	webServer: {
		command: `npx c8 --reporter=html --reporter=lcov --reports-dir=coverage --src=src/server node dist/server/cli.js --host 127.0.0.1 --port ${E2E_PORT} --no-tls --no-ui --agent-cli ${MOCK_AGENT}`,
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
		},
	},
	globalTeardown: './tests/e2e/e2e-teardown.ts',
	use: { baseURL: `http://127.0.0.1:${E2E_PORT}` },
});
