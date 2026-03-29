import { gatewayFetch } from "./api.js";
import { state, renderApp, activeSessionId } from "./state.js";

let pollTimer: ReturnType<typeof setInterval> | null = null;
let lastMtime = 0;

/** Start polling preview-{sessionId}.html for changes. */
export function startPreviewPolling(): void {
	if (pollTimer) return;
	lastMtime = 0;
	pollNow();
	pollTimer = setInterval(pollNow, 1000);
}

/** Stop polling. */
export function stopPreviewPolling(): void {
	if (pollTimer) {
		clearInterval(pollTimer);
		pollTimer = null;
	}
	lastMtime = 0;
}

async function pollNow(): Promise<void> {
	if (!state.isPreviewSession) {
		stopPreviewPolling();
		return;
	}
	try {
		const sessionId = activeSessionId();
		const qs = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
		const res = await gatewayFetch(`/api/preview${qs}`);
		if (!res.ok) return;
		const data = await res.json();
		if (data.mtime && data.mtime !== lastMtime && data.html) {
			lastMtime = data.mtime;
			state.previewPanelHtml = data.html;
			renderApp();
		}
	} catch {
		// ignore fetch errors
	}
}
