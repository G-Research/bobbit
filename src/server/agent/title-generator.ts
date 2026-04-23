/**
 * Generates a short session title from conversation messages.
 * Supports three modes:
 * 1. Direct Anthropic API (default — uses Claude Haiku via api.anthropic.com)
 * 2. AI Gateway proxy (when aigw is configured — routes through the gateway)
 * 3. Custom naming model (user preference — any provider/model via the gateway)
 */

import { existsSync, readFileSync } from "node:fs";
import { refreshOAuthToken } from "../auth/oauth.js";
import { globalAuthPath } from "../bobbit-dir.js";
import { discoverAigwModels } from "./aigw-manager.js";
import { modelRecencyRank } from "./model-registry.js";

/** Cache for the fallback naming model id, keyed by gateway URL. TTL ~60s. */
let _fallbackCache: { url: string; modelId: string | null; expiresAt: number } | null = null;
const FALLBACK_TTL_MS = 60_000;

/**
 * Pick a low-cost Claude model from the gateway to use as a naming model
 * when the user has no explicit `default.namingModel`. Prefers Haiku.
 * Returns the *stripped* id (no provider prefix) suitable for generateViaGateway,
 * or null if the gateway exposes no Claude-family model.
 */
export async function pickFallbackAigwNamingModel(aigwUrl: string): Promise<string | null> {
	const normalized = aigwUrl.replace(/\/+$/, "");
	const now = Date.now();
	if (_fallbackCache && _fallbackCache.url === normalized && _fallbackCache.expiresAt > now) {
		return _fallbackCache.modelId;
	}
	let picked: string | null = null;
	try {
		const models = await discoverAigwModels(normalized);
		const stripPrefix = (id: string) => { const i = id.indexOf("/"); return i >= 0 ? id.slice(i + 1) : id; };
		const claude = models.filter(m => m.id.toLowerCase().includes("claude"));
		if (claude.length > 0) {
			// Prefer Haiku (cheapest); else highest-ranked Claude by recency (still cheaper than running reviews on Opus).
			const haiku = claude.filter(m => m.id.toLowerCase().includes("haiku"));
			const pool = haiku.length > 0 ? haiku : claude;
			pool.sort((a, b) => modelRecencyRank(b.id) - modelRecencyRank(a.id));
			picked = stripPrefix(pool[0].id);
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
	/** AI Gateway URL for proxying requests (used when provider is "aigw") */
	aigwUrl?: string;
	/** Thinking level for title generation: "off"|"minimal"|"low"|"medium"|"high" */
	thinkingLevel?: string;
}

interface AuthCredentials {
	type: string;
	access: string;
	refresh?: string;
	expires?: number;
}

function loadAuth(): AuthCredentials | null {
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
		if (text.length > maxLen) text = text.slice(0, maxLen) + "…";

		const label = isUser ? "User" : "Assistant";
		parts.push(`${label}: ${text}`);

		if (isUser) userCount++;
		if (isAssistant) assistantCount++;
	}

	return parts.join("\n\n");
}

function cleanTitle(raw: string): string {
	let title = raw
		.replace(/^#+\s*/, "")
		.replace(/^["'"']+|["'"']+$/g, "")
		.replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{27BF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{200D}\u{20E3}\u{FE0F}]/gu, '')
		.replace(/\n.*/s, "")
		.trim();
	if (title.length > 30) title = title.slice(0, 27) + "…";
	return title;
}

/**
 * Resolve a potentially prefix-stripped model ID back to the full gateway model ID.
 * Claude models are stored with the provider prefix stripped (e.g. "us.anthropic.claude-...")
 * but the gateway's /v1/chat/completions endpoint needs the full ID (e.g. "aws/us.anthropic.claude-...").
 * Queries the gateway's /v1/models endpoint to find a match.
 */
async function resolveGatewayModelId(baseUrl: string, strippedId: string): Promise<string> {
	try {
		const modelsUrl = baseUrl.endsWith("/v1") ? `${baseUrl}/models` : `${baseUrl}/v1/models`;
		const res = await fetch(modelsUrl, { signal: AbortSignal.timeout(5000) });
		if (!res.ok) return strippedId;
		const data = await res.json() as { data?: Array<{ id: string }> };
		if (!Array.isArray(data.data)) return strippedId;

		// Exact match first
		const exact = data.data.find(m => m.id === strippedId);
		if (exact) return exact.id;

		// Suffix match — find a model whose ID ends with the stripped ID after the prefix slash
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
 */
async function generateViaGateway(aigwUrl: string, modelId: string, preview: string, thinkingLevel?: string): Promise<string | null> {
	const baseUrl = aigwUrl.replace(/\/+$/, "");
	const resolvedModel = await resolveGatewayModelId(baseUrl, modelId);
	const url = baseUrl.endsWith("/v1") ? `${baseUrl}/chat/completions` : `${baseUrl}/v1/chat/completions`;

	const body: any = {
		model: resolvedModel,
		max_tokens: 20,
		messages: [
			{
				role: "system",
				content: "Output a 2-3 word label for this conversation. MAXIMUM 3 words. Output ONLY the label. No quotes, no markdown, no explanation. No emojis.",
			},
			{
				role: "user",
				content: `Conversation:\n\n---\n${preview}\n---\n\n2-3 word label:`,
			},
		],
	};

	// Add thinking if configured and not "off"
	if (thinkingLevel && thinkingLevel !== "off") {
		const budgets: Record<string, number> = { minimal: 1024, low: 4096, medium: 10240, high: 32768 };
		const budget = budgets[thinkingLevel];
		if (budget) {
			body.thinking = { type: "enabled", budget_tokens: budget };
			body.max_tokens = Math.max(body.max_tokens, budget + 20);
		}
	}

	console.log(`[title-gen] Requesting title via gateway model "${resolvedModel}"${resolvedModel !== modelId ? ` (resolved from "${modelId}")` : ""}…`);

	try {
		const response = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});

		if (!response.ok) {
			const errText = await response.text();
			console.error(`[title-gen] Gateway error ${response.status}: ${errText.slice(0, 200)}`);
			return null;
		}

		const data = await response.json() as any;
		const text = data.choices?.[0]?.message?.content?.trim();
		if (!text) return null;

		const title = cleanTitle(text);
		console.log(`[title-gen] Generated title: "${title}"`);
		return title || null;
	} catch (err) {
		console.error("[title-gen] Gateway request failed:", err);
		return null;
	}
}

/**
 * Generate title via direct Anthropic API call.
 */
async function generateViaAnthropic(preview: string, thinkingLevel?: string): Promise<string | null> {
	let auth = loadAuth();
	if (!auth) return null;

	if (auth.type === "oauth" && auth.expires && Date.now() > auth.expires) {
		const newToken = await refreshOAuthToken();
		if (newToken) {
			auth = { ...auth, access: newToken };
		} else {
			console.error("[title-gen] Token expired and refresh failed");
			return null;
		}
	}

	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		"anthropic-version": "2023-06-01",
	};

	if (auth.type === "oauth") {
		headers["Authorization"] = `Bearer ${auth.access}`;
		headers["anthropic-beta"] = "claude-code-20250219,oauth-2025-04-20";
	} else {
		headers["x-api-key"] = auth.access;
	}

	const coreInstruction = "Output a 2-3 word label for this conversation. MAXIMUM 3 words. Examples: \"Fix Login Bug\", \"Redis Setup\", \"CSV Parser\", \"Dark Mode\". Output ONLY the label. No quotes, no markdown, no explanation. No emojis.";
	const systemText = auth.type === "oauth"
		? `You are Claude Code, Anthropic's official CLI for Claude. ${coreInstruction}`
		: coreInstruction;

	const body: any = {
		model: DEFAULT_TITLE_MODEL,
		max_tokens: 12,
		system: auth.type === "oauth"
			? [{ type: "text", text: systemText }]
			: systemText,
		messages: [
			{
				role: "user",
				content: `Conversation:\n\n---\n${preview}\n---\n\n2-3 word label:`,
			},
		],
	};

	// Add thinking if configured and not "off"
	if (thinkingLevel && thinkingLevel !== "off") {
		const budgets: Record<string, number> = { minimal: 1024, low: 4096, medium: 10240, high: 32768 };
		const budget = budgets[thinkingLevel];
		if (budget) {
			body.thinking = { type: "enabled", budget_tokens: budget };
			body.max_tokens = Math.max(body.max_tokens, budget + 12);
		}
	}

	console.log(`[title-gen] Requesting title via ${DEFAULT_TITLE_MODEL}…`);

	try {
		let response = await fetch(ANTHROPIC_API_URL, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
		});

		// On auth errors, try refreshing the token and retrying once
		if (!response.ok && (response.status === 401 || response.status === 403) && auth.type === "oauth") {
			console.warn(`[title-gen] Auth error ${response.status}, attempting token refresh…`);
			const newToken = await refreshOAuthToken();
			if (newToken) {
				headers["Authorization"] = `Bearer ${newToken}`;
				response = await fetch(ANTHROPIC_API_URL, { method: "POST", headers, body: JSON.stringify(body) });
			}
		}

		if (!response.ok) {
			const errText = await response.text();
			console.error(`[title-gen] API error ${response.status}: ${errText}`);
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
		console.error("[title-gen] Failed:", err);
		return null;
	}
}

/**
 * Generate a short title for a session based on its messages.
 * Returns null if generation fails.
 */
export async function generateSessionTitle(messages: any[], options?: TitleGenOptions): Promise<string | null> {
	// Skip title generation entirely when tests/CI opt out — avoids real
	// outbound calls to api.anthropic.com for every prompted test.
	if (process.env.BOBBIT_SKIP_TITLE_GEN) return null;
	const preview = extractConversationPreview(messages);
	if (!preview.trim()) {
		console.error("[title-gen] No conversation content to summarise");
		return null;
	}

	// If a naming model is configured and we have a gateway, use it
	if (options?.namingModel && options.aigwUrl) {
		const slash = options.namingModel.indexOf("/");
		if (slash > 0 && slash < options.namingModel.length - 1) {
			const modelId = options.namingModel.slice(slash + 1);
			return generateViaGateway(options.aigwUrl, modelId, preview, options.thinkingLevel);
		}
		console.warn(`[title-gen] Malformed namingModel preference: "${options.namingModel}", ignoring`);
	}

	// Gateway configured but no explicit naming model — auto-select a low-cost
	// Claude model from the gateway (prefer Haiku). This avoids silent failures
	// in secure-zone deployments that cannot reach api.anthropic.com directly.
	if (options?.aigwUrl) {
		const fallbackId = await pickFallbackAigwNamingModel(options.aigwUrl);
		if (fallbackId) {
			console.log(`[title-gen] Using fallback gateway naming model "${fallbackId}"`);
			return generateViaGateway(options.aigwUrl, fallbackId, preview, options.thinkingLevel);
		}
		console.warn("[title-gen] Gateway configured but no suitable Claude naming model found; falling back to direct Anthropic API");
	}

	// Default: direct Anthropic API (works for public, gateway-less, and
	// gateway-but-no-Claude setups).
	return generateViaAnthropic(preview, options?.thinkingLevel);
}

// ── Goal title summarization ──────────────────────────────────────────

const GOAL_SUMMARY_SYSTEM = "Summarize this goal title in exactly 3 words. Output ONLY the 3-word summary. No quotes, no markdown, no explanation. No emojis.";

/**
 * Generate a 3-word summary of a goal title via the AI Gateway.
 */
async function generateGoalSummaryViaGateway(aigwUrl: string, modelId: string, goalTitle: string): Promise<string | null> {
	const baseUrl = aigwUrl.replace(/\/+$/, "");
	const resolvedModel = await resolveGatewayModelId(baseUrl, modelId);
	const url = baseUrl.endsWith("/v1") ? `${baseUrl}/chat/completions` : `${baseUrl}/v1/chat/completions`;

	const body = {
		model: resolvedModel,
		max_tokens: 20,
		messages: [
			{ role: "system", content: GOAL_SUMMARY_SYSTEM },
			{ role: "user", content: `Goal title:\n\n---\n${goalTitle}\n---\n\n3-word summary:` },
		],
	};

	console.log(`[title-gen] Requesting goal summary via gateway model "${resolvedModel}"…`);

	try {
		const response = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});

		if (!response.ok) {
			const errText = await response.text();
			console.error(`[title-gen] Gateway error ${response.status}: ${errText.slice(0, 200)}`);
			return null;
		}

		const data = await response.json() as any;
		const text = data.choices?.[0]?.message?.content?.trim();
		if (!text) return null;

		const title = cleanTitle(text);
		console.log(`[title-gen] Generated goal summary: "${title}"`);
		return title || null;
	} catch (err) {
		console.error("[title-gen] Gateway goal summary request failed:", err);
		return null;
	}
}

/**
 * Generate a 3-word summary of a goal title via direct Anthropic API.
 */
async function generateGoalSummaryViaAnthropic(goalTitle: string): Promise<string | null> {
	let auth = loadAuth();
	if (!auth) return null;

	if (auth.type === "oauth" && auth.expires && Date.now() > auth.expires) {
		const newToken = await refreshOAuthToken();
		if (newToken) {
			auth = { ...auth, access: newToken };
		} else {
			console.error("[title-gen] Token expired and refresh failed");
			return null;
		}
	}

	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		"anthropic-version": "2023-06-01",
	};

	if (auth.type === "oauth") {
		headers["Authorization"] = `Bearer ${auth.access}`;
		headers["anthropic-beta"] = "claude-code-20250219,oauth-2025-04-20";
	} else {
		headers["x-api-key"] = auth.access;
	}

	const systemText = auth.type === "oauth"
		? `You are Claude Code, Anthropic's official CLI for Claude. ${GOAL_SUMMARY_SYSTEM}`
		: GOAL_SUMMARY_SYSTEM;

	const body = {
		model: DEFAULT_TITLE_MODEL,
		max_tokens: 12,
		system: auth.type === "oauth"
			? [{ type: "text", text: systemText }]
			: systemText,
		messages: [
			{ role: "user", content: `Goal title:\n\n---\n${goalTitle}\n---\n\n3-word summary:` },
		],
	};

	console.log(`[title-gen] Requesting goal summary via ${DEFAULT_TITLE_MODEL}…`);

	try {
		let response = await fetch(ANTHROPIC_API_URL, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
		});

		// On auth errors, try refreshing the token and retrying once
		if (!response.ok && (response.status === 401 || response.status === 403) && auth.type === "oauth") {
			console.warn(`[title-gen] Auth error ${response.status}, attempting token refresh…`);
			const newToken = await refreshOAuthToken();
			if (newToken) {
				headers["Authorization"] = `Bearer ${newToken}`;
				response = await fetch(ANTHROPIC_API_URL, { method: "POST", headers, body: JSON.stringify(body) });
			}
		}

		if (!response.ok) {
			const errText = await response.text();
			console.error(`[title-gen] API error ${response.status}: ${errText}`);
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
		console.error("[title-gen] Goal summary failed:", err);
		return null;
	}
}

/**
 * Generate a 3-word summary of a goal title for sidebar display.
 * Returns the cleaned summary (without "New goal: " prefix — caller adds that).
 * Returns null if generation fails.
 */
export async function generateGoalSummaryTitle(goalTitle: string, options?: TitleGenOptions): Promise<string | null> {
	if (process.env.BOBBIT_SKIP_TITLE_GEN) return null;
	if (!goalTitle.trim()) {
		console.error("[title-gen] No goal title to summarise");
		return null;
	}

	if (options?.namingModel && options.aigwUrl) {
		const slash = options.namingModel.indexOf("/");
		if (slash > 0 && slash < options.namingModel.length - 1) {
			const modelId = options.namingModel.slice(slash + 1);
			return generateGoalSummaryViaGateway(options.aigwUrl, modelId, goalTitle);
		}
		console.warn(`[title-gen] Malformed namingModel preference: "${options.namingModel}", ignoring`);
	}

	// Gateway configured but no explicit naming model — auto-select a low-cost
	// Claude model (prefer Haiku) rather than hitting api.anthropic.com.
	if (options?.aigwUrl) {
		const fallbackId = await pickFallbackAigwNamingModel(options.aigwUrl);
		if (fallbackId) {
			console.log(`[title-gen] Using fallback gateway naming model "${fallbackId}" for goal summary`);
			return generateGoalSummaryViaGateway(options.aigwUrl, fallbackId, goalTitle);
		}
		console.warn("[title-gen] Gateway configured but no suitable Claude naming model found for goal summary; falling back to direct Anthropic API");
	}

	return generateGoalSummaryViaAnthropic(goalTitle);
}
