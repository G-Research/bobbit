/**
 * Phase 3 nested goals — freeze the parent workflow's execution.verify[]
 * when the team-lead signals the goal-plan gate.
 *
 * SUBGOALS-SPEC §3.6: once goal-plan is signalled, the execution gate's
 * verify[] is frozen. Further mutations route through the mutation
 * classifier (Phase 4 lands the classifier itself).
 *
 * Pure helper so the freeze invariant is unit-testable without the full
 * REST handler. The server.ts gate_signal route calls this directly.
 */

import type { PersistedGoal } from "./goal-store.js";
import type { Workflow } from "./workflow-store.js";

export interface FreezeResult {
	/** True when this signal should trigger a freeze (gateId=goal-plan + workflowId=parent + execution gate exists). */
	freeze: boolean;
	/** Updated workflow snapshot to persist on the goal record (only present when freeze=true). */
	workflow?: Workflow;
}

/**
 * Compute the freeze update for a gate-signal on a parent-workflow goal.
 *
 * Idempotent: re-signalling goal-plan when execution.metadata.frozen is
 * already "true" still returns the (identical) updated workflow — the
 * caller's `update` is then a no-op write that bumps updatedAt only.
 */
export function computePlanFreezeUpdate(
	goal: PersistedGoal,
	gateId: string,
): FreezeResult {
	if (gateId !== "goal-plan") return { freeze: false };
	if (goal.workflowId !== "parent") return { freeze: false };
	if (!goal.workflow) return { freeze: false };
	const executionGate = goal.workflow.gates.find(g => g.id === "execution");
	if (!executionGate) return { freeze: false };

	const updatedGate = {
		...executionGate,
		metadata: { ...(executionGate.metadata ?? {}), frozen: "true" },
	};
	const workflow: Workflow = {
		...goal.workflow,
		gates: goal.workflow.gates.map(g => g.id === "execution" ? updatedGate : g),
		updatedAt: Date.now(),
	};
	return { freeze: true, workflow };
}
