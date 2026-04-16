/**
 * In-process gateway fixture for E2E API tests.
 *
 * Unlike gateway-harness.ts which spawns a child process, this fixture
 * imports the server directly and starts it in the same Node process.
 * This eliminates ~5-8s of process spawn + health-check overhead per worker.
 *
 * Each Playwright worker gets its own isolated gateway with:
 *   - A unique OS-assigned port (port 0)
 *   - A unique BOBBIT_DIR (ephemeral, cleaned up after)
 *   - The mock agent (no API key needed)
 *
 * The fixture sets process.env.E2E_PORT before any test files import
 * e2e-setup.ts, so helpers automatically target the right server.
 *
 * IMPORTANT: This fixture MUST remain worker-scoped (not test-scoped).
 * Node's module cache means server singletons (caches, stores, prompt dirs)
 * persist for the worker's lifetime. createGateway() creates fresh store
 * instances each call, but module-level state in server.ts is shared.
 * Making this test-scoped would cause silent cross-test contamination.
 */
import { test as base } from "@playwright/test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..", "..");
const MOCK_AGENT = resolve(__dirname, "mock-agent.mjs");

// Inside Docker containers, /workspace is a bind-mount with ~10-20x slower I/O
// (9P/gRPC layer on Docker Desktop). Put write-heavy temp dirs on the container's
// local overlay FS instead.  On the host, use os.tmpdir() to guarantee the CWD
// is outside the git repo — otherwise isGitRepo() returns true for the project
// rootPath and sessions auto-create worktrees (slow, conflicts with git state).
const E2E_TEMP_ROOT = existsSync("/.dockerenv") ? "/tmp" : join(tmpdir(), "bobbit-e2e");

export interface GatewayInfo {
	port: number;
	baseURL: string;
	wsBase: string;
	bobbitDir: string;
	sessionManager: any;  // Exposed for sandbox security tests
}

/**
 * Extended test fixture that provides a per-worker in-process gateway.
 *
 * Usage in test files:
 *   import { test, expect } from "./in-process-harness.js";
 *   // e2e-setup helpers automatically target this worker's gateway
 */
export const test = base.extend<{}, { gateway: GatewayInfo }>({
	gateway: [async ({}, use, workerInfo) => {
		mkdirSync(E2E_TEMP_ROOT, { recursive: true });
		const bobbitDir = join(E2E_TEMP_ROOT, `.e2e-inproc-${workerInfo.workerIndex}`);

		// Clean slate
		rmSync(bobbitDir, { recursive: true, force: true });
		mkdirSync(join(bobbitDir, "state"), { recursive: true });
		// Seed projects.json so ensureDefaultProject() fires (mirrors a non-fresh install)
		writeFileSync(join(bobbitDir, "state", "projects.json"), "[]");
		writeFileSync(join(bobbitDir, "state", "setup-complete"), "e2e\n");

		// Set BOBBIT_DIR env BEFORE importing server modules.
		// Playwright workers are separate Node processes, so module singletons
		// (bobbit-dir._projectRoot, caches) are per-worker — no cross-contamination.
		process.env.BOBBIT_DIR = bobbitDir;
		process.env.BOBBIT_SKIP_MCP = "1";
		process.env.BOBBIT_SKIP_NPM_CI = "1";
		process.env.BOBBIT_TEST_NO_PUSH = "1";
		process.env.BOBBIT_LLM_REVIEW_SKIP = "1";
		process.env.BOBBIT_NO_OPEN = "1";
		// Skip outbound network probes and per-prompt title-generation calls.
		process.env.BOBBIT_SKIP_AIGW_DISCOVERY = "1";
		process.env.BOBBIT_SKIP_TITLE_GEN = "1";

		const { setProjectRoot } = await import("../../dist/server/bobbit-dir.js");
		const { scaffoldBobbitDir } = await import("../../dist/server/scaffold.js");
		const { loadOrCreateToken } = await import("../../dist/server/auth/token.js");
		const { createGateway } = await import("../../dist/server/server.js");

		setProjectRoot(bobbitDir);
		scaffoldBobbitDir(bobbitDir);
		const token = loadOrCreateToken();

		const gw = createGateway({
			host: "127.0.0.1",
			port: 0,             // OS-assigned port
			portExplicit: true,  // Skip auto-increment loop
			authToken: token,
			defaultCwd: bobbitDir,
			forceAuth: true,
			agentCliPath: MOCK_AGENT,
		});

		const port = await gw.start();

		// Write gateway-url so agent subprocesses (including the mock agent) can
		// read it for callbacks to internal endpoints.
		writeFileSync(join(bobbitDir, "state", "gateway-url"), `http://127.0.0.1:${port}`, "utf-8");

		// Set env so e2e-setup.ts helpers target this worker's server
		process.env.E2E_PORT = String(port);

		// cli.ts normally writes .bobbit/state/gateway-url so agent subprocesses
		// can discover the gateway. When running in-process we must do that
		// ourselves — tests that exercise tool-grant-request rely on it.
		writeFileSync(join(bobbitDir, "state", "gateway-url"), `http://127.0.0.1:${port}`);

		const info: GatewayInfo = {
			port,
			baseURL: `http://127.0.0.1:${port}`,
			wsBase: `ws://127.0.0.1:${port}`,
			bobbitDir,
			sessionManager: gw.sessionManager,
		};

		await use(info);

		// Teardown — use existing shutdown() for proper cleanup
		await gw.shutdown();
		try {
			rmSync(bobbitDir, { recursive: true, force: true });
		} catch {
			// Best-effort cleanup
		}
	}, { scope: "worker", auto: true, timeout: 30_000 }],
});

export { expect } from "@playwright/test";
