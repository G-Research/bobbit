/**
 * API E2E tests for POST /api/custom-providers/test on manual/openai-completions
 * providers (e.g. NVIDIA NIM, OpenRouter, Together).
 *
 * Bug this pins: before this fix, discoverFromSingleConfig — the function the
 * /test route called for ALL provider types — just echoed the (empty, for a
 * test payload) static `models` list back for manual/openai-completions
 * providers. The route never actually contacted the remote server, so
 * "Test Connection" for these types always reported "0 models" whether the
 * server was reachable, the key was wrong, or the host didn't exist —
 * "validate it works" was a lie. The fix (probeOpenAICompatModels in
 * src/server/agent/model-registry.ts) makes /test actually call the remote
 * /v1/models with the configured key for these types, and throws distinct,
 * surfaceable errors instead of silently returning [].
 *
 * Standalone per-test gateway, mirroring
 * tests/e2e/custom-provider-key-redaction.spec.ts. No live LLM calls.
 */
import { test as base, expect } from "@playwright/test";
import http from "node:http";
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { withDistServerImportLock } from "./test-utils/dist-import-lock.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MOCK_AGENT = resolve(__dirname, "mock-agent.mjs");

const FAKE_KEY = "sk-fake-e2e-test-connection-key-000001";

const E2E_TEMP_ROOT = existsSync("/.dockerenv")
	? "/tmp"
	: process.platform === "win32"
		? (process.env.BOBBIT_E2E_TMP_ROOT || "C:\\bobbit-e2e")
		: join(realpathSync(tmpdir()), "bobbit-e2e");

interface StartedGateway {
	baseURL: string;
	bobbitDir: string;
	token: string;
	shutdown: () => Promise<void>;
}

async function startSeededGateway(): Promise<StartedGateway> {
	mkdirSync(E2E_TEMP_ROOT, { recursive: true });
	const bobbitDir = join(
		E2E_TEMP_ROOT,
		`.e2e-custom-provider-test-connection-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
	);
	const agentDir = join(bobbitDir, "agent");
	rmSync(bobbitDir, { recursive: true, force: true });
	mkdirSync(join(bobbitDir, "state"), { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(bobbitDir, "state", "projects.json"), "[]");
	writeFileSync(join(bobbitDir, "state", "setup-complete"), "e2e\n");

	process.env.BOBBIT_DIR = bobbitDir;
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
	process.env.BOBBIT_SKIP_AIGW_DISCOVERY = "1";

	mkdirSync(join(bobbitDir, "state", "session-prompts"), { recursive: true });

	// Serialize the cold dist/server import across parallel Playwright worker
	// processes. Concurrent cold imports intermittently fail with false ESM
	// loader errors ("module X does not provide an export Y") — observed live
	// in a gate run where two standalone custom-provider specs' workers raced.
	// Same mitigation the harnesses use (see gateway-harness.ts /
	// in-process-harness.ts and test-utils/dist-import-lock.ts).
	const { setProjectRoot, resetAgentDirStateForTests, scaffoldBobbitDir, loadOrCreateToken, createGateway, registerRpcBridgeFactory } =
		await withDistServerImportLock(async () => {
			const { setProjectRoot, resetAgentDirStateForTests } = await import("../../dist/server/bobbit-dir.js");
			const { scaffoldBobbitDir } = await import("../../dist/server/scaffold.js");
			const { loadOrCreateToken } = await import("../../dist/server/auth/token.js");
			const { createGateway } = await import("../../dist/server/server.js");
			const { registerRpcBridgeFactory } = await import("../../dist/server/agent/rpc-bridge.js");
			return { setProjectRoot, resetAgentDirStateForTests, scaffoldBobbitDir, loadOrCreateToken, createGateway, registerRpcBridgeFactory };
		});
	const { InProcessMockBridge, shouldUseInProcessMock } = await import("./in-process-mock-bridge.mjs");
	registerRpcBridgeFactory((opts: any) => {
		if (shouldUseInProcessMock(opts.cliPath)) return new InProcessMockBridge(opts);
		return null;
	});

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
		baseURL: `http://127.0.0.1:${port}`,
		bobbitDir,
		token,
		shutdown: async () => {
			await gw.shutdown();
			try { rmSync(bobbitDir, { recursive: true, force: true }); } catch { /* best-effort */ }
		},
	};
}

/** Mock NIM-like OpenAI-compat server: 200 + model list only for the correct bearer token, 401 otherwise. */
function startMockAuthedServer(modelIds: string[], expectedKey: string): Promise<{ url: string; close: () => Promise<void> }> {
	const server = http.createServer((req, res) => {
		if (req.url?.endsWith("/v1/models")) {
			const auth = req.headers["authorization"];
			if (auth !== `Bearer ${expectedKey}`) {
				res.writeHead(401, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "Unauthorized" }));
				return;
			}
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({
				data: modelIds.map(id => ({ id, object: "model", created: 1700000000, owned_by: "nim" })),
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
				close: () => new Promise<void>((r) => server.close(() => r())),
			});
		});
	});
}

async function api(gw: StartedGateway, path: string, init?: RequestInit): Promise<Response> {
	return fetch(`${gw.baseURL}${path}`, {
		...init,
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${gw.token}`,
			...(init?.headers || {}),
		},
	});
}

const test = base;
test.describe.configure({ mode: "serial" });

test.describe("POST /api/custom-providers/test — manual/openai-completions probe (E2E)", () => {
	test("success: probes the real remote /v1/models and reports the discovered count", async () => {
		const mock = await startMockAuthedServer(["z-ai/glm-5.2", "z-ai/glm-4.7"], FAKE_KEY);
		let gw: StartedGateway | undefined;
		try {
			gw = await startSeededGateway();
			const res = await api(gw, "/api/custom-providers/test", {
				method: "POST",
				body: JSON.stringify({ type: "openai-completions", name: "NIM", baseUrl: mock.url, apiKey: FAKE_KEY }),
			});
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.models.map((m: any) => m.id).sort()).toEqual(["z-ai/glm-4.7", "z-ai/glm-5.2"]);
		} finally {
			await gw?.shutdown();
			await mock.close();
		}
	});

	test("auth failure: wrong/missing key surfaces a distinct error instead of a silent empty list", async () => {
		const mock = await startMockAuthedServer(["z-ai/glm-5.2"], FAKE_KEY);
		let gw: StartedGateway | undefined;
		try {
			gw = await startSeededGateway();
			const res = await api(gw, "/api/custom-providers/test", {
				method: "POST",
				body: JSON.stringify({ type: "openai-completions", name: "NIM", baseUrl: mock.url, apiKey: "sk-wrong-key" }),
			});
			expect(res.status).not.toBe(200);
			const body = await res.json();
			expect(body.error).toMatch(/401/);
		} finally {
			await gw?.shutdown();
			await mock.close();
		}
	});

	test("unreachable: connection refused surfaces a distinct error instead of a silent empty list", async () => {
		let gw: StartedGateway | undefined;
		try {
			gw = await startSeededGateway();
			const res = await api(gw, "/api/custom-providers/test", {
				method: "POST",
				// Port 1 (TCPMUX) reliably refuses connections.
				body: JSON.stringify({ type: "openai-completions", name: "NIM", baseUrl: "http://127.0.0.1:1" }),
			});
			expect(res.status).not.toBe(200);
			const body = await res.json();
			expect(body.error).toBeTruthy();
		} finally {
			await gw?.shutdown();
		}
	});

	test("regression guard: before the fix this endpoint always returned {models: []} with 200 for manual types — must no longer be silently empty on a real failure", async () => {
		let gw: StartedGateway | undefined;
		try {
			gw = await startSeededGateway();
			const res = await api(gw, "/api/custom-providers/test", {
				method: "POST",
				body: JSON.stringify({ type: "manual", name: "unreachable-manual", baseUrl: "http://127.0.0.1:1" }),
			});
			// The old behavior (200 + {models: []}) is indistinguishable from a
			// real empty provider — assert the new behavior instead.
			expect(res.status).not.toBe(200);
		} finally {
			await gw?.shutdown();
		}
	});
});
