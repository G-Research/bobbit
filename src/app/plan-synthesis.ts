/**
 * Pure helper: synthesize "live plan" PlanStep records from a goal's
 * actual non-archived children when no formal plan exists, OR augment
 * a formal plan with orphan children that were spawned ad-hoc.
 *
 * Design intent (post-PR #409 user feedback): the Plan tab is a
 * powerful visualisation regardless of which workflow created the
 * goal. The original visibility predicate gated on the `goal-plan`
 * gate, so any goal on `general` / `feature` / `bug-fix` workflows
 * never showed a plan even when its team-lead clearly had a plan in
 * mind (e.g. "Brisket" coordinating v0.1 / v0.2 / v0.3 sub-goals).
 *
 * Approach: every goal that has children HAS an implicit plan \u2014 the
 * children themselves. Cluster children into phases by createdAt
 * timestamp gap (within `phaseClusterWindowMs`, default 60s, treat as
 * the same phase). The team-lead can refine via `goal_plan_propose`
 * if it wants explicit dependency edges; but as a default, batched
 * spawns (same turn) cluster into one phase, and sequentially-spawned
 * children land in successive phases.
 *
 * Living document: this is recomputed on every render from the live
 * goals array, so it reflects the current state of the tree as it
 * evolves.
 */

export interface PlanStepLike {
	type: "subgoal";
	name: string;
	phase?: number;
	subgoal?: {
		planId: string;
		title: string;
		spec?: string;
		workflowId?: string;
		suggestedRole?: string;
		childGoalId?: string;
		phase?: number;
		dependsOnPlanIds?: string[];
	};
}

export interface PlanSynthChildLike {
	id: string;
	title?: string;
	spec?: string;
	workflowId?: string;
	parentGoalId?: string;
	archived?: boolean;
	createdAt?: number;
	spawnedFromPlanId?: string;
}

export interface PlanSynthOptions {
	/** Children created within this many ms of each other are clustered
	 *  into the same phase. Default 60s \u2014 catches the common case where
	 *  a team-lead spawns N parallel children in one turn. */
	phaseClusterWindowMs?: number;
}

/** Cluster a list of children into phases by createdAt gap. The
 *  children must already be sorted ascending by createdAt. */
export function clusterChildrenIntoPhases(
	sortedChildren: PlanSynthChildLike[],
	windowMs: number,
): PlanSynthChildLike[][] {
	const phases: PlanSynthChildLike[][] = [];
	let currentPhase: PlanSynthChildLike[] = [];
	let lastTs = 0;
	for (const c of sortedChildren) {
		const ts = c.createdAt ?? 0;
		if (currentPhase.length === 0) {
			currentPhase.push(c);
		} else if (ts - lastTs <= windowMs) {
			currentPhase.push(c);
		} else {
			phases.push(currentPhase);
			currentPhase = [c];
		}
		lastTs = ts;
	}
	if (currentPhase.length > 0) phases.push(currentPhase);
	return phases;
}

/** Build a synthetic PlanStep for a single child. Synthetic planIds
 *  are prefixed `auto:` so they never collide with real planIds. */
function childToSyntheticStep(child: PlanSynthChildLike, phase: number): PlanStepLike {
	const planId = child.spawnedFromPlanId ?? `auto:${child.id}`;
	return {
		type: "subgoal",
		name: child.title || "(untitled)",
		phase,
		subgoal: {
			planId,
			title: child.title || "(untitled)",
			spec: child.spec || "",
			workflowId: child.workflowId,
			childGoalId: child.id,
			phase,
		},
	};
}

/** Synthesize plan steps from a goal's children when no formal plan
 *  exists. Returns [] if there are no non-archived children. */
export function synthesizePlanStepsFromChildren(
	goalId: string,
	goals: PlanSynthChildLike[],
	options: PlanSynthOptions = {},
): PlanStepLike[] {
	const windowMs = options.phaseClusterWindowMs ?? 60_000;
	const children = goals.filter(g => g.parentGoalId === goalId && !g.archived);
	if (children.length === 0) return [];
	const sorted = children.slice().sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
	const phases = clusterChildrenIntoPhases(sorted, windowMs);
	const steps: PlanStepLike[] = [];
	for (let i = 0; i < phases.length; i++) {
		for (const child of phases[i]) {
			steps.push(childToSyntheticStep(child, i + 1));
		}
	}
	return steps;
}

/** Compose the final Plan-tab step list. If the goal has formal plan
 *  steps (from `workflow.gates[execution].verify[]`), prefer those;
 *  but ALSO synthesize entries for orphan children that aren't tied
 *  to any formal planId, slotting them into a final phase past the
 *  highest formal phase so the user can see the full picture. If the
 *  goal has NO formal plan, synthesize entirely from children.
 *
 *  This is the single source of truth for "what does the Plan tab
 *  show?". It is the living-document core: every render recomputes
 *  from the current goals tree, so plan-evolution is automatic. */
export function buildPlanSteps(
	goalId: string,
	formalSteps: PlanStepLike[],
	goals: PlanSynthChildLike[],
	options: PlanSynthOptions = {},
): PlanStepLike[] {
	if (formalSteps.length === 0) {
		// No formal plan: pure synthesis.
		return synthesizePlanStepsFromChildren(goalId, goals, options);
	}

	// Formal plan exists; find any orphan children not tied to a formal
	// planId. These are ad-hoc spawns (e.g. via `goal_spawn_child`)
	// that aren't reflected in the snapshotted plan steps.
	const formalPlanIds = new Set(formalSteps.map(s => s.subgoal?.planId).filter((p): p is string => !!p));
	const orphanChildren = goals.filter(g =>
		g.parentGoalId === goalId &&
		!g.archived &&
		!formalPlanIds.has(g.spawnedFromPlanId ?? "")
	);
	if (orphanChildren.length === 0) {
		return formalSteps;
	}

	// Slot orphans into a phase past the highest formal phase, so the
	// formal DAG layout isn't disturbed.
	const maxFormalPhase = formalSteps.reduce((m, s) => {
		const p = (s.phase ?? s.subgoal?.phase ?? 0) | 0;
		return p > m ? p : m;
	}, 0);
	const sortedOrphans = orphanChildren.slice().sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
	const orphanPhases = clusterChildrenIntoPhases(sortedOrphans, options.phaseClusterWindowMs ?? 60_000);
	const orphanSteps: PlanStepLike[] = [];
	for (let i = 0; i < orphanPhases.length; i++) {
		const phase = maxFormalPhase + 1 + i;
		for (const child of orphanPhases[i]) {
			orphanSteps.push(childToSyntheticStep(child, phase));
		}
	}
	return [...formalSteps, ...orphanSteps];
}

/** True iff this goal's plan is "ad-hoc" \u2014 i.e. there's no formal
 *  plan (no `execution.verify[]` subgoal steps), so the plan view is
 *  pure synthesis from live children. The Plan tab can use this to
 *  surface a "Living plan" label distinct from "Editable" / "Frozen". */
export function isAdHocPlan(formalSteps: PlanStepLike[], childCount: number): boolean {
	return formalSteps.length === 0 && childCount > 0;
}
