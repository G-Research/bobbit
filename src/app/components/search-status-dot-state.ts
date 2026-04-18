// Pure state machine for <search-status-dot>.  Kept in a lit-free module so
// unit tests can import it without pulling in the entire UI tree (and its
// transitive CSS imports).

export type IndexPhase = "rebuild" | "incremental";

export interface IndexProgressEvent {
	type: "index:progress";
	projectId: string;
	phase: IndexPhase;
	total: number;
	completed: number;
	backlog: number;
}

export interface IndexCompleteEvent {
	type: "index:complete";
	projectId: string;
	phase: IndexPhase;
	durationMs: number;
	rowsWritten: number;
}

export interface IndexErrorEvent {
	type: "index:error";
	projectId: string;
	message: string;
	recoverable: boolean;
}

export type IndexEvent = IndexProgressEvent | IndexCompleteEvent | IndexErrorEvent;

export type DotState =
	| { kind: "idle" }
	| { kind: "indexing"; completed: number; total: number; backlog: number; phase: IndexPhase }
	| { kind: "error"; message: string; recoverable: boolean };

export const INDEX_EVENT_NAME = "bobbit-index-event";

/**
 * Derive the next dot state from the previous state + an incoming index event.
 *
 * Rules (see design §8 "Backlog threshold"):
 *   - index:error       \u2192 red (error) state, regardless of previous.
 *   - index:complete    \u2192 idle.
 *   - index:progress    \u2192 yellow (indexing) iff phase === "rebuild" OR backlog > 50;
 *                         otherwise falls back to idle (but preserves an existing
 *                         error state so small background pings don't silently
 *                         clear a broken store).
 */
export function nextDotState(prev: DotState, event: IndexEvent): DotState {
	if (event.type === "index:error") {
		return { kind: "error", message: event.message, recoverable: event.recoverable };
	}
	if (event.type === "index:complete") {
		return { kind: "idle" };
	}
	const isRebuild = event.phase === "rebuild";
	const busy = isRebuild || event.backlog > 50;
	if (!busy) {
		return prev.kind === "error" ? prev : { kind: "idle" };
	}
	return {
		kind: "indexing",
		completed: event.completed,
		total: event.total,
		backlog: event.backlog,
		phase: event.phase,
	};
}
