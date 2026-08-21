import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Host-owned loop controls for one exact notification-triggered staff turn.
 * These values are never accepted from prompts, notification envelopes, browser
 * frames, or request bodies.
 */
export interface StaffNotificationTurnContext {
	readonly sessionId: string;
	readonly projectId: string;
	readonly staffId: string;
	readonly triggerId: string;
	readonly notificationId: string;
	readonly rootCorrelationId: string;
	readonly causationDepth: number;
	readonly lifecycleGeneration: number;
}

export const MAX_NOTIFICATION_CAUSATION_DEPTH = 8;
/** A delivered wake increments the source row before binding its staff turn. */
export const MAX_STAFF_NOTIFICATION_TURN_DEPTH = MAX_NOTIFICATION_CAUSATION_DEPTH + 1;

const requestContext = new AsyncLocalStorage<StaffNotificationTurnContext>();

export function freezeStaffNotificationTurnContext(
	context: StaffNotificationTurnContext,
): StaffNotificationTurnContext {
	return Object.freeze({ ...context });
}

/** Bind an authenticated server mutation to the exact staff turn that caused it. */
export function runWithStaffNotificationTurnContext<T>(
	context: StaffNotificationTurnContext,
	operation: () => T,
): T {
	return requestContext.run(context, operation);
}

/** Read-only delivery controls for the current server-owned mutation chain. */
export function currentStaffNotificationTurnContext(): StaffNotificationTurnContext | undefined {
	return requestContext.getStore();
}
