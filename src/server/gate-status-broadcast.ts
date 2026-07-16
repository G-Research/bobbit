import type { GateStatus, GateStore } from "./agent/gate-store.js";
import type { GoalStore } from "./agent/goal-store.js";
import type { ServerMessage } from "./ws/protocol.js";

export type GateStatusChangedEvent = Extract<ServerMessage, { type: "gate_status_changed" }>;
export type GoalEventBroadcaster = (goalId: string, event: GateStatusChangedEvent) => void;

/**
 * Publish the canonical gate-status event consumed by goal WebSocket subscribers.
 * Keeping construction here prevents route and verification paths from drifting
 * from the declared ServerMessage payload.
 */
export function broadcastGateStatusChanged(
	broadcastToGoal: GoalEventBroadcaster,
	goalId: string,
	gateId: string,
	status: GateStatus,
): GateStatusChangedEvent {
	const event: GateStatusChangedEvent = { type: "gate_status_changed", goalId, gateId, status };
	broadcastToGoal(goalId, event);
	return event;
}

/** Wire GateStore mutations to the goal-list generation cache invalidation. */
export function wireGateStatusGenerationInvalidation(
	gateStore: Pick<GateStore, "onStatusChange">,
	goalStore: Pick<GoalStore, "bumpGeneration">,
): void {
	gateStore.onStatusChange = () => {
		goalStore.bumpGeneration();
	};
}
