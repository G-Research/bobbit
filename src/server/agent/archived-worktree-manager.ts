/**
 * Archived-worktree bookkeeping — cohort 1 of the SessionManager decomposition
 * (docs/design/session-manager-decomposition.md, cluster G). Extracted
 * verbatim (mechanical move, no behavior change) from session-manager.ts so
 * this git/filesystem-heavy logic can be exercised in unit tests without
 * dragging in the rest of SessionManager's dependency graph (MCP, RpcBridge,
 * sandbox, search) — the same stated purpose session-status.ts's own header
 * comment gives for its extraction (see design doc §5).
 *
 * All cross-cluster dependencies (live session snapshot, cascade-reap,
 * MCP-scope cleanup, terminate/archive, store resolution) are threaded
 * through `ArchivedWorktreeDeps` as data/callbacks rather than imported
 * directly, per docs/design/route-registry.md's "ctx is data, not imports"
 * rule. Fields that can be reassigned after `SessionManager`'s constructor
 * runs (`sandboxManager` via `setSandboxManager`, `_verificationHarness` via
 * `setVerificationHarness`) are threaded as late-bound getters, never
 * captured by value — see design doc §4.2.
 *
 * Note: `ArchivedWorktreeDeps` intentionally does NOT use the name `ctx` for
 * the dependency-bag field — nearly every method in this file already has a
 * local variable or parameter named `ctx` of type `ArchivedWorktreeScanContext`
 * (the per-scan cache built by `buildArchivedWorktreeScanContext`). The
 * dependency bag is stored as `this.deps` instead, matching the existing
 * `deps` convention in worktree-inventory.ts.
 */
import { execFile as execFileCb } from "node:child_process";
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { PersistedSession, SessionStore } from "./session-store.js";
import type { ProjectContextManager } from "./project-context-manager.js";
import type { SandboxManager } from "./sandbox-manager.js";
import type { ColorStore } from "./color-store.js";
import type { SearchService } from "../search/search-service.js";
import { isWorktreePathReferencedByLiveSession, normalizeWorktreeHostPath, type WorktreeReferenceRecord } from "./worktree-reference-guard.js";
import { canPurgeTeamLeadSession } from "./team-store-consistency.js";
import { sessionFileDelete, sessionFsContextForAgentFile } from "./session-fs.js";
import { resolveSafeSessionsPath } from "./transcript-sanitizer.js";
import { isHostAbsoluteAgentSessionPath } from "./agent-session-path.js";
import { sidecarPathFor } from "./session-sidecar.js";
import { cleanupSessionPrompt, purgePromptSectionsJson } from "./system-prompt.js";
import { bobbitStateDir } from "../bobbit-dir.js";
import { shouldSkipRemotePushForTests } from "../skills/git.js";
import { shouldKeepDespiteOrphan } from "./orphan-cleanup.js";

const execFileAsync = promisify(execFileCb);

export type ArchivedWorktreeLegacyStatus = "removable" | "skipped" | "already-cleaned";
export type ArchivedWorktreeDisposition = "ready-to-clean" | "already-cleaned" | "ineligible" | "needs-attention" | "failed";
export type ArchivedWorktreeReason =
	| "safe-archived-session-worktree"
	| "already-cleaned"
	| "no-worktree-path"
	| "missing-repo-path"
	| "sandbox-container-path"
	| "delegate-shared-worktree"
	| "stale-worktree-directory"
	| "referenced-by-live-session"
	| "referenced-by-live-goal"
	| "referenced-by-live-team"
	| "referenced-by-staff"
	| "scan-error";
export type ArchivedWorktreeReasonCategory = "safe" | "already-cleaned" | "missing-metadata" | "container-path" | "shared-delegate" | "stale-path" | "referenced-record" | "error";
export type ArchivedWorktreeSelectionCategory = "archived-session" | "goal-session" | "team-session" | "delegate-session" | "child-session" | "single-repo" | "multi-repo";
export type ArchivedWorktreeCleanupStatus = "cleaned" | "skipped" | "already-cleaned" | "failed";
export type ArchivedWorktreeCleanupReason = "worktree-and-branch-cleaned" | "worktree-cleaned" | "already-cleaned" | "invalid-selection" | ArchivedWorktreeReason;

export class CleanupArchivedSessionWorktreesRequestError extends Error {
	statusCode = 400;
	constructor(message: string) {
		super(message);
		this.name = "CleanupArchivedSessionWorktreesRequestError";
	}
}

export interface ArchivedSessionWorktreeScanResponse {
	sessions: ArchivedSessionWorktreeSession[];
	items: ArchivedSessionWorktreeItem[];
	counts: {
		archivedSessions: number;
		sessionsWithWorktrees: number;
		removableWorktrees: number;
		skippedWorktrees: number;
		alreadyCleanedWorktrees: number;
		totalItems: number;
		readyToClean: number;
		defaultSelected: number;
		alreadyCleaned: number;
		ineligible: number;
		needsAttention: number;
		failed: number;
		byDisposition: Partial<Record<ArchivedWorktreeDisposition, number>>;
		byReason: Partial<Record<ArchivedWorktreeReason, number>>;
		bySelectionCategory: Partial<Record<ArchivedWorktreeSelectionCategory, number>>;
	};
	groups: ArchivedSessionWorktreeGroup[];
	selectionPresets: ArchivedSessionWorktreeSelectionPreset[];
	generatedAt: number;
}

export interface ArchivedSessionWorktreeGroup {
	key: string;
	label: string;
	description: string;
	disposition: ArchivedWorktreeDisposition;
	reason?: ArchivedWorktreeReason;
	reasonCategory?: ArchivedWorktreeReasonCategory;
	count: number;
	sampleKeys: string[];
	sampleItems: ArchivedSessionWorktreeItem[];
	hasMore: boolean;
	actionable: boolean;
}

export interface ArchivedSessionWorktreeSelectionPreset {
	id: string;
	label: string;
	description: string;
	enabled: boolean;
	count: number;
	worktreeKeys: string[];
	cleanupRequest: CleanupArchivedSessionWorktreesRequest;
}

export interface ArchivedSessionWorktreeSession {
	id: string;
	title: string;
	archivedAt?: number;
	projectId?: string;
	projectName?: string;
	goalId?: string;
	teamGoalId?: string;
	delegateOf?: string;
	parentSessionId?: string;
	childKind?: string;
	sandboxed?: boolean;
	branch?: string;
	repoPath?: string;
	worktreePath?: string;
	worktrees: ArchivedSessionWorktreeItem[];
}

export interface ArchivedSessionWorktreeItem {
	key: string;
	sessionId: string;
	title: string;
	archivedAt?: number;
	projectId?: string;
	projectName?: string;
	goalId?: string;
	teamGoalId?: string;
	delegateOf?: string;
	parentSessionId?: string;
	childKind?: string;
	sandboxed?: boolean;
	repo: string;
	repoPath: string;
	repoDisplayName: string;
	path: string;
	branch?: string;
	source: "repoWorktrees" | "sessionWorktree";
	pathExists: boolean;
	gitWorktreeMetadataExists: boolean;
	localBranchExists: boolean;
	status: ArchivedWorktreeLegacyStatus;
	reason: ArchivedWorktreeReason;
	detail: string;
	willDeleteBranch: boolean;
	branchDeleteBlockedReason?: "branch-referenced-by-live-record" | "branch-referenced-by-archived-record";
	disposition: ArchivedWorktreeDisposition;
	reasonCategory: ArchivedWorktreeReasonCategory;
	actionable: boolean;
	selectable: boolean;
	defaultSelected: boolean;
	selectionCategories: ArchivedWorktreeSelectionCategory[];
}

export type CleanupArchivedSessionWorktreesRequest =
	| { mode: "all" }
	| { mode: "selected"; sessionIds?: string[]; worktrees?: Array<{ sessionId: string; repo?: string; path?: string; key?: string }> }
	| { mode: "category"; categories: ArchivedWorktreeSelectionCategory[]; projectId?: string; repoPath?: string }
	| { mode: "preset"; presetId: string };

export interface CleanupArchivedSessionWorktreesResponse {
	counts: {
		requested: number;
		cleaned: number;
		branchDeleted: number;
		skipped: number;
		alreadyCleaned: number;
		failed: number;
		worktreeRemoved: number;
		invalidSelection: number;
		notActionable: number;
		byStatus: Partial<Record<ArchivedWorktreeCleanupStatus, number>>;
		byReason: Partial<Record<ArchivedWorktreeCleanupReason, number>>;
	};
	results: ArchivedSessionWorktreeCleanupResult[];
	generatedAt: number;
}

export interface ArchivedSessionWorktreeCleanupResult {
	key: string;
	sessionId: string;
	title?: string;
	repo?: string;
	repoPath?: string;
	path?: string;
	branch?: string;
	status: ArchivedWorktreeCleanupStatus;
	reason?: ArchivedWorktreeCleanupReason;
	detail?: string;
	error?: string;
	worktreeRemoved: boolean;
	branchDeleted: boolean;
}

interface GitWorktreeRef {
	path: string;
	branch?: string;
}

interface GitWorktreeRefs {
	entries: GitWorktreeRef[];
}

interface ArchivedWorktreeGuardRef {
	id?: string;
	repoPath?: string;
	worktreePath?: string;
	cwd?: string;
	branch?: string;
	repoWorktrees?: Record<string, string>;
}

interface ArchivedWorktreeScanContext {
	candidateContexts: import("./project-context.js").ProjectContext[];
	sessionPathRecords: WorktreeReferenceRecord[];
	goalRefs: ArchivedWorktreeGuardRef[];
	teamRefs: ArchivedWorktreeGuardRef[];
	staffRefs: ArchivedWorktreeGuardRef[];
	branchGuardsByRepo: Map<string, Set<string>>;
	archivedBranchGuardsByRepo: Map<string, Map<string, Set<string>>>;
	gitRefsCache: Map<string, Promise<GitWorktreeRefs>>;
	branchExistsCache: Map<string, Promise<boolean>>;
}

/**
 * Narrow, plain-data snapshot of a live `SessionInfo`'s worktree-relevant
 * fields — deliberately NOT the full `SessionInfo` type (which lives in
 * session-manager.ts and carries rpcClient/bridge/etc. runtime state this
 * module has no business touching). `SessionManager` builds these fresh on
 * every call via `listLiveSessionWorktreeRefs()` since `sessions` mutates
 * continuously (design doc §4.1/§4.2).
 */
export interface LiveSessionWorktreeRef {
	id: string;
	worktreePath?: string;
	cwd: string;
	repoPath?: string;
	branch?: string;
	repoWorktrees?: Array<{ repo: string; repoPath: string; worktreePath: string }>;
}

/**
 * Everything `ArchivedWorktreeManager` needs from `SessionManager` that it
 * doesn't own itself. Per docs/design/route-registry.md's "ctx is data, not
 * imports" rule: plain references for collaborators fixed at construction
 * time, late-bound getters for anything `SessionManager` can reassign after
 * its own constructor runs, and callbacks for logic owned by other clusters
 * (reused verbatim, not duplicated).
 */
export interface ArchivedWorktreeDeps {
	/** Constructor-time-only; SessionManager never reassigns this after its own constructor runs. */
	projectContextManager: ProjectContextManager | null;
	/** Constructor-time-only test-harness fallback store (used when no ProjectContextManager is wired). */
	testStore: SessionStore | null;
	/** Constructor-time-only test-harness fallback search index (used by cleanupSearchForSession when no ProjectContextManager is wired). */
	testSearchIndex: SearchService | null;
	/** Constructor-time-only; used for the session-color cleanup in purgeOneSession. */
	colorStore: ColorStore | undefined;
	/** `sandboxManager` is set post-construction via `setSandboxManager` — must be a live getter, never a captured value. */
	getSandboxManager(): SandboxManager | null;
	/** `_verificationHarness` is set post-construction via `setVerificationHarness` — must be a live getter. */
	getVerificationHarness(): { getResumingSessionIds(): Set<string> } | undefined;
	/** `sessions` mutates continuously — snapshot closure, never a live Map reference. */
	listLiveSessionWorktreeRefs(): LiveSessionWorktreeRef[];
	/** Cluster C (persistence/store resolution) — existing thin resolvers, reused not duplicated. */
	resolveStoreForId(id: string): SessionStore | null;
	getSessionStore(projectId?: string): SessionStore;
	getAllPersistedSessionsForWorktreeGuard(): PersistedSession[];
	/** Cluster I — reap children before destroying/archiving a parent's data. */
	cascadeReapOwner(sessionId: string): Promise<void>;
	/** Cluster D — MCP scope cleanup on purge. */
	cleanupScopedMcpManagersForSessionScope(scope: { projectId?: string; cwd?: string }): Promise<void>;
	/** Cluster B — used by terminateOrphanedSessions. */
	terminateSession(id: string): Promise<boolean>;
	/** Cluster I — used by terminateOrphanedSessions' fallback path. */
	archiveWithCascade(id: string, store?: SessionStore): Promise<boolean>;
	/** Wraps SessionManager's `_terminationListeners` broadcast (sidebar etc.) on purge. */
	notifyTermination(sessionId: string, info: { projectId?: string; reason: "purged" }): void;
}

export class ArchivedWorktreeManager {
	constructor(private readonly deps: ArchivedWorktreeDeps) {}

	/** Update metadata on an archived session (stored in the session store). */
	updateArchivedMeta(id: string, updates: { teamLeadSessionId?: string; parentSessionId?: string; childKind?: string; readOnly?: boolean; childTerminal?: boolean; terminalAt?: number }): boolean {
		const store = this.deps.resolveStoreForId(id);
		if (!store) return false;
		const ps = store.get(id);
		if (!ps?.archived) return false;
		store.update(id, updates);
		return true;
	}

	/** List archived sessions in the same format as listSessions(). */
	listArchivedSessions(): Array<{
		id: string;
		title: string;
		cwd: string;
		status: string;
		createdAt: number;
		lastActivity: number;
		lastReadAt?: number;
		clientCount: number;
		isCompacting: boolean;
		goalId?: string;
		assistantType?: string;
		delegateOf?: string;
		parentSessionId?: string;
		childKind?: string;
		readOnly?: boolean;
		role?: string;
		teamGoalId?: string;
		teamLeadSessionId?: string;
		worktreePath?: string;
		taskId?: string;
		staffId?: string;
		accessory?: string;
		preview?: boolean;
		reattemptGoalId?: string;
		sandboxed?: boolean;
		archived: boolean;
		archivedAt?: number;
	}> {
		const allArchived = this.deps.projectContextManager
			? [...this.deps.projectContextManager.all()].flatMap(ctx => ctx.sessionStore.getArchived())
			: (this.deps.testStore?.getArchived() ?? []);
		return allArchived.map((ps) => ({
			id: ps.id,
			title: ps.title,
			cwd: ps.cwd,
			status: "archived",
			createdAt: ps.createdAt,
			lastActivity: ps.lastActivity,
			lastReadAt: ps.lastReadAt,
			clientCount: 0,
			isCompacting: false,
			goalId: ps.goalId,
			assistantType: ps.assistantType,
			delegateOf: ps.delegateOf,
			parentSessionId: ps.parentSessionId,
			childKind: ps.childKind,
			readOnly: ps.readOnly,
			role: ps.role,
			teamGoalId: ps.teamGoalId,
			teamLeadSessionId: ps.teamLeadSessionId,
			worktreePath: ps.worktreePath,
			taskId: ps.taskId,
			staffId: ps.staffId,
			accessory: ps.accessory,
			preview: ps.preview,
			reattemptGoalId: ps.reattemptGoalId,
			sandboxed: ps.sandboxed,
			archived: true,
			archivedAt: ps.archivedAt,
		}));
	}

	/** Permanently purge a single archived session immediately. */
	async purgeArchivedSession(id: string): Promise<boolean> {
		const ps = this.deps.resolveStoreForId(id)?.get(id);
		if (!ps?.archived) return false;
		await this.purgeOneSession(ps);
		return true;
	}

	/** Purge all archived sessions older than 7 days. */
	async purgeExpiredArchives(): Promise<void> {
		const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
		const cutoff = Date.now() - SEVEN_DAYS_MS;
		const archived = this.deps.projectContextManager
			? [...this.deps.projectContextManager.all()].flatMap(ctx => ctx.sessionStore.getArchived())
			: (this.deps.testStore?.getArchived() ?? []);
		for (const ps of archived) {
			if (ps.archivedAt && ps.archivedAt < cutoff) {
				try {
					await this.purgeOneSession(ps);
					console.log(`[session-manager] Purged expired archive: "${ps.title}" (${ps.id})`);
				} catch (err) {
					console.error(`[session-manager] Failed to purge archive ${ps.id}:`, err);
				}
			}
		}
	}

	async listArchivedSessionWorktrees(includeAlreadyCleaned = false): Promise<ArchivedSessionWorktreeScanResponse> {
		const ctx = this.buildArchivedWorktreeScanContext();
		const sessions: ArchivedSessionWorktreeSession[] = [];
		const allItems: ArchivedSessionWorktreeItem[] = [];
		const counts: ArchivedSessionWorktreeScanResponse["counts"] = {
			archivedSessions: 0,
			sessionsWithWorktrees: 0,
			removableWorktrees: 0,
			skippedWorktrees: 0,
			alreadyCleanedWorktrees: 0,
			totalItems: 0,
			readyToClean: 0,
			defaultSelected: 0,
			alreadyCleaned: 0,
			ineligible: 0,
			needsAttention: 0,
			failed: 0,
			byDisposition: {},
			byReason: {},
			bySelectionCategory: {},
		};

		const archivedRows: Array<{ ps: PersistedSession; projectName?: string }> = [];
		if (this.deps.projectContextManager) {
			for (const projectCtx of ctx.candidateContexts) {
				for (const ps of projectCtx.sessionStore.getArchived()) {
					archivedRows.push({ ps, projectName: projectCtx.project.name });
				}
			}
		} else {
			for (const ps of this.deps.testStore?.getArchived() ?? []) archivedRows.push({ ps });
		}

		counts.archivedSessions = archivedRows.length;
		for (const { ps, projectName } of archivedRows) {
			const worktrees = await this.archivedSessionWorktreeItems(ps, ctx, projectName);
			allItems.push(...worktrees);
			for (const item of worktrees) {
				if (item.status === "removable") counts.removableWorktrees++;
				else if (item.status === "already-cleaned") counts.alreadyCleanedWorktrees++;
				else counts.skippedWorktrees++;
			}
			if (worktrees.some(item => item.status !== "already-cleaned" && item.reason !== "no-worktree-path")) counts.sessionsWithWorktrees++;
			if (!includeAlreadyCleaned && worktrees.every(item => item.status === "already-cleaned")) continue;
			sessions.push({
				id: ps.id,
				title: ps.title,
				archivedAt: ps.archivedAt,
				projectId: ps.projectId,
				projectName,
				goalId: ps.goalId,
				teamGoalId: ps.teamGoalId,
				delegateOf: ps.delegateOf,
				parentSessionId: ps.parentSessionId,
				childKind: ps.childKind,
				sandboxed: ps.sandboxed,
				branch: ps.branch,
				repoPath: ps.repoPath,
				worktreePath: ps.worktreePath,
				worktrees,
			});
		}

		const responseItems = sessions.flatMap(session => session.worktrees);
		this.populateArchivedWorktreeUxCounts(counts, allItems);
		return {
			sessions,
			items: responseItems,
			counts,
			groups: this.buildArchivedWorktreeGroups(allItems),
			selectionPresets: this.buildArchivedWorktreeSelectionPresets(responseItems),
			generatedAt: Date.now(),
		};
	}

	async cleanupArchivedSessionWorktrees(request: CleanupArchivedSessionWorktreesRequest): Promise<CleanupArchivedSessionWorktreesResponse> {
		const zeroCounts = (): CleanupArchivedSessionWorktreesResponse["counts"] => ({
			requested: 0,
			cleaned: 0,
			branchDeleted: 0,
			skipped: 0,
			alreadyCleaned: 0,
			failed: 0,
			worktreeRemoved: 0,
			invalidSelection: 0,
			notActionable: 0,
			byStatus: {},
			byReason: {},
		});
		const response: CleanupArchivedSessionWorktreesResponse = { counts: zeroCounts(), results: [], generatedAt: Date.now() };
		const scan = await this.listArchivedSessionWorktrees(true);
		const sessionById = new Map(scan.sessions.map(session => [session.id, session]));
		const rows = scan.items.map(item => ({ session: sessionById.get(item.sessionId), item }));

		let selected: Array<{ session?: ArchivedSessionWorktreeSession; item: ArchivedSessionWorktreeItem }> = [];
		const invalidSelections: ArchivedSessionWorktreeCleanupResult[] = [];
		if (request.mode === "all") {
			selected = rows.filter(row => row.item.status === "removable");
		} else if (request.mode === "selected" && request.sessionIds) {
			const ids = new Set(request.sessionIds);
			selected = rows.filter(row => ids.has(row.item.sessionId));
			for (const id of ids) {
				if (!rows.some(row => row.item.sessionId === id)) {
					invalidSelections.push({ key: id, sessionId: id, status: "skipped", reason: "invalid-selection", worktreeRemoved: false, branchDeleted: false });
				}
			}
		} else if (request.mode === "selected" && request.worktrees) {
			for (const selector of request.worktrees) {
				const match = rows.find(row => {
					if (row.item.sessionId !== selector.sessionId) return false;
					if (selector.key) return row.item.key === selector.key;
					if (selector.repo !== undefined && row.item.repo !== selector.repo) return false;
					if (selector.path !== undefined && normalizeWorktreeHostPath(row.item.path) !== normalizeWorktreeHostPath(selector.path)) return false;
					return selector.repo !== undefined || selector.path !== undefined;
				});
				if (match) {
					selected.push(match);
				} else {
					const key = selector.key ?? `${selector.sessionId}:${selector.repo ?? ""}:${selector.path ?? ""}`;
					invalidSelections.push({ key, sessionId: selector.sessionId, repo: selector.repo, path: selector.path, status: "skipped", reason: "invalid-selection", worktreeRemoved: false, branchDeleted: false });
				}
			}
		} else if (request.mode === "selected") {
			selected = [];
		} else if (request.mode === "category") {
			const categories = new Set(request.categories);
			const repoFilter = normalizeWorktreeHostPath(request.repoPath);
			selected = rows.filter(row => {
				if (row.item.status !== "removable") return false;
				if (!row.item.selectionCategories.some(category => categories.has(category))) return false;
				if (request.projectId && row.item.projectId !== request.projectId) return false;
				if (repoFilter && normalizeWorktreeHostPath(row.item.repoPath) !== repoFilter) return false;
				return true;
			});
		} else if (request.mode === "preset") {
			const preset = scan.selectionPresets.find(candidate => candidate.id === request.presetId);
			if (!preset) throw new CleanupArchivedSessionWorktreesRequestError("Invalid cleanup preset");
			const keys = new Set(preset.worktreeKeys);
			selected = rows.filter(row => row.item.status === "removable" && keys.has(row.item.key));
		}

		const seen = new Set<string>();
		selected = selected.filter(row => {
			if (seen.has(row.item.key)) return false;
			seen.add(row.item.key);
			return true;
		});
		response.counts.requested = selected.length + invalidSelections.length;

		const recordResult = (result: ArchivedSessionWorktreeCleanupResult) => {
			response.results.push(result);
			response.counts.byStatus[result.status] = (response.counts.byStatus[result.status] ?? 0) + 1;
			if (result.reason) response.counts.byReason[result.reason] = (response.counts.byReason[result.reason] ?? 0) + 1;
			if (result.worktreeRemoved) response.counts.worktreeRemoved++;
			if (result.reason === "invalid-selection") response.counts.invalidSelection++;
			if (result.status === "skipped" && result.reason !== "invalid-selection") response.counts.notActionable++;
		};

		for (const invalid of invalidSelections) {
			recordResult(invalid);
			response.counts.skipped++;
		}

		for (const { session, item } of selected) {
			const base: Omit<ArchivedSessionWorktreeCleanupResult, "status" | "worktreeRemoved" | "branchDeleted"> = {
				key: item.key,
				sessionId: item.sessionId,
				title: session?.title ?? item.title,
				repo: item.repo,
				repoPath: item.repoPath,
				path: item.path,
				branch: item.branch,
			};
			if (item.status === "already-cleaned") {
				recordResult({ ...base, status: "already-cleaned", reason: "already-cleaned", detail: item.detail, worktreeRemoved: false, branchDeleted: false });
				response.counts.alreadyCleaned++;
				continue;
			}
			if (item.status !== "removable") {
				recordResult({ ...base, status: "skipped", reason: item.reason, detail: item.detail, worktreeRemoved: false, branchDeleted: false });
				response.counts.skipped++;
				continue;
			}

			try {
				const { cleanupWorktree } = await import("../skills/git.js");
				await cleanupWorktree(item.repoPath, item.path, item.branch, false);

				const worktreeRemoved = await this.archivedWorktreeRemoved(item);
				if (!worktreeRemoved) {
					recordResult({ ...base, status: "failed", reason: "scan-error", error: "cleanup did not remove worktree path or git metadata", worktreeRemoved: false, branchDeleted: false });
					response.counts.failed++;
					continue;
				}

				const branchDeleted = await this.deleteArchivedWorktreeBranchIfAllowed(item);
				recordResult({
					...base,
					status: "cleaned",
					reason: branchDeleted ? "worktree-and-branch-cleaned" : "worktree-cleaned",
					worktreeRemoved: true,
					branchDeleted,
				});
				response.counts.cleaned++;
				if (branchDeleted) response.counts.branchDeleted++;
			} catch (err) {
				recordResult({ ...base, status: "failed", reason: "scan-error", error: err instanceof Error ? err.message : String(err), worktreeRemoved: false, branchDeleted: false });
				response.counts.failed++;
			}
		}

		return response;
	}

	private populateArchivedWorktreeUxCounts(counts: ArchivedSessionWorktreeScanResponse["counts"], items: ArchivedSessionWorktreeItem[]): void {
		counts.totalItems = items.length;
		for (const item of items) {
			counts.byDisposition[item.disposition] = (counts.byDisposition[item.disposition] ?? 0) + 1;
			counts.byReason[item.reason] = (counts.byReason[item.reason] ?? 0) + 1;
			for (const category of item.selectionCategories) counts.bySelectionCategory[category] = (counts.bySelectionCategory[category] ?? 0) + 1;
			if (item.disposition === "ready-to-clean") counts.readyToClean++;
			if (item.defaultSelected) counts.defaultSelected++;
			if (item.disposition === "already-cleaned") counts.alreadyCleaned++;
			if (item.disposition === "ineligible") counts.ineligible++;
			if (item.disposition === "failed") counts.failed++;
			if (item.disposition === "needs-attention" || item.disposition === "failed") counts.needsAttention++;
		}
	}

	private buildArchivedWorktreeGroups(items: ArchivedSessionWorktreeItem[]): ArchivedSessionWorktreeGroup[] {
		const groupSpecs: Array<{ key: string; label: string; description: string; disposition: ArchivedWorktreeDisposition; reason?: ArchivedWorktreeReason }> = [
			{ key: "ready-to-clean", label: "Ready to clean", description: "Archived-session worktrees that are safe to remove now.", disposition: "ready-to-clean", reason: "safe-archived-session-worktree" },
			{ key: "already-cleaned", label: "Already cleaned", description: "Archived sessions whose recorded git worktree is already gone.", disposition: "already-cleaned", reason: "already-cleaned" },
			{ key: "reason:no-worktree-path", label: "Missing worktree path", description: "Archived sessions without a recorded host worktree path.", disposition: "ineligible", reason: "no-worktree-path" },
			{ key: "reason:missing-repo-path", label: "Missing repository path", description: "Archived sessions without enough repository metadata to evaluate cleanup.", disposition: "ineligible", reason: "missing-repo-path" },
			{ key: "reason:sandbox-container-path", label: "Sandbox/container path", description: "Recorded paths are container-internal and do not identify a host worktree.", disposition: "ineligible", reason: "sandbox-container-path" },
			{ key: "reason:delegate-shared-worktree", label: "Shared delegate worktree", description: "Archived delegates that appear to share a parent worktree.", disposition: "ineligible", reason: "delegate-shared-worktree" },
			{ key: "reason:stale-worktree-directory", label: "Stale worktree directory", description: "A path remains on disk without matching git worktree metadata; manual inspection may be needed.", disposition: "needs-attention", reason: "stale-worktree-directory" },
			{ key: "reason:referenced-by-live-session", label: "Referenced by live session", description: "A non-archived or runtime session still references the worktree.", disposition: "ineligible", reason: "referenced-by-live-session" },
			{ key: "reason:referenced-by-live-goal", label: "Referenced by live goal", description: "A persisted goal still references the worktree.", disposition: "ineligible", reason: "referenced-by-live-goal" },
			{ key: "reason:referenced-by-live-team", label: "Referenced by live team", description: "A team entry or team agent still references the worktree.", disposition: "ineligible", reason: "referenced-by-live-team" },
			{ key: "reason:referenced-by-staff", label: "Referenced by staff", description: "A staff record still references the worktree.", disposition: "ineligible", reason: "referenced-by-staff" },
			{ key: "reason:scan-error", label: "Scan errors", description: "Worktrees that could not be evaluated safely.", disposition: "failed", reason: "scan-error" },
		];
		return groupSpecs.flatMap(spec => {
			const matches = spec.key === "ready-to-clean"
				? items.filter(item => item.disposition === "ready-to-clean")
				: items.filter(item => item.reason === spec.reason);
			if (matches.length === 0) return [];
			const sampleItems = matches.slice(0, 5);
			return [{
				key: spec.key,
				label: spec.label,
				description: spec.description,
				disposition: spec.disposition,
				reason: spec.reason,
				reasonCategory: spec.reason ? this.archivedWorktreeReasonCategory(spec.reason) : undefined,
				count: matches.length,
				sampleKeys: sampleItems.map(item => item.key),
				sampleItems,
				hasMore: matches.length > 5,
				actionable: spec.disposition === "ready-to-clean",
			}];
		});
	}

	private buildArchivedWorktreeSelectionPresets(items: ArchivedSessionWorktreeItem[]): ArchivedSessionWorktreeSelectionPreset[] {
		const actionable = items.filter(item => item.actionable);
		const makePreset = (id: string, label: string, description: string, matches: ArchivedSessionWorktreeItem[], cleanupRequest: CleanupArchivedSessionWorktreesRequest): ArchivedSessionWorktreeSelectionPreset => ({
			id,
			label,
			description,
			enabled: matches.length > 0,
			count: matches.length,
			worktreeKeys: matches.map(item => item.key),
			cleanupRequest,
		});
		const presets: ArchivedSessionWorktreeSelectionPreset[] = [
			makePreset("all-removable", "Select all removable", "Select every archived-session worktree that is safe to clean.", actionable, { mode: "all" }),
			makePreset("category:archived-session", "Archived sessions only", "Select all actionable archived-session worktrees.", actionable.filter(item => item.selectionCategories.includes("archived-session")), { mode: "category", categories: ["archived-session"] }),
		];
		const categoryLabels: Partial<Record<ArchivedWorktreeSelectionCategory, string>> = {
			"goal-session": "Goal sessions",
			"team-session": "Goal/team worktrees",
			"delegate-session": "Delegate worktrees",
		};
		for (const category of ["goal-session", "team-session", "delegate-session"] as const) {
			const matches = actionable.filter(item => item.selectionCategories.includes(category));
			if (matches.length > 0) presets.push(makePreset(`category:${category}`, categoryLabels[category] ?? category, `Select actionable ${category.replace(/-/g, " ")} worktrees.`, matches, { mode: "category", categories: [category] }));
		}
		const projects = new Map<string, ArchivedSessionWorktreeItem[]>();
		const repos = new Map<string, ArchivedSessionWorktreeItem[]>();
		for (const item of actionable) {
			if (item.projectId) {
				const existing = projects.get(item.projectId) ?? [];
				existing.push(item);
				projects.set(item.projectId, existing);
			}
			const repoKey = normalizeWorktreeHostPath(item.repoPath);
			if (repoKey) {
				const existing = repos.get(repoKey) ?? [];
				existing.push(item);
				repos.set(repoKey, existing);
			}
		}
		for (const [projectId, matches] of projects) {
			const label = matches[0]?.projectName ? `Current project: ${matches[0].projectName}` : "Current project";
			presets.push(makePreset(`project:${projectId}`, label, "Select actionable archived worktrees in this project.", matches, { mode: "category", categories: ["archived-session"], projectId }));
		}
		for (const [repoPath, matches] of repos) {
			const label = matches[0]?.repoDisplayName ? `Repository: ${matches[0].repoDisplayName}` : "Repository";
			presets.push(makePreset(`repo:${repoPath}`, label, "Select actionable archived worktrees in this repository.", matches, { mode: "category", categories: ["archived-session"], repoPath }));
		}
		return presets;
	}

	private archivedWorktreeDisposition(status: ArchivedWorktreeLegacyStatus, reason: ArchivedWorktreeReason): ArchivedWorktreeDisposition {
		if (status === "removable") return "ready-to-clean";
		if (status === "already-cleaned") return "already-cleaned";
		if (reason === "stale-worktree-directory") return "needs-attention";
		if (reason === "scan-error") return "failed";
		return "ineligible";
	}

	private archivedWorktreeReasonCategory(reason: ArchivedWorktreeReason): ArchivedWorktreeReasonCategory {
		switch (reason) {
			case "safe-archived-session-worktree": return "safe";
			case "already-cleaned": return "already-cleaned";
			case "no-worktree-path":
			case "missing-repo-path": return "missing-metadata";
			case "sandbox-container-path": return "container-path";
			case "delegate-shared-worktree": return "shared-delegate";
			case "stale-worktree-directory": return "stale-path";
			case "referenced-by-live-session":
			case "referenced-by-live-goal":
			case "referenced-by-live-team":
			case "referenced-by-staff": return "referenced-record";
			case "scan-error": return "error";
		}
	}

	private archivedWorktreeSelectionCategories(ps: PersistedSession, source: "repoWorktrees" | "sessionWorktree"): ArchivedWorktreeSelectionCategory[] {
		const categories: ArchivedWorktreeSelectionCategory[] = ["archived-session"];
		if (ps.goalId) categories.push("goal-session");
		if (ps.teamGoalId) categories.push("team-session");
		if (ps.delegateOf) categories.push("delegate-session");
		if (ps.parentSessionId || ps.childKind) categories.push("child-session");
		categories.push(source === "repoWorktrees" ? "multi-repo" : "single-repo");
		return categories;
	}

	private buildArchivedWorktreeScanContext(): ArchivedWorktreeScanContext {
		const candidateContexts = this.deps.projectContextManager ? [...this.deps.projectContextManager.visible()] : [];
		const allContexts = this.deps.projectContextManager ? [...this.deps.projectContextManager.all()] : [];
		const sessionPathRecords: WorktreeReferenceRecord[] = [];
		const goalRefs: ArchivedWorktreeGuardRef[] = [];
		const teamRefs: ArchivedWorktreeGuardRef[] = [];
		const staffRefs: ArchivedWorktreeGuardRef[] = [];
		const branchGuardsByRepo = new Map<string, Set<string>>();
		const archivedBranchGuardsByRepo = new Map<string, Map<string, Set<string>>>();
		const addBranchGuard = (repoPath: string | undefined, branch: string | undefined) => {
			const repoKey = normalizeWorktreeHostPath(repoPath);
			if (!repoKey || !branch) return;
			let set = branchGuardsByRepo.get(repoKey);
			if (!set) {
				set = new Set<string>();
				branchGuardsByRepo.set(repoKey, set);
			}
			set.add(branch);
		};
		const addArchivedBranchGuard = (repoPath: string | undefined, branch: string | undefined, itemKey: string) => {
			const repoKey = normalizeWorktreeHostPath(repoPath);
			if (!repoKey || !branch) return;
			let branches = archivedBranchGuardsByRepo.get(repoKey);
			if (!branches) {
				branches = new Map<string, Set<string>>();
				archivedBranchGuardsByRepo.set(repoKey, branches);
			}
			let keys = branches.get(branch);
			if (!keys) {
				keys = new Set<string>();
				branches.set(branch, keys);
			}
			keys.add(itemKey);
		};
		const addRepoBranches = (repoPath: string | undefined, branch: string | undefined, repoWorktrees?: Record<string, string>) => {
			if (repoWorktrees && repoPath) {
				for (const repo of Object.keys(repoWorktrees)) addBranchGuard(repo === "." ? repoPath : path.join(repoPath, repo), branch);
			} else {
				addBranchGuard(repoPath, branch);
			}
		};

		const persistedSessions = this.deps.projectContextManager
			? allContexts.flatMap(ctx => ctx.sessionStore.getLive())
			: (this.deps.testStore?.getLive() ?? []);
		for (const ps of persistedSessions) {
			sessionPathRecords.push(ps);
			addRepoBranches(ps.repoPath, ps.branch, ps.repoWorktrees);
		}
		for (const session of this.deps.listLiveSessionWorktreeRefs()) {
			const repoWorktrees = session.repoWorktrees ? Object.fromEntries(session.repoWorktrees.map(w => [w.repo, w.worktreePath])) : undefined;
			sessionPathRecords.push({ id: session.id, worktreePath: session.worktreePath, cwd: session.cwd, repoWorktrees });
			if (session.repoWorktrees && session.repoWorktrees.length > 0) {
				for (const wt of session.repoWorktrees) addBranchGuard(wt.repoPath, session.branch);
			} else {
				addBranchGuard(session.repoPath, session.branch);
			}
		}

		const archivedSessions = this.deps.projectContextManager
			? allContexts.flatMap(ctx => ctx.sessionStore.getArchived())
			: (this.deps.testStore?.getArchived() ?? []);
		for (const ps of archivedSessions) {
			if (ps.repoWorktrees && Object.keys(ps.repoWorktrees).length > 0 && ps.repoPath) {
				for (const [repo, wt] of Object.entries(ps.repoWorktrees)) {
					const repoPath = repo === "." ? ps.repoPath : path.join(ps.repoPath, repo);
					addArchivedBranchGuard(repoPath, ps.branch, this.archivedWorktreeKey(ps.id, repo, wt));
				}
			} else {
				addArchivedBranchGuard(ps.repoPath, ps.branch, this.archivedWorktreeKey(ps.id, ".", ps.worktreePath));
			}
		}

		for (const projectCtx of allContexts) {
			const goalsById = new Map(projectCtx.goalStore.getAll().map(goal => [goal.id, goal]));
			for (const goal of projectCtx.goalStore.getAll()) {
				goalRefs.push({ id: goal.id, repoPath: goal.repoPath, worktreePath: goal.worktreePath, cwd: goal.cwd, branch: goal.branch, repoWorktrees: goal.repoWorktrees });
				addRepoBranches(goal.repoPath, goal.branch, goal.repoWorktrees);
			}
			for (const team of projectCtx.teamStore.getAll()) {
				const ownerGoal = goalsById.get(team.goalId);
				for (const agent of team.agents) {
					teamRefs.push({ id: agent.sessionId, repoPath: ownerGoal?.repoPath ?? projectCtx.project.rootPath, worktreePath: agent.worktreePath, branch: agent.branch });
					addBranchGuard(ownerGoal?.repoPath ?? projectCtx.project.rootPath, agent.branch);
				}
				const lead = team.teamLeadSessionId ? projectCtx.sessionStore.get(team.teamLeadSessionId) : undefined;
				if (lead) {
					teamRefs.push({ id: lead.id, repoPath: lead.repoPath, worktreePath: lead.worktreePath, cwd: lead.cwd, branch: lead.branch, repoWorktrees: lead.repoWorktrees });
					addRepoBranches(lead.repoPath, lead.branch, lead.repoWorktrees);
				}
			}
			for (const staff of projectCtx.staffStore.getAll()) {
				staffRefs.push({ id: staff.id, repoPath: staff.repoPath, worktreePath: staff.worktreePath, cwd: staff.cwd, branch: staff.branch, repoWorktrees: staff.repoWorktrees });
				addRepoBranches(staff.repoPath, staff.branch, staff.repoWorktrees);
			}
		}

		return {
			candidateContexts,
			sessionPathRecords,
			goalRefs,
			teamRefs,
			staffRefs,
			branchGuardsByRepo,
			archivedBranchGuardsByRepo,
			gitRefsCache: new Map(),
			branchExistsCache: new Map(),
		};
	}

	private async archivedSessionWorktreeItems(ps: PersistedSession, ctx: ArchivedWorktreeScanContext, projectName?: string): Promise<ArchivedSessionWorktreeItem[]> {
		const specs: Array<{ repo: string; repoPath?: string; worktreePath?: string; branch?: string; source: "repoWorktrees" | "sessionWorktree" }> = [];
		if (ps.repoWorktrees && Object.keys(ps.repoWorktrees).length > 0) {
			for (const [repo, wt] of Object.entries(ps.repoWorktrees)) {
				specs.push({ repo, repoPath: ps.repoPath ? (repo === "." ? ps.repoPath : path.join(ps.repoPath, repo)) : undefined, worktreePath: wt, branch: ps.branch, source: "repoWorktrees" });
			}
		} else {
			specs.push({ repo: ".", repoPath: ps.repoPath, worktreePath: ps.worktreePath, branch: ps.branch, source: "sessionWorktree" });
		}

		const items: ArchivedSessionWorktreeItem[] = [];
		for (const spec of specs) {
			const item = await this.archivedSessionWorktreeItem(ps, spec, ctx, projectName);
			items.push(item);
		}
		return items;
	}

	private async archivedSessionWorktreeItem(
		ps: PersistedSession,
		spec: { repo: string; repoPath?: string; worktreePath?: string; branch?: string; source: "repoWorktrees" | "sessionWorktree" },
		ctx: ArchivedWorktreeScanContext,
		projectName?: string,
	): Promise<ArchivedSessionWorktreeItem> {
		const key = this.archivedWorktreeKey(ps.id, spec.repo, spec.worktreePath);
		const repoDisplayName = spec.repo === "." ? (projectName ?? (spec.repoPath ? path.basename(spec.repoPath) : ".")) : spec.repo;
		const base = (overrides: Partial<ArchivedSessionWorktreeItem>): ArchivedSessionWorktreeItem => {
			const raw = {
				key,
				sessionId: ps.id,
				title: ps.title,
				archivedAt: ps.archivedAt,
				projectId: ps.projectId,
				projectName,
				goalId: ps.goalId,
				teamGoalId: ps.teamGoalId,
				delegateOf: ps.delegateOf,
				parentSessionId: ps.parentSessionId,
				childKind: ps.childKind,
				sandboxed: ps.sandboxed,
				repo: spec.repo,
				repoPath: spec.repoPath ?? "",
				repoDisplayName,
				path: spec.worktreePath ?? "",
				branch: spec.branch,
				source: spec.source,
				pathExists: false,
				gitWorktreeMetadataExists: false,
				localBranchExists: false,
				status: "skipped" as ArchivedWorktreeLegacyStatus,
				reason: "scan-error" as ArchivedWorktreeReason,
				detail: "Not evaluated.",
				willDeleteBranch: false,
				selectionCategories: this.archivedWorktreeSelectionCategories(ps, spec.source),
				...overrides,
			};
			const status = raw.status ?? "skipped";
			const reason = raw.reason ?? "scan-error";
			const disposition = raw.disposition ?? this.archivedWorktreeDisposition(status, reason);
			const actionable = raw.actionable ?? disposition === "ready-to-clean";
			return {
				...raw,
				status,
				reason,
				disposition,
				reasonCategory: raw.reasonCategory ?? this.archivedWorktreeReasonCategory(reason),
				actionable,
				selectable: raw.selectable ?? actionable,
				defaultSelected: raw.defaultSelected ?? actionable,
			};
		};

		if (!spec.worktreePath) return base({ status: "skipped", reason: "no-worktree-path", detail: "Archived session has no recorded worktree path." });
		if (!spec.repoPath) return base({ status: "skipped", reason: "missing-repo-path", detail: "Archived session has no recorded repository path for this worktree." });
		if (this.isContainerInternalWorktreePath(spec.worktreePath)) return base({ status: "skipped", reason: "sandbox-container-path", detail: "Recorded worktree path is container-internal and has no host worktree to remove." });
		if (ps.delegateOf && !ps.branch && (!ps.repoWorktrees || Object.keys(ps.repoWorktrees).length === 0)) {
			return base({ status: "skipped", reason: "delegate-shared-worktree", detail: "Archived delegate appears to share its parent worktree." });
		}

		let pathExists = false;
		try { pathExists = fs.existsSync(spec.worktreePath); } catch { pathExists = false; }
		const gitRefs = await this.readGitWorktreeRefs(spec.repoPath, ctx);
		const normalizedCandidate = normalizeWorktreeHostPath(spec.worktreePath);
		const gitWorktreeMetadataExists = this.gitWorktreeMetadataMatches(gitRefs, normalizedCandidate, spec.branch);
		const localBranchExists = await this.localBranchExists(spec.repoPath, spec.branch, ctx);
		const sessionReferenced = isWorktreePathReferencedByLiveSession(spec.worktreePath, ctx.sessionPathRecords, { ignoreSessionId: ps.id });
		if (sessionReferenced) {
			return base({ pathExists, gitWorktreeMetadataExists, localBranchExists, status: "skipped", reason: "referenced-by-live-session", detail: "Another non-archived or runtime session still references this worktree." });
		}
		if (this.isWorktreeReferencedByRefs(spec.worktreePath, ctx.goalRefs)) {
			return base({ pathExists, gitWorktreeMetadataExists, localBranchExists, status: "skipped", reason: "referenced-by-live-goal", detail: "A persisted goal still references this worktree." });
		}
		if (this.isWorktreeReferencedByRefs(spec.worktreePath, ctx.teamRefs)) {
			return base({ pathExists, gitWorktreeMetadataExists, localBranchExists, status: "skipped", reason: "referenced-by-live-team", detail: "A persisted team entry or team agent still references this worktree." });
		}
		if (this.isWorktreeReferencedByRefs(spec.worktreePath, ctx.staffRefs)) {
			return base({ pathExists, gitWorktreeMetadataExists, localBranchExists, status: "skipped", reason: "referenced-by-staff", detail: "A staff record still references this worktree." });
		}
		if (!gitWorktreeMetadataExists) {
			return base({
				pathExists,
				gitWorktreeMetadataExists,
				localBranchExists,
				status: pathExists ? "skipped" : "already-cleaned",
				reason: pathExists ? "stale-worktree-directory" : "already-cleaned",
				detail: pathExists
					? "Recorded path exists but no matching git worktree metadata remains; archived-session cleanup will not remove stale directories."
					: "No worktree directory or git worktree metadata remains; any branch-only residue is out of scope for archived-session worktree cleanup.",
			});
		}

		const branchDeleteBlockedReason = localBranchExists
			? this.branchDeleteBlockedReason(spec.branch, spec.repoPath, ctx, key)
			: undefined;
		const willDeleteBranch = localBranchExists && !branchDeleteBlockedReason;
		return base({
			pathExists,
			gitWorktreeMetadataExists,
			localBranchExists,
			status: "removable",
			reason: "safe-archived-session-worktree",
			detail: branchDeleteBlockedReason === "branch-referenced-by-archived-record"
				? "Archived session worktree is safe to remove; branch deletion is blocked because another archived record still references the branch."
				: branchDeleteBlockedReason
					? "Archived session worktree is safe to remove; branch deletion is blocked because another live record still references the branch."
					: "Archived session worktree is safe to remove.",
			willDeleteBranch,
			branchDeleteBlockedReason,
		});
	}

	private archivedWorktreeKey(sessionId: string, repo: string, worktreePath: string | undefined): string {
		return `${sessionId}:${repo}:${normalizeWorktreeHostPath(worktreePath) ?? ""}`;
	}

	private isContainerInternalWorktreePath(candidatePath: string): boolean {
		const normalized = candidatePath.replace(/\\/g, "/");
		return normalized === "/workspace" || normalized.startsWith("/workspace/") || normalized === "/workspace-wt" || normalized.startsWith("/workspace-wt/");
	}

	private isWorktreeReferencedByRefs(candidatePath: string | undefined, refs: ArchivedWorktreeGuardRef[]): boolean {
		const candidate = normalizeWorktreeHostPath(candidatePath);
		if (!candidate) return false;
		for (const ref of refs) {
			if (normalizeWorktreeHostPath(ref.worktreePath) === candidate) return true;
			const cwd = normalizeWorktreeHostPath(ref.cwd);
			if (cwd && (cwd === candidate || cwd.startsWith(`${candidate}/`))) return true;
			if (ref.repoWorktrees) {
				for (const wt of Object.values(ref.repoWorktrees)) {
					if (normalizeWorktreeHostPath(wt) === candidate) return true;
				}
			}
		}
		return false;
	}

	private branchDeleteBlockedReason(branch: string | undefined, repoPath: string, ctx: ArchivedWorktreeScanContext, ownKey?: string): ArchivedSessionWorktreeItem["branchDeleteBlockedReason"] | undefined {
		if (!branch) return "branch-referenced-by-live-record";
		const repoKey = normalizeWorktreeHostPath(repoPath);
		if (!repoKey) return "branch-referenced-by-live-record";
		if (ctx.branchGuardsByRepo.get(repoKey)?.has(branch)) return "branch-referenced-by-live-record";
		const archivedKeys = ctx.archivedBranchGuardsByRepo.get(repoKey)?.get(branch);
		if (archivedKeys && [...archivedKeys].some(key => key !== ownKey)) return "branch-referenced-by-archived-record";
		return undefined;
	}

	private branchDeletionAllowed(branch: string | undefined, repoPath: string, ctx: ArchivedWorktreeScanContext, ownKey?: string): boolean {
		return !this.branchDeleteBlockedReason(branch, repoPath, ctx, ownKey);
	}

	private async archivedWorktreeRemoved(item: ArchivedSessionWorktreeItem): Promise<boolean> {
		let pathExists = false;
		try { pathExists = fs.existsSync(item.path); } catch { pathExists = false; }
		const gitRefs = await this.readGitWorktreeRefsUncached(item.repoPath);
		const normalizedCandidate = normalizeWorktreeHostPath(item.path);
		const gitWorktreeMetadataExists = this.gitWorktreeMetadataMatches(gitRefs, normalizedCandidate, item.branch);
		return !pathExists && !gitWorktreeMetadataExists;
	}

	private async deleteArchivedWorktreeBranchIfAllowed(item: ArchivedSessionWorktreeItem): Promise<boolean> {
		if (!item.willDeleteBranch || !item.branch || !item.localBranchExists) return false;
		const ctx = this.buildArchivedWorktreeScanContext();
		if (!this.branchDeletionAllowed(item.branch, item.repoPath, ctx, item.key)) return false;
		try {
			await execFileAsync("git", ["branch", "-D", item.branch], { cwd: item.repoPath });
		} catch {
			// Verify below before reporting success; branch deletion may have raced or been blocked.
		}
		const branchDeleted = !(await this.localBranchExistsUncached(item.repoPath, item.branch));
		if (!branchDeleted) return false;
		if (!(await shouldSkipRemotePushForTests(item.repoPath))) {
			try {
				await execFileAsync("git", ["push", "origin", "--delete", item.branch], { cwd: item.repoPath, timeout: 15_000 });
			} catch {
				// Best effort: remote may be missing, unreachable, or already deleted.
			}
		}
		return true;
	}

	private gitWorktreeMetadataMatches(gitRefs: GitWorktreeRefs, normalizedCandidate: string | undefined, branch: string | undefined): boolean {
		if (!normalizedCandidate) return false;
		return gitRefs.entries.some(entry => entry.path === normalizedCandidate && (!branch || entry.branch === branch));
	}

	private readGitWorktreeRefs(repoPath: string, ctx: ArchivedWorktreeScanContext): Promise<GitWorktreeRefs> {
		const repoKey = normalizeWorktreeHostPath(repoPath) ?? repoPath;
		let cached = ctx.gitRefsCache.get(repoKey);
		if (!cached) {
			cached = this.readGitWorktreeRefsUncached(repoPath);
			ctx.gitRefsCache.set(repoKey, cached);
		}
		return cached;
	}

	private async readGitWorktreeRefsUncached(repoPath: string): Promise<GitWorktreeRefs> {
		try {
			const { stdout } = await execFileAsync("git", ["worktree", "list", "--porcelain"], { cwd: repoPath });
			const entries: GitWorktreeRef[] = [];
			for (const block of stdout.split("\n\n")) {
				const pathMatch = block.match(/^worktree (.+)$/m);
				const branchMatch = block.match(/^branch refs\/heads\/(.+)$/m);
				const normalizedPath = normalizeWorktreeHostPath(pathMatch?.[1]);
				if (!normalizedPath) continue;
				entries.push({ path: normalizedPath, branch: branchMatch?.[1] });
			}
			return { entries };
		} catch {
			return { entries: [] };
		}
	}

	private localBranchExists(repoPath: string, branch: string | undefined, ctx: ArchivedWorktreeScanContext): Promise<boolean> {
		if (!branch) return Promise.resolve(false);
		const repoKey = normalizeWorktreeHostPath(repoPath) ?? repoPath;
		const key = `${repoKey}:${branch}`;
		let cached = ctx.branchExistsCache.get(key);
		if (!cached) {
			cached = this.localBranchExistsUncached(repoPath, branch);
			ctx.branchExistsCache.set(key, cached);
		}
		return cached;
	}

	private localBranchExistsUncached(repoPath: string, branch: string): Promise<boolean> {
		return execFileAsync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: repoPath })
			.then(() => true)
			.catch(() => false);
	}

	/** Internal: purge a single archived session — delete files, worktree, store entry. */
	private async purgeOneSession(ps: PersistedSession): Promise<void> {
		// SAFETY: refuse to destroy a team-lead session that the team-store
		// still references for a non-archived goal. Symptom this prevents:
		// the user's "Audit subgoals branch" team-lead vanished because some
		// caller (most likely the immediate-purge branch of `DELETE /api/
		// sessions/:id` at server.ts:5816, or the 7-day archive sweep) hit
		// `purgeOneSession` on a session that the team-store still treated
		// as the active team-lead. After purge the team-store referenced a
		// dead session id, the goal got stuck at "Start Team" with a
		// non-functional button, and the .jsonl was permanently destroyed.
		//
		// The right cleanup order is: teardownTeam(goalId) → that removes
		// the team-store entry and terminates the team-lead session →
		// purgeOneSession is then safe. Anything that wants to skip the
		// teardown step is destroying user data.
		//
		// Allow the purge when the owning goal is archived: at that point
		// teardownTeam should already have run (goal-manager.archiveGoal
		// invokes it), and even if it didn't the team is no longer being
		// used by the user, so cleaning up is acceptable.
		if (ps.role === "team-lead" && ps.teamGoalId && ps.projectId && this.deps.projectContextManager) {
			try {
				const ctx = this.deps.projectContextManager.getOrCreate(ps.projectId);
				if (ctx) {
					const verdict = canPurgeTeamLeadSession(
						{ role: ps.role, id: ps.id, teamGoalId: ps.teamGoalId },
						(goalId) => ctx.teamStore.get(goalId)?.teamLeadSessionId ?? undefined,
						(goalId) => !!ctx.goalStore.get(goalId)?.archived,
					);
					if (!verdict.allow) {
						console.warn(`[session-manager] Refusing to purge session ${ps.id}: ${verdict.reason}`);
						return;
					}
				}
			} catch (err) {
				console.error(`[session-manager] Pre-purge safety check failed for ${ps.id}:`, err);
				// Fall through to purge rather than block indefinitely on a
				// check error — best-effort, the rest of the cleanup logs.
			}
		}

		// Cascade-reap any child agents before destroying the parent's data (§6).
		// A parent normally cascades at archive time, but purge is a terminal data
		// destruction — reap here as a final safety net so a child never outlives
		// the purge of its parent.
		try { await this.deps.cascadeReapOwner(ps.id); } catch { /* best-effort */ }

		// Remove from search index
		this.cleanupSearchForSession(ps.id, ps.projectId);

		// Delete .jsonl file. Exact persisted paths outside trusted sessions
		// roots are read-compatible only; never purge/delete them or sidecars.
		if (ps.agentSessionFile) {
			const safeFile = isHostAbsoluteAgentSessionPath(ps.agentSessionFile)
				? resolveSafeSessionsPath(ps.agentSessionFile)
				: ps.agentSessionFile;
			if (safeFile) {
				const purgeCtx = sessionFsContextForAgentFile(ps, safeFile);
				await sessionFileDelete(purgeCtx, safeFile, this.deps.getSandboxManager()).catch(err => {
					console.error(`[session-manager] Failed to delete .jsonl for ${ps.id}:`, err);
				});
			}
			// Delete the bobbit sidecar alongside the .jsonl. Best-effort —
			// host-side path lookup (sidecars are bobbit-owned, never written
			// by sandboxed agents). Missing file is fine.
			if (safeFile) {
				try {
					const sidecarPath = sidecarPathFor(safeFile);
					if (fs.existsSync(sidecarPath)) {
						fs.unlinkSync(sidecarPath);
					}
				} catch (err) {
					console.warn(`[session-manager] Failed to delete sidecar for ${ps.id}:`, err);
				}
			}
		}

		// Delete per-session proposal-drafts directory. Deferred from archive
		// (terminateSession) so that archived sessions retain their drafts long
		// enough for the reopen-archived-proposals flows (Path A in-place
		// resubmit + Path B continue-assistant). Best-effort — missing dir is
		// harmless. See docs/design/editable-proposals.md §4.
		try {
			await fsp.rm(path.join(bobbitStateDir(), "proposal-drafts", ps.id), { recursive: true, force: true });
		} catch (err) {
			console.warn(`[session-manager] proposal-drafts purge failed for ${ps.id}:`, err);
		}

		// Delete session prompt file
		try {
			cleanupSessionPrompt(ps.id);
		} catch (err) {
			console.error(`[session-manager] Failed to cleanup prompt for ${ps.id}:`, err);
		}

		// Delete persisted prompt sections JSON
		purgePromptSectionsJson(ps.id);

		// Clean up host worktree.  Sandboxed session worktrees also create a host-side
		// worktree for server bookkeeping, so we clean those up too.  Skip paths that
		// are container-internal (start with /workspace) — those have no host counterpart.
		// Skip delegates — they share the parent's worktree and must never remove it.
		if (ps.worktreePath && ps.repoPath && !ps.worktreePath.startsWith("/workspace") && !ps.delegateOf) {
			try {
				const { cleanupWorktree } = await import("../skills/git.js");
				const allPersisted = this.deps.getAllPersistedSessionsForWorktreeGuard();
				// Multi-repo: clean each repo's worktree in parallel + delete the
				// shared branch from each repo's remote (Phase 4a).
				if (ps.repoWorktrees && Object.keys(ps.repoWorktrees).length > 0) {
					await Promise.allSettled(Object.entries(ps.repoWorktrees).map(([repo, wt]) => {
						if (isWorktreePathReferencedByLiveSession(wt, allPersisted, { ignoreSessionId: ps.id })) {
							console.log(`[session-manager] Skipping shared worktree cleanup for purged session ${ps.id}: ${wt}`);
							return Promise.resolve();
						}
						const repoPath = repo === "." ? ps.repoPath! : path.join(ps.repoPath!, repo);
						return cleanupWorktree(repoPath, wt, ps.branch, true);
					}));
				} else if (!isWorktreePathReferencedByLiveSession(ps.worktreePath, allPersisted, { ignoreSessionId: ps.id })) {
					await cleanupWorktree(ps.repoPath, ps.worktreePath, ps.branch, true);
				} else {
					console.log(`[session-manager] Skipping shared worktree cleanup for purged session ${ps.id}: ${ps.worktreePath}`);
				}
			} catch (err) {
				console.error(`[session-manager] Failed to cleanup worktree for ${ps.id}:`, err);
			}
		}

		// Remove color
		try {
			this.deps.colorStore?.remove(ps.id);
		} catch (err) {
			console.error(`[session-manager] Failed to remove color for ${ps.id}:`, err);
		}

		// Remove from store
		this.deps.resolveStoreForId(ps.id)?.purge(ps.id);

		// Source-fix for the dangling-team-lead bug: if the purged session was
		// the team-lead of a team-mode goal, also drop the corresponding
		// team-store entry. Without this, the team-store keeps a pointer at
		// the now-deleted session id; on the next boot `TeamManager.restoreTeams`
		// surfaces the dangling entry into `this.teams`, and `startTeam(goalId)`
		// then throws "Team already active" forever — the goal becomes stuck
		// at "No agents — Start Team" with a non-functional button. A boot-time
		// sweep in `team-manager.ts::restoreTeams` recovers already-damaged
		// state; this clears the leak at source so the sweep stays a defensive
		// belt rather than the only line of defence.
		if (ps.role === "team-lead" && ps.teamGoalId && ps.projectId && this.deps.projectContextManager) {
			try {
				const ctx = this.deps.projectContextManager.getOrCreate(ps.projectId);
				if (ctx && ctx.teamStore.get(ps.teamGoalId)) {
					ctx.teamStore.remove(ps.teamGoalId);
					console.log(`[session-manager] Dropped team-store entry for goal ${ps.teamGoalId} on team-lead purge (session ${ps.id}).`);
				}
			} catch (err) {
				console.error(`[session-manager] Failed to clean team-store entry on team-lead purge for ${ps.id}:`, err);
			}
		}

		await this.deps.cleanupScopedMcpManagersForSessionScope({ projectId: ps.projectId, cwd: ps.cwd });

		// Notify termination listeners (sidebar broadcast etc.) so cached UI lists
		// drop the entry without waiting for a polling tick.
		this.deps.notifyTermination(ps.id, { projectId: ps.projectId, reason: "purged" });
	}

	/** Remove search index entries for a session. Used when removing a session from the store. */
	private cleanupSearchForSession(sessionId: string, projectId?: string): void {
		try {
			const searchIndex = projectId
				? this.deps.projectContextManager?.getOrCreate(projectId)?.searchIndex
				: null;
			const idx = searchIndex || this.deps.testSearchIndex;
			if (idx) {
				idx.removeMessagesForSession(sessionId);
				idx.removeSession(sessionId);
			}
		} catch {
			// Non-critical — don't break the removal flow
		}
	}

	/**
	 * Clean up orphaned session worktrees that have no matching active session.
	 * Best-effort — logs warnings but never throws.
	 */
	async cleanupOrphanedSessionWorktrees(repoPath: string): Promise<void> {
		try {
			const { stdout } = await execFileAsync("git", ["worktree", "list", "--porcelain"], { cwd: repoPath });
			const blocks = stdout.split("\n\n");

			// Build a set of branches/paths owned by live (non-archived) persisted sessions.
			// Prior to the fix, pool worktree directories were renamed on claim but
			// `git worktree repair` could fail — git tracked the OLD path while
			// the session stored the NEW path. Matching by branch prevents the
			// cleanup from deleting worktrees that are actually in use.
			const persistedBranches = new Set<string>();
			const allPersisted = this.deps.getAllPersistedSessionsForWorktreeGuard();
			for (const ps of allPersisted) {
				if (!ps.archived && ps.branch) persistedBranches.add(ps.branch);
			}
			const runtimeRecords: WorktreeReferenceRecord[] = this.deps.listLiveSessionWorktreeRefs().map(s => ({
				id: s.id,
				worktreePath: s.worktreePath,
				cwd: s.cwd,
				repoWorktrees: s.repoWorktrees
					? Object.fromEntries(s.repoWorktrees.map(w => [w.repo, w.worktreePath]))
					: undefined,
			}));
			const allPathRecords: WorktreeReferenceRecord[] = [...allPersisted, ...runtimeRecords];

			for (const block of blocks) {
				const branchMatch = block.match(/^branch refs\/heads\/(session\/.+)$/m);
				if (!branchMatch) continue;
				const branch = branchMatch[1];
				// Skip worktree pool entries — they're pre-built and waiting to be
				// claimed by new sessions. They won't have a matching active session yet.
				if (branch.startsWith("session/_pool-")) continue;
				const pathMatch = block.match(/^worktree (.+)$/m);
				if (!pathMatch) continue;
				const wtPath = pathMatch[1];
				// Check if any active session uses this worktree (by path or branch)
				const isActive = isWorktreePathReferencedByLiveSession(wtPath, allPathRecords) || persistedBranches.has(branch);
				if (!isActive) {
					console.log(`[session-manager] Cleaning up orphaned session worktree: ${wtPath} (branch: ${branch})`);
					const { cleanupWorktree } = await import("../skills/git.js");
					await cleanupWorktree(repoPath, wtPath, branch, true).catch(() => {});
				}
			}
		} catch (err) {
			console.warn("[session-manager] Failed to clean up orphaned session worktrees:", err);
		}
	}

	/**
	 * List orphaned session worktrees without deleting them.
	 * Same detection logic as cleanupOrphanedSessionWorktrees but read-only.
	 */
	async listOrphanedSessionWorktrees(repoPath: string): Promise<Array<{ path: string; branch: string }>> {
		try {
			const { stdout } = await execFileAsync("git", ["worktree", "list", "--porcelain"], { cwd: repoPath });
			const blocks = stdout.split("\n\n");

			const persistedBranches = new Set<string>();
			const allPersisted = this.deps.getAllPersistedSessionsForWorktreeGuard();
			for (const ps of allPersisted) {
				if (!ps.archived && ps.branch) persistedBranches.add(ps.branch);
			}
			const runtimeRecords: WorktreeReferenceRecord[] = this.deps.listLiveSessionWorktreeRefs().map(s => ({
				id: s.id,
				worktreePath: s.worktreePath,
				cwd: s.cwd,
				repoWorktrees: s.repoWorktrees
					? Object.fromEntries(s.repoWorktrees.map(w => [w.repo, w.worktreePath]))
					: undefined,
			}));
			const allPathRecords: WorktreeReferenceRecord[] = [...allPersisted, ...runtimeRecords];

			const orphans: Array<{ path: string; branch: string }> = [];
			for (const block of blocks) {
				const branchMatch = block.match(/^branch refs\/heads\/(session\/.+)$/m);
				if (!branchMatch) continue;
				const branch = branchMatch[1];
				if (branch.startsWith("session/_pool-")) continue;
				const pathMatch = block.match(/^worktree (.+)$/m);
				if (!pathMatch) continue;
				const wtPath = pathMatch[1];
				const isActive = isWorktreePathReferencedByLiveSession(wtPath, allPathRecords) || persistedBranches.has(branch);
				if (!isActive) {
					orphans.push({ path: wtPath, branch });
				}
			}
			return orphans;
		} catch (err) {
			console.warn("[session-manager] Failed to list orphaned session worktrees:", err);
			return [];
		}
	}

	/**
	 * List orphaned non-interactive sessions (e.g. verification reviewers)
	 * that have no tracking in the verification harness. Read-only.
	 */
	async listOrphanedNonInteractiveSessions(): Promise<Array<{ id: string; title: string; createdAt: number }>> {
		const resumingIds = this.deps.getVerificationHarness()?.getResumingSessionIds() ?? new Set<string>();
		const result: Array<{ id: string; title: string; createdAt: number }> = [];
		const allLive = this.deps.projectContextManager
			? [...this.deps.projectContextManager.getAllLiveSessions()]
			: (this.deps.testStore?.getLive() ?? []);
		for (const ps of allLive) {
			if (ps.nonInteractive && !resumingIds.has(ps.id)) {
				result.push({ id: ps.id, title: ps.title, createdAt: ps.createdAt });
			}
		}
		return result;
	}

	/**
	 * Terminate a list of orphaned non-interactive sessions.
	 * Returns the number actually terminated.
	 */
	async terminateOrphanedSessions(sessionIds: string[]): Promise<number> {
		let terminated = 0;
		for (const id of sessionIds) {
			// Gate: refuse to archive if worktree dir + recent JSONL still present.
			// Catches the post-crash bulk-archive bug from goal sessions-p-14dc3ec7.
			const psForGate = this.deps.resolveStoreForId(id)?.get(id);
			if (psForGate && shouldKeepDespiteOrphan(psForGate)) {
				console.warn(`[orphan-cleanup] WARN: would-archive ${id} but worktree+recent-transcript present — leaving live`);
				continue;
			}
			try {
				const didTerminate = await this.deps.terminateSession(id);
				if (didTerminate) {
					terminated++;
				} else {
					// Session not in memory — try direct archive (cascade-reap children first)
					try {
						const ps = this.deps.resolveStoreForId(id)?.get(id);
						if (ps) {
							await this.deps.archiveWithCascade(id, this.deps.getSessionStore(ps.projectId));
							terminated++;
						}
					} catch { /* project gone */ }
				}
			} catch (err) {
				console.warn(`[session-manager] Failed to terminate orphan ${id}:`, err);
				// Try direct archive as fallback (cascade-reap children first)
				try {
					const ps = this.deps.resolveStoreForId(id)?.get(id);
					if (ps) {
						await this.deps.archiveWithCascade(id, this.deps.getSessionStore(ps.projectId));
						terminated++;
					}
				} catch { /* project gone */ }
			}
		}
		return terminated;
	}

	/**
	 * Get statistics about expired archives (past 7-day retention).
	 */
	async getExpiredArchiveStats(): Promise<{ count: number; totalSizeBytes: number }> {
		const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
		const cutoff = Date.now() - SEVEN_DAYS_MS;
		let count = 0;
		let totalSizeBytes = 0;

		const archived = this.deps.projectContextManager
			? [...this.deps.projectContextManager.all()].flatMap(ctx => ctx.sessionStore.getArchived())
			: (this.deps.testStore?.getArchived() ?? []);

		for (const ps of archived) {
			if (ps.archivedAt && ps.archivedAt < cutoff) {
				count++;
				if (ps.agentSessionFile) {
					try {
						const stat = fs.statSync(ps.agentSessionFile);
						totalSizeBytes += stat.size;
					} catch { /* file may not exist */ }
				}
			}
		}
		return { count, totalSizeBytes };
	}
}
