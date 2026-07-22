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

import type { MessageAuthor } from "../shared/message-author.js";

export type MessageOrigin = "server" | "optimistic" | "synthetic" | "permission";

export interface OrderedMessage {
	[k: string]: unknown;
	id?: string;
	role: string;
	timestamp?: number;
	author?: MessageAuthor;
	/**
	 * Sort primary. Server-stamped (positive seq for live, negative for
	 * snapshot) or sentinel for optimistic/synthetic.
	 */
	_order: number;
	_origin: MessageOrigin;
	/** Sort secondary. Monotonic counter incremented on every reduce. */
	_insertionTick: number;
	/**
	 * Durable marker set by `settle-optimistic`: an `_origin:"optimistic"` row
	 * whose turn terminated WITHOUT a reconciling server user echo. Its `_order`
	 * has been re-stamped ONCE, out of the far-future tail sentinel into
	 * chronological position (`highestSeq + epsilon` captured at turn-end — just
	 * after the latest live message we had consumed). That value sorts AFTER any
	 * negative-order snapshot transcript, which is exactly right: a failed prompt
	 * was sent AFTER the persisted history, so it belongs after it. The marker is
	 * durable so the snapshot survivor pass keeps the row VISIBLE and at that
	 * settled position: it must NOT be consumed by the same-text dedup budget
	 * (that budget is for PENDING rows awaiting echo reconciliation) and must NOT
	 * be re-stamped into older history. The row stays `_origin:"optimistic"` with
	 * its `optimistic_` id so a late server echo can still reconcile it in place.
	 */
	_settled?: boolean;
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
	| { type: "permission-resolved"; messageId: string; status?: string; error?: string }
	| { type: "permission-status"; messageId?: string; toolName?: string; status: string; error?: string; actionable?: boolean; fromStatus?: string }
	| { type: "permission-reconciled"; current: any | null; reason?: string }
	| { type: "blocked-tool-call-placeholder"; message: any; seq?: number }
	| { type: "compaction-placeholder"; message: any }
	| { type: "compaction-result"; message: any; success: boolean; toolResult?: any }
	| { type: "system-notification"; message: any }
	| { type: "mutation-pending"; message: any }
	| { type: "mutation-update"; messageId: string; patch: Record<string, unknown> }
	| { type: "error"; message: any }
	| { type: "settle-optimistic" }
	| { type: "deny-permission-filter"; messageId: string }
	| { type: "replace-messages"; messages: any[] }
	| { type: "reset" };

export const SNAPSHOT_ORDER_FLOOR = -1_000_000_000;
const OPTIMISTIC_ORDER_BASE = Number.MAX_SAFE_INTEGER - 1_000_000_000;
/** Fractional nudge used to land a settled optimistic row just-after the latest
 *  consumed live seq (`highestSeq + epsilon`) without colliding with it. */
const SETTLE_EPSILON = 0.5;

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

/** Multiset dedup key for plain-text rows (snapshot↔live). Empty-text rows —
 *  id-less aborted/errored assistant message_ends — key on
 *  `${role}|EMPTY|${stopReason}` so the snapshot dedups them by multiset count
 *  instead of skipping them (the S7/S10 double-banner). Non-empty rows keep
 *  `${role}|${text}`, preserving the existing H3 cardinality contract. (WP2/RC1) */
function plainTextEquivKey(m: any): string {
	const t = normaliseText(extractText(m));
	if (t.length === 0) return `${m.role}|EMPTY|${(m as any).stopReason ?? ""}`;
	return `${m.role}|${t}`;
}

/** Reconstruct the server "modelText" from an optimistic row's originalText plus
 *  its `skillExpansions` (the expanded slash-skill body the server echoes back).
 *  Splice each expansion's `[start,end]` range right-to-left so earlier indices
 *  stay valid. Returns the raw text when there are no (valid) expansions. Lets the
 *  optimistic text-fallback match a `/foo` row against its `EXPANDED foo` echo so
 *  a skill-expanded prompt doesn't render twice. (WP2/RC1 — S17, unprefixed case) */
function reconstructModelText(m: any): string {
	const orig = extractText(m);
	const exps = (m as any).skillExpansions;
	if (!Array.isArray(exps) || exps.length === 0) return orig;
	const ranged = exps.filter((e: any) => Array.isArray(e?.range) && e.range.length === 2);
	ranged.sort((a: any, b: any) => b.range[0] - a.range[0]);
	let out = orig;
	for (const e of ranged) {
		const start = e.range[0];
		const end = e.range[1];
		if (typeof start === "number" && typeof end === "number" && start >= 0 && end <= out.length && start <= end) {
			out = out.slice(0, start) + (typeof e.expanded === "string" ? e.expanded : "") + out.slice(end);
		}
	}
	return out;
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

/** Stable id of the live in-progress / just-completed compaction synthetic. */
const COMPACTION_ACTIVE_ID = "compact_active";

/** Pull the sidecar `compactionId` off a rich `__compaction_summary` row.
 *  Persisted (reload-spliced) rows and the post-fix live `compact_active`
 *  card both carry it in `arguments.compactionId`; returns null otherwise. */
function compactionSummaryId(m: any): string | null {
	if (!m || m.role !== "assistant") return null;
	const cs = m.content;
	if (!Array.isArray(cs)) return null;
	for (const c of cs) {
		if (c?.type === "toolCall" && c?.name === COMPACTION_TOOL_NAME) {
			const cid = c?.arguments?.compactionId;
			return typeof cid === "string" && cid.length > 0 ? cid : null;
		}
	}
	return null;
}

function isLegacyTextCompaction(m: any): boolean {
	if (!m || m.role !== "assistant") return false;
	const t = extractText(m);
	return typeof t === "string" && t.startsWith("Context compacted");
}

/**
 * Shared ordering invariant (docs/design/fix-compaction-ordering.md §2, §4):
 * a live `compact_active` card retained in place of the persisted/snapshot
 * sidecar card for the SAME `compactionId` must inherit that persisted row's
 * canonical `_order` (and its paired toolResult's `_order`) — otherwise the
 * live card keeps a stale positive `highestSeq + 0.5` order and sorts AFTER
 * the negative-ordered preserved tail, diverging from reload ordering.
 *
 * Returns the persisted card / paired-toolResult `_order`s for `compactionId`,
 * EXCLUDING the live `compact_active` surface itself (id !== compact_active).
 * `null` when no persisted row is present. Pinned by message-reducer.test.ts
 * cases (12f)/(12g)/(12h)/(12i).
 */
function persistedCompactionAnchor(
	messages: OrderedMessage[],
	compactionId: string,
): { cardOrder: number | null; toolResultOrder: number | null } {
	let cardOrder: number | null = null;
	let toolResultOrder: number | null = null;
	const pairedToolCallId = `compaction-summary:${compactionId}`;
	for (const m of messages) {
		if (m.id !== COMPACTION_ACTIVE_ID && compactionSummaryId(m) === compactionId) {
			cardOrder = m._order;
		} else if (
			m.role === "toolResult"
			&& (m as any).toolCallId === pairedToolCallId
		) {
			toolResultOrder = m._order;
		}
	}
	return { cardOrder, toolResultOrder };
}

// `parseTokensBeforeFromServerMarker` and `upgradeServerCompactionMarker`
// removed. With the compaction sidecar (docs/design/persist-compaction-
// history.md §A), the server splices the rich synthetic into snapshots
// directly — the reload-path upgrade adapter is no longer reachable.
// Branches (a) and (b) of the snapshot dedup below still handle the
// legacy text-marker passes so the active-session live state isn't
// disturbed.

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

/** Reconstruct a `user-with-attachments` row from a user message's image
 *  content blocks. Used on BOTH the snapshot path and the live-event path so a
 *  server-authoritative `role:"user"` echo carrying `{type:"image"}` blocks
 *  renders identically live and after reload (WP1 / RC2 — the live/snapshot
 *  asymmetry was the root of the "image heals only on reload" symptom). */
export function enrichUserMessage(msg: any): any {
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

const ACTIVE_PERMISSION_STATUSES = new Set(["active", "granting"]);

function permissionStatus(message: any): string {
	return typeof message?.status === "string" ? message.status : "active";
}

function isActionablePermission(message: any): boolean {
	return message?.role === "tool_permission_needed"
		&& message.actionable !== false
		&& ACTIVE_PERMISSION_STATUSES.has(permissionStatus(message));
}

function settlePermission(message: OrderedMessage, status: string, error?: string): OrderedMessage {
	return {
		...message,
		status,
		actionable: false,
		...(error ? { error } : {}),
	};
}

function samePermissionRequest(message: any, request: any): boolean {
	if (!message || !request) return false;
	if (typeof request.id === "string" && request.id && message.id === request.id) return true;
	const sameTool = typeof request.toolName === "string" && message.toolName === request.toolName;
	const sameGroup = typeof request.group === "string" ? message.group === request.group : true;
	return sameTool && sameGroup;
}

function containsToolCall(message: any, toolCallId: string): boolean {
	return !!message && message.role === "assistant" && Array.isArray(message.content)
		&& message.content.some((c: any) => c?.type === "toolCall" && c?.id === toolCallId);
}

function toolCallIds(message: any): string[] {
	return Array.isArray(message?.content)
		? message.content
			.filter((c: any) => c?.type === "toolCall" && typeof c.id === "string")
			.map((c: any) => c.id as string)
		: [];
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
			// Enrich on the LIVE path too (not just snapshots): a role:"user" echo
			// carrying image content blocks becomes user-with-attachments so it
			// renders without depending on the racy _pendingAttachments slot. No-op
			// for non-user / no-image / already-enriched rows. (WP1 / RC2)
			let incoming = enrichUserMessage(frame.message);
			// RC1/WP2: stamp a stable synthetic id on id-less server rows. pi
			// persists user/aborted/errored rows id-less (agent.js:255-259), so
			// without an id the reducer cannot replace-by-id or dedup an id-less
			// live row against its snapshot copy (the S7/S10 double "Request
			// aborted" banner). Distinct from the synth:tc: scheme
			// (streaming-message-id.ts) stamped upstream in remote-agent.ts BEFORE
			// the reducer, so a non-empty id (real or synth:tc) is never overwritten.
			if (typeof incoming.id !== "string" || incoming.id.length === 0) {
				incoming = { ...incoming, id: `synth:seq:${seq}` };
			}
			const role = incoming.role;
			let messages = state.messages.slice();

			// Permission blocking freezes the in-flight assistant tool-use row as a
			// synthetic placeholder. If the matching live message_end arrives later,
			// replace that placeholder instead of rendering the same tool calls twice
			// until the next snapshot/reload reconciles them.
			if (role === "assistant") {
				const ids = toolCallIds(incoming);
				if (ids.length > 0) {
					const before = messages.length;
					messages = messages.filter((m: any) => !(m._permissionBlocked === true && ids.some((id) => containsToolCall(m, id))));
					if (messages.length !== before) incoming = { ...incoming, _permissionBlocked: true };
				}
			}

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
				const text = extractText(incoming);
				const idMatchIdx = messages.findIndex(
					(m) =>
						m._origin === "optimistic" &&
						typeof incoming.id === "string" &&
						m.id === incoming.id,
				);
				let reconciled = false;
				if (idMatchIdx !== -1) {
					messages.splice(idMatchIdx, 1);
					reconciled = true;
				} else {
					// Text-fallback: match either the raw optimistic text OR its
					// skill-expanded modelText (WP2/RC1 — S17). A slash-skill prompt
					// renders optimistically as "/foo" but the server echoes the
					// expanded body, so exact-text alone would leave a duplicate.
					const textIdx = messages.findIndex(
						(m) =>
							m._origin === "optimistic" &&
							typeof m.id === "string" &&
							m.id.startsWith("optimistic_") &&
							(extractText(m) === text || reconstructModelText(m) === text),
					);
					if (textIdx !== -1) {
						messages.splice(textIdx, 1);
						reconciled = true;
					}
				}
				// Step 4b (S18): if no optimistic matched, the echo may be replacing a
				// prior-SNAPSHOT user artifact of the same text — a snapshot that landed
				// in the optimistic→echo gap already deduped the optimistic, leaving
				// only the id-less snapshot copy. Consume that artifact so the live echo
				// replaces rather than re-stacks. id-less + _order<=0 scoping excludes
				// the id'd inflight-steer:* synthetic; the user-role scope means a
				// distinct new assistant same-text reply is never over-deduped.
				if (!reconciled) {
					const artifactIdx = messages.findIndex(
						(m) =>
							m._origin === "server" &&
							m._order <= 0 &&
							(typeof m.id !== "string" || m.id.length === 0) &&
							(m.role === "user" || m.role === "user-with-attachments") &&
							isPlainTextRow(m) &&
							extractText(m) === text,
					);
					if (artifactIdx !== -1) messages.splice(artifactIdx, 1);
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
			//       leave the snapshot alone; the synthetic is dropped below by
			//       the survivor pass so the server text wins. (Cases 12 and
			//       "snapshot drops trailing synthetic compaction marker".)
			//
			//   Former branch (c) — "upgrade the server's text marker in place
			//   into a rich synthetic" — is gone. The compaction sidecar
			//   (docs/design/persist-compaction-history.md §A) splices the rich
			//   synthetic into snapshots server-side; no client-side upgrade is
			//   needed and pi-coding-agent never produced the text marker we
			//   were upgrading from.
			const hasRichSyntheticCompaction = state.messages.some(
				(m) => m._origin === "synthetic" && hasCompactionToolCall(m),
			);
			let effectiveRows = enriched;
			if (hasRichSyntheticCompaction) {
				effectiveRows = enriched.filter((m: any) => !isLegacyTextCompaction(m));
			}
			// Live-session compaction dedup: when state holds the live
			// `compact_active` synthetic carrying a `compactionId`, the server's
			// post-compaction snapshot ALSO splices the persisted sidecar synthetic
			// for the same compaction (under a different id = the compactionId).
			// Drop the snapshot's persisted assistant card AND its paired
			// toolResult so a single live card survives — the live card already
			// hosts the affordance via its compactionId, and reusing one DOM node
			// avoids a flicker/duplicate. On reload there is NO live `compact_active`
			// in state, so this set is empty and the persisted synthetic survives
			// untouched (reload persistence preserved).
			const liveCompactionIds = new Set<string>();
			// Interim duplicate-card window (docs/design/fix-compaction-ordering.md
			// §4.1, HIGH finding): when a post-compaction snapshot arrives while the
			// live `compact_active` card is still in-progress and carries NO
			// `compactionId`, the cid-keyed dedup below can't see it, so BOTH the
			// persisted sidecar card and the live card would survive until the
			// deferred `compaction-result` fires. Track the in-progress live card so
			// we can anchor it to the persisted sidecar card's position instead.
			let hasInProgressLiveCard = false;
			// Compaction ids ALREADY established in prior state — persisted
			// (reload-spliced) sidecar cards from EARLIER compactions in this
			// session, plus any completed live card that gained a compactionId.
			// The interim heuristic below must NOT consume these: they belong to
			// older compactions, not the current pending one. Without this guard a
			// stale older card would be dropped and its `_order` mis-transferred
			// to an unrelated in-progress card (verifiable race; see §4.1).
			const establishedCompactionIds = new Set<string>();
			for (const m of state.messages) {
				if (m._origin === "synthetic" && m.id === COMPACTION_ACTIVE_ID) {
					const cid = compactionSummaryId(m);
					if (cid) liveCompactionIds.add(cid);
					else hasInProgressLiveCard = true;
				} else {
					const cid = compactionSummaryId(m);
					if (cid) establishedCompactionIds.add(cid);
				}
			}
			// Stamp the FULL row set FIRST so canonical snapshot `_order`s
			// (SNAPSHOT_ORDER_FLOOR + index) are computed over the unfiltered,
			// server-spliced ordering — the persisted compaction card keeps the
			// most-negative (prepended) position the server gave it. We then
			// partition out the persisted compaction rows that a live
			// `compact_active` card already represents, RECORDING their canonical
			// orders, instead of dropping them before stamping. The surviving
			// live card inherits those orders below so live ordering matches
			// reload (docs/design/fix-compaction-ordering.md §4.1).
			const stampedAll: OrderedMessage[] = effectiveRows.map((m, i) => {
				const explicit = (m as any)._order;
				const order = typeof explicit === "number" ? explicit : SNAPSHOT_ORDER_FLOOR + i;
				return stamp(m, "server", order, tick);
			});
			const compactionAnchors = new Map<
				string,
				{ cardOrder: number | null; toolResultOrder: number | null }
			>();
			// Anchor transferred to an IN-PROGRESS live `compact_active` card (no
			// compactionId yet) from the persisted sidecar card it duplicates.
			let inProgressAnchor: { cardOrder: number; toolResultOrder: number | null } | null = null;
			let snapshotRows: OrderedMessage[] = stampedAll;
			if (liveCompactionIds.size > 0) {
				for (const cid of liveCompactionIds) {
					compactionAnchors.set(cid, persistedCompactionAnchor(stampedAll, cid));
				}
				const pairedToolCallIds = new Set<string>();
				for (const id of liveCompactionIds) pairedToolCallIds.add(`compaction-summary:${id}`);
				snapshotRows = stampedAll.filter((m: any) => {
					const cid = compactionSummaryId(m);
					if (cid && liveCompactionIds.has(cid)) return false;
					if (
						m?.role === "toolResult"
						&& typeof (m as any).toolCallId === "string"
						&& pairedToolCallIds.has((m as any).toolCallId)
					) return false;
					return true;
				});
			} else if (hasInProgressLiveCard) {
				// Interim case: the live card has no compactionId, so we can't match
				// by cid. Treat the MOST RECENT persisted sidecar compaction card in
				// the snapshot (greatest `_order` among sidecar cards — the latest row
				// prepended by mergeCompactionSidecarIntoMessages) as the pending live
				// compaction anchor. Drop that card + its paired toolResult and stash
				// their canonical orders so the surviving in-progress live card sorts
				// before the preserved tail — exactly one card during the window.
				//
				// Verifiable race guard (review of PR #819): only consume a sidecar
				// card that is NOT already established in prior state. An older
				// compaction's persisted card (`establishedCompactionIds`) must not
				// be selected as the anchor for the current pending compaction — if
				// the new compaction's sidecar row has not been written yet, the
				// snapshot may carry ONLY the old card, and consuming it would
				// wrongly drop the old card and transfer its `_order` to the
				// unrelated in-progress card. When no NEW (unestablished) sidecar
				// card exists, leave the live card tail-anchored and keep the old
				// card untouched.
				let bestCard: OrderedMessage | null = null;
				for (const m of stampedAll) {
					if (m.id === COMPACTION_ACTIVE_ID) continue;
					const cid = compactionSummaryId(m);
					if (cid === null || establishedCompactionIds.has(cid)) continue;
					if (bestCard === null || m._order > bestCard._order) bestCard = m;
				}
				if (bestCard) {
					const bestCid = compactionSummaryId(bestCard) as string;
					const pairedToolCallId = `compaction-summary:${bestCid}`;
					let trOrder: number | null = null;
					for (const m of stampedAll) {
						if (m.role === "toolResult" && (m as any).toolCallId === pairedToolCallId) {
							trOrder = m._order;
						}
					}
					inProgressAnchor = { cardOrder: bestCard._order, toolResultOrder: trOrder };
					const dropCard = bestCard;
					snapshotRows = stampedAll.filter((m: any) => {
						if (m === dropCard) return false;
						if (m.role === "toolResult" && (m as any).toolCallId === pairedToolCallId) return false;
						return true;
					});
				}
			}

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
				// WP2/RC1: key empty-text rows too (S7/S10) via plainTextEquivKey.
				const key = plainTextEquivKey(m);
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
						// WP2/RC1: consume the multiset via plainTextEquivKey so id-less
						// EMPTY-text aborted/errored rows dedup against the snapshot's
						// copy (S7/S10) — previously skipped, leaving a double banner.
						const key = plainTextEquivKey(m);
						const remaining = serverPlainTextCounts.get(key) ?? 0;
						if (remaining > 0) {
							serverPlainTextCounts.set(key, remaining - 1);
							continue;
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
					// Optimistic prompts/steers normally survive — the server echo
					// reconciles via id/text on a later live-event.
					if (typeof m.id === "string" && serverIds.has(m.id)) continue;
					// A SETTLED optimistic row (turn terminated, never echoed) must
					// stay VISIBLE and keep its chronological position. Its settle
					// `_order` (`highestSeq + epsilon`) already sits AFTER any
					// negative-order snapshot transcript, so it correctly sorts after
					// the persisted history — the failed prompt was sent after that
					// transcript (reviewer issue 2: a `serverMaxOrder - epsilon`
					// re-stamp wrongly inserted it INTO older history). It must also
					// NOT be consumed by the same-text dedup budget below (reviewer
					// issue 1: that budget is for PENDING rows awaiting echo
					// reconciliation; a settled row sharing text with an old snapshot
					// row would otherwise be silently dropped, breaking the
					// stays-visible contract). Survive untouched. A late echo can
					// still reconcile it in place via the id-match drop above.
					if (m._settled === true) {
						survivors.push(m);
						continue;
					}
					// Step 4a (S18): dedup a same-text PENDING optimistic row against a
					// snapshot that arrived BEFORE the live echo. Consume the same
					// multiset budget the server-origin survivors use, so a snapshot
					// user row representing this prompt drops the optimistic instead of
					// leaving both. Multiset-counted → two genuinely-distinct same-text
					// prompts still both survive.
					if (isPlainTextRow(m)) {
						const key = plainTextEquivKey(m);
						const remaining = serverPlainTextCounts.get(key) ?? 0;
						if (remaining > 0) {
							serverPlainTextCounts.set(key, remaining - 1);
							continue;
						}
					}
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

			let merged = [...snapshotRows, ...survivors];
			// Transfer the displaced persisted card's canonical `_order` to the
			// surviving live `compact_active` card + its paired toolResult, so the
			// card+affordance sort BEFORE the negative-ordered preserved tail —
			// identical to reload (docs/design/fix-compaction-ordering.md §4.1;
			// pinned by (12f)/(12h)). Pure: replace via spread, never mutate the
			// prior-state survivor objects in place.
			if (compactionAnchors.size > 0) {
				const liveCard = merged.find(
					(m) => m._origin === "synthetic" && m.id === COMPACTION_ACTIVE_ID,
				);
				const liveCid = liveCard ? compactionSummaryId(liveCard) : null;
				const anchor = liveCid ? compactionAnchors.get(liveCid) : undefined;
				if (anchor && anchor.cardOrder !== null) {
					const cardOrder = anchor.cardOrder;
					const trOrder = anchor.toolResultOrder ?? cardOrder + 0.001;
					merged = merged.map((m) => {
						if (m._origin === "synthetic" && m.id === COMPACTION_ACTIVE_ID) {
							return { ...m, _order: cardOrder };
						}
						if (
							m.role === "toolResult"
							&& (m as any).toolCallId === `compaction-summary:${COMPACTION_ACTIVE_ID}`
						) {
							return { ...m, _order: trOrder };
						}
						return m;
					});
				}
			} else if (inProgressAnchor) {
				// Transfer the displaced persisted card's canonical (negative) order to
				// the surviving IN-PROGRESS live `compact_active` card. Its paired
				// toolResult usually doesn't exist yet (the in-progress placeholder is
				// a bare toolCall), so the toolResult branch is a no-op until the
				// terminal transition. This makes the interim window show exactly one
				// card, positioned before the preserved tail.
				const cardOrder = inProgressAnchor.cardOrder;
				const trOrder = inProgressAnchor.toolResultOrder ?? cardOrder + 0.001;
				merged = merged.map((m) => {
					if (m._origin === "synthetic" && m.id === COMPACTION_ACTIVE_ID) {
						return { ...m, _order: cardOrder };
					}
					if (
						m.role === "toolResult"
						&& (m as any).toolCallId === `compaction-summary:${COMPACTION_ACTIVE_ID}`
					) {
						return { ...m, _order: trOrder };
					}
					return m;
				});
			}
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
			const existingIdx = state.messages.findIndex((m: any) =>
				m.role === "tool_permission_needed"
				&& (
					(action.card.id && m.id === action.card.id)
					|| (
						typeof action.seq === "number"
						&& m._order === action.seq
						&& m.toolName === action.card.toolName
						&& m.group === action.card.group
					)
				),
			);
			let messages = state.messages.map((m) => {
				if (m.role !== "tool_permission_needed") return m;
				if (existingIdx !== -1 && m === state.messages[existingIdx]) return m;
				// Parallel calls for the same tool/group should stack under one pinned
				// decision instead of superseding each other.
				if (samePermissionRequest(m, action.card)) return m;
				return isActionablePermission(m) ? settlePermission(m, "superseded") : m;
			});
			const card = {
				...action.card,
				status: action.card.status ?? "active",
				actionable: action.card.actionable ?? true,
			};
			if (existingIdx !== -1) {
				messages = messages.map((m, idx) => {
					if (idx !== existingIdx) return m;
					const updated = { ...m, ...card, _order: m._order, _origin: m._origin, _insertionTick: m._insertionTick };
					if (!("error" in card)) delete (updated as any).error;
					return updated;
				});
			} else {
				messages = [
					...messages,
					stamp(card, "permission", order, tick),
				];
			}
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

		case "permission-resolved": {
			const status = action.status ?? "granted";
			const messages = state.messages.map((m) => m.id === action.messageId ? settlePermission(m, status, action.error) : m);
			return { ...state, messages };
		}

		case "deny-permission-filter": {
			const messages = state.messages.map((m) => m.id === action.messageId ? settlePermission(m, "denied") : m);
			return { ...state, messages };
		}

		case "permission-status": {
			const messages = state.messages.map((m: any) => {
				if (m.role !== "tool_permission_needed") return m;
				const idMatches = action.messageId && m.id === action.messageId;
				const toolMatches = !action.messageId && action.toolName && m.toolName === action.toolName && isActionablePermission(m);
				const fallbackActiveMatch = !action.messageId && !action.toolName && isActionablePermission(m);
				if (!idMatches && !toolMatches && !fallbackActiveMatch) return m;
				if (action.fromStatus && m.status !== action.fromStatus) return m;
				const actionable = action.actionable ?? ACTIVE_PERMISSION_STATUSES.has(action.status);
				const updated = { ...m, status: action.status, actionable, ...(action.error ? { error: action.error } : {}) };
				if (!action.error) delete (updated as any).error;
				return updated;
			});
			return { ...state, messages };
		}

		case "permission-reconciled": {
			const status = action.reason ?? "expired";
			const messages = state.messages.map((m: any) => {
				if (m.role !== "tool_permission_needed" || !isActionablePermission(m)) return m;
				if (action.current && samePermissionRequest(m, action.current)) return m;
				return settlePermission(m, status);
			});
			return { ...state, messages };
		}

		case "blocked-tool-call-placeholder": {
			const tick = state.nextTick;
			const ids = toolCallIds(action.message);
			if (ids.length === 0) return state;
			if (state.messages.some((m) => ids.some((id) => containsToolCall(m, id)))) return state;
			const order = typeof action.seq === "number" ? action.seq - 0.001 : state.highestSeq + 0.2;
			const message = {
				...action.message,
				id: action.message.id || `blocked_tool_${ids[0]}`,
				_permissionBlocked: true,
			};
			return {
				messages: sortMessages([...state.messages, stamp(message, "server", order, tick)]),
				nextTick: tick + 1,
				highestSeq: state.highestSeq,
			};
		}

		case "compaction-placeholder": {
			// Carries a RICH in-progress synthetic with stable id `compact_active`.
			// Filter both the legacy plaintext id and the stable id so reconnect
			// races / double-emission collapse to a single row. See
			// `docs/design/compaction-e2e-rich-summary.md` §7.4.
			const tick = state.nextTick;
			const order = state.highestSeq + 0.5;
			// Also drop the prior `compact_active` card's PAIRED synthetic
			// toolResult (`toolCallId === "compaction-summary:compact_active"`).
			// Filtering only the assistant card by id leaves a stale orphaned
			// toolResult behind when a subsequent compaction starts, which then
			// renders/anchors incorrectly. The `compaction-result` filter already
			// removes this toolResult; keep the two filters symmetric.
			const messages = state.messages.filter(
				(m) =>
					m.id !== "compacting_placeholder"
					&& m.id !== "compact_active"
					&& (m as any).toolCallId !== "compaction-summary:compact_active",
			);
			messages.push(stamp(action.message, "synthetic", order, tick));
			return {
				messages: sortMessages(messages),
				nextTick: tick + 1,
				highestSeq: state.highestSeq,
			};
		}

		case "compaction-result": {
			// Drop the legacy plaintext placeholder id AND any rich in-progress
			// row carrying the stable `compact_active` id (the in-place
			// transition target) AND its paired toolResult. Then push the new
			// rich row(s) under the same stable id. Single-DOM-identity
			// invariant pinned by message-reducer.test.ts case 12d.
			const tick = state.nextTick;
			// When the terminal live card carries a `compactionId`, also drop any
			// persisted (reload/refresh-spliced) sidecar synthetic + paired
			// toolResult for the SAME compaction. The server splices that card
			// into the post-compaction snapshot, which typically lands BEFORE this
			// in-place transition (the card has a min-visible-duration delay), so
			// the snapshot-case dedup can't yet see a compactionId on the live
			// in-progress placeholder. Reconciling here guarantees a single card.
			const resultCompactionId = compactionSummaryId(action.message);
			const dupToolCallId = resultCompactionId
				? `compaction-summary:${resultCompactionId}`
				: null;
			// Sub-case 2 (docs/design/fix-compaction-ordering.md §2.1, §4.2):
			// when the post-compaction snapshot landed BEFORE this deferred
			// terminal transition, a persisted sidecar card for `compactionId`
			// already sits in state at its canonical (negative, prepended)
			// snapshot order. The new `compact_active` card REPLACES it, so it
			// must inherit that anchor order — NOT `highestSeq + 0.5` (positive),
			// which would re-sink the card below the preserved tail. Falls back
			// to the tail anchor only when no persisted card is being displaced
			// (the genuinely-live case; corrected later when its snapshot lands).
			// Pinned by (12g)/(12h).
			const anchor = resultCompactionId
				? persistedCompactionAnchor(state.messages, resultCompactionId)
				: { cardOrder: null, toolResultOrder: null };
			// Fallback chain (docs/design/fix-compaction-ordering.md §4.2): when no
			// persisted sidecar card is being displaced — because the interim
			// snapshot already dropped it in favour of the in-progress live card and
			// transferred its negative order onto `compact_active` — inherit that
			// existing live card's `_order` so the deferred transition preserves the
			// negative anchor. Only the genuinely-live case (no snapshot yet) falls
			// back to the positive `highestSeq + 0.5` tail anchor, corrected later
			// when its snapshot lands.
			const existingActiveCard = state.messages.find(
				(m) => m._origin === "synthetic" && m.id === COMPACTION_ACTIVE_ID,
			);
			const existingActiveToolResult = state.messages.find(
				(m) =>
					m.role === "toolResult"
					&& (m as any).toolCallId === `compaction-summary:${COMPACTION_ACTIVE_ID}`,
			);
			const order =
				anchor.cardOrder ?? existingActiveCard?._order ?? state.highestSeq + 0.5;
			const toolResultOrder =
				anchor.toolResultOrder ?? existingActiveToolResult?._order ?? order + 0.001;
			const messages = state.messages.filter(
				(m) => {
					if (
						m.id === "compacting_placeholder"
						|| m.id === "compact_active"
						|| (m as any).toolCallId === "compaction-summary:compact_active"
					) return false;
					if (resultCompactionId) {
						if (compactionSummaryId(m) === resultCompactionId) return false;
						if (
							m.role === "toolResult"
							&& (m as any).toolCallId === dupToolCallId
						) return false;
					}
					return true;
				},
			);
			messages.push(stamp(action.message, "synthetic", order, tick));
			if (action.toolResult) {
				messages.push(
					stamp(action.toolResult, "synthetic", toolResultOrder, tick + 1),
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

		case "mutation-pending": {
			// Phase 5b: identical to system-notification — append a synthetic
			// row for the mutation-pending chat card. Dedupe by `requestId`:
			// a duplicate WS event for the same requestId should not produce
			// a second card.
			const incoming = action.message;
			const reqId = incoming?.requestId;
			if (reqId) {
				const exists = state.messages.some((m: any) => m?.role === "mutation-pending" && m?.requestId === reqId);
				if (exists) return state;
			}
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

		case "mutation-update": {
			// Patch an existing mutation-pending row in place (e.g. to flip
			// `decided: "approved"` after the WS `mutation_decided` arrives).
			const messages = state.messages.map((m: any) => {
				if (m?.id === action.messageId) return { ...m, ...action.patch };
				return m;
			});
			return { ...state, messages };
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

		case "settle-optimistic": {
			// Turn termination (error / agent_end). Any `_origin:"optimistic"`
			// row STILL pinned at the far-future tail sentinel
			// (`_order > OPTIMISTIC_ORDER_BASE`) was never reconciled by a server
			// user echo — the turn died before the prompt was persisted/echoed
			// (e.g. an immediate model 404). Left at the sentinel it sorts after
			// every server-ordered message and strands at the transcript bottom.
			//
			// Re-stamp it into chronological position: `highestSeq + epsilon`
			// (just after the latest live message we've consumed) and flag it
			// `_settled` so the snapshot survivor pass can keep it before later
			// snapshot tails. Keep `_origin:"optimistic"` + the `optimistic_` id
			// so a late server echo still reconciles in place (no duplicate).
			// Already-settled / already-reconciled rows are untouched, so this is
			// a pure no-op on the happy path and idempotent on re-dispatch.
			let changed = false;
			const settleOrder = state.highestSeq + SETTLE_EPSILON;
			const messages = state.messages.map((m) => {
				if (m._origin === "optimistic" && m._order > OPTIMISTIC_ORDER_BASE) {
					changed = true;
					return { ...m, _order: settleOrder, _settled: true };
				}
				return m;
			});
			if (!changed) return state;
			return { ...state, messages: sortMessages(messages) };
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
