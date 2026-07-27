import { normalizeWorkflow, type Workflow } from "./workflow-store.js";
import {
	SYSTEMS_INTERACTION_REVIEW_PROMPT_ID,
	resolveSystemsInteractionReviewContract,
} from "./systems-interaction-review-contract.js";

/**
 * Workflow validation shared by project workflow mutations, goal creation, and
 * frozen goal-workflow replacement.
 */

export interface WorkflowComponentRef {
	name: string;
	commands?: Record<string, string>;
}

export interface WorkflowValidationOptions {
	/**
	 * Goal snapshots may originate from a different workflow cascade layer than
	 * the goal's target project. They still require full shape/DAG validation,
	 * but their already-resolved component references must remain intact.
	 */
	validateComponentReferences?: boolean;
	/**
	 * Historical persisted goal snapshots are read directly and never enter this
	 * validator. This escape hatch is reserved for explicit legacy inspection
	 * tools; all authored definitions and newly frozen snapshots enforce the
	 * implementation-gate Systems review invariant by default.
	 */
	enforceSystemsInteractionReview?: boolean;
}

export interface ValidatorVerifyStep {
	name?: string;
	type?: string;
	component?: string;
	command?: string;
	run?: string;
	prompt?: string;
	promptRef?: string;
	promptId?: string;
	promptSha256?: string;
	resolvedPrompt?: string;
	role?: string;
	reviewGroup?: string;
	optional?: boolean;
	label?: string;
	optionalLabel?: string;
	/** Unknown at the raw boundary so callers can validate malformed input. */
	timeout?: unknown;
	phase?: number;
	expect?: string;
	description?: string;
	subgoal?: unknown;
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
	description?: string;
	gates?: ValidatorGate[];
	[k: string]: unknown;
}

/** Lowercase alphanumeric + hyphens. Dots would collide with template namespaces. */
export const WORKFLOW_ID_PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;

const STEP_TYPES = ["command", "llm-review", "agent-qa", "subgoal", "human-signoff"] as const;

export type WorkflowSystemsReviewInvariantCode =
	| "systems-review-missing"
	| "systems-review-duplicate"
	| "systems-review-invalid-step"
	| "systems-review-invalid-contract"
	| "specialist-phase-mismatch"
	| "command-phase-order"
	| "qa-phase-order";

/** Structured diagnostic used to block only new snapshots of incompatible workflows. */
export class WorkflowSystemsReviewInvariantError extends Error {
	readonly code: WorkflowSystemsReviewInvariantCode;
	readonly workflow: string;
	readonly gate = "implementation" as const;
	readonly stepIndex?: number;
	readonly stepName?: string;

	constructor(opts: {
		code: WorkflowSystemsReviewInvariantCode;
		workflow: string;
		message: string;
		stepIndex?: number;
		stepName?: string;
	}) {
		super(`Workflow "${opts.workflow}", gate "implementation": ${opts.message}`);
		this.name = "WorkflowSystemsReviewInvariantError";
		this.code = opts.code;
		this.workflow = opts.workflow;
		this.stepIndex = opts.stepIndex;
		this.stepName = opts.stepName;
	}
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(item => typeof item === "string");
}

/** Levenshtein distance — small helper for "Did you mean…" suggestions. */
function levenshtein(a: string, b: string): number {
	if (a === b) return 0;
	if (!a.length) return b.length;
	if (!b.length) return a.length;
	const prev = new Array<number>(b.length + 1);
	const curr = new Array<number>(b.length + 1);
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

function suggest(value: string, candidates: string[]): string | undefined {
	if (candidates.length === 0) return undefined;
	let best: string | undefined;
	let bestDist = Infinity;
	for (const candidate of candidates) {
		const distance = levenshtein(value.toLowerCase(), candidate.toLowerCase());
		if (distance < bestDist) {
			bestDist = distance;
			best = candidate;
		}
	}
	if (best === undefined) return undefined;
	return bestDist <= Math.max(2, Math.floor(value.length / 3)) ? best : undefined;
}

function workflowLabel(raw: unknown): string {
	return isPlainObject(raw) && typeof raw.id === "string" && raw.id ? raw.id : "(anonymous)";
}

function gateDependencies(gate: Record<string, unknown>): unknown {
	return Array.isArray(gate.depends_on) ? gate.depends_on : gate.dependsOn;
}

const SYSTEMS_REVIEW_STEP_NAME = "Systems interaction review";
const SYSTEMS_REVIEW_ROLE = "systems-reviewer";
const SPECIALIST_REVIEW_GROUP = "specialist";
const KNOWN_SPECIALIST_ROLES = new Set(["spec-auditor", "code-reviewer", "bug-hunter", "security-reviewer"]);
const KNOWN_SPECIALIST_NAMES = new Set([
	"gap analysis",
	"code quality review",
	"bug hunt",
	"security review",
	"regression test coverage",
	"e2e user journey coverage",
]);

function effectiveStepPhase(step: ValidatorVerifyStep): number {
	return typeof step.phase === "number" && Number.isInteger(step.phase) && step.phase >= 0 ? step.phase : 0;
}

function isKnownSpecialistStep(step: ValidatorVerifyStep): boolean {
	if ((step.type ?? "command") !== "llm-review") return false;
	if (step.reviewGroup === SPECIALIST_REVIEW_GROUP) return true;
	if (typeof step.role === "string" && KNOWN_SPECIALIST_ROLES.has(step.role)) return true;
	return typeof step.name === "string" && KNOWN_SPECIALIST_NAMES.has(step.name.trim().toLowerCase());
}

function looksLikeSystemsReviewStep(step: ValidatorVerifyStep): boolean {
	return step.name === SYSTEMS_REVIEW_STEP_NAME
		|| step.role === SYSTEMS_REVIEW_ROLE
		|| step.promptRef === SYSTEMS_INTERACTION_REVIEW_PROMPT_ID
		|| step.promptId === SYSTEMS_INTERACTION_REVIEW_PROMPT_ID;
}

function validateSystemsInteractionReviewGate(wfId: string, steps: ValidatorVerifyStep[]): Error[] {
	const errors: Error[] = [];
	const add = (
		code: WorkflowSystemsReviewInvariantCode,
		message: string,
		stepIndex?: number,
		stepName?: string,
	): void => {
		errors.push(new WorkflowSystemsReviewInvariantError({ code, workflow: wfId, message, stepIndex, stepName }));
	};
	const systemsCandidates = steps
		.map((step, index) => ({ step, index }))
		.filter(({ step }) => isPlainObject(step) && looksLikeSystemsReviewStep(step));

	if (systemsCandidates.length === 0) {
		add(
			"systems-review-missing",
			`missing mandatory "${SYSTEMS_REVIEW_STEP_NAME}" llm-review step. This workflow requires manual upgrade before it can be selected for a new goal.`,
		);
		return errors;
	}
	if (systemsCandidates.length > 1) {
		add(
			"systems-review-duplicate",
			`has ${systemsCandidates.length} Systems interaction review candidates; keep exactly one canonical mandatory step.`,
		);
		return errors;
	}

	const { step: systems, index: systemsIndex } = systemsCandidates[0];
	const systemsName = typeof systems.name === "string" ? systems.name : "";
	if (systems.name !== SYSTEMS_REVIEW_STEP_NAME
		|| systems.type !== "llm-review"
		|| systems.role !== SYSTEMS_REVIEW_ROLE
		|| systems.reviewGroup !== SPECIALIST_REVIEW_GROUP
		|| systems.optional === true
		|| systems.phase === undefined
		|| systems.prompt !== undefined) {
		add(
			"systems-review-invalid-step",
			`step ${systemsIndex + 1} ("${systemsName || "<unnamed>"}") must be a mandatory llm-review using role "${SYSTEMS_REVIEW_ROLE}", reviewGroup "${SPECIALIST_REVIEW_GROUP}", an explicit phase, and no inline prompt.`,
			systemsIndex,
			systemsName,
		);
	}

	let contract: { prompt: string; sha256: string };
	try {
		contract = resolveSystemsInteractionReviewContract(SYSTEMS_INTERACTION_REVIEW_PROMPT_ID);
	} catch (error) {
		add("systems-review-invalid-contract", `cannot resolve prompt contract "${SYSTEMS_INTERACTION_REVIEW_PROMPT_ID}": ${error instanceof Error ? error.message : String(error)}`);
		return errors;
	}
	const hasReference = systems.promptRef === SYSTEMS_INTERACTION_REVIEW_PROMPT_ID;
	const hasInvalidReference = systems.promptRef !== undefined && !hasReference;
	const snapshotFields = [systems.promptId, systems.promptSha256, systems.resolvedPrompt];
	const hasAnySnapshotField = snapshotFields.some(value => value !== undefined);
	const hasExactSnapshot = systems.promptId === SYSTEMS_INTERACTION_REVIEW_PROMPT_ID
		&& systems.promptSha256 === contract.sha256
		&& systems.resolvedPrompt === contract.prompt;
	if (hasInvalidReference || (!hasReference && !hasExactSnapshot) || (hasAnySnapshotField && !hasExactSnapshot)) {
		add(
			"systems-review-invalid-contract",
			`step ${systemsIndex + 1} must reference "${SYSTEMS_INTERACTION_REVIEW_PROMPT_ID}" or carry its exact immutable {promptId, promptSha256, resolvedPrompt} snapshot.`,
			systemsIndex,
			systemsName,
		);
	}

	const systemsPhase = effectiveStepPhase(systems);
	// Known shipped specialist roles/names remain recognizable while the boot
	// migration adds reviewGroup to legacy project definitions. Explicitly
	// grouped custom specialists are included too; unrelated LLM groups are not.
	const specialists = steps.filter(step => step === systems || (isPlainObject(step) && isKnownSpecialistStep(step)));
	const phaseMismatches = specialists.filter(step => effectiveStepPhase(step) !== systemsPhase);
	if (phaseMismatches.length > 0) {
		add(
			"specialist-phase-mismatch",
			`all specialist llm-review steps must share phase ${systemsPhase}; mismatched: ${phaseMismatches.map(step => `"${step.name ?? "<unnamed>"}"`).join(", ")}.`,
		);
	}

	const lateCommands = steps.filter(step => isPlainObject(step) && (step.type ?? "command") === "command" && effectiveStepPhase(step) >= systemsPhase);
	if (lateCommands.length > 0) {
		add(
			"command-phase-order",
			`all command steps must run before specialist phase ${systemsPhase}; not earlier: ${lateCommands.map(step => `"${step.name ?? "<unnamed>"}"`).join(", ")}.`,
		);
	}
	const earlyQa = steps.filter(step => isPlainObject(step) && step.type === "agent-qa" && effectiveStepPhase(step) <= systemsPhase);
	if (earlyQa.length > 0) {
		add(
			"qa-phase-order",
			`all agent-qa steps must remain after specialist phase ${systemsPhase}; not later: ${earlyQa.map(step => `"${step.name ?? "<unnamed>"}"`).join(", ")}.`,
		);
	}
	return errors;
}

/** Resolve authored prompt references exactly once into a newly frozen snapshot. */
function resolveSystemsInteractionReviewSnapshots(workflow: Workflow): Workflow {
	const clone = structuredClone(workflow);
	for (const gate of clone.gates) {
		if (gate.id !== "implementation") continue;
		for (const step of gate.verify ?? []) {
			if (step.name !== SYSTEMS_REVIEW_STEP_NAME || step.role !== SYSTEMS_REVIEW_ROLE) continue;
			if (step.promptRef !== SYSTEMS_INTERACTION_REVIEW_PROMPT_ID) continue;
			const contract = resolveSystemsInteractionReviewContract(step.promptRef);
			step.promptId = step.promptRef;
			step.promptSha256 = contract.sha256;
			step.resolvedPrompt = contract.prompt;
		}
	}
	return clone;
}

/**
 * Validate verification execution semantics and component/command references.
 * This entry point remains intentionally non-throwing for config diagnostics.
 */
function validateWorkflowSteps(
	wf: ValidatorWorkflow,
	components: WorkflowComponentRef[],
	validateComponentReferences: boolean,
	enforceSystemsInteractionReview: boolean,
): Error[] {
	const errors: Error[] = [];
	const wfId = typeof wf?.id === "string" && wf.id ? wf.id : "(anonymous)";
	const componentNames = components.map(c => c.name);
	const componentByName = new Map(components.map(c => [c.name, c]));
	const gates = Array.isArray(wf?.gates) ? wf.gates : [];

	for (const gate of gates) {
		if (!isPlainObject(gate)) continue;
		const gateId = typeof gate.id === "string" && gate.id ? gate.id : "(anonymous)";
		const steps = Array.isArray(gate.verify) ? gate.verify : [];

		for (let i = 0; i < steps.length; i++) {
			const step = steps[i];
			if (!isPlainObject(step)) continue;
			const stepName = typeof step.name === "string" ? step.name : "";
			const fail = (reason: string): void => {
				errors.push(new WorkflowResolveError({ workflow: wfId, gate: gateId, stepIndex: i, stepName, reason }));
			};

			if (step.optional === true && !step.optionalLabel && !step.label) {
				fail("step is optional: true but has no optionalLabel.");
			}

			const stepType = step.type ?? "command";
			const projectTokenIn = (value?: unknown): string | null => {
				if (typeof value !== "string" || !value) return null;
				const match = /\{\{\s*project\.([^}\s]+)\s*\}\}/.exec(value);
				return match ? match[1] : null;
			};
			const projectToken = projectTokenIn(step.run) ?? projectTokenIn(step.prompt);
			if (projectToken !== null) {
				fail(`uses removed token "{{project.${projectToken}}}". Replace command-shape steps with { component, command } structural refs (see docs/design/multi-repo-components.md §3.3).`);
				continue;
			}

			const hasComponent = isNonEmptyString(step.component);
			if (validateComponentReferences && hasComponent && !componentByName.has(step.component as string)) {
				const hint = suggest(step.component as string, componentNames);
				const tail = hint
					? ` Did you mean "${hint}"?`
					: componentNames.length === 0 ? "" : ` Available: ${componentNames.join(", ")}.`;
				fail(`component "${step.component}" not found in components[].${tail}`);
				continue;
			}

			if (stepType === "command") {
				const hasCommand = isNonEmptyString(step.command);
				const hasRun = isNonEmptyString(step.run);
				if (hasCommand && hasRun) {
					fail('type: command step has both "command" and "run" set; pick exactly one.');
					continue;
				}
				if (!hasCommand && !hasRun) {
					fail('type: command step has neither "command" nor "run" set; one is required.');
					continue;
				}
				if (hasCommand && !hasComponent) {
					fail('type: command step has "command" but no "component"; structural commands must reference a component.');
					continue;
				}
				if (validateComponentReferences && hasComponent && hasCommand) {
					const component = componentByName.get(step.component as string)!;
					const available = component.commands ? Object.keys(component.commands) : [];
					if (!component.commands || !(step.command as string in component.commands)) {
						const hint = suggest(step.command as string, available);
						const tail = hint
							? ` Did you mean "${hint}"?`
							: available.length === 0
								? ` Component "${component.name}" has no commands defined (data-only).`
								: ` Available: ${available.join(", ")}.`;
						fail(`component "${component.name}" has no command "${step.command}".${tail}`);
					}
				}
			} else if (stepType === "llm-review" || stepType === "agent-qa") {
				const contractBackedSystemsStep = gateId === "implementation"
					&& stepType === "llm-review"
					&& looksLikeSystemsReviewStep(step);
				if (!contractBackedSystemsStep && !isNonEmptyString(step.prompt)) {
					fail(`type: ${stepType} step requires a non-empty "prompt".`);
				}
				if (step.reviewGroup !== undefined && stepType !== "llm-review") {
					fail("reviewGroup is supported only on llm-review steps.");
				}
			} else if (stepType === "human-signoff") {
				if (!isNonEmptyString(step.prompt)) fail('type: human-signoff step requires a non-empty "prompt".');
				if (!isNonEmptyString(step.label)) fail('type: human-signoff step requires a non-empty "label".');
			} else if (stepType !== "subgoal") {
				fail(`unknown step type "${String(stepType)}"; expected one of: ${STEP_TYPES.join(", ")}.`);
			}
		}

		if (enforceSystemsInteractionReview && gateId === "implementation") {
			errors.push(...validateSystemsInteractionReviewGate(wfId, steps));
		}
	}
	return errors;
}

/**
 * Validate a complete raw workflow definition before alias normalization can
 * silently discard malformed fields. Returns all discovered errors.
 */
export function validateWorkflowDefinition(
	raw: unknown,
	components: WorkflowComponentRef[] = [],
	options: WorkflowValidationOptions = {},
): Error[] {
	const errors: Error[] = [];
	if (!isPlainObject(raw)) return [new Error("Workflow must be a plain object")];
	const wfId = workflowLabel(raw);
	const fail = (message: string): void => { errors.push(new Error(message)); };

	if (!isNonEmptyString(raw.id)) fail("Missing workflow id");
	else if (!WORKFLOW_ID_PATTERN.test(raw.id)) fail("Workflow id must be lowercase alphanumeric + hyphens (e.g. 'my-workflow')");
	if (!isNonEmptyString(raw.name)) fail("Missing workflow name");
	if (raw.description !== undefined && typeof raw.description !== "string") fail(`Workflow "${wfId}" description must be a string`);
	if (raw.hidden !== undefined && typeof raw.hidden !== "boolean") fail(`Workflow "${wfId}" hidden must be a boolean`);
	for (const timestamp of ["createdAt", "updatedAt"] as const) {
		if (raw[timestamp] !== undefined && (typeof raw[timestamp] !== "number" || !Number.isFinite(raw[timestamp]) || raw[timestamp] < 0)) {
			fail(`Workflow "${wfId}" ${timestamp} must be a finite non-negative number`);
		}
	}
	if (!Array.isArray(raw.gates) || raw.gates.length === 0) {
		fail("Workflow must have at least one gate");
		return errors;
	}

	const ids = new Set<string>();
	const gateRecords: Record<string, unknown>[] = [];
	const subgoals: Array<{ gateId: string; stepIndex: number; planId: string; dependsOn: string[] }> = [];
	for (let gateIndex = 0; gateIndex < raw.gates.length; gateIndex++) {
		const value = raw.gates[gateIndex];
		if (!isPlainObject(value)) {
			fail(`Workflow "${wfId}", gate ${gateIndex + 1}: gate must be a plain object`);
			continue;
		}
		gateRecords.push(value);
		const gateId = isNonEmptyString(value.id) ? value.id : `(gate ${gateIndex + 1})`;
		if (!isNonEmptyString(value.id)) fail("Each gate must have an id");
		else if (!WORKFLOW_ID_PATTERN.test(value.id)) fail(`Gate ID "${value.id}" must be lowercase alphanumeric + hyphens (e.g. 'issue-analysis')`);
		else if (ids.has(value.id)) fail(`Duplicate gate ID: "${value.id}"`);
		else ids.add(value.id);
		if (!isNonEmptyString(value.name)) fail(`Gate "${gateId}" must have a name`);

		for (const depField of ["dependsOn", "depends_on"] as const) {
			if (value[depField] !== undefined && !isStringArray(value[depField])) fail(`Gate "${gateId}" ${depField} must be an array of strings`);
		}
		const deps = gateDependencies(value);
		if (isStringArray(deps) && new Set(deps).size !== deps.length) fail(`Gate "${gateId}" has duplicate dependencies`);
		for (const boolField of ["content", "injectDownstream", "inject_downstream", "optional", "manual"] as const) {
			if (value[boolField] !== undefined && typeof value[boolField] !== "boolean") fail(`Gate "${gateId}" ${boolField} must be a boolean`);
		}
		if (value.metadata !== undefined) {
			if (!isPlainObject(value.metadata) || Object.values(value.metadata).some(item => typeof item !== "string")) {
				fail(`Gate "${gateId}" metadata must be an object with string values`);
			}
		}
		if (value.verify !== undefined && !Array.isArray(value.verify)) {
			fail(`Gate "${gateId}" verify must be an array`);
			continue;
		}

		const verifySteps = Array.isArray(value.verify) ? value.verify : [];
		for (let stepIndex = 0; stepIndex < verifySteps.length; stepIndex++) {
			const stepValue = verifySteps[stepIndex];
			if (!isPlainObject(stepValue)) {
				fail(`Workflow "${wfId}", gate "${gateId}", step ${stepIndex + 1}: step must be a plain object`);
				continue;
			}
			const prefix = `Workflow "${wfId}", gate "${gateId}", step ${stepIndex + 1}`;
			if (!isNonEmptyString(stepValue.name)) fail(`${prefix}: step must have a non-empty name`);
			const type = stepValue.type === undefined ? "command" : stepValue.type;
			for (const stringField of [
				"run", "prompt", "promptRef", "promptId", "promptSha256", "resolvedPrompt",
				"role", "reviewGroup", "label", "optionalLabel", "description", "component", "command",
			] as const) {
				if (stepValue[stringField] !== undefined && typeof stepValue[stringField] !== "string") fail(`${prefix}: ${stringField} must be a string`);
			}
			if (stepValue.reviewGroup !== undefined && type !== "llm-review") fail(`${prefix}: reviewGroup is supported only on llm-review steps`);
			const hasPromptContractField = stepValue.promptRef !== undefined
				|| stepValue.promptId !== undefined
				|| stepValue.promptSha256 !== undefined
				|| stepValue.resolvedPrompt !== undefined;
			if (hasPromptContractField && !(gateId === "implementation" && type === "llm-review" && looksLikeSystemsReviewStep(stepValue))) {
				fail(`${prefix}: prompt contract fields are reserved for the implementation gate's Systems interaction review`);
			}
			if (stepValue.optional !== undefined && typeof stepValue.optional !== "boolean") fail(`${prefix}: optional must be a boolean`);
			if (stepValue.expect !== undefined && stepValue.expect !== "success" && stepValue.expect !== "failure") fail(`${prefix}: expect must be "success" or "failure"`);
			if (stepValue.timeout !== undefined && (typeof stepValue.timeout !== "number" || !Number.isFinite(stepValue.timeout) || !Number.isInteger(stepValue.timeout) || stepValue.timeout <= 0)) {
				fail(`${prefix}: timeout must be a finite positive integer`);
			}
			if (stepValue.phase !== undefined && (typeof stepValue.phase !== "number" || !Number.isFinite(stepValue.phase) || !Number.isInteger(stepValue.phase) || stepValue.phase < 0)) {
				fail(`${prefix}: phase must be a finite non-negative integer`);
			}
			if (type === "subgoal") {
				if (!isPlainObject(stepValue.subgoal)) {
					fail(`${prefix}: type: subgoal step requires a "subgoal" object`);
				} else {
					const subgoal = stepValue.subgoal;
					for (const required of ["planId", "title", "spec"] as const) {
						if (!isNonEmptyString(subgoal[required])) fail(`${prefix}: subgoal.${required} must be a non-empty string`);
					}
					for (const optional of ["workflowId", "workflow_id", "suggestedRole", "suggested_role"] as const) {
						if (subgoal[optional] !== undefined && typeof subgoal[optional] !== "string") fail(`${prefix}: subgoal.${optional} must be a string`);
					}
					for (const depField of ["dependsOn", "depends_on"] as const) {
						if (subgoal[depField] !== undefined && !isStringArray(subgoal[depField])) fail(`${prefix}: subgoal.${depField} must be an array of strings`);
					}
					const dependsOn = Array.isArray(subgoal.dependsOn) ? subgoal.dependsOn : Array.isArray(subgoal.depends_on) ? subgoal.depends_on : [];
					if (isNonEmptyString(subgoal.planId) && isStringArray(dependsOn)) subgoals.push({ gateId, stepIndex, planId: subgoal.planId, dependsOn });
				}
			} else if (stepValue.subgoal !== undefined && !isPlainObject(stepValue.subgoal)) {
				fail(`${prefix}: subgoal must be a plain object`);
			}
		}
	}

	for (const gate of gateRecords) {
		if (!isNonEmptyString(gate.id)) continue;
		const deps = gateDependencies(gate);
		if (!isStringArray(deps)) continue;
		for (const dependency of deps) {
			if (dependency === gate.id) fail(`Gate "${gate.id}" depends on itself`);
			else if (!ids.has(dependency)) fail(`Gate "${gate.id}" depends on unknown "${dependency}"`);
		}
	}
	const gateMap = new Map(gateRecords.filter(g => isNonEmptyString(g.id)).map(g => [g.id as string, g]));
	const visited = new Set<string>();
	const visiting = new Set<string>();
	const visit = (id: string): void => {
		if (visited.has(id)) return;
		if (visiting.has(id)) throw new Error(`Circular dependency detected involving "${id}"`);
		visiting.add(id);
		const deps = gateDependencies(gateMap.get(id)!);
		if (isStringArray(deps)) for (const dep of deps) if (gateMap.has(dep)) visit(dep);
		visiting.delete(id);
		visited.add(id);
	};
	try { for (const id of gateMap.keys()) visit(id); } catch (error) { errors.push(error as Error); }

	const planIds = new Set<string>();
	for (const subgoal of subgoals) {
		if (planIds.has(subgoal.planId)) fail(`Duplicate subgoal planId: "${subgoal.planId}"`);
		planIds.add(subgoal.planId);
	}
	for (const subgoal of subgoals) {
		for (const dependency of subgoal.dependsOn) {
			if (dependency === subgoal.planId) fail(`Subgoal "${subgoal.planId}" depends on itself`);
			else if (!planIds.has(dependency)) fail(`Subgoal "${subgoal.planId}" depends on unknown "${dependency}"`);
		}
	}
	const subgoalById = new Map(subgoals.map(s => [s.planId, s]));
	const seenPlans = new Set<string>();
	const visitingPlans = new Set<string>();
	const visitPlan = (id: string): void => {
		if (seenPlans.has(id)) return;
		if (visitingPlans.has(id)) throw new Error(`Circular subgoal dependency detected involving "${id}"`);
		visitingPlans.add(id);
		for (const dep of subgoalById.get(id)?.dependsOn ?? []) if (subgoalById.has(dep)) visitPlan(dep);
		visitingPlans.delete(id);
		seenPlans.add(id);
	};
	try { for (const id of subgoalById.keys()) visitPlan(id); } catch (error) { errors.push(error as Error); }

	errors.push(...validateWorkflowSteps(
		raw as unknown as ValidatorWorkflow,
		components,
		options.validateComponentReferences !== false,
		options.enforceSystemsInteractionReview !== false,
	));
	return errors;
}

/** Back-compatible name for the shared full-definition validator. */
export function validateWorkflow(
	workflow: ValidatorWorkflow,
	components: WorkflowComponentRef[],
): Error[] {
	return validateWorkflowDefinition(workflow, components);
}

export function assertValidWorkflowDefinition(
	raw: unknown,
	components: WorkflowComponentRef[] = [],
	options: WorkflowValidationOptions = {},
): asserts raw is ValidatorWorkflow {
	const errors = validateWorkflowDefinition(raw, components, options);
	if (errors.length > 0) throw errors[0];
}

/** Validate raw input, normalize aliases, and deep-clone the canonical snapshot. */
export function freezeWorkflowDefinition(
	raw: unknown,
	components: WorkflowComponentRef[] = [],
	idHint = "",
	options: WorkflowValidationOptions = {},
): Workflow {
	assertValidWorkflowDefinition(raw, components, options);
	const normalized = normalizeWorkflow(raw, idHint);
	if (!normalized) throw new Error("Invalid workflow definition");
	return options.enforceSystemsInteractionReview === false
		? structuredClone(normalized)
		: resolveSystemsInteractionReviewSnapshots(normalized);
}

/** Validate every workflow in an inline workflows map. */
export function validateAllWorkflows(
	workflows: Record<string, ValidatorWorkflow> | undefined | null,
	components: WorkflowComponentRef[],
): Error[] {
	if (!workflows) return [];
	const errors: Error[] = [];
	for (const [id, workflow] of Object.entries(workflows)) {
		const enriched: ValidatorWorkflow = workflow.id ? workflow : { ...workflow, id };
		errors.push(...validateWorkflowDefinition(enriched, components));
	}
	return errors;
}
