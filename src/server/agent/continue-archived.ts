/**
 * Continue-Archived: build seed context to inject into a new session's
 * system prompt from an archived session's transcript.
 *
 * Modes:
 *   - "full":    verbatim rendering of the transcript, capped at 128 KB.
 *   - "summary": LLM-generated recap via the naming model. Falls back to
 *                "full" when the naming model is unavailable.
 */

import type { PersistedSession } from "./session-store.js";
import { LARGE_CONTENT_THRESHOLD } from "./truncate-large-content.js";

/** Hard cap for total seed-context payload (128 KB). */
const SEED_TOTAL_BUDGET = 4 * LARGE_CONTENT_THRESHOLD;
/** Soft cap for summary-mode input transcript (60 KB). */
const SUMMARY_INPUT_BUDGET = 60 * 1024;

export interface NamingModelOptions {
	namingModel?: string;
	aigwUrl?: string;
	thinkingLevel?: string;
}

/** Truncate a string to a max byte budget, adding a terminator marker. */
export function truncateStringToBudget(input: string, maxBytes: number): string {
	if (input.length <= maxBytes) return input;
	const marker = "\n\n…[truncated — original exceeded seed-context budget]";
	const head = input.slice(0, Math.max(0, maxBytes - marker.length));
	return head + marker;
}

function renderBlock(block: any): string {
	if (!block || typeof block !== "object") return "";
	const type = block.type;
	if (type === "text") {
		return typeof block.text === "string" ? block.text : "";
	}
	if (type === "tool_use" || type === "toolCall") {
		const name = block.name || block.toolName || "tool";
		const id = block.id || block.toolUseId || "";
		let input = block.input ?? block.args ?? "";
		try {
			if (typeof input !== "string") input = JSON.stringify(input);
		} catch { input = String(input); }
		// Hide pathological base64 image blobs
		if (typeof input === "string" && input.length > 8 * 1024) {
			input = input.slice(0, 8 * 1024) + "…[tool input truncated]";
		}
		return `[tool_use ${name}${id ? ` id=${id}` : ""}]\n${input}`;
	}
	if (type === "tool_result" || type === "toolResult") {
		const id = block.tool_use_id || block.toolUseId || "";
		let content = block.content ?? block.result ?? "";
		if (Array.isArray(content)) {
			content = content.map(renderBlock).filter(Boolean).join("\n");
		}
		if (typeof content !== "string") {
			try { content = JSON.stringify(content); } catch { content = String(content); }
		}
		// Normalize base64 image payloads
		if (typeof content === "string" && /^data:image\/[a-z]+;base64,/i.test(content)) {
			content = "[image]";
		}
		return `[tool_result${id ? ` id=${id}` : ""}]\n${content}`;
	}
	if (type === "image") {
		return "[image]";
	}
	if (type === "thinking") {
		return ""; // drop internal CoT
	}
	// Unknown — fall back to JSON
	try { return JSON.stringify(block); } catch { return ""; }
}

/** Render messages into plain-text role-prefixed blocks. */
export function renderMessagesAsText(messages: unknown[]): string {
	const parts: string[] = [];
	for (const msg of messages as any[]) {
		if (!msg) continue;
		const role = msg.role || "unknown";
		let body = "";
		if (typeof msg.content === "string") {
			body = msg.content;
		} else if (Array.isArray(msg.content)) {
			body = msg.content.map(renderBlock).filter((s: string) => s && s.trim()).join("\n\n");
		}
		if (!body.trim()) continue;
		parts.push(`### ${role}\n\n${body.trim()}`);
	}
	return parts.join("\n\n");
}

/** Format the full transcript (verbatim) with a header. */
export function formatFullTranscript(messages: unknown[], source: PersistedSession): string {
	const rendered = renderMessagesAsText(messages);
	const archivedAt = source.archivedAt
		? new Date(source.archivedAt).toISOString()
		: "unknown";
	const header = `Original session: "${source.title}" (archived ${archivedAt})\n\n`;
	return truncateStringToBudget(header + rendered, SEED_TOTAL_BUDGET);
}

/**
 * Resolve the gateway model id, matching title-generator's lightweight
 * approach. We avoid importing the private helpers from title-generator
 * and instead just pass through the configured model id.
 */
async function callNamingModel(
	prompt: string,
	options: NamingModelOptions,
): Promise<string | null> {
	if (!options.namingModel || !options.aigwUrl) return null;
	const slash = options.namingModel.indexOf("/");
	if (slash <= 0 || slash >= options.namingModel.length - 1) return null;
	const modelId = options.namingModel.slice(slash + 1);

	const baseUrl = options.aigwUrl.replace(/\/+$/, "");
	const url = baseUrl.endsWith("/v1")
		? `${baseUrl}/chat/completions`
		: `${baseUrl}/v1/chat/completions`;

	const body: any = {
		model: modelId,
		max_tokens: 1024,
		messages: [
			{ role: "system", content: "You produce concise bullet-point summaries of past AI-coding sessions." },
			{ role: "user", content: prompt },
		],
	};

	if (options.thinkingLevel && options.thinkingLevel !== "off") {
		const budgets: Record<string, number> = { minimal: 1024, low: 4096, medium: 10240, high: 32768 };
		const budget = budgets[options.thinkingLevel];
		if (budget) {
			body.thinking = { type: "enabled", budget_tokens: budget };
			body.max_tokens = Math.max(body.max_tokens, budget + 512);
		}
	}

	try {
		const response = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(30_000),
		});
		if (!response.ok) {
			console.warn(`[continue-archived] Naming model returned ${response.status}`);
			return null;
		}
		const data = await response.json() as any;
		const text = data?.choices?.[0]?.message?.content;
		if (typeof text === "string" && text.trim()) return text.trim();
		return null;
	} catch (err) {
		console.warn("[continue-archived] Naming model request failed:", err);
		return null;
	}
}

/** Summarize a transcript. Falls back to full mode when the model is unavailable. */
export async function summarizeTranscript(
	messages: unknown[],
	source: PersistedSession,
	options: NamingModelOptions,
): Promise<string> {
	const fullTranscript = renderMessagesAsText(messages);
	const capped = fullTranscript.length > SUMMARY_INPUT_BUDGET
		? fullTranscript.slice(0, SUMMARY_INPUT_BUDGET) + "\n…[truncated for summary]"
		: fullTranscript;

	const prompt =
		`Summarize this past conversation in 10-20 bullet points capturing:\n` +
		`- The user's overall goal/task\n` +
		`- Key decisions and conclusions\n` +
		`- Files/components touched\n` +
		`- Open threads or next steps\n\n` +
		`Conversation:\n\n${capped}`;

	const summary = await callNamingModel(prompt, options);
	if (!summary) {
		console.warn("[continue-archived] Naming model unavailable — falling back to full transcript");
		return formatFullTranscript(messages, source);
	}

	const header = `Summary of prior session "${source.title}":\n\n`;
	return truncateStringToBudget(header + summary, SEED_TOTAL_BUDGET);
}

/** Build the seed context. Always returns a non-empty string on success. */
export async function buildSeedContext(
	messages: unknown[],
	mode: "summary" | "full",
	source: PersistedSession,
	options: NamingModelOptions,
): Promise<string> {
	if (mode === "full") return formatFullTranscript(messages, source);
	return summarizeTranscript(messages, source, options);
}
