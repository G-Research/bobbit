import type { GoalManager } from "./goal-manager.js";
import {
	isAwaitingExtensionConsentPauseReason,
	type AwaitingExtensionConsentPauseReason,
	type PersistedGoal,
} from "./goal-store.js";
import type { SessionManager } from "./session-manager.js";
import type { VerificationHarness } from "./verification-harness.js";

/** Dependencies for the canonical durable goal-pause lifecycle. */
export interface GoalPauseServiceDeps {
	getGoalManagerForGoal(goalId: string): Pick<GoalManager, "getGoalStore">;
	verificationHarness: Pick<VerificationHarness, "getActiveVerifications" | "cancelStaleVerifications">;
	sessionManager: Pick<SessionManager, "getAllSessionsRaw" | "abortSessionTurn">;
	broadcastGoalStateChanged(goalId: string): void;
}

export type ConsentPauseOutcome = "paused" | "already-paused" | "not-matching";

async function cancelAllVerifications(
	verificationHarness: GoalPauseServiceDeps["verificationHarness"],
	goalId: string,
): Promise<void> {
	for (const active of verificationHarness.getActiveVerifications(goalId)) {
		try {
			await verificationHarness.cancelStaleVerifications(goalId, active.gateId);
		} catch (err) {
			console.error(`[api] cancelAllVerifications: error cancelling verification for ${goalId}/${active.gateId}:`, err);
		}
	}
}

function abortStreamingSessions(
	sessionManager: GoalPauseServiceDeps["sessionManager"],
	pausedIds: Set<string>,
	callerSessionId: string | undefined,
): void {
	for (const session of sessionManager.getAllSessionsRaw()) {
		if (!session.goalId || !pausedIds.has(session.goalId)) continue;
		if (session.status !== "streaming" || session.id === callerSessionId) continue;
		sessionManager.abortSessionTurn(session.id).catch((err) => {
			console.warn(`[pause] abortSessionTurn failed for session=${session.id} goal=${session.goalId}:`, err);
		});
	}
}

/**
 * Pause selected goals using the existing operator/replan semantics.
 *
 * The route remains responsible for auth, target selection, and cascade
 * construction. Explicit operator/replan pauses clear an old consent reason:
 * that pause must never later be mistaken for a consent-owned pause.
 */
export async function executePauseForGoals(
	deps: GoalPauseServiceDeps,
	targets: PersistedGoal[],
	callerSessionId: string | undefined,
): Promise<number> {
	const pausedIds = new Set<string>(targets.map(goal => goal.id));
	let count = 0;
	for (const target of targets) {
		const store = deps.getGoalManagerForGoal(target.id).getGoalStore();
		const goal = store.get(target.id);
		if (!goal) continue;
		if (goal.paused) {
			if (goal.pauseReason) {
				store.update(goal.id, { pauseReason: undefined });
				deps.broadcastGoalStateChanged(goal.id);
			}
			continue;
		}
		// Provenance distinguishes an operator pause from pre-provenance legacy
		// dependency pauses when GoalManager restores persisted goals on boot.
		store.update(goal.id, { paused: true, pauseReason: undefined, pauseSource: "operator" });
		await cancelAllVerifications(deps.verificationHarness, goal.id);
		deps.broadcastGoalStateChanged(goal.id);
		count++;
	}
	abortStreamingSessions(deps.sessionManager, pausedIds, callerSessionId);
	return count;
}

/**
 * Durably attach an exact awaiting-consent reason and run the canonical pause
 * side effects. Replay is idempotent only for the same reason; a manual or
 * different pause is never relabelled as consent-owned.
 */
export async function pauseGoalAwaitingExtensionConsent(
	deps: GoalPauseServiceDeps,
	goalId: string,
	reason: AwaitingExtensionConsentPauseReason,
	callerSessionId?: string,
): Promise<ConsentPauseOutcome> {
	if (!isAwaitingExtensionConsentPauseReason(reason)) {
		throw new Error("Invalid awaiting-extension-consent pause reason");
	}
	const store = deps.getGoalManagerForGoal(goalId).getGoalStore();
	const goal = store.get(goalId);
	if (!goal) return "not-matching";
	const sameReason = goal.pauseReason?.kind === reason.kind
		&& goal.pauseReason.requestId === reason.requestId
		&& goal.pauseReason.createdAt === reason.createdAt;
	if (goal.paused && !sameReason) return "not-matching";
	if (!goal.paused) {
		await store.updateStrict(goalId, { paused: true, pauseReason: { ...reason } });
	}
	// Recovery may re-enter after the durable write but before these effects.
	await cancelAllVerifications(deps.verificationHarness, goalId);
	deps.broadcastGoalStateChanged(goalId);
	abortStreamingSessions(deps.sessionManager, new Set([goalId]), callerSessionId);
	return sameReason ? "already-paused" : "paused";
}
