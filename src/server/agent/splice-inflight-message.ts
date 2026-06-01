/**
 * Splice an in-flight `message_update` payload into a snapshot messages
 * array returned by `session.rpcClient.getMessages()`. Pure helper, no
 * dependencies on the rest of the session-manager module graph so that
 * unit tests can import it without dragging in flexsearch / pi-coding-agent.
 *
 * Behaviour:
 *  - If `latest` is undefined or its `message` has empty content, returns
 *    the input array unchanged (same reference).
 *  - If `messages` already contains a row whose id matches `latest.id`,
 *    that row is replaced in place in a new array.
 *  - Otherwise the in-flight message is appended at the end of a new array.
 *
 * Used by every site that returns the snapshot to a client (WS
 * `get_messages`, `refreshAfterCompaction`, role-switch refresh,
 * `generateTitleForAnySession` live branch, `autoGenerateTitle`). See the
 * H3 design doc on the goal — the agent flushes to `.jsonl` only on
 * `message_end`, so without this splice a snapshot taken mid-stream drops
 * the in-flight assistant row entirely (the H3-D convergent-loss case).
 */
export function spliceInFlightMessage(
	messages: any[],
	latest?: { id?: string; message: any },
): any[] {
	if (!latest || !latest.message) return messages;
	const content = (latest.message as any).content;
	const hasContent =
		(typeof content === "string" && content.length > 0) ||
		(Array.isArray(content) && content.length > 0);
	if (!hasContent) return messages;
	if (latest.id && Array.isArray(messages)) {
		const idx = messages.findIndex((m: any) => m && m.id === latest.id);
		if (idx !== -1) {
			const next = messages.slice();
			next[idx] = latest.message;
			return next;
		}
	}
	return [...messages, latest.message];
}

/** Extract a user-message body as plain text (string or text-block array). */
function extractUserText(message: any): string {
	if (!message) return "";
	if (typeof message.content === "string") return message.content;
	if (Array.isArray(message.content)) {
		const block = message.content.find((c: any) => c?.type === "text");
		return block?.text ?? "";
	}
	return "";
}

/**
 * Splice synthetic user-role messages for every entry in the steer shadow
 * ledger (`session.inFlightSteerTexts`) that is NOT already represented as
 * a user message in the snapshot.
 *
 * Companion to `spliceInFlightMessage` (which handles in-flight assistant
 * `message_update`). Solves a steer-specific continuity race:
 *
 *   `_dispatchSteer()` removes the queue row and broadcasts the empty
 *   queue *before* awaiting `rpcClient.steer()`. The SDK only echoes the
 *   text back as `message_end(role:user)` after a roundtrip, and the
 *   agent only flushes that echo to `.jsonl` at that point. Between
 *   queue-removal and echo, a client `get_messages` (visibility resync,
 *   WS reconnect resume-fallback, second tab) sees a snapshot with
 *   neither the pill nor the transcript row — the steer text appears
 *   to vanish, only to reappear seconds later when the echo lands.
 *
 * The ledger is the in-process record of "steer texts the SDK has but
 * `.jsonl` doesn't yet". Splicing them into snapshot responses closes
 * the gap. Synthetic rows carry a stable id prefix `inflight-steer:` so
 * the client reducer can route them through the normal server-snapshot
 * dedup paths (multiset plain-text match against the real echo when a
 * later snapshot arrives, plus the `_origin: "server" && _order <= 0`
 * prior-snapshot drop for any leftover).
 *
 * Bounded by construction: the ledger only ever contains entries that
 * are paired with a future echo (which clears them) or an abort-drain
 * (which moves them back into `promptQueue`). It cannot grow without
 * bound.
 */
export function spliceInFlightSteers(
	messages: any[],
	inFlightSteerTexts?: string[],
): any[] {
	if (!Array.isArray(messages)) return messages;
	if (!inFlightSteerTexts || inFlightSteerTexts.length === 0) return messages;

	// Count every user-role plain text already present in the snapshot so we
	// don't double-up if the echo has already flushed to `.jsonl` by the time
	// this splice runs (and the ledger hasn't been cleared yet). MULTISET, not a
	// Set (S42): two identical-text steers must each splice a row. The old
	// Set + `add(text)` collapsed them — the second identical steer was skipped,
	// so a resync in the dispatch→echo window dropped one of two same-text pills.
	const presentCounts = new Map<string, number>();
	for (const m of messages) {
		if (!m) continue;
		if (m.role !== "user" && m.role !== "user-with-attachments") continue;
		const t = extractUserText(m);
		if (t) presentCounts.set(t, (presentCounts.get(t) ?? 0) + 1);
	}

	const additions: any[] = [];
	let i = 0;
	for (const text of inFlightSteerTexts) {
		if (!text) { i++; continue; }
		const remaining = presentCounts.get(text) ?? 0;
		if (remaining > 0) {
			// Already represented by a real snapshot row — consume one and skip.
			presentCounts.set(text, remaining - 1);
			i++;
			continue;
		}
		additions.push({
			// Stable, content-derived id so repeated `get_messages` calls during
			// the same dispatch→echo window produce the same synthetic row. The
			// real echo's id won't collide (agents use uuid-shaped ids). The index
			// prefix keeps two identical-text steers distinct.
			id: `inflight-steer:${i}:${text.slice(0, 32)}`,
			role: "user",
			content: [{ type: "text", text }],
			_inFlightSteer: true,
		});
		i++;
	}
	if (additions.length === 0) return messages;
	return [...messages, ...additions];
}
