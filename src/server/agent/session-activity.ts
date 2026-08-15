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
	pendingBoundaries: Map<string, SessionPromptActivityBoundary>;
}

export interface SessionPromptActivityBoundary {
	/** Unique identity of one RPC dispatch attempt, never a durable queue-row id. */
	readonly attemptId: string;
	/** Exact attribution installation that created this token, when installed. */
	readonly owner?: object;
	state: "pending" | "committed" | "cancelled";
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
	const previous = attribution.get(session as object);
	if (previous) cancelPendingBoundaries(previous);
	attribution.set(session as object, {
		store,
		now: opts.now ?? Date.now,
		suppressUntilPrompt: opts.suppressUntilPrompt === true,
		pendingBoundaries: new Map(),
	});
}

/**
 * Cancel every still-pending dispatch transaction for this exact session
 * object. This deliberately changes neither restore quarantine nor author
 * correlation: replacement owners use it before stopping the old bridge so a
 * late acknowledgement cannot write activity through stale object state.
 */
export function cancelPendingSessionPromptActivity(session: ActivitySession): void {
	const state = attribution.get(session as object);
	if (state) cancelPendingBoundaries(state);
}

/** Re-enter the restore-only quarantine for an in-place bridge replacement. */
export function suppressSessionActivityUntilPrompt(session: ActivitySession): void {
	const state = attribution.get(session as object);
	if (!state) return;
	state.suppressUntilPrompt = true;
	// RPC acknowledgements from the replaced bridge are no longer authoritative.
	cancelPendingSessionPromptActivity(session);
}

/**
 * Start an origin-correlated prompt boundary without changing activity.
 * `attemptId` identifies one RPC invocation; durable queue ownership must stay
 * separate so a redrain can never alias an older asynchronous callback.
 */
export function beginSessionPromptActivity(
	session: ActivitySession,
	attemptId: string,
): SessionPromptActivityBoundary {
	const state = attribution.get(session as object);
	const previous = state?.pendingBoundaries.get(attemptId);
	if (previous) previous.state = "cancelled";
	const boundary: SessionPromptActivityBoundary = {
		attemptId,
		...(state ? { owner: state } : {}),
		state: "pending",
	};
	state?.pendingBoundaries.set(attemptId, boundary);
	return boundary;
}

/** Commit exactly one live dispatch attempt. Idempotent after an early echo. */
export function commitSessionPromptActivity(
	session: ActivitySession,
	boundary: SessionPromptActivityBoundary | undefined,
): boolean {
	if (!boundary) return false;
	if (boundary.state === "committed") return true;
	if (boundary.state !== "pending") return false;
	const state = attribution.get(session as object);
	if (!boundary.owner) {
		// Narrow test doubles may omit attribution. Preserve dispatch acceptance
		// semantics without fabricating a timestamp writer.
		if (state) {
			boundary.state = "cancelled";
			return false;
		}
		boundary.state = "committed";
		return true;
	}
	if (!state || boundary.owner !== state || state.pendingBoundaries.get(boundary.attemptId) !== boundary) {
		boundary.state = "cancelled";
		return false;
	}
	boundary.state = "committed";
	state.pendingBoundaries.delete(boundary.attemptId);
	state.suppressUntilPrompt = false;
	bump(session, state);
	return true;
}

/** Cancel exactly one attempt; late acknowledgement or echo becomes inert. */
export function cancelSessionPromptActivity(
	session: ActivitySession,
	boundary: SessionPromptActivityBoundary | undefined,
): boolean {
	if (!boundary || boundary.state !== "pending") return false;
	const state = attribution.get(session as object);
	boundary.state = "cancelled";
	if (state && boundary.owner === state && state.pendingBoundaries.get(boundary.attemptId) === boundary) {
		state.pendingBoundaries.delete(boundary.attemptId);
	}
	return true;
}

function cancelPendingBoundaries(state: AttributionState): void {
	for (const boundary of state.pendingBoundaries.values()) boundary.state = "cancelled";
	state.pendingBoundaries.clear();
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
	const candidate = event as {
		type?: unknown;
		willRetry?: unknown;
		message?: { role?: unknown };
	};
	switch (candidate.type) {
		case "message_update":
		case "message_end":
			// User projections are evidence for the exact prompt-boundary transaction,
			// not independent activity. Counting them here would let an uncommitted or
			// cancelled dispatch advance activity whenever restore quarantine is open,
			// and would double-count accepted prompts after their boundary commits.
			return candidate.message?.role !== "user"
				&& candidate.message?.role !== "user-with-attachments";
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
