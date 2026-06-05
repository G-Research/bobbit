/**
 * Child-aware `ready-to-merge` gate adapter.
 *
 * Background: the shipped `feature` / `general` / `bug-fix` workflows hard-
 * code their `ready-to-merge` verify[] at "Master merged into branch" + "PR
 * raised". For ROOT goals those checks are correct (the goal merges into
 * master and a PR is raised). For CHILD goals (`goal.mergeTarget === "parent"`)
 * both are wrong — children merge LOCALLY into the parent's branch and only
 * the root goal raises a PR (system-prompt Stanza B).
 *
 * This module rewrites the two offending verify steps with `echo` no-ops so
 * the same workflow can be inherited by a child without false failures.
 * Replacement (rather than removal) keeps the step count stable so the
 * harness's cached step indexing continues to line up.
 *
 * Pure module — no IO, no side effects on the input. Used by:
 *   - `runSubgoalStep` in verification-harness (spawn-time rewrite)
 *   - `verifyGateSignal` in verification-harness (runtime safety net for
 *     in-flight child goals whose snapshots predate this fix)
 */

import type { VerifyStep, Workflow } from "./workflow-store.js";

export interface AdaptOptions {
	/** Parent goal's branch name, e.g. "goal/audit-subg-225e4d3d" (no `origin/` prefix). */
	parentBranch: string;
}

const ECHO_PREFIX = "echo 'child goal —";

/**
 * Returns a new verify[] array with child-aware rewrites of the two offending
 * steps. All other steps are returned by reference (no clone — the caller
 * `adaptReadyToMergeForChild` already deep-clones the workflow before
 * invoking this helper).
 *
 * Idempotent: if a step's `run` already starts with the echo marker, it is
 * left alone.
 */
export function adaptReadyToMergeVerify(
	verify: VerifyStep[],
	opts: AdaptOptions,
): VerifyStep[] {
	const { parentBranch } = opts;
	return verify.map((step) => {
		// Idempotency guard — already rewritten.
		if (typeof step.run === "string" && step.run.startsWith(ECHO_PREFIX)) {
			return step;
		}
		if (step.name === "Master merged into branch") {
			return {
				name: "Master merged into branch",
				type: "command" as const,
				run: `echo 'child goal — merges locally into parent branch ${parentBranch}; no master merge required'`,
			};
		}
		if (step.name === "PR raised") {
			return {
				name: "PR raised",
				type: "command" as const,
				run: "echo 'child goal — only the root goal raises a PR'",
			};
		}
		return step;
	});
}

/**
 * Returns a new workflow with the `ready-to-merge` gate's verify[] rewritten
 * for child semantics. Deep-clones via `structuredClone` — does NOT mutate
 * the input. If the workflow has no `ready-to-merge` gate, returns the deep
 * clone unchanged.
 */
export function adaptReadyToMergeForChild(
	workflow: Workflow,
	opts: AdaptOptions,
): Workflow {
	const cloned = structuredClone(workflow);
	for (const gate of cloned.gates) {
		if (gate.id === "ready-to-merge" && Array.isArray(gate.verify)) {
			gate.verify = adaptReadyToMergeVerify(gate.verify, opts);
		}
	}
	return cloned;
}
