import { createHash } from "node:crypto";
import { getProposalTypePlugin, readSnapshot, type TypedProposal, type ProposalType } from "./proposal-files.js";
import type { ProposalApplicationIdentity, StoredDecisionRequest } from "../agent/decision-request-store.js";

/** Immutable server-owned identity for one reviewed import draft revision. */
export interface ProjectImportApplication {
	projectId: string;
	importId: string;
	requestId: string;
	type: ProposalType;
	rev: number;
	/** Tool bytes captured before the claim; used for deterministic replay. */
	toolBeforeSha256?: string | null;
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
export class ProjectImportProposalApplicationService {
	/** Per-gateway single-flight state. A process-global map leaked completed work
	 * between isolated gateway instances and made test/server lifetimes overlap. */
	private readonly inFlightApplications = new Map<string, Promise<ProjectImportApplicationResult>>();

	constructor(private readonly operations: ProjectImportMutationOperations) {}

	validate(input: ProjectImportApplication): void {
		if (!Number.isInteger(input.rev) || input.rev < 1 || typeof input.snapshot !== "string" || input.proposal.type !== input.type) {
			throw new ProjectImportApplicationError(422, "INVALID_PROPOSAL", "Proposal identity is invalid");
		}
		const target = input.proposal.fields.projectId;
		// Import ownership supplies the project target. Older, valid project
		// drafts may omit it, but a declared target must never cross that boundary.
		if (target !== undefined && target !== input.projectId) {
			throw new ProjectImportApplicationError(409, "PROJECT_ID_MISMATCH", "Project import proposal target does not match its owner");
		}
	}

	/** Adopt a dead process's durable applying claim. This never claims or executes a created proposal. */
	async reconcileApplying(stateDir: string, record: StoredDecisionRequest, identity: ProposalApplicationIdentity): Promise<ProjectImportApplicationResult | undefined> {
		if (record.proposal?.status !== "applying" || record.proposal.application.key !== identity.key) return undefined;
		const draftId = (await import("./proposal-seed-service.js")).proposalDraftOwnerId({ kind: "project-import", projectId: identity.projectId, importId: identity.importId, requestId: identity.requestId });
		const snapshot = await readSnapshot(stateDir, draftId, identity.type, identity.rev);
		if (snapshot === undefined || projectImportSnapshotSha256(snapshot) !== identity.snapshotSha256) throw new ProjectImportApplicationError(409, "SNAPSHOT_MISMATCH", "Applying proposal revision is unavailable");
		const parsed = getProposalTypePlugin(identity.type).parse(snapshot);
		if (!parsed.ok) throw new ProjectImportApplicationError(422, "INVALID_PROPOSAL", "Applying proposal revision is invalid");
		return this.apply({ ...identity, snapshot, proposal: parsed.value });
	}

	async apply(input: ProjectImportApplication): Promise<ProjectImportApplicationResult> {
		this.validate(input);
		const application = { ...input, applicationKey: projectImportApplicationKey(input) };
		const existing = this.inFlightApplications.get(application.applicationKey);
		if (existing) return existing;
		const work = Promise.resolve(this.operations[input.type](input.proposal.fields, application));
		this.inFlightApplications.set(application.applicationKey, work);
		try { return await work; }
		finally { if (this.inFlightApplications.get(application.applicationKey) === work) this.inFlightApplications.delete(application.applicationKey); }
	}
}
