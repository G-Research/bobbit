import { state, renderApp, activeSessionId } from "./state.js";

// WP-E: SSE subscription to per-session preview mount events.
// The gateway watches <stateDir>/preview/<sid>/ and emits a `preview-changed`
// event whenever the agent rewrites the entry file or any sibling asset.
// We bump `previewPanelMtime` to force the iframe to reload via `#mtime=<n>`.

let es: EventSource | null = null;
let currentSid: string | null = null;

/** Start an SSE subscription to preview-events for the given session. */
export function startPreviewSubscription(sessionId: string): void {
	stopPreviewSubscription();
	currentSid = sessionId;
	try {
		es = new EventSource(`/api/sessions/${encodeURIComponent(sessionId)}/preview-events`, {
			withCredentials: true,
		});
		es.addEventListener("preview-changed", (ev: MessageEvent) => {
			try {
				const data = JSON.parse(ev.data);
				if (typeof data?.entry === "string" && data.entry) {
					state.previewPanelEntry = data.entry;
				}
				if (typeof data?.mtime === "number") {
					state.previewPanelMtime = data.mtime;
				} else {
					state.previewPanelMtime = Date.now();
				}
				renderApp();
			} catch {
				/* ignore malformed events */
			}
		});
		es.onerror = () => {
			// EventSource auto-reconnects; nothing to do here.
		};
	} catch {
		es = null;
	}
}

/** Tear down the current SSE subscription. */
export function stopPreviewSubscription(): void {
	if (es) {
		try { es.close(); } catch { /* noop */ }
		es = null;
	}
	currentSid = null;
}

// --- Backwards-compat shims for legacy call sites ---
//
// session-manager.ts still imports `startPreviewPolling` / `stopPreviewPolling`
// from this module. Re-export them as aliases for the SSE start/stop so we
// don't have to touch session-manager (constraint: minimal diff).

export function startPreviewPolling(): void {
	const sid = activeSessionId();
	if (!sid) return;
	if (currentSid === sid && es) return;
	startPreviewSubscription(sid);
}

export function stopPreviewPolling(): void {
	stopPreviewSubscription();
}

