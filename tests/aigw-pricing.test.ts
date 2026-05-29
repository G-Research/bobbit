/**
 * Reproducing test for AI Gateway pricing metadata propagation.
 *
 * AI Gateway /v1/models returns pricing in USD per token. Bobbit must convert
 * that to pi-ai's per-million-token cost shape and expose it through the model
 * registry used by GET /api/models and the generated agent models.json.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { PreferencesStore } = await import("../src/server/agent/preferences-store.ts");
const { getAvailableModels, invalidateModelCache } = await import("../src/server/agent/model-registry.ts");
const { discoverAigwModels, writeAigwModelsJson } = await import("../src/server/agent/aigw-manager.ts");

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const GPT_52_COST = { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.5625 };
const CLAUDE_COST = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };

type MockAigw = {
	url: string;
	close: () => Promise<void>;
	requests: () => string[];
};

type AigwModelPayload = {
	id: string;
	pricing?: unknown;
	context_window?: number;
	max_tokens?: number;
};

function startMockAigw(models: AigwModelPayload[] = [pricedOpenAiModel()]): Promise<MockAigw> {
	const requests: string[] = [];
	const server = http.createServer((req, res) => {
		requests.push(req.url ?? "");
		if (req.url === "/v1/models") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({
				data: models.map((model) => ({
					object: "model",
					created: 1700000000,
					owned_by: "system",
					...model,
				})),
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

function pricedOpenAiModel(): AigwModelPayload {
	return {
		id: "openai/gpt-5.2",
		pricing: {
			prompt: 0.00000125,
			completion: 0.00001,
		},
	};
}

function pricedClaudeModel(): AigwModelPayload {
	return {
		id: "aws/us.anthropic.claude-sonnet-4-5-v1:0",
		pricing: {
			prompt: 0.000003,
			completion: 0.000015,
		},
	};
}

function readModelsJson(agentDir: string): any {
	return JSON.parse(fs.readFileSync(path.join(agentDir, "models.json"), "utf-8"));
}

async function withMockAigw<T>(models: AigwModelPayload[], fn: (mock: MockAigw) => Promise<T>): Promise<T> {
	const mock = await startMockAigw(models);
	try {
		return await fn(mock);
	} finally {
		await mock.close();
	}
}

describe("AI Gateway pricing metadata", () => {
	it("converts /v1/models pricing to per-million costs in discoverAigwModels output", async () => {
		await withMockAigw([pricedOpenAiModel()], async (mock) => {
			const models = await discoverAigwModels(mock.url);
			const aigwModel = models.find((m: any) => m.id === "openai/gpt-5.2") as any;

			assert.ok(aigwModel, "expected mocked AIGW model to appear in discoverAigwModels output");
			assert.deepEqual(
				aigwModel.cost,
				GPT_52_COST,
				"AIGW discovery should convert gateway USD-per-token pricing to per-million cost metadata",
			);
			assert.deepEqual(
				mock.requests(),
				["/v1/models"],
				"AIGW pricing discovery must not call unavailable aggregate usage/cost endpoints",
			);
		});
	});

	it("falls back to zero cost for missing or malformed /v1/models pricing without throwing", async () => {
		await withMockAigw([
			{ id: "openai/missing-pricing" },
			{ id: "openai/malformed-pricing", pricing: { prompt: "not-a-number", completion: 0.000002 } },
			{ id: "openai/incomplete-pricing", pricing: { prompt: 0.000001 } },
		], async (mock) => {
			const models = await discoverAigwModels(mock.url);

			for (const id of ["openai/missing-pricing", "openai/malformed-pricing", "openai/incomplete-pricing"]) {
				const model = models.find((m: any) => m.id === id) as any;
				assert.ok(model, `expected ${id} to be returned from discovery`);
				assert.deepEqual(model.cost, ZERO_COST, `${id} should use the safe zero-cost fallback`);
			}
			assert.deepEqual(mock.requests(), ["/v1/models"]);
		});
	});

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
				GPT_52_COST,
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

	it("persists cost on generated AIGW model entries for Claude/Bedrock and non-Claude routes", async () => {
		const previousAgentDir = process.env.BOBBIT_AGENT_DIR;
		const tmpAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-aigw-pricing-models-"));
		try {
			process.env.BOBBIT_AGENT_DIR = tmpAgentDir;
			const mock = await startMockAigw([pricedOpenAiModel(), pricedClaudeModel()]);
			try {
				const discoveredModels = await discoverAigwModels(mock.url);

				writeAigwModelsJson(`${mock.url}/v1`, discoveredModels);

				const data = readModelsJson(tmpAgentDir);
				const persistedModels = data.providers.aigw.models;
				const openAiEntry = persistedModels.find((m: any) => m.id === "openai/gpt-5.2");
				const claudeEntry = persistedModels.find((m: any) => m.id === "us.anthropic.claude-sonnet-4-5-v1:0");

				assert.ok(openAiEntry, "expected non-Claude AIGW entry in models.json");
				assert.ok(claudeEntry, "expected Claude AIGW entry to be persisted with Bedrock-stripped id");
				assert.equal(openAiEntry.api ?? "openai-completions", "openai-completions");
				assert.equal(claudeEntry.api, "bedrock-converse-stream");
				assert.deepEqual(openAiEntry.cost, GPT_52_COST, "non-Claude generated model entry should preserve discovered cost");
				assert.deepEqual(claudeEntry.cost, CLAUDE_COST, "Claude Bedrock-routed generated model entry should preserve discovered cost");
				assert.deepEqual(mock.requests(), ["/v1/models"]);
			} finally {
				await mock.close();
			}
		} finally {
			if (previousAgentDir === undefined) delete process.env.BOBBIT_AGENT_DIR;
			else process.env.BOBBIT_AGENT_DIR = previousAgentDir;
			fs.rmSync(tmpAgentDir, { recursive: true, force: true });
		}
	});
});
