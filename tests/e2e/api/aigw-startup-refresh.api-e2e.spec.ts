/**
 * API E2E tests for the startup refresh of `~/.bobbit/agent/models.json`.
 *
 * Each test spins up its own in-process gateway with pre-seeded preferences
 * (so `aigw.url` is set BEFORE startup), so we can exercise the actual
 * `startupAigwCheck()` code path that runs in `createGateway()`.
 *
 * The retained journey proves that a reachable configured AIGW is discovered
 * through `createGateway().start()` and published as an explicitly managed
 * provider. Policy-only failure branches are covered deterministically in the
 * AIGW unit suites without paying for additional gateway boots.
 */
import { test as base, expect } from "@playwright/test";
import http from "node:http";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadE2EDistServerRuntime } from "../../support/harnesses/e2e/dist-server-runtime.js";

// Deliberately do not enable Node's on-disk V8 compile cache here. The E2E
// workers cold-import dist/server once per process, so a per-worker cache gives
// no useful same-run speedup; on Windows/Node 24 it intermittently returned
// stale module metadata as false "does not provide an export" startup errors.

const __dirname = fileURLToPath(new URL("..", import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..", "..");
const MOCK_AGENT = resolve(__dirname, "mock-agent.mjs");

const E2E_TEMP_ROOT = process.env.BOBBIT_E2E_TMP_ROOT
	// Docker's `/tmp` is shared across coordinators; use the explicit owned root.
	|| (existsSync("/.dockerenv")
		? "/tmp"
		: process.platform === "win32"
			? "C:\\bobbit-e2e"
			: join(realpathSync(tmpdir()), "bobbit-e2e"));

const EXPECTED_HEADER_VALUE =
	`!node -e "process.stdout.write(process.env.BOBBIT_SESSION_ID || '')"`;
const PACKAGE_VERSION = JSON.parse(readFileSync(resolve(PROJECT_ROOT, "package.json"), "utf-8")).version;
const EXPECTED_USER_AGENT = `Bobbit/${PACKAGE_VERSION}`;

interface StartedGateway {
	port: number;
	baseURL: string;
	bobbitDir: string;
	agentDir: string;
	modelsJsonPath: string;
	shutdown: () => Promise<void>;
}

async function startSeededGateway(aigwUrl: string): Promise<StartedGateway> {
	mkdirSync(E2E_TEMP_ROOT, { recursive: true });
	const bobbitDir = join(
		E2E_TEMP_ROOT,
		`.e2e-aigw-startup-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
	);
	const agentDir = join(bobbitDir, "agent");
	rmSync(bobbitDir, { recursive: true, force: true });
	mkdirSync(join(bobbitDir, "state"), { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(bobbitDir, "state", "projects.json"), "[]");
	writeFileSync(join(bobbitDir, "state", "setup-complete"), "e2e\n");

	// Pre-seed preferences with aigw.url so startupAigwCheck picks it up.
	writeFileSync(
		join(bobbitDir, "state", "preferences.json"),
		JSON.stringify({ "aigw.url": aigwUrl }, null, 2),
	);

	const modelsJsonPath = join(agentDir, "models.json");

	process.env.BOBBIT_DIR = bobbitDir;
	// Isolate live server secrets (token/TLS/sandbox-agent auth) so they never
	// land in the developer's real OS home dir (serverSecretsDir() default).
	process.env.BOBBIT_SECRETS_DIR = join(bobbitDir, ".secrets");
	// Isolate the agent dir so each test has its own ~/.bobbit/agent equivalent.
	process.env.BOBBIT_AGENT_DIR = agentDir;
	process.env.NODE_ENV = "test";
	process.env.BOBBIT_SKIP_MCP = "1";
	process.env.BOBBIT_SKIP_NPM_CI = "1";
	process.env.BOBBIT_TEST_NO_PUSH = "1";
	process.env.BOBBIT_TEST_NO_REMOTE = "1";
	process.env.BOBBIT_TEST_NO_EXTERNAL = "1";
	process.env.BOBBIT_LLM_REVIEW_SKIP = "1";
	process.env.BOBBIT_NO_OPEN = "1";
	process.env.BOBBIT_SKIP_TITLE_GEN = "1";
	process.env.BOBBIT_SKIP_WORKTREE_POOL = "1";
	delete process.env.BOBBIT_SKIP_AIGW_DISCOVERY;

	mkdirSync(join(bobbitDir, "state", "session-prompts"), { recursive: true });

	const runtime = await loadE2EDistServerRuntime(async () => {
		const bobbitDir = await import("../../../dist/server/bobbit-dir.js");
		const scaffold = await import("../../../dist/server/scaffold.js");
		const authToken = await import("../../../dist/server/auth/token.js");
		const server = await import("../../../dist/server/server.js");
		const rpcBridge = await import("../../../dist/server/agent/rpc-bridge.js");
		return { bobbitDir, scaffold, authToken, server, rpcBridge };
	});
	const { setProjectRoot, resetAgentDirStateForTests } = runtime.bobbitDir;
	const { scaffoldBobbitDir } = runtime.scaffold;
	const { loadOrCreateToken } = runtime.authToken;
	const { createGateway } = runtime.server;
	const { registerRpcBridgeFactory } = runtime.rpcBridge;
	const { InProcessMockBridge, shouldUseInProcessMock } = await import("../in-process-mock-bridge.mjs");
	registerRpcBridgeFactory((opts: any) => {
		if (shouldUseInProcessMock(opts.cliPath)) return new InProcessMockBridge(opts);
		return null;
	});

	// This serial suite reuses imported server modules across isolated boots.
	// Reset the startup-pinned agent directory so each boot publishes only into
	// its own models.json fixture rather than the first test's removed directory.
	resetAgentDirStateForTests();
	setProjectRoot(bobbitDir);
	scaffoldBobbitDir(bobbitDir);
	const token = loadOrCreateToken();

	const gw = createGateway({
		host: "127.0.0.1",
		port: 0,
		portExplicit: true,
		authToken: token,
		defaultCwd: bobbitDir,
		forceAuth: true,
		agentCliPath: MOCK_AGENT,
	});

	const port = await gw.start();
	writeFileSync(join(bobbitDir, "state", "gateway-url"), `http://127.0.0.1:${port}`, "utf-8");

	return {
		port,
		baseURL: `http://127.0.0.1:${port}`,
		bobbitDir,
		agentDir,
		modelsJsonPath,
		shutdown: async () => {
			await gw.shutdown();
			try { rmSync(bobbitDir, { recursive: true, force: true }); } catch { /* best-effort */ }
		},
	};
}

interface RecordedRequest {
	method?: string;
	url?: string;
	headers: http.IncomingHttpHeaders;
	rawHeaders: string[];
}

interface MockGateway {
	url: string;
	hits: () => number;
	requests: () => RecordedRequest[];
	close: () => Promise<void>;
}

function userAgentValues(record: RecordedRequest): string[] {
	const values: string[] = [];
	for (let i = 0; i < record.rawHeaders.length; i += 2) {
		if (record.rawHeaders[i]?.toLowerCase() === "user-agent") {
			values.push(record.rawHeaders[i + 1] || "");
		}
	}
	return values;
}

function expectSingleBobbitUserAgent(record: RecordedRequest | undefined): void {
	expect(record, "mock gateway should have recorded startup discovery").toBeTruthy();
	expect(record!.headers["user-agent"]).toBe(EXPECTED_USER_AGENT);
	expect(userAgentValues(record!)).toEqual([EXPECTED_USER_AGENT]);
}

function startMockAigw(modelIds: string[]): Promise<MockGateway> {
	let hits = 0;
	const requests: RecordedRequest[] = [];
	const server = http.createServer((req, res) => {
		hits++;
		requests.push({
			method: req.method,
			url: req.url,
			headers: req.headers,
			rawHeaders: [...req.rawHeaders],
		});
		if (req.url?.endsWith("/v1/models")) {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({
				data: modelIds.map(id => ({ id, object: "model", created: 1700000000, owned_by: "system" })),
			}));
			return;
		}
		res.writeHead(404);
		res.end();
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const port = (server.address() as any).port;
			resolve({
				url: `http://127.0.0.1:${port}`,
				hits: () => hits,
				requests: () => [...requests],
				close: () => new Promise<void>((r) => server.close(() => r())),
			});
		});
	});
}

// Tests run sequentially in this file because they share the singleton
// server.ts module-level state through repeated createGateway() calls.
const test = base;
test.describe.configure({ mode: "serial" });

test.describe("startupAigwCheck — refresh models.json on startup (E2E)", () => {
	test("startup with reachable aigw publishes a marked provider with exact routed models", async () => {
		const mock = await startMockAigw([
			"openai/gpt-5.2",
			"aws/us.anthropic.claude-sonnet-4-6",
		]);
		let gw: StartedGateway | undefined;
		try {
			gw = await startSeededGateway(mock.url);

			expect(existsSync(gw.modelsJsonPath)).toBe(true);
			const data = JSON.parse(readFileSync(gw.modelsJsonPath, "utf-8"));
			expect(data?.providers?.aigw, "aigw provider must exist after startup refresh").toBeTruthy();
			expect(data.providers.aigw["x-bobbit-managed"]).toEqual({ kind: "aigw-publication", version: 1 });
			expect(data.providers.aigw.headers["x-opencode-session"]).toBe(EXPECTED_HEADER_VALUE);
			expect(data.providers.aigw.headers["User-Agent"]).toBe(EXPECTED_USER_AGENT);

			const ids = data.providers.aigw.models.map((m: any) => m.id);
			// gpt-5.2 is a reasoning model → the option-1 fallback routes it to
			// openai-responses with a BARE wire id ("openai/gpt-5.2" → "gpt-5.2").
			expect(ids).toContain("gpt-5.2");
			expect(ids).toContain("us.anthropic.claude-sonnet-4-6"); // Claude prefix stripped
			expect(mock.hits()).toBeGreaterThan(0);
			expectSingleBobbitUserAgent(mock.requests().find((record) => record.url === "/v1/models"));
		} finally {
			await gw?.shutdown();
			await mock.close();
		}
	});

});
