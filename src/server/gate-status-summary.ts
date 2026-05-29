import type { GateState, GateStatus } from "./agent/gate-store.js";
import type { ActiveVerification } from "./agent/verification-harness.js";
import type { Workflow } from "./agent/workflow-store.js";

export type GateEffectiveStatus = GateStatus | "running";

export interface GateStatusSummaryGate {
	gateId: string;
	name?: string;
	status: GateStatus;
	effectiveStatus: GateEffectiveStatus;
	running: boolean;
	awaitingSignoffCount: number;
	dependsOn: string[];
	signalCount: number;
	updatedAt?: number;
	failedSteps?: string[];
}

export interface GateStatusSummary {
	passed: number;
	total: number;
	verifying: boolean;
	verifyingCount: number;
	awaitingSignoffCount: number;
	awaitingHumanSignoff: boolean;
	runningGateIds: string[];
	gates: GateStatusSummaryGate[];
}

interface GateStatusSummaryInput {
	workflow?: Pick<Workflow, "gates">;
	gates: GateState[];
	activeVerifications: ActiveVerification[];
}

function failedStepNames(gate: GateState): string[] | undefined {
	if (gate.status !== "failed") return undefined;
	const latest = gate.signals[gate.signals.length - 1];
	const failed = latest?.verification?.steps
		?.filter(step => !step.passed && !step.skipped)
		.map(step => step.name) ?? [];
	return failed.length > 0 ? failed : undefined;
}

/**
 * Build the authoritative gate progress summary from server truth.
 *
 * Stored gate state owns pass/fail/pending. ActiveVerification owns in-flight
 * and awaiting-human state, which may not be present on `/gates?view=summary`
 * rows if clients try to infer it from slim signal payloads.
 */
export function buildGateStatusSummary(input: GateStatusSummaryInput): GateStatusSummary {
	const gateById = new Map(input.gates.map(gate => [gate.gateId, gate]));
	const workflowGates = input.workflow?.gates ?? input.gates.map(gate => ({ id: gate.gateId, name: gate.gateId, dependsOn: [] as string[] }));
	const runningByGate = new Map<string, number>();
	const awaitingByGate = new Map<string, number>();

	for (const verification of input.activeVerifications) {
		if (verification.cancelled || verification.overallStatus !== "running") continue;
		runningByGate.set(verification.gateId, (runningByGate.get(verification.gateId) ?? 0) + 1);
		const awaitingCount = verification.steps.filter(step => step.awaitingHuman).length;
		if (awaitingCount > 0) {
			awaitingByGate.set(verification.gateId, (awaitingByGate.get(verification.gateId) ?? 0) + awaitingCount);
		}
	}

	const summaryGates: GateStatusSummaryGate[] = workflowGates.map(def => {
		const stored = gateById.get(def.id);
		const status = stored?.status ?? "pending";
		const running = (runningByGate.get(def.id) ?? 0) > 0;
		const awaitingSignoffCount = awaitingByGate.get(def.id) ?? 0;
		const gate: GateStatusSummaryGate = {
			gateId: def.id,
			name: def.name,
			status,
			effectiveStatus: running ? "running" : status,
			running,
			awaitingSignoffCount,
			dependsOn: def.dependsOn || [],
			signalCount: stored?.signals.length ?? 0,
		};
		if (stored?.signals.length) gate.updatedAt = stored.updatedAt;
		const failedSteps = stored ? failedStepNames(stored) : undefined;
		if (failedSteps) gate.failedSteps = failedSteps;
		return gate;
	});

	const runningGateIds = summaryGates.filter(gate => gate.running).map(gate => gate.gateId);
	const awaitingSignoffCount = summaryGates.reduce((sum, gate) => sum + gate.awaitingSignoffCount, 0);

	return {
		passed: summaryGates.filter(gate => gate.status === "passed").length,
		total: summaryGates.length,
		verifying: runningGateIds.length > 0,
		verifyingCount: runningGateIds.length,
		awaitingSignoffCount,
		awaitingHumanSignoff: awaitingSignoffCount > 0,
		runningGateIds,
		gates: summaryGates,
	};
}
