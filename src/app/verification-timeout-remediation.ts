import { gatewayFetch } from "./gateway-fetch.js";
import { state } from "./state.js";

export interface VerificationTimeoutTarget {
	goalId: string;
	gateId: string;
	stepName: string;
}

export interface VerificationTimeoutContext extends VerificationTimeoutTarget {
	projectId: string;
	projectName: string;
	workflowId: string;
	goalWorkflow: WorkflowDefinition;
}

export interface WorkflowDefinition extends Record<string, unknown> {
	id: string;
	gates: WorkflowGateDefinition[];
	origin?: string;
}

interface WorkflowGateDefinition extends Record<string, unknown> {
	id: string;
	verify?: VerificationStepDefinition[];
}

interface VerificationStepDefinition extends Record<string, unknown> {
	name: string;
	timeout?: number;
}

export class VerificationTimeoutRemediationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "VerificationTimeoutRemediationError";
	}
}

async function responseError(response: Response, fallback: string): Promise<VerificationTimeoutRemediationError> {
	let message = fallback;
	try {
		const body = await response.json();
		if (typeof body?.error === "string" && body.error.trim()) message = body.error;
		else if (typeof body?.message === "string" && body.message.trim()) message = body.message;
	} catch {
		// The status-aware fallback remains useful for non-JSON failures.
	}
	return new VerificationTimeoutRemediationError(message);
}

async function readJson(response: Response, fallback: string): Promise<any> {
	if (!response.ok) throw await responseError(response, fallback);
	try {
		return await response.json();
	} catch {
		throw new VerificationTimeoutRemediationError(`${fallback}: invalid server response`);
	}
}

function assertWorkflow(value: unknown, label: string): asserts value is WorkflowDefinition {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new VerificationTimeoutRemediationError(`${label} is unavailable`);
	}
	const workflow = value as Partial<WorkflowDefinition>;
	if (typeof workflow.id !== "string" || !workflow.id || !Array.isArray(workflow.gates)) {
		throw new VerificationTimeoutRemediationError(`${label} is incomplete`);
	}
}

/** Patch exactly one named verification step without mutating the source workflow. */
export function patchVerificationTimeout(
	workflow: WorkflowDefinition,
	gateId: string,
	stepName: string,
	timeoutSeconds: number,
): WorkflowDefinition {
	if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds <= 0) {
		throw new VerificationTimeoutRemediationError("Timeout must be a positive whole number of seconds");
	}

	const gateMatches = workflow.gates
		.map((gate, index) => ({ gate, index }))
		.filter(({ gate }) => gate?.id === gateId);
	if (gateMatches.length !== 1) {
		throw new VerificationTimeoutRemediationError(
			gateMatches.length === 0
				? `Gate "${gateId}" was not found in the workflow`
				: `Gate "${gateId}" is ambiguous in the workflow`,
		);
	}

	const { gate, index: gateIndex } = gateMatches[0];
	const verify = Array.isArray(gate.verify) ? gate.verify : [];
	const stepMatches = verify
		.map((step, index) => ({ step, index }))
		.filter(({ step }) => step?.name === stepName);
	if (stepMatches.length !== 1) {
		throw new VerificationTimeoutRemediationError(
			stepMatches.length === 0
				? `Verification step "${stepName}" was not found in gate "${gateId}"`
				: `Verification step "${stepName}" is ambiguous in gate "${gateId}"`,
		);
	}

	const stepIndex = stepMatches[0].index;
	const nextVerify = verify.map((step, index) => index === stepIndex ? { ...step, timeout: timeoutSeconds } : step);
	const nextGates = workflow.gates.map((candidate, index) => index === gateIndex ? { ...gate, verify: nextVerify } : candidate);
	return { ...workflow, gates: nextGates };
}

/** Fetch the active goal snapshot exactly once when the remediation dialog opens. */
export async function loadVerificationTimeoutContext(target: VerificationTimeoutTarget): Promise<VerificationTimeoutContext> {
	const response = await gatewayFetch(`/api/goals/${encodeURIComponent(target.goalId)}`);
	const goal = await readJson(response, `Unable to load goal (${response.status})`);
	const projectId = typeof goal?.projectId === "string" ? goal.projectId : "";
	if (!projectId) throw new VerificationTimeoutRemediationError("The goal has no project context");
	assertWorkflow(goal?.workflow, "The goal workflow");

	const projectName = state.projects.find(project => project.id === projectId)?.name
		|| (typeof goal?.projectName === "string" ? goal.projectName : "")
		|| (typeof goal?.project?.name === "string" ? goal.project.name : "")
		|| projectId;
	return {
		...target,
		projectId,
		projectName,
		workflowId: goal.workflow.id,
		goalWorkflow: goal.workflow,
	};
}

export async function updateCurrentGoalVerificationTimeout(
	context: VerificationTimeoutContext,
	timeoutSeconds: number,
): Promise<void> {
	const workflow = patchVerificationTimeout(
		context.goalWorkflow,
		context.gateId,
		context.stepName,
		timeoutSeconds,
	);
	const response = await gatewayFetch(`/api/goals/${encodeURIComponent(context.goalId)}/workflow`, {
		method: "PUT",
		body: JSON.stringify(workflow),
	});
	if (!response.ok) throw await responseError(response, `Unable to update this goal (${response.status})`);
}

export async function updateFutureGoalsVerificationTimeout(
	context: VerificationTimeoutContext,
	timeoutSeconds: number,
): Promise<void> {
	const workflowPath = `/api/workflows/${encodeURIComponent(context.workflowId)}?projectId=${encodeURIComponent(context.projectId)}`;
	const fetchedResponse = await gatewayFetch(workflowPath);
	let projectWorkflow = await readJson(fetchedResponse, `Unable to load the project workflow (${fetchedResponse.status})`);
	assertWorkflow(projectWorkflow, "The project workflow");

	if (projectWorkflow.origin !== "project") {
		const customizeResponse = await gatewayFetch(
			`/api/workflows/${encodeURIComponent(context.workflowId)}/customize?projectId=${encodeURIComponent(context.projectId)}`,
			{ method: "POST" },
		);
		const customized = await readJson(customizeResponse, `Unable to customize the project workflow (${customizeResponse.status})`);
		assertWorkflow(customized, "The customized project workflow");
		projectWorkflow = customized;
	}

	const workflow = patchVerificationTimeout(
		projectWorkflow,
		context.gateId,
		context.stepName,
		timeoutSeconds,
	);
	const updateResponse = await gatewayFetch(workflowPath, {
		method: "PUT",
		body: JSON.stringify(workflow),
	});
	if (!updateResponse.ok) {
		throw await responseError(updateResponse, `Unable to update future goals (${updateResponse.status})`);
	}
}
