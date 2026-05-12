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
 * Single DOM identity invariant: the synthetic message uses a STABLE id
 * (`COMPACTION_ACTIVE_ID = "compact_active"`) across the whole lifecycle
 * (in-progress → complete | error). The reducer filters by that id so the
 * Lit render keeps the same DOM node and only re-paints the body. See
 * §2.1 / §7 of `docs/design/compaction-e2e-rich-summary.md`.
 */

/** "manual" → /compact slash; "auto" → threshold-driven; "overflow" → context-limit error. */
export type CompactionTrigger = "manual" | "auto" | "overflow";

/** Three lifecycle states the renderer branches on. */
export type CompactionState = "in-progress" | "complete" | "error";

export interface CompactionSummaryPayload {
	/** v1 — bump if the renderer adds new fields that break older snapshots. */
	schemaVersion: 1;
	trigger: CompactionTrigger;
	/** NEW — drives the renderer branch. Older persisted payloads may omit
	 *  this; the renderer derives `complete | error` from `success` as a
	 *  back-compat fallback. */
	state?: CompactionState;
	/** Mirrors `state === "complete"`. Kept so case (12c) upgrade adapter
	 *  and back-compat snapshots stay intact. */
	success: boolean;
	/** ISO-8601 of compaction_end (or compaction_start for in-progress). */
	timestamp: string;
	/** Token count from compaction_end.tokensBefore (or
	 *  parsed from the overflow error, or the last-known live context). */
	tokensBefore: number | null;
	/** Best-effort post-compaction usage from the latest assistant message
	 *  with `usage`. Null when not known. */
	tokensAfter: number | null;
	/** Derived. Null if either count is null. Range 0–100, one decimal. */
	reductionPct: number | null;
	/** Failure detail; only set when state === "error". */
	error?: string;
}

export interface CompactionSummaryMessages {
	message: any;
	toolResult: any;
}

/** Synthetic-tool name. Leading `__` keeps it off the real-tool registry. */
export const COMPACTION_TOOL_NAME = "__compaction_summary";

/** Stable id used across all lifecycle states for single-DOM-identity. */
export const COMPACTION_ACTIVE_ID = "compact_active";
export const COMPACTION_ACTIVE_TOOLCALL_ID = `compaction-summary:${COMPACTION_ACTIVE_ID}`;

/**
 * Build the synthetic assistant message + paired toolResult that the reducer
 * pushes via the `compaction-result` (or `compaction-placeholder` for the
 * in-progress state) action. Uses a STABLE id so the renderer keeps the same
 * DOM node across in-progress → complete | error.
 */
export function buildCompactionSummaryMessages(
	payload: CompactionSummaryPayload,
): CompactionSummaryMessages {
	const now = Date.now();
	const id = COMPACTION_ACTIVE_ID;
	const toolCallId = COMPACTION_ACTIVE_TOOLCALL_ID;
	const isError = (payload.state ?? (payload.success ? "complete" : "error")) === "error";

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
		isError,
		content: [
			{
				type: "text" as const,
				text: isError ? (payload.error || "compaction failed") : "ok",
			},
		],
		details: payload,
		timestamp: now,
	};

	return { message, toolResult };
}

/**
 * Build the in-progress payload emitted on `compaction_start`. tokensBefore
 * is best-effort (read from the latest usage row or, if forwarded, the
 * server-side RPC result).
 */
export function buildInProgressCompactionPayload(
	trigger: CompactionTrigger,
	tokensBefore: number | null,
): CompactionSummaryPayload {
	return {
		schemaVersion: 1,
		trigger,
		state: "in-progress",
		// In-progress payloads carry success:true as a placeholder; the
		// renderer drives off `state`, not `success`. Older readers that
		// still check `success` see this as "not yet failed".
		success: true,
		timestamp: new Date().toISOString(),
		tokensBefore,
		tokensAfter: null,
		reductionPct: null,
	};
}

/**
 * Parse the canonical Anthropic overflow error string into a token count.
 *
 * Matches "prompt is too long: 202592 tokens > 200000 maximum" and
 * sibling shapes like "X tokens > Y". Returns null on miss.
 */
export function parseOverflowTokenCount(text: string | null | undefined): number | null {
	if (!text) return null;
	const m = /(\d{4,})\s*tokens\s*>/i.exec(text);
	if (!m) return null;
	const n = parseInt(m[1], 10);
	return Number.isFinite(n) && n > 0 ? n : null;
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
 * stay null; trigger defaults to "manual" (we cannot tell from the row
 * alone). NOTE: this uses the server-row's original id (NOT the stable
 * `compact_active` id) — this is pre-existing reload-time data, not the
 * live lifecycle, so we don't need DOM-identity continuity.
 */
export function upgradeServerCompactionMarker(serverRow: any): any {
	const text = extractTextFromMessage(serverRow);
	const tokensBefore = parseTokensBeforeFromServerMarker(text);
	const payload: CompactionSummaryPayload = {
		schemaVersion: 1,
		trigger: "manual",
		state: "complete",
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
