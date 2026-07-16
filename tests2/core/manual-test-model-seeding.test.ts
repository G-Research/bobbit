import { guardProcessEnv } from "./helpers/env-guard.js";
guardProcessEnv();

import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { createFsFromVolume, Volume } from "memfs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, it, vi } from "vitest";

import {
	MANUAL_INHERIT_SERVER_CONFIG_ENV,
	seedManualTestModelPreferences,
} from "../../tests/manual-integration/manual-test-model-seeding.ts";

const memoryFs = createFsFromVolume(new Volume()) as unknown as typeof fs;
const fsSpies: Array<{ mockRestore(): void }> = [];
let fixtureSequence = 0;
let roots: string[] = [];

beforeAll(() => {
	for (const name of [
		"copyFileSync", "existsSync", "mkdirSync", "readFileSync", "rmSync", "statSync", "writeFileSync",
	] as const) {
		fsSpies.push(vi.spyOn(fs, name).mockImplementation(memoryFs[name].bind(memoryFs) as never));
	}
	// The production helper imports named node:fs exports; synchronize them with
	// the spied default export so its complete contract runs against this volume.
	syncBuiltinESMExports();
});

beforeEach(() => {
	delete process.env[MANUAL_INHERIT_SERVER_CONFIG_ENV];
	delete process.env.BOBBIT_DIR;
	delete process.env.MANUAL_TEST_MODEL;
	delete process.env.MANUAL_TEST_THINKING_LEVEL;
});

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

afterAll(() => {
	fsSpies.forEach(spy => spy.mockRestore());
	syncBuiltinESMExports();
});

describe("seedManualTestModelPreferences", () => {
	it("keeps the default isolated behavior when no manual model env is set", () => {
		const dir = tempDir();

		seedManualTestModelPreferences(dir);

		assert.equal(fs.existsSync(path.join(dir, ".bobbit", "state", "preferences.json")), false);
		assert.equal(fs.existsSync(path.join(dir, ".bobbit", "agent", "auth.json")), false);
	});

	it("seeds explicit MANUAL_TEST_MODEL and MANUAL_TEST_THINKING_LEVEL without inheritance", () => {
		const dir = tempDir();
		process.env.MANUAL_TEST_MODEL = "openai-codex/gpt-5.5";
		process.env.MANUAL_TEST_THINKING_LEVEL = "high";

		seedManualTestModelPreferences(dir);

		assert.deepEqual(readJson(path.join(dir, ".bobbit", "state", "preferences.json")), {
			"default.sessionModel": "openai-codex/gpt-5.5",
			"default.sessionThinkingLevel": "high",
		});
	});

	it("inherits only model-binding preferences and Pi agent auth/config files from live BOBBIT_DIR", () => {
		const live = tempDir();
		const target = tempDir();
		fs.mkdirSync(path.join(live, "state"), { recursive: true });
		fs.mkdirSync(path.join(live, "agent"), { recursive: true });
		fs.writeFileSync(path.join(live, "state", "preferences.json"), JSON.stringify({
			"default.sessionModel": "openai-codex/gpt-5.5",
			"default.sessionThinkingLevel": "max",
			"default.reviewModel": "openai/gpt-5.6-luna",
			"default.reviewThinkingLevel": "high",
			"default.namingModel": "openai/gpt-5.6-sol",
			"default.namingThinkingLevel": "low",
			"allowSessionModelFallback": true,
			"providerKey.openai-codex": "secret-codex-key",
			"aigw.url": "https://aigw.example.test",
			"customProviders": [{ id: "custom" }],
			"ui.sidebar.width": 333,
			"token": "must-not-copy",
		}, null, 2));
		fs.writeFileSync(path.join(live, "state", "sessions.json"), "[]");
		fs.writeFileSync(path.join(live, "state", "token"), "live-gateway-token");
		fs.writeFileSync(path.join(live, "agent", "auth.json"), JSON.stringify({ openai: { access_token: "oauth" } }));
		fs.writeFileSync(path.join(live, "agent", "settings.json"), JSON.stringify({ selected: "codex" }));
		fs.writeFileSync(path.join(live, "agent", "models.json"), JSON.stringify({ models: ["codex"] }));
		fs.writeFileSync(path.join(live, "agent", "google-code-assist.json"), JSON.stringify({ account: "user@example.test" }));
		fs.writeFileSync(path.join(live, "agent", "sessions.json"), "must-not-copy");

		fs.mkdirSync(path.join(target, ".bobbit", "state"), { recursive: true });
		fs.writeFileSync(path.join(target, ".bobbit", "state", "preferences.json"), JSON.stringify({ "local.only": true }));
		process.env[MANUAL_INHERIT_SERVER_CONFIG_ENV] = "1";
		process.env.BOBBIT_DIR = live;

		seedManualTestModelPreferences(target);

		assert.deepEqual(readJson(path.join(target, ".bobbit", "state", "preferences.json")), {
			"local.only": true,
			"default.sessionModel": "openai-codex/gpt-5.5",
			"default.sessionThinkingLevel": "max",
			"default.reviewModel": "openai/gpt-5.6-luna",
			"default.reviewThinkingLevel": "high",
			"default.namingModel": "openai/gpt-5.6-sol",
			"default.namingThinkingLevel": "low",
			"allowSessionModelFallback": true,
			"providerKey.openai-codex": "secret-codex-key",
			"aigw.url": "https://aigw.example.test",
			"customProviders": [{ id: "custom" }],
		});
		assert.deepEqual(readJson(path.join(target, ".bobbit", "agent", "auth.json")), { openai: { access_token: "oauth" } });
		assert.deepEqual(readJson(path.join(target, ".bobbit", "agent", "settings.json")), { selected: "codex" });
		assert.deepEqual(readJson(path.join(target, ".bobbit", "agent", "models.json")), { models: ["codex"] });
		assert.deepEqual(readJson(path.join(target, ".bobbit", "agent", "google-code-assist.json")), { account: "user@example.test" });
		assert.equal(fs.existsSync(path.join(target, ".bobbit", "state", "token")), false);
		assert.equal(fs.existsSync(path.join(target, ".bobbit", "state", "sessions.json")), false);
		assert.equal(fs.existsSync(path.join(target, ".bobbit", "agent", "sessions.json")), false);
	});

	it("lets explicit MANUAL_TEST_MODEL env override inherited session defaults", () => {
		const live = tempDir();
		const target = tempDir();
		fs.mkdirSync(path.join(live, "state"), { recursive: true });
		fs.writeFileSync(path.join(live, "state", "preferences.json"), JSON.stringify({
			"default.sessionModel": "openai-codex/gpt-5.5",
			"default.sessionThinkingLevel": "max",
			"default.reviewModel": "openai/gpt-5.6-luna",
		}));
		process.env[MANUAL_INHERIT_SERVER_CONFIG_ENV] = "true";
		process.env.BOBBIT_DIR = live;
		process.env.MANUAL_TEST_MODEL = "openrouter/gpt-5.6-terra";
		process.env.MANUAL_TEST_THINKING_LEVEL = "medium";

		seedManualTestModelPreferences(target);

		assert.deepEqual(readJson(path.join(target, ".bobbit", "state", "preferences.json")), {
			"default.sessionModel": "openrouter/gpt-5.6-terra",
			"default.sessionThinkingLevel": "medium",
			"default.reviewModel": "openai/gpt-5.6-luna",
		});
	});
});

function tempDir(): string {
	const dir = path.resolve("/memfs/manual-test-model-seeding", `fixture-${fixtureSequence++}`);
	fs.mkdirSync(dir, { recursive: true });
	roots.push(dir);
	return dir;
}

function readJson(file: string): unknown {
	return JSON.parse(fs.readFileSync(file, "utf-8"));
}
