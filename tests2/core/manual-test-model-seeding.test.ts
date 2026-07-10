import { guardProcessEnv } from "./helpers/env-guard.js";
guardProcessEnv();

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";

import {
	MANUAL_INHERIT_SERVER_CONFIG_ENV,
	seedManualTestModelPreferences,
} from "../../tests/manual-integration/manual-test-model-seeding.ts";

let roots: string[] = [];

beforeEach(() => {
	delete process.env[MANUAL_INHERIT_SERVER_CONFIG_ENV];
	delete process.env.BOBBIT_DIR;
	delete process.env.MANUAL_TEST_MODEL;
	delete process.env.MANUAL_TEST_THINKING_LEVEL;
});

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("seedManualTestModelPreferences", () => {
	it("keeps the default isolated behavior when no manual model env is set", () => {
		const dir = tempDir();

		seedManualTestModelPreferences(dir);

		assert.equal(existsSync(join(dir, ".bobbit", "state", "preferences.json")), false);
		assert.equal(existsSync(join(dir, ".bobbit", "agent", "auth.json")), false);
	});

	it("seeds explicit MANUAL_TEST_MODEL and MANUAL_TEST_THINKING_LEVEL without inheritance", () => {
		const dir = tempDir();
		process.env.MANUAL_TEST_MODEL = "openai-codex/gpt-5.5";
		process.env.MANUAL_TEST_THINKING_LEVEL = "high";

		seedManualTestModelPreferences(dir);

		assert.deepEqual(readJson(join(dir, ".bobbit", "state", "preferences.json")), {
			"default.sessionModel": "openai-codex/gpt-5.5",
			"default.sessionThinkingLevel": "high",
		});
	});

	it("inherits only model-binding preferences and Pi agent auth/config files from live BOBBIT_DIR", () => {
		const live = tempDir();
		const target = tempDir();
		mkdirSync(join(live, "state"), { recursive: true });
		mkdirSync(join(live, "agent"), { recursive: true });
		writeFileSync(join(live, "state", "preferences.json"), JSON.stringify({
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
		writeFileSync(join(live, "state", "sessions.json"), "[]");
		writeFileSync(join(live, "state", "token"), "live-gateway-token");
		writeFileSync(join(live, "agent", "auth.json"), JSON.stringify({ openai: { access_token: "oauth" } }));
		writeFileSync(join(live, "agent", "settings.json"), JSON.stringify({ selected: "codex" }));
		writeFileSync(join(live, "agent", "models.json"), JSON.stringify({ models: ["codex"] }));
		writeFileSync(join(live, "agent", "google-code-assist.json"), JSON.stringify({ account: "user@example.test" }));
		writeFileSync(join(live, "agent", "sessions.json"), "must-not-copy");

		mkdirSync(join(target, ".bobbit", "state"), { recursive: true });
		writeFileSync(join(target, ".bobbit", "state", "preferences.json"), JSON.stringify({ "local.only": true }));
		process.env[MANUAL_INHERIT_SERVER_CONFIG_ENV] = "1";
		process.env.BOBBIT_DIR = live;

		seedManualTestModelPreferences(target);

		assert.deepEqual(readJson(join(target, ".bobbit", "state", "preferences.json")), {
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
		assert.deepEqual(readJson(join(target, ".bobbit", "agent", "auth.json")), { openai: { access_token: "oauth" } });
		assert.deepEqual(readJson(join(target, ".bobbit", "agent", "settings.json")), { selected: "codex" });
		assert.deepEqual(readJson(join(target, ".bobbit", "agent", "models.json")), { models: ["codex"] });
		assert.deepEqual(readJson(join(target, ".bobbit", "agent", "google-code-assist.json")), { account: "user@example.test" });
		assert.equal(existsSync(join(target, ".bobbit", "state", "token")), false);
		assert.equal(existsSync(join(target, ".bobbit", "state", "sessions.json")), false);
		assert.equal(existsSync(join(target, ".bobbit", "agent", "sessions.json")), false);
	});

	it("lets explicit MANUAL_TEST_MODEL env override inherited session defaults", () => {
		const live = tempDir();
		const target = tempDir();
		mkdirSync(join(live, "state"), { recursive: true });
		writeFileSync(join(live, "state", "preferences.json"), JSON.stringify({
			"default.sessionModel": "openai-codex/gpt-5.5",
			"default.sessionThinkingLevel": "max",
			"default.reviewModel": "openai/gpt-5.6-luna",
		}));
		process.env[MANUAL_INHERIT_SERVER_CONFIG_ENV] = "true";
		process.env.BOBBIT_DIR = live;
		process.env.MANUAL_TEST_MODEL = "openrouter/gpt-5.6-terra";
		process.env.MANUAL_TEST_THINKING_LEVEL = "medium";

		seedManualTestModelPreferences(target);

		assert.deepEqual(readJson(join(target, ".bobbit", "state", "preferences.json")), {
			"default.sessionModel": "openrouter/gpt-5.6-terra",
			"default.sessionThinkingLevel": "medium",
			"default.reviewModel": "openai/gpt-5.6-luna",
		});
	});
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "bobbit-manual-seed-"));
	roots.push(dir);
	return dir;
}

function readJson(file: string): unknown {
	return JSON.parse(readFileSync(file, "utf-8"));
}
