import { randomUUID } from "node:crypto";
import type { GateSignal, GateSignalStep, GateStore } from "./agent/gate-store.js";
import type { VerificationContentDigest, VerificationContentDigestErrorSummary } from "./agent/verification-content-digest.js";
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

export type GateCacheMissReason =
	| "no-prior-passed-signal"
	| "unknown-commit"
	| "content-digest-unavailable"
	| "content-digest-mismatch"
	| "invalidated"
	| "human-signoff";

export interface ReuseCachedGateSignalDecision {
	response?: GateSignalPostResponse;
	missReason?: GateCacheMissReason;
	priorSignalIds: string[];
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
	contentDigest?: VerificationContentDigest;
	contentDigestError?: VerificationContentDigestErrorSummary;
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

function validDigest(value: VerificationContentDigest | undefined): value is VerificationContentDigest {
	return value?.algorithm === "sha256"
		&& value.version === 1
		&& /^[a-f0-9]{64}$/.test(value.digest)
		&& Number.isSafeInteger(value.fileCount)
		&& value.fileCount >= 0;
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
 * Materialize a same-commit passed gate only when the live source-byte witness
 * exactly matches. Legacy and failed digest records deliberately fail closed.
 */
export function reuseCachedGateSignal(options: ReuseCachedGateSignalOptions): ReuseCachedGateSignalDecision {
	const {
		gateStore, goalId, gate, commitSha, contentDigest, contentDigestError,
		body = {}, notifier, clock = { now: Date.now }, createSignalId = randomUUID,
	} = options;
	if (commitSha === "unknown") return { missReason: "unknown-commit", priorSignalIds: [] };

	const gateState = gateStore.getGate(goalId, gate.id);
	if (!gateState) return { missReason: "no-prior-passed-signal", priorSignalIds: [] };
	const sameCommitPassed = gateState.signals.filter(signal =>
		signal.commitSha === commitSha && signal.verification.status === "passed",
	);
	if (sameCommitPassed.length === 0) return { missReason: "no-prior-passed-signal", priorSignalIds: [] };
	const invalidatedAt = gateState.verificationCacheInvalidatedAt;
	const postInvalidation = sameCommitPassed.filter(signal => invalidatedAt === undefined || signal.timestamp > invalidatedAt);
	if (postInvalidation.length === 0) return { missReason: "invalidated", priorSignalIds: sameCommitPassed.map(s => s.id) };
	const noHumanSignoff = postInvalidation.filter(signal => !signal.verification.steps.some(step => step.type === "human-signoff"));
	if (noHumanSignoff.length === 0) return { missReason: "human-signoff", priorSignalIds: postInvalidation.map(s => s.id) };
	if (contentDigestError || !validDigest(contentDigest)) return { missReason: "content-digest-unavailable", priorSignalIds: noHumanSignoff.map(s => s.id) };
	const validPriorPassed = noHumanSignoff.filter(signal => !signal.contentDigestError && validDigest(signal.contentDigest));
	const priorPassed = validPriorPassed.find(signal => signal.contentDigest!.digest === contentDigest.digest);
	if (!priorPassed) {
		// A valid but different witness proves a content change even when legacy
		// or failed-digest records are also present. Report unavailable only when
		// no usable prior witness exists at all.
		const missReason = validPriorPassed.length === 0
			? "content-digest-unavailable"
			: "content-digest-mismatch";
		return { missReason, priorSignalIds: noHumanSignoff.map(s => s.id) };
	}

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
		id: createSignalId(), gateId: gate.id, goalId, sessionId: body.sessionId ?? "unknown",
		timestamp: clock.now(), commitSha, metadata: body.metadata, content: body.content,
		contentVersion: body.content ? (gateState.currentContentVersion ?? 0) + 1 : undefined,
		contentDigest,
		verification: { status: "passed", steps: cachedSteps },
	};

	gateStore.recordSignal(cachedSignal);
	if (body.content && cachedSignal.contentVersion) gateStore.updateGateContent(goalId, gate.id, body.content, cachedSignal.contentVersion);
	if (body.metadata) gateStore.updateGateMetadata(goalId, gate.id, body.metadata);
	gateStore.updateGateStatus(goalId, gate.id, "passed");
	notifier.signalReceived(goalId, gate.id, cachedSignal.id);
	notifier.verificationComplete(goalId, gate.id, cachedSignal.id, "passed");
	notifier.statusChanged(goalId, gate.id, "passed");

	return {
		response: { signal: { id: cachedSignal.id, gateId: gate.id, goalId, status: "passed", steps: responseSteps(cachedSteps), cached: true } },
		priorSignalIds: [priorPassed.id],
	};
}
