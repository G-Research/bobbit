import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";

const { invalidateModelCache } = await import("../../src/server/agent/model-registry.ts");
const { buildResolvedModelStateModel } = await import("../../src/server/ws/handler.ts");

describe("buildResolvedModelStateModel — exact optional metadata", () => {
	it("preserves capability fields from an identity-matched live frame when exact metadata is unavailable", () => {
		invalidateModelCache();
		const liveMap = { off: null, low: "small", high: "large", max: "maximum" };
		const base = {
			provider: "custom",
			id: "my-private-model-42",
			name: "Private model",
			contextWindow: 512_000,
			maxTokens: 64_000,
			reasoning: true,
			input: ["text", "image"],
			thinkingLevelMap: liveMap,
		};

		const model = buildResolvedModelStateModel("custom", "my-private-model-42", base);

		assert.equal(model.name, "Private model");
		assert.equal(model.contextWindow, 512_000);
		assert.equal(model.maxTokens, 64_000);
		assert.equal(model.reasoning, true);
		assert.deepEqual(model.input, ["text", "image"]);
		assert.deepEqual(model.thinkingLevelMap, liveMap);
	});

	it("does not fabricate fields when neither exact nor matching live metadata exists", () => {
		invalidateModelCache();
		assert.deepEqual(
			buildResolvedModelStateModel("custom", "totally-unknown-model"),
			{ provider: "custom", id: "totally-unknown-model" },
		);
	});

	it("rejects live capability metadata from a different identity", () => {
		invalidateModelCache();
		const model = buildResolvedModelStateModel("custom", "requested-model", {
			provider: "custom",
			id: "different-model",
			contextWindow: 999_999,
			maxTokens: 88_888,
			reasoning: true,
			input: ["text", "image"],
			thinkingLevelMap: { max: "max" },
		});
		assert.deepEqual(model, { provider: "custom", id: "requested-model" });
	});

	it("exact Pi metadata overrides stale identity-matched live values", () => {
		invalidateModelCache();
		const exact = getBuiltinModel("anthropic" as any, "claude-fable-5" as any) as any;
		assert.ok(exact);
		const model = buildResolvedModelStateModel("anthropic", "claude-fable-5", {
			provider: "anthropic",
			id: "claude-fable-5",
			contextWindow: 1,
			maxTokens: 1,
			reasoning: !exact.reasoning,
			input: exact.input?.includes("image") ? ["text"] : ["text", "image"],
			thinkingLevelMap: { max: "stale" },
		});

		assert.equal(model.contextWindow, exact.contextWindow);
		assert.equal(model.maxTokens, exact.maxTokens);
		assert.equal(model.reasoning, exact.reasoning);
		assert.deepEqual(model.input, exact.input);
		assert.deepEqual(model.thinkingLevelMap, exact.thinkingLevelMap);
	});
});
