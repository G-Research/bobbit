import { randomUUID } from "node:crypto";
import type { GateSignal, GateSignalStep, GateStore } from "./agent/gate-store.js";
import type { WorkflowGate } from "./agent/workflow-store.js";

export const GATE_SIGNAL_AGENT_REMINDER = "Gate signal accepted. Verification is running asynchronously. Do not poll with `gate_status` or `gate_inspect`. Go idle now and wait for the server to deliver verification results or further instructions.";

export interface GateSignalResponseStep {
	name: string;
	type: GateSignalStep["type"];
	status: GateSignalStep["status"];
	passed: boolean;
	skipped?: boolean;
	phase?: number;
	duration_ms: number;
	output: string;
}

export interface GateSignalPostResponse {
	signal: {
		id: string;
		gateId: string;
		goalId: string;
		status: "running" | "passed" | "failed";
		steps: GateSignalResponseStep[];
		cached?: true;
	};
	agentReminder?: string;
}

export interface CachedGateSignalNotifier {
	signalReceived(goalId: string, gateId: string, signalId: string): void;
	verificationComplete(goalId: string, gateId: string, signalId: string, status: "passed"): void;
	statusChanged(goalId: string, gateId: string, status: "passed"): void;
}

export interface GateSignalDecisionClock {
	now(): number;
}

interface CachedGateSignalBody {
	sessionId?: string;
	metadata?: Record<string, string>;
	content?: string;
}

interface ReuseCachedGateSignalOptions {
	gateStore: GateStore;
	goalId: string;
	gate: WorkflowGate;
	commitSha: string;
	body?: CachedGateSignalBody;
	notifier: CachedGateSignalNotifier;
	clock?: GateSignalDecisionClock;
	createSignalId?: () => string;
}

function responseSteps(steps: GateSignalStep[]): GateSignalResponseStep[] {
	return steps.map((step) => ({
		name: step.name,
		type: step.type,
		status: step.status,
		passed: step.passed,
		skipped: step.skipped,
		phase: step.phase,
		duration_ms: step.duration_ms,
		output: step.output,
	}));
}

export function buildRunningGateSignalResponse(
	signal: GateSignal,
	verificationIsRunning: boolean,
): GateSignalPostResponse {
	const response: GateSignalPostResponse = {
		signal: {
			id: signal.id,
			gateId: signal.gateId,
			goalId: signal.goalId,
			status: signal.verification.status,
			steps: responseSteps(signal.verification.steps),
		},
	};
	if (verificationIsRunning) response.agentReminder = GATE_SIGNAL_AGENT_REMINDER;
	return response;
}

/**
 * Reuse a passed verification for the same commit and materialize the exact
 * persisted signal/API response used by the gate-signal route. Returns
 * undefined when the request must continue through normal verification.
 */
export function reuseCachedGateSignal(options: ReuseCachedGateSignalOptions): GateSignalPostResponse | undefined {
	const {
		gateStore,
		goalId,
		gate,
		commitSha,
		body = {},
		notifier,
		clock = { now: Date.now },
		createSignalId = randomUUID,
	} = options;
	if (commitSha === "unknown") return undefined;

	const gateState = gateStore.getGate(goalId, gate.id);
	if (!gateState) return undefined;
	const invalidatedAt = gateState.verificationCacheInvalidatedAt;
	const priorPassed = gateState.signals.find((signal) =>
		signal.commitSha === commitSha
		&& signal.verification.status === "passed"
		&& (invalidatedAt === undefined || signal.timestamp > invalidatedAt)
		&& !signal.verification.steps.some((step) => step.type === "human-signoff")
	);
	if (!priorPassed) return undefined;

	const phaseByStepName = new Map((gate.verify ?? []).map((step) => [step.name, step.phase ?? 0]));
	const cachedSteps = priorPassed.verification.steps.map((step): GateSignalStep => {
		const status = step.skipped ? "skipped" : (step.status ?? (step.passed ? "passed" : "failed"));
		return {
			...step,
			status,
			...(status === "skipped" ? { skipped: true } : {}),
			phase: step.phase ?? phaseByStepName.get(step.name) ?? 0,
			output: `[cached from prior signal] ${step.output}`,
		};
	});
	const cachedSignal: GateSignal = {
		id: createSignalId(),
		gateId: gate.id,
		goalId,
		sessionId: body.sessionId ?? "unknown",
		timestamp: clock.now(),
		commitSha,
		metadata: body.metadata,
		content: body.content,
		contentVersion: body.content ? (gateState.currentContentVersion ?? 0) + 1 : undefined,
		verification: { status: "passed", steps: cachedSteps },
	};

	gateStore.recordSignal(cachedSignal);
	if (body.content && cachedSignal.contentVersion) {
		gateStore.updateGateContent(goalId, gate.id, body.content, cachedSignal.contentVersion);
	}
	if (body.metadata) gateStore.updateGateMetadata(goalId, gate.id, body.metadata);
	gateStore.updateGateStatus(goalId, gate.id, "passed");
	notifier.signalReceived(goalId, gate.id, cachedSignal.id);
	notifier.verificationComplete(goalId, gate.id, cachedSignal.id, "passed");
	notifier.statusChanged(goalId, gate.id, "passed");

	return {
		signal: {
			id: cachedSignal.id,
			gateId: gate.id,
			goalId,
			status: "passed",
			steps: responseSteps(cachedSteps),
			cached: true,
		},
	};
}
