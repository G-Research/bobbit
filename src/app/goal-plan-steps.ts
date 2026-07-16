import type { Goal, GoalState } from "./state.js";
import {
	buildPlanSteps,
	type FormalPlanStep,
	type PlanStep,
	type SynthesisGoal,
} from "./plan-synthesis.js";

/**
 * Goal states considered "terminal" for the live-only Plan filter.
 * A child is "live" iff it is NOT archived AND its `state` is not in
 * this set — i.e. only todo / in-progress / blocked remain. Centralised
 * here so the renderer and the data helper share the exact same rule,
 * and so the test fixture can pin it without loading the DOM.
 */
const PLAN_TERMINAL_STATES: ReadonlySet<GoalState> = new Set<GoalState>(["complete", "shelved"]);

export function isLivePlanChild(g: { state?: string | null; archived?: boolean | null }): boolean {
	if (g.archived) return false;
	return !PLAN_TERMINAL_STATES.has((g.state ?? "todo") as GoalState);
}

/**
 * Compute plan steps for an arbitrary goal (top-level or nested).
 *
 * Default behaviour: include ALL direct children regardless of state
 * (archived/completed children remain visible in the plan). Pass
 * `liveOnly:true` to opt OUT of archived children at the call site —
 * defaults that hide data are the root cause of "archived siblings
 * vanish from the plan" regressions, so the helper default stays
 * inclusive and only explicit callers exclude.
 */
export function computePlanStepsForGoal(goal: Goal, allGoals: Goal[], opts?: { isNested?: boolean; liveOnly?: boolean }): PlanStep[] {
	const formalGate = goal.workflow?.gates.find(g => g.id === "execution");
	let formalSteps: FormalPlanStep[] | undefined = (formalGate as any)?.verify
		?.filter((v: any) => v.type === "subgoal" && v.subgoal)
		.map((v: any, idx: number) => ({
			planId: v.subgoal.planId,
			title: v.subgoal.title,
			spec: v.subgoal.spec,
			phase: typeof v.phase === "number" ? v.phase : idx,
			dependsOn: Array.isArray(v.subgoal.dependsOn) ? v.subgoal.dependsOn : undefined,
		}));
	const childSynthesis: SynthesisGoal[] = allGoals
		// pinned by tests/plan-archived-children.test.ts::computePlanStepsForGoal liveOnly filter
		// liveOnly EXCLUDES archived AND terminal-state (complete/shelved) children — only
		// in-progress / todo / blocked remain. See PLAN_TERMINAL_STATES.
		.filter(g => g.parentGoalId === goal.id && (!opts?.liveOnly || isLivePlanChild(g)))
		.map(g => ({
			id: g.id,
			parentGoalId: g.parentGoalId,
			spawnedFromPlanId: g.spawnedFromPlanId,
			createdAt: g.createdAt,
			state: g.state as any,
			archived: !!g.archived,
			paused: !!(g as any).paused,
			title: g.title,
			workflowId: g.workflowId,
			dependsOnPlanIds: g.dependsOnPlanIds,
		}));
	// Guard against inherited parent-workflow snapshots rendering phantom
	// plan steps. At nested depth, formalSteps only count if at least one
	// own child resolves them — otherwise we're seeing an inherited echo.
	if (opts?.isNested && formalSteps && formalSteps.length > 0) {
		const formalPlanIds = new Set(formalSteps.map(s => s.planId));
		const anyResolved = childSynthesis.some(c => c.spawnedFromPlanId && formalPlanIds.has(c.spawnedFromPlanId));
		if (!anyResolved) formalSteps = undefined;
	}
	// liveOnly: also drop formal execution-plan steps whose resolved child
	// is absent from the (already-filtered) childSynthesis. Without this,
	// archiving/completing a child would leave a phantom unresolved "todo"
	// formal node behind when the user has explicitly asked for live work
	// only. Default mode keeps ALL formal steps (including unresolved/
	// archived/completed) — the helper default stays inclusive.
	// pinned by tests/plan-archived-children.test.ts::formal execution plan liveOnly hides steps whose resolved child is archived or completed
	if (opts?.liveOnly && formalSteps && formalSteps.length > 0) {
		const liveChildPlanIds = new Set(
			childSynthesis
				.map(c => c.spawnedFromPlanId)
				.filter((p): p is string => typeof p === "string" && p.length > 0)
		);
		formalSteps = formalSteps.filter(s => liveChildPlanIds.has(s.planId));
		if (formalSteps.length === 0) formalSteps = undefined;
	}
	return buildPlanSteps({ formalSteps, childGoals: childSynthesis });
}
