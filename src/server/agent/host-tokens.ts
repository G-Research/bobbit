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
		// Google account OAuth path (Gemini Code Assist). `GOOGLE_CLOUD_ACCESS_TOKEN`
		// is the env var the Gemini CLI / google-auth honor for a pre-acquired Bearer
		// token (paired with GOOGLE_GENAI_USE_GCA=1). Distinct from the API-key `google`
		// provider above so the two never collide.
		envVar: "GOOGLE_CLOUD_ACCESS_TOKEN",
		label: "Google (Gemini Code Assist OAuth)",
		provider: "google-gemini-cli",
		envKeys: ["GOOGLE_CLOUD_ACCESS_TOKEN"],
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
/** Sandbox-token policy keys that opt a sandbox into the Google account (Gemini Code Assist) OAuth credential. */
export const GOOGLE_GEMINI_CLI_SANDBOX_AUTH_TOKEN_KEYS = new Set(["GOOGLE_CLOUD_ACCESS_TOKEN"]);

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

function isUsableGoogleOAuthCredential(value: unknown): value is Record<string, any> {
	return isCredentialObject(value) && value.type === "oauth" && typeof value.access === "string" && !!value.access;
}

/**
 * Sanitize the stored `google-gemini-cli` (Google account / Gemini Code Assist) OAuth
 * credential down to exactly the fields a sandboxed agent needs to use and refresh a
 * Bearer token. Never copies `email`/profile/scope/account display metadata into the
 * sandbox-visible auth.json. Returns undefined for absent or API-key-only values.
 */
function sanitizeGoogleCredential(value: unknown): Record<string, any> | undefined {
	if (!isUsableGoogleOAuthCredential(value)) return undefined;
	const sanitized: Record<string, any> = { type: "oauth", access: value.access };
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
	/** Opt the sandbox into the Google account (Gemini Code Assist) OAuth credential. */
	includeGoogleAuth?: boolean;
	/** Separate files prevent one project's authorized mount from feeding another project's denied mount. */
	scope?: string;
}

function normalizeSandboxAgentAuthOptions(options?: PreferencesStore | SandboxAgentAuthOptions | null): SandboxAgentAuthOptions {
	if (!options || typeof (options as any).get === "function") {
		return { prefs: options as PreferencesStore | null | undefined, includeCodexAuth: false, includeGoogleAuth: false };
	}
	return options as SandboxAgentAuthOptions;
}

/** Resolve the sanitized OpenAI Codex credential for the sandbox (prefs key → host auth.json oauth/api_key → legacy `openai` oauth). */
function resolveSandboxCodexCredential(prefs?: PreferencesStore | null): Record<string, any> | undefined {
	const storedCodexKey = prefs?.get("providerKey.openai-codex") as string | undefined;
	if (storedCodexKey) return { type: "api_key", key: storedCodexKey };

	const hostAuth = readHostAuthJson();
	if (!hostAuth) return undefined;

	const codex = sanitizeCodexCredential(hostAuth["openai-codex"]);
	if (codex) return codex;

	// Older installs may have ChatGPT OAuth under `openai`. Only OAuth is a
	// Codex-compatible credential; OpenAI API keys continue to flow via env vars.
	const openai = hostAuth.openai;
	return isCredentialObject(openai) && openai.type === "oauth"
		? sanitizeCodexCredential(openai)
		: undefined;
}

/** Resolve the sanitized Google account (Gemini Code Assist) OAuth credential for the sandbox. */
function resolveSandboxGoogleCredential(): Record<string, any> | undefined {
	const hostAuth = readHostAuthJson();
	if (!hostAuth) return undefined;
	return sanitizeGoogleCredential(hostAuth["google-gemini-cli"]);
}

/**
 * Build the minimal auth.json content a sandboxed pi-coding-agent needs for
 * provider OAuth. Returns an empty object unless sandbox token policy explicitly
 * opts the sandbox into a provider's credentials. Codex and Google are independent,
 * provider-isolated entries: opting into one never includes the other.
 */
export function buildSandboxAgentAuthJson(options?: PreferencesStore | SandboxAgentAuthOptions | null): Record<string, any> {
	const { prefs, includeCodexAuth = false, includeGoogleAuth = false } = normalizeSandboxAgentAuthOptions(options);
	const auth: Record<string, any> = {};

	if (includeCodexAuth) {
		const codex = resolveSandboxCodexCredential(prefs);
		if (codex) auth["openai-codex"] = codex;
	}

	if (includeGoogleAuth) {
		const google = resolveSandboxGoogleCredential();
		if (google) auth["google-gemini-cli"] = google;
	}

	return auth;
}

export function sandboxTokenPolicyAllowsCodexAuth(entries: Array<{ key?: string; enabled?: boolean }> | undefined | null): boolean {
	return (entries || []).some((entry) => entry.enabled !== false && !!entry.key && OPENAI_CODEX_SANDBOX_AUTH_TOKEN_KEYS.has(entry.key));
}

export function sandboxTokenPolicyAllowsGoogleAuth(entries: Array<{ key?: string; enabled?: boolean }> | undefined | null): boolean {
	return (entries || []).some((entry) => entry.enabled !== false && !!entry.key && GOOGLE_GEMINI_CLI_SANDBOX_AUTH_TOKEN_KEYS.has(entry.key));
}

export function resolveSandboxAgentAuthPolicy(entries: Array<{ key?: string; enabled?: boolean }> | undefined | null): { includeCodexAuth: boolean; includeGoogleAuth: boolean } {
	const list = entries || [];
	return {
		// Preserve legacy Codex behavior: projects without an explicit sandbox_tokens
		// policy still receive the host Codex auth file when available.
		includeCodexAuth: list.length === 0 || sandboxTokenPolicyAllowsCodexAuth(list),
		// Google OAuth carries a Google refresh token; require explicit opt-in.
		includeGoogleAuth: sandboxTokenPolicyAllowsGoogleAuth(list),
	};
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

	// Check auth.json for provider tokens.
	// For the Google account OAuth path (GOOGLE_CLOUD_ACCESS_TOKEN → provider
	// `google-gemini-cli`) this returns the stored `oauth.access` synchronously.
	// It may be expired; the sandbox refreshes it using the refresh token that
	// rides along in the sanitized sandbox auth.json. Gateway-side fresh refresh
	// is the responsibility of the async OAuth refresh helper, not this sync path.
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
