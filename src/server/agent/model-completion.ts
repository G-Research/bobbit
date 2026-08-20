import { complete, completeSimple } from "@earendil-works/pi-ai/compat";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai/compat";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { realModelConfigCommandRunner, type ModelConfigCommandRunner } from "./model-config-command-runner.js";
import { invalidateRejectedAnthropicDirectCredential, refreshOAuthToken } from "../auth/oauth.js";
import { isUsableAnthropicOAuthCredential } from "../auth/credential-store.js";
import { globalAgentDir, globalAuthPath } from "../bobbit-dir.js";
import type { PreferencesStore } from "./preferences-store.js";
import { getAvailableModels, type ApiModel, type CustomProviderConfig } from "./model-registry.js";
import { GOOGLE_GEMINI_CLI_PROVIDER, codeAssistComplete } from "./google-code-assist.js";
import { sanitizeModelErrorText } from "./model-error-sanitizer.js";
import { classifyModelProbeError, modelProbeFailure } from "./model-probe-result.js";
import { resolveGatewayCredential } from "./gateway-credential-resolver.js";

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
	if (cred.type === "oauth") {
		const oauth = { type: "oauth", access: cred.access, refresh: cred.refresh, expires: cred.expires };
		// Unlike legacy API-key rows, Anthropic OAuth rows are Pi credentials and
		// must be renewable. Do not let a partial on-disk row become a Bearer token.
		if (provider === "anthropic") {
			return isUsableAnthropicOAuthCredential(globalAuthPath(), oauth) ? oauth : { type: "invalid-oauth" };
		}
		if (cred.access) return oauth;
	}
	if ((cred.type === "api-key" || cred.type === "api_key") && cred.key) return { type: "api-key", key: cred.key };
	if (typeof cred.key === "string" && cred.key.trim()) return { type: "api-key", key: cred.key };
	if (typeof cred.access === "string" && cred.access.trim()) {
		// Untagged access values are not a valid Anthropic credential shape either.
		if (provider === "anthropic") return { type: "invalid-oauth" };
		return { type: cred.type || "oauth", access: cred.access, expires: cred.expires };
	}
	return null;
}

export interface ModelProviderConfig {
	apiKey?: unknown;
	headers?: unknown;
}

export type ModelProviderConfigReader = (provider: string) => ModelProviderConfig | undefined;

function readModelsJsonProvider(provider: string): ModelProviderConfig | undefined {
	try {
		const p = path.join(globalAgentDir(), "models.json");
		if (!existsSync(p)) return undefined;
		const data = JSON.parse(readFileSync(p, "utf-8"));
		return data?.providers?.[provider];
	} catch {
		return undefined;
	}
}

export { realModelConfigCommandRunner, type ModelConfigCommandRunner } from "./model-config-command-runner.js";

function platformShellCommand(command: string, env: NodeJS.ProcessEnv): { file: string; args: string[] } {
	if (process.platform === "win32") {
		return { file: env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", command] };
	}
	return { file: "/bin/sh", args: ["-c", command] };
}

export async function resolveConfigValue(
	value: unknown,
	commandRunner: ModelConfigCommandRunner = realModelConfigCommandRunner,
	env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
	if (typeof value !== "string" || !value.trim()) return undefined;
	const trimmed = value.trim();
	if (trimmed === "none") return trimmed;
	if (trimmed.startsWith("!")) {
		try {
			const command = platformShellCommand(trimmed.slice(1), env);
			const { stdout } = await commandRunner.execFile(command.file, command.args, {
				encoding: "utf-8",
				timeout: 15_000,
				windowsHide: true,
			});
			const output = typeof stdout === "string"
				? stdout
				: Buffer.isBuffer(stdout) ? stdout.toString("utf-8") : undefined;
			return output?.trim() || undefined;
		} catch {
			return undefined;
		}
	}
	const envValue = env[trimmed];
	if (envValue) return envValue;
	return trimmed;
}

async function resolveProviderHeaders(
	provider: string,
	commandRunner: ModelConfigCommandRunner,
	env: NodeJS.ProcessEnv,
	providerConfigReader: ModelProviderConfigReader,
): Promise<Record<string, string> | undefined> {
	if (provider !== "aigw") return undefined;
	const rawHeaders = providerConfigReader(provider)?.headers;
	if (!rawHeaders || typeof rawHeaders !== "object") return undefined;
	const headers: Record<string, string> = {};
	for (const [key, value] of Object.entries(rawHeaders)) {
		if (typeof key !== "string" || !key.trim()) continue;
		const resolved = await resolveConfigValue(value, commandRunner, env);
		if (resolved) headers[key] = resolved;
	}
	return Object.keys(headers).length > 0 ? headers : undefined;
}

interface ResolvedProviderApiKey {
	apiKey?: string;
	/** The persisted OAuth access credential actually selected for this request. */
	oauthAccess?: string;
	/** Pi could not resolve an expired renewable OAuth credential; do not send its stale access value. */
	oauthResolutionFailed?: boolean;
}

interface GatewayCredentialSource {
	name: string;
	url: string;
	expression: unknown;
}

function hasGatewayCredentialExpression(expression: unknown): expression is string {
	return typeof expression === "string" && expression.trim() !== "" && expression.trim() !== "none";
}

/** A gateway key belongs only to requests sent to that gateway's own origin. */
function modelUsesGatewayOrigin(model: ApiModel, gateway: GatewayCredentialSource): boolean {
	if (typeof model.baseUrl !== "string" || !model.baseUrl) return false;
	try {
		return new URL(model.baseUrl).origin === new URL(gateway.url).origin;
	} catch {
		return false;
	}
}

/**
 * Resolve a model provider back to its persisted gateway row without importing
 * aigw-manager (which would create a model-registry import cycle). A matching
 * gateway owns authentication exclusively: do not fall through to generic
 * provider credentials or models.json indirection.
 */
function gatewayCredentialSource(prefs: PreferencesStore | undefined, provider: string): GatewayCredentialSource | undefined {
	const gateways = prefs?.get("modelGateways");
	if (!Array.isArray(gateways)) return undefined;
	for (const candidate of gateways) {
		if (!candidate || typeof candidate !== "object") continue;
		const row = candidate as Record<string, unknown>;
		if (
			row.name !== provider ||
			typeof row.id !== "string" ||
			!row.id.trim() ||
			typeof row.url !== "string" ||
			!row.url.trim()
		) continue;
		return { name: provider, url: row.url, expression: prefs?.get(`providerKey.gateway.${row.id}`) };
	}
	return undefined;
}

async function resolveProviderApiKey(
	prefs: PreferencesStore | undefined,
	provider: string,
	commandRunner: ModelConfigCommandRunner,
	env: NodeJS.ProcessEnv,
	providerConfigReader: ModelProviderConfigReader,
	anthropicOAuthTokenResolver: () => Promise<string | null> = refreshOAuthToken,
): Promise<ResolvedProviderApiKey> {
	const stored = prefs?.get(`providerKey.${provider}`);
	if (typeof stored === "string" && stored.trim()) return { apiKey: stored.trim() };

	for (const key of PROVIDER_ENV_KEYS[provider] || []) {
		if (env[key]) return { apiKey: env[key] };
	}

	const auth = authCredentialForProvider(provider);
	if (auth?.type === "invalid-oauth") return { oauthResolutionFailed: true };
	if (auth?.type === "oauth" && provider === "anthropic" && auth.expires && Date.now() > auth.expires) {
		const refreshed = await anthropicOAuthTokenResolver();
		if (refreshed) return { apiKey: refreshed, oauthAccess: refreshed };
		// A transient Pi refresh failure must not fall through to the expired
		// stored access value. That request could receive a 401/403 and erase a
		// still-renewable credential as though the provider rejected the refresh.
		return { oauthResolutionFailed: true };
	}
	if (auth?.access) return {
		apiKey: auth.access,
		...(auth.type === "oauth" ? { oauthAccess: auth.access } : {}),
	};
	if (auth?.key) return { apiKey: auth.key };

	const configs = (prefs?.get("customProviders") as CustomProviderConfig[] | undefined) || [];
	const custom = configs.find(c => (c.name || c.id) === provider || c.id === provider);
	if (custom) return { apiKey: custom.apiKey?.trim() || "none" };

	return { apiKey: await resolveConfigValue(providerConfigReader(provider)?.apiKey, commandRunner, env) };
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

export interface ModelCompletionDependencies {
	commandRunner?: ModelConfigCommandRunner;
	env?: NodeJS.ProcessEnv;
	providerConfigReader?: ModelProviderConfigReader;
	/** Test seam for Pi's locked Anthropic OAuth resolution. */
	anthropicOAuthTokenResolver?: () => Promise<string | null>;
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
	completeFn: CompleteSimpleFn = completeSimple,
	dependencies: ModelCompletionDependencies = {},
): Promise<string> {
	// Google account (Code Assist / OAuth) models speak a different wire protocol
	// than pi-ai's API-key `google` provider, so route them through the Bearer
	// Code Assist adapter instead of completeSimple. The API-key `google` provider
	// path below is unchanged.
	if (model.provider === GOOGLE_GEMINI_CLI_PROVIDER) {
		return codeAssistComplete({
			model: model.id,
			systemPrompt: args.systemPrompt,
			userPrompt: args.userPrompt,
			maxTokens: args.maxTokens ?? 500,
			...(args.thinkingLevel ? { thinkingLevel: args.thinkingLevel } : {}),
			// Honor the caller's deadline so Code Assist completions can't hang past
			// it; mirrors the timeoutMs handed to pi-ai for normal providers below.
			timeoutMs: args.timeoutMs ?? 30_000,
		});
	}

	const commandRunner = dependencies.commandRunner ?? realModelConfigCommandRunner;
	const env = dependencies.env ?? process.env;
	const providerConfigReader = dependencies.providerConfigReader ?? readModelsJsonProvider;
	const gatewayCredential = gatewayCredentialSource(prefs, model.provider);
	const configuredGatewayCredential = gatewayCredential && hasGatewayCredentialExpression(gatewayCredential.expression);
	// A matching gateway row owns credentials exclusively. Its absent, blank, or
	// explicit "none" expression must remain Pi's anonymous sentinel; do not
	// revive a generic preference or retained models.json key for that provider.
	// Resolve every configured expression before checking the target origin. A
	// foreign retained model must never receive the key, but a broken command is
	// still a gateway configuration failure rather than permission to fall back
	// to an anonymous request.
	const resolvedGatewayCredential = gatewayCredential && configuredGatewayCredential
		? await resolveGatewayCredential(gatewayCredential.expression, gatewayCredential.name, env, commandRunner)
		: undefined;
	const resolvedApiKey = gatewayCredential
		? {
			apiKey: resolvedGatewayCredential && modelUsesGatewayOrigin(model, gatewayCredential)
				? resolvedGatewayCredential
				: "none",
		}
		: await resolveProviderApiKey(
			prefs,
			model.provider,
			commandRunner,
			env,
			providerConfigReader,
			dependencies.anthropicOAuthTokenResolver,
		);
	if (resolvedApiKey.oauthResolutionFailed) {
		throw new Error("Anthropic OAuth credential could not be resolved");
	}
	const providerHeaders = await resolveProviderHeaders(model.provider, commandRunner, env, providerConfigReader);
	const options: Record<string, any> = {
		maxTokens: args.maxTokens ?? 500,
		timeoutMs: args.timeoutMs ?? 30_000,
		maxRetries: 0,
		cacheRetention: "none",
		...(resolvedApiKey.apiKey ? { apiKey: resolvedApiKey.apiKey } : {}),
		...(providerHeaders ? { headers: providerHeaders } : {}),
	};
	if (args.thinkingLevel && args.thinkingLevel !== "off") {
		options.reasoning = args.thinkingLevel;
	}

	try {
		const result = await completeFn(toPiModel(model) as any, {
			systemPrompt: args.systemPrompt,
			messages: [{ role: "user", content: args.userPrompt, timestamp: Date.now() }],
		}, options);

		if ((result as any).stopReason === "error") {
			throw new Error(sanitizeModelErrorText((result as any).errorMessage || "Model returned an error"));
		}
		return assistantText(result);
	} catch (error) {
		const { status } = classifyModelProbeError(error);
		if (model.provider === "anthropic" && resolvedApiKey.oauthAccess && status === 401) {
			// The selected access credential is a concurrency guard: a newer login or
			// refresh must survive an earlier request's definitive rejection.
			await invalidateRejectedAnthropicDirectCredential(resolvedApiKey.oauthAccess);
		}
		throw error;
	}
}

export async function testProviderApiKey(
	provider: string,
	modelId: string,
	apiKey: string,
): Promise<{ ok: boolean; modelResolved?: string; latencyMs?: number; error?: string; status?: number }> {
	if (!provider || !modelId || !apiKey.trim()) {
		return { ok: false, status: 400, error: "Missing provider, modelId, or key" };
	}
	const model = getBuiltinModel(provider as any, modelId as any) as Model<Api> | undefined;
	if (!model) {
		return { ok: false, status: 404, error: `Model "${provider}/${modelId}" is not in the built-in pi-ai catalog.` };
	}

	const started = Date.now();
	try {
		const result = await complete(model as any, {
			messages: [{ role: "user", content: "Reply with: OK", timestamp: Date.now() }],
		}, {
			apiKey,
			maxTokens: 5,
			timeoutMs: 15_000,
			maxRetries: 0,
		} as any);
		if ((result as any).stopReason === "error") {
			throw new Error(sanitizeModelErrorText((result as any).errorMessage || "Model returned an error"));
		}
		return { ok: true, modelResolved: model.id, latencyMs: Date.now() - started };
	} catch (err: unknown) {
		return modelProbeFailure(err, { modelResolved: model.id, latencyMs: Date.now() - started });
	}
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
	} catch (err: unknown) {
		return modelProbeFailure(err, { modelResolved: model.id, latencyMs: Date.now() - started });
	}
}
