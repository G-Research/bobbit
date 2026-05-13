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

import { resolvePlanNodeChild } from "./plan-node-state.js";

export interface SynthesisGoal {
	id: string;
	parentGoalId?: string;
	spawnedFromPlanId?: string;
	createdAt: number;
	state: "todo" | "in-progress" | "complete" | "shelved";
	archived?: boolean;
	paused?: boolean;
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

function pickResolvedChild(planId: string, childGoals: SynthesisGoal[]): SynthesisGoal | undefined {
	// Delegate to the canonical tier resolver so server, plan-node-state, and
	// plan-synthesis agree on which child wins per planId.
	return resolvePlanNodeChild(planId, childGoals).child as SynthesisGoal | undefined;
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
			childGoalId: pickResolvedChild(s.planId, childGoals)?.id,
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
	// Group by real planId so re-spawned children (archived + live for the
	// same plan) collapse to one row. The canonical tier resolver picks the
	// winner. Children with no `spawnedFromPlanId` are true orphans — keep
	// each as its own `synth:<id>` row (no grouping possible).
	const sorted = childGoals
		.slice()
		.sort((a, b) => a.createdAt - b.createdAt);

	// Bucket children by planId. For real planIds, collect all siblings so
	// the tier resolver sees the full candidate set. Synth planIds are
	// unique per child by construction.
	const groupOrder: string[] = [];
	const groupMembers = new Map<string, SynthesisGoal[]>();
	for (const c of sorted) {
		const planId = c.spawnedFromPlanId ?? `synth:${c.id}`;
		if (!groupMembers.has(planId)) {
			groupOrder.push(planId);
			groupMembers.set(planId, []);
		}
		groupMembers.get(planId)!.push(c);
	}

	// Resolve a single winner per planId via the canonical tier resolver.
	// For synth groups (size 1) the winner is just that child.
	const winners: { planId: string; child: SynthesisGoal }[] = [];
	for (const planId of groupOrder) {
		const members = groupMembers.get(planId)!;
		if (planId.startsWith("synth:")) {
			winners.push({ planId, child: members[0] });
			continue;
		}
		const resolved = resolvePlanNodeChild(planId, members).child as SynthesisGoal | undefined;
		// Resolver always returns a child when matching.length > 0, but be
		// defensive (matches plan-node-state.ts "Unreachable" branch).
		winners.push({ planId, child: resolved ?? members[members.length - 1] });
	}

	const layered: Layered[] = winners.map(w => ({
		planId: w.planId,
		dependsOn: w.child.dependsOnPlanIds ?? [],
	}));
	const depth = computeDepth(layered);
	return winners.map(w => ({
		planId: w.planId,
		title: w.child.title,
		spec: undefined,
		phase: depth.get(w.planId) ?? 0,
		dependsOn: (w.child.dependsOnPlanIds ?? []).slice(),
		childGoalId: w.child.id,
	}));
}
