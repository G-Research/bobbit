/**
 * Content policy for semantic-search indexing.
 *
 * Translates an agent message object into a list of role-tagged, weighted
 * text entries ready to be wrapped in `Indexable`s by upstream sources.
 *
 * This replaces the older `message-extractor.ts::extractTextFromMessage`
 * which only emitted flat assistant text. See design doc §5 for the
 * authoritative table of role → weight → text rules.
 *
 * Design reference: docs/design/semantic-search.md §5 (Content policy).
 */

import type { Role } from "./types.js";

// ── Versioning ───────────────────────────────────────────────────────

/**
 * Bump when the extraction rules below change in a way that alters what
 * text gets indexed or how it is weighted. A version mismatch in
 * `search_meta` triggers a full rebuild on next open (see §10).
 */
export const CONTENT_POLICY_VERSION = 1;

// ── Constants ────────────────────────────────────────────────────────

/**
 * Raw tool-result content bigger than this is hard-skipped (not indexed).
 * Aligned with `src/server/agent/truncate-large-content.ts` (32KB).
 */
export const MAX_TOOL_RESULT_INPUT_CHARS = 32_768;

/** Tool-result text is truncated to this many characters when indexed. */
export const TOOL_RESULT_INDEX_CHARS = 500;

// ── Public types ─────────────────────────────────────────────────────

export interface PolicyEntry {
	role: Role;
	weight: number;
	text: string;
	/** Stable per-message key — used by callers to build chunk/row ids. */
	blockKey: string;
}

export interface PolicyHit {
	entries: PolicyEntry[];
}

export interface ExtractOptions {
	/** Skip tool_result blocks whose raw content exceeds this (default 32768). */
	maxToolResultInputChars?: number;
	/** Truncate indexed tool_result text to this length (default 500). */
	toolResultIndexChars?: number;
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Remove `<thinking>…</thinking>` blocks from assistant text.
 *
 * Non-nested, multi-line. Unmatched opening tags are left untouched — we
 * only strip when a matching close tag is found. This keeps partial
 * streaming output sensible and avoids eating everything to EOF.
 */
export function stripThinking(text: string): string {
	if (!text) return text;
	// Non-greedy match, dot-all via [\s\S].
	return text.replace(/<thinking>[\s\S]*?<\/thinking>/g, "").trim();
}

/** Extract just the first line (up to the first \r or \n) of a string. */
function firstLine(text: string): string {
	const idx = text.search(/[\r\n]/);
	return idx === -1 ? text : text.slice(0, idx);
}

/**
 * Summarise a tool invocation into a single short indexable line:
 *
 *     <tool_name> <first-line-of-stringified-input>
 *
 * Robust to non-serialisable input (falls back to an empty arg section).
 */
export function summariseToolCall(name: string, input: unknown): string {
	const safeName = typeof name === "string" ? name : "";
	let argLine = "";
	if (input !== undefined && input !== null) {
		try {
			const s = typeof input === "string" ? input : JSON.stringify(input);
			if (typeof s === "string") argLine = firstLine(s);
		} catch {
			argLine = "";
		}
	}
	return argLine ? `${safeName} ${argLine}`.trim() : safeName.trim();
}

// ── Core: extractForIndexing ─────────────────────────────────────────

function blockTextContent(block: Record<string, unknown>): string {
	// Tool-result blocks carry content in `content` which may be:
	//  - string
	//  - array of { type: "text"|"image"; text?: string } blocks
	const direct = block.text;
	if (typeof direct === "string") return direct;

	const content = block.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		const parts: string[] = [];
		for (const c of content) {
			if (c && typeof c === "object") {
				const cb = c as Record<string, unknown>;
				if (cb.type === "text" && typeof cb.text === "string") {
					parts.push(cb.text);
				}
			} else if (typeof c === "string") {
				parts.push(c);
			}
		}
		return parts.join("\n");
	}
	return "";
}

/**
 * Extract role-weighted indexable entries from a single message.
 *
 * Role-detection rule order (per block) — design §5:
 *   1. user + text      → user,         2.0
 *   2. user + tool_result → tool_result, 0.5 (skip if raw >32KB, else first 500 chars)
 *   3. assistant + text → assistant,    1.0  (stripThinking)
 *   4. assistant + tool_use → tool_call, 0.8
 *   5. thinking blocks  → skip
 *   6. image/binary     → skip
 *
 * A bare string `content` on a user/assistant message is treated as a
 * single text block.
 *
 * Empty-text entries are filtered out before returning — callers never
 * have to re-check.
 */
export function extractForIndexing(
	message: unknown,
	opts?: ExtractOptions,
): PolicyHit {
	const maxToolChars = opts?.maxToolResultInputChars ?? MAX_TOOL_RESULT_INPUT_CHARS;
	const toolIndexChars = opts?.toolResultIndexChars ?? TOOL_RESULT_INDEX_CHARS;

	if (!message || typeof message !== "object") return { entries: [] };
	const msg = message as Record<string, unknown>;
	const msgRole = msg.role as string | undefined;

	// Only user/assistant messages contribute to the index.
	if (msgRole !== "user" && msgRole !== "assistant") return { entries: [] };

	const entries: PolicyEntry[] = [];
	const content = msg.content;

	const pushText = (role: Role, weight: number, text: string, blockKey: string) => {
		const t = text?.trim();
		if (!t) return;
		entries.push({ role, weight, text: t, blockKey });
	};

	// String content — treat as a single text block.
	if (typeof content === "string") {
		if (msgRole === "user") {
			pushText("user", 2.0, content, "text:0");
		} else {
			pushText("assistant", 1.0, stripThinking(content), "text:0");
		}
		return { entries };
	}

	if (!Array.isArray(content)) return { entries };

	for (let i = 0; i < content.length; i++) {
		const block = content[i];
		if (!block || typeof block !== "object") continue;
		const b = block as Record<string, unknown>;
		const type = b.type as string | undefined;

		// Skip binary / internal reasoning block types outright.
		if (type === "thinking" || type === "image") continue;

		if (msgRole === "user") {
			if (type === "text") {
				pushText("user", 2.0, blockTextContent(b), `text:${i}`);
			} else if (type === "tool_result") {
				const raw = blockTextContent(b);
				if (raw.length > maxToolChars) continue; // hard skip
				pushText(
					"tool_result",
					0.5,
					raw.slice(0, toolIndexChars),
					`tool_result:${i}`,
				);
			}
			// Any other block type from a user message → skip.
			continue;
		}

		// assistant
		if (type === "text") {
			pushText(
				"assistant",
				1.0,
				stripThinking(blockTextContent(b)),
				`text:${i}`,
			);
		} else if (type === "tool_use") {
			const name = typeof b.name === "string" ? b.name : "";
			const summary = summariseToolCall(name, b.input);
			pushText("tool_call", 0.8, summary, `tool_use:${i}`);
		}
		// Any other block type from assistant → skip.
	}

	return { entries };
}
