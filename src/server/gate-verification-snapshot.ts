import fs from "node:fs";

import type { GateSignal } from "./agent/gate-store.js";
import type { ActiveVerification } from "./agent/verification-harness.js";
import {
	MAX_SELECTED_BYTES,
	MAX_SELECTED_LINES,
	selectText,
	truncateTextToBudget,
	type TextSelectionMetadata,
	type TextSelectionOptions,
} from "./utils/text-selection.js";

export type GateVerificationSnapshotStatus = "passed" | "failed" | "skipped" | "running" | "waiting" | "blocked";

export interface GateVerificationSnapshotStep {
	name: string;
	type: string;
	status: GateVerificationSnapshotStatus;
	passed?: boolean | null;
	skipped?: boolean;
	duration_ms?: number;
	output?: string;
	selection?: TextSelectionMetadata;
	phase?: number;
	sessionId?: string;
	session?: { id: string; href: string };
	liveLogs?: { stdout: boolean; stderr: boolean };
}

export interface GateVerificationSnapshot {
	status?: GateSignal["verification"]["status"] | ActiveVerification["overallStatus"];
	steps: GateVerificationSnapshotStep[];
	counts: Record<GateVerificationSnapshotStatus, number>;
	summary: string;
	selection: TextSelectionMetadata & { truncationReason?: string };
	active: boolean;
}

interface GateInspectOutputStep {
	output?: string;
	selection?: TextSelectionMetadata;
}

export function enforceGateVerificationAggregateOutputBudget(steps: GateInspectOutputStep[]): { truncated: boolean; truncationReason?: string } {
	let remainingLines = MAX_SELECTED_LINES;
	let remainingBytes = MAX_SELECTED_BYTES;
	let truncated = false;
	let truncationReason: string | undefined;

	for (const step of steps) {
		if (typeof step.output !== "string" || step.output.length === 0) continue;
		if (remainingLines <= 0 || remainingBytes <= 0) {
			step.output = "";
			truncated = true;
			truncationReason = truncationReason || `aggregate selected output exceeded ${MAX_SELECTED_LINES} line/${MAX_SELECTED_BYTES} byte budget`;
			if (step.selection) step.selection = { ...step.selection, truncated: true, truncationReason };
			continue;
		}
		const capped = truncateTextToBudget(step.output, remainingLines, remainingBytes);
		step.output = capped.text;
		remainingLines -= capped.lines;
		remainingBytes -= capped.bytes;
		if (capped.truncated) {
			truncated = true;
			truncationReason = capped.truncationReason || `aggregate selected output exceeded ${MAX_SELECTED_LINES} line/${MAX_SELECTED_BYTES} byte budget`;
			if (step.selection) step.selection = { ...step.selection, truncated: true, truncationReason };
		}
	}

	return { truncated, truncationReason };
}

export function gateVerificationDefaultSelection(options: TextSelectionOptions = {}): TextSelectionOptions {
	if (options.implicitDefault || options.mode === undefined) {
		return { ...options, mode: "tail", lines: options.lines ?? 20 };
	}
	return options;
}

function readOptionalFile(filePath: string | undefined): string {
	if (!filePath) return "";
	try { return fs.readFileSync(filePath, "utf8"); } catch { return ""; }
}

function readLiveCommandOutput(activeStep: ActiveVerification["steps"][number]): { output: string; liveLogs?: { stdout: boolean; stderr: boolean } } {
	const stdout = readOptionalFile(activeStep.outFile).replace(/(?:\r?\n)+$/, "");
	const stderr = readOptionalFile(activeStep.errFile).replace(/(?:\r?\n)+$/, "");
	const hasStdout = stdout.length > 0;
	const hasStderr = stderr.length > 0;
	if (hasStdout || hasStderr) {
		return {
			output: [stdout, stderr].filter(Boolean).join("\n"),
			liveLogs: { stdout: !!activeStep.outFile, stderr: !!activeStep.errFile },
		};
	}
	return {
		output: activeStep.output || "",
		liveLogs: activeStep.outFile || activeStep.errFile ? { stdout: !!activeStep.outFile, stderr: !!activeStep.errFile } : undefined,
	};
}

function isBlockedByEarlierFailure(activeStep: ActiveVerification["steps"][number] | undefined, persistedOutput: string, priorFailure: boolean): boolean {
	if (!activeStep) return false;
	if (activeStep.status === "skipped" && /earlier phase failed/i.test(activeStep.output || persistedOutput)) return true;
	return activeStep.status === "waiting" && priorFailure;
}

function finalStatusFromPersisted(step: GateSignal["verification"]["steps"][number], verificationStatus?: GateSignal["verification"]["status"]): GateVerificationSnapshotStatus {
	if (verificationStatus === "running" && (step.status === "running" || step.status === "waiting")) return step.status;
	if (step.status === "passed" || step.status === "failed" || step.status === "skipped") return step.status;
	if (step.skipped) return "skipped";
	return step.passed ? "passed" : "failed";
}

function shouldExposePassed(status: GateVerificationSnapshotStatus): boolean {
	return status === "passed" || status === "failed" || status === "skipped";
}

function runningDurationMs(activeStep: ActiveVerification["steps"][number], now: number): number {
	const elapsed = activeStep.startedAt ? Math.max(0, now - activeStep.startedAt) : 0;
	return Math.max(activeStep.durationMs ?? 0, elapsed);
}

function buildSummary(counts: Record<GateVerificationSnapshotStatus, number>): string {
	const order: GateVerificationSnapshotStatus[] = ["passed", "failed", "skipped", "running", "waiting", "blocked"];
	const parts = order.filter(status => counts[status] > 0).map(status => `${counts[status]} ${status}`);
	return parts.length ? parts.join(", ") : "0 steps";
}

export function buildGateVerificationSnapshot(input: {
	goalId: string;
	gateId: string;
	signalId: string;
	verification?: GateSignal["verification"];
	activeVerification?: ActiveVerification;
	selectionOptions?: TextSelectionOptions;
	now?: number;
}): GateVerificationSnapshot {
	const now = input.now ?? Date.now();
	const selectionOptions = gateVerificationDefaultSelection(input.selectionOptions ?? { implicitDefault: true });
	const active = input.activeVerification
		&& input.activeVerification.goalId === input.goalId
		&& input.activeVerification.gateId === input.gateId
		&& input.activeVerification.signalId === input.signalId
		? input.activeVerification
		: undefined;
	const persistedSteps = input.verification?.steps ?? [];
	const activeByName = new Map((active?.steps ?? []).map(step => [step.name, step]));
	let priorFailure = false;
	let aggregateTotalLines = 0;

	const steps = persistedSteps.map((persisted, index): GateVerificationSnapshotStep => {
		const activeStep = active?.steps[index]?.name === persisted.name ? active.steps[index] : activeByName.get(persisted.name);
		const rawPersistedOutput = typeof persisted.output === "string" ? persisted.output : "";
		let status: GateVerificationSnapshotStatus;
		let rawOutput = rawPersistedOutput;
		let durationMs = persisted.duration_ms;
		let liveLogs: GateVerificationSnapshotStep["liveLogs"];
		const sessionId = activeStep?.sessionId;

		if (activeStep) {
			if (isBlockedByEarlierFailure(activeStep, rawPersistedOutput, priorFailure)) {
				status = "blocked";
			} else {
				status = activeStep.status;
			}
			if (activeStep.status === "running") {
				durationMs = runningDurationMs(activeStep, now);
				const live = activeStep.type === "command" ? readLiveCommandOutput(activeStep) : { output: activeStep.output || rawPersistedOutput };
				rawOutput = live.output;
				liveLogs = live.liveLogs;
			} else {
				durationMs = activeStep.durationMs ?? persisted.duration_ms;
				rawOutput = activeStep.output ?? rawPersistedOutput;
				if (activeStep.type === "command" && (activeStep.outFile || activeStep.errFile)) liveLogs = { stdout: !!activeStep.outFile, stderr: !!activeStep.errFile };
			}
		} else {
			status = finalStatusFromPersisted(persisted, input.verification?.status);
		}

		const selected = selectText(rawOutput, selectionOptions);
		aggregateTotalLines += selected.selection.totalLines;
		if (status === "failed") priorFailure = true;

		const out: GateVerificationSnapshotStep = {
			name: persisted.name,
			type: persisted.type,
			status,
			duration_ms: durationMs,
			output: selected.text,
			selection: selected.selection,
		};
		if (shouldExposePassed(status)) out.passed = status === "passed" || (status === "skipped" && persisted.passed === true);
		if (status === "skipped" || status === "blocked" || persisted.skipped) out.skipped = true;
		const phase = activeStep?.phase ?? persisted.phase;
		if (phase !== undefined) out.phase = phase;
		if (sessionId) {
			out.sessionId = sessionId;
			out.session = { id: sessionId, href: `/sessions/${encodeURIComponent(sessionId)}` };
		}
		if (liveLogs) out.liveLogs = liveLogs;
		return out;
	});

	const aggregate = enforceGateVerificationAggregateOutputBudget(steps);
	const counts: Record<GateVerificationSnapshotStatus, number> = {
		passed: 0,
		failed: 0,
		skipped: 0,
		running: 0,
		waiting: 0,
		blocked: 0,
	};
	for (const step of steps) counts[step.status]++;

	return {
		status: active?.overallStatus ?? input.verification?.status,
		steps,
		counts,
		summary: buildSummary(counts),
		selection: {
			mode: selectionOptions.mode ?? "tail",
			totalLines: aggregateTotalLines,
			truncated: aggregate.truncated,
			truncationReason: aggregate.truncationReason,
		},
		active: !!active,
	};
}
