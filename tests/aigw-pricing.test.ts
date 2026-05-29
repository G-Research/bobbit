/**
 * Reproducing test for AI Gateway pricing metadata propagation.
 *
 * AI Gateway /v1/models returns pricing in USD per token. Bobbit must convert
 * that to pi-ai's per-million-token cost shape and expose it through the model
 * registry used by GET /api/models.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { PreferencesStore } = await import("../src/server/agent/preferences-store.ts");
const { getAvailableModels, invalidateModelCache } = await import("../src/server/agent/model-registry.ts");

type MockAigw = {
	url: string;
	close: () => Promise<void>;
	requests: () => string[];
};

function startMockAigw(): Promise<MockAigw> {
	const requests: string[] = [];
	const server = http.createServer((req, res) => {
		requests.push(req.url ?? "");
		if (req.url === "/v1/models") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({
				data: [
					{
						id: "openai/gpt-5.2",
						object: "model",
						created: 1700000000,
						owned_by: "system",
						pricing: {
							prompt: 0.00000125,
							completion: 0.00001,
						},
					},
				],
			}));
			return;
		}
		res.writeHead(500, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: `unexpected AIGW test request: ${req.url}` }));
	});

	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const port = (server.address() as any).port;
			resolve({
				url: `http://127.0.0.1:${port}`,
				close: () => new Promise<void>((r) => server.close(() => r())),
				requests: () => requests,
			});
		});
	});
}

describe("AI Gateway pricing metadata", () => {
	it("converts /v1/models pricing to per-million costs in getAvailableModels output", async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-aigw-pricing-"));
		const mock = await startMockAigw();
		try {
			const prefs = new PreferencesStore(tmpDir);
			prefs.set("aigw.url", mock.url);
			invalidateModelCache();

			const models = await getAvailableModels(prefs as any);
			const aigwModel = models.find((m) => m.provider === "aigw" && m.id === "openai/gpt-5.2");

			assert.ok(aigwModel, "expected mocked AIGW model to appear in getAvailableModels output");
			assert.deepEqual(
				aigwModel.cost,
				{ input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.5625 },
				"AIGW pricing cost should be converted from USD-per-token gateway pricing and exposed via getAvailableModels",
			);
			assert.deepEqual(
				mock.requests(),
				["/v1/models"],
				"AIGW pricing cost discovery must only call the model list endpoint, not aggregate usage/cost endpoints",
			);
		} finally {
			invalidateModelCache();
			await mock.close();
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});
