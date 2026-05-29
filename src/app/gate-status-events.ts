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
