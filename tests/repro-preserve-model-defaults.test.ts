/**
 * Reproducing test for: "Preserve Default Model Settings on First Headquarters Startup"
 *
 * Demonstrates the bug: when BOBBIT_DIR points to a fresh directory (override
 * scenario), calling migrateLegacyHeadquartersDirectory() alone does NOT seed
 * model-default preference keys from the legacy .bobbit/state/preferences.json.
 *
 * The fix adds seedModelDefaultsFromLegacy() which is called after migration to
 * non-destructively seed the missing keys.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { migrateLegacyHeadquartersDirectory } = await import("../src/server/agent/state-migration.ts");

// Pin BOBBIT_SECRETS_DIR to an isolated temp dir so the test never writes admin
// secrets into the developer's home directory.
const isolatedSecretsDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-repro-secrets-"));
process.env.BOBBIT_SECRETS_DIR = isolatedSecretsDir;

function tmpDir(prefix = "bobbit-repro-model-defaults-"): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeJson(filePath: string, value: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

function readJsonOrEmpty(filePath: string): Record<string, unknown> {
	try {
		if (!fs.existsSync(filePath)) return {};
		return JSON.parse(fs.readFileSync(filePath, "utf-8"));
	} catch {
		return {};
	}
}

describe("preserve model defaults on fresh HQ startup (BOBBIT_DIR override scenario)", () => {
	it("model-default keys are present in the override HQ state dir after startup", () => {
		const serverRoot = tmpDir("bobbit-repro-server-");
		const overrideHqDir = tmpDir("bobbit-repro-override-hq-");
		const overrideHqStateDir = path.join(overrideHqDir, "state");
		const overrideHqConfigDir = path.join(overrideHqDir, "config");

		// Write legacy preferences at the default (non-override) path.
		writeJson(path.join(serverRoot, ".bobbit", "state", "preferences.json"), {
			"default.sessionModel": "anthropic/claude-opus-4",
			"default.reviewModel": "anthropic/claude-3-5-sonnet",
			"default.namingModel": "openai/gpt-4o-mini",
			"default.imageModel": "openai/dall-e-3",
			"default.sessionThinkingLevel": "high",
			"default.reviewThinkingLevel": "medium",
			"default.namingThinkingLevel": "low",
		});

		// Simulate startup: run only migrateLegacyHeadquartersDirectory in the
		// override scenario. The bug: model defaults from legacy are NOT seeded.
		migrateLegacyHeadquartersDirectory({
			serverRunDir: serverRoot,
			headquartersDir: overrideHqDir,
			headquartersStateDir: overrideHqStateDir,
			headquartersConfigDir: overrideHqConfigDir,
			legacyServerBobbitDir: path.join(serverRoot, ".bobbit"),
		});

		// Assert that model defaults are present in the override HQ state dir.
		// BUG: migrateLegacyHeadquartersDirectory skips legacy copy when override
		// is active, so these keys are absent → assertions fail.
		const hqPrefs = readJsonOrEmpty(path.join(overrideHqStateDir, "preferences.json"));

		assert.equal(hqPrefs["default.sessionModel"], "anthropic/claude-opus-4",
			"default.sessionModel must be preserved in the override HQ state dir");
		assert.equal(hqPrefs["default.reviewModel"], "anthropic/claude-3-5-sonnet",
			"default.reviewModel must be preserved in the override HQ state dir");
		assert.equal(hqPrefs["default.namingModel"], "openai/gpt-4o-mini",
			"default.namingModel must be preserved in the override HQ state dir");
		assert.equal(hqPrefs["default.imageModel"], "openai/dall-e-3",
			"default.imageModel must be preserved in the override HQ state dir");
		assert.equal(hqPrefs["default.sessionThinkingLevel"], "high",
			"default.sessionThinkingLevel must be preserved in the override HQ state dir");
		assert.equal(hqPrefs["default.reviewThinkingLevel"], "medium",
			"default.reviewThinkingLevel must be preserved in the override HQ state dir");
		assert.equal(hqPrefs["default.namingThinkingLevel"], "low",
			"default.namingThinkingLevel must be preserved in the override HQ state dir");

		// Clean up
		fs.rmSync(serverRoot, { recursive: true, force: true });
		fs.rmSync(overrideHqDir, { recursive: true, force: true });
	});
});
