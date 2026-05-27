/**
 * Workflow validator — load-time structural checks for inline `workflows:` blocks.
 *
 * See docs/design/multi-repo-components.md §3.4.
 *
 * Two entry points:
 *   - validateWorkflow(wf, components)  → returns array of errors for one workflow
 *   - validateAllWorkflows(map, components) → aggregates across all workflows
 *
 * Errors carry the structured location (`workflow`, `gate`, `step`) plus a
 * human-readable message in the canonical format used in user-facing
 * surfaces:
 *
 *   Workflow "general", gate "implementation", step 3:
 *     component "apii" not found in components[]. Did you mean "api"?
 */

export interface WorkflowComponentRef {
	name: string;
	commands?: Record<string, string>;
}

export interface ValidatorVerifyStep {
	name?: string;
	type?: string;
	component?: string;
	command?: string;
	run?: string;
	prompt?: string;
	role?: string;
	optional?: boolean;
	/** Human-signoff card title. Legacy optional-step toggle label may still appear here on old configs. */
	label?: string;
	/** Optional-step opt-in toggle label (canonical after the label/optionalLabel split). */
	optionalLabel?: string;
	[k: string]: unknown;
}

export interface ValidatorGate {
	id?: string;
	name?: string;
	dependsOn?: string[];
	depends_on?: string[];
	verify?: ValidatorVerifyStep[];
	[k: string]: unknown;
}

export interface ValidatorWorkflow {
	id?: string;
	name?: string;
	gates?: ValidatorGate[];
	[k: string]: unknown;
}

export class WorkflowResolveError extends Error {
	readonly workflow: string;
	readonly gate: string;
	readonly stepIndex: number;
	readonly stepName: string;
	readonly reason: string;

	constructor(opts: {
		workflow: string;
		gate: string;
		stepIndex: number;
		stepName: string;
		reason: string;
	}) {
		const stepLabel = opts.stepName ? `${opts.stepIndex + 1} ("${opts.stepName}")` : `${opts.stepIndex + 1}`;
		super(`Workflow "${opts.workflow}", gate "${opts.gate}", step ${stepLabel}: ${opts.reason}`);
		this.name = "WorkflowResolveError";
		this.workflow = opts.workflow;
		this.gate = opts.gate;
		this.stepIndex = opts.stepIndex;
		this.stepName = opts.stepName;
		this.reason = opts.reason;
	}
}

/** Levenshtein distance — small helper for "Did you mean…" suggestions. */
function levenshtein(a: string, b: string): number {
	if (a === b) return 0;
	if (!a.length) return b.length;
	if (!b.length) return a.length;
	const prev = new Array(b.length + 1);
	const curr = new Array(b.length + 1);
	for (let j = 0; j <= b.length; j++) prev[j] = j;
	for (let i = 1; i <= a.length; i++) {
		curr[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
		}
		for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
	}
	return prev[b.length];
}

/** Pick the closest candidate (≤2 edits) or undefined. */
function suggest(value: string, candidates: string[]): string | undefined {
	if (candidates.length === 0) return undefined;
	let best: string | undefined;
	let bestDist = Infinity;
	for (const c of candidates) {
		const d = levenshtein(value.toLowerCase(), c.toLowerCase());
		if (d < bestDist) {
			bestDist = d;
			best = c;
		}
	}
	if (best === undefined) return undefined;
	const threshold = Math.max(2, Math.floor(value.length / 3));
	return bestDist <= threshold ? best : undefined;
}

/**
 * Validate a single workflow against the project's component list.
 *
 * Returns an array of WorkflowResolveError; an empty array means valid.
 * The validator deliberately does NOT throw — callers may wish to collect
 * errors across all workflows before surfacing them.
 */
export function validateWorkflow(
	wf: ValidatorWorkflow,
	components: WorkflowComponentRef[],
): WorkflowResolveError[] {
	const errors: WorkflowResolveError[] = [];
	const wfId = wf.id ?? "(anonymous)";
	const componentNames = components.map(c => c.name);
	const componentByName = new Map(components.map(c => [c.name, c]));

	for (const gate of wf.gates ?? []) {
		const gateId = gate.id ?? "(anonymous)";
		const steps = gate.verify ?? [];

		for (let i = 0; i < steps.length; i++) {
			const step = steps[i];
			const stepName = step.name ?? "";

			const fail = (reason: string): void => {
				errors.push(new WorkflowResolveError({
					workflow: wfId,
					gate: gateId,
					stepIndex: i,
					stepName,
					reason,
				}));
			};

			// `optional: true` requires a goal-creation toggle label. The canonical
			// field is `optionalLabel`; accept legacy `label` as a backwards-compatible
			// read path for old configs that have not yet been migrated by
			// workflow-store::normalizeStep.
			if (step.optional === true && !step.optionalLabel && !step.label) {
				fail(`step is optional: true but has no optionalLabel.`);
			}

			const stepType = step.type ?? "command";

			// Phase 2 (multi-repo): the {{project.X}} token namespace is removed.
			// Structural { component, command } refs replace it. Free-form
			// `run:` strings that still mention {{project.X}} are flagged as
			// errors so the user converts them.  Other tokens (e.g. {{branch}},
			// {{agent.X}}, {{<gate>.meta.X}}) pass through.
			const projectTokenIn = (s?: string): string | null => {
				if (!s) return null;
				const m = /\{\{\s*project\.([^}\s]+)\s*\}\}/.exec(s);
				return m ? m[1] : null;
			};
			const projectTok = projectTokenIn(step.run) ?? projectTokenIn(step.prompt);
			if (projectTok !== null) {
				fail(`uses removed token "{{project.${projectTok}}}". Replace command-shape steps with { component, command } structural refs (see docs/design/multi-repo-components.md §3.3).`);
				continue;
			}

			if (stepType === "command") {
				const hasComponent = typeof step.component === "string" && step.component.length > 0;
				const hasCommand = typeof step.command === "string" && step.command.length > 0;
				const hasRun = typeof step.run === "string" && step.run.length > 0;

				if (hasCommand && hasRun) {
					fail(`type: command step has both "command" and "run" set; pick exactly one.`);
					continue;
				}
				if (!hasCommand && !hasRun) {
					fail(`type: command step has neither "command" nor "run" set; one is required.`);
					continue;
				}
				if (hasCommand && !hasComponent) {
					fail(`type: command step has "command" but no "component"; structural commands must reference a component.`);
					continue;
				}

				if (hasComponent) {
					const c = componentByName.get(step.component as string);
					if (!c) {
						const hint = suggest(step.component as string, componentNames);
						const tail = hint
							? ` Did you mean "${hint}"?`
							: componentNames.length === 0
								? ""
								: ` Available: ${componentNames.join(", ")}.`;
						fail(`component "${step.component}" not found in components[].${tail}`);
						continue;
					}
					if (hasCommand) {
						const available = c.commands ? Object.keys(c.commands) : [];
						if (!c.commands || !(step.command as string in c.commands)) {
							const hint = suggest(step.command as string, available);
							const tail = hint
								? ` Did you mean "${hint}"?`
								: available.length === 0
									? ` Component "${c.name}" has no commands defined (data-only).`
									: ` Available: ${available.join(", ")}.`;
							fail(`component "${c.name}" has no command "${step.command}".${tail}`);
							continue;
						}
					}
				}
			} else if (stepType === "llm-review" || stepType === "agent-qa") {
				if (typeof step.prompt !== "string" || step.prompt.length === 0) {
					fail(`type: ${stepType} step requires a non-empty "prompt".`);
				}
			} else if (stepType === "human-signoff") {
				// Human sign-off steps surface to the user via the goal-status widget;
				// the prompt is rendered as markdown context and the label is shown as
				// the card header. Both are mandatory.
				if (typeof step.prompt !== "string" || step.prompt.length === 0) {
					fail(`type: human-signoff step requires a non-empty "prompt".`);
				}
				if (typeof step.label !== "string" || step.label.length === 0) {
					fail(`type: human-signoff step requires a non-empty "label".`);
				}
			} else {
				fail(`unknown step type "${stepType}"; expected one of: command, llm-review, agent-qa, human-signoff.`);
			}
		}
	}

	return errors;
}

/**
 * Validate a full `workflows:` map against the project's component list.
 * Aggregates errors across every workflow.
 */
export function validateAllWorkflows(
	workflows: Record<string, ValidatorWorkflow> | undefined | null,
	components: WorkflowComponentRef[],
): WorkflowResolveError[] {
	if (!workflows) return [];
	const errors: WorkflowResolveError[] = [];
	for (const [id, wf] of Object.entries(workflows)) {
		const enriched: ValidatorWorkflow = wf.id ? wf : { ...wf, id };
		errors.push(...validateWorkflow(enriched, components));
	}
	return errors;
}
