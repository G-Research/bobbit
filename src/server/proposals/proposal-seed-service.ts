import { createHash } from "node:crypto";
import type http from "node:http";
import type { PersistedGoal } from "../agent/goal-store.js";
import type { ProjectContextManager } from "../agent/project-context-manager.js";
import type { ProjectRegistry } from "../agent/project-registry.js";
import type { SessionManager } from "../agent/session-manager.js";
import type { Workflow } from "../agent/workflow-store.js";
import type { ConfigCascade } from "../agent/config-cascade.js";
import type { PackContributionRegistry } from "../extension-host/pack-contribution-registry.js";
import { openSidePanelWorkspaceTab } from "../side-panel-workspace-routes.js";
import { prepareGoalProposalSeed, type GoalProposalValidationError } from "./goal-proposal-seed.js";
import {
	deleteProposalFile,
	parseProposalFile,
	writeProposalFile,
	type ProposalType,
} from "./proposal-files.js";

export type ProposalSeedFailure = {
	ok: false;
	status: 400 | 422;
	body: GoalProposalValidationError | { ok: false; code: string; message: string };
};

export type ProposalSeedResult =
	| { ok: true; status: 200; rev: number; fields: Record<string, unknown> }
	| ProposalSeedFailure;

/**
 * Server-owned identity for an editable proposal draft. Project imports have
 * no agent session, so they must never borrow one merely to store or present a
 * proposal. The import/request ids are durable coordinator records.
 */
export type ProposalDraftOwner =
	| { kind: "session"; sessionId: string }
	| { kind: "project-import"; projectId: string; importId: string; requestId: string };

/**
 * Stable, path-safe draft bucket for a proposal owner. Import ids identify a
 * replay run rather than an individual answer, so each draft also binds its
 * project and durable request identity. Hashing keeps arbitrary durable ids
 * out of paths and holds the bucket to a fixed size.
 */
export function proposalDraftOwnerId(owner: ProposalDraftOwner): string {
	if (owner.kind === "session") return owner.sessionId;
	const identity = JSON.stringify([owner.projectId, owner.importId, owner.requestId]);
	return `project-import-v1-${createHash("sha256").update(identity, "utf8").digest("hex")}`;
}

/** Payload for the project-owned proposal workspace projection. */
export interface ProjectImportProposalWorkspace {
	owner: Extract<ProposalDraftOwner, { kind: "project-import" }>;
	draftId: string;
	proposalType: ProposalType;
	fields: Record<string, unknown>;
	rev: number;
}

export interface ProposalSeedServiceDeps {
	stateDir: string;
	sessionManager: SessionManager;
	projectRegistry: ProjectRegistry;
	projectContextManager: ProjectContextManager;
	configCascade: ConfigCascade;
	getGoal(id: string): PersistedGoal | undefined;
	getPreference(key: string): unknown;
	systemProjectId: string;
	headquartersProjectId: string;
	broadcastToSession?: (sessionId: string, event: unknown) => void;
	packContributionRegistry?: PackContributionRegistry;
	/**
	 * Opens the project-owned proposal projection after an import decision seeds
	 * a draft. It deliberately has no SessionManager dependency.
	 */
	openProjectImportProposalWorkspace?: (workspace: ProjectImportProposalWorkspace) => void | Promise<void>;
	/** Required by the shared side-panel workspace route dependency surface. */
	readBody(req: http.IncomingMessage, maxBytes?: number): Promise<any>;
}

/**
 * Creates editable proposal drafts through the same validated persistence,
 * workspace, and broadcast path used by the proposal seed endpoint.
 *
 * This service intentionally has no proposal-acceptance or configuration
 * mutation capability. Consumers only receive an editable draft.
 */
export class ProposalSeedService {
	constructor(private readonly deps: ProposalSeedServiceDeps) {}

	/** Seed a proposal from the normal proposal tool route. */
	async seed(
		sessionId: string,
		proposalType: ProposalType,
		args: Record<string, unknown>,
	): Promise<ProposalSeedResult> {
		return this.seedForOwner({ kind: "session", sessionId }, proposalType, args);
	}

	/**
	 * Seed a draft after a validated extension decision. Import owners are real,
	 * project-scoped records; they never create or borrow an agent session.
	 *
	 * The string overload is transitional compatibility for the existing session
	 * dispatcher. New callers must pass the typed owner.
	 */
	async seedFromDecision(
		owner: ProposalDraftOwner,
		proposalType: ProposalType,
		args: Record<string, unknown>,
	): Promise<ProposalSeedResult>;
	/** @deprecated Session callers should migrate to `{ kind: "session", sessionId }`. */
	async seedFromDecision(
		owner: string,
		proposalType: ProposalType,
		args: Record<string, unknown>,
	): Promise<ProposalSeedResult>;
	async seedFromDecision(
		owner: ProposalDraftOwner | string,
		proposalType: ProposalType,
		args: Record<string, unknown>,
	): Promise<ProposalSeedResult> {
		const normalizedOwner: ProposalDraftOwner = typeof owner === "string"
			? { kind: "session", sessionId: owner }
			: owner;
		if (normalizedOwner.kind === "session") {
			if (!this.deps.sessionManager.getSession(normalizedOwner.sessionId) && !this.deps.sessionManager.getPersistedSession(normalizedOwner.sessionId)) {
				return {
					ok: false,
					status: 400,
					body: { ok: false, code: "INVALID_ORIGIN_SESSION", message: "Decision origin session not found" },
				};
			}
		} else if (!this.deps.projectRegistry.get(normalizedOwner.projectId)) {
			return {
				ok: false,
				status: 422,
				body: { ok: false, code: "UNKNOWN_PROJECT", message: `Unknown project: ${normalizedOwner.projectId}` },
			};
		}
		return this.seedForOwner(normalizedOwner, proposalType, args);
	}

	private async seedForOwner(
		owner: ProposalDraftOwner,
		proposalType: ProposalType,
		args: Record<string, unknown>,
	): Promise<ProposalSeedResult> {
		const draftId = proposalDraftOwnerId(owner);
		const prepared = this.prepare(owner, proposalType, args);
		if (!prepared.ok) return prepared;

		const writeRes = await writeProposalFile(this.deps.stateDir, draftId, proposalType, prepared.args);
		const parsed = await parseProposalFile(this.deps.stateDir, draftId, proposalType);
		if (!parsed.ok) return { ok: false, status: 400, body: parsed };

		if (owner.kind === "session") {
			await this.openSessionWorkspace(owner.sessionId, proposalType).catch((err) => {
				console.warn(`[proposal/seed] failed to open side-panel workspace tab for ${owner.sessionId}/${proposalType}:`, err);
			});
			this.deps.broadcastToSession?.(owner.sessionId, {
				type: "proposal_update",
				sessionId: owner.sessionId,
				proposalType,
				fields: parsed.value.fields,
				rev: writeRes.rev,
				streaming: false,
				source: "seed",
			});
		} else {
			// Unlike a session projection, a project import has no later WS/session
			// recovery path. A draft is successful only when its project-owned
			// workspace is durably projected; otherwise do not report `created`.
			if (!this.deps.openProjectImportProposalWorkspace) {
				await deleteProposalFile(this.deps.stateDir, draftId, proposalType).catch(() => {});
				return { ok: false, status: 422, body: { ok: false, code: "PROJECT_IMPORT_WORKSPACE_UNAVAILABLE", message: "Project import proposal workspace is unavailable" } };
			}
			try {
				await this.deps.openProjectImportProposalWorkspace({
					owner, draftId, proposalType, fields: parsed.value.fields, rev: writeRes.rev,
				});
			} catch (err) {
				console.warn(`[proposal/seed] failed to open project-import proposal workspace for ${owner.importId}/${proposalType}:`, err);
				await deleteProposalFile(this.deps.stateDir, draftId, proposalType).catch(() => {});
				return { ok: false, status: 422, body: { ok: false, code: "PROJECT_IMPORT_WORKSPACE_UNAVAILABLE", message: "Project import proposal workspace is unavailable" } };
			}
		}
		return { ok: true, status: 200, rev: writeRes.rev, fields: parsed.value.fields };
	}

	private async openSessionWorkspace(sessionId: string, proposalType: ProposalType): Promise<void> {
		const proposalLabel = proposalType.charAt(0).toUpperCase() + proposalType.slice(1);
		await openSidePanelWorkspaceTab({
			sessionManager: this.deps.sessionManager,
			broadcastToSession: this.deps.broadcastToSession,
			packContributionRegistry: this.deps.packContributionRegistry,
			readBody: this.deps.readBody,
		}, sessionId, {
			id: `proposal:${proposalType}`,
			kind: "proposal",
			title: `${proposalLabel} Proposal`,
			label: proposalLabel,
			source: { type: "proposal", sessionId, proposalType },
			updatedAt: Date.now(),
		}, { focus: true, placeAfterActive: true });
	}

	private prepare(
		owner: ProposalDraftOwner,
		proposalType: ProposalType,
		args: Record<string, unknown>,
	): { ok: true; args: Record<string, unknown> } | ProposalSeedFailure {
		let enrichedArgs = args;
		const proposalSession = owner.kind === "session"
			? this.deps.sessionManager.getSession(owner.sessionId) ?? this.deps.sessionManager.getPersistedSession(owner.sessionId)
			: undefined;
		const ownerProjectId = owner.kind === "project-import" ? owner.projectId : proposalSession?.projectId;
		if (proposalType === "goal" || proposalType === "staff" || proposalType === "role" || proposalType === "tool") {
			const explicitProjectId = typeof enrichedArgs.projectId === "string" && enrichedArgs.projectId.trim().length > 0
				? enrichedArgs.projectId.trim()
				: undefined;
			const defaultProjectId = ownerProjectId === this.deps.systemProjectId
				? this.deps.headquartersProjectId
				: ownerProjectId;
			const targetProjectId = explicitProjectId ?? defaultProjectId;
			if (!targetProjectId) {
				return { ok: false, status: 400, body: { ok: false, code: "PROJECT_ID_REQUIRED", message: "projectId required for project-scoped proposals" } };
			}
			const targetRecord = this.deps.projectRegistry.get(targetProjectId);
			if (!targetRecord) {
				return { ok: false, status: 422, body: { ok: false, code: "UNKNOWN_PROJECT", message: `Unknown project: ${targetProjectId}` } };
			}
			if (explicitProjectId && targetRecord.hidden) {
				return {
					ok: false,
					status: 422,
					body: { ok: false, code: "UNKNOWN_PROJECT", message: `Project "${explicitProjectId}" is not a valid cross-project target.` },
				};
			}
			enrichedArgs = { ...enrichedArgs, projectId: targetProjectId };
		}

		if (proposalType !== "goal") return { ok: true, args: enrichedArgs };

		const projectId = (typeof enrichedArgs.projectId === "string" && enrichedArgs.projectId.trim().length > 0
			? enrichedArgs.projectId.trim()
			: undefined) ?? ownerProjectId;
		let workflows: Workflow[] = [];
		if (projectId) {
			workflows = this.deps.configCascade.resolveWorkflows(projectId).map(record => record.item);
			if (workflows.length === 0) {
				const ctx = this.deps.projectContextManager.getOrCreate(projectId);
				if (ctx) workflows = ctx.workflowStore.getAll();
			}
		}
		const prepared = prepareGoalProposalSeed(enrichedArgs, {
			session: owner.kind === "session" ? this.deps.sessionManager.getSession(owner.sessionId) : undefined,
			workflows,
			getGoal: this.deps.getGoal,
			getPreference: this.deps.getPreference,
		});
		if (!prepared.ok) return prepared;
		return { ok: true, args: prepared.args };
	}
}
