/**
 * E2E test: Verify that Bobbit writes contextWindow overrides to models.json
 * for Claude models whose built-in pi-ai context window is too low (200k
 * instead of 1M).
 *
 * This test FAILS on unfixed code — proving the 200k compaction bug exists.
 */

import { test, expect } from "./gateway-harness.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Resolve the models.json path the same way aigw-manager does:
 * PI_CODING_AGENT_DIR env → ~/.pi/agent
 */
function getModelsJsonPath(): string {
	const envDir = process.env.PI_CODING_AGENT_DIR;
	let agentDir: string;
	if (envDir) {
		if (envDir === "~") agentDir = homedir();
		else if (envDir.startsWith("~/")) agentDir = homedir() + envDir.slice(1);
		else agentDir = envDir;
	} else {
		agentDir = join(homedir(), ".pi", "agent");
	}
	return join(agentDir, "models.json");
}

test.describe("Context window overrides in models.json", () => {
	test("server writes contextWindow overrides for Claude Sonnet/Opus models", async () => {
		// The E2E gateway has already started by this point (Playwright webServer).
		// Read models.json that the server should have written overrides to.
		const modelsPath = getModelsJsonPath();

		let data: Record<string, any> = { providers: {} };
		try {
			data = JSON.parse(readFileSync(modelsPath, "utf-8"));
		} catch {
			// File may not exist — that's the bug
		}

		const providers = data.providers || {};

		// Check amazon-bedrock provider
		const bedrock = providers["amazon-bedrock"] || {};
		const bedrockOverrides = bedrock.modelOverrides || {};

		// Check anthropic provider
		const anthropic = providers["anthropic"] || {};
		const anthropicOverrides = anthropic.modelOverrides || {};

		// Find any Claude Sonnet or Opus override with contextWindow: 1000000
		// in either provider. The fix should write these for all known models.
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

		// At least one Sonnet and one Opus override must exist in each provider.
		// This assertion will FAIL on unfixed code because no overrides are written.
		const allPresent =
			hasSonnetBedrockOverride &&
			hasOpusBedrockOverride &&
			hasSonnetAnthropicOverride &&
			hasOpusAnthropicOverride;

		expect(allPresent, "Expected contextWindow override for Claude models in amazon-bedrock and anthropic providers of models.json").toBe(true);
	});
});
