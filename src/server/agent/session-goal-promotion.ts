/**
 * Pure policy for promoting a proposal-owning regular session into a goal lead.
 *
 * Callers must supply only records resolved from the proposal owner and the
 * registered project. Request bodies are deliberately not part of this API, so
 * a branch, path, session id, or sandbox supplied by a client can never become
 * promotion authority.
 */

export const SESSION_GOAL_WORKTREE_MODES = ["new-worktree", "current-session"] as const;
export type SessionGoalWorktreeMode = typeof SESSION_GOAL_WORKTREE_MODES[number];

export function isSessionGoalWorktreeMode(value: unknown): value is SessionGoalWorktreeMode {
	return value === "new-worktree" || value === "current-session";
}

/** Missing legacy proposal fields retain the existing goal-creation behavior. */
export function resolveSessionGoalWorktreeMode(value: unknown): SessionGoalWorktreeMode {
	return isSessionGoalWorktreeMode(value) ? value : "new-worktree";
}

export interface SessionGoalPromotionGoalRecord {
	id: string;
	projectId?: string;
	archived?: boolean;
	/** Provenance stamped only by the in-place promotion path. */
	worktreeOwnerSessionId?: string;
}

export type SessionGoalPromotionLookup<G extends SessionGoalPromotionGoalRecord = SessionGoalPromotionGoalRecord> =
	| { status: "none" }
	| { status: "found"; goal: G }
	| { status: "conflict"; goals: G[] };

/**
 * Locate an idempotent promotion retry by server-owned provenance. Equal paths
 * or branches are intentionally insufficient. Multiple live matches fail
 * closed instead of choosing an arbitrary goal.
 */
export function lookupSessionGoalPromotion<G extends SessionGoalPromotionGoalRecord>(
	goals: readonly G[],
	ownerSessionId: string,
): SessionGoalPromotionLookup<G> {
	const matches = goals.filter(goal => !goal.archived && goal.worktreeOwnerSessionId === ownerSessionId);
	if (matches.length === 0) return { status: "none" };
	if (matches.length === 1) return { status: "found", goal: matches[0] };
	return { status: "conflict", goals: matches };
}

export interface SessionGoalPromotionLiveSession {
	id: string;
	projectId?: string;
	cwd?: string;
	worktreePath?: string;
	repoPath?: string;
	branch?: string;
	repoWorktrees?: Readonly<Record<string, string>> | ReadonlyArray<{
		repo: string;
		worktreePath: string;
	}>;
	status: string;
	isCompacting?: boolean;
	restoreStartupWasStreaming?: boolean;
	dormant?: boolean;
	lifecycleFenced?: boolean;
	goalId?: string;
	teamGoalId?: string;
	teamLeadSessionId?: string;
	role?: string;
	assistantType?: string;
	delegateOf?: string;
	parentSessionId?: string;
	childKind?: string;
	childTerminal?: boolean;
	readOnly?: boolean;
	nonInteractive?: boolean;
	borrowsWorktree?: boolean;
	borrowedWorktreeOwnerSessionId?: string;
	staffId?: string;
	taskId?: string;
	sandboxed?: boolean;
	containerId?: string;
}

export interface SessionGoalPromotionPersistedSession {
	id: string;
	projectId?: string;
	cwd?: string;
	worktreePath?: string;
	repoPath?: string;
	branch?: string;
	repoWorktrees?: Readonly<Record<string, string>>;
	agentSessionFile?: string;
	archived?: boolean;
	wasStreaming?: boolean;
	goalId?: string;
	teamGoalId?: string;
	teamLeadSessionId?: string;
	role?: string;
	assistantType?: string;
	goalAssistant?: boolean;
	roleAssistant?: boolean;
	toolAssistant?: boolean;
	delegateOf?: string;
	parentSessionId?: string;
	childKind?: string;
	childTerminal?: boolean;
	readOnly?: boolean;
	nonInteractive?: boolean;
	borrowsWorktree?: boolean;
	borrowedWorktreeOwnerSessionId?: string;
	staffId?: string;
	taskId?: string;
	sandboxed?: boolean;
}

/** A live canonical record that already refers to some workspace path. */
export interface SessionGoalPromotionWorkspaceClaim {
	kind: "session" | "goal" | "team" | "staff";
	id: string;
	projectId?: string;
	worktreePath?: string;
	repoWorktrees?: Readonly<Record<string, string>>;
	/** Set only for session claims; lets the source session claim its own checkout. */
	sessionId?: string;
	/** Set only for goal/team claims; exact retry provenance may claim the checkout. */
	goalId?: string;
}

export interface EvaluateSessionGoalPromotionInput {
	ownerSessionId: string;
	/** Target project resolved from the proposal owner + draft, never a request coordinate. */
	proposalProjectId?: string;
	/** Registered canonical target project. */
	project?: { id: string; rootPath: string };
	liveSession?: SessionGoalPromotionLiveSession;
	persistedSession?: SessionGoalPromotionPersistedSession;
	/** Result of checking the canonical transcript in its host/container realm. */
	transcriptAvailable: boolean;
	/** Result of checking the canonical worktree + branch in its host/container realm. */
	workspaceAvailable: boolean;
	/** Additional manager-owned busy state (queued/replacing/background handoff). */
	hasPendingWork?: boolean;
	/** Distinct configured repositories that actually own Git worktrees. */
	gitComponentRepos?: readonly string[];
	/** Result of resolving and probing the existing project sandbox/container. */
	sandboxReachable?: boolean;
	workspaceClaims?: readonly SessionGoalPromotionWorkspaceClaim[];
	goals?: readonly SessionGoalPromotionGoalRecord[];
}

export interface SessionGoalPromotionCoordinates {
	sessionId: string;
	projectId: string;
	cwd: string;
	worktreePath: string;
	repoPath: string;
	branch: string;
	repoWorktrees?: Record<string, string>;
	sandboxed: boolean;
	containerId?: string;
}

export type SessionGoalPromotionReasonCode =
	| "SESSION_NOT_LIVE"
	| "SESSION_NOT_IDLE"
	| "SESSION_HAS_RELATION"
	| "SESSION_UNSAFE"
	| "PROJECT_UNAVAILABLE"
	| "PROJECT_MISMATCH"
	| "TRANSCRIPT_UNAVAILABLE"
	| "WORKTREE_UNAVAILABLE"
	| "WORKSPACE_MISMATCH"
	| "MULTI_REPO_MISMATCH"
	| "SANDBOX_UNAVAILABLE"
	| "PROMOTION_CONFLICT"
	| "WORKSPACE_CLAIMED";

export type SessionGoalPromotionEligibility =
	| { eligible: true; coordinates: SessionGoalPromotionCoordinates }
	| { eligible: false; code: SessionGoalPromotionReasonCode; reason: string };

const REASONS: Record<SessionGoalPromotionReasonCode, string> = {
	SESSION_NOT_LIVE: "Current session is not live.",
	SESSION_NOT_IDLE: "Current session must be idle.",
	SESSION_HAS_RELATION: "Current session already belongs to another Bobbit workflow.",
	SESSION_UNSAFE: "Current session cannot be promoted safely.",
	PROJECT_UNAVAILABLE: "The proposal project is unavailable.",
	PROJECT_MISMATCH: "Current session belongs to a different project.",
	TRANSCRIPT_UNAVAILABLE: "Current session has no available transcript.",
	WORKTREE_UNAVAILABLE: "Current session has no dedicated worktree and branch.",
	WORKSPACE_MISMATCH: "Current session workspace metadata is inconsistent.",
	MULTI_REPO_MISMATCH: "Current session multi-repo worktrees are incomplete.",
	SANDBOX_UNAVAILABLE: "Current session sandbox is unavailable.",
	PROMOTION_CONFLICT: "Current session has conflicting goal promotion records.",
	WORKSPACE_CLAIMED: "Current session worktree is already in use.",
};

function unavailable(code: SessionGoalPromotionReasonCode): SessionGoalPromotionEligibility {
	return { eligible: false, code, reason: REASONS[code] };
}

function nonEmpty(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function repoWorktreeMap(
	value: SessionGoalPromotionLiveSession["repoWorktrees"] | SessionGoalPromotionPersistedSession["repoWorktrees"],
): Record<string, string> | undefined {
	if (!value) return undefined;
	if (Array.isArray(value)) {
		const result: Record<string, string> = {};
		for (const entry of value) {
			if (!entry || !nonEmpty(entry.repo) || !nonEmpty(entry.worktreePath) || result[entry.repo] !== undefined) return undefined;
			result[entry.repo] = entry.worktreePath;
		}
		return result;
	}
	const result: Record<string, string> = {};
	for (const [repo, worktreePath] of Object.entries(value)) {
		if (!nonEmpty(repo) || !nonEmpty(worktreePath)) return undefined;
		result[repo] = worktreePath;
	}
	return result;
}

function equalStringMaps(a: Readonly<Record<string, string>> | undefined, b: Readonly<Record<string, string>> | undefined): boolean {
	const ak = Object.keys(a ?? {}).sort();
	const bk = Object.keys(b ?? {}).sort();
	return ak.length === bk.length
		&& ak.every((key, index) => key === bk[index] && a![key] === b![key]);
}

function normalizePath(value: string): string {
	let normalized = value.replace(/\\/g, "/").replace(/\/+$/, "");
	if (/^[A-Za-z]:\//.test(normalized) || normalized.startsWith("//")) normalized = normalized.toLowerCase();
	return normalized || "/";
}

function containsPath(parent: string, child: string): boolean {
	const normalizedParent = normalizePath(parent);
	const normalizedChild = normalizePath(child);
	return normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}/`);
}

function relationPresent(session: SessionGoalPromotionLiveSession | SessionGoalPromotionPersistedSession): boolean {
	return !!(
		session.goalId
		|| session.teamGoalId
		|| session.teamLeadSessionId
		|| session.role
		|| session.assistantType
		|| ("goalAssistant" in session && (session.goalAssistant || session.roleAssistant || session.toolAssistant))
		|| session.delegateOf
		|| session.parentSessionId
		|| session.childKind
		|| session.staffId
		|| session.taskId
	);
}

function unsafeMarkerPresent(session: SessionGoalPromotionLiveSession | SessionGoalPromotionPersistedSession): boolean {
	return !!(
		session.childTerminal
		|| session.readOnly
		|| session.nonInteractive
		|| session.borrowsWorktree
		|| session.borrowedWorktreeOwnerSessionId
	);
}

function workspacePaths(worktreePath: string | undefined, repoWorktrees: Readonly<Record<string, string>> | undefined): string[] {
	return [worktreePath, ...Object.values(repoWorktrees ?? {})]
		.filter(nonEmpty)
		.map(normalizePath);
}

function claimConflicts(
	claim: SessionGoalPromotionWorkspaceClaim,
	ownerSessionId: string,
	retryGoalId: string | undefined,
	promotionPaths: readonly string[],
): boolean {
	if (claim.kind === "session" && (claim.sessionId === ownerSessionId || claim.id === ownerSessionId)) return false;
	if ((claim.kind === "goal" || claim.kind === "team") && retryGoalId && (claim.goalId === retryGoalId || claim.id === retryGoalId)) return false;
	const claimPaths = workspacePaths(claim.worktreePath, claim.repoWorktrees);
	return claimPaths.some(claimPath => promotionPaths.some(promotionPath =>
		containsPath(claimPath, promotionPath) || containsPath(promotionPath, claimPath),
	));
}

/**
 * Recompute promotion eligibility from live + durable canonical state.
 * The first failing reason is stable and intentionally concise for direct UI use.
 */
export function evaluateSessionGoalPromotion(
	input: EvaluateSessionGoalPromotionInput,
): SessionGoalPromotionEligibility {
	const live = input.liveSession;
	const persisted = input.persistedSession;
	if (!live || !persisted || live.id !== input.ownerSessionId || persisted.id !== input.ownerSessionId || persisted.archived) {
		return unavailable("SESSION_NOT_LIVE");
	}
	if (live.status !== "idle" || live.isCompacting || live.restoreStartupWasStreaming || persisted.wasStreaming || live.dormant || live.lifecycleFenced || input.hasPendingWork) {
		return unavailable("SESSION_NOT_IDLE");
	}
	if (relationPresent(live) || relationPresent(persisted)) return unavailable("SESSION_HAS_RELATION");
	if (unsafeMarkerPresent(live) || unsafeMarkerPresent(persisted)) return unavailable("SESSION_UNSAFE");

	if (!input.project || !nonEmpty(input.proposalProjectId) || input.project.id !== input.proposalProjectId) {
		return unavailable("PROJECT_UNAVAILABLE");
	}
	if (live.projectId !== input.project.id || persisted.projectId !== input.project.id) {
		return unavailable("PROJECT_MISMATCH");
	}
	if (!input.transcriptAvailable || !nonEmpty(persisted.agentSessionFile)) {
		return unavailable("TRANSCRIPT_UNAVAILABLE");
	}

	const coordinateKeys = ["cwd", "worktreePath", "repoPath", "branch"] as const;
	if (coordinateKeys.some(key => !nonEmpty(live[key]) || !nonEmpty(persisted[key]))) {
		return unavailable("WORKTREE_UNAVAILABLE");
	}
	if (coordinateKeys.some(key => live[key] !== persisted[key])) return unavailable("WORKSPACE_MISMATCH");
	const cwd = live.cwd!;
	const worktreePath = live.worktreePath!;
	const repoPath = live.repoPath!;
	const branch = live.branch!;
	if (!input.workspaceAvailable || !containsPath(worktreePath, cwd) || normalizePath(worktreePath) === normalizePath(repoPath)) {
		return unavailable("WORKTREE_UNAVAILABLE");
	}

	const liveRepoWorktrees = repoWorktreeMap(live.repoWorktrees);
	const persistedRepoWorktrees = repoWorktreeMap(persisted.repoWorktrees);
	if ((live.repoWorktrees && !liveRepoWorktrees) || (persisted.repoWorktrees && !persistedRepoWorktrees)) {
		return unavailable("MULTI_REPO_MISMATCH");
	}
	if (!equalStringMaps(liveRepoWorktrees, persistedRepoWorktrees)) return unavailable("MULTI_REPO_MISMATCH");

	const expectedRepos = input.gitComponentRepos ?? [];
	const distinctRepos = new Set(expectedRepos);
	if (distinctRepos.size !== expectedRepos.length) return unavailable("MULTI_REPO_MISMATCH");
	if (expectedRepos.length > 1 || (expectedRepos.length === 1 && expectedRepos[0] !== ".")) {
		const actualRepos = Object.keys(liveRepoWorktrees ?? {});
		if (actualRepos.length !== distinctRepos.size || actualRepos.some(repo => !distinctRepos.has(repo))) {
			return unavailable("MULTI_REPO_MISMATCH");
		}
		const componentPaths = Object.values(liveRepoWorktrees!);
		if (new Set(componentPaths.map(normalizePath)).size !== componentPaths.length
			|| componentPaths.some(componentPath => !containsPath(worktreePath, componentPath))) {
			return unavailable("MULTI_REPO_MISMATCH");
		}
	} else if (Object.keys(liveRepoWorktrees ?? {}).length > 0) {
		return unavailable("MULTI_REPO_MISMATCH");
	}

	if ((live.sandboxed === true) !== (persisted.sandboxed === true)) return unavailable("WORKSPACE_MISMATCH");
	if (live.sandboxed && (!nonEmpty(live.containerId) || input.sandboxReachable !== true)) {
		return unavailable("SANDBOX_UNAVAILABLE");
	}

	const promotionLookup = lookupSessionGoalPromotion(input.goals ?? [], input.ownerSessionId);
	if (promotionLookup.status === "conflict") return unavailable("PROMOTION_CONFLICT");
	if (promotionLookup.status === "found" && promotionLookup.goal.projectId !== input.project.id) {
		return unavailable("PROMOTION_CONFLICT");
	}
	const retryGoalId = promotionLookup.status === "found" ? promotionLookup.goal.id : undefined;
	const promotionPaths = workspacePaths(worktreePath, liveRepoWorktrees);
	if ((input.workspaceClaims ?? []).some(claim =>
		claimConflicts(claim, input.ownerSessionId, retryGoalId, promotionPaths),
	)) {
		return unavailable("WORKSPACE_CLAIMED");
	}

	return {
		eligible: true,
		coordinates: {
			sessionId: input.ownerSessionId,
			projectId: input.project.id,
			cwd,
			worktreePath,
			repoPath,
			branch,
			repoWorktrees: liveRepoWorktrees && Object.keys(liveRepoWorktrees).length > 0 ? liveRepoWorktrees : undefined,
			sandboxed: live.sandboxed === true,
			containerId: live.sandboxed ? live.containerId : undefined,
		},
	};
}
