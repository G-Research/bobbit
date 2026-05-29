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

const TOOL_TOKENS: { envVar: string; label: string; detect: () => boolean }[] = [
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

function isCredentialObject(value: unknown): value is Record<string, any> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function isUsableCodexCredential(value: unknown): value is Record<string, any> {
	if (!isCredentialObject(value)) return false;
	if (value.type === "oauth" && typeof value.access === "string" && value.access) return true;
	if (value.type === "api_key" && typeof value.key === "string" && value.key) return true;
	return false;
}

export function sandboxAgentAuthPath(): string {
	return path.join(bobbitStateDir(), SANDBOX_AGENT_AUTH_RELATIVE_PATH);
}

/**
 * Build the minimal auth.json content a sandboxed pi-coding-agent needs for
 * ChatGPT / OpenAI Codex OAuth. Never copies unrelated provider credentials.
 */
export function buildSandboxAgentAuthJson(prefs?: PreferencesStore | null): Record<string, any> {
	const auth: Record<string, any> = {};
	const storedCodexKey = prefs?.get("providerKey.openai-codex") as string | undefined;
	if (storedCodexKey) {
		auth["openai-codex"] = { type: "api_key", key: storedCodexKey };
		return auth;
	}

	const hostAuth = readHostAuthJson();
	if (!hostAuth) return auth;

	const codex = hostAuth["openai-codex"];
	if (isUsableCodexCredential(codex)) {
		auth["openai-codex"] = codex;
		return auth;
	}

	// Older installs may have ChatGPT OAuth under `openai`. Only OAuth is a
	// Codex-compatible credential; OpenAI API keys continue to flow via env vars.
	const openai = hostAuth.openai;
	if (isCredentialObject(openai) && openai.type === "oauth" && typeof openai.access === "string" && openai.access) {
		auth["openai-codex"] = openai;
	}
	return auth;
}

export function ensureSandboxAgentAuthFile(prefs?: PreferencesStore | null): string {
	const authPath = sandboxAgentAuthPath();
	const next = `${JSON.stringify(buildSandboxAgentAuthJson(prefs), null, 2)}\n`;
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
