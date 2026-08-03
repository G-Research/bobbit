import { describe, expect, it } from "vitest";
import { CACHE_STALL_INPUT_THRESHOLD, classifyCachePosture } from "../../src/server/agent/cache-posture.js";
import type { ApiModel } from "../../src/server/agent/model-registry.js";

function model(overrides: Partial<ApiModel> = {}): ApiModel {
	return {
		id: "claude-test",
		name: "Claude test",
		provider: "anthropic",
		api: "anthropic-messages",
		contextWindow: 200_000,
		maxTokens: 8_192,
		reasoning: true,
		input: ["text"],
		cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1.25 },
		authenticated: true,
		...overrides,
	};
}

describe("cache posture classifier", () => {
	it("recognizes only an exact direct Anthropic Messages text catalog model", () => {
		const result = classifyCachePosture(model());
		expect(result.capable).toBe(true);
		if (!result.capable) throw new Error("expected cache-capable posture");
		expect(result.posture).toEqual({
			provider: "anthropic",
			model: "claude-test",
			api: "anthropic-messages",
			expectedCaching: "provider-managed",
			ttl: "unknown",
		});
		expect(CACHE_STALL_INPUT_THRESHOLD).toBe(50_000);
	});

	it.each([
		model({ provider: "aigw" }),
		model({ provider: "bedrock", api: "bedrock-converse-stream" }),
		model({ provider: "openrouter", api: "openai-completions" }),
		model({ provider: "anthropic", api: "openai-completions" }),
		model({ input: ["image"] }),
		model({ sessionSelectable: false }),
		undefined,
	])("fails closed for unproven cache paths", (candidate) => {
		expect(classifyCachePosture(candidate)).toEqual({ capable: false });
	});
});
