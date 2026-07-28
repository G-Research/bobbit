import { randomBytes, randomUUID, createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { CommandRunner } from "../gateway-deps.js";
import { SystemsReviewDiffReader } from "./systems-review-reader.js";
import type {
	FinalMutationTargetAssertionRegistryExpectation,
	RegisteredFinalMutationTargetAssertion,
} from "./systems-review-target-evidence.js";
import {
	accumulateSystemsReviewResults,
	finalizeSystemsReviewResult,
	SystemsReviewResultError,
	validateSystemsReviewCheckpoint,
	type SystemsReviewAccumulatedResult,
} from "./systems-review-result-validator.js";
import type {
	SystemsReviewActionBehavior,
	SystemsReviewCheckpointSubmission,
	SystemsReviewCoverageItem,
	SystemsReviewFinalReport,
	SystemsReviewFinalSubmission,
	SystemsReviewResultSubmission,
	SystemsReviewSnapshot,
	SystemsReviewStoredCheckpoint,
} from "./systems-review-types.js";

const STORE_VERSION = 1 as const;
const STORE_FILE = "systems-review-executions.json";

export type SystemsReviewExecutionStatus = "running" | "passed" | "failed" | "timed-out" | "cancelled" | "interrupted";

export interface SystemsReviewExecutionFailure {
	code: string;
	message: string;
	at: number;
	partialCheckpointDigest?: string;
}

export interface PersistedSystemsReviewExecution {
	version: typeof STORE_VERSION;
	id: string;
	goalId: string;
	gateId: string;
	signalId: string;
	/** Initial reviewer session retained for snapshot/receipt compatibility. */
	sessionId: string;
	/** Every fresh continuation session authorized for this logical execution. */
	reviewerSessionIds: string[];
	snapshot: SystemsReviewSnapshot;
	contractId: string;
	contractDigest: string;
	receiptSecretBase64: string;
	status: SystemsReviewExecutionStatus;
	checkpoints: SystemsReviewStoredCheckpoint[];
	/** Server-attested, append-only exact-target assertions available to the reviewer. */
	targetAssertions: RegisteredFinalMutationTargetAssertion[];
	createdAt: number;
	updatedAt: number;
	final?: SystemsReviewFinalReport;
	finalSubmissionDigest?: string;
	failure?: SystemsReviewExecutionFailure;
}

export interface CreateSystemsReviewExecutionInput {
	id?: string;
	goalId: string;
	gateId: string;
	signalId: string;
	sessionId: string;
	snapshot: SystemsReviewSnapshot;
	contractId: string;
	contractDigest: string;
	receiptSecret?: Buffer;
}

export interface SystemsReviewContinuationIndex {
	executionId: string;
	snapshotDigest: string;
	contractId: string;
	contractDigest: string;
	nextChunkId?: string;
	nextChunkIndex: number;
	checkpointHead?: string;
	processedChunkIds: string[];
	processedChangeIds: string[];
	behaviors: Array<{ id: string; kind: "state" | "action"; title: string; coverageItemIds: string[]; layerNames: string[] }>;
	findings: Array<{ id: string; severity: string; category: string; behaviorIds: string[] }>;
	coverageMappings: Array<{ coverageItemId: string; behaviorIds: string[]; nonBehavioralReason?: string }>;
	unresolvedLinks: string[];
}

export interface SubmitSystemsReviewResultOptions {
	validateExactTargetAssertion?: (args: { assertionId: string; behavior: SystemsReviewActionBehavior; coverageItem: SystemsReviewCoverageItem }) => boolean;
}

export class SystemsReviewExecutionStoreError extends Error {
	readonly code: string;
	readonly status: number;
	readonly details?: Record<string, unknown>;

	constructor(code: string, message: string, status = 409, details?: Record<string, unknown>) {
		super(message);
		this.name = "SystemsReviewExecutionStoreError";
		this.code = code;
		this.status = status;
		this.details = details;
	}
}

function stableJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record).filter(key => record[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function sha256(value: unknown): string {
	return createHash("sha256").update(stableJson(value)).digest("hex");
}

function clone<T>(value: T): T {
	return structuredClone(value);
}

function checkpointSubmission(checkpoint: SystemsReviewStoredCheckpoint): SystemsReviewCheckpointSubmission {
	return {
		operation: "checkpoint",
		executionId: checkpoint.executionId,
		snapshotDigest: checkpoint.snapshotDigest,
		contractDigest: checkpoint.contractDigest,
		previousCheckpointDigest: checkpoint.previousCheckpointDigest,
		chunkId: checkpoint.chunkId,
		coverageCursor: checkpoint.coverageCursor,
		processedChangeIds: checkpoint.processedChangeIds,
		receiptTokens: checkpoint.receiptTokens,
		behaviors: checkpoint.behaviors,
		coverageMappings: checkpoint.coverageMappings,
		findings: checkpoint.findings,
		unresolvedLinks: checkpoint.unresolvedLinks,
	};
}

function validateCreateInput(input: CreateSystemsReviewExecutionInput): void {
	if (!input.goalId || !input.gateId || !input.signalId || !input.sessionId || !input.contractId || !/^[0-9a-f]{64}$/.test(input.contractDigest)) throw new SystemsReviewExecutionStoreError("INVALID_EXECUTION", "Systems review execution binding is incomplete.", 400);
	if (input.snapshot.signalId !== input.signalId || input.snapshot.sessionId !== input.sessionId) throw new SystemsReviewExecutionStoreError("SNAPSHOT_SCOPE_MISMATCH", "Systems review snapshot is bound to another signal or session.", 400);
}

export class SystemsReviewExecutionStore {
	private readonly stateDir: string;
	private readonly filePath: string;
	private readonly now: () => number;
	private readonly executions = new Map<string, PersistedSystemsReviewExecution>();

	constructor(stateDir: string, options: { now?: () => number } = {}) {
		this.stateDir = stateDir;
		this.filePath = path.join(stateDir, STORE_FILE);
		this.now = options.now ?? (() => Date.now());
		this.load();
	}

	private load(): void {
		try {
			const parsed: unknown = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
			if (!Array.isArray(parsed)) throw new Error("expected an array");
			for (const candidate of parsed) {
				if (!candidate || typeof candidate !== "object") continue;
				const execution = candidate as PersistedSystemsReviewExecution;
				if (execution.version !== STORE_VERSION || !execution.id || !execution.snapshot?.digest || !Array.isArray(execution.checkpoints)) continue;
				// v1 executions created before resumable fresh-session support carry
				// only sessionId. Upgrade in memory without changing their snapshot.
				execution.reviewerSessionIds = Array.isArray(execution.reviewerSessionIds)
					? [...new Set([execution.sessionId, ...execution.reviewerSessionIds].filter(Boolean))]
					: [execution.sessionId];
				execution.targetAssertions = Array.isArray(execution.targetAssertions) ? execution.targetAssertions : [];
				this.executions.set(execution.id, execution);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`[systems-review-store] Failed to load ${this.filePath}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private save(): void {
		fs.mkdirSync(this.stateDir, { recursive: true });
		const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
		fs.writeFileSync(temporary, `${JSON.stringify([...this.executions.values()], null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		try {
			fs.renameSync(temporary, this.filePath);
		} catch (error) {
			try { fs.unlinkSync(this.filePath); } catch { /* Windows replacement fallback. */ }
			try {
				fs.renameSync(temporary, this.filePath);
			} catch {
				try { fs.unlinkSync(temporary); } catch { /* Best effort. */ }
				throw error;
			}
		}
	}

	create(input: CreateSystemsReviewExecutionInput): PersistedSystemsReviewExecution {
		validateCreateInput(input);
		const id = input.id ?? randomUUID();
		const found = this.executions.get(id);
		if (found) {
			if (found.signalId === input.signalId && found.sessionId === input.sessionId && found.snapshot.digest === input.snapshot.digest && found.contractDigest === input.contractDigest) return clone(found);
			throw new SystemsReviewExecutionStoreError("EXECUTION_CONFLICT", `Systems review execution "${id}" already exists with different immutable bindings.`);
		}
		const secret = input.receiptSecret ?? randomBytes(32);
		if (secret.byteLength < 32) throw new SystemsReviewExecutionStoreError("WEAK_SECRET", "Systems review receipt secret must contain at least 32 bytes.", 400);
		const timestamp = this.now();
		const execution: PersistedSystemsReviewExecution = {
			version: STORE_VERSION,
			id,
			goalId: input.goalId,
			gateId: input.gateId,
			signalId: input.signalId,
			sessionId: input.sessionId,
			reviewerSessionIds: [input.sessionId],
			snapshot: clone(input.snapshot),
			contractId: input.contractId,
			contractDigest: input.contractDigest,
			receiptSecretBase64: secret.toString("base64"),
			status: "running",
			checkpoints: [],
			targetAssertions: [],
			createdAt: timestamp,
			updatedAt: timestamp,
		};
		this.executions.set(id, execution);
		this.save();
		return clone(execution);
	}

	get(id: string): PersistedSystemsReviewExecution | undefined {
		const found = this.executions.get(id);
		return found ? clone(found) : undefined;
	}

	isReviewerSessionBound(id: string, sessionId: string): boolean {
		const execution = this.require(id);
		return execution.sessionId === sessionId || execution.reviewerSessionIds.includes(sessionId);
	}

	bindContinuationSession(id: string, sessionId: string): PersistedSystemsReviewExecution {
		const execution = this.require(id);
		if (execution.final || execution.status !== "running") {
			throw new SystemsReviewExecutionStoreError("EXECUTION_CLOSED", `Systems review execution is ${execution.status}; continuation session rejected.`, 410);
		}
		if (!sessionId) throw new SystemsReviewExecutionStoreError("INVALID_SESSION", "Continuation session id is required.", 400);
		if (!execution.reviewerSessionIds.includes(sessionId)) {
			execution.reviewerSessionIds.push(sessionId);
			execution.updatedAt = this.now();
			this.save();
		}
		return clone(execution);
	}

	private require(id: string): PersistedSystemsReviewExecution {
		const found = this.executions.get(id);
		if (!found) throw new SystemsReviewExecutionStoreError("EXECUTION_NOT_FOUND", `Systems review execution "${id}" was not found.`, 404);
		return found;
	}

	reader(id: string, commandRunner?: CommandRunner): SystemsReviewDiffReader {
		const execution = this.require(id);
		return new SystemsReviewDiffReader({
			snapshot: execution.snapshot,
			secret: Buffer.from(execution.receiptSecretBase64, "base64"),
			commandRunner,
			targetAssertions: execution.targetAssertions,
		});
	}

	registerTargetAssertion(id: string, assertion: RegisteredFinalMutationTargetAssertion): RegisteredFinalMutationTargetAssertion {
		const execution = this.require(id);
		if (execution.status !== "running" || execution.final) {
			throw new SystemsReviewExecutionStoreError("EXECUTION_CLOSED", "Target evidence requires a running Systems review execution.", 410);
		}
		if (assertion.executionId !== execution.id) {
			throw new SystemsReviewExecutionStoreError("TARGET_ASSERTION_SCOPE_MISMATCH", "Target assertion belongs to another Systems review execution.", 400);
		}
		const coverage = execution.snapshot.coverage.find(item => item.id === assertion.coverageItemId);
		const repo = coverage && execution.snapshot.repos.find(candidate => candidate.id === coverage.repoId);
		if (
			!coverage
			|| !repo
			|| assertion.baseOid !== repo.mergeBaseOid
			|| assertion.headOid !== repo.headOid
			|| assertion.effectOutcome !== "succeeded"
			|| !(coverage.requiredTargetActionIds ?? []).includes(assertion.actionId)
			|| assertion.adapterIds.length === 0
			|| assertion.adapterIds.some(adapterId => !(coverage.requiredTargetAdapterIds ?? []).includes(adapterId))
		) {
			throw new SystemsReviewExecutionStoreError("TARGET_ASSERTION_SCOPE_MISMATCH", "Target assertion does not match its immutable coverage, commit, adapter, or outcome binding.", 400);
		}
		const duplicate = execution.targetAssertions.find(candidate => candidate.assertionId === assertion.assertionId);
		if (duplicate) {
			if (stableJson(duplicate) === stableJson(assertion)) return clone(duplicate);
			throw new SystemsReviewExecutionStoreError("TARGET_ASSERTION_CONFLICT", "Target assertion id is already bound to different evidence.", 409);
		}
		if (execution.targetAssertions.some(candidate => candidate.coverageItemId === assertion.coverageItemId)) {
			throw new SystemsReviewExecutionStoreError(
				"TARGET_ASSERTION_COVERAGE_CONFLICT",
				"A coverage item can expose only one immutable exact-target assertion; ambiguous multi-action changes fail closed.",
				409,
			);
		}
		execution.targetAssertions.push(clone(assertion));
		execution.updatedAt = this.now();
		this.save();
		return clone(assertion);
	}

	validateTargetAssertion(
		id: string,
		assertionId: string,
		expected: FinalMutationTargetAssertionRegistryExpectation,
	): boolean {
		const execution = this.require(id);
		const assertion = execution.targetAssertions.find(candidate => candidate.assertionId === assertionId);
		if (!assertion || assertion.executionId !== expected.executionId || assertion.executionId !== execution.id) return false;
		if (
			assertion.baseOid !== expected.baseOid
			|| assertion.headOid !== expected.headOid
			|| (expected.actionId !== undefined && assertion.actionId !== expected.actionId)
			|| assertion.coverageItemId !== expected.coverageItemId
			|| assertion.effectOutcome !== "succeeded"
		) return false;
		const required = new Set(expected.requiredAdapterIds);
		return required.size > 0 && assertion.adapterIds.length > 0 && assertion.adapterIds.every(adapterId => required.has(adapterId));
	}

	submitCheckpoint(submission: SystemsReviewCheckpointSubmission): SystemsReviewStoredCheckpoint {
		const execution = this.require(submission.executionId);
		if (execution.status !== "running") throw new SystemsReviewExecutionStoreError("EXECUTION_CLOSED", `Systems review execution is ${execution.status}; late checkpoint rejected.`, 410);
		const duplicate = execution.checkpoints.find(checkpoint => checkpoint.chunkId === submission.chunkId);
		if (duplicate) {
			if (stableJson(checkpointSubmission(duplicate)) === stableJson(submission)) return clone(duplicate);
			throw new SystemsReviewExecutionStoreError("CONFLICTING_CHECKPOINT", `Evidence chunk "${submission.chunkId}" already has a different accepted checkpoint.`, 409);
		}
		try {
			const reader = this.reader(execution.id);
			const accumulated = accumulateSystemsReviewResults(execution.checkpoints);
			const checkpoint = validateSystemsReviewCheckpoint(submission, {
				snapshot: execution.snapshot,
				contractDigest: execution.contractDigest,
				executionId: execution.id,
				checkpoints: execution.checkpoints,
				accumulated,
				verifyReceipt: token => reader.verifyReceipt(token),
				now: this.now,
			});
			execution.checkpoints.push(checkpoint);
			execution.updatedAt = this.now();
			this.save();
			return clone(checkpoint);
		} catch (error) {
			if (error instanceof SystemsReviewResultError) throw new SystemsReviewExecutionStoreError(error.code, error.message, 400, error.details);
			throw error;
		}
	}

	finalize(submission: SystemsReviewFinalSubmission, options: SubmitSystemsReviewResultOptions = {}): SystemsReviewFinalReport {
		const execution = this.require(submission.executionId);
		if (submission.snapshotDigest !== execution.snapshot.digest || submission.contractDigest !== execution.contractDigest) throw new SystemsReviewExecutionStoreError("SUBMISSION_SCOPE_MISMATCH", "Systems review final synthesis belongs to another snapshot or contract.", 400);
		const submissionDigest = sha256(submission);
		if (execution.final) {
			if (execution.finalSubmissionDigest === submissionDigest) return clone(execution.final);
			throw new SystemsReviewExecutionStoreError("CONFLICTING_FINAL", "Systems review execution already has a different final synthesis.", 409);
		}
		if (execution.status !== "running") throw new SystemsReviewExecutionStoreError("EXECUTION_CLOSED", `Systems review execution is ${execution.status}; late final synthesis rejected.`, 410);
		try {
			const accumulated = accumulateSystemsReviewResults(execution.checkpoints);
			const final = finalizeSystemsReviewResult({
				snapshot: execution.snapshot,
				checkpoints: execution.checkpoints,
				accumulated,
				resolvedLinks: submission.resolvedLinks,
				finalCheckpointDigest: submission.finalCheckpointDigest,
				validateExactTargetAssertion: options.validateExactTargetAssertion,
				now: this.now,
			});
			execution.final = final;
			execution.finalSubmissionDigest = submissionDigest;
			execution.status = final.verdict === "pass" ? "passed" : "failed";
			execution.updatedAt = this.now();
			this.save();
			return clone(final);
		} catch (error) {
			if (error instanceof SystemsReviewResultError) throw new SystemsReviewExecutionStoreError(error.code, error.message, 400, error.details);
			throw error;
		}
	}

	submit(submission: SystemsReviewResultSubmission, options: SubmitSystemsReviewResultOptions = {}): SystemsReviewStoredCheckpoint | SystemsReviewFinalReport {
		return submission.operation === "checkpoint" ? this.submitCheckpoint(submission) : this.finalize(submission, options);
	}

	markFailed(id: string, status: Extract<SystemsReviewExecutionStatus, "failed" | "timed-out" | "cancelled" | "interrupted">, code: string, message: string): PersistedSystemsReviewExecution {
		const execution = this.require(id);
		if (execution.final) return clone(execution);
		if (execution.status !== "running") return clone(execution);
		execution.status = status;
		execution.failure = {
			code,
			message,
			at: this.now(),
			partialCheckpointDigest: execution.checkpoints.at(-1)?.digest,
		};
		execution.updatedAt = this.now();
		this.save();
		return clone(execution);
	}

	resume(id: string): PersistedSystemsReviewExecution {
		const execution = this.require(id);
		if (execution.final) throw new SystemsReviewExecutionStoreError("EXECUTION_FINAL", "A finalized Systems review execution cannot be resumed.", 409);
		if (execution.status !== "timed-out" && execution.status !== "interrupted") throw new SystemsReviewExecutionStoreError("EXECUTION_NOT_RESUMABLE", `Systems review execution in state ${execution.status} cannot be resumed.`, 409);
		execution.status = "running";
		execution.failure = undefined;
		execution.updatedAt = this.now();
		this.save();
		return clone(execution);
	}

	continuationIndex(id: string): SystemsReviewContinuationIndex {
		const execution = this.require(id);
		const accumulated: SystemsReviewAccumulatedResult = accumulateSystemsReviewResults(execution.checkpoints);
		const nextChunkIndex = execution.checkpoints.length;
		return {
			executionId: execution.id,
			snapshotDigest: execution.snapshot.digest,
			contractId: execution.contractId,
			contractDigest: execution.contractDigest,
			nextChunkId: execution.snapshot.chunks[nextChunkIndex]?.id,
			nextChunkIndex,
			checkpointHead: execution.checkpoints.at(-1)?.digest,
			processedChunkIds: execution.checkpoints.map(checkpoint => checkpoint.chunkId),
			processedChangeIds: [...new Set(execution.checkpoints.flatMap(checkpoint => checkpoint.processedChangeIds))],
			behaviors: accumulated.behaviors.map(behavior => ({ id: behavior.id, kind: behavior.kind, title: behavior.title, coverageItemIds: behavior.coverageItemIds, layerNames: behavior.layers.map(layer => layer.layer) })),
			findings: accumulated.findings.map(finding => ({ id: finding.id, severity: finding.severity, category: finding.category, behaviorIds: finding.behaviorIds })),
			coverageMappings: accumulated.coverageMappings.map(mapping => ({ coverageItemId: mapping.coverageItemId, behaviorIds: mapping.behaviorIds, nonBehavioralReason: mapping.nonBehavioralReason })),
			unresolvedLinks: accumulated.unresolvedLinks,
		};
	}
}
