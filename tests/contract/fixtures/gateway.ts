/**
 * Tier 2 "contract" test fixture — fresh in-process gateway per test.
 *
 * Each call to createTestGateway() spins up a gateway in ~30ms, gives you
 * direct access to sessionManager and stores, and cleans up on disposal.
 *
 * IMPORTANT: We do NOT call gw.start(). That means no HTTP/WS. Tier 2 tests
 * call gateway logic directly via sessionManager, stores, and helpers.
 *
 * For HTTP/WS protocol coverage, use Tier 3 (tests/e2e/).
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Lazy-load server modules once, reused across all tests in a process.
// First call: ~1s (module graph import). Subsequent calls: 0ms.
let serverModules: any = null;
async function getServerModules() {
	if (serverModules) return serverModules;
	const [bd, sc, tok, srv] = await Promise.all([
		import("../../../dist/server/bobbit-dir.js"),
		import("../../../dist/server/scaffold.js"),
		import("../../../dist/server/auth/token.js"),
		import("../../../dist/server/server.js"),
	]);
	serverModules = {
		setProjectRoot: bd.setProjectRoot,
		scaffoldBobbitDir: sc.scaffoldBobbitDir,
		loadOrCreateToken: tok.loadOrCreateToken,
		createGateway: srv.createGateway,
	};
	return serverModules;
}

export interface TestGateway {
	/** The underlying gateway (exposes sessionManager, server, shutdown). */
	gw: any;
	/** Temp directory acting as BOBBIT_DIR for this test. */
	dir: string;
	/** Shortcut to sessionManager. */
	sessionManager: any;
	/** Auth token (for tests that need to make HTTP requests via start()). */
	token: string;
	/** HTTP base URL — only set if startHttp was true. */
	baseURL: string | null;
	/** Cleanup — called automatically if you use `await using`. */
	[Symbol.asyncDispose]: () => Promise<void>;
}

/**
 * Create a fresh in-process gateway for a single test.
 *
 * Usage:
 *   await using gw = await createTestGateway();
 *   const session = await gw.sessionManager.createSession(...);
 *   // ... assertions ...
 *   // Automatic cleanup via `using`
 *
 * Or without `using`:
 *   const gw = await createTestGateway();
 *   try { ... } finally { await gw[Symbol.asyncDispose](); }
 */
export async function createTestGateway(opts?: {
	/** If true, also start HTTP/WS (adds ~170ms). Defaults to false. */
	startHttp?: boolean;
	/** Path to mock agent CLI. Defaults to tests/e2e/mock-agent.mjs. */
	agentCliPath?: string;
}): Promise<TestGateway> {
	const dir = join(tmpdir(), `tier2-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(join(dir, "state"), { recursive: true });
	writeFileSync(join(dir, "state", "projects.json"), "[]");
	writeFileSync(join(dir, "state", "setup-complete"), "tier2\n");

	// Per-test env — safe because each test is isolated at the process level
	// (node:test parallelises tests in the same process, but module-level
	// state in server.ts is scoped via the returned gateway object).
	process.env.BOBBIT_DIR = dir;
	process.env.BOBBIT_SKIP_MCP = "1";
	process.env.BOBBIT_SKIP_NPM_CI = "1";
	process.env.BOBBIT_LLM_REVIEW_SKIP = "1";
	process.env.BOBBIT_NO_OPEN = "1";

	const { setProjectRoot, scaffoldBobbitDir, loadOrCreateToken, createGateway } = await getServerModules();

	setProjectRoot(dir);
	scaffoldBobbitDir(dir);
	const token = loadOrCreateToken();

	const defaultAgent = join(process.cwd(), "tests", "e2e", "mock-agent.mjs");
	const gw = createGateway({
		host: "127.0.0.1",
		port: 0,
		portExplicit: true,
		authToken: token,
		defaultCwd: dir,
		forceAuth: true,
		agentCliPath: opts?.agentCliPath ?? defaultAgent,
	});

	let baseURL: string | null = null;
	if (opts?.startHttp) {
		const port = await gw.start();
		baseURL = `http://127.0.0.1:${port}`;
	}

	return {
		gw,
		dir,
		sessionManager: gw.sessionManager,
		token,
		baseURL,
		async [Symbol.asyncDispose]() {
			try {
				await gw.shutdown();
			} catch {
				// best-effort
			}
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {
				// best-effort
			}
		},
	};
}
