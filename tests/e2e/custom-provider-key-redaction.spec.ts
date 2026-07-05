/**
 * API E2E tests pinning the custom-provider API-key redaction contract.
 *
 * Security bug this pins (found live 2026-07-05, caused a key rotation):
 * GET /api/custom-providers returned every stored provider `apiKey` in
 * CLEARTEXT to any reader of the endpoint (Settings UI network tab, local
 * tools, agent transcripts that curl it).
 *
 * Contract (see redactCustomProviderConfig in src/server/agent/model-registry.ts):
 *   READ  — every serialization of a provider config to the client omits
 *           `apiKey` and carries `hasApiKey: boolean` instead. This covers
 *           GET /api/custom-providers AND the POST save-acknowledgement echo.
 *   WRITE — POST /api/custom-providers apiKey semantics:
 *             non-empty string → set/replace the stored key
 *             explicit null    → clear the stored key
 *             omitted or ""    → PRESERVE the stored key (the classic
 *                                footgun: the edit dialog can never resend
 *                                the key it never received — an unrelated
 *                                edit must not wipe the secret)
 *   TEST  — POST /api/custom-providers/test with no apiKey but a known
 *           provider id falls back to the STORED key server-side (the edit
 *           dialog can no longer supply it).
 *
 * Standalone per-test gateway (own temp .bobbit dir, own port), mirroring
 * tests/e2e/custom-provider-models-json-sync.spec.ts. No live LLM calls —
 * the mock server only serves GET /v1/models and records Authorization
 * headers so the stored-key fallback is observable.
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

// Fake keys only — never a real credential in this file.
const FAKE_KEY = "sk-fake-e2e-redaction-key-000001";
const FAKE_KEY_2 = "sk-fake-e2e-redaction-key-000002";

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
	preferencesPath: string;
	token: string;
	shutdown: () => Promise<void>;
}

async function startSeededGateway(opts: SeedOpts = {}): Promise<StartedGateway> {
	mkdirSync(E2E_TEMP_ROOT, { recursive: true });
	const bobbitDir = join(
		E2E_TEMP_ROOT,
		`.e2e-custom-provider-redaction-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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
		preferencesPath: join(bobbitDir, "state", "preferences.json"),
		token,
		shutdown: async () => {
			await gw.shutdown();
			try { rmSync(bobbitDir, { recursive: true, force: true }); } catch { /* best-effort */ }
		},
	};
}

/** Mock OpenAI-compat server that records the Authorization header of every request. */
function startMockOpenAICompatServer(modelIds: string[]): Promise<{
	url: string;
	authHeaders: string[];
	close: () => Promise<void>;
}> {
	const authHeaders: string[] = [];
	const server = http.createServer((req, res) => {
		authHeaders.push(String(req.headers["authorization"] || ""));
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
				authHeaders,
				close: () => new Promise<void>((r) => server.close(() => r())),
			});
		});
	});
}

function readStoredProviders(gw: StartedGateway): any[] {
	if (!existsSync(gw.preferencesPath)) return [];
	return JSON.parse(readFileSync(gw.preferencesPath, "utf-8")).customProviders || [];
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

test.describe("Custom provider API-key redaction (E2E)", () => {
	test("GET /api/custom-providers never returns stored keys — redacted to hasApiKey", async () => {
		let gw: StartedGateway | undefined;
		try {
			gw = await startSeededGateway({
				preferences: {
					customProviders: [
						{ id: "with-key", name: "with-key", type: "manual", baseUrl: "http://127.0.0.1:1", apiKey: FAKE_KEY, models: [{ id: "m1", name: "m1" }] },
						{ id: "no-key", name: "no-key", type: "manual", baseUrl: "http://127.0.0.1:1", models: [{ id: "m2", name: "m2" }] },
					],
				},
			});

			const res = await api(gw, "/api/custom-providers");
			expect(res.status).toBe(200);
			const raw = await res.text();
			// The strongest assertion: the raw key must not appear ANYWHERE in the payload.
			expect(raw).not.toContain(FAKE_KEY);

			const configs = JSON.parse(raw);
			const withKey = configs.find((c: any) => c.id === "with-key");
			const noKey = configs.find((c: any) => c.id === "no-key");
			expect(withKey).toBeTruthy();
			expect(noKey).toBeTruthy();
			expect("apiKey" in withKey, "apiKey must be omitted, not masked or blanked").toBe(false);
			expect("apiKey" in noKey).toBe(false);
			expect(withKey.hasApiKey).toBe(true);
			expect(noKey.hasApiKey).toBe(false);
			// Non-secret fields still round-trip.
			expect(withKey.baseUrl).toBe("http://127.0.0.1:1");
			expect(withKey.models.map((m: any) => m.id)).toEqual(["m1"]);
		} finally {
			await gw?.shutdown();
		}
	});

	test("POST save acknowledgement echo is redacted; key is stored server-side", async () => {
		let gw: StartedGateway | undefined;
		try {
			gw = await startSeededGateway();

			const res = await api(gw, "/api/custom-providers", {
				method: "POST",
				body: JSON.stringify({
					id: "p1", name: "p1", type: "manual", baseUrl: "http://127.0.0.1:1",
					apiKey: FAKE_KEY, models: [{ id: "m1", name: "m1" }],
				}),
			});
			expect(res.status).toBe(200);
			const raw = await res.text();
			expect(raw, "save echo must not contain the raw key").not.toContain(FAKE_KEY);
			const body = JSON.parse(raw);
			expect(body.ok).toBe(true);
			expect("apiKey" in body.config).toBe(false);
			expect(body.config.hasApiKey).toBe(true);

			// The key IS persisted server-side (write path unaffected by redaction).
			const stored = readStoredProviders(gw).find((c) => c.id === "p1");
			expect(stored?.apiKey).toBe(FAKE_KEY);
		} finally {
			await gw?.shutdown();
		}
	});

	test("update WITHOUT apiKey (omitted or empty) preserves the stored key — never wiped or mask-overwritten", async () => {
		let gw: StartedGateway | undefined;
		try {
			gw = await startSeededGateway({
				preferences: {
					customProviders: [
						{ id: "p1", name: "p1", type: "manual", baseUrl: "http://127.0.0.1:1", apiKey: FAKE_KEY, models: [{ id: "m1", name: "m1" }] },
					],
				},
			});

			// Rename with apiKey omitted — the edit dialog never receives the
			// stored key, so this is exactly what it sends.
			let res = await api(gw, "/api/custom-providers", {
				method: "POST",
				body: JSON.stringify({ id: "p1", name: "p1-renamed", type: "manual", baseUrl: "http://127.0.0.1:1", models: [{ id: "m1", name: "m1" }] }),
			});
			expect(res.status).toBe(200);
			let stored = readStoredProviders(gw).find((c) => c.id === "p1");
			expect(stored?.name).toBe("p1-renamed");
			expect(stored?.apiKey, "omitted apiKey must preserve the stored key").toBe(FAKE_KEY);

			// Empty string is also "untouched", not "clear".
			res = await api(gw, "/api/custom-providers", {
				method: "POST",
				body: JSON.stringify({ id: "p1", name: "p1", type: "manual", baseUrl: "http://127.0.0.1:1", apiKey: "", models: [{ id: "m1", name: "m1" }] }),
			});
			expect(res.status).toBe(200);
			stored = readStoredProviders(gw).find((c) => c.id === "p1");
			expect(stored?.apiKey, "empty-string apiKey must preserve the stored key").toBe(FAKE_KEY);

			// And the GET still reports hasApiKey without leaking it.
			const getRaw = await (await api(gw, "/api/custom-providers")).text();
			expect(getRaw).not.toContain(FAKE_KEY);
			expect(JSON.parse(getRaw).find((c: any) => c.id === "p1").hasApiKey).toBe(true);
		} finally {
			await gw?.shutdown();
		}
	});

	test("update WITH a new key overwrites; explicit null clears", async () => {
		let gw: StartedGateway | undefined;
		try {
			gw = await startSeededGateway({
				preferences: {
					customProviders: [
						{ id: "p1", name: "p1", type: "manual", baseUrl: "http://127.0.0.1:1", apiKey: FAKE_KEY, models: [{ id: "m1", name: "m1" }] },
					],
				},
			});

			// New key replaces the old one.
			let res = await api(gw, "/api/custom-providers", {
				method: "POST",
				body: JSON.stringify({ id: "p1", name: "p1", type: "manual", baseUrl: "http://127.0.0.1:1", apiKey: FAKE_KEY_2, models: [{ id: "m1", name: "m1" }] }),
			});
			expect(res.status).toBe(200);
			let stored = readStoredProviders(gw).find((c) => c.id === "p1");
			expect(stored?.apiKey).toBe(FAKE_KEY_2);

			// Explicit null clears the stored key.
			res = await api(gw, "/api/custom-providers", {
				method: "POST",
				body: JSON.stringify({ id: "p1", name: "p1", type: "manual", baseUrl: "http://127.0.0.1:1", apiKey: null, models: [{ id: "m1", name: "m1" }] }),
			});
			expect(res.status).toBe(200);
			stored = readStoredProviders(gw).find((c) => c.id === "p1");
			expect(stored && "apiKey" in stored, "null must clear the stored key").toBe(false);

			const configs = await (await api(gw, "/api/custom-providers")).json();
			expect(configs.find((c: any) => c.id === "p1").hasApiKey).toBe(false);
		} finally {
			await gw?.shutdown();
		}
	});

	test("POST /api/custom-providers/test with no apiKey falls back to the STORED key (edit-dialog test-connection)", async () => {
		const mock = await startMockOpenAICompatServer(["model-a"]);
		let gw: StartedGateway | undefined;
		try {
			gw = await startSeededGateway({
				preferences: {
					customProviders: [
						{ id: "p-vllm", name: "p-vllm", type: "vllm", baseUrl: mock.url, apiKey: FAKE_KEY },
					],
				},
			});

			// Edit flow: dialog has the provider id but never got the key back.
			mock.authHeaders.length = 0;
			let res = await api(gw, "/api/custom-providers/test", {
				method: "POST",
				body: JSON.stringify({ id: "p-vllm", name: "p-vllm", type: "vllm", baseUrl: mock.url }),
			});
			expect(res.status).toBe(200);
			expect((await res.json()).models.map((m: any) => m.id)).toContain("model-a");
			expect(mock.authHeaders, "server must have used the STORED key").toContain(`Bearer ${FAKE_KEY}`);

			// A key typed into the dialog still wins over the stored one.
			mock.authHeaders.length = 0;
			res = await api(gw, "/api/custom-providers/test", {
				method: "POST",
				body: JSON.stringify({ id: "p-vllm", name: "p-vllm", type: "vllm", baseUrl: mock.url, apiKey: FAKE_KEY_2 }),
			});
			expect(res.status).toBe(200);
			expect(mock.authHeaders).toContain(`Bearer ${FAKE_KEY_2}`);
			expect(mock.authHeaders).not.toContain(`Bearer ${FAKE_KEY}`);

			// Trailing-slash difference is still the same destination — the
			// normalization must not force users to retype the key over a "/".
			mock.authHeaders.length = 0;
			res = await api(gw, "/api/custom-providers/test", {
				method: "POST",
				body: JSON.stringify({ id: "p-vllm", name: "p-vllm", type: "vllm", baseUrl: `${mock.url}/` }),
			});
			expect(res.status).toBe(200);
			expect(mock.authHeaders, "trailing slash must still match the stored baseUrl").toContain(`Bearer ${FAKE_KEY}`);
		} finally {
			await gw?.shutdown();
			await mock.close();
		}
	});

	test("SECURITY: /test with a stored id but a DIFFERENT baseUrl must NOT export the stored key (anti-exfiltration)", async () => {
		// mockA is the saved destination; mockB plays the attacker-chosen URL.
		const mockA = await startMockOpenAICompatServer(["model-a"]);
		const mockB = await startMockOpenAICompatServer(["model-b"]);
		let gw: StartedGateway | undefined;
		try {
			gw = await startSeededGateway({
				preferences: {
					customProviders: [
						{ id: "p-vllm", name: "p-vllm", type: "vllm", baseUrl: mockA.url, apiKey: FAKE_KEY },
					],
				},
			});

			mockA.authHeaders.length = 0;
			mockB.authHeaders.length = 0;
			const res = await api(gw, "/api/custom-providers/test", {
				method: "POST",
				body: JSON.stringify({ id: "p-vllm", name: "p-vllm", type: "vllm", baseUrl: mockB.url }),
			});
			// The test still runs (new-destination test) — just without a key.
			expect(res.status).toBe(200);
			expect((await res.json()).models.map((m: any) => m.id)).toContain("model-b");
			// The stored key must not have been sent ANYWHERE: the outbound
			// request to the caller-chosen URL carries no Authorization at all.
			expect(mockB.authHeaders.length).toBeGreaterThan(0);
			for (const h of mockB.authHeaders) expect(h, "no Authorization header may reach a non-matching baseUrl").toBe("");
			expect(mockB.authHeaders.join("|")).not.toContain(FAKE_KEY);
			expect(mockA.authHeaders, "the saved destination must not be contacted either").toHaveLength(0);
		} finally {
			await gw?.shutdown();
			await mockA.close();
			await mockB.close();
		}
	});
});
