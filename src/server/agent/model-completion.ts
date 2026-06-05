import { completeSimple, type Api, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { execSync } from "node:child_process";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { refreshOAuthToken } from "../auth/oauth.js";
import { globalAgentDir, globalAuthPath } from "../bobbit-dir.js";
import type { PreferencesStore } from "./preferences-store.js";
import { getAvailableModels, type ApiModel, type CustomProviderConfig } from "./model-registry.js";
import { ensurePiAiBedrockHeadersPatch } from "./pi-ai-bedrock-headers-patch.js";

ensurePiAiBedrockHeadersPatch();

interface AuthCredentials {
	type: string;
	access?: string;
	key?: string;
	refresh?: string;
	expires?: number;
}

const PROVIDER_ENV_KEYS: Record<string, string[]> = {
	anthropic: ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"],
	openai: ["OPENAI_API_KEY"],
	"openai-codex": ["OPENAI_API_KEY"],
	google: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
	"google-gemini-cli": ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
	xai: ["XAI_API_KEY"],
	groq: ["GROQ_API_KEY"],
	mistral: ["MISTRAL_API_KEY"],
	openrouter: ["OPENROUTER_API_KEY"],
};

function loadAuthData(): Record<string, any> | null {
	const authPath = globalAuthPath();
	if (!existsSync(authPath)) return null;
	try { return JSON.parse(readFileSync(authPath, "utf-8")); }
	catch { return null; }
}

function authCredentialForProvider(provider: string): AuthCredentials | null {
	const cred = loadAuthData()?.[provider];
	if (!cred) return null;
	if (cred.type === "oauth" && cred.access) return { type: "oauth", access: cred.access, refresh: cred.refresh, expires: cred.expires };
	if ((cred.type === "api-key" || cred.type === "api_key") && cred.key) return { type: "api-key", key: cred.key };
	if (typeof cred.key === "string" && cred.key.trim()) return { type: "api-key", key: cred.key };
	if (typeof cred.access === "string" && cred.access.trim()) return { type: cred.type || "oauth", access: cred.access, expires: cred.expires };
	return null;
}

function readModelsJsonProvider(provider: string): any | undefined {
	try {
		const p = path.join(globalAgentDir(), "models.json");
		if (!existsSync(p)) return undefined;
		const data = JSON.parse(readFileSync(p, "utf-8"));
		return data?.providers?.[provider];
	} catch {
		return undefined;
	}
}

function resolveConfigValue(value: unknown): string | undefined {
	if (typeof value !== "string" || !value.trim()) return undefined;
	const trimmed = value.trim();
	if (trimmed === "none") return trimmed;
	if (trimmed.startsWith("!")) {
		try {
			return execSync(trimmed.slice(1), { encoding: "utf-8", timeout: 15_000, windowsHide: true }).trim() || undefined;
		} catch {
			return undefined;
		}
	}
	const envValue = process.env[trimmed];
	if (envValue) return envValue;
	return trimmed;
}

function resolveProviderHeaders(provider: string): Record<string, string> | undefined {
	if (provider !== "aigw") return undefined;
	const rawHeaders = readModelsJsonProvider(provider)?.headers;
	if (!rawHeaders || typeof rawHeaders !== "object") return undefined;
	const headers: Record<string, string> = {};
	for (const [key, value] of Object.entries(rawHeaders)) {
		if (typeof key !== "string" || !key.trim()) continue;
		const resolved = resolveConfigValue(value);
		if (resolved) headers[key] = resolved;
	}
	return Object.keys(headers).length > 0 ? headers : undefined;
}

async function resolveProviderApiKey(prefs: PreferencesStore | undefined, provider: string): Promise<string | undefined> {
	const stored = prefs?.get(`providerKey.${provider}`);
	if (typeof stored === "string" && stored.trim()) return stored.trim();

	for (const key of PROVIDER_ENV_KEYS[provider] || []) {
		if (process.env[key]) return process.env[key];
	}

	const auth = authCredentialForProvider(provider);
	if (auth?.type === "oauth" && provider === "anthropic" && auth.expires && Date.now() > auth.expires) {
		const refreshed = await refreshOAuthToken();
		if (refreshed) return refreshed;
	}
	if (auth?.access) return auth.access;
	if (auth?.key) return auth.key;

	const configs = (prefs?.get("customProviders") as CustomProviderConfig[] | undefined) || [];
	const custom = configs.find(c => (c.name || c.id) === provider || c.id === provider);
	if (custom) return custom.apiKey?.trim() || "none";

	return resolveConfigValue(readModelsJsonProvider(provider)?.apiKey);
}

export function toPiModel(model: ApiModel): Model<Api> {
	return {
		id: model.id,
		name: model.name || model.id,
		api: model.api as Api,
		provider: model.provider,
		baseUrl: model.baseUrl || "",
		reasoning: !!model.reasoning,
		...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap as any } : {}),
		input: model.input || ["text"],
		cost: model.cost || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: model.contextWindow || 8192,
		maxTokens: model.maxTokens || 4096,
		...((model as any).headers ? { headers: (model as any).headers } : {}),
		...((model as any).compat ? { compat: (model as any).compat } : {}),
	};
}

function assistantText(message: any): string {
	return (message?.content || [])
		.filter((c: any) => c?.type === "text")
		.map((c: any) => c.text || "")
		.join("")
		.trim();
}

type CompleteSimpleFn = typeof completeSimple;

export async function completeModelText(
	model: ApiModel,
	prefs: PreferencesStore | undefined,
	args: {
		systemPrompt: string;
		userPrompt: string;
		maxTokens?: number;
		thinkingLevel?: ModelThinkingLevel;
		timeoutMs?: number;
	},
	completeFn: CompleteSimpleFn = completeSimple,
): Promise<string> {
	const apiKey = await resolveProviderApiKey(prefs, model.provider);
	const providerHeaders = resolveProviderHeaders(model.provider);
	const options: Record<string, any> = {
		maxTokens: args.maxTokens ?? 500,
		timeoutMs: args.timeoutMs ?? 30_000,
		maxRetries: 0,
		cacheRetention: "none",
		...(apiKey ? { apiKey } : {}),
		...(providerHeaders ? { headers: providerHeaders } : {}),
	};
	if (args.thinkingLevel && args.thinkingLevel !== "off") {
		options.reasoning = args.thinkingLevel;
	}

	const result = await completeFn(toPiModel(model) as any, {
		systemPrompt: args.systemPrompt,
		messages: [{ role: "user", content: args.userPrompt, timestamp: Date.now() }],
	}, options);

	if ((result as any).stopReason === "error") {
		throw new Error((result as any).errorMessage || "Model returned an error");
	}
	return assistantText(result);
}

export async function testModelPreference(
	prefs: PreferencesStore,
	pref: string,
	completer: typeof completeModelText = completeModelText,
): Promise<{ ok: boolean; modelResolved?: string; latencyMs?: number; error?: string; status?: number }> {
	const slash = pref.indexOf("/");
	if (slash <= 0 || slash >= pref.length - 1) {
		return { ok: false, status: 400, error: "Malformed pref — expected 'provider/modelId'" };
	}
	const provider = pref.slice(0, slash);
	const modelId = pref.slice(slash + 1);
	const models = await getAvailableModels(prefs);
	const model = models.find((m) => m.provider === provider && m.id === modelId);
	if (!model) {
		return { ok: false, status: 404, error: `Model "${pref}" is not in the current available-models list. It may be a stale preference.` };
	}

	const started = Date.now();
	try {
		await completer(model, prefs, {
			systemPrompt: "You are a connection test. Reply with OK.",
			userPrompt: "Reply with OK",
			maxTokens: 5,
			thinkingLevel: "off",
			timeoutMs: 15_000,
		});
		return { ok: true, modelResolved: model.id, latencyMs: Date.now() - started };
	} catch (err: any) {
		return { ok: false, modelResolved: model.id, latencyMs: Date.now() - started, error: err?.message || "Request failed" };
	}
}
