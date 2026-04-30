/**
 * Plan-mutation classifier (nested goals — see
 * docs/design/nested-goals.md §4).
 *
 * Pure module: no goal-store / goal-manager / server / I/O imports. Type-only
 * imports of `VerifyStep` (workflow-store) and `PersistedGoal` (goal-store).
 *
 * The single export `classifyMutation()` shapes a proposed plan-`verify[]`
 * change into one of five `MutationClass` values plus per-criterion
 * adherence diagnostics. The §8 REST handlers and `defaults/tools/children/`
 * extension consume the result to gate auto-approve vs prompt vs reject
 * paths per the §4.3 decision matrix.
 *
 * Subgoal verify steps are identified by `subgoal.planId` (stable across
 * replans). Non-subgoal verify steps in `before`/`after` are ignored: the
 * classifier only cares about plan-level structural changes, and only
 * subgoal steps carry plan ids.
 */

import type { VerifyStep } from "./workflow-store.js";
import type { PersistedGoal } from "./goal-store.js";

export type MutationClass =
	| "noop"
	| "fix-up"
	| "expansion"
	| "restructure"
	| "criteria-drop";

export interface MutationDiff {
	cls: MutationClass;
	/**
	 * Acceptance criteria from `rootGoal.acceptanceCriteria` that are no
	 * longer covered by the union of `rootGoal.spec` and the `after`-side
	 * subgoal specs. Empty unless `cls === "criteria-drop"`.
	 */
	droppedCriteria: string[];
	/** Subgoal step labels added (planId on after side, not in before). */
	addedNodes: string[];
	/** Subgoal step labels removed (planId in before, not in after). */
	removedNodes: string[];
	/** True when any surviving node's phase or workflowId changed. */
	changedDeps: boolean;
	/** Human-readable summary used in the UI banner / 409 error body. */
	summary: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────

function subgoalSteps(steps: VerifyStep[]): VerifyStep[] {
	const out: VerifyStep[] = [];
	for (const s of steps) {
		if (s.type === "subgoal" && s.subgoal && s.subgoal.planId) out.push(s);
	}
	return out;
}

function indexByPlanId(steps: VerifyStep[]): Map<string, VerifyStep> {
	const m = new Map<string, VerifyStep>();
	for (const s of subgoalSteps(steps)) m.set(s.subgoal!.planId, s);
	return m;
}

function nodeLabel(s: VerifyStep): string {
	return (
		(s.subgoal?.title?.trim() || "") ||
		(s.name?.trim() || "") ||
		(s.subgoal?.planId ?? "?")
	);
}

function maxPhase(steps: VerifyStep[]): number {
	let m = 0;
	for (const s of subgoalSteps(steps)) {
		const p = s.phase ?? 0;
		if (p > m) m = p;
	}
	return m;
}

/**
 * Normalise text for substring matching: lowercase, collapse runs of
 * whitespace into a single space, trim. See design doc §4.2.
 */
function normaliseText(s: string): string {
	return (s || "").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Coverage check for a single criterion. Returns true when the
 * normalised criterion is a substring of the union of the (normalised)
 * root spec and the (normalised) `subgoal.spec` of every surviving
 * subgoal step in `after`. Criteria shorter than 8 normalised characters
 * are treated as auto-covered (too short to anchor — design doc §4.2).
 */
function criterionCovered(criterion: string, after: VerifyStep[], rootSpec: string): boolean {
	const needle = normaliseText(criterion);
	if (needle.length < 8) return true;
	const subgoalSpecs = subgoalSteps(after)
		.map(s => normaliseText(s.subgoal?.spec ?? ""))
		.join("\n");
	const haystack = normaliseText(rootSpec) + "\n" + subgoalSpecs;
	return haystack.includes(needle);
}

// ── Summary builder ─────────────────────────────────────────────────────

function joinList(labels: string[]): string {
	return labels.map(l => `"${l}"`).join(", ");
}

function buildSummary(
	cls: MutationClass,
	added: string[],
	removed: string[],
	changedDeps: boolean,
	dropped: string[],
): string {
	switch (cls) {
		case "noop":
			return "No structural changes.";
		case "fix-up":
			return added.length === 1
				? `Adds leaf subgoal ${joinList(added)} at an existing phase.`
				: `Adds ${added.length} leaf subgoals at existing phases (${joinList(added)}).`;
		case "expansion": {
			const parts: string[] = [];
			if (added.length > 0) {
				parts.push(
					added.length === 1
						? `adds new subgoal ${joinList(added)}`
						: `adds ${added.length} new subgoals (${joinList(added)})`,
				);
			}
			if (changedDeps) parts.push("introduces new dependencies");
			if (parts.length === 0) return "Expansion.";
			const joined = parts.join("; ");
			return joined.charAt(0).toUpperCase() + joined.slice(1) + ".";
		}
		case "restructure": {
			const parts: string[] = [];
			if (removed.length > 0) {
				parts.push(
					removed.length === 1
						? `removes subgoal ${joinList(removed)}`
						: `removes ${removed.length} subgoals (${joinList(removed)})`,
				);
			}
			if (added.length > 0) {
				parts.push(
					added.length === 1
						? `adds subgoal ${joinList(added)}`
						: `adds ${added.length} subgoals (${joinList(added)})`,
				);
			}
			if (changedDeps) parts.push("changes dependencies");
			if (parts.length === 0) return "Restructure.";
			const joined = parts.join("; ");
			return joined.charAt(0).toUpperCase() + joined.slice(1) + ".";
		}
		case "criteria-drop": {
			if (dropped.length === 1) {
				return `Drops coverage of acceptance criterion: "${dropped[0]}".`;
			}
			return `Drops coverage of ${dropped.length} acceptance criteria: ${joinList(dropped)}.`;
		}
	}
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Classify a plan mutation by structural shape and acceptance-criteria
 * adherence. See `docs/design/nested-goals.md` §4.1.
 *
 * Algorithm (priority order):
 *   1. `noop` — no added/removed nodes and no surviving-node phase/workflowId
 *      change.
 *   2. Structural shape:
 *      - Empty `before` (pre-freeze proposal) with non-empty `after` →
 *        `expansion` (per §4.1 contract).
 *      - Removed nodes OR survivor phase/workflowId change → `restructure`.
 *      - Added nodes only:
 *          * Any added node's phase > max(before phases) → `expansion`.
 *          * All added nodes at existing phases → `fix-up`.
 *   3. Adherence: for each criterion in `rootGoal.acceptanceCriteria`,
 *      check substring coverage against the union of `rootGoal.spec` and
 *      the surviving subgoal-step specs. Any uncovered criterion → override
 *      `cls` to `criteria-drop` and populate `droppedCriteria`. Criteria
 *      shorter than 8 normalised characters auto-pass.
 */
export function classifyMutation(
	before: VerifyStep[],
	after: VerifyStep[],
	rootGoal: PersistedGoal,
): MutationDiff {
	const beforeMap = indexByPlanId(before);
	const afterMap = indexByPlanId(after);

	const addedIds: string[] = [];
	const removedIds: string[] = [];
	const addedNodes: string[] = [];
	const removedNodes: string[] = [];

	for (const [id, s] of afterMap) {
		if (!beforeMap.has(id)) {
			addedIds.push(id);
			addedNodes.push(nodeLabel(s));
		}
	}
	for (const [id, s] of beforeMap) {
		if (!afterMap.has(id)) {
			removedIds.push(id);
			removedNodes.push(nodeLabel(s));
		}
	}

	// Detect dep/structural changes among survivors: phase or workflowId.
	let changedDeps = false;
	for (const [id, afterStep] of afterMap) {
		const beforeStep = beforeMap.get(id);
		if (!beforeStep) continue;
		const bp = beforeStep.phase ?? 0;
		const ap = afterStep.phase ?? 0;
		if (bp !== ap) {
			changedDeps = true;
			break;
		}
		const bwid = beforeStep.subgoal?.workflowId ?? "";
		const awid = afterStep.subgoal?.workflowId ?? "";
		if (bwid !== awid) {
			changedDeps = true;
			break;
		}
	}

	// Classify shape.
	let cls: MutationClass;
	const beforeSubgoalCount = beforeMap.size;
	if (addedIds.length === 0 && removedIds.length === 0 && !changedDeps) {
		cls = "noop";
	} else if (beforeSubgoalCount === 0 && addedIds.length > 0) {
		// Pre-freeze proposal — populated from an empty plan. Per §4.1
		// contract: always classifies as "expansion".
		cls = "expansion";
	} else if (removedIds.length > 0 || changedDeps) {
		cls = "restructure";
	} else {
		// addedIds.length > 0 && no removals && no survivor dep changes.
		const beforeMax = maxPhase(before);
		const addedPhases = addedIds.map(id => afterMap.get(id)?.phase ?? 0);
		const addedMax = addedPhases.length > 0 ? Math.max(...addedPhases) : 0;
		cls = addedMax > beforeMax ? "expansion" : "fix-up";
	}

	// Adherence override. `noop` is exempt — if nothing changed, coverage
	// can't have shifted relative to the goal's own (unchanged) spec, and
	// surfacing a drop here would be a false positive on degenerate input.
	const droppedCriteria: string[] = [];
	if (cls !== "noop") {
		const criteria = rootGoal.acceptanceCriteria ?? [];
		const rootSpec = rootGoal.spec ?? "";
		for (const c of criteria) {
			if (!criterionCovered(c, after, rootSpec)) droppedCriteria.push(c);
		}
		if (droppedCriteria.length > 0) cls = "criteria-drop";
	}

	const summary = buildSummary(cls, addedNodes, removedNodes, changedDeps, droppedCriteria);

	return { cls, droppedCriteria, addedNodes, removedNodes, changedDeps, summary };
}
