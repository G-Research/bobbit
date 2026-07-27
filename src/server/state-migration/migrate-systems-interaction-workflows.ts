import { SYSTEMS_INTERACTION_REVIEW_PROMPT_ID } from "../agent/systems-interaction-review-contract.js";

/**
 * Forward migration for project-owned workflow definitions. Goal workflow
 * snapshots are deliberately outside this module and are never rewritten.
 */
export const SYSTEMS_INTERACTION_WORKFLOW_MIGRATION_VERSION = 1 as const;
export const SYSTEMS_INTERACTION_REVIEW_STEP_NAME = "Systems interaction review" as const;
export const SYSTEMS_INTERACTION_REVIEW_ROLE = "systems-reviewer" as const;
export const SPECIALIST_REVIEW_GROUP = "specialist" as const;

export type SystemsInteractionWorkflowMigrationDiagnosticCode =
	| "missing-specialist-review"
	| "ambiguous-specialist-phase"
	| "command-not-before-specialists"
	| "qa-not-after-specialists"
	| "conflicting-systems-review-step";

export interface SystemsInteractionWorkflowMigrationDiagnostic {
	version: typeof SYSTEMS_INTERACTION_WORKFLOW_MIGRATION_VERSION;
	status: "manual-upgrade-required";
	workflowId: string;
	gateId: "implementation";
	code: SystemsInteractionWorkflowMigrationDiagnosticCode;
	message: string;
	stepNames?: string[];
}

export interface SystemsInteractionWorkflowMigrationResult {
	workflows: Record<string, unknown>;
	changed: boolean;
	upgradedWorkflowIds: string[];
	diagnostics: SystemsInteractionWorkflowMigrationDiagnostic[];
}

const SPECIALIST_ROLES = new Set([
	"spec-auditor",
	"code-reviewer",
	"bug-hunter",
	"security-reviewer",
]);

const SPECIALIST_NAMES = new Set([
	"gap analysis",
	"code quality review",
	"bug hunt",
	"security review",
	"regression test coverage",
	"e2e user journey coverage",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function phaseOf(step: Record<string, unknown>): number {
	return typeof step.phase === "number" && Number.isInteger(step.phase) && step.phase >= 0
		? step.phase
		: 0;
}

function stepName(step: Record<string, unknown>): string {
	return typeof step.name === "string" ? step.name : "<unnamed>";
}

function isKnownSpecialist(step: Record<string, unknown>): boolean {
	if (step.type !== "llm-review") return false;
	if (step.reviewGroup === SPECIALIST_REVIEW_GROUP) return true;
	if (typeof step.role === "string" && SPECIALIST_ROLES.has(step.role)) return true;
	return typeof step.name === "string" && SPECIALIST_NAMES.has(step.name.trim().toLowerCase());
}

function isCanonicalSystemsStep(step: Record<string, unknown>): boolean {
	return step.name === SYSTEMS_INTERACTION_REVIEW_STEP_NAME
		&& step.type === "llm-review"
		&& step.role === SYSTEMS_INTERACTION_REVIEW_ROLE
		&& step.reviewGroup === SPECIALIST_REVIEW_GROUP
		&& step.promptRef === SYSTEMS_INTERACTION_REVIEW_PROMPT_ID
		&& typeof step.phase === "number"
		&& Number.isInteger(step.phase)
		&& step.phase >= 0
		&& step.optional !== true
		&& step.prompt === undefined
		&& step.promptId === undefined
		&& step.promptSha256 === undefined
		&& step.resolvedPrompt === undefined;
}

function looksLikeSystemsStep(step: Record<string, unknown>): boolean {
	return step.name === SYSTEMS_INTERACTION_REVIEW_STEP_NAME
		|| step.role === SYSTEMS_INTERACTION_REVIEW_ROLE
		|| step.promptRef === SYSTEMS_INTERACTION_REVIEW_PROMPT_ID;
}

function diagnostic(
	workflowId: string,
	code: SystemsInteractionWorkflowMigrationDiagnosticCode,
	message: string,
	stepNames?: string[],
): SystemsInteractionWorkflowMigrationDiagnostic {
	return {
		version: SYSTEMS_INTERACTION_WORKFLOW_MIGRATION_VERSION,
		status: "manual-upgrade-required",
		workflowId,
		gateId: "implementation",
		code,
		message,
		...(stepNames && stepNames.length > 0 ? { stepNames } : {}),
	};
}

function migrateImplementationGate(
	workflowId: string,
	gate: Record<string, unknown>,
): { gate?: Record<string, unknown>; diagnostics: SystemsInteractionWorkflowMigrationDiagnostic[]; changed: boolean } {
	const verify = Array.isArray(gate.verify) ? gate.verify : [];
	const steps = verify.filter(isRecord);
	if (steps.length !== verify.length) {
		return {
			changed: false,
			diagnostics: [diagnostic(
				workflowId,
				"conflicting-systems-review-step",
				"The implementation gate contains a malformed verification step; repair it before adding the Systems interaction review.",
			)],
		};
	}

	const systemsLike = steps.filter(looksLikeSystemsStep);
	if (systemsLike.length > 1 || (systemsLike.length === 1 && !isCanonicalSystemsStep(systemsLike[0]))) {
		return {
			changed: false,
			diagnostics: [diagnostic(
				workflowId,
				"conflicting-systems-review-step",
				`The implementation gate has ${systemsLike.length > 1 ? "multiple" : "a non-canonical"} Systems interaction review candidate. Keep exactly one mandatory llm-review step using role systems-reviewer, reviewGroup specialist, and the v1 promptRef.`,
				systemsLike.map(stepName),
			)],
		};
	}

	const existingSystems = systemsLike[0];
	const peers = steps.filter(step => step !== existingSystems && isKnownSpecialist(step));
	if (!existingSystems && peers.length === 0) {
		return {
			changed: false,
			diagnostics: [diagnostic(
				workflowId,
				"missing-specialist-review",
				"The implementation gate has no recognized specialist LLM review from which a safe concurrent phase can be inferred. Add and phase the Systems interaction review manually.",
			)],
		};
	}

	const specialistPhases = new Set(peers.map(phaseOf));
	if (existingSystems) specialistPhases.add(phaseOf(existingSystems));
	if (specialistPhases.size !== 1) {
		return {
			changed: false,
			diagnostics: [diagnostic(
				workflowId,
				"ambiguous-specialist-phase",
				"Recognized specialist LLM reviews do not share one phase. Put all specialist reviews in one concurrent phase before upgrading.",
				[...peers, ...(existingSystems ? [existingSystems] : [])].map(stepName),
			)],
		};
	}
	const specialistPhase = specialistPhases.values().next().value as number;

	const lateCommands = steps.filter(step => step.type === "command" && phaseOf(step) >= specialistPhase);
	if (lateCommands.length > 0) {
		return {
			changed: false,
			diagnostics: [diagnostic(
				workflowId,
				"command-not-before-specialists",
				"Every implementation command must run in a phase before the concurrent specialist reviews.",
				lateCommands.map(stepName),
			)],
		};
	}

	const earlyQa = steps.filter(step => step.type === "agent-qa" && phaseOf(step) <= specialistPhase);
	if (earlyQa.length > 0) {
		return {
			changed: false,
			diagnostics: [diagnostic(
				workflowId,
				"qa-not-after-specialists",
				"Every agent-qa step must remain in a later phase than the concurrent specialist reviews.",
				earlyQa.map(stepName),
			)],
		};
	}

	let changed = false;
	const migratedSteps = steps.map(step => {
		if (step === existingSystems || !peers.includes(step) || step.reviewGroup === SPECIALIST_REVIEW_GROUP) return step;
		changed = true;
		return { ...step, reviewGroup: SPECIALIST_REVIEW_GROUP };
	});

	if (!existingSystems) {
		changed = true;
		const insertionIndex = migratedSteps.reduce(
			(last, step, index) => isKnownSpecialist(step) ? index + 1 : last,
			0,
		);
		migratedSteps.splice(insertionIndex, 0, {
			name: SYSTEMS_INTERACTION_REVIEW_STEP_NAME,
			type: "llm-review",
			role: SYSTEMS_INTERACTION_REVIEW_ROLE,
			phase: specialistPhase,
			reviewGroup: SPECIALIST_REVIEW_GROUP,
			promptRef: SYSTEMS_INTERACTION_REVIEW_PROMPT_ID,
		});
	}

	return {
		changed,
		diagnostics: [],
		gate: changed ? { ...gate, verify: migratedSteps } : gate,
	};
}

/**
 * Upgrade compatible project workflow definitions without guessing at custom
 * phase semantics. A workflow is transactional: if any implementation gate is
 * ambiguous, none of that workflow is rewritten and a structured diagnostic is
 * returned for boot logging and manual repair.
 */
export function migrateSystemsInteractionWorkflows(
	workflows: Record<string, unknown>,
): SystemsInteractionWorkflowMigrationResult {
	const next: Record<string, unknown> = { ...workflows };
	const diagnostics: SystemsInteractionWorkflowMigrationDiagnostic[] = [];
	const upgradedWorkflowIds: string[] = [];

	for (const [mapId, rawWorkflow] of Object.entries(workflows)) {
		if (!isRecord(rawWorkflow) || !Array.isArray(rawWorkflow.gates)) continue;
		const workflowId = typeof rawWorkflow.id === "string" && rawWorkflow.id ? rawWorkflow.id : mapId;
		const migratedGates: unknown[] = [];
		const workflowDiagnostics: SystemsInteractionWorkflowMigrationDiagnostic[] = [];
		let changed = false;

		for (const rawGate of rawWorkflow.gates) {
			if (!isRecord(rawGate) || rawGate.id !== "implementation") {
				migratedGates.push(rawGate);
				continue;
			}
			const result = migrateImplementationGate(workflowId, rawGate);
			workflowDiagnostics.push(...result.diagnostics);
			changed ||= result.changed;
			migratedGates.push(result.gate ?? rawGate);
		}

		if (workflowDiagnostics.length > 0) {
			diagnostics.push(...workflowDiagnostics);
			continue;
		}
		if (changed) {
			next[mapId] = { ...rawWorkflow, gates: migratedGates };
			upgradedWorkflowIds.push(workflowId);
		}
	}

	return {
		workflows: next,
		changed: upgradedWorkflowIds.length > 0,
		upgradedWorkflowIds,
		diagnostics,
	};
}
