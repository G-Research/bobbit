/**
 * AgentMemory preferences resolution.
 *
 * Defines the system-level preference keys, defaults, and a project-scope
 * resolver. Default is OFF — when `agentMemoryEnabled !== true` at the
 * system level, every project resolves to fully disabled regardless of
 * project config.
 *
 * Project config keys (read from ProjectConfigStore's flat string view via
 * the `agentmemory.*` namespace, but we accept either dotted or underscored
 * names so legacy callers continue to work):
 *
 *   agentmemory.enabled       inherit | true | false
 *   agentmemory.inject        inherit | true | false
 *   agentmemory.autoCapture   inherit | true | false
 *   agentmemory.scope         project+global | project | global
 *   agentmemory.projectKey    string (optional override)
 *   agentmemory.tokenBudget   integer (200..4000)
 *
 * See docs/design/agentmemory-integration.md.
 */

export type AgentMemoryMode = "external" | "managed" | "mcp-only";
export type AgentMemoryScope = "project+global" | "project" | "global";

export interface AgentMemorySystemPrefs {
	enabled: boolean;
	/** null means "ask on first enable" (the wizard has not run yet). */
	mode: AgentMemoryMode | null;
	url: string;
	autoCapture: boolean;
	globalRecall: boolean;
	defaultInject: boolean;
	tokenBudget: number;
	managedPackage: string;
	managedDataDir: string | null;
}

export interface AgentMemoryResolvedProjectPrefs {
	/** Effective enabled for this project. False when system is off. */
	enabled: boolean;
	/** Effective prompt injection (per-project; default off). */
	inject: boolean;
	/** Effective auto-capture (default follows system). */
	autoCapture: boolean;
	scope: AgentMemoryScope;
	projectKey: string | undefined;
	tokenBudget: number;
}

/** Preference keys read/written via PreferencesStore (system scope). */
export const PREF_KEYS = {
	enabled: "agentMemoryEnabled",
	mode: "agentMemoryMode",
	url: "agentMemoryUrl",
	autoCapture: "agentMemoryAutoCapture",
	globalRecall: "agentMemoryGlobalRecall",
	defaultInject: "agentMemoryDefaultInject",
	tokenBudget: "agentMemoryTokenBudget",
	managedPackage: "agentMemoryManagedPackage",
	managedDataDir: "agentMemoryManagedDataDir",
} as const;

/** Secret key used in SecretsStore for the bearer token. */
export const SECRET_KEY = "agentMemoryBearerToken";

export const TOKEN_BUDGET_MIN = 200;
export const TOKEN_BUDGET_MAX = 4000;
export const TOKEN_BUDGET_DEFAULT = 1200;

export const DEFAULT_URL = "http://127.0.0.1:3111";
export const DEFAULT_VIEWER_URL = "http://127.0.0.1:3113";
export const DEFAULT_MANAGED_PACKAGE = "@agentmemory/agentmemory";

const VALID_MODES: readonly AgentMemoryMode[] = ["external", "managed", "mcp-only"];
const VALID_SCOPES: readonly AgentMemoryScope[] = ["project+global", "project", "global"];

export function isAgentMemoryMode(x: unknown): x is AgentMemoryMode {
	return typeof x === "string" && (VALID_MODES as readonly string[]).includes(x);
}

export function isAgentMemoryScope(x: unknown): x is AgentMemoryScope {
	return typeof x === "string" && (VALID_SCOPES as readonly string[]).includes(x);
}

export function clampTokenBudget(raw: unknown): number {
	let n: number;
	if (typeof raw === "number") n = raw;
	else if (typeof raw === "string" && raw.trim() !== "") n = Number(raw);
	else return TOKEN_BUDGET_DEFAULT;
	if (!Number.isFinite(n)) return TOKEN_BUDGET_DEFAULT;
	n = Math.trunc(n);
	if (n < TOKEN_BUDGET_MIN) return TOKEN_BUDGET_MIN;
	if (n > TOKEN_BUDGET_MAX) return TOKEN_BUDGET_MAX;
	return n;
}

/** Minimal interface we need from PreferencesStore — keeps tests injectable. */
export interface PrefReader {
	get(key: string): unknown | undefined;
}

/** Read system-level AgentMemory preferences with defaults applied. */
export function readSystemPrefs(prefs: PrefReader): AgentMemorySystemPrefs {
	const enabled = prefs.get(PREF_KEYS.enabled) === true;
	const rawMode = prefs.get(PREF_KEYS.mode);
	const mode: AgentMemoryMode | null = isAgentMemoryMode(rawMode) ? rawMode : null;
	const rawUrl = prefs.get(PREF_KEYS.url);
	const url = typeof rawUrl === "string" && rawUrl.trim() !== "" ? rawUrl.trim() : DEFAULT_URL;
	const autoCapture = prefs.get(PREF_KEYS.autoCapture);
	const globalRecall = prefs.get(PREF_KEYS.globalRecall);
	const defaultInject = prefs.get(PREF_KEYS.defaultInject);
	const tokenBudget = clampTokenBudget(prefs.get(PREF_KEYS.tokenBudget));
	const rawPkg = prefs.get(PREF_KEYS.managedPackage);
	const managedPackage = typeof rawPkg === "string" && rawPkg.trim() !== "" ? rawPkg.trim() : DEFAULT_MANAGED_PACKAGE;
	const rawDataDir = prefs.get(PREF_KEYS.managedDataDir);
	const managedDataDir = typeof rawDataDir === "string" && rawDataDir.trim() !== "" ? rawDataDir : null;
	return {
		enabled,
		mode,
		url,
		// autoCapture / globalRecall default ON when enabled; default-off only when user set false.
		autoCapture: autoCapture === undefined ? true : autoCapture === true,
		globalRecall: globalRecall === undefined ? true : globalRecall === true,
		defaultInject: defaultInject === true,
		tokenBudget,
		managedPackage,
		managedDataDir,
	};
}

/** Minimal interface we need from ProjectConfigStore — keeps tests injectable. */
export interface ProjectConfigReader {
	get(key: string): string | undefined;
}

/** Normalize the per-project flat-string ternary: "inherit" | "true" | "false". */
function readTernary(p: ProjectConfigReader, dotted: string): "inherit" | true | false {
	// Project store rejects dotted keys via set(), but loads from yaml,
	// so we accept dotted on read. Also support underscore fallback.
	const candidates = [dotted, dotted.replace(/\./g, "_")];
	for (const k of candidates) {
		const v = p.get(k);
		if (v === undefined) continue;
		const s = String(v).trim().toLowerCase();
		if (s === "" || s === "inherit") return "inherit";
		if (s === "true" || s === "yes" || s === "on" || s === "1") return true;
		if (s === "false" || s === "no" || s === "off" || s === "0") return false;
	}
	return "inherit";
}

function readString(p: ProjectConfigReader, dotted: string): string | undefined {
	const candidates = [dotted, dotted.replace(/\./g, "_")];
	for (const k of candidates) {
		const v = p.get(k);
		if (typeof v === "string" && v.trim() !== "") return v.trim();
	}
	return undefined;
}

/** Resolve effective per-project AgentMemory preferences.
 *
 * Rules:
 * - System disabled => everything disabled.
 * - Project `agentmemory.enabled=false` opts out.
 * - Project injection defaults OFF; project must explicitly set true.
 * - Auto-capture default follows system, project can override.
 * - Scope defaults to `project+global`; project can override.
 * - Token budget falls back to system; clamped.
 *
 * If project store is unavailable, behaves as full inherit.
 */
export function resolveProjectPrefs(
	system: AgentMemorySystemPrefs,
	project: ProjectConfigReader | null | undefined,
): AgentMemoryResolvedProjectPrefs {
	if (!system.enabled) {
		return {
			enabled: false,
			inject: false,
			autoCapture: false,
			scope: "project+global",
			projectKey: undefined,
			tokenBudget: system.tokenBudget,
		};
	}
	const enabledT = project ? readTernary(project, "agentmemory.enabled") : "inherit";
	const enabled = enabledT === false ? false : true;
	if (!enabled) {
		return {
			enabled: false,
			inject: false,
			autoCapture: false,
			scope: "project+global",
			projectKey: undefined,
			tokenBudget: system.tokenBudget,
		};
	}
	const injectT = project ? readTernary(project, "agentmemory.inject") : "inherit";
	const inject = injectT === true ? true : injectT === false ? false : system.defaultInject;
	const autoT = project ? readTernary(project, "agentmemory.autoCapture") : "inherit";
	const autoCapture = autoT === true ? true : autoT === false ? false : system.autoCapture;
	const rawScope = project ? readString(project, "agentmemory.scope") : undefined;
	const scope: AgentMemoryScope = isAgentMemoryScope(rawScope)
		? rawScope
		: !system.globalRecall ? "project" : "project+global";
	const projectKey = project ? readString(project, "agentmemory.projectKey") : undefined;
	const budgetRaw = project ? readString(project, "agentmemory.tokenBudget") : undefined;
	const tokenBudget = budgetRaw !== undefined ? clampTokenBudget(budgetRaw) : system.tokenBudget;
	return { enabled, inject, autoCapture, scope, projectKey, tokenBudget };
}
