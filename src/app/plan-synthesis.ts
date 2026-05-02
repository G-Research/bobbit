/**
 * Pure helper for "living plan" synthesis (Phase 5a, Lesson 4.20).
 *
 * Builds a list of `PlanStep`s that the Plan tab DAG renders. Two modes:
 *
 *  - **Formal plan present**: callers pass `formalSteps` from the goal's
 *    `execution` gate. The output is the formal list mapped to PlanSteps,
 *    with each step's `childGoalId` resolved from `childGoals` whose
 *    `spawnedFromPlanId === step.planId`. Any ad-hoc child goals whose
 *    `spawnedFromPlanId` is NOT in `formalSteps` are appended as orphans
 *    past the maximum formal phase, clustered by `createdAt` gap.
 *
 *  - **No formal plan (living plan)**: ad-hoc children only — sort by
 *    `createdAt` ASC, then cluster into phases whenever the gap from the
 *    previous child exceeds `phaseClusterGapMs` (default 60s). Each child
 *    becomes a synthesised PlanStep using `spawnedFromPlanId` when present
 *    or `synth:<childGoalId>` as a fallback.
 *
 * No DOM. No Lit. The Plan tab calls this on every render — it must stay
 * O(n log n) and pure. Phase 5b consumers should re-call on each
 * `goal_state_changed` / `goal_child_spawned` WS event (throttled at 250ms
 * by the consumer to avoid layout thrash, per spec §Lesson 4.22).
 */

export interface SynthesisGoal {
	id: string;
	parentGoalId?: string;
	spawnedFromPlanId?: string;
	createdAt: number;
	state: "todo" | "in-progress" | "complete" | "shelved";
	archived?: boolean;
	title: string;
	workflowId?: string;
}

export interface PlanStep {
	planId: string;
	title: string;
	spec?: string;
	phase: number;
	childGoalId?: string;
}

export interface FormalPlanStep {
	planId: string;
	title: string;
	spec?: string;
	phase?: number;
}

export interface BuildPlanStepsOpts {
	formalSteps?: FormalPlanStep[];
	childGoals: SynthesisGoal[];
	/** Default 60_000 ms — gap above which a new phase cluster starts. */
	phaseClusterGapMs?: number;
}

const DEFAULT_PHASE_CLUSTER_GAP_MS = 60_000;

function pickResolvedChild(planId: string, childGoals: SynthesisGoal[]): string | undefined {
	// Prefer the most-recent matching child by createdAt (mirrors plan-node-state
	// tie-break at the top level — full tier preference lives in plan-node-state.ts).
	let best: SynthesisGoal | undefined;
	for (const c of childGoals) {
		if (c.spawnedFromPlanId !== planId) continue;
		if (!best || c.createdAt > best.createdAt) best = c;
	}
	return best?.id;
}

/**
 * Cluster pre-sorted (createdAt ASC) goals into phases by createdAt gap.
 * Returns parallel arrays: phases[i] is the phase index assigned to goals[i].
 */
function clusterPhases(goals: SynthesisGoal[], gapMs: number, startPhase: number): number[] {
	const phases: number[] = [];
	let phase = startPhase;
	let prevCreatedAt: number | undefined;
	for (const g of goals) {
		if (prevCreatedAt !== undefined && g.createdAt - prevCreatedAt > gapMs) phase += 1;
		phases.push(phase);
		prevCreatedAt = g.createdAt;
	}
	return phases;
}

export function buildPlanSteps(opts: BuildPlanStepsOpts): PlanStep[] {
	const gap = opts.phaseClusterGapMs ?? DEFAULT_PHASE_CLUSTER_GAP_MS;
	const childGoals = opts.childGoals;

	if (opts.formalSteps && opts.formalSteps.length > 0) {
		const formal = opts.formalSteps;
		const formalPlanIds = new Set(formal.map(s => s.planId));
		const out: PlanStep[] = formal.map(s => ({
			planId: s.planId,
			title: s.title,
			spec: s.spec,
			phase: s.phase ?? 0,
			childGoalId: pickResolvedChild(s.planId, childGoals),
		}));
		const maxFormalPhase = out.reduce((m, s) => Math.max(m, s.phase), 0);
		// Orphans = ad-hoc children whose spawnedFromPlanId is not in the formal list.
		const orphans = childGoals
			.filter(c => !c.archived && (c.spawnedFromPlanId === undefined || !formalPlanIds.has(c.spawnedFromPlanId)))
			.slice()
			.sort((a, b) => a.createdAt - b.createdAt);
		const orphanPhases = clusterPhases(orphans, gap, maxFormalPhase + 1);
		for (let i = 0; i < orphans.length; i++) {
			const c = orphans[i];
			out.push({
				planId: c.spawnedFromPlanId ?? `synth:${c.id}`,
				title: c.title,
				spec: undefined,
				phase: orphanPhases[i],
				childGoalId: c.id,
			});
		}
		return out;
	}

	// Living plan: synthesise from non-archived children.
	const sorted = childGoals
		.filter(c => !c.archived)
		.slice()
		.sort((a, b) => a.createdAt - b.createdAt);
	const phases = clusterPhases(sorted, gap, 0);
	return sorted.map((c, i) => ({
		planId: c.spawnedFromPlanId ?? `synth:${c.id}`,
		title: c.title,
		spec: undefined,
		phase: phases[i],
		childGoalId: c.id,
	}));
}
