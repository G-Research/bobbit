/**
 * Agent-finish beep preference — shared read/write helpers.
 *
 * The preference lives server-side (`playAgentFinishSound`) and is mirrored onto
 * `document.documentElement.dataset.playAgentFinishSound` (default ON; only an
 * explicit `false` opts out). `RemoteAgent.playNotificationBeep()` gates on that
 * dataset value. This module is the single place that flips it, so the header
 * `<bell-toggle>` and the Settings checkbox stay consistent.
 */
// Import from the dependency-free module (not ./api.js) so this helper — and
// the <bell-toggle> that imports it — don't drag the whole app-shell graph.
import { gatewayFetch } from "./gateway-fetch.js";

/** Window event dispatched whenever the beep preference changes (any surface). */
export const PLAY_FINISH_SOUND_CHANGED = "bobbit-play-finish-sound-changed";

/** Current effective state — default ON; only an explicit `false` opts out. */
export function isPlayFinishSoundEnabled(): boolean {
	if (typeof document === "undefined") return true;
	return document.documentElement.dataset.playAgentFinishSound !== "false";
}

/**
 * Flip + persist the beep preference. Applies the dataset synchronously (so the
 * `playNotificationBeep()` gate flips immediately, without waiting on the
 * `preferences_changed` broadcast), notifies in-page listeners, then persists.
 */
export async function setPlayFinishSoundEnabled(enabled: boolean): Promise<void> {
	if (typeof document !== "undefined") {
		document.documentElement.dataset.playAgentFinishSound = enabled ? "true" : "false";
	}
	if (typeof window !== "undefined") {
		window.dispatchEvent(new CustomEvent(PLAY_FINISH_SOUND_CHANGED, { detail: { enabled } }));
	}
	try {
		await gatewayFetch("/api/preferences", {
			method: "PUT",
			body: JSON.stringify({ playAgentFinishSound: enabled }),
		});
	} catch {
		// Non-fatal — the dataset is already applied optimistically.
	}
}
