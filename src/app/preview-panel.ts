import { gatewayFetch } from "./api.js";
import { state, renderApp, activeSessionId } from "./state.js";

let pollTimer: ReturnType<typeof setInterval> | null = null;
let lastMtime = 0;
let lastMode: "inline" | "file" = "inline";

/** Start polling preview-{sessionId}.html for changes. */
export function startPreviewPolling(): void {
	if (pollTimer) return;
	lastMtime = 0;
	lastMode = "inline";
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
	lastMode = "inline";
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
		const mode: "inline" | "file" = data.kind === "file" ? "file" : "inline";
		const mtime: number = typeof data.mtime === "number" ? data.mtime : 0;
		const modeChanged = mode !== lastMode;
		const mtimeChanged = mtime && mtime !== lastMtime;
		if (modeChanged || mtimeChanged) {
			lastMode = mode;
			if (mtime) lastMtime = mtime;
			state.previewPanelMode = mode;
			state.previewPanelMtime = mtime;
			if (mode === "inline" && typeof data.html === "string") {
				state.previewPanelHtml = data.html;
			} else if (mode === "file") {
				// Cleared so a subsequent flip back to inline doesn't show stale.
				state.previewPanelHtml = "";
			}
			renderApp();
		}
	} catch {
		// ignore fetch errors
	}
}
