import type { PersistedGoal } from "../agent/goal-store.js";
import {
	checkCanSpawnChild,
	readSubgoalNestingPrefs,
} from "../agent/subgoal-nesting-limit.js";
import type { Workflow } from "../agent/workflow-store.js";
import { validateGoalInlineWorkflow } from "./proposal-types.js";

export type GoalProposalValidationError = {
	ok: false;
	code: string;
	message: string;
	availableWorkflows?: { id: string; name: string }[];
	validOptionalSteps?: string[];
};

export interface GoalProposalSeedSession {
	role?: string;
	teamGoalId?: string;
}

export interface PrepareGoalProposalSeedDeps {
	/** The live session only. Persisted sessions must not gain parent injection. */
	session?: GoalProposalSeedSession;
	/** Workflows resolved from the proposal's target project. */
	workflows: Workflow[];
	getGoal(id: string): PersistedGoal | undefined;
	getPreference(key: string): unknown;
}

export type PrepareGoalProposalSeedResult =
	| { ok: true; status: 200; args: Record<string, unknown> }
	| { ok: false; status: 400; body: GoalProposalValidationError };

/**
 * Prepare the goal-specific portion of the proposal seed route without owning
 * transport, session-manager, or project-context state. The HTTP route resolves
 * and stamps the target project first, then delegates parent injection and
 * workflow validation here.
 */
export function prepareGoalProposalSeed(
	args: Record<string, unknown>,
	deps: PrepareGoalProposalSeedDeps,
): PrepareGoalProposalSeedResult {
	let enrichedArgs = args;
	const session = deps.session;
	if (session?.role === "team-lead" && session.teamGoalId) {
		const existingParent = enrichedArgs.parentGoalId;
		if (!existingParent || (typeof existingParent === "string" && existingParent.trim() === "")) {
			const parent = deps.getGoal(session.teamGoalId);
			const targetProjectId = typeof enrichedArgs.projectId === "string" && enrichedArgs.projectId.trim().length > 0
				? enrichedArgs.projectId.trim()
				: undefined;
			const sameProjectParent = !!parent && (!targetProjectId || parent.projectId === targetProjectId);
			const preferences = readSubgoalNestingPrefs(deps.getPreference);
			const canSpawnImplicitChild = !!parent && sameProjectParent && checkCanSpawnChild(
				parent,
				preferences,
				deps.getGoal,
			).ok;
			if (canSpawnImplicitChild) {
				enrichedArgs = { ...enrichedArgs, parentGoalId: session.teamGoalId };
			}
		}
	}

	const validationError = validateGoalProposalWorkflow(enrichedArgs, deps.workflows);
	return validationError
		? { ok: false, status: 400, body: validationError }
		: { ok: true, status: 200, args: enrichedArgs };
}

/**
 * Validate a goal proposal's `workflow` / `inlineWorkflow` / `options` args.
 * Returns a structured route error, or null when the proposal is valid.
 */
export function validateGoalProposalWorkflow(
	args: Record<string, unknown>,
	workflows: Workflow[],
): GoalProposalValidationError | null {
	const inlineWorkflow = args.inlineWorkflow;
	if (inlineWorkflow !== undefined && inlineWorkflow !== null) {
		const inlineError = validateGoalInlineWorkflow(inlineWorkflow);
		if (inlineError) return inlineError;
		return validateGoalProposalOptions(args, inlineWorkflow as Workflow);
	}

	if (workflows.length === 0) return null;

	const workflowId = typeof args.workflow === "string" ? args.workflow.trim() : "";
	const availableWorkflows = workflows.map(workflow => ({ id: workflow.id, name: workflow.name }));
	const availableIds = availableWorkflows.map(workflow => workflow.id).join(", ");
	if (!workflowId) {
		return {
			ok: false,
			code: "MISSING_WORKFLOW",
			message: `Workflow is required for this project. Re-call propose_goal with one of these workflow IDs: ${availableIds}.`,
			availableWorkflows,
		};
	}

	const selectedWorkflow = workflows.find(workflow => workflow.id === workflowId);
	if (!selectedWorkflow) {
		return {
			ok: false,
			code: "UNKNOWN_WORKFLOW",
			message: `Unknown workflow "${workflowId}". Available workflows for this project: ${availableIds}. Re-call propose_goal with one of these IDs.`,
			availableWorkflows,
		};
	}

	return validateGoalProposalOptions(args, selectedWorkflow);
}

function validateGoalProposalOptions(
	args: Record<string, unknown>,
	workflow: Workflow,
): GoalProposalValidationError | null {
	const options = typeof args.options === "string" ? args.options : "";
	const requested = options.split(",").map(option => option.trim()).filter(Boolean);
	if (requested.length === 0) return null;

	const validNames = new Set<string>();
	for (const gate of workflow.gates) {
		for (const step of gate.verify ?? []) {
			if (step.optional === true) validNames.add(step.name);
		}
	}
	const validOptionalSteps = [...validNames];
	const unknown = requested.filter(option => !validNames.has(option));
	if (unknown.length === 0) return null;
	return {
		ok: false,
		code: "UNKNOWN_OPTIONAL_STEP",
		message: `Unknown optional step(s) [${unknown.join(", ")}] for workflow "${workflow.id}". Valid optional steps: ${validOptionalSteps.length ? validOptionalSteps.join(", ") : "(none)"}.`,
		validOptionalSteps,
	};
}
