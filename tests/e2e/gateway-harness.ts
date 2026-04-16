/**
 * Worker-scoped gateway fixture for browser E2E tests.
 *
 * Runs the gateway IN-PROCESS (same strategy as in-process-harness.ts) and
 * additionally serves the built UI from dist/ui so Playwright's browser can
 * load the app. Eliminates a persistent per-worker Node child process that
 * the previous spawned-gateway implementation required.
 *
 * Each Playwright worker gets its own isolated gateway with:
 *   - A unique OS-assigned port (port 0)
 *   - A unique BOBBIT_DIR (ephemeral, cleaned up after)
 *   - An isolated BOBBIT_AGENT_DIR with fake oauth creds so the UI skips
 *     the OAuth prompt
 *   - The mock agent (no API key needed)
 *
 * By default MCP subprocesses are skipped (BOBBIT_SKIP_MCP=1). Specs that
 * actually exercise MCP opt back in with `test.use({ enableMcp: true })`.
 *
 * IMPORTANT: This fixture MUST remain worker-scoped (not test-scoped).
 * Node's module cache means server singletons persist for the worker's
 * lifetime; making this test-scoped would cause silent cross-test
 * contamination.
 */
import { test as base } from "@playwright/test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..", "..");
const MOCK_AGENT = resolve(__dirname, "mock-agent.mjs");
const STATIC_DIR = resolve(PROJECT_ROOT, "dist", "ui");

// Inside Docker containers, /workspace is a bind-mount with ~10-20x slower I/O
// (9P/gRPC layer on Docker Desktop). Put write-heavy temp dirs on the container's
// local overlay FS instead. On the host, use os.tmpdir() to guarantee the CWD
// is outside the git repo — otherwise isGitRepo() returns true for the project
// rootPath and sessions auto-create worktrees (slow, conflicts with git state).
const E2E_TEMP_ROOT = existsSync("/.dockerenv") ? "/tmp" : join(tmpdir(), "bobbit-e2e");

export interface GatewayInfo {
	port: number;
	baseURL: string;
	wsBase: string;
	bobbitDir: string;
	sessionManager?: any;
}

export const test = base.extend<{}, { enableMcp: boolean; gateway: GatewayInfo }>({
	// Worker-scoped option. Default false — opt in with `test.use({ enableMcp: true })`
	// at the top of a spec file. Playwright groups tests with matching option
	// values onto the same worker, so each spec file effectively gets its own gateway.
	enableMcp: [false, { scope: "worker", option: true }],

	gateway: [async ({ enableMcp }, use, workerInfo) => {
		mkdirSync(E2E_TEMP_ROOT, { recursive: true });
		// Include pid + timestamp so retries don't collide with a previous
		// worker's teardown that may still hold file handles on Windows.
		const bobbitDir = join(
			E2E_TEMP_ROOT,
			`.e2e-browser-${process.pid}-${workerInfo.workerIndex}-${Date.now()}`,
		);

		// Clean slate (usually a no-op since the dir name is fresh)
		rmSync(bobbitDir, { recursive: true, force: true });
		mkdirSync(join(bobbitDir, "state"), { recursive: true });
		// Seed projects.json so ensureDefaultProject() fires (mirrors a non-fresh install)
		writeFileSync(join(bobbitDir, "state", "projects.json"), "[]");
		// Mark setup as complete so the setup wizard doesn't appear in tests
		writeFileSync(join(bobbitDir, "state", "setup-complete"), "e2e\n");

		// Create a fake agent dir with auth.json so the UI skips OAuth prompts.
		// The client checks /api/oauth/status which reads ~/.bobbit/agent/auth.json;
		// by setting BOBBIT_AGENT_DIR we redirect that to our isolated dir.
		const agentDir = join(bobbitDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "auth.json"), JSON.stringify({
			anthropic: { type: "oauth", expires: Date.now() + 86_400_000 },
		}));

		// Set env BEFORE importing server modules. Playwright workers are
		// separate Node processes, so module singletons are per-worker — no
		// cross-contamination.
		process.env.BOBBIT_DIR = bobbitDir;
		process.env.BOBBIT_AGENT_DIR = agentDir;
		process.env.BOBBIT_SKIP_NPM_CI = "1";
		process.env.BOBBIT_TEST_NO_PUSH = "1";
		process.env.BOBBIT_LLM_REVIEW_SKIP = "1";
		process.env.BOBBIT_NO_OPEN = "1";
		// Skip outbound network probes and per-prompt title-generation calls.
		// Tests that exercise these paths override explicitly.
		process.env.BOBBIT_SKIP_AIGW_DISCOVERY = "1";
		process.env.BOBBIT_SKIP_TITLE_GEN = "1";
		// Prevent inherited host/sandbox gateway credentials from leaking into
		// spawned agent subprocesses. We set these to the *local* gateway values
		// after it starts, below.
		delete process.env.BOBBIT_GATEWAY_URL;
		delete process.env.BOBBIT_TOKEN;
		// Skip MCP by default — spawning MCP subprocesses per gateway is expensive.
		// mcp-integration / mcp-tool-permission specs opt back in via test.use().
		if (enableMcp) {
			delete process.env.BOBBIT_SKIP_MCP;
		} else {
			process.env.BOBBIT_SKIP_MCP = "1";
		}

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
			// Browser tests need the UI served from the same origin.
			staticDir: STATIC_DIR,
		});

		const port = await gw.start();

		// Set env so e2e-setup.ts helpers target this worker's server
		process.env.E2E_PORT = String(port);

		// cli.ts normally writes .bobbit/state/gateway-url so agent subprocesses
		// (mock-agent, tool-grant-request flow) can discover the gateway.
		// When running in-process we must do that ourselves.
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
	}, { scope: "worker", auto: true, timeout: 60_000 }],
});

export { expect } from "@playwright/test";
