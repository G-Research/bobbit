/**
 * Pure helper for plan-tab synthesis (Phase 5b — explicit dependsOn DAG).
 *
 * Builds a list of `PlanStep`s the Plan tab DAG renders. The step's
 * `phase` field carries its **column index** in the layered topological
 * layout: `phase = max(deps.phase) + 1`, defaulting to 0 for steps with
 * no declared dependencies. The createdAt-gap heuristic that earlier
 * versions used is gone — it inferred dependencies that didn't exist and
 * chained unrelated children together.
 *
 *  - **Formal plan present**: callers pass `formalSteps` from the goal's
 *    `execution` gate. Each step's `dependsOn` is read from the verify-
 *    step's subgoal payload (formal). Steps that don't appear in
 *    `formalSteps` come from ad-hoc children and are appended; their
 *    `dependsOn` comes from the child goal's `dependsOnPlanIds` field.
 *
 *  - **No formal plan (living plan)**: ad-hoc children only. Each child
 *    becomes a synthesised PlanStep keyed on `spawnedFromPlanId` (or
 *    `synth:<childGoalId>` fallback). `dependsOn` is read from the child
 *    goal's `dependsOnPlanIds`.
 *
 * Cycles + unknown deps are filtered as defence in depth at synthesis
 * (the API rejects them upstream); on a cycle, depth defaults to 0 for
 * the affected nodes so the renderer never spins.
 *
 * No DOM. No Lit. The Plan tab calls this on every render — it must stay
 * O(n + e) and pure.
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
	/** Explicit sibling planIds this child depends on (Phase 5). */
	dependsOnPlanIds?: string[];
}

export interface PlanStep {
	planId: string;
	title: string;
	spec?: string;
	/** Topological depth (column index); 0 = root. Synonym of column. */
	phase: number;
	/** Sibling planIds this step depends on. Always present (possibly empty). */
	dependsOn: string[];
	childGoalId?: string;
}

export interface FormalPlanStep {
	planId: string;
	title: string;
	spec?: string;
	phase?: number;
	/** Explicit sibling planIds this step depends on (Phase 5). */
	dependsOn?: string[];
}

export interface BuildPlanStepsOpts {
	formalSteps?: FormalPlanStep[];
	childGoals: SynthesisGoal[];
}

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

interface Layered {
	planId: string;
	dependsOn: string[];
}

/**
 * Compute a column index per step using a topological-depth pass. Steps
 * with no declared deps land at column 0; otherwise column =
 * max(deps.column) + 1. Cycles are defended: any step whose deps couldn't
 * be resolved (cycle or unknown) defaults to 0 so the Plan tab never
 * stalls. We log the cycle once per build so authors can spot it.
 */
export function computeDepth(steps: Layered[]): Map<string, number> {
	const depth = new Map<string, number>();
	const knownIds = new Set<string>();
	for (const s of steps) knownIds.add(s.planId);

	// Filter unknown deps once up-front (defence in depth — API should reject).
	const filtered: Layered[] = steps.map(s => ({
		planId: s.planId,
		dependsOn: s.dependsOn.filter(d => knownIds.has(d) && d !== s.planId),
	}));

	// Kahn-style depth assignment.
	const inDegree = new Map<string, number>();
	const adj = new Map<string, string[]>();
	for (const s of filtered) {
		inDegree.set(s.planId, 0);
		adj.set(s.planId, []);
	}
	for (const s of filtered) {
		for (const d of s.dependsOn) {
			adj.get(d)!.push(s.planId);
			inDegree.set(s.planId, (inDegree.get(s.planId) ?? 0) + 1);
		}
	}
	const ready: string[] = [];
	for (const [k, v] of inDegree) if (v === 0) {
		ready.push(k);
		depth.set(k, 0);
	}
	while (ready.length > 0) {
		const id = ready.shift()!;
		const d = depth.get(id) ?? 0;
		for (const next of adj.get(id) ?? []) {
			const candidate = d + 1;
			const existing = depth.get(next);
			if (existing === undefined || candidate > existing) {
				depth.set(next, candidate);
			}
			const remaining = (inDegree.get(next) ?? 0) - 1;
			inDegree.set(next, remaining);
			if (remaining === 0) ready.push(next);
		}
	}
	// Anything still missing is in a cycle (or downstream of one); default to 0.
	let cycledCount = 0;
	for (const s of filtered) {
		if (!depth.has(s.planId)) {
			depth.set(s.planId, 0);
			cycledCount++;
		}
	}
	if (cycledCount > 0) {
		// One-shot per build — don't spam.
		console.warn(`[plan-synthesis] ${cycledCount} step(s) in a dependsOn cycle; defaulted to depth 0`);
	}
	return depth;
}

export function buildPlanSteps(opts: BuildPlanStepsOpts): PlanStep[] {
	const childGoals = opts.childGoals;

	if (opts.formalSteps && opts.formalSteps.length > 0) {
		const formal = opts.formalSteps;
		const formalPlanIds = new Set(formal.map(s => s.planId));
		// Orphans = ad-hoc children whose spawnedFromPlanId is not in the formal list.
		// Include archived children too — the renderer (plan-node-state.ts) decides
		// display state per node.
		const orphans = childGoals
			.filter(c => c.spawnedFromPlanId === undefined || !formalPlanIds.has(c.spawnedFromPlanId))
			.slice()
			.sort((a, b) => a.createdAt - b.createdAt);

		// Build the unified planId universe to compute layered depth across both
		// formal + orphan steps. (Orphans can declare deps on formal steps via
		// the child goal's dependsOnPlanIds.)
		const orphanPlanIds = orphans.map(c => c.spawnedFromPlanId ?? `synth:${c.id}`);
		const universe: Layered[] = [
			...formal.map(s => ({ planId: s.planId, dependsOn: s.dependsOn ?? [] })),
			...orphans.map((c, i) => ({ planId: orphanPlanIds[i], dependsOn: c.dependsOnPlanIds ?? [] })),
		];
		const depth = computeDepth(universe);

		const out: PlanStep[] = formal.map(s => ({
			planId: s.planId,
			title: s.title,
			spec: s.spec,
			phase: depth.get(s.planId) ?? 0,
			dependsOn: (s.dependsOn ?? []).slice(),
			childGoalId: pickResolvedChild(s.planId, childGoals),
		}));
		for (let i = 0; i < orphans.length; i++) {
			const c = orphans[i];
			const planId = orphanPlanIds[i];
			out.push({
				planId,
				title: c.title,
				spec: undefined,
				phase: depth.get(planId) ?? 0,
				dependsOn: (c.dependsOnPlanIds ?? []).slice(),
				childGoalId: c.id,
			});
		}
		return out;
	}

	// Living plan: synthesise from ALL children — archived included.
	const sorted = childGoals
		.slice()
		.sort((a, b) => a.createdAt - b.createdAt);
	const planIds = sorted.map(c => c.spawnedFromPlanId ?? `synth:${c.id}`);
	const layered: Layered[] = sorted.map((c, i) => ({
		planId: planIds[i],
		dependsOn: c.dependsOnPlanIds ?? [],
	}));
	const depth = computeDepth(layered);
	return sorted.map((c, i) => ({
		planId: planIds[i],
		title: c.title,
		spec: undefined,
		phase: depth.get(planIds[i]) ?? 0,
		dependsOn: (c.dependsOnPlanIds ?? []).slice(),
		childGoalId: c.id,
	}));
}
