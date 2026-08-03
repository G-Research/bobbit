// v2-native — type-specific provider blocks must make routing structural.
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { buildAigwProviderBlock, buildOpenAiCompatibleProviderBlock } from "../../src/server/agent/aigw-manager.js";

const model = (id: string, overrides: Record<string, unknown> = {}) => ({
	id, name: id, api: "openai-completions", reasoning: false, input: ["text"] as ("text" | "image")[], contextWindow: 128_000, maxTokens: 16_384, ...overrides,
});

describe("multi-gateway models.json writers", () => {
	it("preserves authoritative AIGW model routing and provider headers", () => {
		const block: any = buildAigwProviderBlock(
			{ id: "a", name: "aigw", url: "https://gateway.test/v1", type: "aigw", enabled: true },
			[model("gpt-routed", { wireId: "gpt-wire", api: "openai-responses", baseUrl: "https://gateway.test/openai/v1", upstreamProvider: "openai" })],
		);
		assert.equal(block.apiKey, "none");
		assert.equal(block.headers["x-opencode-session"], `!node -e "process.stdout.write(process.env.BOBBIT_SESSION_ID || '')"`);
		assert.deepEqual(block.models[0], {
			id: "gpt-wire", upstreamProvider: "openai", name: "gpt-routed", contextWindow: 128_000, maxTokens: 16_384,
			reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, api: "openai-responses", baseUrl: "https://gateway.test/openai/v1",
		});
	});

	it("uses raw OpenAI ids with no AIGW header or Bedrock route", () => {
		const block: any = buildOpenAiCompatibleProviderBlock(
			{ id: "l", name: "local", url: "http://localhost:8080/", type: "openai-compatible", enabled: true },
			[model("claude-local")],
			"LOCAL_TOKEN_REFERENCE",
		);
		assert.equal(block.baseUrl, "http://localhost:8080/v1");
		assert.equal(block.apiKey, "LOCAL_TOKEN_REFERENCE", "the expression, never a resolved token, belongs in models.json");
		assert.equal(block.headers, undefined);
		assert.equal(block.models[0].id, "claude-local");
		assert.equal(block.models[0].api, "openai-completions");
		assert.equal(block.models[0].baseUrl, undefined);
	});
});
