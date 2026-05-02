/**
 * Pure helper: rewrite builtin workflow `component:` fields that point
 * at the placeholder name `"app"` to the project's actual primary
 * component name, AND prune verify steps whose named command isn't
 * declared on the project's primary component.
 *
 * Live test (PR #409 v0.1-foundation):
 *
 * ISSUE 8 (component substitution): `BuiltinConfigProvider.getWorkflows()`
 * calls `buildDefaultWorkflows("app")` once at boot, so every project's
 * workflow store ends up with the literal string `"app"` baked into the
 * `parent` workflow's integration gate command steps. Projects whose
 * primary component isn't named `"app"` (e.g. agent-memory's is
 * `"agent-memory"`) hit
 *   `component "app" not found in components[]`.
 *
 * ISSUE 9 (command pruning): the same `parent.integration` template
 * also hardcodes `command: "e2e"`. Projects whose primary component
 * declares no `e2e` command (e.g. agent-memory's components[].commands
 * has unit/contract/integration/eval/fault-injection/replay but no
 * `e2e`) hit
 *   `component "agent-memory" has no command "e2e"`.
 *
 * Both gaps come from the same root: the safety-net `parent` workflow
 * is supposed to provide a UNIVERSAL gate sequence (charter \u2192 plan-review
 * \u2192 goal-plan \u2192 execution \u2192 integration \u2192 ready-to-merge), but the
 * specific integration commands vary by project. The placeholder is
 * documented in `BuiltinConfigProvider.getWorkflows()` JSDoc as "any
 * project either re-declares in its own workflows or relies on
 * per-component scaffolds" \u2014 but the `parent` workflow IS structural
 * infrastructure that no project is expected to re-declare. So we
 * substitute + prune at per-project workflow-store seeding time so the
 * `parent` workflow Just Works against whatever commands the project
 * actually has.
 *
 * Substitution rule: replace `step.component === "app"` with the
 * project's primary component name.
 *
 * Prune rule: after substitution, if a command-type step's
 * `step.component === primary.name` AND `step.command` is set AND
 * `primary.commands[step.command]` is undefined, drop the step from
 * the gate's verify[]. Silent prune (logged at info level) \u2014 the
 * project chose not to declare that command, don't fail their
 * integration gate over it.
 *
 * Both rules are idempotent (a second pass is a no-op) and skip
 * gracefully when:
 *  - `primary.name` is missing/empty
 *  - `primary.name` is the placeholder `"app"`
 *  - `primary.commands` is missing (back-compat: skip pruning, only
 *    substitute)
 *  - the workflow has no gates / verify steps
 */

import type { Workflow } from "./workflow-store.js";

export const PLACEHOLDER_COMPONENT_NAME = "app";

/** Minimal component shape \u2014 just the bits the substitution + prune
 *  needs. Tests don't need the full Component union. */
export interface PrimaryComponent {
	name: string;
	commands?: Record<string, string>;
}

/** Resolve the input form (string for back-compat with PR-aa913742-era
 *  tests, or a full PrimaryComponent for prune support).
 *
 *  Production callers (project-context-manager / boot-migration) pass
 *  the object form. Object form with `commands: undefined` is treated
 *  as `commands: {}` — the project explicitly declared no commands, so
 *  every named command targeting this component must be pruned.
 *
 *  String form preserves the back-compat skip-prune behaviour (the
 *  PR-aa913742-era unit tests rely on this).
 */
function resolvePrimary(
	primary: PrimaryComponent | string | undefined,
): PrimaryComponent | undefined {
	if (!primary) return undefined;
	if (typeof primary === "string") return { name: primary };
	if (!primary.name) return undefined;
	// Object form: normalise commands to {} so the prune predicate fires
	// even when the project's component declares no commands at all.
	if (!primary.commands) return { name: primary.name, commands: {} };
	return primary;
}

/**
 * Substitute + prune on a single workflow. Returns a fresh Workflow
 * (does not mutate the input) so the global builtin snapshot stays
 * untouched.
 */
export function substituteBuiltinComponent(
	wf: Workflow,
	primary: PrimaryComponent | string | undefined,
): Workflow {
	const p = resolvePrimary(primary);
	if (!p) return wf;
	if (p.name === PLACEHOLDER_COMPONENT_NAME) return wf;
	if (!wf.gates || wf.gates.length === 0) return wf;

	let changed = false;
	const newGates = wf.gates.map(g => {
		if (!g.verify || g.verify.length === 0) return g;
		const filteredVerify: typeof g.verify = [];
		for (const s of g.verify) {
			const sAny = s as { type?: string; component?: string; command?: string; name?: string };

			// Substitution: rewrite "app" placeholder \u2192 primary.name.
			let component = sAny.component;
			if (sAny.type === "command" && component === PLACEHOLDER_COMPONENT_NAME) {
				component = p.name;
				changed = true;
			}

			// Prune rule: command-type step targeting primary's component
			// with a named command that primary.commands doesn't declare.
			// Only applies when we actually have a commands map to check
			// against \u2014 if the caller passed a string-only primary
			// (no commands map) we skip pruning for back-compat.
			const shouldCheckPrune =
				sAny.type === "command" &&
				p.commands &&
				typeof sAny.command === "string" &&
				sAny.command.length > 0 &&
				component === p.name;
			if (shouldCheckPrune && !(sAny.command! in p.commands!)) {
				changed = true;
				const available = Object.keys(p.commands!).join(", ") || "(none)";
				console.log(
					`[builtin-prune] dropping verify step "${sAny.name ?? sAny.command}" from workflow "${wf.id}" gate "${g.id}": ` +
					`component "${p.name}" has no command "${sAny.command}". Available: ${available}. ` +
					`Override the gate's verify[] in project.yaml::workflows to include this command if it's wanted.`,
				);
				continue; // drop this step
			}

			// Keep, with substituted component.
			if (component !== sAny.component) {
				filteredVerify.push({ ...s, component } as typeof s);
			} else {
				filteredVerify.push(s);
			}
		}
		if (filteredVerify.length === g.verify.length && !filteredVerify.some((s, i) => s !== g.verify![i])) {
			return g; // nothing changed in this gate
		}
		return { ...g, verify: filteredVerify };
	});

	if (!changed) return wf;
	return { ...wf, gates: newGates };
}

/**
 * Apply `substituteBuiltinComponent` across an array of builtin
 * workflows. Returns a new array (each entry is either the original
 * (no changes) or a substituted/pruned copy).
 */
export function substituteBuiltinComponents(
	workflows: Workflow[],
	primary: PrimaryComponent | string | undefined,
): Workflow[] {
	return workflows.map(wf => substituteBuiltinComponent(wf, primary));
}
