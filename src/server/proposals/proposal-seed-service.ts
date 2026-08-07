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
		const prepared = this.prepare(sessionId, proposalType, args);
		if (!prepared.ok) return prepared;

		const writeRes = await writeProposalFile(this.deps.stateDir, sessionId, proposalType, prepared.args);
		const parsed = await parseProposalFile(this.deps.stateDir, sessionId, proposalType);
		if (!parsed.ok) {
			return { ok: false, status: 400, body: parsed };
		}

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
		}, { focus: true, placeAfterActive: true }).catch((err) => {
			console.warn(`[proposal/seed] failed to open side-panel workspace tab for ${sessionId}/${proposalType}:`, err);
		});

		this.deps.broadcastToSession?.(sessionId, {
			type: "proposal_update",
			sessionId,
			proposalType,
			fields: parsed.value.fields,
			rev: writeRes.rev,
			streaming: false,
			source: "seed",
		});
		return { ok: true, status: 200, rev: writeRes.rev, fields: parsed.value.fields };
	}

	/**
	 * Seed a draft after a validated extension decision. The server-owned origin
	 * session is required so an extension cannot create drafts under an arbitrary
	 * session id. Like `seed`, this only writes an editable proposal draft.
	 */
	async seedFromDecision(
		originSessionId: string,
		proposalType: ProposalType,
		args: Record<string, unknown>,
	): Promise<ProposalSeedResult> {
		if (!this.deps.sessionManager.getSession(originSessionId) && !this.deps.sessionManager.getPersistedSession(originSessionId)) {
			return {
				ok: false,
				status: 400,
				body: { ok: false, code: "INVALID_ORIGIN_SESSION", message: "Decision origin session not found" },
			};
		}
		return this.seed(originSessionId, proposalType, args);
	}

	private prepare(
		sessionId: string,
		proposalType: ProposalType,
		args: Record<string, unknown>,
	): { ok: true; args: Record<string, unknown> } | ProposalSeedFailure {
		let enrichedArgs = args;
		if (proposalType === "goal" || proposalType === "staff" || proposalType === "role" || proposalType === "tool") {
			const proposalSession = this.deps.sessionManager.getSession(sessionId) ?? this.deps.sessionManager.getPersistedSession(sessionId);
			const sessionProjectId = proposalSession?.projectId;
			const explicitProjectId = typeof enrichedArgs.projectId === "string" && enrichedArgs.projectId.trim().length > 0
				? enrichedArgs.projectId.trim()
				: undefined;
			const defaultProjectId = sessionProjectId === this.deps.systemProjectId
				? this.deps.headquartersProjectId
				: sessionProjectId;
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

		const liveSession = this.deps.sessionManager.getSession(sessionId);
		const projectId = (typeof enrichedArgs.projectId === "string" && enrichedArgs.projectId.trim().length > 0
			? enrichedArgs.projectId.trim()
			: undefined)
			?? (liveSession ?? this.deps.sessionManager.getPersistedSession(sessionId))?.projectId;
		let workflows: Workflow[] = [];
		if (projectId) {
			workflows = this.deps.configCascade.resolveWorkflows(projectId).map(record => record.item);
			if (workflows.length === 0) {
				const ctx = this.deps.projectContextManager.getOrCreate(projectId);
				if (ctx) workflows = ctx.workflowStore.getAll();
			}
		}
		const prepared = prepareGoalProposalSeed(enrichedArgs, {
			session: liveSession,
			workflows,
			getGoal: this.deps.getGoal,
			getPreference: this.deps.getPreference,
		});
		if (!prepared.ok) return prepared;
		return { ok: true, args: prepared.args };
	}
}
