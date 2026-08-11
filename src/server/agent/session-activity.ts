import type { PersistedSession } from "./session-store.js";

export interface ActivitySession {
	id: string;
	lastActivity: number;
}

export interface ActivityStore {
	/** Optional only for narrow event-pipeline test doubles; production SessionStore provides it. */
	get?(id: string): Pick<PersistedSession, "lastReadAt"> | undefined;
	update(id: string, updates: { lastActivity: number }): void;
}

interface AttributionState {
	store: ActivityStore;
	now: () => number;
	suppressUntilPrompt: boolean;
}

const attribution = new WeakMap<object, AttributionState>();

/**
 * Install the authoritative activity writer for one live session object.
 * Restored/rehydrated sessions remain quarantined until Bobbit dispatches a
 * new prompt; this is an origin boundary, not a timing assumption, so replay
 * frames arriving after switch_session's response are still restore-only.
 */
export function installSessionActivityAttribution(
	session: ActivitySession,
	store: ActivityStore,
	opts: { now?: () => number; suppressUntilPrompt?: boolean } = {},
): void {
	attribution.set(session as object, {
		store,
		now: opts.now ?? Date.now,
		suppressUntilPrompt: opts.suppressUntilPrompt === true,
	});
}

/** Re-enter the restore-only quarantine for an in-place bridge replacement. */
export function suppressSessionActivityUntilPrompt(session: ActivitySession): void {
	const state = attribution.get(session as object);
	if (state) state.suppressUntilPrompt = true;
}

/**
 * A prompt/steer dispatched by Bobbit is the authoritative boundary between
 * restore-only traffic and genuine new work. Record it immediately so a new
 * user-visible turn advances activity even before the first assistant frame.
 */
export function recordSessionPromptActivity(session: ActivitySession): boolean {
	const state = attribution.get(session as object);
	if (!state) return false;
	state.suppressUntilPrompt = false;
	return bump(session, state);
}

/** Record only meaningful RPC activity after the prompt boundary is open. */
export function recordSessionEventActivity(session: ActivitySession, event: unknown): boolean {
	const state = attribution.get(session as object);
	if (!state || state.suppressUntilPrompt || !isUserVisibleActivity(event)) return false;
	return bump(session, state);
}

/**
 * Genuine transcript/tool/terminal work. Lifecycle, status, history hydration,
 * model/thinking restoration, and retryable intermediate agent_end frames are
 * deliberately excluded.
 */
export function isUserVisibleActivity(event: unknown): boolean {
	if (!event || typeof event !== "object") return false;
	const candidate = event as { type?: unknown; willRetry?: unknown };
	switch (candidate.type) {
		case "message_update":
		case "message_end":
		case "tool_execution_start":
		case "tool_execution_end":
			return true;
		case "agent_end":
			return candidate.willRetry !== true;
		default:
			return false;
	}
}

function bump(session: ActivitySession, state: AttributionState): boolean {
	const lastReadAt = state.store.get?.(session.id)?.lastReadAt ?? 0;
	const next = Math.max(state.now(), session.lastActivity + 1, lastReadAt + 1);
	session.lastActivity = next;
	state.store.update(session.id, { lastActivity: next });
	return true;
}
