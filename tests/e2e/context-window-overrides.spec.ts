/**
 * E2E test: Verify that Bobbit writes contextWindow overrides to models.json
 * for Claude models whose built-in pi-ai context window is too low (200k
 * instead of 1M).
 *
 * This test FAILS on unfixed code — proving the 200k compaction bug exists.
 */

import { test, expect } from "./in-process-harness.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type OverrideState = {
	ready: boolean;
	summary: string;
	hasSonnetBedrockOverride: boolean;
	hasOpusBedrockOverride: boolean;
	hasSonnetAnthropicOverride: boolean;
	hasOpusAnthropicOverride: boolean;
};

function summarizeKeys(record: Record<string, unknown>): string {
	const keys = Object.keys(record);
	return keys.length > 0 ? keys.slice(0, 8).join(", ") : "<none>";
}

function inspectContextWindowOverrides(modelsPath: string): OverrideState {
	let data: Record<string, any>;
	try {
		data = JSON.parse(readFileSync(modelsPath, "utf-8"));
	} catch (err: any) {
		return {
			ready: false,
			summary: `models.json is not readable yet at ${modelsPath}: ${err?.code || err?.message || String(err)}`,
			hasSonnetBedrockOverride: false,
			hasOpusBedrockOverride: false,
			hasSonnetAnthropicOverride: false,
			hasOpusAnthropicOverride: false,
		};
	}

	const providers = data.providers || {};
	const bedrockOverrides = providers["amazon-bedrock"]?.modelOverrides || {};
	const anthropicOverrides = providers.anthropic?.modelOverrides || {};

	const hasSonnetBedrockOverride = Object.entries(bedrockOverrides).some(
		([key, val]: [string, any]) =>
			key.toLowerCase().includes("claude-sonnet") &&
			val?.contextWindow === 1_000_000,
	);
	const hasOpusBedrockOverride = Object.entries(bedrockOverrides).some(
		([key, val]: [string, any]) =>
			key.toLowerCase().includes("claude-opus") &&
			val?.contextWindow === 1_000_000,
	);
	const hasSonnetAnthropicOverride = Object.entries(anthropicOverrides).some(
		([key, val]: [string, any]) =>
			key.toLowerCase().includes("claude-sonnet") &&
			val?.contextWindow === 1_000_000,
	);
	const hasOpusAnthropicOverride = Object.entries(anthropicOverrides).some(
		([key, val]: [string, any]) =>
			key.toLowerCase().includes("claude-opus") &&
			val?.contextWindow === 1_000_000,
	);

	const ready =
		hasSonnetBedrockOverride &&
		hasOpusBedrockOverride &&
		hasSonnetAnthropicOverride &&
		hasOpusAnthropicOverride;

	return {
		ready,
		summary:
			`amazon-bedrock override keys: ${summarizeKeys(bedrockOverrides)}; ` +
			`anthropic override keys: ${summarizeKeys(anthropicOverrides)}`,
		hasSonnetBedrockOverride,
		hasOpusBedrockOverride,
		hasSonnetAnthropicOverride,
		hasOpusAnthropicOverride,
	};
}

test.describe("Context window overrides in models.json", () => {
	test("server writes contextWindow overrides for Claude Sonnet/Opus models @smoke", async ({ gateway }) => {
		// Use the in-process gateway fixture's isolated agent directory. Reading
		// process.env here is flaky in broad E2E runs because workers mutate it
		// during setup/teardown; the fixture identity is the authoritative path.
		const modelsPath = join(gateway.bobbitDir, "agent", "models.json");

		await expect
			.poll(() => inspectContextWindowOverrides(modelsPath), {
				message:
					"Expected contextWindow overrides for Claude Sonnet/Opus models " +
					"in amazon-bedrock and anthropic providers of models.json",
				timeout: 5_000,
				intervals: [50, 100, 250, 500],
			})
			.toMatchObject({
				ready: true,
				hasSonnetBedrockOverride: true,
				hasOpusBedrockOverride: true,
				hasSonnetAnthropicOverride: true,
				hasOpusAnthropicOverride: true,
			});
	});
});
