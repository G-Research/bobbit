/**
 * Pure helper: collect descendants of a goal by walking `parentGoalId`.
 *
 * Thin wrapper around the canonical `walkGoalSubtree` BFS — see
 * `src/server/agent/goal-subtree.ts`. Preserved as a named export with
 * its own minimal `DescendantWalkGoal` typing for callers that don't
 * carry the full `PersistedGoal` shape (tests, generic walkers).
 *
 * BFS, depth-capped to defend against malformed cycles. The root itself
 * is NOT included in the result.
 */

import { walkGoalSubtree, SUBTREE_WALK_DEFAULT_DEPTH_CAP } from "./goal-subtree.js";
import type { PersistedGoal } from "./goal-store.js";
import type { GateStatus } from "./gate-store.js";

/**
 * Aggregated per-descendant gate status surfaced on `GET /descendants` for the
 * dashboard Plan tab. This is a DATA CONTRACT consumed by the Plan-tab frontend
 * — do not rename or change the value set.
 */
export type DescendantGateStatus = "pending" | "running" | "passed" | "failed";

/** Minimal gate shape consumed by `aggregateGateStatus`. */
export interface DescendantGate {
	gateId: string;
	status: GateStatus;
}

/**
 * Aggregate a child goal's workflow gates into a single Plan-tab status.
 *
 * Precedence (highest first):
 *   - `failed`  — any gate verification failed.
 *   - `running` — a gate is currently verifying (in-flight verification).
 *   - `passed`  — the child merged (archived + complete), its `ready-to-merge`
 *                 gate passed, or every gate it has is passed.
 *   - `pending` — otherwise (no gates yet, or gates still awaiting signal).
 */
export function aggregateGateStatus(
	goal: { archived?: boolean; state?: string },
	gates: readonly DescendantGate[],
	hasActiveVerification: boolean,
): DescendantGateStatus {
	if (gates.some(g => g.status === "failed")) return "failed";
	if (hasActiveVerification) return "running";
	const merged = goal.archived === true && goal.state === "complete";
	const rtmPassed = gates.some(g => g.gateId === "ready-to-merge" && g.status === "passed");
	const allPassed = gates.length > 0 && gates.every(g => g.status === "passed");
	if (merged || rtmPassed || allPassed) return "passed";
	return "pending";
}

/** Dependencies for enriching descendants with per-node Plan-tab fields. */
export interface DescendantEnrichmentDeps {
	getGatesForGoal: (goalId: string) => readonly DescendantGate[];
	hasActiveVerification: (goalId: string) => boolean;
}

/**
 * A descendant goal enriched with the Plan-tab data contract: a non-optional
 * `mergeConflict` boolean and an aggregated `gateStatus`. The frontend consumes
 * exactly these field names — do not rename.
 */
export type EnrichedDescendant = PersistedGoal & {
	mergeConflict: boolean;
	gateStatus: DescendantGateStatus;
};

/**
 * Enrich the raw descendant list with the Plan-tab data contract fields
 * (`mergeConflict`, `gateStatus`). `mergeConflict` is normalised to a strict
 * boolean (the persisted field is optional); `gateStatus` is aggregated from
 * the child's workflow gates via {@link aggregateGateStatus}.
 */
export function enrichDescendantsForPlan(
	descendants: readonly PersistedGoal[],
	deps: DescendantEnrichmentDeps,
): EnrichedDescendant[] {
	return descendants.map(g => ({
		...g,
		mergeConflict: g.mergeConflict === true,
		gateStatus: aggregateGateStatus(g, deps.getGatesForGoal(g.id), deps.hasActiveVerification(g.id)),
	}));
}

/** Minimal goal shape consumed by `collectDescendants`. */
export interface DescendantWalkGoal {
	id: string;
	parentGoalId?: string;
}

/** Hard cap on the BFS walk depth, defends against malformed cycles. */
export const DESCENDANT_WALK_DEPTH_CAP = SUBTREE_WALK_DEFAULT_DEPTH_CAP;

/**
 * Collect all descendants of `rootId` from `allGoals` via the
 * `parentGoalId` chain. BFS; depth capped at `DESCENDANT_WALK_DEPTH_CAP`.
 *
 * Thin wrapper around `walkGoalSubtree` — the canonical BFS used by
 * every cascade in the server. Archived descendants are INCLUDED (this
 * helper powers `GET /api/goals/:goalId/descendants`, which the Plan
 * tab consumes; archived children must remain visible in the DAG even
 * when the sidebar's "See Archived" toggle is off).
 */
export function collectDescendants<G extends DescendantWalkGoal>(
	rootId: string,
	allGoals: readonly G[],
): G[] {
	if (!rootId) return [];
	// pinned by tests/plan-archived-children.test.ts::collectDescendants includes archived descendants
	return walkGoalSubtree(rootId, allGoals as unknown as PersistedGoal[], {
		includeRoot: false,
		includeArchived: true,
	}) as unknown as G[];
}
