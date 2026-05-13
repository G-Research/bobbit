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
import module from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { awaitableRm } from "./test-utils/cleanup.js";

// Per-worker V8 compile cache. See gateway-harness.ts for rationale.
{
	const cacheRoot = process.env.BOBBIT_E2E_V8CACHE_ROOT || join(tmpdir(), "bobbit-e2e-v8cache");
	const workerCacheDir = join(cacheRoot, `w-${process.pid}`);
	try { mkdirSync(workerCacheDir, { recursive: true }); } catch { /* best-effort */ }
	try { module.enableCompileCache?.(workerCacheDir); } catch { /* Node < 22.8 */ }
}

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..", "..");
const MOCK_AGENT = resolve(__dirname, "mock-agent.mjs");

// Inside Docker containers, /workspace is a bind-mount with ~10-20x slower I/O
// (9P/gRPC layer on Docker Desktop). Put write-heavy temp dirs on the container's
// local overlay FS instead.  On the host, use os.tmpdir() to guarantee the CWD
// is outside the git repo — otherwise isGitRepo() returns true for the project
// rootPath and sessions auto-create worktrees (slow, conflicts with git state).
const E2E_TEMP_ROOT = existsSync("/.dockerenv")
	? "/tmp"
	: process.platform === "win32"
		? (process.env.BOBBIT_E2E_TMP_ROOT || "C:\\bobbit-e2e")
		: join(tmpdir(), "bobbit-e2e");

export interface GatewayInfo {
	port: number;
	baseURL: string;
	wsBase: string;
	bobbitDir: string;
	sessionManager: any;  // Exposed for sandbox security tests
	bgProcessManager: any;  // Exposed for bg-wait abort tests
	teamManager: any;     // Exposed for pause-cascade supervisor-respawn tests
}

/**
 * Extended test fixture that provides a per-worker in-process gateway.
 *
 * Usage in test files:
 *   import { test, expect } from "./in-process-harness.js";
 *   // e2e-setup helpers automatically target this worker's gateway
 */
export const test = base.extend<{}, { enableWorktreePool: boolean; gateway: GatewayInfo }>({
	// Worker-scoped option. Default false (pool pre-fill skipped for CPU).
	// Opt in with `test.use({ enableWorktreePool: true })` in specs that
	// actually exercise the pool endpoints.
	enableWorktreePool: [false, { scope: "worker", option: true }],

	gateway: [async ({ enableWorktreePool }, use, workerInfo) => {
		mkdirSync(E2E_TEMP_ROOT, { recursive: true });
		// Include pid + a per-worker counter so retries don't collide with a
		// previous worker's teardown that still holds file handles on Windows.
		let bobbitDir = join(
			E2E_TEMP_ROOT,
			`.e2e-inproc-${process.pid}-${workerInfo.workerIndex}-${Date.now()}`,
		);

		// Clean slate (usually a no-op since the dir name is fresh)
		rmSync(bobbitDir, { recursive: true, force: true });
		mkdirSync(join(bobbitDir, "state"), { recursive: true });
		// Canonicalize: see gateway-harness.ts for the same rationale
		// (/var/folders -> /private/var/folders on macOS).
		try {
			const { realpathSync } = await import("node:fs");
			bobbitDir = realpathSync(bobbitDir);
		} catch { /* fall back */ }
		// Seed projects.json. The server no longer auto-registers a default project,
		// so we register one explicitly via the API after startup (see below) to
		// preserve the pre-existing test harness contract ("projects[0] == server CWD").
		writeFileSync(join(bobbitDir, "state", "projects.json"), "[]");
		writeFileSync(join(bobbitDir, "state", "setup-complete"), "e2e\n");
		// Default the system-scope Subgoals (Experimental) flag ON for E2E tests so
		// existing nested-goal specs keep working unchanged. The flag's OFF path
		// is covered by tests/e2e/ui/subgoals-experimental-toggle.spec.ts and the
		// server-unit + helper unit tests. See
		// docs/design/subgoals-experimental-toggle.md §9.
		writeFileSync(
			join(bobbitDir, "state", "preferences.json"),
			JSON.stringify({ subgoalsEnabled: true }, null, 2),
		);

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
		// Skip worktree pool pre-fill by default — git worktree + setup commands
		// are expensive and most tests don't exercise the pool path. Specs that
		// exercise the pool opt in with `test.use({ enableWorktreePool: true })`.
		if (enableWorktreePool) {
			delete process.env.BOBBIT_SKIP_WORKTREE_POOL;
		} else {
			process.env.BOBBIT_SKIP_WORKTREE_POOL = "1";
		}

		// Pre-create subdirectories that the server writes into. Under heavy
		// parallel load on Windows, concurrent first-use of these dirs races
		// with scaffolding and produces spurious ENOENT.
		mkdirSync(join(bobbitDir, "state", "session-prompts"), { recursive: true });

		const { setProjectRoot } = await import("../../dist/server/bobbit-dir.js");
		const { scaffoldBobbitDir } = await import("../../dist/server/scaffold.js");
		const { loadOrCreateToken } = await import("../../dist/server/auth/token.js");
		const { createGateway } = await import("../../dist/server/server.js");
		// Register the in-process mock bridge factory before any sessions are
		// created. The factory intercepts RpcBridge constructions whose cliPath
		// points at our mock-agent.mjs and returns a drop-in class that skips
		// the Node subprocess + JSONL serialization entirely.
		const { registerRpcBridgeFactory } = await import("../../dist/server/agent/rpc-bridge.js");
		const { InProcessMockBridge, shouldUseInProcessMock } = await import("./in-process-mock-bridge.mjs");
		registerRpcBridgeFactory((opts: any) => {
			if (shouldUseInProcessMock(opts.cliPath)) return new InProcessMockBridge(opts);
			return null;
		});

		setProjectRoot(bobbitDir);
		scaffoldBobbitDir(bobbitDir);
		const token = loadOrCreateToken();

		// Seed inline test workflows BEFORE the gateway boots — direct file
		// write avoids the HTTP round-trip that previously widened a race
		// window. See gateway-harness.ts for rationale.
		try {
			const { testWorkflows, TEST_DEFAULT_COMPONENT } = await import("./seed-workflows.js");
			const { mkdirSync: mkSync, writeFileSync: wrSync } = await import("node:fs");
			const yaml = await import("yaml");
			const yamlContent = yaml.stringify({
				name: "default",
				components: [TEST_DEFAULT_COMPONENT],
				workflows: testWorkflows(),
			});
			// Server-level config (cascade): <bobbitDir>/config/project.yaml
			const serverConfigDir = join(bobbitDir, "config");
			mkSync(serverConfigDir, { recursive: true });
			wrSync(join(serverConfigDir, "project.yaml"), yamlContent);
			// Per-project config (project-context): <bobbitDir>/.bobbit/config/project.yaml
			const projectConfigDir = join(bobbitDir, ".bobbit", "config");
			mkSync(projectConfigDir, { recursive: true });
			wrSync(join(projectConfigDir, "project.yaml"), yamlContent);
		} catch { /* best-effort */ }

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

		// Register the server CWD as a project via REST so existing tests that
		// rely on a pre-existing "default" project at projects[0] keep working.
		// The server no longer auto-registers one — see server.ts startup block.
		// Workflows already seeded above via direct project.yaml write.
		try {
			await fetch(`http://127.0.0.1:${port}/api/projects`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Authorization": `Bearer ${token}`,
				},
				body: JSON.stringify({ name: "default", rootPath: bobbitDir, upsert: true, acceptCanonical: true }),
			});
		} catch { /* best-effort */ }

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
			bgProcessManager: gw.bgProcessManager,
			teamManager: (gw as any).teamManager,
		};

		await use(info);

		// Teardown — use existing shutdown() for proper cleanup
		await gw.shutdown();
		// Bounded-retry cleanup — see gateway-harness.ts for rationale.
		await awaitableRm(bobbitDir, {
			onFinalFailure: (err) => {
				const msg = (err as Error)?.message ?? String(err);
				console.warn(`[in-process-harness] cleanup deferred for ${bobbitDir}: ${msg}`);
			},
		});
	}, { scope: "worker", auto: true, timeout: 30_000 }],
});

export { expect } from "@playwright/test";
