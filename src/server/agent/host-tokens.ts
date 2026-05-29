/**
 * Detects which token/credential env vars are available on the host.
 * Returns env var names only — never values — for display in the settings UI.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { bobbitStateDir, globalAuthPath } from "../bobbit-dir.js";
import type { PreferencesStore } from "./preferences-store.js";

/** Provider keys from auth.json / host env → sandbox env var name + description */
const PROVIDER_TOKENS: { envVar: string; label: string; provider: string; envKeys: string[] }[] = [
	{
		envVar: "ANTHROPIC_OAUTH_TOKEN",
		label: "Anthropic (OAuth / API key)",
		provider: "anthropic",
		envKeys: ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
	},
	{
		envVar: "OPENAI_API_KEY",
		label: "OpenAI",
		provider: "openai",
		envKeys: ["OPENAI_API_KEY"],
	},
	{
		envVar: "GEMINI_API_KEY",
		label: "Google Gemini",
		provider: "google",
		envKeys: ["GEMINI_API_KEY"],
	},
	{
		envVar: "XAI_API_KEY",
		label: "xAI / Grok",
		provider: "xai",
		envKeys: ["XAI_API_KEY"],
	},
	{
		envVar: "GROQ_API_KEY",
		label: "Groq",
		provider: "groq",
		envKeys: ["GROQ_API_KEY"],
	},
	{
		envVar: "MISTRAL_API_KEY",
		label: "Mistral",
		provider: "mistral",
		envKeys: ["MISTRAL_API_KEY"],
	},
	{
		envVar: "OPENROUTER_API_KEY",
		label: "OpenRouter",
		provider: "openrouter",
		envKeys: ["OPENROUTER_API_KEY"],
	},
];

/** Well-known non-provider tokens that users may want in sandboxes */
export const SANDBOX_AGENT_AUTH_RELATIVE_PATH = path.join("sandbox-agent-auth", "auth.json");
export const OPENAI_CODEX_SANDBOX_AUTH_TOKEN_KEYS = new Set(["OPENAI_API_KEY", "OPENAI_CODEX_AUTH"]);

const TOOL_TOKENS: { envVar: string; label: string; detect: () => boolean }[] = [
	{
		envVar: "OPENAI_CODEX_AUTH",
		label: "OpenAI Codex (auth.json)",
		detect: () => hasOpenAiCodexAuth(),
	},
	{
		envVar: "GITHUB_TOKEN",
		label: "GitHub (git push, gh CLI)",
		detect: () => !!(process.env["GITHUB_TOKEN"] || process.env["GH_TOKEN"] || detectGhCli()),
	},
	{
		envVar: "NPM_TOKEN",
		label: "npm (private registry)",
		detect: () => !!process.env["NPM_TOKEN"],
	},
];

function detectGhCli(): boolean {
	try {
		const token = execFileSync("gh", ["auth", "token"], { timeout: 5_000, encoding: "utf-8" }).trim();
		return !!token;
	} catch {
		return false;
	}
}

function readHostAuthJson(): Record<string, any> | null {
	try {
		const authPath = globalAuthPath();
		if (!fs.existsSync(authPath)) return null;
		const data = JSON.parse(fs.readFileSync(authPath, "utf-8"));
		return data && typeof data === "object" && !Array.isArray(data) ? data : null;
	} catch { return null; }
}

function detectAuthJson(): Record<string, boolean> {
	const result: Record<string, boolean> = {};
	const data = readHostAuthJson();
	if (data) {
		for (const key of Object.keys(data)) {
			result[key] = true;
		}
	}
	return result;
}

function hasOpenAiCodexAuth(): boolean {
	const data = readHostAuthJson();
	return !!(isUsableCodexCredential(data?.["openai-codex"])
		|| (isCredentialObject(data?.openai) && data?.openai.type === "oauth" && isUsableCodexCredential(data.openai)));
}

function isCredentialObject(value: unknown): value is Record<string, any> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function isUsableCodexCredential(value: unknown): value is Record<string, any> {
	if (!isCredentialObject(value)) return false;
	if (value.type === "oauth" && typeof value.access === "string" && value.access) return true;
	if (value.type === "api_key" && typeof value.key === "string" && value.key) return true;
	return false;
}

function sanitizeCodexCredential(value: unknown): Record<string, any> | undefined {
	if (!isUsableCodexCredential(value)) return undefined;
	if (value.type === "api_key") return { type: "api_key", key: value.key };
	const sanitized: Record<string, any> = { type: "oauth", access: value.access };
	// Pi's OAuth credential schema uses refresh/expires for token refresh; do not
	// copy unrelated account/profile metadata into sandbox-visible auth.json.
	if (typeof value.refresh === "string" && value.refresh) sanitized.refresh = value.refresh;
	if (typeof value.expires === "number") sanitized.expires = value.expires;
	return sanitized;
}

function sanitizeAuthScope(scope?: string): string | undefined {
	if (!scope) return undefined;
	const safe = scope.replace(/[^A-Za-z0-9_.-]/g, "_").replace(/^\.+$/, "_");
	return safe || undefined;
}

export function sandboxAgentAuthPath(scope?: string): string {
	const safeScope = sanitizeAuthScope(scope);
	return safeScope
		? path.join(bobbitStateDir(), "sandbox-agent-auth", `${safeScope}.auth.json`)
		: path.join(bobbitStateDir(), SANDBOX_AGENT_AUTH_RELATIVE_PATH);
}

export interface SandboxAgentAuthOptions {
	prefs?: PreferencesStore | null;
	includeCodexAuth?: boolean;
	/** Separate files prevent one project's authorized mount from feeding another project's denied mount. */
	scope?: string;
}

function normalizeSandboxAgentAuthOptions(options?: PreferencesStore | SandboxAgentAuthOptions | null): SandboxAgentAuthOptions {
	if (!options || typeof (options as any).get === "function") {
		return { prefs: options as PreferencesStore | null | undefined, includeCodexAuth: false };
	}
	return options as SandboxAgentAuthOptions;
}

/**
 * Build the minimal auth.json content a sandboxed pi-coding-agent needs for
 * ChatGPT / OpenAI Codex OAuth. Returns an empty object unless sandbox token
 * policy explicitly allows OpenAI/Codex credentials for this sandbox.
 */
export function buildSandboxAgentAuthJson(options?: PreferencesStore | SandboxAgentAuthOptions | null): Record<string, any> {
	const { prefs, includeCodexAuth = false } = normalizeSandboxAgentAuthOptions(options);
	const auth: Record<string, any> = {};
	if (!includeCodexAuth) return auth;

	const storedCodexKey = prefs?.get("providerKey.openai-codex") as string | undefined;
	if (storedCodexKey) {
		auth["openai-codex"] = { type: "api_key", key: storedCodexKey };
		return auth;
	}

	const hostAuth = readHostAuthJson();
	if (!hostAuth) return auth;

	const codex = sanitizeCodexCredential(hostAuth["openai-codex"]);
	if (codex) {
		auth["openai-codex"] = codex;
		return auth;
	}

	// Older installs may have ChatGPT OAuth under `openai`. Only OAuth is a
	// Codex-compatible credential; OpenAI API keys continue to flow via env vars.
	const openai = hostAuth.openai;
	const legacyCodex = isCredentialObject(openai) && openai.type === "oauth"
		? sanitizeCodexCredential(openai)
		: undefined;
	if (legacyCodex) auth["openai-codex"] = legacyCodex;
	return auth;
}

export function sandboxTokenPolicyAllowsCodexAuth(entries: Array<{ key?: string; enabled?: boolean }> | undefined | null): boolean {
	return (entries || []).some((entry) => entry.enabled !== false && !!entry.key && OPENAI_CODEX_SANDBOX_AUTH_TOKEN_KEYS.has(entry.key));
}

export function ensureSandboxAgentAuthFile(options?: PreferencesStore | SandboxAgentAuthOptions | null): string {
	const normalized = normalizeSandboxAgentAuthOptions(options);
	const authPath = sandboxAgentAuthPath(normalized.scope);
	const next = `${JSON.stringify(buildSandboxAgentAuthJson(normalized), null, 2)}\n`;
	fs.mkdirSync(path.dirname(authPath), { recursive: true });
	let current: string | undefined;
	try { current = fs.readFileSync(authPath, "utf-8"); } catch { /* missing */ }
	if (current !== next) {
		fs.writeFileSync(authPath, next, { encoding: "utf-8", mode: 0o600 });
	}
	return authPath;
}

export interface DetectedHostToken {
	envVar: string;
	label: string;
	available: boolean;
}

/**
 * Scan the host for available tokens. Returns env var names + labels + availability.
 * Never returns actual token values.
 */
export function detectHostTokens(prefs?: PreferencesStore | null): DetectedHostToken[] {
	const authProviders = detectAuthJson();
	const result: DetectedHostToken[] = [];

	for (const t of PROVIDER_TOKENS) {
		const fromEnv = t.envKeys.some(k => !!process.env[k]);
		const fromAuth = !!authProviders[t.provider];
		const fromPrefs = prefs ? !!prefs.get(`providerKey.${t.provider}`) : false;
		result.push({ envVar: t.envVar, label: t.label, available: fromEnv || fromAuth || fromPrefs });
	}

	for (const t of TOOL_TOKENS) {
		result.push({ envVar: t.envVar, label: t.label, available: t.detect() });
	}

	return result;
}

/**
 * Resolve the actual value of a host token by env var name.
 * Used by the sandbox token system when a token has an empty value (meaning "from host").
 * Returns undefined if the token cannot be resolved.
 */
export function resolveHostTokenValue(envVar: string, prefs?: PreferencesStore | null): string | undefined {
	// Check env var directly
	if (process.env[envVar]) return process.env[envVar];

	// Special cases
	if (envVar === "GITHUB_TOKEN") {
		if (process.env["GH_TOKEN"]) return process.env["GH_TOKEN"];
		try {
			const token = execFileSync("gh", ["auth", "token"], { timeout: 5_000, encoding: "utf-8" }).trim();
			if (token) return token;
		} catch { /* gh not installed or not authenticated */ }
		return undefined;
	}

	if (envVar === "ANTHROPIC_OAUTH_TOKEN" && process.env["ANTHROPIC_API_KEY"]) {
		return process.env["ANTHROPIC_API_KEY"];
	}

	// Check auth.json for provider tokens
	const providerForEnv = PROVIDER_TOKENS.find(t => t.envVar === envVar);
	if (providerForEnv) {
		// Check preferences store
		if (prefs) {
			const storedKey = prefs.get(`providerKey.${providerForEnv.provider}`) as string | undefined;
			if (storedKey) return storedKey;
		}
		// Check auth.json
		try {
			const data = readHostAuthJson();
			const providerData = data?.[providerForEnv.provider];
			if (providerData) {
				if (providerData.type === "oauth" && providerData.access) return providerData.access;
				if (providerData.type === "api_key" && providerData.key) return providerData.key;
			}
		} catch { /* ignore read errors */ }
	}

	return undefined;
}
