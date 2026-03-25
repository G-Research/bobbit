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

const DEFAULT_TITLE_MODEL = "claude-haiku-4-5-20251001";
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";

export interface TitleGenOptions {
	/** Override model in "provider/modelId" format, e.g. "aigw/claude-haiku-4-5" */
	namingModel?: string;
	/** AI Gateway URL for proxying requests (used when provider is "aigw") */
	aigwUrl?: string;
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
async function generateViaGateway(aigwUrl: string, modelId: string, preview: string): Promise<string | null> {
	const baseUrl = aigwUrl.replace(/\/+$/, "");
	const resolvedModel = await resolveGatewayModelId(baseUrl, modelId);
	const url = baseUrl.endsWith("/v1") ? `${baseUrl}/chat/completions` : `${baseUrl}/v1/chat/completions`;

	const body = {
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
async function generateViaAnthropic(preview: string): Promise<string | null> {
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

	const body = {
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

	console.log(`[title-gen] Requesting title via ${DEFAULT_TITLE_MODEL}…`);

	try {
		const response = await fetch(ANTHROPIC_API_URL, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
		});

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
			return generateViaGateway(options.aigwUrl, modelId, preview);
		}
		console.warn(`[title-gen] Malformed namingModel preference: "${options.namingModel}", ignoring`);
	}

	// Default: direct Anthropic API (works for both public and gateway-less setups).
	// We don't fall back to the gateway without an explicit naming model because
	// the gateway may not host the default Haiku model ID.
	return generateViaAnthropic(preview);
}
