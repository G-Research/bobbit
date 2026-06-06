/**
 * Pure helper for resolving the displayed state of a Plan-tab node from the
 * set of child goals that share its planId (Phase 5a, tier-based child resolution).
 *
 * tier-based child resolution — when multiple children share a `spawnedFromPlanId` (the
 * archived/merged success child plus a stranded zombie sibling), naïve
 * "live > archived" tie-break shadowed the real success child and the Plan
 * tab rendered the zombie as failed. Fix: tier-based preference where a
 * success-terminal archived record outranks a live "todo" or "shelved" one.
 *
 * Tier preference (highest → lowest):
 *  1. Live (`!archived`) AND `state === "in-progress"` AND not paused
 *  2. Archived AND `state === "complete"` (success terminal — merged child)
 *  3. Live (`!archived`) other (todo, paused, in-progress&&paused, shelved)
 *  4. Archived AND `state !== "complete"` (shelved dupe)
 *
 * Within a tier, the most-recent (`createdAt` desc) candidate wins.
 *
 * Derived display state:
 *  - Tier 1 → `"in-progress"`
 *  - Tier 2 → `"complete"`
 *  - Tier 3 → `paused` => `"paused"`; `state==="shelved"` => `"failed"`;
 *             `state==="in-progress"` (must be paused, given Tier 1
 *             precedence) => `"paused"`; `state==="complete"` => `"complete"`;
 *             otherwise (todo) => `"todo"`
 *  - Tier 4 → `"failed"`
 *  - No candidates → `"todo"`, `child=undefined`
 *
 * No DOM, no Lit. Mirrors the server-side `resolvePlanStepChild` (spec §5,
 * Phase 3) so server and client agree on the displayed state.
 */

export type PlanNodeState =
	| "todo"
	| "in-progress"
	| "complete"
	| "failed"
	| "paused";

/**
 * Per-node gate status (Phase 5c). An ADDITIONAL display dimension carried
 * alongside the tier-based `state` — the two are orthogonal: `state` is the
 * tier resolution of which child wins per planId, `gateStatus` is that
 * child's workflow-gate progress. The backend stamps it on each descendant
 * (data contract: `gateStatus: "pending"|"running"|"passed"|"failed"`).
 * Optional everywhere so legacy payloads and tier resolution are unaffected.
 */
export type PlanNodeGateStatus = "pending" | "running" | "passed" | "failed";

export interface PlanNodeChild {
	id: string;
	parentGoalId?: string;
	spawnedFromPlanId?: string;
	state: "todo" | "in-progress" | "complete" | "shelved" | "blocked";
	archived?: boolean;
	paused?: boolean;
	createdAt: number;
	/** Backend data contract: true when the child's local merge into the
	 *  parent branch hit a conflict and was preserved for manual recovery. */
	mergeConflict?: boolean;
	/** Backend data contract: the child's workflow-gate progress. Orthogonal
	 *  to the tier-based `state` resolution. */
	gateStatus?: PlanNodeGateStatus;
}

export interface PlanNodeResolution {
	child?: PlanNodeChild;
	state: PlanNodeState;
}

function classifyTier(c: PlanNodeChild): 1 | 2 | 3 | 4 {
	const live = !c.archived;
	if (live && c.state === "in-progress" && !c.paused) return 1;
	if (c.archived && c.state === "complete") return 2;
	if (live) return 3;
	return 4;
}

export function resolvePlanNodeChild(
	planId: string,
	candidates: PlanNodeChild[],
): PlanNodeResolution {
	const matching = candidates.filter(c => c.spawnedFromPlanId === planId);
	if (matching.length === 0) return { child: undefined, state: "todo" };

	// Group by tier; within tier pick most-recent createdAt.
	const buckets: { [tier: number]: PlanNodeChild[] } = { 1: [], 2: [], 3: [], 4: [] };
	for (const c of matching) buckets[classifyTier(c)].push(c);

	for (const tier of [1, 2, 3, 4] as const) {
		const list = buckets[tier];
		if (list.length === 0) continue;
		const winner = list.reduce((best, c) => (c.createdAt > best.createdAt ? c : best));
		return { child: winner, state: deriveDisplayState(tier, winner) };
	}

	// Unreachable: matching.length > 0 guarantees at least one bucket non-empty.
	return { child: undefined, state: "todo" };
}

function deriveDisplayState(tier: 1 | 2 | 3 | 4, c: PlanNodeChild): PlanNodeState {
	if (tier === 1) return "in-progress";
	if (tier === 2) return "complete";
	if (tier === 4) return "failed";
	// tier === 3 — live, non-tier-1, non-archived
	if (c.paused) return "paused";
	if (c.state === "shelved") return "failed";
	if (c.state === "complete") return "complete";
	if (c.state === "in-progress") return "in-progress";
	return "todo";
}
