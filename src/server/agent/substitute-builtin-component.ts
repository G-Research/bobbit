/**
 * Pure helper: rewrite builtin workflow `component:` fields that point
 * at the placeholder name `"app"` to the project's actual primary
 * component name.
 *
 * Live test (PR #409 v0.1-foundation integration gate failure):
 * `BuiltinConfigProvider.getWorkflows()` calls
 * `buildDefaultWorkflows("app")` once at boot, so every project's
 * workflow store ends up with the literal string `"app"` baked into
 * the `parent` workflow's integration gate command steps. Projects
 * whose primary component isn't named `"app"` (e.g. agent-memory's
 * is `"agent-memory"`) hit the harness's
 *   `component "app" not found in components[]`
 * error.
 *
 * The placeholder is documented in `BuiltinConfigProvider.getWorkflows()`
 * JSDoc as "any project either re-declares in its own workflows or
 * relies on per-component scaffolds" \u2014 but the `parent` workflow is
 * structural infrastructure that no project is expected to re-declare.
 *
 * Fix: at per-project workflow-store seeding time, walk the builtin
 * workflows and replace `step.component === "app"` with the project's
 * first component name. Idempotent (a second call leaves the already-
 * substituted workflow alone). If the project has no components at
 * all, leaves the placeholder unchanged so the resulting error is
 * still actionable.
 */

import type { Workflow } from "./workflow-store.js";

export const PLACEHOLDER_COMPONENT_NAME = "app";

export interface ComponentLike {
	name: string;
}

/**
 * Substitute `component: "app"` references in a workflow's command
 * verify steps with the project's primary component name. Returns a
 * fresh Workflow (does not mutate the input) so the global builtin
 * snapshot stays untouched.
 *
 * Skip rules:
 *  - If `primaryComponentName` is the placeholder itself (`"app"`),
 *    no-op (the literal "app" is also the project's name; no
 *    substitution needed).
 *  - If `primaryComponentName` is missing/empty, return the input
 *    unchanged (the harness will surface the original placeholder
 *    error, which is still the right diagnostic when the project has
 *    no components).
 *  - Steps whose `component:` field is set to anything OTHER than the
 *    placeholder are left alone (project authors who explicitly named
 *    a component "app" or any other value get exact-match behaviour).
 */
export function substituteBuiltinComponent(
	wf: Workflow,
	primaryComponentName: string | undefined,
): Workflow {
	if (!primaryComponentName) return wf;
	if (primaryComponentName === PLACEHOLDER_COMPONENT_NAME) return wf;

	let changed = false;
	const rewriteGates = (gates: Workflow["gates"]) => gates.map(g => {
		if (!g.verify || g.verify.length === 0) return g;
		const newVerify = g.verify.map(s => {
			// Only command-type steps with the placeholder component get rewritten.
			const sAny = s as { type?: string; component?: string };
			if (sAny.type === "command" && sAny.component === PLACEHOLDER_COMPONENT_NAME) {
				changed = true;
				return { ...s, component: primaryComponentName };
			}
			return s;
		});
		return { ...g, verify: newVerify };
	});

	if (!wf.gates || wf.gates.length === 0) return wf;
	const rewritten = rewriteGates(wf.gates);
	if (!changed) return wf;
	return { ...wf, gates: rewritten };
}

/**
 * Apply `substituteBuiltinComponent` across an array of builtin
 * workflows. Returns a new array (each entry is either the original
 * (no changes) or a substituted copy).
 */
export function substituteBuiltinComponents(
	workflows: Workflow[],
	primaryComponentName: string | undefined,
): Workflow[] {
	return workflows.map(wf => substituteBuiltinComponent(wf, primaryComponentName));
}
