import type { GateState, GateStatus, VerificationCancellationCause } from "./agent/gate-store.js";
import type { ActiveVerification } from "./agent/verification-harness.js";
import type { Workflow } from "./agent/workflow-store.js";

export type GateEffectiveStatus = GateStatus | "running";

/**
 * Slim a gate for the gate-LIST endpoint (`GET /api/goals/:id/gates`).
 *
 * The list endpoint previously returned the entire signal history with full
 * inline step output, artifact bodies, and diagnostics — a payload that grows
 * unbounded with gates × signals × steps and is re-serialized by the client on
 * every poll tick. This projection strips the heavy fields so the list stays
 * lightweight; full step text is fetched lazily on expand via the gate-DETAIL
 * / verification-snapshot / inspect paths (which are unaffected).
 *
 * For every signal step it: blanks `output`, deletes `artifact.content` (keeps
 * `artifact.contentType` + `artifact.metadata` so the UI still knows an
 * artifact exists), and deletes `diagnostics`. All other fields — step
 * name/type/status/passed/skipped/duration_ms/phase and signal-level
 * metadata/content/timestamp — are preserved.
 *
 * The input is NOT mutated: a structured deep clone is returned so the
 * in-memory gate store keeps its full fidelity.
 */
export function projectGateForList<T extends { signals: any[] }>(gate: T): T {
	const clone: T = typeof structuredClone === "function"
		? structuredClone(gate)
		: JSON.parse(JSON.stringify(gate));
	for (const signal of clone.signals ?? []) {
		const steps = signal?.verification?.steps;
		if (!Array.isArray(steps)) continue;
		for (const step of steps) {
			if (step == null) continue;
			step.output = "";
			if (step.artifact && typeof step.artifact === "object") {
				delete step.artifact.content;
			}
			delete step.diagnostics;
		}
	}
	return clone;
}

/**
 * The latest terminal cancellation, projected without turning the gate itself
 * into a failed state. `requestedAt` is optional only for legacy records that
 * predate durable cancellation provenance.
 */
export interface GateStatusSummaryCancellation {
	cause: VerificationCancellationCause;
	requestedAt?: number;
	finalizedAt?: number;
}

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
	/** The latest signal was cancelled; gate `status` remains eligible/pending. */
	verificationStatus?: "cancelled";
	cancellation?: GateStatusSummaryCancellation;
}

export interface GateStatusSummary {
	passed: number;
	/** Count of gates forced past verification via human bypass. */
	bypassed: number;
	/** Alias of `bypassed` (spec references both names). */
	bypassedCount: number;
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

function mostRecentFailedSignal(gate: GateState): GateState["signals"][number] | undefined {
	for (let index = gate.signals.length - 1; index >= 0; index--) {
		const signal = gate.signals[index];
		if (signal?.verification.status === "failed") return signal;
	}
	return undefined;
}

function failedStepNames(signal: GateState["signals"][number] | undefined): string[] | undefined {
	const failed = signal?.verification.steps
		.filter(step => !step.passed && !step.skipped)
		.map(step => step.name) ?? [];
	return failed.length > 0 ? failed : undefined;
}

/**
 * Old persisted cancellations did not retain provenance. Surface those records
 * neutrally as `unknown` instead of deriving a cause from a kill reason.
 */
function latestCancellation(gate: GateState): GateStatusSummaryCancellation | undefined {
	const verification = gate.signals[gate.signals.length - 1]?.verification as {
		status?: string;
		cancellation?: GateStatusSummaryCancellation;
	} | undefined;
	if (verification?.status !== "cancelled") return undefined;
	return verification.cancellation ?? { cause: "unknown" };
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
		const cancellation = stored ? latestCancellation(stored) : undefined;
		// A cancellation cannot itself fail a gate. It may, however, follow a
		// genuine failed verification; retain that durable prior verdict instead of
		// letting the latest run erase the failure from the summary.
		const failedSignal = stored ? mostRecentFailedSignal(stored) : undefined;
		const status = cancellation && stored?.status === "failed" && !failedSignal
			? "pending"
			: (stored?.status ?? "pending");
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
		if (cancellation) {
			gate.verificationStatus = "cancelled";
			gate.cancellation = cancellation;
		}
		if (stored?.signals.length) gate.updatedAt = stored.updatedAt;
		const failedSteps = status === "failed" ? failedStepNames(failedSignal) : undefined;
		if (failedSteps) gate.failedSteps = failedSteps;
		return gate;
	});

	const runningGateIds = summaryGates.filter(gate => gate.running).map(gate => gate.gateId);
	const awaitingSignoffCount = summaryGates.reduce((sum, gate) => sum + gate.awaitingSignoffCount, 0);

	const bypassed = summaryGates.filter(gate => gate.status === "bypassed").length;
	return {
		passed: summaryGates.filter(gate => gate.status === "passed").length,
		bypassed,
		bypassedCount: bypassed,
		total: summaryGates.length,
		verifying: runningGateIds.length > 0,
		verifyingCount: runningGateIds.length,
		awaitingSignoffCount,
		awaitingHumanSignoff: awaitingSignoffCount > 0,
		runningGateIds,
		gates: summaryGates,
	};
}
