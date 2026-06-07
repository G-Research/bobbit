/**
 * Subgoal nesting-limit policy — single source of truth shared between the
 * REST `POST /api/goals/:id/spawn-child` handler and the verification
 * harness's `runSubgoalStep`.
 *
 * Two knobs:
 *   - system pref `maxNestingDepth` (default 3, clamped 1..10).
 *   - per-goal optional override `maxNestingDepth` (must not exceed parent's
 *     effective value — system is the ceiling, descendants can only tighten).
 *
 * Plus the gate:
 *   - system pref `subgoalsEnabled` (default true in production; unset reads as enabled).
 *   - per-goal optional override `subgoalsAllowed` (can disable but not
 *     enable when system is OFF — system is the ceiling).
 *
 * `nestingDepth(goal)` walks the `parentGoalId` chain — root = 1, each
 * additional hop adds 1.
 */

import type { PersistedGoal } from "./goal-store.js";

export const SYSTEM_MAX_NESTING_DEPTH_DEFAULT = 3;
export const SYSTEM_MAX_NESTING_DEPTH_MIN = 1;
export const SYSTEM_MAX_NESTING_DEPTH_MAX = 10;

export interface SubgoalNestingPrefs {
	subgoalsEnabled: boolean;
	maxNestingDepth: number;
}

/** Read system prefs with defaults + clamping. */
export function readSubgoalNestingPrefs(
	prefsGet: (key: string) => unknown,
): SubgoalNestingPrefs {
	// Production deviation from PR #497: subgoals default ON. An unset pref reads
	// as enabled; only an explicit `false` disables the system-wide gate.
	const subgoalsEnabled = prefsGet("subgoalsEnabled") !== false;
	const rawDepth = prefsGet("maxNestingDepth");
	const depth = (typeof rawDepth === "number" && Number.isFinite(rawDepth))
		? rawDepth
		: SYSTEM_MAX_NESTING_DEPTH_DEFAULT;
	return {
		subgoalsEnabled,
		maxNestingDepth: clampMaxDepth(depth),
	};
}

/** Clamp a candidate max-depth value into the allowed band. */
export function clampMaxDepth(n: number): number {
	if (!Number.isFinite(n)) return SYSTEM_MAX_NESTING_DEPTH_DEFAULT;
	const i = Math.floor(n);
	if (i < SYSTEM_MAX_NESTING_DEPTH_MIN) return SYSTEM_MAX_NESTING_DEPTH_MIN;
	if (i > SYSTEM_MAX_NESTING_DEPTH_MAX) return SYSTEM_MAX_NESTING_DEPTH_MAX;
	return i;
}

/**
 * Compute the depth of `goal` measured as parent hops from the root + 1
 * (root = 1). Uses a bounded walk (cap = 64) so a corrupt cycle in the
 * `parentGoalId` chain can never loop infinitely.
 */
export function nestingDepth(
	goal: PersistedGoal,
	lookup: (id: string) => PersistedGoal | undefined,
): number {
	let depth = 1;
	let cur: PersistedGoal | undefined = goal;
	const seen = new Set<string>();
	while (cur?.parentGoalId && !seen.has(cur.id)) {
		seen.add(cur.id);
		const parent = lookup(cur.parentGoalId);
		if (!parent) break;
		depth++;
		if (depth >= 64) break; // safety bound
		cur = parent;
	}
	return depth;
}

/** Effective per-goal subgoals-allowed flag. System OFF wins (ceiling). */
export function effectiveSubgoalsAllowed(
	goal: PersistedGoal | undefined,
	prefs: SubgoalNestingPrefs,
): boolean {
	if (!prefs.subgoalsEnabled) return false;
	if (goal?.subgoalsAllowed === false) return false;
	return true;
}

/** Effective per-goal max depth. System is the ceiling. */
export function effectiveMaxNestingDepth(
	goal: PersistedGoal | undefined,
	prefs: SubgoalNestingPrefs,
): number {
	const sys = prefs.maxNestingDepth;
	const own = goal?.maxNestingDepth;
	if (typeof own === "number" && Number.isFinite(own)) {
		return Math.min(sys, clampMaxDepth(own));
	}
	return sys;
}

export type NestingCheckResult =
	| { ok: true; childDepth: number; maxDepth: number }
	| { ok: false; code: "SUBGOALS_DISABLED" }
	| { ok: false; code: "NESTING_DEPTH_EXCEEDED"; currentDepth: number; maxDepth: number };

/**
 * Run the full pre-spawn gate. Returns a structured outcome instead of
 * throwing or writing a response so both the REST handler and the
 * verification harness can consume it.
 */
export function checkCanSpawnChild(
	parent: PersistedGoal,
	prefs: SubgoalNestingPrefs,
	lookup: (id: string) => PersistedGoal | undefined,
): NestingCheckResult {
	if (!effectiveSubgoalsAllowed(parent, prefs)) {
		return { ok: false, code: "SUBGOALS_DISABLED" };
	}
	const maxDepth = effectiveMaxNestingDepth(parent, prefs);
	const currentDepth = nestingDepth(parent, lookup);
	if (currentDepth + 1 > maxDepth) {
		return { ok: false, code: "NESTING_DEPTH_EXCEEDED", currentDepth, maxDepth };
	}
	return { ok: true, childDepth: currentDepth + 1, maxDepth };
}

/**
 * Compute the inherited per-goal overrides to stamp onto a new child so it
 * cannot exceed the parent's effective ceiling. We always propagate the
 * parent's effective values (system ∩ parent.own) — so descendants are
 * naturally bounded even if the system pref later widens.
 */
export function inheritedChildOverrides(
	parent: PersistedGoal,
	prefs: SubgoalNestingPrefs,
): { subgoalsAllowed: boolean; maxNestingDepth: number } {
	return {
		subgoalsAllowed: effectiveSubgoalsAllowed(parent, prefs),
		maxNestingDepth: effectiveMaxNestingDepth(parent, prefs),
	};
}
