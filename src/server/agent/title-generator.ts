/**
 * Generates a short session title from conversation messages.
 * Supports three modes:
 * 1. Direct Anthropic API (default - uses Claude Haiku via api.anthropic.com)
 * 2. AI Gateway proxy (when aigw is configured - routes through the gateway)
 * 3. Custom naming model (user preference - any provider/model via the gateway)
 */

import { existsSync, readFileSync } from "node:fs";
import { invalidateRejectedAnthropicDirectCredential, refreshOAuthToken } from "../auth/oauth.js";
import { isUsableAnthropicOAuthCredential } from "../auth/credential-store.js";
import { globalAuthPath } from "../bobbit-dir.js";
import { createAnthropicDirectHeaders, type AnthropicDirectCredentials } from "./anthropic-direct-request.js";
import { sanitizeModelErrorText } from "./model-error-sanitizer.js";
import { discoverAigwModels, normalizeAigwModelString, type ModelGateway } from "./aigw-manager.js";
import { GatewayCredentialResolutionError, resolveGatewayCredential } from "./gateway-credential-resolver.js";
import { aigwUserAgentHeaders } from "./aigw-user-agent.js";
import { completeModelText, type ModelCompletionDependencies } from "./model-completion.js";
import { getAvailableModels, modelRecencyRank, type ApiModel } from "./model-registry.js";
import type { PreferencesStore } from "./preferences-store.js";

const defaultFetch: typeof fetch = (input, init) => globalThis.fetch(input, init);

/** Cache for the fallback naming model id, keyed by gateway URL. TTL ~60s. */
let _fallbackCache: { url: string; modelId: string | null; expiresAt: number } | null = null;
const FALLBACK_TTL_MS = 60_000;

/**
 * Pick a low-cost Claude model from the gateway to use as a naming model
 * when the user has no explicit `default.namingModel`. Prefers Haiku.
 * Returns the *stripped* id (no provider prefix) suitable for generateViaGateway,
 * or null if the gateway exposes no Claude-family model.
 */
export async function pickFallbackAigwNamingModel(aigwUrl: string, _fetchImpl: typeof fetch = defaultFetch, authorization?: string): Promise<string | null> {
	const normalized = aigwUrl.replace(/\/+$/, "");
	const now = Date.now();
	if (_fallbackCache && _fallbackCache.url === normalized && _fallbackCache.expiresAt > now) {
		return _fallbackCache.modelId;
	}
	let picked: string | null = null;
	try {
		const models = await discoverAigwModels(normalized, authorization);
		const stripPrefix = (id: string) => { const i = id.indexOf("/"); return i >= 0 ? id.slice(i + 1) : id; };
		const claude = models.filter(m => m.id.toLowerCase().includes("claude"));
		if (claude.length > 0) {
			// Rank by cheapness tier (haiku < sonnet < opus) so that when no Haiku is
			// available we fall back to Sonnet before ever picking Opus. Within the
			// same tier, prefer the most recent model.
			const tier = (id: string): number => {
				const lc = id.toLowerCase();
				if (lc.includes("haiku")) return 0;
				if (lc.includes("sonnet")) return 1;
				if (lc.includes("opus")) return 2;
				return 3;
			};
			claude.sort((a, b) => {
				const t = tier(a.id) - tier(b.id);
				if (t !== 0) return t;
				return modelRecencyRank(b.id) - modelRecencyRank(a.id);
			});
			picked = stripPrefix(claude[0].id);
		}
	} catch (err) {
		console.warn("[title-gen] pickFallbackAigwNamingModel: discoverAigwModels failed:", err);
		picked = null;
	}
	_fallbackCache = { url: normalized, modelId: picked, expiresAt: now + FALLBACK_TTL_MS };
	return picked;
}

const DEFAULT_TITLE_MODEL = "claude-haiku-4-5-20251001";
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";

export interface TitleGenOptions {
	/** Override model in "provider/modelId" format, e.g. "aigw/claude-haiku-4-5" */
	namingModel?: string;
	/** Enabled named gateways. Explicit naming models retain their exact
	 * provider/model tuple and are resolved from the registry against these rows. */
	gateways?: ModelGateway[];
	/** AIGW-only URL for the legacy implicit Claude fallback. */
	aigwUrl?: string;
	/** The persisted AIGW row for the implicit fallback. Its private key is
	 * resolved immediately before discovery and completion. */
	aigwGateway?: ModelGateway;
	/** Thinking level for title generation: "off"|"minimal"|"low"|"medium"|"high"|"xhigh" */
	thinkingLevel?: string;
	/** Model to try when no explicit naming model is configured (usually default.sessionModel). */
	fallbackModel?: string;
	/** Preferences are needed to resolve and authenticate non-AI-Gateway naming models. */
	preferencesStore?: PreferencesStore;
	/** Test hook: supplies available models without reading preferences. */
	availableModels?: ApiModel[] | (() => Promise<ApiModel[]>);
	/** Test hook: performs the direct-model completion. */
	directModelCompleter?: (model: ApiModel, args: { systemPrompt: string; userPrompt: string; maxTokens: number; thinkingLevel: "off" }) => Promise<string | null>;
	/** Test seam for dependencies used by the real model completion path. */
	modelCompletionDependencies?: ModelCompletionDependencies;
	/** Test hook for Pi-backed Anthropic OAuth token resolution. */
	anthropicOAuthTokenResolver?: () => Promise<string | null>;
	/** Runtime boundary flag for legacy BOBBIT_SKIP_TITLE_GEN behavior. */
	skipTitleGeneration?: boolean;
	fetchImpl?: typeof fetch;
}

type AuthCredentials = AnthropicDirectCredentials;

function loadAuth(): AuthCredentials | null {
	const authPath = globalAuthPath();
	if (!existsSync(authPath)) return null;

	try {
		const data = JSON.parse(readFileSync(authPath, "utf-8"));
		const cred = data.anthropic;
		if (!cred) return null;

		// OAuth token selection and refresh belong to Pi's credential runtime;
		// only inspect the credential kind here, never use the stored access token.
		if (cred.type === "oauth" && isUsableAnthropicOAuthCredential(authPath, cred)) return { type: "oauth", access: "" };
		if ((cred.type === "api-key" || cred.type === "api_key") && cred.key) return { type: "api-key", access: cred.key };
		return null;
	} catch {
		return null;
	}
}

function describeAnthropicFailure(status: number): string {
	if (status === 404) return "model not found";
	if (status === 401 || status === 403) return "authentication failed";
	if (status === 429) return "rate or spend limit reached";
	return `request failed (HTTP ${status})`;
}

/** Provider response bodies can echo credentials, so classify failures by status only. */
function describeGatewayFailure(status: number): string {
	if (status === 401 || status === 403) return "authentication failed";
	if (status === 404) return "model not found";
	if (status === 429) return "rate or spend limit reached";
	return `request failed (HTTP ${status})`;
}

async function resolveAnthropicOAuthToken(options?: TitleGenOptions): Promise<string | null> {
	try {
		return await (options?.anthropicOAuthTokenResolver ?? refreshOAuthToken)();
	} catch (error) {
		console.error(`[title-gen] Anthropic OAuth credential resolution failed: ${sanitizeModelErrorText(error)}`);
		return null;
	}
}

/**
 * Extract text from agent messages for title generation.
 */
function extractConversationPreview(messages: any[]): string {
	const parts: string[] = [];
	let userCount = 0;
	let assistantCount = 0;
	const maxEach = 2;

	for (const msg of messages) {
		if (userCount >= maxEach && assistantCount >= maxEach) break;

		const role = msg.role;
		const isUser = role === "user" || role === "user-with-attachments";
		const isAssistant = role === "assistant";

		if (!isUser && !isAssistant) continue;
		if (isUser && userCount >= maxEach) continue;
		if (isAssistant && assistantCount >= maxEach) continue;

		let text = "";
		if (typeof msg.content === "string") {
			text = msg.content;
		} else if (Array.isArray(msg.content)) {
			text = msg.content
				.filter((c: any) => c.type === "text")
				.map((c: any) => c.text || "")
				.join(" ");
		}

		if (!text.trim()) continue;

		const maxLen = 400;
		if (text.length > maxLen) text = text.slice(0, maxLen) + "...";

		const label = isUser ? "User" : "Assistant";
		parts.push(`${label}: ${text}`);

		if (isUser) userCount++;
		if (isAssistant) assistantCount++;
	}

	return parts.join("\n\n");
}

const EMOJI_RE = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{27BF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{200D}\u{20E3}\u{FE0F}]/gu;

function normalizeTitle(s: string): string {
	let title = s
		.replace(/^#+\s*/, "")
		.replace(/^["'"']+|["'"']+$/g, "")
		.replace(EMOJI_RE, "")
		.trim();
	if (title.length > 30) title = title.slice(0, 27) + "…";
	return title;
}

/**
 * Extract a title from model output. Strategy:
 *   1. Prefer the contents of the LAST `<title>...</title>` block (the prompt
 *      asks the model to wrap its answer this way; "last" tolerates models that
 *      include the tag literally in reasoning preamble).
 *   2. Fall back to the last non-empty short line (≤80 chars) of the response,
 *      which handles models that ignored the XML instruction but still placed
 *      a bare label at the end after some reasoning.
 *   3. Final fallback: the first line, matching legacy behaviour.
 */
export function cleanTitle(raw: string): string {
	if (!raw) return "";

	// 1. <title>...</title> - last match wins.
	const tagMatches = [...raw.matchAll(/<title>([\s\S]*?)<\/title>/gi)];
	if (tagMatches.length > 0) {
		const inner = tagMatches[tagMatches.length - 1]![1] ?? "";
		const t = normalizeTitle(inner.replace(/\s+/g, " "));
		if (t) return t;
	}

	// 2. Last non-empty short line.
	const lines = raw
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter((l) => l.length > 0 && l.length <= 80);
	if (lines.length > 0) {
		const t = normalizeTitle(lines[lines.length - 1]!);
		if (t) return t;
	}

	// 3. First line.
	return normalizeTitle(raw.split(/\r?\n/)[0] || "");
}

/**
 * Resolve a potentially prefix-stripped model ID back to the full gateway model ID.
 * Claude models are stored with the provider prefix stripped (e.g. "us.anthropic.claude-...")
 * but the gateway's /v1/chat/completions endpoint needs the full ID (e.g. "aws/us.anthropic.claude-...").
 * Queries the gateway's /v1/models endpoint to find a match.
 */
function gatewayAuthorizationHeaders(baseUrl: string, targetUrl: string, authorization?: string): Record<string, string> {
	if (!authorization || new URL(baseUrl).origin !== new URL(targetUrl).origin) return {};
	return { Authorization: `Bearer ${authorization}` };
}

async function resolveGatewayModelId(baseUrl: string, strippedId: string, fetchImpl: typeof fetch = defaultFetch, authorization?: string): Promise<string> {
	try {
		const modelsUrl = baseUrl.endsWith("/v1") ? `${baseUrl}/models` : `${baseUrl}/v1/models`;
		const res = await fetchImpl(modelsUrl, {
			headers: aigwUserAgentHeaders(gatewayAuthorizationHeaders(baseUrl, modelsUrl, authorization)),
			signal: AbortSignal.timeout(5000),
		});
		if (!res.ok) return strippedId;
		const data = await res.json() as { data?: Array<{ id: string }> };
		if (!Array.isArray(data.data)) return strippedId;

		// Exact match first
		const exact = data.data.find(m => m.id === strippedId);
		if (exact) return exact.id;

		// Suffix match - find a model whose ID ends with the stripped ID after the prefix slash
		const match = data.data.find(m => {
			const slash = m.id.indexOf("/");
			return slash >= 0 && m.id.slice(slash + 1) === strippedId;
		});
		return match?.id ?? strippedId;
	} catch {
		return strippedId; // Fall back to the stripped ID on network errors
	}
}

/**
 * Generate title via the AI Gateway using OpenAI-compatible chat completions.
 *
 * This legacy path is used only for automatic Claude fallback when no explicit
 * naming preference exists. Explicit AIGW models resolve through ApiModel and
 * completeModelText(), preserving Responses, Converse, or completions routing.
 */
async function generateViaGateway(aigwUrl: string, modelId: string, preview: string, thinkingLevel?: string, fetchImpl: typeof fetch = defaultFetch, authorization?: string): Promise<string | null> {
	const baseUrl = aigwUrl.replace(/\/+$/, "");
	const resolvedModel = await resolveGatewayModelId(baseUrl, modelId, fetchImpl, authorization);
	const url = baseUrl.endsWith("/v1") ? `${baseUrl}/chat/completions` : `${baseUrl}/v1/chat/completions`;

	const body: any = {
		model: resolvedModel,
		// Bumped from 20 → 500 so reasoning models that ignore the "no thinking"
		// instruction and emit a few tokens of preamble still leave room for the
		// label itself. cleanTitle() truncates to 30 chars regardless.
		max_tokens: 500,
		messages: [
			{
				role: "system",
				content: "Output a 2-3 word label for this conversation. MAXIMUM 3 words. Wrap the label in <title>…</title> tags, e.g. <title>Fix Login Bug</title>. No quotes, no markdown, no explanation outside the tags. No emojis. Do NOT reason, think, or plan — emit the <title> tag as your very first tokens.",
			},
			{
				role: "user",
				content: `Conversation:\n\n---\n${preview}\n---\n\nReply with ONLY <title>YOUR LABEL</title>:`,
			},
		],
	};

	// Add thinking if configured and not "off"
	if (thinkingLevel && thinkingLevel !== "off") {
		const budgets: Record<string, number> = { minimal: 1024, low: 4096, medium: 10240, high: 32768 };
		const budget = budgets[thinkingLevel];
		if (budget) {
			body.thinking = { type: "enabled", budget_tokens: budget };
			body.max_tokens = Math.max(body.max_tokens, budget + 500);
		}
	}

	console.log(`[title-gen] Requesting title via gateway model "${resolvedModel}"${resolvedModel !== modelId ? ` (resolved from "${modelId}")` : ""}...`);

	try {
		const response = await fetchImpl(url, {
			method: "POST",
			headers: aigwUserAgentHeaders({ "Content-Type": "application/json", ...gatewayAuthorizationHeaders(baseUrl, url, authorization) }),
			body: JSON.stringify(body),
		});

		if (!response.ok) {
			console.error(`[title-gen] Gateway ${describeGatewayFailure(response.status)}`);
			return null;
		}

		const data = await response.json() as any;
		const text = data.choices?.[0]?.message?.content?.trim();
		if (!text) return null;

		const title = cleanTitle(text);
		console.log(`[title-gen] Generated title: "${title}"`);
		return title || null;
	} catch (err) {
		console.error(`[title-gen] Gateway request failed: ${sanitizeModelErrorText(err)}`);
		return null;
	}
}

/**
 * Generate title via direct Anthropic API call.
 */
async function getOptionModels(options: TitleGenOptions): Promise<ApiModel[]> {
	if (Array.isArray(options.availableModels)) return options.availableModels;
	if (typeof options.availableModels === "function") return options.availableModels();
	if (options.preferencesStore) return getAvailableModels(options.preferencesStore);
	return [];
}

async function findConfiguredModel(pref: string, options: TitleGenOptions): Promise<{ provider: string; modelId: string; model?: ApiModel } | null> {
	const normalizedPref = normalizeAigwModelString(pref);
	const slash = normalizedPref.indexOf("/");
	if (slash <= 0 || slash >= normalizedPref.length - 1) {
		console.warn(`[title-gen] Malformed namingModel preference: "${pref}", ignoring`);
		return null;
	}
	const provider = normalizedPref.slice(0, slash);
	const modelId = normalizedPref.slice(slash + 1);
	const models = await getOptionModels(options);
	return { provider, modelId, model: models.find(m => m.provider === provider && m.id === modelId) };
}

async function generateViaConfiguredDirectModel(model: ApiModel, userPrompt: string, systemPrompt: string, options: TitleGenOptions): Promise<string | null> {
	// A test/direct completer bypasses completeModelText, so retain its explicit
	// fail-closed credential boundary. The real completion path owns resolution
	// itself; pre-resolving here would execute a configured command twice.
	if (options.directModelCompleter) {
		const gateway = options.gateways?.find((candidate) => candidate.enabled && candidate.name === model.provider);
		if (gateway) {
			await resolveGatewayCredential(options.preferencesStore?.get(`providerKey.gateway.${gateway.id}`), gateway.name);
		}
	}
	try {
		const text = options.directModelCompleter
			? await options.directModelCompleter(model, { systemPrompt, userPrompt, maxTokens: 500, thinkingLevel: "off" })
			: await completeModelText(model, options.preferencesStore, { systemPrompt, userPrompt, maxTokens: 500, thinkingLevel: "off" }, undefined, options.modelCompletionDependencies);
		if (!text) return null;
		const title = cleanTitle(text);
		console.log(`[title-gen] Generated title: "${title}"`);
		return title || null;
	} catch (err) {
		// A gateway key command failure is an authentication boundary, not an
		// ordinary title-generation miss. Surface the sanitized typed error so the
		// caller cannot silently retry an unauthenticated fallback.
		if (err instanceof GatewayCredentialResolutionError) throw err;
		console.error(`[title-gen] Direct model "${model.provider}/${model.id}" failed: ${sanitizeModelErrorText(err)}`);
		return null;
	}
}

async function generateViaAnthropic(
	preview: string,
	thinkingLevel?: string,
	modelId = DEFAULT_TITLE_MODEL,
	fetchImpl: typeof fetch = defaultFetch,
	options?: TitleGenOptions,
): Promise<string | null> {
	let auth = loadAuth();
	if (!auth) return null;

	if (auth.type === "oauth") {
		const access = await resolveAnthropicOAuthToken(options);
		if (!access) {
			console.error("[title-gen] Anthropic OAuth credential could not be resolved");
			return null;
		}
		auth = { ...auth, access };
	}

	const headers = createAnthropicDirectHeaders(auth);

	const coreInstruction = "Output a 2-3 word label for this conversation. MAXIMUM 3 words. Wrap the label in <title>…</title> tags, e.g. <title>Fix Login Bug</title>, <title>Redis Setup</title>, <title>CSV Parser</title>, <title>Dark Mode</title>. No quotes, no markdown, no explanation outside the tags. No emojis. Do NOT reason, think, or plan — emit the <title> tag as your very first tokens.";
	const systemText = auth.type === "oauth"
		? `You are Claude Code, Anthropic's official CLI for Claude. ${coreInstruction}`
		: coreInstruction;

	const body: any = {
		model: modelId,
		// Bumped from 12 → 500 to tolerate brief reasoning preamble (see gateway path).
		max_tokens: 500,
		system: auth.type === "oauth"
			? [{ type: "text", text: systemText }]
			: systemText,
		messages: [
			{
				role: "user",
				content: `Conversation:\n\n---\n${preview}\n---\n\nReply with ONLY <title>YOUR LABEL</title>:`,
			},
		],
	};

	// Add thinking if configured and not "off"
	if (thinkingLevel && thinkingLevel !== "off") {
		const budgets: Record<string, number> = { minimal: 1024, low: 4096, medium: 10240, high: 32768 };
		const budget = budgets[thinkingLevel];
		if (budget) {
			body.thinking = { type: "enabled", budget_tokens: budget };
			body.max_tokens = Math.max(body.max_tokens, budget + 500);
		}
	}

	console.log(`[title-gen] Requesting title via ${modelId}…`);

	try {
		const response = await fetchImpl(ANTHROPIC_API_URL, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
		});

		// Only a 401 proves the bearer credential failed; a 403 can be model or resource policy.
		if (!response.ok) {
			if (auth.type === "oauth" && response.status === 401) {
				await invalidateRejectedAnthropicDirectCredential(auth.access);
			}
			console.error(`[title-gen] Anthropic ${describeAnthropicFailure(response.status)}`);
			return null;
		}

		const data = (await response.json()) as {
			content: Array<{ type: string; text?: string }>;
		};

		const text = data.content
			?.filter((c) => c.type === "text")
			.map((c) => c.text || "")
			.join("")
			.trim();

		if (!text) return null;

		const title = cleanTitle(text);
		console.log(`[title-gen] Generated title: "${title}"`);
		return title || null;
	} catch (err) {
		console.error(`[title-gen] Anthropic request failed: ${sanitizeModelErrorText(err)}`);
		return null;
	}
}

/**
 * Generate a short title for a session based on its messages.
 * Returns null if generation fails.
 */
export async function generateSessionTitle(messages: any[], options?: TitleGenOptions): Promise<string | null> {
	const fetchImpl = options?.fetchImpl ?? defaultFetch;
	// Skip title generation entirely when tests/CI opt out - avoids real
	// outbound calls to api.anthropic.com for every prompted test.
	if (options?.skipTitleGeneration ?? false) return null;
	const preview = extractConversationPreview(messages);
	if (!preview.trim()) {
		console.error("[title-gen] No conversation content to summarise");
		return null;
	}

	// Every explicit model, including AIGW Responses/Converse/completions, routes
	// through the resolved registry model and pi-ai. Never guess the legacy root
	// chat endpoint for an explicit AIGW preference.
	if (options?.namingModel) {
		const configured = await findConfiguredModel(options.namingModel, options);
		if (configured?.model) {
			const userPrompt = `Conversation:\n\n---\n${preview}\n---\n\nReply with ONLY <title>YOUR LABEL</title>:`;
			const systemPrompt = "Output a 2-3 word label for this conversation. MAXIMUM 3 words. Wrap the label in <title>…</title> tags, e.g. <title>Fix Login Bug</title>. No quotes, no markdown, no explanation outside the tags. No emojis. Do NOT reason, think, or plan — emit the <title> tag as your very first tokens.";
			return generateViaConfiguredDirectModel(configured.model, userPrompt, systemPrompt, options);
		}
		// Anthropic remains directly runnable even when exclusive AIGW mode hides
		// built-ins from the available-model registry. Preserve that established
		// explicit-preference path rather than silently selecting an AIGW fallback.
		if (configured?.provider === "anthropic") {
			return generateViaAnthropic(preview, "off", configured.modelId, fetchImpl, options);
		}
		console.warn(`[title-gen] Naming model "${options.namingModel}" is not available; falling back`);
	}

	// Gateway configured but no explicit naming model - auto-select a low-cost
	// Claude model from the gateway (prefer Haiku). This avoids silent failures
	// in secure-zone deployments that cannot reach api.anthropic.com directly.
	const aigwGateway = options?.aigwGateway ?? options?.gateways?.find((gateway) => gateway.type === "aigw" && gateway.enabled);
	const aigwUrl = aigwGateway?.url ?? options?.aigwUrl;
	if (aigwUrl) {
		// Resolve before *any* discovery or completion request. The typed resolver
		// throws on command failure/empty output, so no unauthenticated fallback
		// request is possible.
		const authorization = aigwGateway
			? await resolveGatewayCredential(options?.preferencesStore?.get(`providerKey.gateway.${aigwGateway.id}`), aigwGateway.name)
			: undefined;
		const fallbackId = await pickFallbackAigwNamingModel(aigwUrl, fetchImpl, authorization);
		if (fallbackId) {
			console.log(`[title-gen] Using fallback gateway naming model "${fallbackId}"`);
			return generateViaGateway(aigwUrl, fallbackId, preview, "off", fetchImpl, authorization);
		}
		console.warn("[title-gen] Gateway configured but no suitable Claude naming model found; falling back");
	}

	// No explicit naming model and no usable gateway fallback. Try the session
	// default before the legacy Haiku path so OpenAI-only installations still
	// auto-rename sessions after switching away from Anthropic.
	if (options?.fallbackModel) {
		const configured = await findConfiguredModel(options.fallbackModel, options);
		if (configured?.model) {
			const userPrompt = `Conversation:\n\n---\n${preview}\n---\n\nReply with ONLY <title>YOUR LABEL</title>:`;
			const systemPrompt = "Output a 2-3 word label for this conversation. MAXIMUM 3 words. Wrap the label in <title>…</title> tags, e.g. <title>Fix Login Bug</title>. No quotes, no markdown, no explanation outside the tags. No emojis. Do NOT reason, think, or plan — emit the <title> tag as your very first tokens.";
			console.log(`[title-gen] Using session default fallback naming model "${options.fallbackModel}"`);
			return generateViaConfiguredDirectModel(configured.model, userPrompt, systemPrompt, options);
		}
	}

	// Legacy default: direct Anthropic API.
	return generateViaAnthropic(preview, "off", DEFAULT_TITLE_MODEL, fetchImpl, options);
}

// ── Goal title summarization ──────────────────────────────────────────

const GOAL_SUMMARY_SYSTEM = "Summarize this goal title in exactly 3 words. Wrap the summary in <title>…</title> tags, e.g. <title>Fix Login Bug</title>. No quotes, no markdown, no explanation outside the tags. No emojis. Do NOT reason, think, or plan — emit the <title> tag as your very first tokens.";

/**
 * Generate a 3-word summary of a goal title via the AI Gateway.
 */
async function generateGoalSummaryViaGateway(aigwUrl: string, modelId: string, goalTitle: string, fetchImpl: typeof fetch = defaultFetch, authorization?: string): Promise<string | null> {
	const baseUrl = aigwUrl.replace(/\/+$/, "");
	const resolvedModel = await resolveGatewayModelId(baseUrl, modelId, fetchImpl, authorization);
	const url = baseUrl.endsWith("/v1") ? `${baseUrl}/chat/completions` : `${baseUrl}/v1/chat/completions`;

	const body = {
		model: resolvedModel,
		// Bumped from 20 → 500 to tolerate brief reasoning preamble (see session-title path).
		max_tokens: 500,
		messages: [
			{ role: "system", content: GOAL_SUMMARY_SYSTEM },
			{ role: "user", content: `Goal title:\n\n---\n${goalTitle}\n---\n\nReply with ONLY <title>YOUR 3-WORD SUMMARY</title>:` },
		],
	};

	console.log(`[title-gen] Requesting goal summary via gateway model "${resolvedModel}"…`);

	try {
		const response = await fetchImpl(url, {
			method: "POST",
			headers: aigwUserAgentHeaders({ "Content-Type": "application/json", ...gatewayAuthorizationHeaders(baseUrl, url, authorization) }),
			body: JSON.stringify(body),
		});

		if (!response.ok) {
			console.error(`[title-gen] Gateway ${describeGatewayFailure(response.status)}`);
			return null;
		}

		const data = await response.json() as any;
		const text = data.choices?.[0]?.message?.content?.trim();
		if (!text) return null;

		const title = cleanTitle(text);
		console.log(`[title-gen] Generated goal summary: "${title}"`);
		return title || null;
	} catch (err) {
		console.error(`[title-gen] Gateway goal summary request failed: ${sanitizeModelErrorText(err)}`);
		return null;
	}
}

/**
 * Generate a 3-word summary of a goal title via direct Anthropic API.
 */
async function generateGoalSummaryViaAnthropic(
	goalTitle: string,
	modelId = DEFAULT_TITLE_MODEL,
	fetchImpl: typeof fetch = defaultFetch,
	options?: TitleGenOptions,
): Promise<string | null> {
	let auth = loadAuth();
	if (!auth) return null;

	if (auth.type === "oauth") {
		const access = await resolveAnthropicOAuthToken(options);
		if (!access) {
			console.error("[title-gen] Anthropic OAuth credential could not be resolved");
			return null;
		}
		auth = { ...auth, access };
	}

	const headers = createAnthropicDirectHeaders(auth);

	const systemText = auth.type === "oauth"
		? `You are Claude Code, Anthropic's official CLI for Claude. ${GOAL_SUMMARY_SYSTEM}`
		: GOAL_SUMMARY_SYSTEM;

	const body = {
		model: modelId,
		// Bumped from 12 → 500 to tolerate brief reasoning preamble.
		max_tokens: 500,
		system: auth.type === "oauth"
			? [{ type: "text", text: systemText }]
			: systemText,
		messages: [
			{ role: "user", content: `Goal title:\n\n---\n${goalTitle}\n---\n\nReply with ONLY <title>YOUR 3-WORD SUMMARY</title>:` },
		],
	};

	console.log(`[title-gen] Requesting goal summary via ${modelId}…`);

	try {
		const response = await fetchImpl(ANTHROPIC_API_URL, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
		});

		// Only a 401 proves the bearer credential failed; a 403 can be model or resource policy.
		if (!response.ok) {
			if (auth.type === "oauth" && response.status === 401) {
				await invalidateRejectedAnthropicDirectCredential(auth.access);
			}
			console.error(`[title-gen] Anthropic ${describeAnthropicFailure(response.status)}`);
			return null;
		}

		const data = (await response.json()) as {
			content: Array<{ type: string; text?: string }>;
		};

		const text = data.content
			?.filter((c) => c.type === "text")
			.map((c) => c.text || "")
			.join("")
			.trim();

		if (!text) return null;

		const title = cleanTitle(text);
		console.log(`[title-gen] Generated goal summary: "${title}"`);
		return title || null;
	} catch (err) {
		console.error(`[title-gen] Anthropic goal-summary request failed: ${sanitizeModelErrorText(err)}`);
		return null;
	}
}

/**
 * Generate a 3-word summary of a goal title for sidebar display.
 * Returns the cleaned summary (without "New goal: " prefix - caller adds that).
 * Returns null if generation fails.
 */
export async function generateGoalSummaryTitle(goalTitle: string, options?: TitleGenOptions): Promise<string | null> {
	const fetchImpl = options?.fetchImpl ?? defaultFetch;
	if (options?.skipTitleGeneration ?? false) return null;
	if (!goalTitle.trim()) {
		console.error("[title-gen] No goal title to summarise");
		return null;
	}

	if (options?.namingModel) {
		const configured = await findConfiguredModel(options.namingModel, options);
		if (configured?.model) {
			const userPrompt = `Goal title:\n\n---\n${goalTitle}\n---\n\nReply with ONLY <title>YOUR 3-WORD SUMMARY</title>:`;
			return generateViaConfiguredDirectModel(configured.model, userPrompt, GOAL_SUMMARY_SYSTEM, options);
		}
		if (configured?.provider === "anthropic") {
			return generateGoalSummaryViaAnthropic(goalTitle, configured.modelId, fetchImpl, options);
		}
		console.warn(`[title-gen] Naming model "${options.namingModel}" is not available for goal summary; falling back`);
	}

	// Gateway configured but no explicit naming model - auto-select a low-cost
	// Claude model (prefer Haiku) rather than hitting api.anthropic.com.
	const aigwGateway = options?.aigwGateway ?? options?.gateways?.find((gateway) => gateway.type === "aigw" && gateway.enabled);
	const aigwUrl = aigwGateway?.url ?? options?.aigwUrl;
	if (aigwUrl) {
		const authorization = aigwGateway
			? await resolveGatewayCredential(options?.preferencesStore?.get(`providerKey.gateway.${aigwGateway.id}`), aigwGateway.name)
			: undefined;
		const fallbackId = await pickFallbackAigwNamingModel(aigwUrl, fetchImpl, authorization);
		if (fallbackId) {
			console.log(`[title-gen] Using fallback gateway naming model "${fallbackId}" for goal summary`);
			return generateGoalSummaryViaGateway(aigwUrl, fallbackId, goalTitle, fetchImpl, authorization);
		}
		console.warn("[title-gen] Gateway configured but no suitable Claude naming model found for goal summary; falling back");
	}

	if (options?.fallbackModel) {
		const configured = await findConfiguredModel(options.fallbackModel, options);
		if (configured?.model) {
			const userPrompt = `Goal title:\n\n---\n${goalTitle}\n---\n\nReply with ONLY <title>YOUR 3-WORD SUMMARY</title>:`;
			console.log(`[title-gen] Using session default fallback naming model "${options.fallbackModel}" for goal summary`);
			return generateViaConfiguredDirectModel(configured.model, userPrompt, GOAL_SUMMARY_SYSTEM, options);
		}
	}

	return generateGoalSummaryViaAnthropic(goalTitle, DEFAULT_TITLE_MODEL, fetchImpl, options);
}
