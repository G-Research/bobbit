/**
 * In-process gateway fixture for E2E API tests.
 *
 * Unlike gateway-harness.ts which spawns a child process, this fixture
 * imports the server directly and starts it in the same Node process.
 * This eliminates ~5-8s of process spawn + health-check overhead per worker.
 *
 * Each Playwright worker gets its own isolated gateway with:
 *   - A unique OS-assigned port (port 0)
 *   - A unique BOBBIT_DIR and BOBBIT_AGENT_DIR (ephemeral, cleaned up after)
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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { awaitableRm } from "./test-utils/cleanup.js";

// Deliberately do not enable Node's on-disk V8 compile cache here. The E2E
// workers cold-import dist/server once per process, so a per-worker cache gives
// no useful same-run speedup; on Windows/Node 24 it intermittently returned
// stale module metadata as false "does not provide an export" startup errors.

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
}

function readHarnessToken(info: GatewayInfo): string {
	try { return readFileSync(join(info.bobbitDir, "state", "token"), "utf-8").trim(); } catch {}
	const token = process.env.BOBBIT_TOKEN?.trim();
	if (token && token.length >= 64) return token;
	throw new Error(`missing token for ${info.bobbitDir}`);
}

async function seedHarnessDefaultWorkflows(info: GatewayInfo, headers: Record<string, string>, projectId: string): Promise<void> {
	const { testWorkflows, TEST_DEFAULT_COMPONENT } = await import("./seed-workflows.js");
	let current: Record<string, any> = {};
	try {
		const cfgResp = await fetch(`${info.baseURL}/api/projects/${projectId}/config`, { headers });
		if (cfgResp.ok) current = await cfgResp.json();
	} catch { /* fall back to additive seed */ }
	const existingWorkflows = current.workflows && typeof current.workflows === "object" && !Array.isArray(current.workflows)
		? current.workflows as Record<string, unknown>
		: {};
	const workflows = { ...testWorkflows(), ...existingWorkflows };
	const existingComponents = Array.isArray(current.components) ? current.components : [];
	const componentNames = new Set(existingComponents.map((c: any) => c?.name).filter((name: unknown): name is string => typeof name === "string"));
	const components = componentNames.has(TEST_DEFAULT_COMPONENT.name)
		? existingComponents
		: [...existingComponents, TEST_DEFAULT_COMPONENT];
	const seedResp = await fetch(`${info.baseURL}/api/projects/${projectId}/config`, {
		method: "PUT",
		headers,
		body: JSON.stringify({ components, workflows }),
	});
	if (!seedResp.ok) {
		const seedText = await seedResp.text().catch(() => "<failed to read body>");
		throw new Error(`[in-process-harness] default project workflow restore failed: ${seedResp.status} ${seedResp.statusText} body=${seedText}`);
	}
}

async function restoreHarnessDefaultProject(info: GatewayInfo): Promise<void> {
	const token = readHarnessToken(info);
	const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
	const listResp = await fetch(`${info.baseURL}/api/projects`, { headers });
	if (!listResp.ok) {
		throw new Error(`[in-process-harness] default project restore list failed: ${listResp.status} ${listResp.statusText}`);
	}
	const body = await listResp.json();
	const projects: Array<{ id?: string; name?: string; hidden?: boolean }> = Array.isArray(body) ? body : (body.projects ?? []);
	const existingDefault = projects.find(p => !p.hidden && p.name === "default" && p.id);
	if (existingDefault?.id) {
		await seedHarnessDefaultWorkflows(info, headers, existingDefault.id);
		return;
	}

	const registerResp = await fetch(`${info.baseURL}/api/projects`, {
		method: "POST",
		headers,
		body: JSON.stringify({ name: "default", rootPath: info.bobbitDir, upsert: true, acceptCanonical: true }),
	});
	const registerText = await registerResp.text().catch(() => "<failed to read body>");
	if (!registerResp.ok) {
		throw new Error(`[in-process-harness] default project restore failed: ${registerResp.status} ${registerResp.statusText} body=${registerText}`);
	}
	const project = JSON.parse(registerText) as { id?: string };
	if (!project.id) throw new Error(`[in-process-harness] default project restore returned no id: ${registerText}`);
	await seedHarnessDefaultWorkflows(info, headers, project.id);
}

/**
 * Extended test fixture that provides a per-worker in-process gateway.
 *
 * Usage in test files:
 *   import { test, expect } from "./in-process-harness.js";
 *   // e2e-setup helpers automatically target this worker's gateway
 */
export const test = base.extend<{ restoreDefaultProject: void }, { enableWorktreePool: boolean; gateway: GatewayInfo }>({
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
		const agentDir = join(bobbitDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		// Canonicalize bobbitDir so downstream consumers (process.env.BOBBIT_DIR,
		// the project rootPath derived from it, the preview-mount baseDir) all
		// see the real path. On macOS /var/folders → /private/var/folders, and
		// the path-guard's realpath-aware containment check otherwise rejects
		// missing files under the symlinked baseDir with 400→03 instead of 404.
		try {
			const { realpathSync } = await import("node:fs");
			bobbitDir = realpathSync(bobbitDir);
		} catch { /* not all platforms / first-call edge cases — fall back */ }
		// Seed projects.json. The server no longer auto-registers a default project,
		// so we register one explicitly via the API after startup (see below) to
		// preserve the pre-existing test harness contract ("projects[0] == server CWD").
		writeFileSync(join(bobbitDir, "state", "projects.json"), "[]");
		writeFileSync(join(bobbitDir, "state", "setup-complete"), "e2e\n");

		// Set BOBBIT_DIR env BEFORE importing server modules.
		// Playwright workers are separate Node processes, so module singletons
		// (bobbit-dir._projectRoot, caches) are per-worker — no cross-contamination.
		process.env.BOBBIT_DIR = bobbitDir;
		// Isolate the agent CLI directory as well as .bobbit/. Without this, API
		// workers race through ~/.bobbit/agent/models.json during startup/aigw tests.
		process.env.BOBBIT_AGENT_DIR = agentDir;
		process.env.PI_CODING_AGENT_DIR = agentDir;
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
		const gatewayUrl = `http://127.0.0.1:${port}`;

		// Set env so e2e-setup.ts helpers and in-process mock agents target this worker's server.
		process.env.E2E_PORT = String(port);
		process.env.BOBBIT_GATEWAY_URL = gatewayUrl;
		process.env.BOBBIT_TOKEN = token;

		// Register the server CWD as a project via REST so existing tests that
		// rely on a pre-existing "default" project at projects[0] keep working.
		// The server no longer auto-registers one — see server.ts startup block.
		// Workflows already seeded above via direct project.yaml write.
		const defaultProjectRegister = await fetch(`http://127.0.0.1:${port}/api/projects`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Authorization": `Bearer ${token}`,
			},
			// acceptCanonical=true is needed on macOS, where TMPDIR
			// (/var/folders/...) is a symlink to /private/var/folders/...
			// Without it, the server rejects the register with a
			// SymlinkProjectRootError 400 and the harness must fail loudly;
			// otherwise every POST /api/sessions or /api/goals then 400s with
			// "projectId required".
			body: JSON.stringify({ name: "default", rootPath: bobbitDir, upsert: true, acceptCanonical: true }),
		});
		if (!defaultProjectRegister.ok) {
			const body = await defaultProjectRegister.text().catch(() => "<failed to read body>");
			throw new Error(
				`[in-process-harness] default project registration failed: ` +
				`${defaultProjectRegister.status} ${defaultProjectRegister.statusText} body=${body || "<empty>"}`,
			);
		}

		// Write gateway-url so agent subprocesses (including the mock agent) can
		// read it for callbacks to internal endpoints.
		writeFileSync(join(bobbitDir, "state", "gateway-url"), gatewayUrl, "utf-8");

		const info: GatewayInfo = {
			port,
			baseURL: `http://127.0.0.1:${port}`,
			wsBase: `ws://127.0.0.1:${port}`,
			bobbitDir,
			sessionManager: gw.sessionManager,
			bgProcessManager: gw.bgProcessManager,
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

	restoreDefaultProject: [async ({ gateway }, use) => {
		await use();
		try {
			await restoreHarnessDefaultProject(gateway);
		} catch (err) {
			console.warn(`[in-process-harness] default project restore skipped: ${err instanceof Error ? err.message : String(err)}`);
		}
	}, { auto: true }],
});

export { expect } from "@playwright/test";
