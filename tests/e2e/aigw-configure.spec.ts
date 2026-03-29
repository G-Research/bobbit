/**
 * E2E tests for the full AI Gateway configure flow using a mock gateway.
 *
 * Spins up a tiny HTTP server that mimics the /v1/models endpoint,
 * then tests configure → status → model discovery end-to-end.
 */

import { test, expect } from "./gateway-harness.js";
import http from "node:http";
import { apiFetch } from "./e2e-setup.js";

const MOCK_MODELS = {
	data: [
		{ id: "openai/gpt-5.2", object: "model", created: 1700000000, owned_by: "system" },
		{ id: "aws/us.anthropic.claude-sonnet-4-6", object: "model", created: 1700000000, owned_by: "system" },
		{ id: "gresearch/qwen3-coder-480b-a35b", object: "model", created: 1700000000, owned_by: "system" },
	],
};

let mockServer: http.Server;
let mockPort: number;

test.beforeAll(async () => {
	mockServer = http.createServer((_req, res) => {
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
});

test.describe("AI Gateway Configure Flow", () => {
	test("test connection discovers models without saving", async () => {
		const res = await apiFetch("/api/aigw/test", {
			method: "POST",
			body: JSON.stringify({ url: `http://127.0.0.1:${mockPort}` }),
		});
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.ok).toBe(true);
		expect(data.models).toHaveLength(3);

		// Should NOT be configured after test
		const status = await apiFetch("/api/aigw/status");
		const statusData = await status.json();
		expect(statusData.configured).toBe(false);
	});

	test("configure discovers models and persists config", async () => {
		const res = await apiFetch("/api/aigw/configure", {
			method: "POST",
			body: JSON.stringify({ url: `http://127.0.0.1:${mockPort}` }),
		});
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.ok).toBe(true);
		expect(data.models).toHaveLength(3);

		// Verify model IDs — Claude models get prefix stripped (Bedrock API)
		const ids = data.models.map((m: any) => m.id);
		expect(ids).toContain("openai/gpt-5.2");
		expect(ids).toContain("us.anthropic.claude-sonnet-4-6");
		expect(ids).toContain("gresearch/qwen3-coder-480b-a35b");
	});

	test("status returns configured state and models", async () => {
		// Configure first
		await apiFetch("/api/aigw/configure", {
			method: "POST",
			body: JSON.stringify({ url: `http://127.0.0.1:${mockPort}` }),
		});

		const res = await apiFetch("/api/aigw/status");
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.configured).toBe(true);
		expect(data.url).toBe(`http://127.0.0.1:${mockPort}`);
		expect(data.models).toHaveLength(3);
	});

	test("model metadata is inferred correctly", async () => {
		const res = await apiFetch("/api/aigw/configure", {
			method: "POST",
			body: JSON.stringify({ url: `http://127.0.0.1:${mockPort}` }),
		});
		const data = await res.json();

		const gpt = data.models.find((m: any) => m.id === "openai/gpt-5.2");
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

		// Proxy request
		const res = await apiFetch("/api/aigw/v1/models");
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.data).toHaveLength(3);
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
