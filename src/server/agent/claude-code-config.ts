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

export function isClaudeCodePreferenceKey(key: string): boolean {
	return key.startsWith("claudeCode.");
}

export function readClaudeCodeConfig(
	prefs: Pick<PreferencesStore, "get">,
	projectConfig?: { get(key: string): string | undefined } | null,
): ClaudeCodeConfig {
	const executablePath = normalizeExecutablePath(
		projectConfig?.get("claudeCodeExecutablePath") ?? prefs.get(CLAUDE_CODE_PREF_KEYS.executablePath),
	);
	const defaultModel = normalizeModelAlias(
		projectConfig?.get("claudeCodeDefaultModel") ?? prefs.get(CLAUDE_CODE_PREF_KEYS.defaultModel),
	);
	const projectAllowBypass = parseBooleanLike(projectConfig?.get("claudeCodeAllowBypassPermissions"));
	const allowBypassPermissions = projectAllowBypass ?? (prefs.get(CLAUDE_CODE_PREF_KEYS.allowBypassPermissions) === true);
	const permissionMode = normalizePermissionMode(
		projectConfig?.get("claudeCodePermissionMode") ?? prefs.get(CLAUDE_CODE_PREF_KEYS.permissionMode),
		allowBypassPermissions,
	);
	return { executablePath, defaultModel, permissionMode, allowBypassPermissions };
}

function parseBooleanLike(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim().toLowerCase();
	if (["true", "1", "yes", "on"].includes(trimmed)) return true;
	if (["false", "0", "no", "off"].includes(trimmed)) return false;
	return undefined;
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
	return value.trim();
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
