import { createHash } from "node:crypto";
import type { TypedProposal, ProposalType } from "./proposal-files.js";

/** Immutable server-owned identity for one reviewed import draft revision. */
export interface ProjectImportApplication {
	projectId: string;
	importId: string;
	requestId: string;
	type: ProposalType;
	rev: number;
	/** Exact immutable revision bytes, never the mutable live draft. */
	snapshot: string;
	proposal: TypedProposal;
}

export type ProjectImportApplicationResult = { outcome?: Record<string, string> };

export class ProjectImportApplicationError extends Error {
	constructor(readonly status: 400 | 409 | 422 | 500, readonly code: string, message: string) {
		super(message);
	}
}

/** A hash is opaque, bounded, and cannot be forged through proposal fields. */
export function projectImportSnapshotSha256(snapshot: string): string {
	return createHash("sha256").update(snapshot, "utf8").digest("hex");
}

export function projectImportApplicationKey(input: Omit<ProjectImportApplication, "proposal">): string {
	const exact = JSON.stringify([input.projectId, input.importId, input.requestId, input.type, input.rev, projectImportSnapshotSha256(input.snapshot)]);
	return `import-proposal-v1:${createHash("sha256").update(exact, "utf8").digest("hex")}`;
}

export type ProjectImportMutationOperations = {
	[type in ProposalType]: (fields: Record<string, unknown>, application: ProjectImportApplication & { applicationKey: string }) => Promise<ProjectImportApplicationResult>;
};

/**
 * This owns only the trusted draft-to-canonical-operation boundary. Route
 * composition supplies the same canonical mutation functions used publicly;
 * no session, HTTP request, or import-specific config writer exists here.
 */
const inFlightApplications = new Map<string, Promise<ProjectImportApplicationResult>>();

export class ProjectImportProposalApplicationService {
	constructor(private readonly operations: ProjectImportMutationOperations) {}

	validate(input: ProjectImportApplication): void {
		if (!Number.isInteger(input.rev) || input.rev < 1 || typeof input.snapshot !== "string" || input.proposal.type !== input.type) {
			throw new ProjectImportApplicationError(422, "INVALID_PROPOSAL", "Proposal identity is invalid");
		}
		const target = input.proposal.fields.projectId;
		if (target !== input.projectId) {
			throw new ProjectImportApplicationError(409, "PROJECT_ID_MISMATCH", "Project import proposal target does not match its owner");
		}
	}

	async apply(input: ProjectImportApplication): Promise<ProjectImportApplicationResult> {
		this.validate(input);
		const application = { ...input, applicationKey: projectImportApplicationKey(input) };
		const existing = inFlightApplications.get(application.applicationKey);
		if (existing) return existing;
		const work = Promise.resolve(this.operations[input.type](input.proposal.fields, application));
		inFlightApplications.set(application.applicationKey, work);
		try { return await work; }
		finally { if (inFlightApplications.get(application.applicationKey) === work) inFlightApplications.delete(application.applicationKey); }
	}
}
