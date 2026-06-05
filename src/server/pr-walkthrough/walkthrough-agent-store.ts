import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { bobbitStateDir } from "../bobbit-dir.js";
import type { PrWalkthroughAnalysisBundleMetadata } from "./walkthrough-analysis-bundle.js";
import { storageKeyForChangesetId } from "./walkthrough-store.js";

export const PR_WALKTHROUGH_AGENT_STORE_SCHEMA_VERSION = 1;

export type PrWalkthroughJobStatus = "starting" | "waiting_for_yaml" | "validation_failed" | "ready" | "error";

export type PrWalkthroughTarget = {
	provider: "github" | "local" | string;
	prUrl?: string;
	owner?: string;
	repo?: string;
	number?: number;
	baseSha?: string;
	headSha?: string;
	/**
	 * Normalized GitHub host for github-provider targets ("github.com" for
	 * github.com/www.github.com, the real host otherwise). Used to host-qualify
	 * changeset ids so two enterprise hosts sharing owner/repo/number do not
	 * collide on the same tabId / stored-payload path / export lookup.
	 */
	host?: string;
	canonicalKey: string;
};

export type PrWalkthroughValidationIssue = {
	path: string;
	message: string;
};

export type PrWalkthroughValidationSummary = {
	code: "YAML_SCHEMA_INVALID" | string;
	message: string;
	errors: PrWalkthroughValidationIssue[];
	retryable: boolean;
	yamlHash?: string;
};

export type WalkthroughWarning = {
	code: string;
	severity: "info" | "warning" | "error";
	message: string;
	filePath?: string;
};

export type PrWalkthroughJobError = {
	code: string;
	message: string;
	retryable?: boolean;
	host?: string;
};

export interface PrWalkthroughJobRecord {
	schemaVersion: typeof PR_WALKTHROUGH_AGENT_STORE_SCHEMA_VERSION;
	jobId: string;
	parentSessionId: string;
	childSessionId: string;
	projectId?: string;
	cwd: string;
	target: PrWalkthroughTarget;
	changesetId: string;
	tabId: string;
	status: PrWalkthroughJobStatus;
	title: string;
	createdAt: string;
	updatedAt: string;
	lastValidationError?: PrWalkthroughValidationSummary;
	submittedAt?: string;
	payloadUpdatedAt?: string;
	warnings?: WalkthroughWarning[];
	error?: PrWalkthroughJobError;
	reminderCount?: number;
	submissionProofHash?: string;
	analysisBundle?: PrWalkthroughAnalysisBundleMetadata;
}

type StoredJobFile = Partial<PrWalkthroughJobRecord> & Record<string, unknown>;

const STORE_DIR = "pr-walkthrough-agents";

export function createSubmissionProof(): string {
	return randomBytes(32).toString("base64url");
}

export function hashSubmissionProof(jobId: string, sessionId: string, proof: string): string {
	return createHash("sha256").update(`${jobId}\0${sessionId}\0${proof}`).digest("hex");
}

export function verifySubmissionProof(proof: string | undefined, job: Pick<PrWalkthroughJobRecord, "jobId" | "childSessionId" | "submissionProofHash">): boolean {
	if (!proof || !job.submissionProofHash) return false;
	const expected = Buffer.from(job.submissionProofHash, "hex");
	const actual = Buffer.from(hashSubmissionProof(job.jobId, job.childSessionId, proof), "hex");
	return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function rotateSubmissionProofForRestoredJob(stateDir: string, sessionId: string, jobId: string): Record<string, string> | undefined {
	const store = new WalkthroughAgentStore(stateDir);
	const job = store.get(jobId);
	if (!job || job.childSessionId !== sessionId || job.status === "ready" || job.status === "error") return undefined;
	const proof = createSubmissionProof();
	const updated = store.update(jobId, { submissionProofHash: hashSubmissionProof(job.jobId, job.childSessionId, proof) });
	if (!updated) return undefined;
	return {
		BOBBIT_SESSION_ID: sessionId,
		BOBBIT_WALKTHROUGH_JOB_ID: jobId,
		BOBBIT_WALKTHROUGH_SUBMIT_PROOF: proof,
		...walkthroughTargetEnvForJob(updated),
	};
}

export function walkthroughTargetEnvForJob(job: Pick<PrWalkthroughJobRecord, "target">): Record<string, string> {
	const target = job.target;
	const number = typeof target.number === "number" ? target.number : Number(target.number);
	if (target.provider !== "github" || !target.owner || !target.repo || !Number.isInteger(number)) return {};
	return {
		BOBBIT_WALKTHROUGH_TARGET_PROVIDER: "github",
		BOBBIT_WALKTHROUGH_TARGET_OWNER: target.owner,
		BOBBIT_WALKTHROUGH_TARGET_REPO: target.repo,
		BOBBIT_WALKTHROUGH_TARGET_NUMBER: String(number),
	};
}

export class WalkthroughAgentStore {
	private readonly rootDir: string;

	constructor(stateDir = bobbitStateDir()) {
		this.rootDir = path.join(stateDir, STORE_DIR, `v${PR_WALKTHROUGH_AGENT_STORE_SCHEMA_VERSION}`);
	}

	save(record: PrWalkthroughJobRecord): PrWalkthroughJobRecord {
		const now = new Date().toISOString();
		const stored = sanitizeJob({ ...record, updatedAt: record.updatedAt || now });
		this.ensureDir();
		fs.writeFileSync(this.filePath(stored.jobId), `${JSON.stringify(stored, null, 2)}\n`, "utf-8");
		return stored;
	}

	create(input: Omit<PrWalkthroughJobRecord, "schemaVersion" | "createdAt" | "updatedAt"> & { createdAt?: string; updatedAt?: string }): PrWalkthroughJobRecord {
		const now = new Date().toISOString();
		return this.save({
			...input,
			schemaVersion: PR_WALKTHROUGH_AGENT_STORE_SCHEMA_VERSION,
			createdAt: input.createdAt ?? now,
			updatedAt: input.updatedAt ?? now,
		});
	}

	update(jobId: string, updates: Partial<Omit<PrWalkthroughJobRecord, "schemaVersion" | "jobId" | "createdAt">>): PrWalkthroughJobRecord | null {
		const existing = this.get(jobId);
		if (!existing) return null;
		return this.save({
			...existing,
			...updates,
			updatedAt: new Date().toISOString(),
		});
	}

	get(jobId: string): PrWalkthroughJobRecord | null {
		try {
			const raw = JSON.parse(fs.readFileSync(this.filePath(jobId), "utf-8")) as StoredJobFile;
			return parseStoredJob(raw, jobId);
		} catch (error) {
			if (isNodeError(error) && error.code === "ENOENT") return null;
			return null;
		}
	}

	getByChildSession(childSessionId: string): PrWalkthroughJobRecord | null {
		return this.list().find(job => job.childSessionId === childSessionId) ?? null;
	}

	findByParentAndTarget(parentSessionId: string, canonicalTargetKey: string): PrWalkthroughJobRecord | null {
		return this.list().find(job => job.parentSessionId === parentSessionId && job.target.canonicalKey === canonicalTargetKey) ?? null;
	}

	list(): PrWalkthroughJobRecord[] {
		try {
			return fs.readdirSync(this.rootDir, { withFileTypes: true })
				.filter(entry => entry.isFile() && entry.name.endsWith(".json"))
				.map(entry => this.readFile(path.join(this.rootDir, entry.name)))
				.filter((job): job is PrWalkthroughJobRecord => job !== null)
				.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
		} catch (error) {
			if (isNodeError(error) && error.code === "ENOENT") return [];
			return [];
		}
	}

	private readFile(filePath: string): PrWalkthroughJobRecord | null {
		try {
			return parseStoredJob(JSON.parse(fs.readFileSync(filePath, "utf-8")) as StoredJobFile);
		} catch {
			return null;
		}
	}

	private ensureDir(): void {
		fs.mkdirSync(this.rootDir, { recursive: true });
	}

	private filePath(jobId: string): string {
		return path.join(this.rootDir, `${storageKeyForChangesetId(jobId)}.json`);
	}
}

export function sanitizeJob(record: PrWalkthroughJobRecord): PrWalkthroughJobRecord {
	return sanitizeValue(record) as PrWalkthroughJobRecord;
}

function parseStoredJob(raw: StoredJobFile, expectedJobId?: string): PrWalkthroughJobRecord | null {
	if (raw.schemaVersion !== PR_WALKTHROUGH_AGENT_STORE_SCHEMA_VERSION) return null;
	if (typeof raw.jobId !== "string" || (expectedJobId && raw.jobId !== expectedJobId)) return null;
	if (typeof raw.parentSessionId !== "string" || typeof raw.childSessionId !== "string") return null;
	if (typeof raw.cwd !== "string" || typeof raw.changesetId !== "string" || typeof raw.tabId !== "string") return null;
	if (typeof raw.title !== "string" || typeof raw.createdAt !== "string" || typeof raw.updatedAt !== "string") return null;
	if (!isStatus(raw.status) || !isRecord(raw.target) || typeof raw.target.canonicalKey !== "string") return null;
	return sanitizeJob({
		schemaVersion: PR_WALKTHROUGH_AGENT_STORE_SCHEMA_VERSION,
		jobId: raw.jobId,
		parentSessionId: raw.parentSessionId,
		childSessionId: raw.childSessionId,
		projectId: typeof raw.projectId === "string" ? raw.projectId : undefined,
		cwd: raw.cwd,
		target: raw.target as PrWalkthroughTarget,
		changesetId: raw.changesetId,
		tabId: raw.tabId,
		status: raw.status,
		title: raw.title,
		createdAt: raw.createdAt,
		updatedAt: raw.updatedAt,
		lastValidationError: isRecord(raw.lastValidationError) ? raw.lastValidationError as PrWalkthroughValidationSummary : undefined,
		submittedAt: typeof raw.submittedAt === "string" ? raw.submittedAt : undefined,
		payloadUpdatedAt: typeof raw.payloadUpdatedAt === "string" ? raw.payloadUpdatedAt : undefined,
		warnings: Array.isArray(raw.warnings) ? raw.warnings as WalkthroughWarning[] : undefined,
		error: isRecord(raw.error) ? raw.error as PrWalkthroughJobError : undefined,
		reminderCount: typeof raw.reminderCount === "number" ? raw.reminderCount : undefined,
		submissionProofHash: typeof raw.submissionProofHash === "string" ? raw.submissionProofHash : undefined,
		analysisBundle: isRecord(raw.analysisBundle) ? raw.analysisBundle as PrWalkthroughAnalysisBundleMetadata : undefined,
	});
}

function isStatus(value: unknown): value is PrWalkthroughJobStatus {
	return value === "starting" || value === "waiting_for_yaml" || value === "validation_failed" || value === "ready" || value === "error";
}

function sanitizeValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(item => sanitizeValue(item));
	if (!isRecord(value)) return value;
	const out: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (isSensitiveKey(key)) continue;
		out[key] = sanitizeValue(entry);
	}
	return out;
}

function isSensitiveKey(key: string): boolean {
	if (/proof/i.test(key) && !/hash$/i.test(key)) return true;
	return /(^|[-_])(token|secret|authorization|auth[-_]?header|auth[-_]?headers|raw[-_]?headers|headers?)($|[-_])/i.test(key)
		|| /^(token|secret|authorization|auth|headers)$/i.test(key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}
