import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { PreferencesStore } from "../src/server/agent/preferences-store.ts";
import {
	CLAUDE_CODE_PREF_KEYS,
	CLAUDE_CODE_DEFAULT_CONFIG,
	buildClaudeCodeSanitizedEnv,
	isValidModelAlias,
	normalizeClaudeCodePreferencePatch,
	readClaudeCodeConfig,
	resolveClaudeCodeExecutable,
	sensitiveClaudeCodePreferenceMutation,
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

function withPatchedEnv<T>(patch: Record<string, string | undefined>, fn: () => T): T {
	const previous = new Map<string, string | undefined>();
	for (const [key, value] of Object.entries(patch)) {
		previous.set(key, process.env[key]);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	const restore = () => {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	};
	try {
		const result = fn();
		if (result && typeof (result as any).finally === "function") {
			return (result as Promise<unknown>).finally(restore) as T;
		}
		restore();
		return result;
	} catch (error) {
		restore();
		throw error;
	}
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
			assert.equal(CLAUDE_CODE_DEFAULT_CONFIG.defaultModel, "local-claude-opus-4-8");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("validates executable, model alias, permission mode, and bypass opt-in", () => {
		const { prefs, dir } = makePrefs();
		try {
			const ok = normalizeClaudeCodePreferencePatch({
				[CLAUDE_CODE_PREF_KEYS.executablePath]: "  /usr/local/bin/claude  ",
				[CLAUDE_CODE_PREF_KEYS.defaultModel]: "local-claude-sonnet-4-6",
				[CLAUDE_CODE_PREF_KEYS.allowBypassPermissions]: true,
				[CLAUDE_CODE_PREF_KEYS.permissionMode]: "bypassPermissions",
			}, prefs);
			assert.equal(ok.ok, true);
			assert.equal((ok as any).values[CLAUDE_CODE_PREF_KEYS.executablePath], "/usr/local/bin/claude");
			assert.equal((ok as any).values[CLAUDE_CODE_PREF_KEYS.defaultModel], "local-claude-sonnet-4-6");
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

			const relativePath = normalizeClaudeCodePreferencePatch({
				[CLAUDE_CODE_PREF_KEYS.executablePath]: "./claude",
			}, prefs);
			assert.equal(relativePath.ok, false);
			assert.match((relativePath as any).error, /relative path/);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("requires operator confirmation for executable changes and resets", () => {
		const changed = sensitiveClaudeCodePreferenceMutation({
			[CLAUDE_CODE_PREF_KEYS.executablePath]: "/usr/local/bin/claude",
		});
		assert.equal(changed.requiresConfirmation, true);
		assert.deepEqual(changed.keys, [CLAUDE_CODE_PREF_KEYS.executablePath]);
		assert.equal(changed.values[CLAUDE_CODE_PREF_KEYS.executablePath], "/usr/local/bin/claude");

		const reset = sensitiveClaudeCodePreferenceMutation({
			[CLAUDE_CODE_PREF_KEYS.executablePath]: null,
		});
		assert.equal(reset.requiresConfirmation, true);
		assert.deepEqual(reset.keys, [CLAUDE_CODE_PREF_KEYS.executablePath]);
		assert.equal(reset.values[CLAUDE_CODE_PREF_KEYS.executablePath], null);
	});

	it("uses one model alias validation contract", () => {
		assert.equal(isValidModelAlias("vendor:model.alias-48"), true);
		assert.equal(isValidModelAlias("bad alias; rm -rf"), false);
	});

	it("does not let project config choose host executable or enable bypassPermissions", () => {
		const { prefs, dir } = makePrefs();
		try {
			prefs.set(CLAUDE_CODE_PREF_KEYS.executablePath, "/user/bin/claude");
			const config = readClaudeCodeConfig(prefs, {
				get(key: string) {
					if (key === "claudeCodeExecutablePath") return "/repo/malicious/claude";
					if (key === "claudeCodeAllowBypassPermissions") return "true";
					if (key === "claudeCodePermissionMode") return "bypassPermissions";
					return undefined;
				},
			});
			assert.equal(config.executablePath, "/user/bin/claude");
			assert.equal(config.allowBypassPermissions, false);
			assert.equal(config.permissionMode, "default");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("builds a minimal Claude Code environment and drops gateway/provider secrets", () => {
		const safeBin = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-safe-path-"));
		const unsafeCwd = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-unsafe-cwd-"));
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-home-"));
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-tmp-"));
		try {
			withPatchedEnv({
				PATH: [safeBin, unsafeCwd].join(path.delimiter),
				HOME: home,
				TMPDIR: tmp,
				LANG: "en_US.UTF-8",
				LC_ALL: "C.UTF-8",
				ANTHROPIC_API_KEY: "anthropic-secret",
				OPENAI_API_KEY: "openai-secret",
				GITHUB_TOKEN: "github-secret",
				AWS_SECRET_ACCESS_KEY: "aws-secret",
				GOOGLE_APPLICATION_CREDENTIALS: "/secret/google.json",
				BOBBIT_GATEWAY_TOKEN: "bobbit-secret",
				UNRELATED_GATEWAY_VALUE: "must-not-copy-process-env",
			}, () => {
				const env = buildClaudeCodeSanitizedEnv({
					HOME: path.join(home, "override"),
					LANG: "fr_FR.UTF-8",
					TEMP: tmp,
					ANTHROPIC_API_KEY: "extra-anthropic-secret",
					EXTRA_TOKEN: "extra-token-secret",
					AWS_REGION: "extra-aws-value",
					GITHUB_REPOSITORY: "extra-github-value",
					BOBBIT_SESSION_ID: "extra-bobbit-value",
					EXTRA_SAFE: "not-on-allowlist",
				}, { cwd: unsafeCwd });

				assert.equal(env.HOME, path.join(home, "override"));
				assert.equal(env.LANG, "fr_FR.UTF-8");
				assert.equal(env.LC_ALL, "C.UTF-8");
				assert.equal(env.TMPDIR, tmp);
				assert.equal(env.TEMP, tmp);
				assert.ok(String(env.PATH || "").split(path.delimiter).includes(fs.realpathSync(safeBin)));
				assert.ok(!String(env.PATH || "").split(path.delimiter).includes(fs.realpathSync(unsafeCwd)));

				assert.equal(env.ANTHROPIC_API_KEY, undefined);
				assert.equal(env.OPENAI_API_KEY, undefined);
				assert.equal(env.GITHUB_TOKEN, undefined);
				assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
				assert.equal(env.GOOGLE_APPLICATION_CREDENTIALS, undefined);
				assert.equal(env.BOBBIT_GATEWAY_TOKEN, undefined);
				assert.equal(env.UNRELATED_GATEWAY_VALUE, undefined);
				assert.equal(env.EXTRA_TOKEN, undefined);
				assert.equal(env.AWS_REGION, undefined);
				assert.equal(env.GITHUB_REPOSITORY, undefined);
				assert.equal(env.BOBBIT_SESSION_ID, undefined);
				assert.equal(env.EXTRA_SAFE, undefined);
			});
		} finally {
			fs.rmSync(safeBin, { recursive: true, force: true });
			fs.rmSync(unsafeCwd, { recursive: true, force: true });
			fs.rmSync(home, { recursive: true, force: true });
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
});

describe("Claude Code status", () => {
	it("probes with an absolute executable, execFile-style args, safe cwd, and sanitized env", async () => {
		let seen: any;
		const safeBin = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-status-path-"));
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-status-home-"));
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-status-tmp-"));
		try {
			const status = await withPatchedEnv({
				PATH: [path.dirname(process.execPath), safeBin, process.cwd()].join(path.delimiter),
				HOME: home,
				TMPDIR: tmp,
				LANG: "en_US.UTF-8",
				LC_CTYPE: "C.UTF-8",
				NODE_OPTIONS: "--require ./malicious.js",
				ANTHROPIC_API_KEY: "anthropic-secret",
				OPENAI_API_KEY: "openai-secret",
				GITHUB_TOKEN: "github-secret",
				AWS_ACCESS_KEY_ID: "aws-secret",
				GOOGLE_APPLICATION_CREDENTIALS: "/secret/google.json",
				BOBBIT_GATEWAY_TOKEN: "bobbit-secret",
			}, () => probeClaudeCodeStatus({ executablePath: process.execPath }, async (file, args, options) => {
				seen = { file, args, options };
				return { stdout: "claude 1.2.3\n", stderr: "" };
			}));

			assert.equal(seen.file, fs.realpathSync(process.execPath));
			assert.deepEqual(seen.args, ["--version"]);
			assert.equal(seen.options.shell, false);
			assert.ok(path.isAbsolute(seen.options.cwd));
			assert.equal(seen.options.env.HOME, home);
			assert.equal(seen.options.env.TMPDIR, tmp);
			assert.equal(seen.options.env.LANG, "en_US.UTF-8");
			assert.equal(seen.options.env.LC_CTYPE, "C.UTF-8");
			assert.equal(seen.options.env.NODE_OPTIONS, undefined);
			assert.equal(seen.options.env.ANTHROPIC_API_KEY, undefined);
			assert.equal(seen.options.env.OPENAI_API_KEY, undefined);
			assert.equal(seen.options.env.GITHUB_TOKEN, undefined);
			assert.equal(seen.options.env.AWS_ACCESS_KEY_ID, undefined);
			assert.equal(seen.options.env.GOOGLE_APPLICATION_CREDENTIALS, undefined);
			assert.equal(seen.options.env.BOBBIT_GATEWAY_TOKEN, undefined);
			assert.ok(String(seen.options.env.PATH || "").split(path.delimiter).includes(fs.realpathSync(safeBin)));
			assert.ok(!String(seen.options.env.PATH || "").split(path.delimiter).includes(process.cwd()));
			assert.equal(status.available, true);
			assert.equal(status.ready, true);
			assert.equal(status.authenticated, false);
			assert.equal(status.authenticationStatus, "unknown");
			assert.equal(status.version, "1.2.3");
			assert.match(status.message || "", /verified when a Claude Code session starts/);
		} finally {
			fs.rmSync(safeBin, { recursive: true, force: true });
			fs.rmSync(home, { recursive: true, force: true });
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("rejects relative executable paths during trusted resolution", () => {
		assert.throws(() => resolveClaudeCodeExecutable("./claude"), /absolute path or a command name/);
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
			assert.deepEqual(local.map(m => m.id), ["local-claude-opus-4-8", "local-claude-sonnet-4-6"]);
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

	it("keeps Claude Code models selectable when CLI is available but auth is unknown", async () => {
		const { prefs, dir } = makePrefs();
		try {
			prefs.set(CLAUDE_CODE_PREF_KEYS.executablePath, process.execPath);
			const models = await getAvailableModels(prefs);
			const opus48 = models.find(m => m.provider === "claude-code" && m.id === "local-claude-opus-4-8");
			assert.ok(opus48);
			assert.equal(opus48.name, "local-claude-opus-4-8");
			assert.equal(opus48.authenticated, false);
			assert.equal(opus48.sessionSelectable, true);
			assert.equal(opus48.sessionUnavailableReason, undefined);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("ignores project-scoped Claude Code executable paths for automatic model probes", async () => {
		const { prefs, dir } = makePrefs();
		try {
			prefs.set(CLAUDE_CODE_PREF_KEYS.executablePath, path.join(dir, "missing-global-claude"));
			const projectConfig = {
				get(key: string) {
					return key === "claudeCodeExecutablePath" ? process.execPath : undefined;
				},
			};
			const models = await getAvailableModels(prefs, projectConfig);
			const opus48 = models.find(m => m.provider === "claude-code" && m.id === "local-claude-opus-4-8");
			assert.ok(opus48);
			assert.equal(opus48.sessionSelectable, false);
			assert.equal(opus48.sessionUnavailableReason, "Claude Code CLI not found");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("allows test harnesses to fake authenticated status explicitly", async () => {
		const { prefs, dir } = makePrefs();
		const previous = process.env.BOBBIT_TEST_CLAUDE_CODE_AUTHENTICATED;
		process.env.BOBBIT_TEST_CLAUDE_CODE_AUTHENTICATED = "1";
		try {
			prefs.set(CLAUDE_CODE_PREF_KEYS.executablePath, process.execPath);
			invalidateClaudeCodeStatusCache();
			invalidateModelCache();
			const models = await getAvailableModels(prefs);
			const opus48 = models.find(m => m.provider === "claude-code" && m.id === "local-claude-opus-4-8");
			assert.ok(opus48);
			assert.equal(opus48.authenticated, true);
			assert.equal(opus48.sessionSelectable, true);
			assert.equal(opus48.sessionUnavailableReason, undefined);
		} finally {
			if (previous === undefined) delete process.env.BOBBIT_TEST_CLAUDE_CODE_AUTHENTICATED;
			else process.env.BOBBIT_TEST_CLAUDE_CODE_AUTHENTICATED = previous;
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
