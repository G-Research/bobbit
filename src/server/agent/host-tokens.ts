/**
 * Detects which token/credential env vars are available on the host.
 * Returns env var names only — never values — for display in the settings UI.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";

import { globalAuthPath } from "../bobbit-dir.js";
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

function detectAuthJson(): Record<string, boolean> {
	const result: Record<string, boolean> = {};
	try {
		const authPath = globalAuthPath();
		if (fs.existsSync(authPath)) {
			const data = JSON.parse(fs.readFileSync(authPath, "utf-8"));
			for (const key of Object.keys(data)) {
				result[key] = true;
			}
		}
	} catch { /* ignore */ }
	return result;
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
