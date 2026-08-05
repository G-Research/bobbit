import fs from "node:fs";
import path from "node:path";

import type { GateSignal, VerificationTimeoutInfo } from "./agent/gate-store.js";
import type { GateStepDiagnostics } from "./gate-diagnostics.js";
import { buildArtifactIndex, type GateArtifactIndex } from "./gate-artifacts.js";
import { selectGateTextStream, selectManagedGatePayload, type ManagedPayloadSelectionResult } from "./agent/gate-store-v2-persistence.js";
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

export type GateVerificationSnapshotStatus = "passed" | "failed" | "timeout" | "skipped" | "running" | "waiting" | "blocked";

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
	timeout?: VerificationTimeoutInfo;
	output?: string;
	selection?: TextSelectionMetadata;
	phase?: number;
	/** Authoritative marker for an active human-signoff step awaiting input. */
	awaitingHuman?: true;
	/** Human-readable sign-off label, exposed only with `awaitingHuman`. */
	humanLabel?: string;
	/** Already-substituted sign-off prompt, exposed only with `awaitingHuman`. */
	humanPrompt?: string;
	sessionId?: string;
	session?: { id: string; href: string };
	liveLogs?: { stdout: boolean; stderr: boolean };
	diagnostics?: {
		outputSource: "compact-tail" | "live-logs" | "retained-logs";
		logs?: {
			stdout?: { bytes: number; lines: number; truncated?: boolean; truncationReason?: string };
			stderr?: { bytes: number; lines: number; truncated?: boolean; truncationReason?: string };
		};
		artifacts?: GateArtifactIndex;
		inspectHints?: string[];
		note?: string;
	};
}

export interface GateVerificationSnapshot {
	status?: GateSignal["verification"]["status"] | ActiveVerification["overallStatus"];
	steps: GateVerificationSnapshotStep[];
	counts: Record<GateVerificationSnapshotStatus, number>;
	summary: string;
	selection: TextSelectionMetadata & { truncationReason?: string };
	active: boolean;
	/**
	 * True when a matching active verification entry existed but its backing
	 * sessions/process were no longer alive (dead-but-not-removed). The dead
	 * entry is ignored for liveness and the top-level `status` is never
	 * reported as `running`; the UI renders a terminated/stale state with a
	 * re-signal affordance instead of a perpetual spinner.
	 */
	stale?: boolean;
}

type GateVerificationOutputSource = NonNullable<GateVerificationSnapshotStep["diagnostics"]>["outputSource"];

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

function buildInspectHints(gateId: string, stepName: string, artifacts?: GateArtifactIndex): string[] {
	const encodedStep = stepName.replace(/"/g, '\\"');
	const hints = [
		`gate_inspect(gate_id="${gateId}", section="verification", step="${encodedStep}", mode="grep", pattern="error|failed|Error", context=3)`,
		`gate_inspect(gate_id="${gateId}", section="verification", step="${encodedStep}", mode="slice", from=120, to=220)`,
		`gate_inspect(gate_id="${gateId}", section="verification", step="${encodedStep}", mode="tail", lines=200)`,
	];
	const artifact = artifacts?.files.find(file => file.relativePath === "error-context.md" || file.relativePath.endsWith("/error-context.md")) ?? artifacts?.files[0];
	if (artifact) {
		const encodedArtifact = artifact.id.replace(/"/g, '\\"');
		hints.push(`gate_inspect(gate_id="${gateId}", section="artifact", step="${encodedStep}", artifact="${encodedArtifact}", mode="grep", pattern="Error|locator|failed", context=3)`);
		if (artifact.retries && artifact.retries > 0) {
			hints.push(`gate_inspect(gate_id="${gateId}", section="artifact", step="${encodedStep}", artifact="${encodedArtifact}", retry=1, mode="tail", lines=120)`);
		}
	}
	return hints;
}

function diagnosticsMetadata(input: {
	diagnostics?: GateStepDiagnostics;
	outputSource: GateVerificationOutputSource;
	gateId: string;
	stepName: string;
}): GateVerificationSnapshotStep["diagnostics"] {
	const diagnostics = input.diagnostics;
	const artifacts = diagnostics?.artifacts?.length ? buildArtifactIndex(diagnostics) : undefined;
	const out: NonNullable<GateVerificationSnapshotStep["diagnostics"]> = {
		outputSource: input.outputSource,
		inspectHints: buildInspectHints(input.gateId, input.stepName, artifacts),
	};
	if (diagnostics) {
		out.logs = {};
		if (diagnostics.stdout) {
			const { bytes, lines, truncated, truncationReason } = diagnostics.stdout;
			out.logs.stdout = { bytes, lines, ...(truncated ? { truncated } : {}), ...(truncationReason ? { truncationReason } : {}) };
		}
		if (diagnostics.stderr) {
			const { bytes, lines, truncated, truncationReason } = diagnostics.stderr;
			out.logs.stderr = { bytes, lines, ...(truncated ? { truncated } : {}), ...(truncationReason ? { truncationReason } : {}) };
		}
		if (!out.logs.stdout && !out.logs.stderr) delete out.logs;
		if (artifacts) out.artifacts = artifacts;
		out.note = input.outputSource === "retained-logs"
			? "Inspection output is selected from retained stdout/stderr under Bobbit state; compact status output remains bounded. Artifact content is metadata-only here; use section=\"artifact\" to fetch one retained artifact with bounded selection."
			: "Status output is compact; use explicit gate_inspect modes to query retained logs when available.";
	} else {
		out.note = input.outputSource === "live-logs"
			? "Inspection output is selected from live command log files."
			: "Inspection output is selected from compact persisted output; no retained logs were recorded for this step.";
	}
	return out;
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
	if (step.status === "passed" || step.status === "failed" || step.status === "timeout" || step.status === "skipped") return step.status;
	if (step.skipped) return "skipped";
	return step.passed ? "passed" : "failed";
}

function shouldExposePassed(status: GateVerificationSnapshotStatus): boolean {
	return status === "passed" || status === "failed" || status === "timeout" || status === "skipped";
}

function runningDurationMs(activeStep: ActiveVerification["steps"][number], now: number): number {
	const elapsed = activeStep.startedAt ? Math.max(0, now - activeStep.startedAt) : 0;
	return Math.max(activeStep.durationMs ?? 0, elapsed);
}

function buildSummary(counts: Record<GateVerificationSnapshotStatus, number>): string {
	const order: GateVerificationSnapshotStatus[] = ["passed", "failed", "timeout", "skipped", "running", "waiting", "blocked"];
	const parts = order.filter(status => counts[status] > 0).map(status => `${counts[status]} ${status}`);
	return parts.length ? parts.join(", ") : "0 steps";
}

export interface GateVerificationSnapshotInput {
	goalId: string;
	gateId: string;
	signalId: string;
	verification?: GateSignal["verification"];
	activeVerification?: ActiveVerification;
	selectionOptions?: TextSelectionOptions;
	stepName?: string;
	now?: number;
	/**
	 * Liveness of the matching active verification's backing sessions/process.
	 * Defaults to `true` (back-compat). When explicitly `false`, a matching
	 * active entry is treated as dead-but-not-removed: it is ignored for
	 * liveness, the snapshot is flagged `stale`, and the top-level status is
	 * never reported as `running`. Callers should pass
	 * `verificationHarness.areVerificationSessionsAlive(signalId)`.
	 */
	isActiveVerificationAlive?: boolean;
}

export function buildGateVerificationSnapshot(input: GateVerificationSnapshotInput): GateVerificationSnapshot {
	const now = input.now ?? Date.now();
	const selectionOptions = gateVerificationDefaultSelection(input.selectionOptions ?? { implicitDefault: true });
	const explicitInspectMode = input.selectionOptions?.mode !== undefined;
	const includeDiagnostics = explicitInspectMode && input.selectionOptions?.includeDiagnostics !== false;
	const matchedActive = input.activeVerification
		&& input.activeVerification.goalId === input.goalId
		&& input.activeVerification.gateId === input.gateId
		&& input.activeVerification.signalId === input.signalId
		? input.activeVerification
		: undefined;
	// A matching-but-dead active entry (`isActiveVerificationAlive === false`)
	// is stale: ignore it for all liveness/step derivation and flag the
	// snapshot so the UI shows a terminated state instead of a spinner.
	const stale = !!matchedActive && input.isActiveVerificationAlive === false;
	const active = stale ? undefined : matchedActive;
	const persistedSteps = input.verification?.steps ?? [];
	const activeByName = new Map((active?.steps ?? []).map(step => [step.name, step]));
	let priorFailure = false;
	let aggregateTotalLines = 0;

	const steps = persistedSteps.map((persisted, index): GateVerificationSnapshotStep => {
		const activeStep = active?.steps[index]?.name === persisted.name ? active.steps[index] : activeByName.get(persisted.name);
		// Canonical snapshots never hydrate managed bodies. Explicit inspection
		// uses buildGateVerificationInspectionSnapshot(), which is root-bound and
		// streams only the requested bounded selection.
		const rawPersistedOutput = typeof persisted.output === "string" && persisted.output.length > 0
			? persisted.output
			: "";
		let status: GateVerificationSnapshotStatus;
		let rawOutput = rawPersistedOutput;
		let durationMs = persisted.duration_ms;
		let timeout = persisted.timeout;
		let liveLogs: GateVerificationSnapshotStep["liveLogs"];
		let liveLogTruncationReason: string | undefined;
		let outputSource: GateVerificationOutputSource = "compact-tail";
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
				if (live.liveLogs) outputSource = "live-logs";
				liveLogTruncationReason = live.truncationReason;
			} else {
				durationMs = activeStep.durationMs ?? persisted.duration_ms;
				rawOutput = activeStep.output ?? rawPersistedOutput;
				if (activeStep.type === "command" && (activeStep.outFile || activeStep.errFile)) liveLogs = { stdout: !!activeStep.outFile, stderr: !!activeStep.errFile };
			}
			timeout = (activeStep as typeof activeStep & { timeout?: VerificationTimeoutInfo }).timeout ?? timeout;
		} else {
			status = finalStatusFromPersisted(persisted, input.verification?.status);
		}

		const selected = selectText(rawOutput, selectionOptions);
		const outputTruncationReason = combineTruncationReasons([liveLogTruncationReason]);
		const selection = outputTruncationReason
			? {
				...selected.selection,
				truncated: true,
				truncationReason: selected.selection.truncationReason
					? `${outputTruncationReason}; ${selected.selection.truncationReason}`
					: outputTruncationReason,
			}
			: selected.selection;
		aggregateTotalLines += selection.totalLines;
		if (status === "failed" || status === "timeout") priorFailure = true;

		const out: GateVerificationSnapshotStep = {
			name: persisted.name,
			type: persisted.type,
			status,
			duration_ms: durationMs,
			output: selected.text,
			selection,
		};
		if (shouldExposePassed(status)) out.passed = status === "passed" || (status === "skipped" && persisted.passed === true);
		if (timeout) out.timeout = timeout;
		if (status === "skipped" || status === "blocked" || persisted.skipped) out.skipped = true;
		const phase = activeStep?.phase ?? persisted.phase;
		if (phase !== undefined) out.phase = phase;
		// Sign-off actionability is an active-state overlay, never something inferred
		// from persisted status/output. Require the exact live, parked human step so
		// queued, terminal, stale, mismatched, and historical snapshots cannot leak it.
		const isAwaitingHumanSignoff = active?.overallStatus === "running"
			&& persisted.type === "human-signoff"
			&& activeStep?.type === "human-signoff"
			&& activeStep.status === "running"
			&& activeStep.awaitingHuman === true;
		if (isAwaitingHumanSignoff) {
			out.awaitingHuman = true;
			if (typeof activeStep.humanLabel === "string") out.humanLabel = activeStep.humanLabel;
			if (typeof activeStep.humanPrompt === "string") out.humanPrompt = activeStep.humanPrompt;
		}
		if (sessionId) {
			out.sessionId = sessionId;
			out.session = { id: sessionId, href: `/sessions/${encodeURIComponent(sessionId)}` };
		}
		if (liveLogs) out.liveLogs = liveLogs;
		if (persisted.type === "command" && includeDiagnostics) {
			out.diagnostics = diagnosticsMetadata({
				diagnostics: persisted.diagnostics,
				outputSource,
				gateId: input.gateId,
				stepName: persisted.name,
			});
		}
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
		timeout: 0,
		skipped: 0,
		running: 0,
		waiting: 0,
		blocked: 0,
	};
	for (const step of finalSteps) counts[step.status]++;

	let overallStatus: GateVerificationSnapshot["status"] = active?.overallStatus ?? input.verification?.status;
	// A stale (dead-but-not-removed) verification must never read as running:
	// coerce a residual running/undefined overall status to "cancelled" (a
	// terminal, not-running value) so the UI drops the spinner and offers a
	// re-signal. The `stale` flag is the authoritative UI signal.
	if (stale && (overallStatus === "running" || overallStatus === undefined)) {
		overallStatus = "cancelled";
	}

	return {
		status: overallStatus,
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
		...(stale ? { stale: true } : {}),
	};
}

function isWithinDirectory(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function validateRetainedLogPath(v2Root: string, diagnostics: GateStepDiagnostics, stream: "stdout" | "stderr"): string | undefined {
	const metadata = diagnostics[stream];
	if (!metadata) return undefined;
	const stateDir = path.dirname(path.dirname(path.resolve(v2Root)));
	const diagnosticsRoot = path.join(stateDir, "gate-diagnostics");
	const baseDir = path.resolve(diagnostics.baseDir);
	const expected = path.join(baseDir, `${stream}.log`);
	if (metadata.path !== expected || !isWithinDirectory(path.resolve(diagnosticsRoot), baseDir)) return undefined;
	try {
		const rootReal = fs.realpathSync(diagnosticsRoot);
		const candidate = fs.realpathSync(expected);
		const stat = fs.statSync(candidate);
		if (!stat.isFile() || !isWithinDirectory(rootReal, candidate)) return undefined;
		return candidate;
	} catch {
		return undefined;
	}
}

async function selectRetainedCommandOutput(
	v2Root: string,
	diagnostics: GateStepDiagnostics,
	selection: TextSelectionOptions,
	maxBytes: number,
	maxLines: number,
): Promise<ManagedPayloadSelectionResult | undefined> {
	const files = (["stdout", "stderr"] as const)
		.map(stream => validateRetainedLogPath(v2Root, diagnostics, stream))
		.filter((file): file is string => !!file);
	if (!files.length) return undefined;
	async function* chunks(): AsyncGenerator<Buffer> {
		for (let index = 0; index < files.length; index++) {
			if (index > 0) yield Buffer.from("\n");
			for await (const chunk of fs.createReadStream(files[index]!, { highWaterMark: 64 * 1024 })) yield chunk as Buffer;
		}
	}
	try {
		return await selectGateTextStream(chunks(), {
			mode: selection.mode,
			lines: Math.min(selection.lines ?? (selection.mode === "full" ? MAX_SELECTED_LINES : 200), maxLines),
			from: selection.from,
			to: selection.to,
			pattern: selection.pattern,
			context: selection.context,
			maxResults: selection.maxResults ?? selection.max_results,
			maxBytes,
		});
	} catch {
		return undefined;
	}
}

/**
 * Explicit body inspection. The trusted owning v2 root is mandatory; normal
 * snapshots above remain metadata/preview-only. At most the aggregate response
 * budget is selected. Managed payloads are hashed to EOF, and retained logs are
 * streamed once without exposing their backing paths.
 */
export async function buildGateVerificationInspectionSnapshot(
	input: GateVerificationSnapshotInput & { v2Root: string },
): Promise<GateVerificationSnapshot> {
	const snapshot = buildGateVerificationSnapshot(input);
	if (snapshot.active || !input.verification) return snapshot;
	const options = gateVerificationDefaultSelection(input.selectionOptions ?? { implicitDefault: true });
	let remainingBytes = MAX_SELECTED_BYTES;
	let remainingLines = MAX_SELECTED_LINES;

	for (const projected of snapshot.steps) {
		if (remainingBytes <= 0 || remainingLines <= 0) break;
		const persisted = input.verification.steps.find(step => step.name === projected.name);
		let selected: ManagedPayloadSelectionResult | undefined;
		let source: "retained-logs" | "managed" | undefined;
		if (persisted?.type === "command" && persisted.diagnostics) {
			selected = await selectRetainedCommandOutput(input.v2Root, persisted.diagnostics, options, remainingBytes, remainingLines);
			if (selected) source = "retained-logs";
		} else if (!projected.output && persisted?.outputRef && !persisted.output) {
			selected = await selectManagedGatePayload(input.v2Root, persisted.outputRef, {
				mode: options.mode,
				lines: Math.min(options.lines ?? (options.mode === "full" ? MAX_SELECTED_LINES : 200), remainingLines),
				from: options.from,
				to: options.to,
				pattern: options.pattern,
				context: options.context,
				maxResults: options.maxResults ?? options.max_results,
				maxBytes: remainingBytes,
			});
			if (selected) source = "managed";
		}
		if (selected) {
			projected.output = selected.text;
			projected.selection = {
				mode: options.mode ?? "tail",
				totalLines: selected.totalLines,
				range: selected.range,
				matchCount: selected.matchCount,
				shownMatches: selected.shownMatches,
				truncated: selected.truncated,
				...(selected.truncated ? { truncationReason: `selected ${source === "retained-logs" ? "retained diagnostics" : "managed output"} exceeded the bounded selection budget` } : {}),
			};
			if (source === "retained-logs" && projected.diagnostics) projected.diagnostics.outputSource = "retained-logs";
		}
		const output = projected.output ?? "";
		remainingBytes -= Buffer.byteLength(output);
		remainingLines -= output ? output.split("\n").length : 0;
	}

	const aggregate = enforceGateVerificationAggregateOutputBudget(snapshot.steps);
	snapshot.selection = {
		...snapshot.selection,
		totalLines: snapshot.steps.reduce((sum, step) => sum + (step.selection?.totalLines ?? 0), 0),
		truncated: aggregate.truncated || snapshot.steps.some(step => step.selection?.truncated),
		truncationReason: aggregate.truncationReason,
	};
	return snapshot;
}
