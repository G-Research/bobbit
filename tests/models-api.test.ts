/**
 * Unit tests for the model registry (GET /api/models equivalent).
 *
 * Validates model structure from built-in providers without needing
 * a full gateway. Replaces the slower E2E version in tests/e2e/models-api.spec.ts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Create an isolated temp dir for the PreferencesStore (it reads from disk)
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-models-test-"));

// Import after setup
const { PreferencesStore } = await import("../src/server/agent/preferences-store.ts");
const { getAvailableModels } = await import("../src/server/agent/model-registry.ts");

const prefs = new PreferencesStore(tmpDir);

// Fetch models once — all tests validate the same snapshot
const models = await getAvailableModels(prefs);

// ── Structure tests ─────────────────────────────────────────────────

describe("Model registry", () => {
	it("returns a non-empty array of models", () => {
		assert.ok(Array.isArray(models), "models should be an array");
		assert.ok(models.length > 0, "should have at least one model");
	});

	it("every model has the correct structure", () => {
		for (const m of models) {
			assert.equal(typeof m.id, "string", `id should be string, got ${typeof m.id}`);
			assert.equal(typeof m.name, "string", `name should be string`);
			assert.equal(typeof m.provider, "string", `provider should be string`);
			assert.equal(typeof m.contextWindow, "number", `contextWindow should be number`);
			assert.equal(typeof m.maxTokens, "number", `maxTokens should be number`);
			assert.equal(typeof m.reasoning, "boolean", `reasoning should be boolean`);
			assert.ok(Array.isArray(m.input), `input should be an array`);
			assert.equal(typeof m.authenticated, "boolean", `authenticated should be boolean`);
			// cost object
			assert.equal(typeof m.cost, "object", `cost should be object`);
			assert.equal(typeof m.cost.input, "number", `cost.input should be number`);
			assert.equal(typeof m.cost.output, "number", `cost.output should be number`);
		}
	});

	it("Claude Sonnet/Opus models report >= 1M context window", () => {
		const claudeModels = models.filter(
			(m) => m.id.toLowerCase().includes("claude-sonnet") || m.id.toLowerCase().includes("claude-opus"),
		);
		assert.ok(claudeModels.length > 0, "should have at least one Claude Sonnet or Opus model");

		for (const m of claudeModels) {
			assert.ok(
				m.contextWindow >= 1_000_000,
				`${m.id} contextWindow ${m.contextWindow} should be >= 1M`,
			);
		}
	});

	it("built-in providers include known providers", () => {
		const providers = new Set(models.map((m) => m.provider));
		const hasKnown = providers.has("anthropic") || providers.has("amazon-bedrock");
		assert.ok(hasKnown, `should include anthropic or amazon-bedrock, got: ${[...providers].join(", ")}`);
	});

	it("Claude Haiku models have smaller context than Opus/Sonnet", () => {
		const haiku = models.filter((m) => m.id.toLowerCase().includes("claude-haiku"));
		if (haiku.length > 0) {
			for (const m of haiku) {
				assert.ok(
					m.contextWindow <= 200_000,
					`Haiku model ${m.id} contextWindow ${m.contextWindow} should be <= 200k`,
				);
			}
		}
	});
});

// Cleanup
fs.rmSync(tmpDir, { recursive: true, force: true });
