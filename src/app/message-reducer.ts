/**
 * Unified message ordering reducer.
 *
 * One ordinal, server-stamped at emit time, preserved on every message that
 * ever lands in the transcript, sorted once by a single pure reducer, trusted
 * verbatim by render.
 *
 * See `docs/design/unified-message-ordering-reducer.md`.
 *
 * INVARIANTS
 * - Pure: no `Date.now()`, no `Math.random()`, no `this`, no DOM.
 * - Output `messages` array sorted by `(_order ASC, _insertionTick ASC)` after
 *   every reduce.
 * - All entries carry numeric `_order` + `_origin` + `_insertionTick`.
 * - Server snapshot is authoritative for any id it contains.
 */

export type MessageOrigin = "server" | "optimistic" | "synthetic" | "permission";

export interface OrderedMessage {
	[k: string]: unknown;
	id?: string;
	role: string;
	timestamp?: number;
	/**
	 * Sort primary. Server-stamped (positive seq for live, negative for
	 * snapshot) or sentinel for optimistic/synthetic.
	 */
	_order: number;
	_origin: MessageOrigin;
	/** Sort secondary. Monotonic counter incremented on every reduce. */
	_insertionTick: number;
}

export interface ReducerState {
	/** Sorted by (_order ASC, _insertionTick ASC). Render trusts verbatim. */
	messages: OrderedMessage[];
	nextTick: number;
	/** Highest live seq we've consumed (or last-positive snapshot order). */
	highestSeq: number;
}

export type Action =
	| { type: "live-event"; frame: any; seq: number; ts?: number }
	| { type: "snapshot"; messages: any[] }
	| { type: "optimistic-prompt"; message: any }
	| { type: "optimistic-steer"; message: any }
	| { type: "permission-needed"; card: any; seq?: number; ts?: number }
	| { type: "permission-resolved"; messageId: string }
	| { type: "compaction-placeholder"; message: any }
	| { type: "compaction-result"; message: any; success: boolean; toolResult?: any }
	| { type: "system-notification"; message: any }
	| { type: "error"; message: any }
	| { type: "deny-permission-filter"; messageId: string }
	| { type: "replace-messages"; messages: any[] }
	| { type: "reset" };

export const SNAPSHOT_ORDER_FLOOR = -1_000_000_000;
const OPTIMISTIC_ORDER_BASE = Number.MAX_SAFE_INTEGER - 1_000_000_000;

export function initialState(): ReducerState {
	return { messages: [], nextTick: 1, highestSeq: 0 };
}

function extractText(message: any): string {
	if (!message) return "";
	if (typeof message === "string") return message;
	if (typeof message.content === "string") return message.content;
	if (Array.isArray(message.content)) {
		return message.content
			.filter((c: any) => c.type === "text")
			.map((c: any) => c.text || "")
			.join("\n");
	}
	return "";
}

/** Whitespace-collapsed text used for plain-text snapshot dedup. */
function normaliseText(s: string): string {
	return s.replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Compaction marker helpers.
//
// The synthetic compaction summary can appear in two shapes:
//   (a) Rich  — assistant message with a single `toolCall` block named
//                `__compaction_summary` (current emission path), plus a
//                paired `toolResult` row.
//   (b) Legacy — assistant plain-text row starting with "Context compacted"
//                (pre-rich-summary emission, still produced by older
//                clients / the agent subprocess's own transcript marker).
//
// `isSyntheticCompactionMarker` recognises both so the snapshot dedup
// invariant (case 12 + "snapshot drops trailing synthetic compaction
// marker" in tests/message-reducer.test.ts) keeps working unchanged via
// the legacy branch, while the rich-summary path adds new behaviour
// (case 12b, 12c).
// ---------------------------------------------------------------------------
const COMPACTION_TOOL_NAME = "__compaction_summary";

function hasCompactionToolCall(m: any): boolean {
	if (!m || m.role !== "assistant") return false;
	const cs = m.content;
	if (!Array.isArray(cs)) return false;
	return cs.some((c: any) => c?.type === "toolCall" && c?.name === COMPACTION_TOOL_NAME);
}

function isCompactionToolResult(m: any): boolean {
	return m?.role === "toolResult" && (m as any).toolName === COMPACTION_TOOL_NAME;
}

function isLegacyTextCompaction(m: any): boolean {
	if (!m || m.role !== "assistant") return false;
	const t = extractText(m);
	return typeof t === "string" && t.startsWith("Context compacted");
}

/**
 * Parse "Context compacted from Xk tokens." back into a number. Coupled to
 * pi-coding-agent transcript format — see
 * `docs/design/compaction-e2e-rich-summary.md` §2.4 / §4 risk 1. Case (12c)
 * pins this as a regression sentinel.
 */
function parseTokensBeforeFromServerMarker(text: string): number | null {
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
 * Upgrade a server plain-text compaction marker in-place into a rich
 * synthetic carrying a `__compaction_summary` toolCall. Used by the
 * snapshot path on reload when no live rich synthetic exists yet.
 * `tokensAfter` / `reductionPct` stay null; trigger defaults to "manual".
 */
function upgradeServerCompactionMarker(serverRow: any): any {
	const text = extractText(serverRow);
	const tokensBefore = parseTokensBeforeFromServerMarker(text);
	const payload = {
		schemaVersion: 1 as const,
		trigger: "manual" as const,
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
			: `compact_done_${tokensBefore ?? 0}`;
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

/**
 * Plain-text row test: assistant/user rows whose content has no toolCall and
 * which aren't themselves a toolResult. Snapshot dedup of these rows by
 * `(role, normalisedText)` defends against id-less / id-mismatched live
 * `message_end` rows that the id-only filter would let pass through, leaving
 * the snapshot's regenerated-id copy stacked on top (the new-tab dup bug).
 */
function isPlainTextRow(m: any): boolean {
	if (!m || m.role === "toolResult") return false;
	if (!Array.isArray(m.content)) return true;
	for (const c of m.content) {
		if (c?.type === "toolCall") return false;
	}
	return true;
}

function sortMessages(msgs: OrderedMessage[]): OrderedMessage[] {
	return msgs.slice().sort((a, b) => {
		if (a._order !== b._order) return a._order - b._order;
		return a._insertionTick - b._insertionTick;
	});
}

/**
 * Stamp a raw message-like input with reducer metadata. Preserves any
 * existing `_order`/`_origin`/`_insertionTick` if explicitly provided.
 */
function stamp(
	msg: any,
	origin: MessageOrigin,
	order: number,
	tick: number,
): OrderedMessage {
	return { ...msg, _order: order, _origin: origin, _insertionTick: tick };
}

/** When restoring messages from the server, reconstruct user-with-attachments. */
function enrichUserMessage(msg: any): any {
	if (msg.role !== "user" || !Array.isArray(msg.content)) return msg;
	const imageChunks = msg.content.filter((c: any) => c.type === "image" && c.data);
	if (imageChunks.length === 0) return msg;
	const attachments = imageChunks.map((img: any, i: number) => ({
		id: `restored_${i}`,
		type: "image" as const,
		fileName: `image-${i + 1}.png`,
		mimeType: img.mimeType || img.media_type || "image/png",
		size: img.data?.length || 0,
		content: img.data,
		preview: img.data,
	}));
	return { ...msg, role: "user-with-attachments", attachments };
}

/**
 * Apply a reducer action to the state and return a new state. Pure.
 */
export function reduce(state: ReducerState, action: Action): ReducerState {
	switch (action.type) {
		case "reset":
			return initialState();

		case "live-event": {
			const { frame, seq } = action;
			const tick = state.nextTick;
			const nextHighest = Math.max(state.highestSeq, seq);
			// frame is an event payload — we only care about message_end here;
			// other event types don't mutate the message list.
			if (frame?.type !== "message_end" || !frame.message) {
				return { ...state, highestSeq: nextHighest };
			}
			const incoming = frame.message;
			const role = incoming.role;
			let messages = state.messages.slice();

			// Drop any prior server entry with the same id (replace-by-id).
			if (typeof incoming.id === "string" && incoming.id.length > 0) {
				const idx = messages.findIndex((m) => m.id === incoming.id);
				if (idx !== -1) {
					messages.splice(idx, 1);
				}
			}

			// Reconcile user echoes against optimistic rows: id-match, then
			// text-fallback when the optimistic id matches `^optimistic_`.
			if (role === "user" || role === "user-with-attachments") {
				const idMatchIdx = messages.findIndex(
					(m) =>
						m._origin === "optimistic" &&
						typeof incoming.id === "string" &&
						m.id === incoming.id,
				);
				if (idMatchIdx !== -1) {
					messages.splice(idMatchIdx, 1);
				} else {
					const text = extractText(incoming);
					const textIdx = messages.findIndex(
						(m) =>
							m._origin === "optimistic" &&
							typeof m.id === "string" &&
							m.id.startsWith("optimistic_") &&
							extractText(m) === text,
					);
					if (textIdx !== -1) {
						messages.splice(textIdx, 1);
					}
				}
			}

			messages.push(stamp(incoming, "server", seq, tick));
			return {
				messages: sortMessages(messages),
				nextTick: tick + 1,
				highestSeq: nextHighest,
			};
		}

		case "snapshot": {
			const tick = state.nextTick;
			const enriched = action.messages.map(enrichUserMessage);
			// Two-way compaction dedup:
			//   (a) State has a rich synthetic (`__compaction_summary` toolCall) —
			//       drop the server's plain-text marker from this snapshot. Rich
			//       wins; the synthetic survives untouched. (Case 12b.)
			//   (b) State has a legacy text-form synthetic compaction marker —
			//       leave the snapshot alone; the synthetic is dropped below by the
			//       survivor pass so the server text wins. (Cases 12 and
			//       "snapshot drops trailing synthetic compaction marker".)
			//   (c) No synthetic at all (reload path) — upgrade the server's text
			//       marker in place into a rich synthetic so the renderer fires.
			//       tokensAfter / reductionPct stay null. (Case 12c.)
			const hasRichSyntheticCompaction = state.messages.some(
				(m) => m._origin === "synthetic" && hasCompactionToolCall(m),
			);
			const hasLegacySyntheticCompaction = state.messages.some(
				(m) => m._origin === "synthetic" && isLegacyTextCompaction(m)
					&& !hasCompactionToolCall(m),
			);
			let effectiveRows = enriched;
			if (hasRichSyntheticCompaction) {
				effectiveRows = enriched.filter((m: any) => !isLegacyTextCompaction(m));
			} else if (!hasLegacySyntheticCompaction) {
				effectiveRows = enriched.map((m: any) =>
					isLegacyTextCompaction(m) ? upgradeServerCompactionMarker(m) : m,
				);
			}
			const snapshotRows: OrderedMessage[] = effectiveRows.map((m, i) => {
				const explicit = (m as any)._order;
				const order = typeof explicit === "number" ? explicit : SNAPSHOT_ORDER_FLOOR + i;
				return stamp(m, "server", order, tick);
			});

			const serverIds = new Set<string>();
			// Equivalence sets keyed on toolCallId — the snapshot is authoritative
			// for any toolCall it contains, even when the live row landed without
			// a string id (e.g. mock-agent toolResult message_ends, real LLM
			// toolResult rows that omit `id`). Without these, an id-less live
			// row passes the survivor filter and the snapshot's id'd copy is
			// added on top → duplicate (Bug 2 / scenario 08 bg-3).
			const serverToolResultToolCallIds = new Set<string>();
			const serverAssistantToolCallIds = new Set<string>();
			for (const m of snapshotRows) {
				if (typeof m.id === "string" && m.id.length > 0) serverIds.add(m.id);
				if (m.role === "toolResult") {
					const tcid = (m as any).toolCallId;
					if (typeof tcid === "string" && tcid.length > 0) {
						serverToolResultToolCallIds.add(tcid);
					}
				} else if (m.role === "assistant" && Array.isArray((m as any).content)) {
					for (const c of (m as any).content) {
						if (c?.type === "toolCall" && typeof c.id === "string" && c.id.length > 0) {
							serverAssistantToolCallIds.add(c.id);
						}
					}
				}
			}
			// Plain-text equivalence keys: (role, normalisedText). See
			// `isPlainTextRow` — defends against id-less live `message_end`
			// plain-text assistant rows whose ids don't match the snapshot's
			// regenerated ids. Without this, a visibilitychange-triggered
			// resync (new-tab in same browser) duplicates each plain-text
			// assistant reply on every snapshot tick.
			// Multiset text-match: count how many snapshot rows carry each
			// `(role|text)` key, and decrement one per matched live row in the
			// survivor loop. The earlier Set-based variant collapsed N
			// identical-text live rows (e.g. "STREAM_BURST_DONE:1" repeated
			// across iterations) onto a single snapshot key, dropping all but
			// one of them. The multiset preserves cardinality: drop only the
			// number of live rows the snapshot legitimately represents; any
			// surplus falls through to the H3 `_order` guard. See the H3 design
			// doc on the goal.
			const serverPlainTextCounts = new Map<string, number>();
			for (const m of snapshotRows) {
				if (!isPlainTextRow(m)) continue;
				const t = normaliseText(extractText(m));
				if (t.length === 0) continue;
				const key = `${m.role}|${t}`;
				serverPlainTextCounts.set(key, (serverPlainTextCounts.get(key) ?? 0) + 1);
			}


			const serverHasCompactionMarker = snapshotRows.some((m) =>
				isLegacyTextCompaction(m),
			);
			const serverMaxOrder = snapshotRows.reduce(
				(acc, m) => (m._order > acc ? m._order : acc),
				Number.NEGATIVE_INFINITY,
			);

			// Survivors: client-side rows that the snapshot doesn't already represent.
			const survivors: OrderedMessage[] = [];
			for (const m of state.messages) {
				if (m._origin === "server") {
					// 1) Identity-based drops (structural, correct).
					// Live-event server rows: drop if snapshot has matching id.
					if (typeof m.id === "string" && serverIds.has(m.id)) continue;
					// Drop id-less (or synthetic-id'd) live rows whose
					// toolCallId-equivalent is represented in the snapshot.
					// Server snapshot is authoritative for any toolCall it contains.
					if (m.role === "toolResult") {
						const tcid = (m as any).toolCallId;
						if (typeof tcid === "string" && serverToolResultToolCallIds.has(tcid)) continue;
					} else if (m.role === "assistant" && Array.isArray((m as any).content)) {
						const hasMatchingToolCall = (m as any).content.some(
							(c: any) =>
								c?.type === "toolCall" &&
								typeof c.id === "string" &&
								serverAssistantToolCallIds.has(c.id),
						);
						if (hasMatchingToolCall) continue;
					}
					// 2) Multiset plain-text dedup — drop id-less / id-mismatched
					// live rows up to the count the snapshot carries for each
					// `(role|text)` key. Surplus live rows (count exhausted) fall
					// through to the H3 guard below. The earlier Set-based variant
					// collapsed N identical-text live rows (e.g.
					// `STREAM_BURST_DONE:1` repeated across iterations) onto a
					// single snapshot key, dropping all but one of them — the
					// multiset preserves cardinality. Skipped for
					// toolCall/toolResult rows handled above.
					if (isPlainTextRow(m)) {
						const t = normaliseText(extractText(m));
						if (t.length > 0) {
							const key = `${m.role}|${t}`;
							const remaining = serverPlainTextCounts.get(key) ?? 0;
							if (remaining > 0) {
								serverPlainTextCounts.set(key, remaining - 1);
								continue;
							}
						}
					}
					// 3) Structural invariant (H3 fix). A LIVE server row (positive
					// `_order` = monotonic server seq) stamped after the snapshot
					// was taken is by definition newer than the snapshot. When
					// the snapshot does NOT represent the live row (no id-match,
					// no toolCall-equivalence match, no remaining text-match
					// budget), the live row MUST survive. Without this guard a
					// stale `.jsonl`-backed snapshot strips it (the core H3 race).
					// Scoped to `_order > 0` so the guard does NOT fire for
					// prior-snapshot rows that also carry `_origin: "server"` but
					// live in the negative-order range. See the H3 design doc.
					if (m._order > 0 && m._order > serverMaxOrder) {
						survivors.push(m);
						continue;
					}
					// 4) Prior-snapshot artifacts (`_order <= 0`, server-origin)
					// must NOT survive a fresh snapshot that doesn't represent
					// them. Otherwise an in-flight `message_update` row spliced
					// into snapshot N persists forever after the server clears
					// `latestMessageUpdate` (e.g. mock-agent `_streamChunkedText`
					// with `omitFinalEnd:true`, or a real LLM that abandons partial
					// text to pivot to a tool_use). The new snapshot is the
					// authoritative point-in-time read; previous-snapshot rows that
					// fail every dedup check above are stale and must be dropped.
					if (m._order <= 0) {
						continue;
					}
					// Live row (`_order > 0`) within the snapshot's range — survive.
					survivors.push(m);
					continue;
				}
				if (m._origin === "optimistic") {
					// Optimistic prompts/steers always survive — server echo will
					// reconcile via id/text on a later live-event.
					if (typeof m.id === "string" && serverIds.has(m.id)) continue;
					survivors.push(m);
					continue;
				}
				if (m._origin === "synthetic") {
					if (typeof m.id === "string" && serverIds.has(m.id)) continue;
					// Drop legacy text-form synthetic compaction marker when the
					// server's plain-text marker is present in this snapshot.
					// The rich-form synthetic survives — the snapshot path above
					// has already removed the redundant server text row.
					if (
						serverHasCompactionMarker
						&& isLegacyTextCompaction(m)
						&& !hasCompactionToolCall(m)
						&& !isCompactionToolResult(m)
					) {
						continue;
					}
					survivors.push(m);
					continue;
				}
				if (m._origin === "permission") {
					if (typeof m.id === "string" && serverIds.has(m.id)) continue;
					// Permission cards survive iff no snapshot row's _order > card._order.
					if (serverMaxOrder > m._order) continue;
					survivors.push(m);
					continue;
				}
				survivors.push(m);
			}

			const merged = [...snapshotRows, ...survivors];
			// highestSeq tracks live seqs only — snapshots are negative; keep prior.
			const positiveMax = merged.reduce(
				(acc, m) => (m._order > 0 && m._order > acc ? m._order : acc),
				state.highestSeq,
			);
			return {
				messages: sortMessages(merged),
				nextTick: tick + 1,
				highestSeq: positiveMax,
			};
		}

		case "replace-messages": {
			const tick = state.nextTick;
			const enriched = action.messages.map(enrichUserMessage);
			const rows: OrderedMessage[] = enriched.map((m, i) => {
				const explicit = (m as any)._order;
				const order = typeof explicit === "number" ? explicit : SNAPSHOT_ORDER_FLOOR + i;
				return stamp(m, "server", order, tick);
			});
			const positiveMax = rows.reduce(
				(acc, m) => (m._order > 0 && m._order > acc ? m._order : acc),
				0,
			);
			return {
				messages: sortMessages(rows),
				nextTick: tick + 1,
				highestSeq: positiveMax,
			};
		}

		case "optimistic-prompt":
		case "optimistic-steer": {
			const tick = state.nextTick;
			const order = OPTIMISTIC_ORDER_BASE + tick;
			const messages = [
				...state.messages,
				stamp(action.message, "optimistic", order, tick),
			];
			return {
				messages: sortMessages(messages),
				nextTick: tick + 1,
				highestSeq: state.highestSeq,
			};
		}

		case "permission-needed": {
			const tick = state.nextTick;
			// If server stamps seq, use it. Otherwise fall back to a sentinel
			// just above highestSeq so the card lands at the tail.
			const order =
				typeof action.seq === "number"
					? action.seq
					: state.highestSeq + 0.25;
			const messages = [
				...state.messages,
				stamp(action.card, "permission", order, tick),
			];
			const nextHighest =
				typeof action.seq === "number"
					? Math.max(state.highestSeq, action.seq)
					: state.highestSeq;
			return {
				messages: sortMessages(messages),
				nextTick: tick + 1,
				highestSeq: nextHighest,
			};
		}

		case "permission-resolved":
		case "deny-permission-filter": {
			const messages = state.messages.filter((m) => m.id !== action.messageId);
			return { ...state, messages };
		}

		case "compaction-placeholder": {
			const tick = state.nextTick;
			const order = state.highestSeq + 0.5;
			const messages = state.messages.filter((m) => m.id !== "compacting_placeholder");
			messages.push(stamp(action.message, "synthetic", order, tick));
			return {
				messages: sortMessages(messages),
				nextTick: tick + 1,
				highestSeq: state.highestSeq,
			};
		}

		case "compaction-result": {
			const tick = state.nextTick;
			const order = state.highestSeq + 0.5;
			const messages = state.messages.filter(
				(m) => m.id !== "compacting_placeholder",
			);
			messages.push(stamp(action.message, "synthetic", order, tick));
			if (action.toolResult) {
				messages.push(
					stamp(action.toolResult, "synthetic", order + 0.001, tick + 1),
				);
			}
			return {
				messages: sortMessages(messages),
				nextTick: tick + (action.toolResult ? 2 : 1),
				highestSeq: state.highestSeq,
			};
		}

		case "system-notification": {
			const tick = state.nextTick;
			const order = state.highestSeq + 0.5;
			const messages = [
				...state.messages,
				stamp(action.message, "synthetic", order, tick),
			];
			return {
				messages: sortMessages(messages),
				nextTick: tick + 1,
				highestSeq: state.highestSeq,
			};
		}

		case "error": {
			const tick = state.nextTick;
			const order = state.highestSeq + 0.5;
			const messages = [
				...state.messages,
				stamp(action.message, "synthetic", order, tick),
			];
			return {
				messages: sortMessages(messages),
				nextTick: tick + 1,
				highestSeq: state.highestSeq,
			};
		}
	}
}

/** Render-key helper. Stable across reorders thanks to (origin, order, tick). */
export function keyFor(m: OrderedMessage, group?: string): string {
	const id = typeof m.id === "string" && m.id.length > 0
		? m.id
		: `synth:${m._origin}:${m._order}:${m._insertionTick}`;
	return group ? `${group}:${id}` : id;
}
