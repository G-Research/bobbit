/**
 * Verification event bus — single source of truth for dispatching
 * `gate-verification-event` CustomEvents on `document`, with built-in
 * dedupe.
 *
 * Bug context: every `RemoteAgent` owns its own session WebSocket, and the
 * server's `broadcastToGoal` fan-out delivers each `gate_verification_*`
 * payload to every session WS in the goal. If each `RemoteAgent` (and the
 * `goal-dashboard.ts` viewer WS) dispatched the event independently on
 * `document`, listeners in `<verification-output-modal>` and
 * `<gate-verification-live>` would fire N times for a goal with N sessions.
 *
 * The bus dedupes by a composite key derived from `(type, signalId,
 * stepIndex, seq, …)`. The server now stamps a monotonic `seq` on every
 * gate_verification_* event so dedupe is exact even when payloads differ
 * only by timestamp. For older servers (no `seq`) we fall back to the
 * payload content (`stream`, `text`, `status`, etc.), which collapses
 * identical fan-out copies.
 *
 * The bus is intentionally module-scoped so all dispatch sources share one
 * dedupe window. A bounded FIFO (`MAX_SEEN`) keeps the seen-set from
 * growing unboundedly under long sessions.
 *
 * Listener-side components additionally maintain their own short dedupe
 * window (see `VerificationOutputModal` and `GateVerificationLive`) so
 * raw `document.dispatchEvent` calls (in unit tests, or extension code
 * that bypasses this bus) are also deduped.
 */

const MAX_SEEN = 5000;
const seen: Set<string> = new Set();
const seenOrder: string[] = [];

export function getVerificationEventKey(detail: any): string {
	if (!detail || typeof detail !== "object") return "";
	const type = String(detail.type ?? "");
	const signalId = String(detail.signalId ?? "");
	const stepIndex = detail.stepIndex ?? "";
	// Server-stamped monotonic counter — when present, this alone uniquely
	// identifies the event across the whole verification stream.
	if (detail.seq != null) {
		return `${type}|${signalId}|${stepIndex}|seq=${detail.seq}`;
	}
	// Fallback for events without seq: fold in the payload fields so
	// fan-out copies collapse to one key but distinct events stay distinct.
	const stream = detail.stream ?? "";
	const text = detail.text ?? "";
	const status = detail.status ?? "";
	const startedAt = detail.startedAt ?? "";
	const durationMs = detail.durationMs ?? "";
	const phase = detail.phase ?? "";
	const ts = detail.ts ?? "";
	return `${type}|${signalId}|${stepIndex}|${stream}|${status}|${startedAt}|${durationMs}|${phase}|${ts}|${text}`;
}

/** Returns true if this is the first time we've seen the key. */
export function markSeen(key: string): boolean {
	if (!key) return true;
	if (seen.has(key)) return false;
	seen.add(key);
	seenOrder.push(key);
	if (seenOrder.length > MAX_SEEN) {
		const evict = seenOrder.shift();
		if (evict !== undefined) seen.delete(evict);
	}
	return true;
}

/**
 * Dedupe-aware dispatcher. Only emits a `gate-verification-event`
 * CustomEvent on `document` the first time a particular event id is seen.
 *
 * Call this from per-session `RemoteAgent`s and the dashboard viewer WS in
 * place of `document.dispatchEvent(new CustomEvent("gate-verification-event", { detail: msg }))`.
 */
export function dispatchVerificationEvent(msg: any): void {
	if (!msg || typeof msg !== "object") return;
	const t = msg.type;
	if (typeof t !== "string" || !t.startsWith("gate_verification_")) return;
	const key = getVerificationEventKey(msg);
	if (!markSeen(key)) return;
	document.dispatchEvent(new CustomEvent("gate-verification-event", { detail: msg }));
}

/** Test/diagnostic helper — clears the dedupe window. */
export function _resetVerificationEventBus(): void {
	seen.clear();
	seenOrder.length = 0;
}
