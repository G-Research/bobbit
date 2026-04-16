/**
 * E2E tests for AI Gateway model discovery via GET /api/models.
 *
 * Built-in provider structure tests are in tests/models-api.test.ts (unit).
 * These tests require a running gateway to test aigw configure/discover flow.
 */

import { test, expect } from "./in-process-harness.js";
import http from "node:http";
import { apiFetch } from "./e2e-setup.js";

test.describe("GET /api/models with AI Gateway", () => {
	const MOCK_MODELS = {
		data: [
			{ id: "test-provider/custom-model-1", object: "model", created: 1700000000, owned_by: "system" },
			{ id: "test-provider/custom-model-2", object: "model", created: 1700000000, owned_by: "system" },
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

	test("includes gateway models when aigw is configured", async () => {
		// Configure the mock gateway
		const configRes = await apiFetch("/api/aigw/configure", {
			method: "POST",
			body: JSON.stringify({ url: `http://127.0.0.1:${mockPort}` }),
		});
		expect(configRes.status).toBe(200);

		// Fetch unified models
		const res = await apiFetch("/api/models");
		expect(res.status).toBe(200);
		const models = await res.json();

		// Should include aigw models
		const aigwModels = models.filter((m: any) => m.provider === "aigw");
		expect(aigwModels.length).toBeGreaterThanOrEqual(2);

		// Verify aigw model IDs are present
		const aigwIds = aigwModels.map((m: any) => m.id);
		expect(aigwIds).toContain("test-provider/custom-model-1");
		expect(aigwIds).toContain("test-provider/custom-model-2");

		// aigw models should be marked as authenticated
		for (const m of aigwModels) {
			expect(m.authenticated).toBe(true);
		}
	});

	test("fresh discovery on each call (not permanently stale)", async () => {
		// Configure with first mock
		await apiFetch("/api/aigw/configure", {
			method: "POST",
			body: JSON.stringify({ url: `http://127.0.0.1:${mockPort}` }),
		});

		// First call — should have the 2 mock models
		const res1 = await apiFetch("/api/models");
		const models1 = await res1.json();
		const aigw1 = models1.filter((m: any) => m.provider === "aigw");
		expect(aigw1.length).toBeGreaterThanOrEqual(2);

		// Now update the mock server to serve different models
		const NEW_MODELS = {
			data: [
				{ id: "test-provider/custom-model-1", object: "model", created: 1700000000, owned_by: "system" },
				{ id: "test-provider/custom-model-2", object: "model", created: 1700000000, owned_by: "system" },
				{ id: "test-provider/brand-new-model", object: "model", created: 1700000000, owned_by: "system" },
			],
		};

		// Replace the mock server handler
		mockServer.removeAllListeners("request");
		mockServer.on("request", (_req, res) => {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify(NEW_MODELS));
		});

		// Wait for the cache TTL to expire (5 seconds)
		await new Promise(r => setTimeout(r, 5500));

		// Second call — should pick up the new model
		const res2 = await apiFetch("/api/models");
		const models2 = await res2.json();
		const aigw2 = models2.filter((m: any) => m.provider === "aigw");
		const aigwIds2 = aigw2.map((m: any) => m.id);
		expect(aigwIds2).toContain("test-provider/brand-new-model");
	});

	test("built-in providers still included alongside aigw models", async () => {
		// Configure the mock gateway
		await apiFetch("/api/aigw/configure", {
			method: "POST",
			body: JSON.stringify({ url: `http://127.0.0.1:${mockPort}` }),
		});

		const res = await apiFetch("/api/models");
		const models = await res.json();

		const providers = new Set(models.map((m: any) => m.provider));
		// Should have both built-in and aigw
		expect(providers.has("aigw")).toBe(true);
		const hasBuiltIn = providers.has("anthropic") || providers.has("amazon-bedrock");
		expect(hasBuiltIn).toBe(true);
	});
});
