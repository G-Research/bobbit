import { accessSync, existsSync, realpathSync } from "node:fs";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PreferencesStore } from "./preferences-store.js";

export type ClaudeCodePermissionMode = "default" | "acceptEdits" | "bypassPermissions";
export type ClaudeCodeModelAlias = "default" | "sonnet" | "opus" | string;

export interface ClaudeCodeConfig {
	executablePath: string;
	defaultModel: ClaudeCodeModelAlias;
	permissionMode: ClaudeCodePermissionMode;
	allowBypassPermissions: boolean;
}

export const CLAUDE_CODE_DEFAULT_CONFIG: ClaudeCodeConfig = {
	executablePath: "claude",
	defaultModel: "sonnet",
	permissionMode: "default",
	allowBypassPermissions: false,
};

export const CLAUDE_CODE_PREF_KEYS = {
	executablePath: "claudeCode.executablePath",
	defaultModel: "claudeCode.defaultModel",
	permissionMode: "claudeCode.permissionMode",
	allowBypassPermissions: "claudeCode.allowBypassPermissions",
} as const;

export const CLAUDE_CODE_MODEL_ALIASES = ["default", "sonnet", "opus"] as const;
export const CLAUDE_CODE_PERMISSION_MODES = ["default", "acceptEdits", "bypassPermissions"] as const;

const PATH_KEYS = new Set(["PATH", "Path"]);
const ENV_BLOCKLIST = new Set([
	"NODE_OPTIONS",
	"NODE_PATH",
	"LD_PRELOAD",
	"LD_LIBRARY_PATH",
	"DYLD_INSERT_LIBRARIES",
	"DYLD_LIBRARY_PATH",
	"PYTHONPATH",
	"RUBYOPT",
	"BUNDLE_GEMFILE",
]);

export interface ClaudeCodeExecutableResolutionOptions {
	cwd?: string;
	pathEnv?: string;
	platform?: NodeJS.Platform;
}

export interface ResolvedClaudeCodeExecutable {
	executablePath: string;
	pathEnv: string;
}

export function isClaudeCodePreferenceKey(key: string): boolean {
	return key.startsWith("claudeCode.");
}

export function readClaudeCodeConfig(
	prefs: Pick<PreferencesStore, "get">,
	projectConfig?: { get(key: string): string | undefined } | null,
): ClaudeCodeConfig {
	// SECURITY: the host executable path is user/admin preference only. Project
	// config is untrusted repository-controlled input, and `/api/models` probes
	// this path automatically.
	const executablePath = normalizeExecutablePath(prefs.get(CLAUDE_CODE_PREF_KEYS.executablePath));
	const defaultModel = normalizeModelAlias(
		projectConfig?.get("claudeCodeDefaultModel") ?? prefs.get(CLAUDE_CODE_PREF_KEYS.defaultModel),
	);
	// SECURITY: bypass opt-in is user/admin preference only. A project may request
	// a permission mode, but `bypassPermissions` is downgraded unless the user has
	// explicitly enabled the global opt-in.
	const allowBypassPermissions = prefs.get(CLAUDE_CODE_PREF_KEYS.allowBypassPermissions) === true;
	const permissionMode = normalizePermissionMode(
		projectConfig?.get("claudeCodePermissionMode") ?? prefs.get(CLAUDE_CODE_PREF_KEYS.permissionMode),
		allowBypassPermissions,
	);
	return { executablePath, defaultModel, permissionMode, allowBypassPermissions };
}

export function normalizeExecutablePath(value: unknown): string {
	if (typeof value !== "string") return CLAUDE_CODE_DEFAULT_CONFIG.executablePath;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : CLAUDE_CODE_DEFAULT_CONFIG.executablePath;
}

export function validateExecutablePath(value: unknown): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error("Claude Code executable path must be a non-empty string");
	}
	const trimmed = value.trim();
	if (isRelativeExecutablePath(trimmed)) {
		throw new Error("Claude Code executable path must be a command name on PATH or an absolute path, not a relative path");
	}
	if (!path.isAbsolute(trimmed) && !/^[A-Za-z0-9._-]+$/.test(trimmed)) {
		throw new Error("Claude Code executable name contains unsupported characters");
	}
	return trimmed;
}

export function resolveClaudeCodeExecutable(
	value: unknown,
	options: ClaudeCodeExecutableResolutionOptions = {},
): ResolvedClaudeCodeExecutable {
	const executablePath = normalizeExecutablePath(value);
	const platform = options.platform ?? process.platform;
	const pathEnv = buildTrustedPathEnv(options.pathEnv ?? process.env.PATH ?? process.env.Path ?? "", options.cwd, platform);

	if (path.isAbsolute(executablePath)) {
		return { executablePath: assertExecutableFile(executablePath, platform), pathEnv };
	}
	if (isRelativeExecutablePath(executablePath)) {
		throw new Error("Claude Code executable path must be an absolute path or a command name on trusted PATH");
	}
	if (!/^[A-Za-z0-9._-]+$/.test(executablePath)) {
		throw new Error("Claude Code executable name contains unsupported characters");
	}

	for (const dir of pathEnv.split(path.delimiter).filter(Boolean)) {
		for (const candidate of executableCandidates(path.join(dir, executablePath), platform)) {
			if (!existsSync(candidate)) continue;
			try {
				return { executablePath: assertExecutableFile(candidate, platform), pathEnv };
			} catch {
				// Keep searching PATH for a runnable Claude Code executable.
			}
		}
	}
	throw new Error("Claude Code CLI not found on trusted PATH");
}

export function buildClaudeCodeSanitizedEnv(
	extraEnv: NodeJS.ProcessEnv | undefined,
	options: ClaudeCodeExecutableResolutionOptions = {},
): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined || shouldDropEnvKey(key)) continue;
		env[key] = value;
	}
	for (const [key, value] of Object.entries(extraEnv ?? {})) {
		if (value === undefined || shouldDropEnvKey(key)) continue;
		env[key] = value;
	}
	const trustedPath = buildTrustedPathEnv(options.pathEnv ?? process.env.PATH ?? process.env.Path ?? "", options.cwd, options.platform);
	if (trustedPath) env.PATH = trustedPath;
	const pathext = process.env.PATHEXT;
	if (pathext) env.PATHEXT = pathext;
	return env;
}

export function getClaudeCodeProbeCwd(): string {
	const home = os.homedir();
	if (home && existsSync(home)) return home;
	return path.parse(process.cwd()).root;
}

export function normalizeModelAlias(value: unknown): ClaudeCodeModelAlias {
	if (typeof value !== "string") return CLAUDE_CODE_DEFAULT_CONFIG.defaultModel;
	const trimmed = value.trim();
	return isValidModelAlias(trimmed) ? trimmed : CLAUDE_CODE_DEFAULT_CONFIG.defaultModel;
}

export function validateModelAlias(value: unknown): ClaudeCodeModelAlias {
	if (typeof value !== "string" || !isValidModelAlias(value.trim())) {
		throw new Error("Claude Code model alias must be default, sonnet, opus, or a short model token");
	}
	return value.trim();
}

export function isValidModelAlias(value: string): boolean {
	if (!value) return false;
	if ((CLAUDE_CODE_MODEL_ALIASES as readonly string[]).includes(value)) return true;
	return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(value);
}

export function normalizePermissionMode(value: unknown, allowBypassPermissions: boolean): ClaudeCodePermissionMode {
	if (typeof value !== "string" || !(CLAUDE_CODE_PERMISSION_MODES as readonly string[]).includes(value)) {
		return CLAUDE_CODE_DEFAULT_CONFIG.permissionMode;
	}
	if (value === "bypassPermissions" && !allowBypassPermissions) return CLAUDE_CODE_DEFAULT_CONFIG.permissionMode;
	return value as ClaudeCodePermissionMode;
}

export function validatePermissionMode(value: unknown, allowBypassPermissions: boolean): ClaudeCodePermissionMode {
	if (typeof value !== "string" || !(CLAUDE_CODE_PERMISSION_MODES as readonly string[]).includes(value)) {
		throw new Error("Claude Code permission mode must be default, acceptEdits, or bypassPermissions");
	}
	if (value === "bypassPermissions" && !allowBypassPermissions) {
		throw new Error("Claude Code bypassPermissions requires claudeCode.allowBypassPermissions=true");
	}
	return value as ClaudeCodePermissionMode;
}

function isRelativeExecutablePath(value: string): boolean {
	if (path.isAbsolute(value)) return false;
	return value.startsWith("./") || value.startsWith("../") || value === "." || value === ".." || value.includes("/") || value.includes("\\");
}

function buildTrustedPathEnv(pathEnv: string, unsafeCwd: string | undefined, platform: NodeJS.Platform = process.platform): string {
	const unsafeReal = realpathOrUndefined(unsafeCwd);
	const dirs: string[] = [];
	const seen = new Set<string>();
	for (const rawEntry of pathEnv.split(path.delimiter)) {
		const entry = rawEntry.trim();
		if (!entry || entry === "." || !path.isAbsolute(entry)) continue;
		const realEntry = realpathOrUndefined(entry);
		if (!realEntry) continue;
		if (unsafeReal && (realEntry === unsafeReal || realEntry.startsWith(`${unsafeReal}${path.sep}`))) continue;
		const key = platform === "win32" ? realEntry.toLowerCase() : realEntry;
		if (seen.has(key)) continue;
		seen.add(key);
		dirs.push(realEntry);
	}
	return dirs.join(path.delimiter);
}

function executableCandidates(base: string, platform: NodeJS.Platform): string[] {
	if (platform !== "win32" || path.extname(base)) return [base];
	const extensions = (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM")
		.split(";")
		.map(ext => ext.trim())
		.filter(Boolean);
	return [base, ...extensions.map(ext => `${base}${ext.toLowerCase()}`), ...extensions.map(ext => `${base}${ext.toUpperCase()}`)];
}

function assertExecutableFile(file: string, platform: NodeJS.Platform): string {
	const real = realpathSync(file);
	accessSync(real, platform === "win32" ? constants.F_OK : constants.X_OK);
	return real;
}

function realpathOrUndefined(value: string | undefined): string | undefined {
	if (!value) return undefined;
	try {
		return realpathSync(value);
	} catch {
		return undefined;
	}
}

function shouldDropEnvKey(key: string): boolean {
	return PATH_KEYS.has(key) || ENV_BLOCKLIST.has(key) || key === "PATHEXT" || key === "PWD" || key === "OLDPWD";
}

export function normalizeClaudeCodePreferencePatch(
	patch: Record<string, unknown>,
	prefs: Pick<PreferencesStore, "get">,
): { ok: true; values: Record<string, unknown> } | { ok: false; error: string } {
	try {
		const values: Record<string, unknown> = {};
		const currentAllowBypass = prefs.get(CLAUDE_CODE_PREF_KEYS.allowBypassPermissions) === true;
		const nextAllowBypass = Object.prototype.hasOwnProperty.call(patch, CLAUDE_CODE_PREF_KEYS.allowBypassPermissions)
			? patch[CLAUDE_CODE_PREF_KEYS.allowBypassPermissions] === true
			: currentAllowBypass;

		for (const [key, value] of Object.entries(patch)) {
			if (!isClaudeCodePreferenceKey(key)) continue;
			switch (key) {
				case CLAUDE_CODE_PREF_KEYS.executablePath:
					if (value !== null && value !== undefined) values[key] = validateExecutablePath(value);
					break;
				case CLAUDE_CODE_PREF_KEYS.defaultModel:
					if (value !== null && value !== undefined) values[key] = validateModelAlias(value);
					break;
				case CLAUDE_CODE_PREF_KEYS.permissionMode:
					if (value !== null && value !== undefined) values[key] = validatePermissionMode(value, nextAllowBypass);
					break;
				case CLAUDE_CODE_PREF_KEYS.allowBypassPermissions:
					if (value !== null && value !== undefined && typeof value !== "boolean") {
						throw new Error("Claude Code allowBypassPermissions must be a boolean");
					}
					if (value !== null && value !== undefined) values[key] = value;
					break;
				default:
					throw new Error(`Unknown Claude Code preference: ${key}`);
			}
		}

		if (!nextAllowBypass) {
			const requestedMode = values[CLAUDE_CODE_PREF_KEYS.permissionMode];
			const currentMode = prefs.get(CLAUDE_CODE_PREF_KEYS.permissionMode);
			if (requestedMode === "bypassPermissions" || (requestedMode === undefined && currentMode === "bypassPermissions")) {
				values[CLAUDE_CODE_PREF_KEYS.permissionMode] = CLAUDE_CODE_DEFAULT_CONFIG.permissionMode;
			}
		}

		return { ok: true, values };
	} catch (err: any) {
		return { ok: false, error: err?.message || String(err) };
	}
}
