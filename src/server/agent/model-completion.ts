import { completeSimple, type Api, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { existsSync, readFileSync } from "node:fs";
import { refreshOAuthToken } from "../auth/oauth.js";
import { globalAuthPath } from "../bobbit-dir.js";
import type { PreferencesStore } from "./preferences-store.js";
import { getAvailableModels, type ApiModel, type CustomProviderConfig } from "./model-registry.js";

interface AuthCredentials {
	type: string;
	access: string;
	refresh?: string;
	expires?: number;
}

function loadAnthropicAuth(): AuthCredentials | null {
	const authPath = globalAuthPath();
	if (!existsSync(authPath)) return null;
	try {
		const data = JSON.parse(readFileSync(authPath, "utf-8"));
		const cred = data.anthropic;
		if (!cred) return null;
		if (cred.type === "oauth" && cred.access) return cred;
		if (cred.type === "api-key" && cred.key) return { type: "api-key", access: cred.key };
		return null;
	} catch {
		return null;
	}
}

async function resolveProviderApiKey(prefs: PreferencesStore | undefined, provider: string): Promise<string | undefined> {
	const stored = prefs?.get(`providerKey.${provider}`);
	if (typeof stored === "string" && stored.trim()) return stored.trim();

	if (provider === "anthropic") {
		const auth = loadAnthropicAuth();
		if (auth?.type === "oauth" && auth.expires && Date.now() > auth.expires) {
			const refreshed = await refreshOAuthToken();
			if (refreshed) return refreshed;
		}
		if (auth?.access) return auth.access;
	}

	const configs = (prefs?.get("customProviders") as CustomProviderConfig[] | undefined) || [];
	const custom = configs.find(c => (c.name || c.id) === provider || c.id === provider);
	if (custom) return custom.apiKey?.trim() || "none";

	return undefined;
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
): Promise<string> {
	const apiKey = await resolveProviderApiKey(prefs, model.provider);
	const options: Record<string, any> = {
		maxTokens: args.maxTokens ?? 500,
		timeoutMs: args.timeoutMs ?? 30_000,
		maxRetries: 0,
		cacheRetention: "none",
		...(apiKey ? { apiKey } : {}),
	};
	if (args.thinkingLevel && args.thinkingLevel !== "off") {
		options.reasoning = args.thinkingLevel;
	}

	const result = await completeSimple(toPiModel(model) as any, {
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
