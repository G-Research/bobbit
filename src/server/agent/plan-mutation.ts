/**
 * Plan-mutation classifier — Phase 4 of nested goals.
 *
 * Once the team-lead signals the `goal-plan` gate, the parent goal's
 * `execution.verify[]` array is frozen. Subsequent mutations submitted via
 * `PATCH /api/goals/:id/plan` are routed through this classifier, which
 * reports a single `MutationKind`. The REST handler then applies the
 * binding decision matrix from SUBGOALS-SPEC §3.6 against the goal's
 * `divergencePolicy` to allow/prompt/reject.
 *
 * Pure module — no DOM, no node-only APIs, no I/O. Importable from the
 * server REST routes and unit tests directly.
 *
 * The classifier reports kind as the **most severe** structural change and
 * THEN overrides to `criteria-drop` if any root acceptance criterion would
 * become uncovered. The override is intentional: a criterion drop trumps
 * any structural classification because the decision matrix rejects
 * criteria-drop on every policy.
 *
 * Severity order (lowest → highest):
 *   noop < fix-up < expansion < restructure (criteria-drop overrides any).
 */

export type MutationKind = "noop" | "fix-up" | "expansion" | "restructure" | "criteria-drop";

/**
 * Subgoal-typed plan step shape consumed by the classifier. Mirrors the
 * subset of `VerifyStep` we care about — kept structural-only so the
 * classifier is decoupled from `workflow-store.ts` evolution.
 */
export interface ClassifierPlanStep {
	planId: string;
	phase?: number;
	spec?: string;
	title?: string;
	subgoal?: {
		planId: string;
		title: string;
		spec: string;
		workflowId?: string;
		suggestedRole?: string;
	};
}

export interface ClassifyMutationInput {
	/** Current frozen execution.verify[] (subgoal-typed steps only). */
	current: ClassifierPlanStep[];
	/** Proposed replacement. */
	proposed: ClassifierPlanStep[];
	/** Root goal's acceptance criteria (parsed from spec). */
	rootAcceptanceCriteria: string[];
	/** Root goal's spec markdown (for criteria-coverage union). */
	rootSpec: string;
}

export interface ClassifyMutationDiff {
	/** planIds added in proposed (not in current). */
	added: string[];
	/** planIds removed in proposed (in current but not proposed). */
	removed: string[];
	/** planIds present in both but with title/spec/workflowId/suggestedRole differences (no phase). */
	modified: string[];
	/** planIds whose `phase` changed (subset / superset of `modified`). */
	phaseChanges: string[];
}

export interface ClassifyMutationResult {
	kind: MutationKind;
	/** Human-readable summary of the diff. */
	summary: string;
	/** Acceptance criteria that would become uncovered (only populated for criteria-drop). */
	uncoveredCriteria?: string[];
	/** Step-level diff: added/removed/modified planIds. */
	diff: ClassifyMutationDiff;
}

/**
 * Whitespace-normalised, case-insensitive substring match.
 *
 * SUBGOALS-SPEC §3.6 mandates this comparison for criteria-coverage so the
 * team-lead can paraphrase capitalisation/whitespace without tripping the
 * criteria-drop classifier. Hashes don't work for the same reason.
 */
function normalise(s: string): string {
	return s.replace(/\s+/g, " ").trim().toLowerCase();
}

function effectiveTitle(s: ClassifierPlanStep): string | undefined {
	return s.title ?? s.subgoal?.title;
}

function effectiveSpec(s: ClassifierPlanStep): string | undefined {
	return s.spec ?? s.subgoal?.spec;
}

function effectiveWorkflowId(s: ClassifierPlanStep): string | undefined {
	return s.subgoal?.workflowId;
}

function effectiveRole(s: ClassifierPlanStep): string | undefined {
	return s.subgoal?.suggestedRole;
}

function maxPhase(steps: ClassifierPlanStep[]): number {
	let m = 0;
	for (const s of steps) {
		const p = s.phase ?? 0;
		if (p > m) m = p;
	}
	return m;
}

/**
 * Classify the diff between `current` (frozen) and `proposed` (incoming)
 * plan-step arrays.
 *
 * The decision matrix from SUBGOALS-SPEC §3.6 is applied at the REST
 * handler — this function reports the kind only.
 */
export function classifyMutation(input: ClassifyMutationInput): ClassifyMutationResult {
	const { current, proposed, rootAcceptanceCriteria, rootSpec } = input;

	const currentByPlanId = new Map<string, ClassifierPlanStep>();
	for (const s of current) currentByPlanId.set(s.planId, s);
	const proposedByPlanId = new Map<string, ClassifierPlanStep>();
	for (const s of proposed) proposedByPlanId.set(s.planId, s);

	const added: string[] = [];
	const removed: string[] = [];
	const modified: string[] = [];
	const phaseChanges: string[] = [];

	for (const s of proposed) {
		if (!currentByPlanId.has(s.planId)) {
			added.push(s.planId);
		}
	}
	for (const s of current) {
		if (!proposedByPlanId.has(s.planId)) {
			removed.push(s.planId);
		}
	}
	for (const s of proposed) {
		const c = currentByPlanId.get(s.planId);
		if (!c) continue;
		const titleChanged = effectiveTitle(c) !== effectiveTitle(s);
		const specChanged = effectiveSpec(c) !== effectiveSpec(s);
		const wfChanged = effectiveWorkflowId(c) !== effectiveWorkflowId(s);
		const roleChanged = effectiveRole(c) !== effectiveRole(s);
		const phaseChanged = (c.phase ?? 0) !== (s.phase ?? 0);
		if (titleChanged || specChanged || wfChanged || roleChanged || phaseChanged) {
			modified.push(s.planId);
		}
		if (phaseChanged) {
			phaseChanges.push(s.planId);
		}
	}

	const diff: ClassifyMutationDiff = { added, removed, modified, phaseChanges };

	// ── Structural classification ────────────────────────────────────
	// Severity order: noop < fix-up < expansion < restructure.
	let kind: MutationKind = "noop";

	const noChanges =
		added.length === 0 &&
		removed.length === 0 &&
		modified.length === 0;
	if (noChanges) {
		kind = "noop";
	} else if (removed.length > 0) {
		// Step removed → restructure.
		kind = "restructure";
	} else {
		// No removals. Check for phase decrease on existing steps → restructure.
		let phaseDecrease = false;
		for (const id of phaseChanges) {
			const c = currentByPlanId.get(id);
			const p = proposedByPlanId.get(id);
			if (!c || !p) continue;
			if ((p.phase ?? 0) < (c.phase ?? 0)) {
				phaseDecrease = true;
				break;
			}
		}
		if (phaseDecrease) {
			kind = "restructure";
		} else {
			// Determine fix-up vs expansion. Expansion = a new step at a phase
			// > max(current.phase) OR an existing step's phase increased.
			const maxCurrent = maxPhase(current);
			let isExpansion = false;
			for (const id of added) {
				const p = proposedByPlanId.get(id);
				const phase = p?.phase ?? 0;
				if (phase > maxCurrent) {
					isExpansion = true;
					break;
				}
			}
			if (!isExpansion) {
				for (const id of phaseChanges) {
					const c = currentByPlanId.get(id);
					const p = proposedByPlanId.get(id);
					if (!c || !p) continue;
					if ((p.phase ?? 0) > (c.phase ?? 0)) {
						isExpansion = true;
						break;
					}
				}
			}
			if (isExpansion) {
				kind = "expansion";
			} else if (added.length > 0 || modified.length > 0) {
				kind = "fix-up";
			}
		}
	}

	// ── Criteria-coverage override ───────────────────────────────────
	// Walk the union of rootSpec + every proposed.spec. For each
	// acceptance criterion that's not whitespace-normalised case-insensitive
	// substring-found in that union, mark it uncovered. Any uncovered
	// criterion overrides the kind to "criteria-drop".
	const uncovered: string[] = [];
	if (rootAcceptanceCriteria.length > 0) {
		const haystack = [
			normalise(rootSpec ?? ""),
			...proposed.map(s => normalise(effectiveSpec(s) ?? "")),
		].join("\n");
		for (const crit of rootAcceptanceCriteria) {
			const needle = normalise(crit);
			if (needle.length === 0) continue;
			if (!haystack.includes(needle)) {
				uncovered.push(crit);
			}
		}
	}
	if (uncovered.length > 0) {
		kind = "criteria-drop";
	}

	const summary = buildSummary(kind, diff, uncovered);
	const result: ClassifyMutationResult = { kind, summary, diff };
	if (uncovered.length > 0) result.uncoveredCriteria = uncovered;
	return result;
}

function buildSummary(kind: MutationKind, diff: ClassifyMutationDiff, uncovered: string[]): string {
	const parts: string[] = [];
	if (diff.added.length > 0) parts.push(`+${diff.added.length} added`);
	if (diff.removed.length > 0) parts.push(`-${diff.removed.length} removed`);
	if (diff.modified.length > 0) parts.push(`${diff.modified.length} modified`);
	if (diff.phaseChanges.length > 0) parts.push(`${diff.phaseChanges.length} phase changes`);
	const diffSuffix = parts.length > 0 ? ` (${parts.join(", ")})` : "";
	if (kind === "criteria-drop") {
		return `criteria-drop: ${uncovered.length} criterion(s) would become uncovered${diffSuffix}`;
	}
	if (kind === "noop") return "no effective change";
	return `${kind}${diffSuffix}`;
}
