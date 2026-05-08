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
