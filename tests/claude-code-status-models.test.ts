import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { PreferencesStore } from "../src/server/agent/preferences-store.ts";
import {
	CLAUDE_CODE_PREF_KEYS,
	CLAUDE_CODE_DEFAULT_CONFIG,
	normalizeClaudeCodePreferencePatch,
	readClaudeCodeConfig,
} from "../src/server/agent/claude-code-config.ts";
import {
	invalidateClaudeCodeStatusCache,
	probeClaudeCodeStatus,
} from "../src/server/agent/claude-code-status.ts";
import { getAvailableModels, invalidateModelCache } from "../src/server/agent/model-registry.ts";

function makePrefs(): { prefs: PreferencesStore; dir: string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-claude-code-"));
	return { prefs: new PreferencesStore(dir), dir };
}

beforeEach(() => {
	invalidateClaudeCodeStatusCache();
	invalidateModelCache();
});

describe("Claude Code config", () => {
	it("returns safe defaults", () => {
		const { prefs, dir } = makePrefs();
		try {
			assert.deepEqual(readClaudeCodeConfig(prefs), CLAUDE_CODE_DEFAULT_CONFIG);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("validates executable, model alias, permission mode, and bypass opt-in", () => {
		const { prefs, dir } = makePrefs();
		try {
			const ok = normalizeClaudeCodePreferencePatch({
				[CLAUDE_CODE_PREF_KEYS.executablePath]: "  /usr/local/bin/claude  ",
				[CLAUDE_CODE_PREF_KEYS.defaultModel]: "opus",
				[CLAUDE_CODE_PREF_KEYS.allowBypassPermissions]: true,
				[CLAUDE_CODE_PREF_KEYS.permissionMode]: "bypassPermissions",
			}, prefs);
			assert.equal(ok.ok, true);
			assert.equal((ok as any).values[CLAUDE_CODE_PREF_KEYS.executablePath], "/usr/local/bin/claude");
			assert.equal((ok as any).values[CLAUDE_CODE_PREF_KEYS.defaultModel], "opus");
			assert.equal((ok as any).values[CLAUDE_CODE_PREF_KEYS.permissionMode], "bypassPermissions");

			const bypassWithoutOptIn = normalizeClaudeCodePreferencePatch({
				[CLAUDE_CODE_PREF_KEYS.permissionMode]: "bypassPermissions",
			}, prefs);
			assert.equal(bypassWithoutOptIn.ok, false);
			assert.match((bypassWithoutOptIn as any).error, /requires/);

			const badPath = normalizeClaudeCodePreferencePatch({
				[CLAUDE_CODE_PREF_KEYS.executablePath]: "   ",
			}, prefs);
			assert.equal(badPath.ok, false);
			assert.match((badPath as any).error, /non-empty/);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("Claude Code status", () => {
	it("probes with execFile-style args and no shell", async () => {
		let seen: any;
		const status = await probeClaudeCodeStatus({ executablePath: "claude-test" }, async (file, args, options) => {
			seen = { file, args, options };
			return { stdout: "claude 1.2.3\n", stderr: "" };
		});

		assert.equal(seen.file, "claude-test");
		assert.deepEqual(seen.args, ["--version"]);
		assert.equal(seen.options.shell, false);
		assert.equal(status.available, true);
		assert.equal(status.ready, true);
		assert.equal(status.authenticated, true);
		assert.equal(status.version, "1.2.3");
	});

	it("reports a missing CLI as unavailable", async () => {
		const missing = path.join(os.tmpdir(), `missing-claude-${process.pid}-${Date.now()}`);
		const status = await probeClaudeCodeStatus({ executablePath: missing });
		assert.equal(status.available, false);
		assert.equal(status.ready, false);
		assert.equal(status.authenticated, false);
		assert.equal(status.reason, "Claude Code CLI not found");
	});
});

describe("Claude Code synthetic models", () => {
	it("emits unavailable local-runtime models when the CLI is missing", async () => {
		const { prefs, dir } = makePrefs();
		try {
			prefs.set(CLAUDE_CODE_PREF_KEYS.executablePath, path.join(dir, "missing-claude"));
			const models = await getAvailableModels(prefs);
			const local = models.filter(m => m.provider === "claude-code");
			assert.deepEqual(local.map(m => m.id), ["default", "sonnet", "opus"]);
			for (const model of local) {
				assert.equal(model.api, "claude-code-runtime");
				assert.equal(model.runtime, "claude-code");
				assert.equal(model.localRuntime, true);
				assert.equal(model.runtimeLabel, "Claude Code (local)");
				assert.equal(model.authenticated, false);
				assert.equal(model.sessionSelectable, false);
				assert.equal(model.sessionUnavailableReason, "Claude Code CLI not found");
			}
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("marks Claude Code models selectable when the configured executable probes successfully", async () => {
		const { prefs, dir } = makePrefs();
		try {
			prefs.set(CLAUDE_CODE_PREF_KEYS.executablePath, process.execPath);
			const models = await getAvailableModels(prefs);
			const sonnet = models.find(m => m.provider === "claude-code" && m.id === "sonnet");
			assert.ok(sonnet);
			assert.equal(sonnet.authenticated, true);
			assert.equal(sonnet.sessionSelectable, true);
			assert.equal(sonnet.sessionUnavailableReason, undefined);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
