export const GATE_STATUS_CLIENT_EVENT = "bobbit-gate-status-event";
export const GATE_STATUS_CACHE_UPDATED_EVENT_TYPE = "gate_status_cache_updated";
export const HUMAN_SIGNOFF_RESOLVED_EVENT_TYPE = "gate_verification_signoff_resolved";

const GATE_STATUS_REFRESH_EVENT_TYPES_LIST = [
	"gate_signal_received",
	"gate_status_changed",
	"gate_reset",
	"gate_verification_started",
	"gate_verification_phase_started",
	"gate_verification_step_started",
	"gate_verification_awaiting_human",
	"gate_verification_step_complete",
	"gate_verification_complete",
	HUMAN_SIGNOFF_RESOLVED_EVENT_TYPE,
] as const;

const GATE_DETAIL_REFRESH_EVENT_TYPES_LIST = [
	"gate_signal_received",
	"gate_status_changed",
	"gate_reset",
	"gate_verification_complete",
] as const;

export const GATE_STATUS_REFRESH_EVENT_TYPES = new Set<string>(GATE_STATUS_REFRESH_EVENT_TYPES_LIST);
export const GATE_DETAIL_REFRESH_EVENT_TYPES = new Set<string>(GATE_DETAIL_REFRESH_EVENT_TYPES_LIST);
export const ACTIVE_VERIFICATION_REFRESH_EVENT_TYPES = GATE_STATUS_REFRESH_EVENT_TYPES;

export interface GateStatusClientEvent {
	type: string;
	goalId: string;
	gateId?: string;
	signalId?: string;
	stepName?: string;
	decision?: "pass" | "fail";
}

export function dispatchGateStatusClientEvent(detail: GateStatusClientEvent): void {
	if (typeof window === "undefined" || typeof CustomEvent === "undefined") return;
	window.dispatchEvent(new CustomEvent(GATE_STATUS_CLIENT_EVENT, { detail }));
}

export function dispatchGateStatusCacheUpdated(goalId: string): void {
	dispatchGateStatusClientEvent({ type: GATE_STATUS_CACHE_UPDATED_EVENT_TYPE, goalId });
}

export function dispatchHumanSignoffResolved(detail: Omit<GateStatusClientEvent, "type"> & { decision: "pass" | "fail" }): void {
	dispatchGateStatusClientEvent({ ...detail, type: HUMAN_SIGNOFF_RESOLVED_EVENT_TYPE });
}

export function gateEventGoalId(event: unknown): string | null {
	return event && typeof event === "object" && typeof (event as { goalId?: unknown }).goalId === "string"
		? (event as { goalId: string }).goalId
		: null;
}

export function shouldRefreshGateStatusForEvent(event: unknown): boolean {
	return !!event && typeof event === "object"
		&& typeof (event as { type?: unknown }).type === "string"
		&& GATE_STATUS_REFRESH_EVENT_TYPES.has((event as { type: string }).type);
}

export function shouldRefreshGateDetailsForEvent(event: unknown): boolean {
	return !!event && typeof event === "object"
		&& typeof (event as { type?: unknown }).type === "string"
		&& GATE_DETAIL_REFRESH_EVENT_TYPES.has((event as { type: string }).type);
}

export function shouldRefreshActiveVerificationsForEvent(event: unknown): boolean {
	return !!event && typeof event === "object"
		&& typeof (event as { type?: unknown }).type === "string"
		&& ACTIVE_VERIFICATION_REFRESH_EVENT_TYPES.has((event as { type: string }).type);
}
