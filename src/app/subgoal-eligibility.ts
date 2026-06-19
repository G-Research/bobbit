/**
 * Client-side mirror of the server's per-goal sub-goal host-eligibility rules
 * (`src/server/agent/subgoal-nesting-limit.ts`). Used by the goal-proposal
 * parent picker and the existing-goal Sub-goals settings control so the
 * dead-end ("Parent goal doesn't allow sub-goals") is visible BEFORE submit
 * instead of only surfacing as a server reject.
 *
 * The system-wide `subgoalsEnabled` flag is the master gate and is checked by
 * the callers (the picker only renders when it is ON), so these helpers
 * deliberately consider ONLY the per-goal policy + nesting depth. They never
 * relax the server gate — they only pre-communicate it.
 *
 * Kept dependency-light (no state/render imports) so it is unit-testable.
 */
import { getSystemMaxNestingDepth } from "./subgoals-flag.js";

/** Minimal goal shape these helpers walk. */
export interface EligibilityGoal {
	id: string;
	parentGoalId?: string;
	subgoalsAllowed?: boolean;
	maxNestingDepth?: number;
}

/**
 * Depth of a goal measured as parent hops from the root + 1 (root = 1).
 * Bounded walk so a corrupt `parentGoalId` cycle can never loop forever.
 * Mirrors `nestingDepth` on the server.
 */
export function nestingDepthOf(
	goalId: string,
	goals: ReadonlyArray<EligibilityGoal>,
): number {
	let depth = 1;
	let cur: EligibilityGoal | undefined = goals.find(g => g.id === goalId);
	const seen = new Set<string>();
	while (cur?.parentGoalId && !seen.has(cur.id)) {
		seen.add(cur.id);
		cur = goals.find(g => g.id === cur!.parentGoalId);
		if (!cur) break;
		depth++;
		if (depth >= 64) break;
	}
	return depth;
}

/**
 * Effective absolute max nesting depth for a goal: the system ceiling, tightened
 * by the goal's own override when present. Mirrors `effectiveMaxNestingDepth`.
 */
export function effectiveMaxNestingDepthOf(goal: EligibilityGoal | undefined): number {
	const sys = getSystemMaxNestingDepth();
	const own = goal?.maxNestingDepth;
	if (typeof own === "number" && Number.isFinite(own)) {
		return Math.min(sys, Math.max(1, Math.floor(own)));
	}
	return sys;
}

export type ParentEligibility =
	| { eligible: true }
	| { eligible: false; reason: "subgoals-off" | "at-cap"; suffix: string; hint: string };

/**
 * Whether `goal` can currently host child goals, assuming the system flag is
 * ON (the caller guarantees that). Returns a structured reason so the UI can
 * mark the option AND show a remediation hint when such a parent is selected.
 *
 * NOTE: the `subgoals-off` suffix intentionally contains the literal
 * "sub-goals off" string the parent-picker repro test matches on.
 */
export function parentHostEligibility(
	goal: EligibilityGoal,
	goals: ReadonlyArray<EligibilityGoal>,
): ParentEligibility {
	if (goal.subgoalsAllowed === false) {
		return {
			eligible: false,
			reason: "subgoals-off",
			suffix: "(sub-goals off)",
			hint: "This goal doesn't allow sub-goals. Open its dashboard → Children tab and turn on \u201CAllow sub-goals\u201D, then it can host children.",
		};
	}
	const depth = nestingDepthOf(goal.id, goals);
	const maxDepth = effectiveMaxNestingDepthOf(goal);
	if (depth + 1 > maxDepth) {
		return {
			eligible: false,
			reason: "at-cap",
			suffix: "(at nesting cap)",
			hint: `This goal is at depth ${depth}; the nesting cap (${maxDepth}) leaves no room for sub-goals below it. Pick a shallower parent.`,
		};
	}
	return { eligible: true };
}
