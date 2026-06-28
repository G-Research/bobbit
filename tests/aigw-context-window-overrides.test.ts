import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { applyContextWindowOverrides, parseModelsGeneratedText } = await import("../src/server/agent/aigw-manager.ts");

function modelsFor(providerModels: Map<string, string[]>, provider: string): string[] {
	return providerModels.get(provider) ?? [];
}

describe("AIGW contextWindow overrides", () => {
	it("parses provider-nested and flat models.generated.js shapes", () => {
		const nested = `
			export const MODELS = {
				"amazon-bedrock": {
					"us.anthropic.claude-sonnet-4-5-v1:0": {
						id: "us.anthropic.claude-sonnet-4-5-v1:0",
						provider: "amazon-bedrock",
						pricing: { input: 3, output: 15 },
					},
					"us.anthropic.claude-opus-4-1-v1:0": {
						provider: "amazon-bedrock",
					},
				},
				"anthropic": {
					"claude-sonnet-4-5": {
						provider: "anthropic",
					},
					"claude-opus-4-1": {
						id: "claude-opus-4-1",
						provider: "anthropic",
					},
				},
			};
		`;

		const nestedModels = parseModelsGeneratedText(nested);
		assert.deepEqual(modelsFor(nestedModels, "amazon-bedrock"), [
			"us.anthropic.claude-sonnet-4-5-v1:0",
			"us.anthropic.claude-opus-4-1-v1:0",
		]);
		assert.deepEqual(modelsFor(nestedModels, "anthropic"), [
			"claude-sonnet-4-5",
			"claude-opus-4-1",
		]);
		assert.equal(modelsFor(nestedModels, "amazon-bedrock").includes("amazon-bedrock"), false);
		assert.equal(modelsFor(nestedModels, "anthropic").includes("anthropic"), false);

		const flat = `
			export const MODELS = {
				"claude-sonnet-4-5": { id: "claude-sonnet-4-5", provider: "anthropic" },
				"aws/us.anthropic.claude-opus-4-1-v1:0": { provider: "amazon-bedrock" },
			};
		`;

		const flatModels = parseModelsGeneratedText(flat);
		assert.deepEqual(modelsFor(flatModels, "anthropic"), ["claude-sonnet-4-5"]);
		assert.deepEqual(modelsFor(flatModels, "amazon-bedrock"), ["aws/us.anthropic.claude-opus-4-1-v1:0"]);
	});

	it("writes 1M Sonnet/Opus overrides without clobbering user context windows", () => {
		const data: Record<string, any> = {
			providers: {
				anthropic: {
					apiKey: "sk-test",
					modelOverrides: {
						"claude-sonnet-4-5": { contextWindow: 123_456, custom: true },
					},
				},
			},
		};
		const providerModels = new Map<string, string[]>([
			["amazon-bedrock", [
				"us.anthropic.claude-sonnet-4-5-v1:0",
				"us.anthropic.claude-opus-4-1-v1:0",
				"us.anthropic.claude-haiku-4-5-v1:0",
			]],
			["anthropic", [
				"claude-sonnet-4-5",
				"claude-opus-4-1",
			]],
		]);

		const written = applyContextWindowOverrides(data, providerModels);
		assert.equal(written, 3);
		assert.equal(data.providers["amazon-bedrock"].modelOverrides["us.anthropic.claude-sonnet-4-5-v1:0"].contextWindow, 1_000_000);
		assert.equal(data.providers["amazon-bedrock"].modelOverrides["us.anthropic.claude-opus-4-1-v1:0"].contextWindow, 1_000_000);
		assert.equal(data.providers["amazon-bedrock"].modelOverrides["us.anthropic.claude-haiku-4-5-v1:0"], undefined);
		assert.deepEqual(data.providers.anthropic.modelOverrides["claude-sonnet-4-5"], { contextWindow: 123_456, custom: true });
		assert.equal(data.providers.anthropic.modelOverrides["claude-opus-4-1"].contextWindow, 1_000_000);
		assert.equal(data.providers.anthropic.apiKey, "sk-test");
	});
});
