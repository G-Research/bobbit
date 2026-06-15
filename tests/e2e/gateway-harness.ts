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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { awaitableRm } from "./test-utils/cleanup.js";
import { withDistServerImportLock } from "./test-utils/dist-import-lock.js";

// Deliberately do not enable Node's on-disk V8 compile cache here. The E2E
// workers cold-import dist/server once per process, so a per-worker cache gives
// no useful same-run speedup; on Windows/Node 24 it intermittently returned
// stale module metadata as false "does not provide an export" startup errors.

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..", "..");
const MOCK_AGENT = resolve(__dirname, "mock-agent.mjs");
const STATIC_DIR = resolve(PROJECT_ROOT, "dist", "ui");

// Inside Docker containers, /workspace is a bind-mount with ~10-20x slower I/O
// (9P/gRPC layer on Docker Desktop). Put write-heavy temp dirs on the container's
// local overlay FS instead. On the host, use os.tmpdir() to guarantee the CWD
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
	sessionManager?: any;
	teamManager?: any;
	/** Server-side log ring buffer (last 200 lines), populated by the harness's
	 * console.{log,warn,error} hook. Failure-context fixture below dumps the
	 * tail of this buffer into the test artifact directory. */
	logs: { ring: string[]; capacity: number };
	/** Shut down the in-process gateway. The browser page's WebSocket will
	 * fire `close` and the client's reconnect timer will start polling. */
	crash(): Promise<void>;
	/** Re-boot the gateway anchored at the same `bobbitDir` AND the same
	 * port. Updates `info.sessionManager` to point at the new instance.
	 * Throws if the OS assigns a different port (which would orphan the
	 * browser page's WebSocket reconnect target). */
	restart(): Promise<void>;
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
		throw new Error(`[gateway-harness] default project workflow restore failed: ${seedResp.status} ${seedResp.statusText} body=${seedText}`);
	}
}

async function restoreHarnessDefaultProject(info: GatewayInfo): Promise<void> {
	const token = readHarnessToken(info);
	const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
	const listResp = await fetch(`${info.baseURL}/api/projects`, { headers });
	if (!listResp.ok) {
		throw new Error(`[gateway-harness] default project restore list failed: ${listResp.status} ${listResp.statusText}`);
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
		throw new Error(`[gateway-harness] default project restore failed: ${registerResp.status} ${registerResp.statusText} body=${registerText}`);
	}
	const project = JSON.parse(registerText) as { id?: string };
	if (!project.id) throw new Error(`[gateway-harness] default project restore returned no id: ${registerText}`);
	await seedHarnessDefaultWorkflows(info, headers, project.id);
}

// Server log ring buffer — module-scoped so the gateway worker fixture and
// the per-test failure-context fixture can both reach it without juggling a
// shared object through Playwright fixture chains.
const _serverLogs: { ring: string[]; capacity: number } = { ring: [], capacity: 500 };
function _pushLog(line: string): void {
	_serverLogs.ring.push(line);
	if (_serverLogs.ring.length > _serverLogs.capacity) {
		_serverLogs.ring.splice(0, _serverLogs.ring.length - _serverLogs.capacity);
	}
}
{
	// Tap console once per worker process. Calls are still passed through to
	// the original console so existing log inspection (and Playwright's
	// stdout/stderr piping) keeps working.
	const origLog = console.log.bind(console);
	const origWarn = console.warn.bind(console);
	const origError = console.error.bind(console);
	const fmt = (level: string, args: unknown[]): string => {
		const ts = new Date().toISOString();
		const msg = args.map(a => {
			if (typeof a === "string") return a;
			try { return JSON.stringify(a); } catch { return String(a); }
		}).join(" ");
		return `${ts} [${level}] ${msg}`;
	};
	console.log = (...a: unknown[]) => { _pushLog(fmt("log", a)); origLog(...a); };
	console.warn = (...a: unknown[]) => { _pushLog(fmt("warn", a)); origWarn(...a); };
	console.error = (...a: unknown[]) => { _pushLog(fmt("error", a)); origError(...a); };
}

export const test = base.extend<{ failureContext: void; restoreDefaultProject: void }, { enableMcp: boolean; enableWorktreePool: boolean; enableDevHarnessRestart: boolean; gateway: GatewayInfo }>({
	// Worker-scoped option. Default false — opt in with `test.use({ enableMcp: true })`
	// at the top of a spec file. Playwright groups tests with matching option
	// values onto the same worker, so each spec file effectively gets its own gateway.
	enableMcp: [false, { scope: "worker", option: true }],

	// Worker-scoped option. Default false — opt in via `test.use({ enableWorktreePool: true })`.
	enableWorktreePool: [false, { scope: "worker", option: true }],

	// Worker-scoped option. Default false — opt in via `test.use({ enableDevHarnessRestart: true })`.
	enableDevHarnessRestart: [false, { scope: "worker", option: true }],

	gateway: [async ({ enableMcp, enableWorktreePool, enableDevHarnessRestart }, use, workerInfo) => {
		mkdirSync(E2E_TEMP_ROOT, { recursive: true });
		// Include pid + timestamp so retries don't collide with a previous
		// worker's teardown that may still hold file handles on Windows.
		let bobbitDir = join(
			E2E_TEMP_ROOT,
			`.e2e-browser-${process.pid}-${workerInfo.workerIndex}-${Date.now()}`,
		);

		// Clean slate (usually a no-op since the dir name is fresh)
		rmSync(bobbitDir, { recursive: true, force: true });
		mkdirSync(join(bobbitDir, "state"), { recursive: true });
		// Canonicalize bobbitDir so downstream consumers (process.env.BOBBIT_DIR,
		// bobbitDir() helper, project rootPaths derived from it, preview-mount
		// baseDir) see the real path. On macOS /var/folders → /private/var/folders;
		// mixing the symlink path with the canonical form causes
		// POST /api/projects to 400 with code:"symlink_root" and breaks the
		// path-guard containment check (missing files report 400 instead of 404).
		// Canonicalizing once at the boundary eliminates the entire class.
		try {
			const { realpathSync } = await import("node:fs");
			bobbitDir = realpathSync(bobbitDir);
		} catch { /* not all platforms / first-call edge cases — fall back */ }
		// Pre-create subdirectories that the server writes into. Under heavy
		// parallel load on Windows, concurrent first-use of these dirs races
		// with scaffolding and produces spurious ENOENT — creating them up
		// front makes the server's writes idempotent.
		mkdirSync(join(bobbitDir, "state", "session-prompts"), { recursive: true });
		// Seed projects.json. The server no longer auto-registers a default project;
		// we register one via REST after startup (see below) so existing tests keep working.
		writeFileSync(join(bobbitDir, "state", "projects.json"), "[]");
		// Mark setup as complete so the setup wizard doesn't appear in tests
		writeFileSync(join(bobbitDir, "state", "setup-complete"), "e2e\n");
		// Default the system-scope Subgoals (Experimental) flag ON for browser
		// E2E tests. The OFF path is exercised explicitly by
		// tests/e2e/ui/subgoals-experimental-toggle.spec.ts.
		writeFileSync(
			join(bobbitDir, "state", "preferences.json"),
			JSON.stringify({ subgoalsEnabled: true }, null, 2),
		);

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
		const previousDevHarness = process.env.BOBBIT_DEV_HARNESS;
		if (enableDevHarnessRestart) {
			process.env.BOBBIT_DEV_HARNESS = "1";
		} else {
			delete process.env.BOBBIT_DEV_HARNESS;
		}
		process.env.BOBBIT_DIR = bobbitDir;
		process.env.BOBBIT_AGENT_DIR = agentDir;
		process.env.BOBBIT_SKIP_NPM_CI = "1";
		process.env.BOBBIT_TEST_NO_PUSH = "1";
		// Enable test-only bypass knobs used by various server paths.
		process.env.BOBBIT_E2E = "1";
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
		if (enableWorktreePool) {
			delete process.env.BOBBIT_SKIP_WORKTREE_POOL;
		} else {
			process.env.BOBBIT_SKIP_WORKTREE_POOL = "1";
		}

		const {
			setProjectRoot,
			scaffoldBobbitDir,
			loadOrCreateToken,
			createGateway,
			registerRpcBridgeFactory,
		} = await withDistServerImportLock(async () => {
			const { setProjectRoot } = await import("../../dist/server/bobbit-dir.js");
			const { scaffoldBobbitDir } = await import("../../dist/server/scaffold.js");
			const { loadOrCreateToken } = await import("../../dist/server/auth/token.js");
			const { createGateway } = await import("../../dist/server/server.js");
			const { registerRpcBridgeFactory } = await import("../../dist/server/agent/rpc-bridge.js");
			return { setProjectRoot, scaffoldBobbitDir, loadOrCreateToken, createGateway, registerRpcBridgeFactory };
		});
		// Register the in-process mock bridge factory before any sessions are
		// created. See in-process-harness.ts for rationale — same story here.
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
		// window where parallel workers' token files weren't yet readable.
		// Builtin workflow YAMLs were removed (follow-up A); tests that
		// reference workflowId: "general" / "feature" / "bug-fix" / "quick-fix"
		// / "test-fast" rely on this seed to make those IDs resolvable.
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

		// Reusable gateway-construction args. Captured once on first boot,
		// reused verbatim on restart() so the second instance is anchored
		// at the same on-disk state and behaves identically.
		const gatewayConfig = {
			host: "127.0.0.1",
			authToken: token,
			defaultCwd: bobbitDir,
			forceAuth: true,
			agentCliPath: MOCK_AGENT,
			staticDir: STATIC_DIR,
		};

		let gw = createGateway({
			...gatewayConfig,
			port: 0,             // OS-assigned port on first boot
			portExplicit: true,  // Skip auto-increment loop
		});

		const port = await gw.start();
		const gatewayUrl = `http://127.0.0.1:${port}`;

		// Set env so e2e-setup.ts helpers and in-process mock agents target this worker's server.
		process.env.E2E_PORT = String(port);
		process.env.BOBBIT_GATEWAY_URL = gatewayUrl;
		process.env.BOBBIT_TOKEN = token;

		// cli.ts normally writes .bobbit/state/gateway-url so agent subprocesses
		// (mock-agent, tool-grant-request flow) can discover the gateway.
		// When running in-process we must do that ourselves.
		writeFileSync(join(bobbitDir, "state", "gateway-url"), gatewayUrl);

		// Register the server CWD as a default project via REST. The server no
		// longer does this implicitly — see "eliminate default project" refactor.
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
				`[gateway-harness] default project registration failed: ` +
				`${defaultProjectRegister.status} ${defaultProjectRegister.statusText} body=${body || "<empty>"}`,
			);
		}

		const info: GatewayInfo = {
			port,
			baseURL: `http://127.0.0.1:${port}`,
			wsBase: `ws://127.0.0.1:${port}`,
			bobbitDir,
			sessionManager: gw.sessionManager,
			teamManager: gw.teamManager,
			logs: _serverLogs,
			async crash() {
				await gw.shutdown();
			},
			async restart() {
				// Re-bind the gateway to the same port. setProjectRoot /
				// scaffoldBobbitDir / loadOrCreateToken / project register /
				// workflow seed are all idempotent on-disk state and skipped
				// on restart — second boot reads what first boot wrote.
				// Module singletons in dist/server/* are already shared across
				// boots within the same Playwright worker (same pattern as
				// session-recovery.spec.ts and steer-gateway-restart.spec.ts).
				//
				// Tiny retry loop covers Windows TIME_WAIT races on the listener
				// socket. SO_REUSEADDR is OS-default for IPv4 on Windows so this
				// is rare — but observed enough in CI to warrant the guard.
				let lastErr: unknown;
				let boundPort = -1;
				for (let attempt = 0; attempt < 5; attempt++) {
					const next = createGateway({
						...gatewayConfig,
						port,
						portExplicit: true,
					});
					try {
						boundPort = await next.start();
						gw = next;
						break;
					} catch (err: any) {
						lastErr = err;
						if (err?.code !== "EADDRINUSE") throw err;
						await new Promise(r => setTimeout(r, 200 * (attempt + 1)));
					}
				}
				if (boundPort < 0) throw lastErr;
				if (boundPort !== port) {
					throw new Error(`gateway restarted on different port: ${boundPort} vs ${port}`);
				}
				writeFileSync(
					join(bobbitDir, "state", "gateway-url"),
					`http://127.0.0.1:${port}`,
				);
				info.sessionManager = gw.sessionManager;
				info.teamManager = gw.teamManager;
			},
		};

		await use(info);

		// Teardown — use existing shutdown() for proper cleanup
		await gw.shutdown();
		// Bounded-retry cleanup. Replaces the previous fire-and-forget
		// `void rmAsync(...)` strategy: that hid Windows Defender / FS-handle
		// races behind the global teardown sweep and produced spurious leak
		// reports. awaitableRm() retries with backoff (5 attempts, 200ms
		// base, exponential) and falls back to the global sweep on final
		// failure — so worker teardown is bounded but no longer silent.
		await awaitableRm(bobbitDir, {
			onFinalFailure: (err) => {
				const msg = (err as Error)?.message ?? String(err);
				console.warn(`[gateway-harness] cleanup deferred for ${bobbitDir}: ${msg}`);
			},
		});
		if (previousDevHarness === undefined) delete process.env.BOBBIT_DEV_HARNESS;
		else process.env.BOBBIT_DEV_HARNESS = previousDevHarness;
	}, { scope: "worker", auto: true, timeout: 60_000 }],

	restoreDefaultProject: [async ({ gateway }, use) => {
		await use();
		try {
			await restoreHarnessDefaultProject(gateway);
		} catch (err) {
			console.warn(`[gateway-harness] default project restore skipped: ${err instanceof Error ? err.message : String(err)}`);
		}
	}, { auto: true }],

	// Per-test failure-context fixture (auto). On test failure, attaches a
	// JSON snapshot of `window.bobbitState` (the read-only client state
	// reference exposed for diagnostics) and the tail of the server-log
	// ring buffer to the test result. Helps root-cause the long-tail flakes
	// (e.g. "button visible:false but assertion expected visible") by
	// preserving actual state at fail time instead of leaving us to guess
	// from stack traces.
	failureContext: [async ({ page }, use, testInfo) => {
		// Mark where this test’s server logs start so the snapshot only
		// includes lines emitted during this test’s execution, not the
		// entire worker session.
		const startIndex = _serverLogs.ring.length;
		await use();
		if (testInfo.status === testInfo.expectedStatus) return;
		try {
			const clientState = await page.evaluate(() => {
				try {
					const s = (window as any).bobbitState;
					if (!s) return { __bobbitState: "missing" };
					// Strip non-serialisable fields (DOM nodes, classes, event handlers).
					return JSON.parse(JSON.stringify(s, (_k, v) => {
						if (v instanceof Element) return `[Element ${v.tagName}]`;
						if (typeof v === "function") return "[Function]";
						if (v && typeof v === "object" && "nodeType" in v) return "[Node]";
						return v;
					}));
				} catch (err) {
					return { __bobbitStateError: String(err) };
				}
			});
			await testInfo.attach("client-state.json", {
				body: JSON.stringify(clientState, null, 2),
				contentType: "application/json",
			});
			const hash = await page.evaluate(() => window.location.hash).catch(() => "<unavailable>");
			await testInfo.attach("client-route.txt", {
				body: `hash=${hash}`,
				contentType: "text/plain",
			});
		} catch (err) {
			await testInfo.attach("client-state-error.txt", {
				body: `Failed to capture client state: ${err}`,
				contentType: "text/plain",
			}).catch(() => { /* best-effort */ });
		}
		try {
			const recent = _serverLogs.ring.slice(Math.max(startIndex - 10, 0));
			await testInfo.attach("server-logs.txt", {
				body: recent.join("\n"),
				contentType: "text/plain",
			});
		} catch { /* best-effort */ }
	}, { auto: true }],
});

export { expect } from "@playwright/test";
