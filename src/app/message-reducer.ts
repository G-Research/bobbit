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
	| { type: "compaction-result"; message: any; success: boolean }
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
			const snapshotRows: OrderedMessage[] = enriched.map((m, i) => {
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
			const serverHasCompactionMarker = snapshotRows.some((m) => {
				if (m.role !== "assistant") return false;
				const t = extractText(m);
				return typeof t === "string" && t.startsWith("Context compacted");
			});
			const serverMaxOrder = snapshotRows.reduce(
				(acc, m) => (m._order > acc ? m._order : acc),
				Number.NEGATIVE_INFINITY,
			);

			// Survivors: client-side rows that the snapshot doesn't already represent.
			const survivors: OrderedMessage[] = [];
			for (const m of state.messages) {
				if (m._origin === "server") {
					// Live-event server rows: drop if snapshot has matching id.
					if (typeof m.id === "string" && serverIds.has(m.id)) continue;
					// Defence in depth: also drop id-less (or synthetic-id'd) live
					// rows whose toolCallId-equivalent is represented in the snapshot.
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
					// Drop synthetic compaction marker when server has its own.
					if (m.role === "assistant" && serverHasCompactionMarker) {
						const t = extractText(m);
						if (typeof t === "string" && t.startsWith("Context compacted")) continue;
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
			return {
				messages: sortMessages(messages),
				nextTick: tick + 1,
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
