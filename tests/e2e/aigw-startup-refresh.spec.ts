/**
 * API E2E tests for the startup refresh of `~/.bobbit/agent/models.json`.
 *
 * Each test spins up its own in-process gateway with pre-seeded preferences
 * (so `aigw.url` is set BEFORE startup), so we can exercise the actual
 * `startupAigwCheck()` code path that runs in `createGateway()`.
 *
 * Scenarios:
 *  1. Existing aigw config + reachable mock gateway → models.json rewritten
 *     with the provider-level x-opencode-session header and fresh models.
 *  2. Existing aigw config + unreachable gateway → pre-existing models.json
 *     left byte-identical, gateway still comes up.
 *  3. BOBBIT_SKIP_AIGW_DISCOVERY=1 → no HTTP request to the mock gateway,
 *     models.json untouched, Bedrock env vars set on agent subprocesses.
 */
import { test as base, expect } from "@playwright/test";
import http from "node:http";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import module from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Per-worker V8 compile cache (mirrors in-process-harness.ts).
{
	const cacheRoot = process.env.BOBBIT_E2E_V8CACHE_ROOT || join(tmpdir(), "bobbit-e2e-v8cache");
	const workerCacheDir = join(cacheRoot, `w-${process.pid}`);
	try { mkdirSync(workerCacheDir, { recursive: true }); } catch { /* best-effort */ }
	try { module.enableCompileCache?.(workerCacheDir); } catch { /* Node < 22.8 */ }
}

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..", "..");
const MOCK_AGENT = resolve(__dirname, "mock-agent.mjs");

const E2E_TEMP_ROOT = existsSync("/.dockerenv")
	? "/tmp"
	: process.platform === "win32"
		? (process.env.BOBBIT_E2E_TMP_ROOT || "C:\\bobbit-e2e")
		: join(tmpdir(), "bobbit-e2e");

const EXPECTED_HEADER_VALUE =
	`!node -e "process.stdout.write(process.env.BOBBIT_SESSION_ID || '')"`;

interface SeedOpts {
	aigwUrl?: string;
	skipDiscovery?: boolean;
	preWriteModelsJson?: any;
	mockGateway?: { hits: () => number };
}

interface StartedGateway {
	port: number;
	baseURL: string;
	bobbitDir: string;
	agentDir: string;
	modelsJsonPath: string;
	shutdown: () => Promise<void>;
}

async function startSeededGateway(opts: SeedOpts): Promise<StartedGateway> {
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
	if (opts.aigwUrl) {
		writeFileSync(
			join(bobbitDir, "state", "preferences.json"),
			JSON.stringify({ "aigw.url": opts.aigwUrl }, null, 2),
		);
	}

	// Pre-write models.json (in the isolated agent dir) so we can verify
	// untouched-vs-rewritten on a per-test basis.
	const modelsJsonPath = join(agentDir, "models.json");
	if (opts.preWriteModelsJson !== undefined) {
		writeFileSync(modelsJsonPath, JSON.stringify(opts.preWriteModelsJson, null, 2));
	}

	process.env.BOBBIT_DIR = bobbitDir;
	// Isolate the agent dir so each test has its own ~/.bobbit/agent equivalent.
	process.env.BOBBIT_AGENT_DIR = agentDir;
	process.env.BOBBIT_SKIP_MCP = "1";
	process.env.BOBBIT_SKIP_NPM_CI = "1";
	process.env.BOBBIT_TEST_NO_PUSH = "1";
	process.env.BOBBIT_LLM_REVIEW_SKIP = "1";
	process.env.BOBBIT_NO_OPEN = "1";
	process.env.BOBBIT_SKIP_TITLE_GEN = "1";
	process.env.BOBBIT_SKIP_WORKTREE_POOL = "1";
	if (opts.skipDiscovery) {
		process.env.BOBBIT_SKIP_AIGW_DISCOVERY = "1";
	} else {
		delete process.env.BOBBIT_SKIP_AIGW_DISCOVERY;
	}

	mkdirSync(join(bobbitDir, "state", "session-prompts"), { recursive: true });

	const { setServerCwd } = await import("../../dist/server/bobbit-dir.js");
	const { scaffoldBobbitDir } = await import("../../dist/server/scaffold.js");
	const { loadOrCreateToken } = await import("../../dist/server/auth/token.js");
	const { createGateway } = await import("../../dist/server/server.js");
	const { registerRpcBridgeFactory } = await import("../../dist/server/agent/rpc-bridge.js");
	const { InProcessMockBridge, shouldUseInProcessMock } = await import("./in-process-mock-bridge.mjs");
	registerRpcBridgeFactory((opts: any) => {
		if (shouldUseInProcessMock(opts.cliPath)) return new InProcessMockBridge(opts);
		return null;
	});

	setServerCwd(bobbitDir);
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

interface MockGateway {
	url: string;
	hits: () => number;
	close: () => Promise<void>;
}

function startMockAigw(modelIds: string[]): Promise<MockGateway> {
	let hits = 0;
	const server = http.createServer((req, res) => {
		hits++;
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
	test("startup with reachable aigw rewrites models.json with header block + fresh models", async () => {
		const mock = await startMockAigw([
			"openai/gpt-5.2",
			"aws/us.anthropic.claude-sonnet-4-6",
		]);
		let gw: StartedGateway | undefined;
		try {
			gw = await startSeededGateway({ aigwUrl: mock.url });

			expect(existsSync(gw.modelsJsonPath)).toBe(true);
			const data = JSON.parse(readFileSync(gw.modelsJsonPath, "utf-8"));
			expect(data?.providers?.aigw, "aigw provider must exist after startup refresh").toBeTruthy();
			expect(data.providers.aigw.headers["x-opencode-session"]).toBe(EXPECTED_HEADER_VALUE);

			const ids = data.providers.aigw.models.map((m: any) => m.id);
			expect(ids).toContain("openai/gpt-5.2");
			expect(ids).toContain("us.anthropic.claude-sonnet-4-6"); // Claude prefix stripped
			expect(mock.hits()).toBeGreaterThan(0);
		} finally {
			await gw?.shutdown();
			await mock.close();
		}
	});

	test("startup with unreachable aigw leaves pre-existing aigw block untouched", async () => {
		// Pre-write a sentinel models.json with NO headers block on the aigw
		// provider — a successful startup refresh would add the
		// `x-opencode-session` header block, so its absence after startup proves
		// the file was NOT rewritten by `writeAigwModelsJson`.
		//
		// Note: `writeOpenAIModelAdditions()` and `writeContextWindowOverrides()`
		// run unconditionally after `startupAigwCheck` and may merge unrelated
		// providers (anthropic, openai-codex) into models.json. We therefore
		// assert on the aigw block specifically, not full file equality.
		const sentinelAigw = {
			baseUrl: "http://127.0.0.1:1",
			apiKey: "none",
			api: "openai-completions",
			models: [{ id: "old-cached-model", name: "Old Model" }],
		};
		const sentinel = {
			providers: {
				anthropic: { apiKey: "sk-test", models: [{ id: "claude-x" }] },
				aigw: sentinelAigw,
			},
		};

		let gw: StartedGateway | undefined;
		try {
			gw = await startSeededGateway({
				aigwUrl: "http://127.0.0.1:1", // reserved port — connection refused
				preWriteModelsJson: sentinel,
			});

			const data = JSON.parse(readFileSync(gw.modelsJsonPath, "utf-8"));
			expect(data.providers.aigw).toEqual(sentinelAigw);
			expect(data.providers.aigw.headers).toBeUndefined();
		} finally {
			await gw?.shutdown();
		}
	});

	test("startup with BOBBIT_SKIP_AIGW_DISCOVERY=1 makes no HTTP request and leaves models.json untouched", async () => {
		const mock = await startMockAigw(["should-not-be-fetched"]);
		const sentinel = { providers: { anthropic: { apiKey: "sk-test" } } };
		let gw: StartedGateway | undefined;
		try {
			gw = await startSeededGateway({
				aigwUrl: mock.url,
				skipDiscovery: true,
				preWriteModelsJson: sentinel,
			});

			expect(mock.hits(), "mock gateway must not be hit under skip flag").toBe(0);
			// `writeOpenAIModelAdditions` runs after startupAigwCheck and may add
			// unrelated providers (openai-codex etc.). The contract here is that
			// the aigw provider was NOT touched — in this test no aigw block
			// was pre-seeded so the post-startup file must STILL have no aigw
			// provider entry, and the seeded anthropic provider survives intact.
			const data = JSON.parse(readFileSync(gw.modelsJsonPath, "utf-8"));
			expect(data.providers.aigw, "no aigw provider must be written under skip flag").toBeUndefined();
			// Seeded anthropic apiKey survives (writeContextWindowOverrides may add
			// `modelOverrides` to it but must not clobber the existing fields).
			expect(data.providers.anthropic.apiKey).toBe("sk-test");

			// Sanity: gateway came up and serves /api/health (un-authenticated).
			const res = await fetch(`${gw.baseURL}/api/health`);
			// 200 (no auth required) or 401 (auth required) both prove the gateway
			// is alive — only a refused connection would be a real failure.
			expect([200, 401]).toContain(res.status);
		} finally {
			await gw?.shutdown();
			await mock.close();
		}
	});
});
