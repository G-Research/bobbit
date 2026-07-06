import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { seedModelDefaultsFromLegacy, MODEL_DEFAULT_PREF_KEYS } = await import("../src/server/agent/state-migration.ts");

function tmpDir(prefix = "bobbit-seed-model-defaults-"): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeJson(filePath: string, value: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

function readJson<T = any>(filePath: string): T {
	return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

// Track temp dirs for cleanup.
let tmpRoots: string[] = [];

function makeTmpDir(prefix?: string): string {
	const dir = tmpDir(prefix);
	tmpRoots.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tmpRoots) {
		try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
	}
	tmpRoots = [];
});

describe("seedModelDefaultsFromLegacy", () => {
	it("seeds all model-default keys from legacy path into fresh HQ state dir", () => {
		const serverRoot = makeTmpDir("bobbit-seed-server-");
		const hqStateDir = makeTmpDir("bobbit-seed-hq-");

		// Write legacy preferences with all model-default keys set.
		const legacyPrefs = {
			"default.sessionModel": "openai/gpt-4o",
			"default.reviewModel": "anthropic/claude-3-5-sonnet",
			"default.namingModel": "openai/gpt-4o-mini",
			"default.imageModel": "openai/dall-e-3",
			"default.sessionThinkingLevel": "high",
			"default.reviewThinkingLevel": "medium",
			"default.namingThinkingLevel": "low",
			"someOtherPref": "should-not-be-seeded",
		};
		writeJson(path.join(serverRoot, ".bobbit", "state", "preferences.json"), legacyPrefs);

		// HQ state dir is empty (fresh start).
		seedModelDefaultsFromLegacy({ headquartersStateDir: hqStateDir, serverRunDir: serverRoot });

		const result = readJson(path.join(hqStateDir, "preferences.json"));

		for (const key of MODEL_DEFAULT_PREF_KEYS) {
			assert.equal(result[key], (legacyPrefs as any)[key], `key ${key} should be seeded`);
		}

		// Non-model keys must NOT be seeded.
		assert.equal(result["someOtherPref"], undefined, "non-model-default key must not be seeded");
	});

	it("does not overwrite existing preferences in HQ state dir (non-destructive)", () => {
		const serverRoot = makeTmpDir("bobbit-seed-server-");
		const hqStateDir = makeTmpDir("bobbit-seed-hq-");

		// Legacy has one value.
		writeJson(path.join(serverRoot, ".bobbit", "state", "preferences.json"), {
			"default.sessionModel": "legacy-model",
			"default.reviewModel": "legacy-review-model",
		});

		// HQ already has a different value for sessionModel.
		writeJson(path.join(hqStateDir, "preferences.json"), {
			"default.sessionModel": "already-set-model",
		});

		seedModelDefaultsFromLegacy({ headquartersStateDir: hqStateDir, serverRunDir: serverRoot });

		const result = readJson(path.join(hqStateDir, "preferences.json"));

		// Pre-existing key must not be overwritten.
		assert.equal(result["default.sessionModel"], "already-set-model", "existing key must not be overwritten");

		// Missing key from HQ but present in legacy must be seeded.
		assert.equal(result["default.reviewModel"], "legacy-review-model", "missing key should be seeded");
	});

	it("is a no-op when HQ state dir already has all model-default keys", () => {
		const serverRoot = makeTmpDir("bobbit-seed-server-");
		const hqStateDir = makeTmpDir("bobbit-seed-hq-");

		const hqPrefs: Record<string, string> = {};
		for (const key of MODEL_DEFAULT_PREF_KEYS) {
			hqPrefs[key] = "hq-value";
		}
		writeJson(path.join(hqStateDir, "preferences.json"), hqPrefs);

		// Legacy would overwrite if the guard isn't working.
		const legacyPrefs: Record<string, string> = {};
		for (const key of MODEL_DEFAULT_PREF_KEYS) {
			legacyPrefs[key] = "legacy-value";
		}
		writeJson(path.join(serverRoot, ".bobbit", "state", "preferences.json"), legacyPrefs);

		seedModelDefaultsFromLegacy({ headquartersStateDir: hqStateDir, serverRunDir: serverRoot });

		const result = readJson(path.join(hqStateDir, "preferences.json"));

		for (const key of MODEL_DEFAULT_PREF_KEYS) {
			assert.equal(result[key], "hq-value", `key ${key} must not be overwritten`);
		}
	});

	it("is a no-op when legacy preferences file does not exist", () => {
		const serverRoot = makeTmpDir("bobbit-seed-server-");
		const hqStateDir = makeTmpDir("bobbit-seed-hq-");

		// No legacy preferences file at all.
		// HQ state dir is also fresh.

		// Should not throw or create any files.
		seedModelDefaultsFromLegacy({ headquartersStateDir: hqStateDir, serverRunDir: serverRoot });

		assert.equal(
			fs.existsSync(path.join(hqStateDir, "preferences.json")),
			false,
			"preferences.json must not be created when there is no legacy source"
		);
	});

	it("is a no-op when source and target are the same path", () => {
		// This covers the case where the HQ state dir IS the legacy path.
		const serverRoot = makeTmpDir("bobbit-seed-server-");

		// Make the HQ state dir equal to the legacy path.
		const hqStateDir = path.join(serverRoot, ".bobbit", "state");
		fs.mkdirSync(hqStateDir, { recursive: true });

		const prefs = { "default.sessionModel": "some-model" };
		writeJson(path.join(hqStateDir, "preferences.json"), prefs);

		// Should not throw.
		seedModelDefaultsFromLegacy({ headquartersStateDir: hqStateDir, serverRunDir: serverRoot });

		// File must be unchanged.
		const result = readJson(path.join(hqStateDir, "preferences.json"));
		assert.deepEqual(result, prefs);
	});

	it("seeds model defaults even when BOBBIT_DIR override scenario (fresh override dir)", () => {
		// Simulates: user has BOBBIT_DIR=/some/new/empty/dir
		// The default (non-override) headquarters path at <serverRoot>/.bobbit/state
		// still has preferences from before.
		const serverRoot = makeTmpDir("bobbit-seed-server-");
		const overrideHqStateDir = makeTmpDir("bobbit-seed-override-hq-");

		// Legacy path (default HQ location, not the override) has model settings.
		writeJson(path.join(serverRoot, ".bobbit", "state", "preferences.json"), {
			"default.sessionModel": "anthropic/claude-opus-4",
			"default.namingModel": "openai/gpt-4o-mini",
		});

		// Override HQ state dir is completely empty.
		seedModelDefaultsFromLegacy({ headquartersStateDir: overrideHqStateDir, serverRunDir: serverRoot });

		const result = readJson(path.join(overrideHqStateDir, "preferences.json"));
		assert.equal(result["default.sessionModel"], "anthropic/claude-opus-4");
		assert.equal(result["default.namingModel"], "openai/gpt-4o-mini");
		// Keys not in legacy must not appear.
		assert.equal(result["default.reviewModel"], undefined);
	});
});
