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

const LIVE_LOG_READ_MAX_BYTES = 256 * 1024;
const LIVE_LOG_TAIL_CHUNK_BYTES = 16 * 1024;

export type GateVerificationSnapshotStatus = "passed" | "failed" | "skipped" | "running" | "waiting" | "blocked";

/** Thrown when a `stepName` filter does not match any verification step. Maps to a 400. */
export class UnknownVerificationStepError extends Error {
	availableSteps: string[];
	constructor(stepName: string, availableSteps: string[]) {
		super(`Unknown verification step "${stepName}". Available steps: ${availableSteps.join(", ")}`);
		this.name = "UnknownVerificationStepError";
		this.availableSteps = availableSteps;
	}
}

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

interface BoundedLiveLogRead {
	text: string;
	truncated: boolean;
	truncationReason?: string;
}

function combineTruncationReasons(reasons: Array<string | undefined>): string | undefined {
	const unique = [...new Set(reasons.filter((reason): reason is string => !!reason))];
	return unique.length ? unique.join("; ") : undefined;
}

function readFromStart(filePath: string, maxBytes: number): BoundedLiveLogRead {
	let fd: number | undefined;
	try {
		const stat = fs.statSync(filePath);
		if (!stat.isFile() || stat.size <= 0) return { text: "", truncated: false };
		const bytesToRead = Math.min(stat.size, maxBytes);
		const buffer = Buffer.allocUnsafe(bytesToRead);
		fd = fs.openSync(filePath, "r");
		const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, 0);
		const truncated = stat.size > bytesRead;
		return {
			text: buffer.subarray(0, bytesRead).toString("utf8"),
			truncated,
			truncationReason: truncated ? `live log read bounded to first ${bytesRead} bytes before selection` : undefined,
		};
	} catch {
		return { text: "", truncated: false };
	} finally {
		if (fd !== undefined) {
			try { fs.closeSync(fd); } catch { /* ignore close failure */ }
		}
	}
}

function countLineFeeds(buffer: Buffer): number {
	let count = 0;
	for (const byte of buffer) if (byte === 10) count++;
	return count;
}

function readTailByLines(filePath: string, lines: number, maxBytes: number): BoundedLiveLogRead {
	let fd: number | undefined;
	try {
		const stat = fs.statSync(filePath);
		if (!stat.isFile() || stat.size <= 0) return { text: "", truncated: false };
		fd = fs.openSync(filePath, "r");
		const chunks: Buffer[] = [];
		let position = stat.size;
		let bytesReadTotal = 0;
		let lineFeeds = 0;
		const targetLineFeeds = Math.max(lines, 1);

		while (position > 0 && bytesReadTotal < maxBytes && lineFeeds <= targetLineFeeds) {
			const bytesToRead = Math.min(LIVE_LOG_TAIL_CHUNK_BYTES, position, maxBytes - bytesReadTotal);
			const buffer = Buffer.allocUnsafe(bytesToRead);
			position -= bytesToRead;
			const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, position);
			const chunk = buffer.subarray(0, bytesRead);
			chunks.unshift(chunk);
			bytesReadTotal += bytesRead;
			lineFeeds += countLineFeeds(chunk);
			if (bytesRead === 0) break;
		}

		const truncated = position > 0;
		return {
			text: Buffer.concat(chunks).toString("utf8"),
			truncated,
			truncationReason: truncated ? `live log read bounded to last ${bytesReadTotal} bytes before selection` : undefined,
		};
	} catch {
		return { text: "", truncated: false };
	} finally {
		if (fd !== undefined) {
			try { fs.closeSync(fd); } catch { /* ignore close failure */ }
		}
	}
}

function readBoundedLiveLog(filePath: string | undefined, selectionOptions: TextSelectionOptions): BoundedLiveLogRead {
	if (!filePath) return { text: "", truncated: false };
	if (selectionOptions.mode === "tail") {
		return readTailByLines(filePath, selectionOptions.lines ?? 20, LIVE_LOG_READ_MAX_BYTES);
	}
	return readFromStart(filePath, LIVE_LOG_READ_MAX_BYTES);
}

function trimTrailingNewlines(text: string): string {
	return text.replace(/(?:\r?\n)+$/, "");
}

function prefixLogLines(label: "stdout" | "stderr", text: string): string {
	return text.split(/\r?\n/).map(line => `[${label}] ${line}`).join("\n");
}

function composeLiveLogOutput(stdout: string, stderr: string): string {
	if (stdout && stderr) return [prefixLogLines("stdout", stdout), prefixLogLines("stderr", stderr)].join("\n");
	return stdout || stderr;
}

function readLiveCommandOutput(
	activeStep: ActiveVerification["steps"][number],
	selectionOptions: TextSelectionOptions,
): { output: string; liveLogs?: { stdout: boolean; stderr: boolean }; truncationReason?: string } {
	const stdoutRead = readBoundedLiveLog(activeStep.outFile, selectionOptions);
	const stderrRead = readBoundedLiveLog(activeStep.errFile, selectionOptions);
	const stdout = trimTrailingNewlines(stdoutRead.text);
	const stderr = trimTrailingNewlines(stderrRead.text);
	const hasStdout = stdout.length > 0;
	const hasStderr = stderr.length > 0;
	const truncationReason = combineTruncationReasons([stdoutRead.truncationReason, stderrRead.truncationReason]);
	if (hasStdout || hasStderr) {
		return {
			output: composeLiveLogOutput(stdout, stderr),
			liveLogs: { stdout: !!activeStep.outFile, stderr: !!activeStep.errFile },
			truncationReason,
		};
	}
	return {
		output: activeStep.output || "",
		liveLogs: activeStep.outFile || activeStep.errFile ? { stdout: !!activeStep.outFile, stderr: !!activeStep.errFile } : undefined,
		truncationReason,
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
	stepName?: string;
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
		let liveLogTruncationReason: string | undefined;
		const sessionId = activeStep?.sessionId;

		if (activeStep) {
			if (isBlockedByEarlierFailure(activeStep, rawPersistedOutput, priorFailure)) {
				status = "blocked";
			} else {
				status = activeStep.status;
			}
			if (activeStep.status === "running") {
				durationMs = runningDurationMs(activeStep, now);
				const live = activeStep.type === "command" ? readLiveCommandOutput(activeStep, selectionOptions) : { output: activeStep.output || rawPersistedOutput };
				rawOutput = live.output;
				liveLogs = live.liveLogs;
				liveLogTruncationReason = live.truncationReason;
			} else {
				durationMs = activeStep.durationMs ?? persisted.duration_ms;
				rawOutput = activeStep.output ?? rawPersistedOutput;
				if (activeStep.type === "command" && (activeStep.outFile || activeStep.errFile)) liveLogs = { stdout: !!activeStep.outFile, stderr: !!activeStep.errFile };
			}
		} else {
			status = finalStatusFromPersisted(persisted, input.verification?.status);
		}

		const selected = selectText(rawOutput, selectionOptions);
		const selection = liveLogTruncationReason
			? {
				...selected.selection,
				truncated: true,
				truncationReason: selected.selection.truncationReason
					? `${liveLogTruncationReason}; ${selected.selection.truncationReason}`
					: liveLogTruncationReason,
			}
			: selected.selection;
		aggregateTotalLines += selection.totalLines;
		if (status === "failed") priorFailure = true;

		const out: GateVerificationSnapshotStep = {
			name: persisted.name,
			type: persisted.type,
			status,
			duration_ms: durationMs,
			output: selected.text,
			selection,
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

	// Narrow to a single named step when requested. Blocked/prior-failure state is
	// already computed during the full map above; we only filter what is returned and
	// re-run the aggregate budget over the single step so per-step selection is preserved.
	let finalSteps = steps;
	let totalLines = aggregateTotalLines;
	if (input.stepName !== undefined) {
		const matched = steps.find(step => step.name === input.stepName);
		if (!matched) throw new UnknownVerificationStepError(input.stepName, steps.map(step => step.name));
		finalSteps = [matched];
		totalLines = matched.selection?.totalLines ?? 0;
	}

	const aggregate = enforceGateVerificationAggregateOutputBudget(finalSteps);
	const counts: Record<GateVerificationSnapshotStatus, number> = {
		passed: 0,
		failed: 0,
		skipped: 0,
		running: 0,
		waiting: 0,
		blocked: 0,
	};
	for (const step of finalSteps) counts[step.status]++;

	return {
		status: active?.overallStatus ?? input.verification?.status,
		steps: finalSteps,
		counts,
		summary: buildSummary(counts),
		selection: {
			mode: selectionOptions.mode ?? "tail",
			totalLines,
			truncated: aggregate.truncated,
			truncationReason: aggregate.truncationReason,
		},
		active: !!active,
	};
}
