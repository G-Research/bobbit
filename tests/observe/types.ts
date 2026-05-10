/**
 * Shared types for the observe harness.
 */

export interface MessageSnapshot {
	/** Position in state.messages after sort by (_order, _insertionTick). */
	stateIndex: number;
	role: string;
	_order: number;
	_insertionTick?: number;
	timestamp?: number;
	id?: string;
	/** Short fingerprint of content for cross-tick identity. */
	fingerprint: string;
}

export interface DomMessageRef {
	/** DOM source order (0 = first in transcript). */
	domIndex: number;
	tag: string; // user-message / assistant-message
	fingerprint: string;
}

export interface SessionState {
	id?: string;
	status?: string; // idle | streaming | preparing | error | …
	messages: MessageSnapshot[];
}

export interface TickRecord {
	t: number; // ms relative to run start
	wallMs: number;
	kind: "tick" | "before-action" | "after-action";
	action?: string;
	screenshot: string; // relative path
	domSnapshot: string; // relative path (json)
	stateSnapshot: string; // relative path (json)
	session?: SessionState;
	dom: DomMessageRef[];
	notes?: string[];
}

export interface RunMeta {
	startedAt: string;
	scenario: string;
	gatewayUrl: string;
	thresholds: { hangMs: number; tickMs: number };
	finishedAt?: string;
	exitReason?: string;
}

export interface Finding {
	kind: "hang" | "out-of-order";
	atMs: number;
	tickIndex: number;
	detail: string;
	evidence?: Record<string, unknown>;
}

export interface Timeline {
	meta: RunMeta;
	ticks: TickRecord[];
	findings: Finding[];
}
