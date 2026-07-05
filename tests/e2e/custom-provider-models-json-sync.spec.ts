/**
 * API E2E tests for the custom local provider (Ollama/LM Studio/vLLM/
 * llama.cpp/manual) → `~/.bobbit/agent/models.json` bridge.
 *
 * Bug this pins: before this fix, GET /api/models (and POST/DELETE
 * /api/custom-providers) only ever touched the `customProviders` preference
 * and getAvailableModels()'s in-memory registry — the file the spawned
 * `pi-coding-agent` subprocess actually reads to resolve `set_model` never
 * got the entry. A configured custom provider showed "authenticated" in the
 * picker but every session that selected it failed at spawn with `Model
 * "<provider>/<id>" not found. Use --list-models to see available models.`
 * (reproduced live against a real local Ollama server — see PR description).
 *
 * These tests use a standalone per-test gateway (own temp .bobbit dir, own
 * port), mirroring tests/e2e/aigw-startup-refresh.spec.ts, so we can:
 *   1. Pre-seed `customProviders` in preferences.json BEFORE startup and
 *      assert the real startup-sync code path in createGateway().start()
 *      wrote models.json.
 *   2. Exercise the live POST/DELETE /api/custom-providers routes against a
 *      running gateway and assert models.json is kept in sync.
 *
 * No live LLM calls — the mock server only serves GET /v1/models (model
 * discovery), never /v1/chat/completions; nothing here starts a real
 * agent conversation.
 */
import { test as base, expect } from "@playwright/test";
import http from "node:http";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { withDistServerImportLock } from "./test-utils/dist-import-lock.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MOCK_AGENT = resolve(__dirname, "mock-agent.mjs");

const E2E_TEMP_ROOT = existsSync("/.dockerenv")
	? "/tmp"
	: process.platform === "win32"
		? (process.env.BOBBIT_E2E_TMP_ROOT || "C:\\bobbit-e2e")
		: join(realpathSync(tmpdir()), "bobbit-e2e");

interface SeedOpts {
	preferences?: Record<string, unknown>;
}

interface StartedGateway {
	baseURL: string;
	bobbitDir: string;
	agentDir: string;
	modelsJsonPath: string;
	token: string;
	shutdown: () => Promise<void>;
}

async function startSeededGateway(opts: SeedOpts = {}): Promise<StartedGateway> {
	mkdirSync(E2E_TEMP_ROOT, { recursive: true });
	const bobbitDir = join(
		E2E_TEMP_ROOT,
		`.e2e-custom-provider-sync-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
	);
	const agentDir = join(bobbitDir, "agent");
	rmSync(bobbitDir, { recursive: true, force: true });
	mkdirSync(join(bobbitDir, "state"), { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(bobbitDir, "state", "projects.json"), "[]");
	writeFileSync(join(bobbitDir, "state", "setup-complete"), "e2e\n");

	if (opts.preferences) {
		writeFileSync(join(bobbitDir, "state", "preferences.json"), JSON.stringify(opts.preferences, null, 2));
	}

	const modelsJsonPath = join(agentDir, "models.json");

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
	// No aigw configured in this file — let its startup check no-op quickly.
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

	// The agent-dir runtime is a module-level singleton that (by product
	// design) only re-resolves on a real process restart. Multiple
	// createGateway() calls within one Playwright worker process would
	// otherwise all resolve globalAgentDir() to the FIRST test's (by-then
	// deleted) directory. Reset it before each in-process gateway boot so
	// this test file's per-test isolation actually holds.
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
		agentDir,
		modelsJsonPath,
		token,
		shutdown: async () => {
			await gw.shutdown();
			try { rmSync(bobbitDir, { recursive: true, force: true }); } catch { /* best-effort */ }
		},
	};
}

function startMockOpenAICompatServer(modelIds: string[]): Promise<{ url: string; close: () => Promise<void> }> {
	const server = http.createServer((req, res) => {
		if (req.url?.endsWith("/v1/models")) {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({
				data: modelIds.map(id => ({ id, object: "model", created: 1700000000, owned_by: "local" })),
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

function readModels(gw: StartedGateway): any {
	if (!existsSync(gw.modelsJsonPath)) return null;
	return JSON.parse(readFileSync(gw.modelsJsonPath, "utf-8"));
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

// Tests run sequentially — each spins up its own gateway/port, but the
// module-level rpc-bridge factory registration is shared process state.
const test = base;
test.describe.configure({ mode: "serial" });

test.describe("Custom local provider → models.json sync (E2E)", () => {
	test("startup with a pre-configured custom provider writes its models.json entry before any session can spawn", async () => {
		const mock = await startMockOpenAICompatServer(["qwen3:0.6b"]);
		let gw: StartedGateway | undefined;
		try {
			gw = await startSeededGateway({
				preferences: {
					customProviders: [
						{ id: "local-ollama", name: "local-ollama", type: "vllm", baseUrl: mock.url },
					],
				},
			});

			const data = readModels(gw);
			expect(data?.providers?.["local-ollama"], "custom provider must be synced into models.json at startup").toBeTruthy();
			expect(data.providers["local-ollama"].baseUrl).toBe(`${mock.url}/v1`);
			expect(data.providers["local-ollama"].models.map((m: any) => m.id)).toContain("qwen3:0.6b");
		} finally {
			await gw?.shutdown();
			await mock.close();
		}
	});

	test("POST /api/custom-providers writes models.json; DELETE removes it", async () => {
		const mock = await startMockOpenAICompatServer(["model-a", "model-b"]);
		let gw: StartedGateway | undefined;
		try {
			gw = await startSeededGateway();
			expect(readModels(gw)?.providers?.["e2e-local"]).toBeFalsy();

			const postRes = await api(gw, "/api/custom-providers", {
				method: "POST",
				body: JSON.stringify({ id: "e2e-local", name: "e2e-local", type: "vllm", baseUrl: mock.url }),
			});
			expect(postRes.status).toBe(200);

			const afterPost = readModels(gw);
			expect(afterPost?.providers?.["e2e-local"], "POST must sync the new provider into models.json").toBeTruthy();
			expect(afterPost.providers["e2e-local"].models.map((m: any) => m.id).sort()).toEqual(["model-a", "model-b"]);

			const deleteRes = await api(gw, "/api/custom-providers/e2e-local", { method: "DELETE" });
			expect(deleteRes.status).toBe(200);

			const afterDelete = readModels(gw);
			expect(afterDelete?.providers?.["e2e-local"], "DELETE must remove the provider from models.json").toBeFalsy();
		} finally {
			await gw?.shutdown();
			await mock.close();
		}
	});

	test("GET /api/models lists the custom provider as authenticated (unrelated to any Anthropic credential)", async () => {
		const mock = await startMockOpenAICompatServer(["model-a"]);
		let gw: StartedGateway | undefined;
		try {
			gw = await startSeededGateway();
			// Sanity: no Anthropic credential exists anywhere in this isolated dir.
			expect(existsSync(join(gw.agentDir, "auth.json"))).toBe(false);

			const postRes = await api(gw, "/api/custom-providers", {
				method: "POST",
				body: JSON.stringify({ id: "e2e-local-2", name: "e2e-local-2", type: "vllm", baseUrl: mock.url }),
			});
			expect(postRes.status).toBe(200);

			const modelsRes = await api(gw, "/api/models");
			expect(modelsRes.status).toBe(200);
			const models = await modelsRes.json();
			const custom = models.filter((m: any) => m.provider === "e2e-local-2");
			expect(custom.length).toBeGreaterThan(0);
			for (const m of custom) expect(m.authenticated).toBe(true);
		} finally {
			await gw?.shutdown();
			await mock.close();
		}
	});
});
