/**
 * Per-session preview-change event broadcaster.
 *
 * The mount endpoint (WP-D) emits `preview-changed` events here after every
 * successful write; the SSE handler (WP-B) subscribes per session and forwards
 * to listening browser tabs.
 *
 * Module-scoped EventEmitter map keyed by sessionId. Event payload is the
 * `MountResult` plus an `mtime` timestamp.
 */

import { EventEmitter } from "node:events";

export interface PreviewChangedEvent {
	entry: string;
	mtime: number;
	url?: string;
	path?: string;
	contentHash?: string;
	artifactId?: string;
}

const emitters = new Map<string, EventEmitter>();

function emitterFor(sessionId: string): EventEmitter {
	let e = emitters.get(sessionId);
	if (!e) {
		e = new EventEmitter();
		// SSE handlers may attach many listeners over a session's lifetime; lift cap.
		e.setMaxListeners(64);
		emitters.set(sessionId, e);
	}
	return e;
}

/** Fire a `preview-changed` event on the session's channel. */
export function broadcastPreviewChanged(sessionId: string, payload: PreviewChangedEvent): void {
	emitterFor(sessionId).emit("preview-changed", payload);
}

/** Subscribe to `preview-changed` events for a session. Returns unsubscribe. */
export function subscribePreviewChanged(
	sessionId: string,
	listener: (payload: PreviewChangedEvent) => void,
): () => void {
	const e = emitterFor(sessionId);
	e.on("preview-changed", listener);
	return () => {
		e.off("preview-changed", listener);
		// Cleanup empty emitters to avoid leaks across long-running gateways.
		if (e.listenerCount("preview-changed") === 0) {
			emitters.delete(sessionId);
		}
	};
}

/** Drop all listeners for a session (called on archive/cleanup). */
export function clearPreviewListeners(sessionId: string): void {
	const e = emitters.get(sessionId);
	if (e) {
		e.removeAllListeners();
		emitters.delete(sessionId);
	}
}
