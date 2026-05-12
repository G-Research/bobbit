/**
 * Compaction summary payload + envelope builder.
 *
 * The payload travels on a synthetic assistant message carrying a single
 * `toolCall` block named `__compaction_summary` (plus a paired `toolResult`).
 * The leading `__` signals "synthetic / never invokable by the LLM" — real
 * tools never start with `__`. Both the live emission path
 * (`remote-agent.ts::compaction_end`) and the reload-path upgrade adapter
 * (`message-reducer.ts::snapshot`) use the same shape.
 *
 * See `docs/design/compaction-e2e-rich-summary.md` §2.1, §2.2.
 */

export interface CompactionSummaryPayload {
	/** v1 — bump if the renderer adds new fields that break older snapshots. */
	schemaVersion: 1;
	/** "manual" → /compact slash command; "auto" → agent auto-compaction. */
	trigger: "manual" | "auto";
	success: boolean;
	/** ISO-8601 of compaction_end on the client. */
	timestamp: string;
	/** Token count reported in compaction_end.tokensBefore (may be null). */
	tokensBefore: number | null;
	/** Best-effort post-compaction usage from the latest assistant message
	 *  with `usage`. Null when not known. */
	tokensAfter: number | null;
	/** Derived. Null if either count is null. Range 0–100, one decimal. */
	reductionPct: number | null;
	/** Failure detail; only set when success === false. */
	error?: string;
}

export interface CompactionSummaryMessages {
	message: any;
	toolResult: any;
}

/** Synthetic-tool name. Leading `__` keeps it off the real-tool registry. */
export const COMPACTION_TOOL_NAME = "__compaction_summary";

/**
 * Build the synthetic assistant message + paired toolResult that the reducer
 * pushes via the `compaction-result` action.
 */
export function buildCompactionSummaryMessages(
	payload: CompactionSummaryPayload,
): CompactionSummaryMessages {
	const now = Date.now();
	const id = payload.success
		? `compact_done_${now}`
		: `compact_err_${now}`;
	const toolCallId = `compaction-summary:${id}`;

	const message = {
		id,
		role: "assistant" as const,
		timestamp: now,
		content: [
			{
				type: "toolCall" as const,
				id: toolCallId,
				name: COMPACTION_TOOL_NAME,
				arguments: payload,
			},
		],
	};

	const toolResult = {
		role: "toolResult" as const,
		toolCallId,
		toolName: COMPACTION_TOOL_NAME,
		isError: !payload.success,
		content: [
			{
				type: "text" as const,
				text: payload.success ? "ok" : payload.error || "compaction failed",
			},
		],
		details: payload,
		timestamp: now,
	};

	return { message, toolResult };
}

/**
 * Parse "Context compacted from Xk tokens." back into a number.
 *
 * Coupled to pi-coding-agent transcript format — see
 * `docs/design/compaction-e2e-rich-summary.md` §4 risk 1. Case (12c) in
 * `tests/message-reducer.test.ts` pins this as a regression sentinel.
 *
 * Returns null on parse failure.
 */
export function parseTokensBeforeFromServerMarker(text: string): number | null {
	const m = /Context compacted from\s+([\d.]+)\s*([kKmM]?)\s*tokens?/.exec(text);
	if (!m) return null;
	const n = parseFloat(m[1]);
	if (!Number.isFinite(n)) return null;
	const suffix = m[2]?.toLowerCase();
	if (suffix === "k") return Math.round(n * 1000);
	if (suffix === "m") return Math.round(n * 1_000_000);
	return Math.round(n);
}

/**
 * Test whether a message looks like the server's plain-text compaction marker.
 * Used to identify rows the reducer should upgrade in-place on reload.
 */
export function isServerCompactionTextMarker(m: any): boolean {
	if (!m || m.role !== "assistant") return false;
	const c = m.content;
	let text = "";
	if (typeof c === "string") text = c;
	else if (Array.isArray(c)) {
		text = c
			.filter((x: any) => x?.type === "text")
			.map((x: any) => x.text || "")
			.join("\n");
	} else return false;
	return typeof text === "string" && text.startsWith("Context compacted");
}

function extractTextFromMessage(m: any): string {
	if (!m) return "";
	const c = m.content;
	if (typeof c === "string") return c;
	if (Array.isArray(c)) {
		return c
			.filter((x: any) => x?.type === "text")
			.map((x: any) => x.text || "")
			.join("\n");
	}
	return "";
}

/**
 * Upgrade a server plain-text compaction marker into a rich synthetic
 * carrying a `__compaction_summary` toolCall. Used by the snapshot path on
 * reload when no live synthetic exists yet. `tokensAfter` / `reductionPct`
 * stay null; trigger defaults to "manual" (we cannot tell from the row alone).
 */
export function upgradeServerCompactionMarker(serverRow: any): any {
	const text = extractTextFromMessage(serverRow);
	const tokensBefore = parseTokensBeforeFromServerMarker(text);
	const payload: CompactionSummaryPayload = {
		schemaVersion: 1,
		trigger: "manual",
		success: true,
		timestamp:
			typeof serverRow?.timestamp === "number"
				? new Date(serverRow.timestamp).toISOString()
				: new Date(0).toISOString(),
		tokensBefore,
		tokensAfter: null,
		reductionPct: null,
	};
	const id =
		typeof serverRow?.id === "string" && serverRow.id.length > 0
			? serverRow.id
			: `compact_done_${Date.now()}`;
	const toolCallId = `compaction-summary:${id}`;
	return {
		...serverRow,
		id,
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: toolCallId,
				name: COMPACTION_TOOL_NAME,
				arguments: payload,
			},
		],
	};
}
