/**
 * Playwright E2E config with V8 code coverage collection.
 *
 * Identical to playwright-e2e.config.ts except the webServer env includes
 * NODE_V8_COVERAGE so V8 natively writes coverage data on process exit.
 * After tests complete, run `c8 report` to process the raw data.
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
	timeout: 45_000,
	workers: 1,
	webServer: {
		command: `node dist/server/cli.js --host 127.0.0.1 --port ${E2E_PORT} --no-tls --no-ui --agent-cli ${MOCK_AGENT}`,
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
			NODE_V8_COVERAGE: path.join(__dirname, 'coverage', 'tmp'),
		},
	},
	globalTeardown: './tests/e2e/e2e-coverage-teardown.ts',
	use: { baseURL: `http://127.0.0.1:${E2E_PORT}` },
});
