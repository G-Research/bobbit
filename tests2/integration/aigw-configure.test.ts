/**
 * E2E tests for the full AI Gateway configure flow using a mock gateway.
 *
 * Spins up a tiny HTTP server that mimics the /v1/models endpoint,
 * then tests configure → status → model discovery end-to-end.
 */

import { test, expect } from "./_e2e/in-process-harness.js";
import http from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { apiFetch } from "./_e2e/e2e-setup.js";
import { configureAigwRuntimeFlags } from "../../src/server/agent/aigw-manager.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..", "..");
const PACKAGE_VERSION = JSON.parse(readFileSync(resolve(PROJECT_ROOT, "package.json"), "utf-8")).version;
const EXPECTED_USER_AGENT = `Bobbit/${PACKAGE_VERSION}`;

const MOCK_MODELS = {
	data: [
		{ id: "openai/gpt-5.2", object: "model", created: 1700000000, owned_by: "system" },
		{ id: "aws/us.anthropic.claude-sonnet-4-6", object: "model", created: 1700000000, owned_by: "system" },
		{ id: "gresearch/qwen3-coder-480b-a35b", object: "model", created: 1700000000, owned_by: "system" },
	],
};

interface RecordedRequest {
	method?: string;
	url?: string;
	headers: http.IncomingHttpHeaders;
	rawHeaders: string[];
}

let mockServer: http.Server;
let mockPort: number;
let recordedRequests: RecordedRequest[] = [];

function resetRecordedRequests(): void {
	recordedRequests = [];
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
	expect(record, "mock gateway should have recorded a matching request").toBeTruthy();
	expect(record!.headers["user-agent"]).toBe(EXPECTED_USER_AGENT);
	expect(userAgentValues(record!)).toEqual([EXPECTED_USER_AGENT]);
}

function lastRecordedRequest(path: string): RecordedRequest | undefined {
	return [...recordedRequests].reverse().find((record) => record.url === path);
}

async function readRequestJson(req: http.IncomingMessage): Promise<any> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(Buffer.from(chunk));
	const text = Buffer.concat(chunks).toString("utf-8");
	return text ? JSON.parse(text) : {};
}

test.beforeAll(async () => {
	mockServer = http.createServer((req, res) => {
		recordedRequests.push({
			method: req.method,
			url: req.url,
			headers: req.headers,
			rawHeaders: [...req.rawHeaders],
		});
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify(MOCK_MODELS));
	});
	await new Promise<void>((resolve) => {
		mockServer.listen(0, "127.0.0.1", () => {
			mockPort = (mockServer.address() as any).port;
			resolve();
		});
	});
});

test.afterAll(async () => {
	mockServer?.close();
});

test.afterEach(async () => {
	await apiFetch("/api/aigw/configure", { method: "DELETE" });
	resetRecordedRequests();
});

test.describe("AI Gateway Configure Flow", () => {
	test("test connection discovers models without saving", async () => {
		resetRecordedRequests();
		const res = await apiFetch("/api/aigw/test", {
			method: "POST",
			body: JSON.stringify({ url: `http://127.0.0.1:${mockPort}` }),
		});
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.ok).toBe(true);
		expect(data.models).toHaveLength(3);
		expectSingleBobbitUserAgent(lastRecordedRequest("/v1/models"));

		// Should NOT be configured after test
		const status = await apiFetch("/api/aigw/status");
		const statusData = await status.json();
		expect(statusData.configured).toBe(false);
	});

	test("configure discovers models and persists config", async () => {
		resetRecordedRequests();
		const res = await apiFetch("/api/aigw/configure", {
			method: "POST",
			body: JSON.stringify({ url: `http://127.0.0.1:${mockPort}` }),
		});
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.ok).toBe(true);
		expect(data.models).toHaveLength(3);
		expectSingleBobbitUserAgent(lastRecordedRequest("/v1/models"));

		// Verify model IDs — Claude models get prefix stripped (Bedrock API); gpt-5.2
		// is a reasoning model so the option-1 fix routes it to openai-responses with
		// a BARE wire id ("openai/gpt-5.2" → "gpt-5.2").
		const ids = data.models.map((m: any) => m.id);
		expect(ids).toContain("gpt-5.2");
		expect(ids).toContain("us.anthropic.claude-sonnet-4-6");
		expect(ids).toContain("gresearch/qwen3-coder-480b-a35b");
	});

	test("status returns configured state and models", async () => {
		// Configure first
		await apiFetch("/api/aigw/configure", {
			method: "POST",
			body: JSON.stringify({ url: `http://127.0.0.1:${mockPort}` }),
		});
		resetRecordedRequests();

		const res = await apiFetch("/api/aigw/status");
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.configured).toBe(true);
		expect(data.url).toBe(`http://127.0.0.1:${mockPort}`);
		expect(data.models).toHaveLength(3);
		expectSingleBobbitUserAgent(lastRecordedRequest("/v1/models"));
	});

	test("refresh re-discovers models with the Bobbit User-Agent", async ({ gateway }) => {
		await apiFetch("/api/aigw/configure", {
			method: "POST",
			body: JSON.stringify({ url: `http://127.0.0.1:${mockPort}` }),
		});
		resetRecordedRequests();
		(gateway.sessionManager as any)._aigwModelCache = {
			url: `http://127.0.0.1:${mockPort}`,
			models: [{ id: "removed-old-model" }],
			ts: Date.now(),
		};

		const res = await apiFetch("/api/aigw/refresh", { method: "POST" });
		expect(res.status).toBe(200);
		expect((gateway.sessionManager as any)._aigwModelCache).toBeNull();
		const data = await res.json();
		expect(data.models).toHaveLength(3);
		expectSingleBobbitUserAgent(lastRecordedRequest("/v1/models"));
	});

	test("configure, refresh, and delete remain committed when sandbox remount recovery fails", async ({ gateway }) => {
		const sandboxManager = gateway.sessionManager.getSandboxManager();
		expect(sandboxManager).toBeTruthy();
		const originalRefresh = sandboxManager!.refreshAgentModelMounts.bind(sandboxManager);
		(sandboxManager as any).refreshAgentModelMounts = async () => { throw new Error("simulated remount failure"); };
		try {
			(gateway.sessionManager as any)._aigwModelCache = { url: "stale", models: [{ id: "stale" }], ts: Date.now() };
			const configureRes = await apiFetch("/api/aigw/configure", {
				method: "POST",
				body: JSON.stringify({ url: `http://127.0.0.1:${mockPort}` }),
			});
			expect(configureRes.status).toBe(200);
			expect(await configureRes.json()).toMatchObject({ ok: true, remountPending: true });
			expect((gateway.sessionManager as any)._aigwModelCache).toBeNull();
			expect((await (await apiFetch("/api/aigw/status")).json()).configured).toBe(true);

			(gateway.sessionManager as any)._aigwModelCache = { url: "stale", models: [{ id: "stale" }], ts: Date.now() };
			const refreshRes = await apiFetch("/api/aigw/refresh", { method: "POST" });
			expect(refreshRes.status).toBe(200);
			expect(await refreshRes.json()).toMatchObject({ remountPending: true });
			expect((gateway.sessionManager as any)._aigwModelCache).toBeNull();

			(gateway.sessionManager as any)._aigwModelCache = { url: "stale", models: [{ id: "stale" }], ts: Date.now() };
			const deleteRes = await apiFetch("/api/aigw/configure", { method: "DELETE" });
			expect(deleteRes.status).toBe(200);
			expect(await deleteRes.json()).toMatchObject({ ok: true, remountPending: true });
			expect((gateway.sessionManager as any)._aigwModelCache).toBeNull();
			expect((await (await apiFetch("/api/aigw/status")).json()).configured).toBe(false);
		} finally {
			(sandboxManager as any).refreshAgentModelMounts = originalRefresh;
		}
	});

	test("model metadata is inferred correctly", async () => {
		const res = await apiFetch("/api/aigw/configure", {
			method: "POST",
			body: JSON.stringify({ url: `http://127.0.0.1:${mockPort}` }),
		});
		const data = await res.json();

		const gpt = data.models.find((m: any) => m.id === "gpt-5.2");
		expect(gpt).toBeTruthy();
		expect(gpt.contextWindow).toBe(400_000);
		expect(gpt.input).toContain("image");

		const claude = data.models.find((m: any) => m.id === "us.anthropic.claude-sonnet-4-6");
		expect(claude).toBeTruthy();
		expect(claude.contextWindow).toBe(1_000_000);
		expect(claude.reasoning).toBe(true);

		const qwen = data.models.find((m: any) => m.id === "gresearch/qwen3-coder-480b-a35b");
		expect(qwen).toBeTruthy();
		expect(qwen.input).toContain("text");
	});

	test("delete removes configuration", async () => {
		// Configure first
		await apiFetch("/api/aigw/configure", {
			method: "POST",
			body: JSON.stringify({ url: `http://127.0.0.1:${mockPort}` }),
		});

		// Delete
		const delRes = await apiFetch("/api/aigw/configure", { method: "DELETE" });
		expect(delRes.status).toBe(200);

		// Verify unconfigured
		const status = await apiFetch("/api/aigw/status");
		const data = await status.json();
		expect(data.configured).toBe(false);
	});

	test("proxy route forwards to gateway when configured", async () => {
		// Configure
		await apiFetch("/api/aigw/configure", {
			method: "POST",
			body: JSON.stringify({ url: `http://127.0.0.1:${mockPort}` }),
		});
		resetRecordedRequests();

		// Proxy request with a deliberately wrong incoming User-Agent. The server
		// must replace it with Bobbit/<version>, not forward the client header.
		const res = await apiFetch("/api/aigw/v1/models", {
			headers: { "User-Agent": "WrongClient/9.9" },
		});
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.data).toHaveLength(3);
		expectSingleBobbitUserAgent(lastRecordedRequest("/v1/models"));
	});

	test("preferences reflect aigw config", async () => {
		await apiFetch("/api/aigw/configure", {
			method: "POST",
			body: JSON.stringify({ url: `http://127.0.0.1:${mockPort}` }),
		});

		const res = await apiFetch("/api/preferences");
		const prefs = await res.json();
		expect(prefs["aigw.url"]).toBe(`http://127.0.0.1:${mockPort}`);
		// aigw.models is no longer cached in preferences — models are discovered fresh via GET /api/models
	});

	test("/api/models/test keeps legacy fallback completions probes under /v1", async () => {
		await apiFetch("/api/aigw/configure", {
			method: "POST",
			body: JSON.stringify({ url: `http://127.0.0.1:${mockPort}` }),
		});
		resetRecordedRequests();
		const response = await apiFetch("/api/models/test", {
			method: "POST",
			body: JSON.stringify({ pref: "aigw/gresearch/qwen3-coder-480b-a35b" }),
		});
		expect(response.status).toBe(200);
		expect((await response.json()).ok).toBe(true);
		expect(lastRecordedRequest("/v1/chat/completions")?.method).toBe("POST");
		expect(lastRecordedRequest("/chat/completions")).toBeUndefined();
	});

	test("/api/models/test probes well-known openai-responses models on their per-provider baseUrl", async () => {
		const requests: Array<{ method?: string; url?: string; body?: any }> = [];
		const server = http.createServer(async (req, res) => {
			let body: any | undefined;
			if (req.method === "POST") body = await readRequestJson(req);
			requests.push({ method: req.method, url: req.url, body });
			res.setHeader("Content-Type", "application/json");
			if (req.url?.startsWith("/.well-known/opencode")) {
				res.end(JSON.stringify({
					provider: {
						openai: {
							npm: "@ai-sdk/openai",
							options: { baseURL: `http://127.0.0.1:${wellKnownPort}/openai/v1` },
							models: { "gpt-5.5": { name: "gpt-5.5", reasoning: true, limit: { context: 272000, output: 128000 } } },
						},
						"aws-mantle": {
							npm: "@ai-sdk/openai",
							options: { baseURL: `http://127.0.0.1:${wellKnownPort}/aws/openai/v1` },
							models: { "openai.gpt-5.5": { name: "openai.gpt-5.5", reasoning: true, limit: { context: 272000, output: 128000 } } },
						},
					},
				}));
				return;
			}
			if (req.url === "/openai/v1/responses" || req.url === "/aws/openai/v1/responses") {
				res.end(JSON.stringify({ id: "resp_test", status: "completed", object: "response" }));
				return;
			}
			if (req.url === "/v1/models") {
				res.end(JSON.stringify({ data: [{ id: "openai/gpt-5.5" }, { id: "aws/openai.gpt-5.5" }] }));
				return;
			}
			res.writeHead(400);
			res.end(JSON.stringify({ error: `unexpected ${req.method} ${req.url}` }));
		});
		let wellKnownPort = 0;
		await new Promise<void>((resolve) => {
			server.listen(0, "127.0.0.1", () => {
				wellKnownPort = (server.address() as any).port;
				resolve();
			});
		});
		try {
			configureAigwRuntimeFlags({ skipAigwDiscovery: false });
			const configureRes = await apiFetch("/api/aigw/configure", {
				method: "POST",
				body: JSON.stringify({ url: `http://127.0.0.1:${wellKnownPort}` }),
			});
			expect(configureRes.status).toBe(200);
			const configureData = await configureRes.json();
			const configuredOpenAi = configureData.models.find((m: any) => m.id === "openai.gpt-5.5");
			expect(configuredOpenAi?.upstreamProvider).toBe("aws-mantle");

			const testRes = await apiFetch("/api/models/test", {
				method: "POST",
				body: JSON.stringify({ pref: "aigw/openai.gpt-5.5" }),
			});
			expect(testRes.status).toBe(200);
			const data = await testRes.json();
			expect(data.ok).toBe(true);
			expect(data.modelResolved).toBe("openai.gpt-5.5");

			const responseProbe = requests.find((r) => r.method === "POST" && r.url === "/aws/openai/v1/responses");
			expect(responseProbe).toBeTruthy();
			expect(responseProbe!.body).toMatchObject({
				model: "openai.gpt-5.5",
				max_output_tokens: 16,
				input: "Reply with OK",
			});

			const legacyPrefRes = await apiFetch("/api/models/test", {
				method: "POST",
				body: JSON.stringify({ pref: "aigw/openai/gpt-5.5" }),
			});
			expect(legacyPrefRes.status).toBe(200);
			const legacyPrefData = await legacyPrefRes.json();
			expect(legacyPrefData.ok).toBe(true);
			expect(legacyPrefData.modelResolved).toBe("gpt-5.5");
			expect(requests.some((r) => r.method === "POST" && r.url === "/v1/chat/completions")).toBe(false);
		} finally {
			configureAigwRuntimeFlags({ skipAigwDiscovery: true });
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});

	test("/api/models returns aigw Claude IDs with prefix stripped (regression: model picker silently fails)", async () => {
		// Regression test for the bug where picking a Claude model served by the
		// AI Gateway via the prompt model picker appeared to succeed but actually
		// did not switch the agent's bound model: a subsequent prompt went to the
		// previously bound model, and refreshing snapped the UI back.
		//
		// Root cause: configureAigw() strips the provider prefix from Claude IDs
		// when writing models.json (e.g. "aws/us.anthropic.claude-..." becomes
		// "us.anthropic.claude-..."), but GET /api/models (which powers the
		// ModelSelector popover) was returning the raw prefixed IDs. The agent's
		// rpc `set_model` does a strict equality match against models.json, so the
		// lookup failed, the error was swallowed by the WS handler, and the UI
		// optimistically updated to a model the agent never actually switched to.
		//
		// Guarantee: IDs surfaced by /api/models for the `aigw` provider must
		// match the IDs written to models.json — i.e. Claude models must be
		// prefix-stripped and tagged api=bedrock-converse-stream; non-Claude
		// models retain their original form.
		const configureRes = await apiFetch("/api/aigw/configure", {
			method: "POST",
			body: JSON.stringify({ url: `http://127.0.0.1:${mockPort}` }),
		});
		const configureData = await configureRes.json();

		const res = await apiFetch("/api/models");
		expect(res.status).toBe(200);
		const models = await res.json();

		const aigwModels = models.filter((m: any) => m.provider === "aigw");
		expect(aigwModels.length).toBe(3);

		// Claude: prefix stripped, routed through Bedrock Converse
		const claude = aigwModels.find((m: any) => m.id.includes("claude"));
		expect(claude).toBeTruthy();
		expect(claude.id).toBe("us.anthropic.claude-sonnet-4-6");
		expect(claude.id).not.toContain("/");
		expect(claude.api).toBe("bedrock-converse-stream");

		// gpt-5.2 is a reasoning model → option-1 routes it to openai-responses on
		// the dedicated /openai/v1 subpath with a BARE wire id (no provider prefix).
		const gpt = aigwModels.find((m: any) => m.id.includes("gpt"));
		expect(gpt).toBeTruthy();
		expect(gpt.id).toBe("gpt-5.2");
		expect(gpt.api).toBe("openai-responses");

		const qwen = aigwModels.find((m: any) => m.id.includes("qwen"));
		expect(qwen).toBeTruthy();
		expect(qwen.id).toBe("gresearch/qwen3-coder-480b-a35b");

		// The critical invariant: every aigw ID surfaced by /api/models must
		// also exist in models.json (reflected by the configure response, which
		// applies the same transform before persisting). Without this, the
		// agent's strict-equality set_model lookup silently rejects the pick.
		const modelsJsonIds = new Set(configureData.models.map((m: any) => m.id));
		for (const m of aigwModels) {
			expect(modelsJsonIds.has(m.id)).toBe(true);
		}
	});

	test("preferences cleaned after delete", async () => {
		await apiFetch("/api/aigw/configure", {
			method: "POST",
			body: JSON.stringify({ url: `http://127.0.0.1:${mockPort}` }),
		});
		await apiFetch("/api/aigw/configure", { method: "DELETE" });

		const res = await apiFetch("/api/preferences");
		const prefs = await res.json();
		expect(prefs["aigw.url"]).toBeUndefined();
		// aigw.models is no longer stored in preferences
	});
});
