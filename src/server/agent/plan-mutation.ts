/**
 * Plan-mutation classifier. Pure module — no I/O.
 *
 * After `goal-plan` signal, parent's `execution.verify[]` is frozen;
 * `PATCH /api/goals/:id/plan` routes through here. Reports the most severe
 * structural change, with criteria-drop overriding any structural kind
 * (criteria-drop is rejected by every policy).
 *
 * Severity: noop < fix-up < expansion < restructure (criteria-drop overrides).
 * See docs/nested-goals.md#mutation-classifier.
 */

export type MutationKind = "noop" | "fix-up" | "expansion" | "restructure" | "criteria-drop";

/**
 * Subgoal-typed plan step shape consumed by the classifier.
 *
 * Field precedence: top-level wins over nested `subgoal.*`. Both shapes
 * accepted (raw verify-step or normalised). Conflicting values: top-level
 * wins; one-shot `console.warn` from `effectiveTitle()`.
 */
export interface ClassifierPlanStep {
	planId: string;
	phase?: number;
	spec?: string;
	title?: string;
	/**
	 * Sibling planIds this step depends on (Phase 5 — explicit DAG).
	 * Hoisted top-level alongside `subgoal.dependsOn`; the classifier prefers
	 * the top-level field when both are present (mirrors title/spec).
	 * Diff: a change in the dep set on an existing planId bumps severity to
	 * `restructure` (overrides any `fix-up` classification it would otherwise
	 * receive).
	 */
	dependsOn?: string[];
	/**
	 * G2/C1: `goal_plan_propose` (defaults/tools/children/extension.ts) sends
	 * `workflowId` / `suggestedRole` at the TOP level of each step. The
	 * classifier hoists them alongside `subgoal.workflowId` / `.suggestedRole`
	 * and prefers the top-level field when both are present (mirrors
	 * title/spec/dependsOn). Without this, a child's workflow/role override
	 * was invisible to the diff and silently dropped on replan.
	 */
	workflowId?: string;
	suggestedRole?: string;
	subgoal?: {
		planId: string;
		title: string;
		spec: string;
		workflowId?: string;
		suggestedRole?: string;
		dependsOn?: string[];
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
 *
 * Locale: pinned to `"en"` so a Turkish-locale `İ` criterion matches its
 * dotless lowercase form rather than producing a spurious criteria-drop in
 * Turkish/Azerbaijani user environments.
 */
function normalise(s: string): string {
	return s.replace(/\s+/g, " ").trim().toLocaleLowerCase("en");
}

/** One-shot guard so we don't spam the log when many steps disagree. */
let _warnedConflict = false;
function effectiveTitle(s: ClassifierPlanStep): string | undefined {
	if (s.title !== undefined && s.subgoal?.title !== undefined && s.title !== s.subgoal.title && !_warnedConflict) {
		_warnedConflict = true;
		console.warn(
			`[plan-mutation] ClassifierPlanStep ${s.planId} has conflicting top-level title (${JSON.stringify(s.title)}) ` +
			`and subgoal.title (${JSON.stringify(s.subgoal.title)}) — top-level wins. ` +
			`Normalise call sites to set one or the other.`,
		);
	}
	return s.title ?? s.subgoal?.title;
}

function effectiveSpec(s: ClassifierPlanStep): string | undefined {
	return s.spec ?? s.subgoal?.spec;
}

function effectiveWorkflowId(s: ClassifierPlanStep): string | undefined {
	return s.workflowId ?? s.subgoal?.workflowId;
}

function effectiveRole(s: ClassifierPlanStep): string | undefined {
	return s.suggestedRole ?? s.subgoal?.suggestedRole;
}

function effectiveDependsOn(s: ClassifierPlanStep): string[] {
	return s.dependsOn ?? s.subgoal?.dependsOn ?? [];
}

function sameSet(a: string[], b: string[]): boolean {
	if (a.length !== b.length) return false;
	const sa = new Set(a);
	for (const x of b) if (!sa.has(x)) return false;
	return true;
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
	const dependsOnChanges = new Set<string>();
	for (const s of proposed) {
		const c = currentByPlanId.get(s.planId);
		if (!c) continue;
		const titleChanged = effectiveTitle(c) !== effectiveTitle(s);
		const specChanged = effectiveSpec(c) !== effectiveSpec(s);
		const wfChanged = effectiveWorkflowId(c) !== effectiveWorkflowId(s);
		const roleChanged = effectiveRole(c) !== effectiveRole(s);
		const phaseChanged = (c.phase ?? 0) !== (s.phase ?? 0);
		const depsChanged = !sameSet(effectiveDependsOn(c), effectiveDependsOn(s));
		if (titleChanged || specChanged || wfChanged || roleChanged || phaseChanged || depsChanged) {
			modified.push(s.planId);
		}
		if (phaseChanged) {
			phaseChanges.push(s.planId);
		}
		if (depsChanged) {
			dependsOnChanges.add(s.planId);
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
			// Construction invariant (R-014): `phaseChanges` is built above by
			// iterating `proposed` and only pushing when both `c` (looked up
			// in `currentByPlanId`) and `s` exist with differing phases — so
			// both lookups here are guaranteed to hit. The lint-friendly
			// guard below is dead code retained as a belt-and-braces against
			// a future refactor that decouples this loop from the build site.
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

	// `dependsOn` change on an existing step changes execution shape — always
	// `restructure` (overrides any `fix-up` it would otherwise be classified as).
	// New steps with new deps fall under `expansion`/`restructure` rules above;
	// only modifications to an EXISTING step's dep set trigger this bump.
	if (dependsOnChanges.size > 0 && (kind === "fix-up" || kind === "noop")) {
		kind = "restructure";
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
