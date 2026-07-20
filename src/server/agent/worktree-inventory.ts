import { createHash } from "node:crypto";
import { promises as nodeFs, type Dirent } from "node:fs";
import path from "node:path";
import type { ProjectContextManager } from "./project-context-manager.js";
import type { SessionManager, ArchivedSessionWorktreeGroup, ArchivedSessionWorktreeItem, ArchivedSessionWorktreeScanResponse, ArchivedSessionWorktreeSelectionPreset, ArchivedSessionWorktreeSession, ArchivedWorktreeReason, ArchivedWorktreeReasonCategory, ArchivedWorktreeSelectionCategory, CleanupArchivedSessionWorktreesRequest, CleanupArchivedSessionWorktreesResponse, ArchivedSessionWorktreeCleanupResult } from "./session-manager.js";
import type { PersistedGoal } from "./goal-store.js";
import type { PersistedStaff } from "./staff-store.js";
import type { PersistedTeamEntry } from "./team-store.js";
import type { PersistedSession } from "./session-store.js";
import type { Component } from "./project-config-store.js";
import { normalizeWorktreeHostPath } from "./worktree-reference-guard.js";
import { branchToSlug, worktreeRoot as resolveWorktreeRoot } from "../skills/worktree-paths.js";
import { cleanupWorktree, shouldSkipRemotePushForTests, type RemoteGitPolicy } from "../skills/git.js";
import { realCommandRunner, type CommandRunner } from "../gateway-deps.js";
import { mapWithConcurrency, RECOVERY_IO_CONCURRENCY } from "./bounded-async-work.js";

export type WorktreeInventorySource =
	| "runtime-session"
	| "persisted-live-session"
	| "archived-session"
	| "goal"
	| "team"
	| "delegate"
	| "staff"
	| "pool"
	| "git-worktree"
	| "filesystem";

export type WorktreeInventoryClassification =
	| "ready-to-clean"
	| "protected-in-use"
	| "archived-owned"
	| "unowned-git-worktree"
	| "pool-entry"
	| "already-cleaned"
	| "stale-filesystem-only"
	| "scan-error";

export type WorktreeInventoryReason =
	| "safe-archived-session-worktree"
	| "safe-unowned-session-worktree"
	| "safe-pool-entry"
	| "referenced-by-live-session"
	| "referenced-by-live-goal"
	| "referenced-by-live-team"
	| "referenced-by-delegate"
	| "referenced-by-staff"
	| "referenced-by-pool"
	| "branch-referenced-by-live-record"
	| "branch-referenced-by-archived-record"
	| "git-worktree-metadata-missing"
	| "filesystem-only-needs-attention"
	| "sandbox-container-path"
	| "delegate-shared-worktree"
	| "primary-worktree"
	| "missing-repo-path"
	| "missing-worktree-path"
	| "git-scan-error"
	| "fs-scan-error";

export interface WorktreeInventoryItem {
	id: string;
	projectId: string;
	projectName: string;
	componentName?: string;
	repo: string;
	repoPath: string;
	worktreeRoot?: string;
	path: string;
	branch?: string;
	sources: WorktreeInventorySource[];
	owners: Array<{ type: WorktreeInventorySource; id: string; archived?: boolean; title?: string }>;
	classification: WorktreeInventoryClassification;
	disposition: "ready-to-clean" | "protected" | "already-cleaned" | "needs-attention" | "failed";
	reason: WorktreeInventoryReason;
	detail: string;
	actionable: boolean;
	selectable: boolean;
	defaultSelected: boolean;
	pathExists: boolean;
	gitWorktreeMetadataExists: boolean;
	localBranchExists?: boolean;
	willDeleteBranch: boolean;
	branchDeleteBlockedReason?: "branch-referenced-by-live-record" | "branch-referenced-by-archived-record";
	legacy?: {
		archivedSession?: Pick<ArchivedSessionWorktreeItem, "sessionId" | "repo" | "source" | "selectionCategories"> & { item: ArchivedSessionWorktreeItem };
		orphanedWorktree?: true;
	};
}

export interface WorktreeInventoryReport {
	items: WorktreeInventoryItem[];
	counts: {
		total: number;
		readyToClean: number;
		protectedInUse: number;
		archivedOwned: number;
		unownedGitWorktrees: number;
		poolEntries: number;
		alreadyCleaned: number;
		needsAttention: number;
		scanErrors: number;
		defaultSelected: number;
		byClassification: Partial<Record<WorktreeInventoryClassification, number>>;
		byReason: Partial<Record<WorktreeInventoryReason, number>>;
		bySource: Partial<Record<WorktreeInventorySource, number>>;
	};
	generatedAt: number;
}

export type WorktreeInventoryScanOptions = { include?: "all" | "actionable" | "troubleshooting"; mode?: "maintenance" | "boot" };
export type CleanupWorktreeInventoryRequest =
	| { mode: "all-safe" }
	| { mode: "selected"; itemIds: string[] }
	| { mode: "legacy-orphaned"; worktrees?: Array<{ path: string; branch: string; repoPath: string }> };

export interface CleanupWorktreeInventoryResponse {
	counts: {
		requested: number;
		cleaned: number;
		skipped: number;
		failed: number;
		branchDeleted: number;
		worktreeRemoved: number;
		notActionable: number;
		byStatus: Partial<Record<"cleaned" | "skipped" | "already-cleaned" | "failed", number>>;
		byReason: Partial<Record<WorktreeInventoryReason | "invalid-selection", number>>;
	};
	results: Array<{
		itemId: string;
		path?: string;
		repoPath?: string;
		branch?: string;
		status: "cleaned" | "skipped" | "already-cleaned" | "failed";
		reason?: WorktreeInventoryReason | "invalid-selection";
		detail?: string;
		worktreeRemoved: boolean;
		branchDeleted: boolean;
		error?: string;
	}>;
	generatedAt: number;
}

export interface WorktreePoolSnapshot {
	entries: Array<{
		branchName: string;
		worktreePath: string;
		worktrees?: Array<{ repo: string; repoPath: string; worktreePath: string }>;
		createdAt: number;
	}>;
	target: number;
	filling: boolean;
}

export interface WorktreeInventoryFs {
	access(filePath: string): Promise<void>;
	readdir(dirPath: string, options: { withFileTypes: true }): Promise<Dirent[]>;
}

export interface WorktreeInventoryDeps {
	projectContextManager: ProjectContextManager;
	sessionManager: SessionManager;
	clock?: () => number;
	/** Promise-only filesystem seam for inventory discovery and verification. */
	fs?: WorktreeInventoryFs;
	/** Test seam; production uses the shared background-I/O ceiling. */
	ioConcurrency?: number;
	execGit?: (repoPath: string, args: readonly string[], opts?: { timeoutMs?: number }) => Promise<string>;
	commandRunner?: CommandRunner;
	remotePolicy?: RemoteGitPolicy;
}

interface ParsedGitWorktree { path: string; branch?: string }
interface RepoDescriptor { projectId: string; projectName: string; repo: string; componentName?: string; repoPath: string; worktreeRoot: string; components: Component[]; primary: boolean; archivedOnly?: boolean }
interface Candidate {
	projectId: string;
	projectName: string;
	componentName?: string;
	repo: string;
	repoPath: string;
	worktreeRoot?: string;
	path: string;
	branch?: string;
	sources: Set<WorktreeInventorySource>;
	owners: Array<{ type: WorktreeInventorySource; id: string; archived?: boolean; title?: string }>;
	pathExists: boolean;
	gitWorktreeMetadataExists: boolean;
	legacyArchived?: ArchivedSessionWorktreeItem;
	primary?: boolean;
	scanError?: { reason: WorktreeInventoryReason; detail: string };
}

interface GuardIndexes {
	pathOwners: Map<string, Array<{ type: WorktreeInventorySource; id: string; archived?: boolean; title?: string }>>;
	cwdOwners: Array<{ path: string; owner: { type: WorktreeInventorySource; id: string; archived?: boolean; title?: string } }>;
	liveBranches: Map<string, Set<string>>;
	archivedBranches: Map<string, Map<string, Set<string>>>;
}

type CleanupSelectionPolicy = "all-safe" | "selected" | "legacy-orphaned";

// Maintenance requests construct separate service instances, so the mutation
// queue must be shared at module scope. Read-only scans may overlap; only Git
// mutations for the same repository are serialized.
const repoMutationTails = new Map<string, Promise<void>>();

async function withRepoMutation<T>(repoPath: string, mutate: () => Promise<T>): Promise<T> {
	const key = repoKey(repoPath);
	const previous = repoMutationTails.get(key) ?? Promise.resolve();
	let release!: () => void;
	const turn = new Promise<void>(resolve => { release = resolve; });
	const tail = previous.then(() => turn);
	repoMutationTails.set(key, tail);
	await previous;
	try {
		return await mutate();
	} finally {
		release();
		if (repoMutationTails.get(key) === tail) repoMutationTails.delete(key);
	}
}

export function isContainerInternalWorktreePath(candidatePath: string | undefined): boolean {
	if (!candidatePath) return false;
	const normalized = candidatePath.replace(/\\/g, "/");
	return normalized === "/workspace" || normalized.startsWith("/workspace/") || normalized === "/workspace-wt" || normalized.startsWith("/workspace-wt/");
}

export function isBobbitPoolBranch(branch: string | undefined): boolean {
	return !!branch && (branch.startsWith("pool/_pool-") || branch.startsWith("session/_pool-"));
}

function isLegacySessionOrphanBranch(branch: string | undefined): boolean {
	return !!branch && branch.startsWith("session/") && !isBobbitPoolBranch(branch);
}

function isBobbitOwnedBranch(branch: string | undefined): boolean {
	return !!branch && (branch.startsWith("session/") || branch.startsWith("goal/") || branch.startsWith("staff-") || isBobbitPoolBranch(branch));
}

function norm(p?: string): string | undefined { return normalizeWorktreeHostPath(p); }
function repoKey(repoPath: string | undefined): string { return norm(repoPath) ?? ""; }
function stableId(prefix: string, ...parts: Array<string | undefined>): string {
	return `${prefix}:${createHash("sha1").update(parts.map(p => p ?? "").join("\0")).digest("hex").slice(0, 16)}`;
}

function isMissingFsError(err: unknown): boolean {
	return (err as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

const realWorktreeInventoryFs: WorktreeInventoryFs = {
	access: filePath => nodeFs.access(filePath),
	readdir: (dirPath, options) => nodeFs.readdir(dirPath, options),
};

export function parseGitWorktreeList(stdout: string): ParsedGitWorktree[] {
	const out: ParsedGitWorktree[] = [];
	for (const block of stdout.split(/\r?\n\r?\n/)) {
		if (!block.trim()) continue;
		const pathMatch = block.match(/^worktree (.+)$/m);
		if (!pathMatch) continue;
		const branchMatch = block.match(/^branch refs\/heads\/(.+)$/m);
		out.push({ path: pathMatch[1].trim(), branch: branchMatch?.[1]?.trim() });
	}
	return out;
}

export function classifyPoolReclaimCandidate(opts: {
	resolvedWorktreeRoot: string;
	candidatePath: string;
	branch?: string;
	activeWorktreePaths?: Set<string>;
	gitMetadataExists?: boolean;
}): { eligible: boolean; reason: WorktreeInventoryReason; detail: string } {
	if (isContainerInternalWorktreePath(opts.candidatePath)) return { eligible: false, reason: "sandbox-container-path", detail: "Container-internal paths are not host cleanup targets." };
	const candidate = norm(opts.candidatePath);
	const root = norm(opts.resolvedWorktreeRoot);
	if (!candidate || !root || !(candidate === root || candidate.startsWith(`${root}/`))) {
		return { eligible: false, reason: "filesystem-only-needs-attention", detail: "Candidate is outside the resolved Bobbit worktree root." };
	}
	if (opts.activeWorktreePaths) {
		for (const active of opts.activeWorktreePaths) {
			const activeNorm = norm(active);
			if (activeNorm && (activeNorm === candidate || activeNorm.startsWith(`${candidate}/`) || candidate.startsWith(`${activeNorm}/`))) {
				return { eligible: false, reason: "referenced-by-live-session", detail: "A live worktree path still references this candidate." };
			}
		}
	}
	if (!opts.gitMetadataExists) return { eligible: false, reason: "git-worktree-metadata-missing", detail: "Pool candidate has no git worktree metadata." };
	if (!isBobbitPoolBranch(opts.branch)) return { eligible: false, reason: "filesystem-only-needs-attention", detail: "Candidate branch is not a Bobbit pool branch." };
	const expectedSlug = branchToSlug(opts.branch!);
	if (path.basename(opts.candidatePath) !== expectedSlug) {
		return { eligible: false, reason: "filesystem-only-needs-attention", detail: "Pool candidate directory does not match the pool branch slug." };
	}
	return { eligible: true, reason: "safe-pool-entry", detail: "Pool worktree can be reclaimed by the worktree pool." };
}

export class WorktreeInventoryService {
	private readonly deps: WorktreeInventoryDeps;
	private readonly clock: () => number;
	private readonly fsa: WorktreeInventoryFs;
	private readonly ioConcurrency: number;

	constructor(deps: WorktreeInventoryDeps) {
		this.deps = deps;
		this.clock = deps.clock ?? (() => Date.now());
		this.fsa = deps.fs ?? realWorktreeInventoryFs;
		this.ioConcurrency = deps.ioConcurrency ?? RECOVERY_IO_CONCURRENCY;
		if (!Number.isInteger(this.ioConcurrency) || this.ioConcurrency <= 0) throw new RangeError("inventory I/O concurrency must be a positive integer");
	}

	async scan(opts?: WorktreeInventoryScanOptions): Promise<WorktreeInventoryReport> {
		const repos = await this.discoverRepos();
		const candidates = new Map<string, Candidate>();
		const addCandidate = (repo: RepoDescriptor, wtPath: string, source: WorktreeInventorySource, branch?: string, extra?: Partial<Candidate>) => {
			const key = `${repo.projectId}|${repo.repo}|${norm(wtPath) ?? wtPath}`;
			let c = candidates.get(key);
			if (!c) {
				c = { projectId: repo.projectId, projectName: repo.projectName, componentName: repo.componentName, repo: repo.repo, repoPath: repo.repoPath, worktreeRoot: repo.worktreeRoot, path: wtPath, branch, sources: new Set(), owners: [], pathExists: false, gitWorktreeMetadataExists: false };
				candidates.set(key, c);
			}
			c.sources.add(source);
			if (branch && !c.branch) c.branch = branch;
			Object.assign(c, extra);
			return c;
		};

		const repoScans = await mapWithConcurrency(repos, this.ioConcurrency, async repo => {
			if (!await this.exists(repo.repoPath) || !await this.exists(path.join(repo.repoPath, ".git"))) {
				return { repo, worktrees: [] as ParsedGitWorktree[] };
			}
			try {
				const stdout = await this.execGit(repo.repoPath, ["worktree", "list", "--porcelain"], { timeoutMs: 10_000 });
				return { repo, worktrees: parseGitWorktreeList(stdout) };
			} catch (err) {
				return { repo, worktrees: [] as ParsedGitWorktree[], error: err instanceof Error ? err.message : String(err) };
			}
		});
		for (const result of repoScans) {
			if (result.error !== undefined) {
				const scanPath = path.join(result.repo.worktreeRoot, `.scan-error-${branchToSlug(result.repo.repo)}`);
				addCandidate(result.repo, scanPath, "git-worktree", undefined, { scanError: { reason: "git-scan-error", detail: result.error } });
				continue;
			}
			for (const wt of result.worktrees) {
				const primary = norm(wt.path) === norm(result.repo.repoPath);
				addCandidate(result.repo, wt.path, "git-worktree", wt.branch, { gitWorktreeMetadataExists: true, primary });
			}
		}

		await this.addFilesystemCandidates(repos, addCandidate);
		this.addPoolCandidates(repos, addCandidate);
		await this.addArchivedCandidates(repos, candidates);

		const candidateList = [...candidates.values()];
		await mapWithConcurrency(candidateList, this.ioConcurrency, async candidate => {
			candidate.pathExists = await this.exists(candidate.path);
			if (candidate.legacyArchived) candidate.legacyArchived.pathExists = candidate.pathExists;
		});
		const localBranches = await mapWithConcurrency(candidateList, this.ioConcurrency, candidate => this.localBranchExists(candidate.repoPath, candidate.branch));
		// Ownership is the final asynchronous scan phase. Guard stores and pool
		// snapshots are read only after their async repo-path prerequisites settle,
		// so a claim arriving during any earlier filesystem/Git work is observed.
		const guards = await this.buildGuards();
		for (const candidate of candidateList) this.attachOwners(candidate, guards);
		let items = candidateList.map((candidate, index) => this.classify(candidate, guards, localBranches[index] ?? false));
		items.sort((a, b) => a.projectName.localeCompare(b.projectName) || a.repo.localeCompare(b.repo) || a.path.localeCompare(b.path));
		if (opts?.include === "actionable") items = items.filter(item => item.actionable);
		if (opts?.include === "troubleshooting") items = items.filter(item => !item.actionable);
		return { items, counts: this.counts(items), generatedAt: this.clock() };
	}

	async cleanup(request: CleanupWorktreeInventoryRequest): Promise<CleanupWorktreeInventoryResponse> {
		const report = await this.scan({ include: "all" });
		const byId = new Map(report.items.map(item => [item.id, item]));
		const response: CleanupWorktreeInventoryResponse = {
			counts: { requested: 0, cleaned: 0, skipped: 0, failed: 0, branchDeleted: 0, worktreeRemoved: 0, notActionable: 0, byStatus: {}, byReason: {} },
			results: [],
			generatedAt: this.clock(),
		};
		const record = (result: CleanupWorktreeInventoryResponse["results"][number]) => {
			response.results.push(result);
			response.counts.byStatus[result.status] = (response.counts.byStatus[result.status] ?? 0) + 1;
			if (result.reason) response.counts.byReason[result.reason] = (response.counts.byReason[result.reason] ?? 0) + 1;
			if (result.worktreeRemoved) response.counts.worktreeRemoved++;
			if (result.branchDeleted) response.counts.branchDeleted++;
			if (result.status === "cleaned") response.counts.cleaned++;
			if (result.status === "skipped") response.counts.skipped++;
			if (result.status === "failed") response.counts.failed++;
			if (result.status === "already-cleaned") response.counts.skipped++;
		};

		let selected: WorktreeInventoryItem[] = [];
		const invalidIds: string[] = [];
		if (request.mode === "all-safe") {
			selected = report.items.filter(item => item.actionable && item.defaultSelected);
		} else if (request.mode === "selected") {
			for (const id of request.itemIds) {
				const item = byId.get(id);
				if (item) selected.push(item); else invalidIds.push(id);
			}
		} else {
			if (request.worktrees) {
				for (const wt of request.worktrees) {
					const item = report.items.find(candidate => candidate.legacy?.orphanedWorktree && candidate.path === wt.path && candidate.branch === wt.branch && norm(candidate.repoPath) === norm(wt.repoPath));
					if (item) selected.push(item); else invalidIds.push(stableId("legacy-orphaned", wt.repoPath, wt.path, wt.branch));
				}
			} else {
				selected = report.items.filter(item => item.legacy?.orphanedWorktree && item.actionable);
			}
		}
		const seen = new Set<string>();
		selected = selected.filter(item => { if (seen.has(item.id)) return false; seen.add(item.id); return true; });
		response.counts.requested = selected.length + invalidIds.length;
		for (const id of invalidIds) record({ itemId: id, status: "skipped", reason: "invalid-selection", detail: "Selection did not match a fresh cleanup candidate.", worktreeRemoved: false, branchDeleted: false });

		const selectionPolicy: CleanupSelectionPolicy = request.mode;
		const cleanupResults = await mapWithConcurrency(selected, this.ioConcurrency, item => this.cleanupItem(item, selectionPolicy));
		for (const result of cleanupResults) {
			if (result.status === "skipped" && result.reason !== "invalid-selection") response.counts.notActionable++;
			record(result);
		}
		return response;
	}

	private async cleanupItem(item: WorktreeInventoryItem, policy: CleanupSelectionPolicy): Promise<CleanupWorktreeInventoryResponse["results"][number]> {
		try {
			const prepared = await withRepoMutation(item.repoPath, async () => {
				const revalidated = await this.revalidateCleanupItem(item, policy);
				if ("status" in revalidated) return revalidated;
				// No await belongs between the fresh scan result and the mutation: the
				// scan's final phase rebuilt every ownership and actionability guard.
				await cleanupWorktree(revalidated.repoPath, revalidated.path, revalidated.branch, false, this.deps.commandRunner ?? realCommandRunner, this.deps.remotePolicy ?? {});
				return revalidated;
			});
			if ("status" in prepared) return prepared;
			const removed = await this.worktreeRemoved(prepared);
			if (!removed) {
				return { itemId: item.id, path: prepared.path, repoPath: prepared.repoPath, branch: prepared.branch, status: "failed", reason: "git-scan-error", error: "cleanup did not remove worktree path or git metadata", worktreeRemoved: false, branchDeleted: false };
			}
			const branchDeleted = await withRepoMutation(prepared.repoPath, () => this.deleteBranchIfStillAllowed(prepared));
			return { itemId: item.id, path: prepared.path, repoPath: prepared.repoPath, branch: prepared.branch, status: "cleaned", reason: prepared.reason, worktreeRemoved: true, branchDeleted };
		} catch (err) {
			return { itemId: item.id, path: item.path, repoPath: item.repoPath, branch: item.branch, status: "failed", reason: "git-scan-error", error: err instanceof Error ? err.message : String(err), worktreeRemoved: false, branchDeleted: false };
		}
	}

	private async revalidateCleanupItem(item: WorktreeInventoryItem, policy: CleanupSelectionPolicy): Promise<WorktreeInventoryItem | CleanupWorktreeInventoryResponse["results"][number]> {
		// cleanupItem already runs under the outer shared ceiling. Use a serial
		// scanner here so per-item revalidation cannot multiply that concurrency.
		const revalidator = new WorktreeInventoryService({ ...this.deps, clock: this.clock, fs: this.fsa, ioConcurrency: 1 });
		const report = await revalidator.scan({ include: "all" });
		const current = report.items.find(candidate => candidate.id === item.id);
		if (!current) {
			const sameTarget = report.items.find(candidate => norm(candidate.repoPath) === norm(item.repoPath) && norm(candidate.path) === norm(item.path));
			if (sameTarget) {
				return { itemId: item.id, path: sameTarget.path, repoPath: sameTarget.repoPath, branch: sameTarget.branch, status: "skipped", reason: sameTarget.actionable ? "invalid-selection" : sameTarget.reason, detail: sameTarget.actionable ? "Candidate ownership changed during cleanup revalidation." : sameTarget.detail, worktreeRemoved: false, branchDeleted: false };
			}
			const repoScanError = report.items.find(candidate => norm(candidate.repoPath) === norm(item.repoPath) && candidate.classification === "scan-error");
			if (repoScanError) {
				return { itemId: item.id, path: item.path, repoPath: item.repoPath, branch: item.branch, status: "failed", reason: repoScanError.reason, detail: repoScanError.detail, error: repoScanError.detail, worktreeRemoved: false, branchDeleted: false };
			}
			return { itemId: item.id, path: item.path, repoPath: item.repoPath, branch: item.branch, status: "already-cleaned", reason: "git-worktree-metadata-missing", detail: "Worktree is already absent from the current inventory.", worktreeRemoved: false, branchDeleted: false };
		}
		if (current.classification === "already-cleaned") {
			return { itemId: item.id, path: current.path, repoPath: current.repoPath, branch: current.branch, status: "already-cleaned", reason: current.reason, detail: current.detail, worktreeRemoved: false, branchDeleted: false };
		}
		const policyAllows = current.actionable
			&& (policy !== "all-safe" || current.defaultSelected)
			&& (policy !== "legacy-orphaned" || !!current.legacy?.orphanedWorktree);
		if (!policyAllows) {
			return { itemId: item.id, path: current.path, repoPath: current.repoPath, branch: current.branch, status: "skipped", reason: current.reason, detail: current.detail, worktreeRemoved: false, branchDeleted: false };
		}
		return current;
	}

	async legacyOrphanedWorktrees(): Promise<{ worktrees: Array<{ path: string; branch: string; repoPath: string }> }> {
		const report = await this.scan({ include: "all" });
		return { worktrees: report.items.filter(item => item.legacy?.orphanedWorktree && item.actionable && item.branch).map(item => ({ path: item.path, branch: item.branch!, repoPath: item.repoPath })) };
	}

	async legacyArchivedSessionWorktrees(includeAlreadyCleaned = false): Promise<ArchivedSessionWorktreeScanResponse> {
		const report = await this.scan({ include: "all" });
		const allItems = report.items
			.filter(item => item.legacy?.archivedSession)
			.map(item => this.archivedItemFromInventory(item));
		const sessionsById = new Map<string, ArchivedSessionWorktreeSession>();
		for (const item of allItems) {
			let session = sessionsById.get(item.sessionId);
			if (!session) {
				session = {
					id: item.sessionId,
					title: item.title,
					archivedAt: item.archivedAt,
					projectId: item.projectId,
					projectName: item.projectName,
					goalId: item.goalId,
					teamGoalId: item.teamGoalId,
					delegateOf: item.delegateOf,
					parentSessionId: item.parentSessionId,
					childKind: item.childKind,
					sandboxed: item.sandboxed,
					branch: item.branch,
					repoPath: item.repoPath,
					worktreePath: item.path,
					worktrees: [],
				};
				sessionsById.set(item.sessionId, session);
			}
			session.worktrees.push(item);
		}
		const sessions = [...sessionsById.values()].filter(session => includeAlreadyCleaned || !session.worktrees.every(item => item.status === "already-cleaned"));
		const responseItems = sessions.flatMap(session => session.worktrees);
		return {
			sessions,
			items: responseItems,
			counts: this.archivedCounts(allItems),
			groups: this.archivedGroups(allItems),
			selectionPresets: this.archivedSelectionPresets(responseItems),
			generatedAt: report.generatedAt,
		};
	}

	async cleanupLegacyArchivedSessionWorktrees(request: CleanupArchivedSessionWorktreesRequest): Promise<CleanupArchivedSessionWorktreesResponse> {
		const scan = await this.legacyArchivedSessionWorktrees(true);
		const rows = scan.items.map(item => ({ session: scan.sessions.find(session => session.id === item.sessionId), item }));
		let selected: Array<{ session?: ArchivedSessionWorktreeSession; item: ArchivedSessionWorktreeItem }> = [];
		const invalidSelections: ArchivedSessionWorktreeCleanupResult[] = [];
		if (request.mode === "all") {
			selected = rows.filter(row => row.item.status === "removable");
		} else if (request.mode === "selected" && request.sessionIds) {
			const ids = new Set(request.sessionIds);
			selected = rows.filter(row => ids.has(row.item.sessionId));
			for (const id of ids) if (!rows.some(row => row.item.sessionId === id)) invalidSelections.push({ key: id, sessionId: id, status: "skipped", reason: "invalid-selection", worktreeRemoved: false, branchDeleted: false });
		} else if (request.mode === "selected" && request.worktrees) {
			for (const selector of request.worktrees) {
				const match = rows.find(row => {
					if (row.item.sessionId !== selector.sessionId) return false;
					if (selector.key) return row.item.key === selector.key;
					if (selector.repo !== undefined && row.item.repo !== selector.repo) return false;
					if (selector.path !== undefined && norm(row.item.path) !== norm(selector.path)) return false;
					return selector.repo !== undefined || selector.path !== undefined;
				});
				if (match) selected.push(match);
				else invalidSelections.push({ key: selector.key ?? `${selector.sessionId}:${selector.repo ?? ""}:${selector.path ?? ""}`, sessionId: selector.sessionId, repo: selector.repo, path: selector.path, status: "skipped", reason: "invalid-selection", worktreeRemoved: false, branchDeleted: false });
			}
		} else if (request.mode === "category") {
			const categories = new Set(request.categories);
			const repoFilter = norm(request.repoPath);
			selected = rows.filter(row => row.item.status === "removable" && row.item.selectionCategories.some(category => categories.has(category)) && (!request.projectId || row.item.projectId === request.projectId) && (!repoFilter || norm(row.item.repoPath) === repoFilter));
		} else if (request.mode === "preset") {
			const preset = scan.selectionPresets.find(candidate => candidate.id === request.presetId);
			if (!preset) throw new Error("Invalid cleanup preset");
			const keys = new Set(preset.worktreeKeys);
			selected = rows.filter(row => row.item.status === "removable" && keys.has(row.item.key));
		}

		const seen = new Set<string>();
		selected = selected.filter(row => { if (seen.has(row.item.key)) return false; seen.add(row.item.key); return true; });
		const byKey = new Map(selected.map(row => [row.item.key, row]));
		const cleanup = await this.cleanup({ mode: "selected", itemIds: selected.map(row => stableId("archived", row.item.key)) });
		const response: CleanupArchivedSessionWorktreesResponse = { counts: this.zeroArchivedCleanupCounts(), results: [], generatedAt: cleanup.generatedAt };
		const record = (result: ArchivedSessionWorktreeCleanupResult) => {
			response.results.push(result);
			response.counts.byStatus[result.status] = (response.counts.byStatus[result.status] ?? 0) + 1;
			if (result.reason) response.counts.byReason[result.reason] = (response.counts.byReason[result.reason] ?? 0) + 1;
			if (result.worktreeRemoved) response.counts.worktreeRemoved++;
			if (result.branchDeleted) response.counts.branchDeleted++;
			if (result.reason === "invalid-selection") response.counts.invalidSelection++;
			if (result.status === "cleaned") response.counts.cleaned++;
			if (result.status === "already-cleaned") response.counts.alreadyCleaned++;
			if (result.status === "failed") response.counts.failed++;
			if (result.status === "skipped") {
				response.counts.skipped++;
				if (result.reason !== "invalid-selection") response.counts.notActionable++;
			}
		};
		for (const invalid of invalidSelections) record(invalid);
		for (const result of cleanup.results) {
			const key = result.itemId.startsWith("archived:") ? [...byKey.keys()].find(candidate => stableId("archived", candidate) === result.itemId) : undefined;
			const row = key ? byKey.get(key) : undefined;
			const item = row?.item;
			const base = {
				key: item?.key ?? result.itemId,
				sessionId: item?.sessionId ?? result.itemId,
				title: row?.session?.title ?? item?.title,
				repo: item?.repo,
				repoPath: item?.repoPath ?? result.repoPath,
				path: item?.path ?? result.path,
				branch: item?.branch ?? result.branch,
			};
			if (result.status === "cleaned") record({ ...base, status: "cleaned", reason: result.branchDeleted ? "worktree-and-branch-cleaned" : "worktree-cleaned", worktreeRemoved: result.worktreeRemoved, branchDeleted: result.branchDeleted });
			else if (result.status === "already-cleaned") record({ ...base, status: "already-cleaned", reason: "already-cleaned", detail: result.detail, worktreeRemoved: false, branchDeleted: false });
			else if (result.status === "failed") record({ ...base, status: "failed", reason: "scan-error", detail: result.detail, error: result.error, worktreeRemoved: false, branchDeleted: false });
			else record({ ...base, status: "skipped", reason: this.archivedReasonFromInventory(result.reason, item), detail: result.detail, worktreeRemoved: false, branchDeleted: false });
		}
		response.counts.requested = response.results.length;
		return response;
	}

	private archivedItemFromInventory(item: WorktreeInventoryItem): ArchivedSessionWorktreeItem {
		const legacy = item.legacy!.archivedSession!.item;
		const reason = this.archivedReasonFromInventory(item.reason, legacy) as ArchivedWorktreeReason;
		const status: ArchivedSessionWorktreeItem["status"] = item.classification === "archived-owned" ? "removable" : item.classification === "already-cleaned" ? "already-cleaned" : "skipped";
		const disposition: ArchivedSessionWorktreeItem["disposition"] = status === "removable" ? "ready-to-clean" : status === "already-cleaned" ? "already-cleaned" : reason === "stale-worktree-directory" ? "needs-attention" : reason === "scan-error" ? "failed" : "ineligible";
		return {
			...legacy,
			pathExists: item.pathExists,
			gitWorktreeMetadataExists: item.gitWorktreeMetadataExists,
			localBranchExists: !!item.localBranchExists,
			status,
			reason,
			detail: item.detail,
			willDeleteBranch: item.willDeleteBranch,
			branchDeleteBlockedReason: item.branchDeleteBlockedReason,
			disposition,
			reasonCategory: this.archivedReasonCategory(reason),
			actionable: status === "removable" && item.actionable,
			selectable: status === "removable" && item.selectable,
			defaultSelected: status === "removable" && item.defaultSelected,
		};
	}

	private archivedReasonFromInventory(reason: WorktreeInventoryReason | "invalid-selection" | undefined, fallback?: ArchivedSessionWorktreeItem): ArchivedWorktreeReason | "invalid-selection" {
		if (!reason) return fallback?.reason ?? "scan-error";
		if (reason === "invalid-selection") return "invalid-selection";
		switch (reason) {
			case "safe-archived-session-worktree": return "safe-archived-session-worktree";
			case "git-worktree-metadata-missing": return "already-cleaned";
			case "missing-worktree-path": return "no-worktree-path";
			case "missing-repo-path": return "missing-repo-path";
			case "sandbox-container-path": return "sandbox-container-path";
			case "delegate-shared-worktree": return "delegate-shared-worktree";
			case "filesystem-only-needs-attention": return "stale-worktree-directory";
			case "referenced-by-live-goal": return "referenced-by-live-goal";
			case "referenced-by-live-team": return "referenced-by-live-team";
			case "referenced-by-staff": return "referenced-by-staff";
			case "referenced-by-live-session":
			case "referenced-by-delegate":
			case "referenced-by-pool":
			case "safe-pool-entry":
			case "branch-referenced-by-live-record": return "referenced-by-live-session";
			case "primary-worktree":
			case "branch-referenced-by-archived-record":
			case "safe-unowned-session-worktree":
			case "git-scan-error":
			case "fs-scan-error": return "scan-error";
			default: return fallback?.reason ?? "scan-error";
		}
	}

	private archivedCounts(items: ArchivedSessionWorktreeItem[]): ArchivedSessionWorktreeScanResponse["counts"] {
		const counts: ArchivedSessionWorktreeScanResponse["counts"] = { archivedSessions: new Set(items.map(item => item.sessionId)).size, sessionsWithWorktrees: 0, removableWorktrees: 0, skippedWorktrees: 0, alreadyCleanedWorktrees: 0, totalItems: items.length, readyToClean: 0, defaultSelected: 0, alreadyCleaned: 0, ineligible: 0, needsAttention: 0, failed: 0, byDisposition: {}, byReason: {}, bySelectionCategory: {} };
		const bySession = new Map<string, ArchivedSessionWorktreeItem[]>();
		for (const item of items) {
			const sessionItems = bySession.get(item.sessionId) ?? [];
			sessionItems.push(item);
			bySession.set(item.sessionId, sessionItems);
			if (item.status === "removable") counts.removableWorktrees++;
			else if (item.status === "already-cleaned") counts.alreadyCleanedWorktrees++;
			else counts.skippedWorktrees++;
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
		for (const sessionItems of bySession.values()) if (sessionItems.some(item => item.status !== "already-cleaned" && item.reason !== "no-worktree-path")) counts.sessionsWithWorktrees++;
		return counts;
	}

	private archivedGroups(items: ArchivedSessionWorktreeItem[]): ArchivedSessionWorktreeGroup[] {
		const groupSpecs: Array<{ key: string; label: string; description: string; disposition: ArchivedSessionWorktreeItem["disposition"]; reason?: ArchivedWorktreeReason }> = [
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
			const matches = spec.key === "ready-to-clean" ? items.filter(item => item.disposition === "ready-to-clean") : items.filter(item => item.reason === spec.reason);
			if (matches.length === 0) return [];
			const sampleItems = matches.slice(0, 5);
			return [{ key: spec.key, label: spec.label, description: spec.description, disposition: spec.disposition, reason: spec.reason, reasonCategory: spec.reason ? this.archivedReasonCategory(spec.reason) : undefined, count: matches.length, sampleKeys: sampleItems.map(item => item.key), sampleItems, hasMore: matches.length > 5, actionable: spec.disposition === "ready-to-clean" }];
		});
	}

	private archivedSelectionPresets(items: ArchivedSessionWorktreeItem[]): ArchivedSessionWorktreeSelectionPreset[] {
		const actionable = items.filter(item => item.actionable);
		const makePreset = (id: string, label: string, description: string, matches: ArchivedSessionWorktreeItem[], cleanupRequest: CleanupArchivedSessionWorktreesRequest): ArchivedSessionWorktreeSelectionPreset => ({ id, label, description, enabled: matches.length > 0, count: matches.length, worktreeKeys: matches.map(item => item.key), cleanupRequest });
		const presets: ArchivedSessionWorktreeSelectionPreset[] = [
			makePreset("all-removable", "Select all removable", "Select every archived-session worktree that is safe to clean.", actionable, { mode: "all" }),
			makePreset("category:archived-session", "Archived sessions only", "Select all actionable archived-session worktrees.", actionable.filter(item => item.selectionCategories.includes("archived-session")), { mode: "category", categories: ["archived-session"] }),
		];
		const categoryLabels: Partial<Record<ArchivedWorktreeSelectionCategory, string>> = { "goal-session": "Goal sessions", "team-session": "Goal/team worktrees", "delegate-session": "Delegate worktrees" };
		for (const category of ["goal-session", "team-session", "delegate-session"] as const) {
			const matches = actionable.filter(item => item.selectionCategories.includes(category));
			if (matches.length > 0) presets.push(makePreset(`category:${category}`, categoryLabels[category] ?? category, `Select actionable ${category.replace(/-/g, " ")} worktrees.`, matches, { mode: "category", categories: [category] }));
		}
		const projects = new Map<string, ArchivedSessionWorktreeItem[]>();
		const repos = new Map<string, ArchivedSessionWorktreeItem[]>();
		for (const item of actionable) {
			if (item.projectId) projects.set(item.projectId, [...(projects.get(item.projectId) ?? []), item]);
			const rk = norm(item.repoPath);
			if (rk) repos.set(rk, [...(repos.get(rk) ?? []), item]);
		}
		for (const [projectId, matches] of projects) presets.push(makePreset(`project:${projectId}`, matches[0]?.projectName ? `Current project: ${matches[0].projectName}` : "Current project", "Select actionable archived worktrees in this project.", matches, { mode: "category", categories: ["archived-session"], projectId }));
		for (const [repoPath, matches] of repos) presets.push(makePreset(`repo:${repoPath}`, matches[0]?.repoDisplayName ? `Repository: ${matches[0].repoDisplayName}` : "Repository", "Select actionable archived worktrees in this repository.", matches, { mode: "category", categories: ["archived-session"], repoPath }));
		return presets;
	}

	private archivedReasonCategory(reason: ArchivedWorktreeReason): ArchivedWorktreeReasonCategory {
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

	private zeroArchivedCleanupCounts(): CleanupArchivedSessionWorktreesResponse["counts"] {
		return { requested: 0, cleaned: 0, branchDeleted: 0, skipped: 0, alreadyCleaned: 0, failed: 0, worktreeRemoved: 0, invalidSelection: 0, notActionable: 0, byStatus: {}, byReason: {} };
	}

	private async discoverRepos(): Promise<RepoDescriptor[]> {
		const contexts = [...this.deps.projectContextManager.visible()];
		const batches = await mapWithConcurrency(contexts, this.ioConcurrency, async ctx => {
			const repos: RepoDescriptor[] = [];
			const components = ctx.projectConfigStore.getComponents();
			const configuredWorktreeRoot = ctx.projectConfigStore.get("worktree_root") || undefined;
			const multiRepo = components.some(c => c.repo !== ".");
			const singleRepoRoot = multiRepo ? undefined : await this.resolveSingleRepoRoot(ctx.project.rootPath);
			const worktreeRoot = resolveWorktreeRoot({ rootPath: multiRepo ? ctx.project.rootPath : singleRepoRoot!, worktreeRoot: configuredWorktreeRoot });
			const repoNames = new Set<string>();
			if (components.length === 0 || !multiRepo) repoNames.add(".");
			else for (const component of components) repoNames.add(component.repo);
			for (const repo of repoNames) {
				const repoPath = repo === "." ? (singleRepoRoot ?? await this.resolveSingleRepoRoot(ctx.project.rootPath)) : path.join(ctx.project.rootPath, repo);
				repos.push({ projectId: ctx.project.id, projectName: ctx.project.name, repo, componentName: components.find(c => c.repo === repo)?.name, repoPath, worktreeRoot, components, primary: repo === "." });
			}
			for (const session of ctx.sessionStore.getArchived() as PersistedSession[]) {
				for (const item of this.archivedItemsForSession(session, ctx.project.name)) {
					if (!item.repoPath) continue;
					repos.push({
						projectId: item.projectId ?? ctx.project.id,
						projectName: item.projectName ?? ctx.project.name,
						repo: item.repo,
						componentName: components.find(c => c.repo === item.repo)?.name,
						repoPath: item.repoPath,
						worktreeRoot,
						components,
						primary: item.repo === ".",
						archivedOnly: true,
					});
				}
			}
			return repos;
		});
		const repos: RepoDescriptor[] = [];
		const seen = new Set<string>();
		for (const batch of batches) {
			for (const repo of batch) {
				const key = `${repo.projectId}|${repo.repo}|${repoKey(repo.repoPath)}`;
				if (!repo.repoPath || seen.has(key)) continue;
				seen.add(key);
				repos.push(repo);
			}
		}
		return repos;
	}

	private async contextRepoPaths(ctx: { project: { rootPath: string }; projectConfigStore: { getComponents: () => Component[] } }): Promise<string[]> {
		const components = ctx.projectConfigStore.getComponents();
		const multiRepo = components.some(c => c.repo !== ".");
		if (!multiRepo) return [await this.resolveSingleRepoRoot(ctx.project.rootPath)];
		const seen = new Set<string>();
		const out: string[] = [];
		for (const component of components) {
			if (seen.has(component.repo)) continue;
			seen.add(component.repo);
			out.push(component.repo === "." ? await this.resolveSingleRepoRoot(ctx.project.rootPath) : path.join(ctx.project.rootPath, component.repo));
		}
		return out;
	}

	private async resolveSingleRepoRoot(projectRoot: string): Promise<string> {
		let current = path.resolve(projectRoot);
		for (;;) {
			if (await this.exists(path.join(current, ".git"))) return current;
			const parent = path.dirname(current);
			if (parent === current) return path.resolve(projectRoot);
			current = parent;
		}
	}

	private async addFilesystemCandidates(repos: RepoDescriptor[], addCandidate: (repo: RepoDescriptor, wtPath: string, source: WorktreeInventorySource, branch?: string, extra?: Partial<Candidate>) => void): Promise<void> {
		const reposByRoot = new Map<string, RepoDescriptor[]>();
		for (const repo of repos) {
			if (repo.archivedOnly) continue;
			const arr = reposByRoot.get(repo.worktreeRoot) ?? [];
			arr.push(repo);
			reposByRoot.set(repo.worktreeRoot, arr);
		}
		const rootGroups = [...reposByRoot].map(([root, group]) => ({ root, group }));
		const rootScans = await mapWithConcurrency(rootGroups, this.ioConcurrency, async ({ root, group }) => {
			try {
				const entries = await this.fsa.readdir(root, { withFileTypes: true });
				return { root, group, entries: entries.filter(entry => entry.isDirectory()) };
			} catch (err) {
				return { root, group, entries: [] as Dirent[], error: isMissingFsError(err) ? undefined : err instanceof Error ? err.message : String(err) };
			}
		});
		const pathChecks: Array<{ repo: RepoDescriptor; wtPath: string; checkPath: boolean }> = [];
		for (const scan of rootScans) {
			if (scan.error !== undefined) {
				const repo = scan.group[0];
				if (repo) addCandidate(repo, path.join(scan.root, ".fs-scan-error"), "filesystem", undefined, { scanError: { reason: "fs-scan-error", detail: scan.error } });
				continue;
			}
			const multi = scan.group.some(repo => repo.repo !== ".");
			for (const dirent of scan.entries) {
				const container = path.join(scan.root, dirent.name);
				for (const repo of scan.group) {
					const wtPath = multi && repo.repo !== "." ? path.join(container, repo.repo) : container;
					pathChecks.push({ repo, wtPath, checkPath: multi });
				}
			}
		}
		const present = await mapWithConcurrency(pathChecks, this.ioConcurrency, check => check.checkPath ? this.exists(check.wtPath) : Promise.resolve(true));
		for (let index = 0; index < pathChecks.length; index++) {
			if (present[index]) {
				const check = pathChecks[index]!;
				addCandidate(check.repo, check.wtPath, "filesystem");
			}
		}
	}

	private addPoolCandidates(repos: RepoDescriptor[], addCandidate: (repo: RepoDescriptor, wtPath: string, source: WorktreeInventorySource, branch?: string, extra?: Partial<Candidate>) => void): void {
		for (const [projectId, pool] of this.deps.sessionManager.getAllWorktreePools()) {
			const snapshot = pool.snapshotEntries();
			const projectRepos = repos.filter(repo => repo.projectId === projectId && !repo.archivedOnly);
			for (const entry of snapshot.entries) {
				if (entry.worktrees && entry.worktrees.length > 0) {
					for (const wt of entry.worktrees) {
						const repo = projectRepos.find(candidate => norm(candidate.repoPath) === norm(wt.repoPath) || candidate.repo === wt.repo) ?? projectRepos[0];
						if (repo) addCandidate({ ...repo, repo: wt.repo, repoPath: wt.repoPath }, wt.worktreePath, "pool", entry.branchName);
					}
				} else {
					const repo = projectRepos.find(candidate => candidate.repo === ".") ?? projectRepos[0];
					if (repo) addCandidate(repo, entry.worktreePath, "pool", entry.branchName);
				}
			}
		}
	}

	private async addArchivedCandidates(repos: RepoDescriptor[], candidates: Map<string, Candidate>): Promise<void> {
		for (const ctx of this.deps.projectContextManager.visible()) {
			for (const session of ctx.sessionStore.getArchived() as PersistedSession[]) {
				const projectName = ctx.project.name;
				for (const item of this.archivedItemsForSession(session, projectName)) {
					const repo = repos.find(candidate => norm(candidate.repoPath) === norm(item.repoPath) || (candidate.projectId === item.projectId && candidate.repo === item.repo))
						?? { projectId: item.projectId ?? ctx.project.id, projectName: item.projectName ?? projectName, repo: item.repo, repoPath: item.repoPath, worktreeRoot: item.path ? path.dirname(item.path) : undefined, components: [], primary: item.repo === "." } as RepoDescriptor;
					const key = item.path ? `${repo.projectId}|${repo.repo}|${norm(item.path) ?? item.path}` : `archived|${item.key}`;
					let c = candidates.get(key);
					if (!c) {
						c = { projectId: repo.projectId, projectName: item.projectName ?? projectName, repo: repo.repo, repoPath: item.repoPath, worktreeRoot: repo.worktreeRoot, path: item.path, branch: item.branch, sources: new Set(), owners: [], pathExists: false, gitWorktreeMetadataExists: false };
						candidates.set(key, c);
					}
					c.sources.add("archived-session");
					c.owners.push({ type: "archived-session", id: item.sessionId, archived: true, title: item.title });
					const gitMetadataMatchesArchivedRecord = c.gitWorktreeMetadataExists && (!item.branch || c.branch === item.branch);
					c.branch = c.branch ?? item.branch;
					c.gitWorktreeMetadataExists = gitMetadataMatchesArchivedRecord;
					c.legacyArchived = { ...item, gitWorktreeMetadataExists: gitMetadataMatchesArchivedRecord };
				}
			}
		}
	}

	private archivedItemsForSession(ps: PersistedSession, projectName?: string): ArchivedSessionWorktreeItem[] {
		const specs: Array<{ repo: string; repoPath?: string; worktreePath?: string; branch?: string; source: "repoWorktrees" | "sessionWorktree" }> = [];
		if (ps.repoWorktrees && Object.keys(ps.repoWorktrees).length > 0) {
			for (const [repo, wt] of Object.entries(ps.repoWorktrees)) specs.push({ repo, repoPath: ps.repoPath ? (repo === "." ? ps.repoPath : path.join(ps.repoPath, repo)) : undefined, worktreePath: wt, branch: ps.branch, source: "repoWorktrees" });
		} else {
			specs.push({ repo: ".", repoPath: ps.repoPath, worktreePath: ps.worktreePath, branch: ps.branch, source: "sessionWorktree" });
		}
		return specs.map(spec => this.archivedItemSkeleton(ps, spec, projectName));
	}

	private archivedItemSkeleton(ps: PersistedSession, spec: { repo: string; repoPath?: string; worktreePath?: string; branch?: string; source: "repoWorktrees" | "sessionWorktree" }, projectName?: string): ArchivedSessionWorktreeItem {
		const key = this.archivedWorktreeKey(ps.id, spec.repo, spec.worktreePath);
		const repoDisplayName = spec.repo === "." ? (projectName ?? (spec.repoPath ? path.basename(spec.repoPath) : ".")) : spec.repo;
		return {
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
			status: "skipped",
			reason: "scan-error",
			detail: "Pending unified inventory classification.",
			willDeleteBranch: false,
			disposition: "ineligible",
			reasonCategory: "error",
			actionable: false,
			selectable: false,
			defaultSelected: false,
			selectionCategories: this.archivedSelectionCategories(ps, spec.source),
		};
	}

	private archivedWorktreeKey(sessionId: string, repo: string, worktreePath: string | undefined): string {
		return `${sessionId}:${repo}:${norm(worktreePath) ?? ""}`;
	}

	private archivedSelectionCategories(ps: PersistedSession, source: "repoWorktrees" | "sessionWorktree"): ArchivedWorktreeSelectionCategory[] {
		const categories: ArchivedWorktreeSelectionCategory[] = ["archived-session"];
		if (ps.goalId) categories.push("goal-session");
		if (ps.teamGoalId) categories.push("team-session");
		if (ps.delegateOf) categories.push("delegate-session");
		if (ps.parentSessionId || ps.childKind) categories.push("child-session");
		categories.push(source === "repoWorktrees" ? "multi-repo" : "single-repo");
		return categories;
	}

	private async buildGuards(concurrency = this.ioConcurrency): Promise<GuardIndexes> {
		const guards: GuardIndexes = { pathOwners: new Map(), cwdOwners: [], liveBranches: new Map(), archivedBranches: new Map() };
		const addPath = (p: string | undefined, owner: { type: WorktreeInventorySource; id: string; archived?: boolean; title?: string }) => {
			const n = norm(p); if (!n) return;
			const arr = guards.pathOwners.get(n) ?? [];
			arr.push(owner); guards.pathOwners.set(n, arr);
		};
		const addCwd = (p: string | undefined, owner: { type: WorktreeInventorySource; id: string; archived?: boolean; title?: string }) => { const n = norm(p); if (n) guards.cwdOwners.push({ path: n, owner }); };
		const addBranch = (repoPath: string | undefined, branch: string | undefined, archived: boolean, key: string) => {
			const rk = repoKey(repoPath); if (!rk || !branch) return;
			if (archived) {
				const byBranch = guards.archivedBranches.get(rk) ?? new Map<string, Set<string>>();
				const set = byBranch.get(branch) ?? new Set<string>();
				set.add(key); byBranch.set(branch, set); guards.archivedBranches.set(rk, byBranch);
			} else {
				const set = guards.liveBranches.get(rk) ?? new Set<string>();
				set.add(branch); guards.liveBranches.set(rk, set);
			}
		};
		const addRecord = (record: { id: string; title?: string; repoPath?: string; branch?: string; worktreePath?: string; cwd?: string; repoWorktrees?: Record<string, string>; archived?: boolean }, type: WorktreeInventorySource, branchRepoPaths?: string[]) => {
			const owner = { type, id: record.id, archived: record.archived, title: record.title };
			addPath(record.worktreePath, owner); addCwd(record.cwd, owner);
			if (record.repoWorktrees) {
				for (const [repo, wt] of Object.entries(record.repoWorktrees)) {
					addPath(wt, owner);
					addBranch(record.repoPath ? (repo === "." ? record.repoPath : path.join(record.repoPath, repo)) : undefined, record.branch, !!record.archived, `${record.id}:${repo}:${norm(wt) ?? ""}`);
				}
			} else if (branchRepoPaths && branchRepoPaths.length > 0) {
				for (const repoPath of branchRepoPaths) addBranch(repoPath, record.branch, !!record.archived, `${record.id}:${repoKey(repoPath)}:${norm(record.worktreePath) ?? ""}`);
			} else addBranch(record.repoPath, record.branch, !!record.archived, `${record.id}:.:${norm(record.worktreePath) ?? ""}`);
		};
		const contexts = [...this.deps.projectContextManager.all()];
		let contextRows: Array<{ ctx: typeof contexts[number]; repoPaths: string[] }>;
		if (concurrency === 1) {
			contextRows = [];
			for (const ctx of contexts) contextRows.push({ ctx, repoPaths: await this.contextRepoPaths(ctx) });
		} else {
			contextRows = await mapWithConcurrency(contexts, concurrency, async ctx => ({ ctx, repoPaths: await this.contextRepoPaths(ctx) }));
		}
		// Do not snapshot mutable ownership until all async prerequisites above
		// have settled. Everything below runs in one uninterrupted turn.
		for (const session of this.deps.sessionManager.listSessions()) addRecord(session, session.delegateOf || session.parentSessionId || session.childKind ? "delegate" : "runtime-session");
		for (const { ctx, repoPaths: ctxRepoPaths } of contextRows) {
			for (const session of ctx.sessionStore.getLive()) addRecord(session, session.delegateOf || session.parentSessionId || session.childKind ? "delegate" : "persisted-live-session");
			for (const session of ctx.sessionStore.getArchived()) addRecord(session, "archived-session");
			for (const goal of ctx.goalStore.getAll() as PersistedGoal[]) addRecord({ ...goal, archived: goal.archived }, "goal");
			for (const team of ctx.teamStore.getAll() as PersistedTeamEntry[]) {
				for (const agent of team.agents) addRecord({ id: agent.sessionId, branch: agent.branch, worktreePath: agent.worktreePath }, "team", ctxRepoPaths);
				const lead = team.teamLeadSessionId && typeof ctx.sessionStore.get === "function" ? ctx.sessionStore.get(team.teamLeadSessionId) : undefined;
				if (lead) addRecord({ ...lead, archived: false }, "team");
			}
			for (const staff of ctx.staffStore.getAll() as PersistedStaff[]) addRecord(staff, "staff");
		}
		const repoPathsByProject = new Map(contextRows.map(({ ctx, repoPaths }) => [ctx.project.id, repoPaths]));
		for (const [projectId, pool] of this.deps.sessionManager.getAllWorktreePools()) {
			for (const entry of pool.snapshotEntries().entries) {
				const owner = { type: "pool" as const, id: `${projectId}:${entry.branchName}` };
				addPath(entry.worktreePath, owner);
				if (entry.worktrees) {
					for (const wt of entry.worktrees) {
						addPath(wt.worktreePath, owner);
						addBranch(wt.repoPath, entry.branchName, false, owner.id);
					}
				} else {
					for (const repoPath of repoPathsByProject.get(projectId) ?? []) addBranch(repoPath, entry.branchName, false, owner.id);
				}
			}
		}
		return guards;
	}

	private attachOwners(candidate: Candidate, guards: GuardIndexes): void {
		const seen = new Set(candidate.owners.map(o => `${o.type}:${o.id}`));
		const add = (owner: { type: WorktreeInventorySource; id: string; archived?: boolean; title?: string }) => { const key = `${owner.type}:${owner.id}`; if (!seen.has(key)) { candidate.owners.push(owner); seen.add(key); candidate.sources.add(owner.type); } };
		const n = norm(candidate.path);
		if (n) {
			for (const owner of guards.pathOwners.get(n) ?? []) add(owner);
			for (const [ownerPath, owners] of guards.pathOwners) {
				if (ownerPath !== n && n.startsWith(`${ownerPath}/`)) for (const owner of owners) add(owner);
			}
		}
		if (n) for (const cwd of guards.cwdOwners) if (cwd.path === n || cwd.path.startsWith(`${n}/`)) add(cwd.owner);
	}

	private classify(candidate: Candidate, guards: GuardIndexes, localBranchExists: boolean): WorktreeInventoryItem {
		const item = this.baseItem(candidate, guards, localBranchExists);
		const liveOwner = candidate.owners.find(o => !o.archived && o.type !== "pool");
		const archivedOwner = candidate.owners.find(o => o.archived || o.type === "archived-session");
		if (candidate.scanError) return { ...item, classification: "scan-error", disposition: "failed", reason: candidate.scanError.reason, detail: candidate.scanError.detail };
		if (!candidate.path) return { ...item, classification: "scan-error", disposition: "failed", reason: "missing-worktree-path", detail: "No worktree path is recorded." };
		if (!candidate.repoPath) return { ...item, classification: "scan-error", disposition: "failed", reason: "missing-repo-path", detail: "No repository path is recorded." };
		if (isContainerInternalWorktreePath(candidate.path)) return { ...item, classification: "protected-in-use", disposition: "protected", reason: "sandbox-container-path", detail: "Container-internal paths are not host cleanup targets." };
		if (candidate.primary || norm(candidate.path) === norm(candidate.repoPath)) return { ...item, classification: "protected-in-use", disposition: "protected", reason: "primary-worktree", detail: "Primary repository worktrees are never cleanup targets." };
		if (this.isArchivedDelegateSharedCandidate(candidate)) return { ...item, classification: "protected-in-use", disposition: "protected", reason: "delegate-shared-worktree", detail: "Archived delegate appears to share its parent worktree." };
		if (liveOwner) return { ...item, classification: "protected-in-use", disposition: "protected", reason: this.ownerReason(liveOwner.type), detail: "A live Bobbit record still references this worktree." };
		if (candidate.sources.has("pool") || isBobbitPoolBranch(candidate.branch)) return { ...item, classification: "pool-entry", disposition: "needs-attention", reason: "safe-pool-entry", detail: "Pool entries are inventoried for troubleshooting and reclaimed by the worktree pool, not selected by maintenance cleanup." };
		if (archivedOwner && candidate.gitWorktreeMetadataExists) return { ...item, classification: "archived-owned", disposition: "ready-to-clean", reason: "safe-archived-session-worktree", detail: item.branchDeleteBlockedReason === "branch-referenced-by-archived-record" ? "Archived-owned worktree is safe to remove; branch deletion is blocked because another archived record still references the branch." : item.branchDeleteBlockedReason ? "Archived-owned worktree is safe to remove; branch deletion is blocked because another live record still references the branch." : "Archived-owned worktree is safe to remove.", actionable: true, selectable: true, defaultSelected: true, willDeleteBranch: !!candidate.branch && !!item.localBranchExists && !item.branchDeleteBlockedReason };
		if (candidate.branch && guards.liveBranches.get(repoKey(candidate.repoPath))?.has(candidate.branch)) return { ...item, classification: "protected-in-use", disposition: "protected", reason: "branch-referenced-by-live-record", detail: "A live Bobbit record still references this branch." };
		if (candidate.gitWorktreeMetadataExists && isBobbitOwnedBranch(candidate.branch)) return { ...item, classification: "unowned-git-worktree", disposition: "ready-to-clean", reason: "safe-unowned-session-worktree", detail: "Unowned Bobbit git worktree is safe to remove.", actionable: true, selectable: true, defaultSelected: true, willDeleteBranch: !!candidate.branch && !!item.localBranchExists && !item.branchDeleteBlockedReason, legacy: isLegacySessionOrphanBranch(candidate.branch) ? { ...item.legacy, orphanedWorktree: true } : item.legacy };
		if (archivedOwner && !candidate.pathExists && !candidate.gitWorktreeMetadataExists) return { ...item, classification: "already-cleaned", disposition: "already-cleaned", reason: "git-worktree-metadata-missing", detail: "Archived-owned worktree is already absent." };
		return { ...item, classification: "stale-filesystem-only", disposition: "needs-attention", reason: "filesystem-only-needs-attention", detail: archivedOwner ? "Recorded path exists but no matching git worktree metadata remains; archived-session cleanup will not remove stale directories." : "Filesystem-only directory under a Bobbit worktree root requires manual attention." };
	}

	private baseItem(candidate: Candidate, guards: GuardIndexes, localBranchExists: boolean): WorktreeInventoryItem {
		const branchDeleteBlockedReason = this.branchDeleteBlockedReason(candidate.branch, candidate.repoPath, guards, candidate.legacyArchived?.key);
		return {
			id: candidate.legacyArchived ? stableId("archived", candidate.legacyArchived.key) : stableId("worktree", candidate.projectId, candidate.repo, candidate.repoPath, candidate.path),
			projectId: candidate.projectId,
			projectName: candidate.projectName,
			componentName: candidate.componentName,
			repo: candidate.repo,
			repoPath: candidate.repoPath,
			worktreeRoot: candidate.worktreeRoot,
			path: candidate.path,
			branch: candidate.branch,
			sources: [...candidate.sources].sort(),
			owners: candidate.owners,
			classification: "stale-filesystem-only",
			disposition: "needs-attention",
			reason: "filesystem-only-needs-attention",
			detail: "Not evaluated.",
			actionable: false,
			selectable: false,
			defaultSelected: false,
			pathExists: candidate.pathExists,
			gitWorktreeMetadataExists: candidate.gitWorktreeMetadataExists,
			localBranchExists,
			willDeleteBranch: false,
			branchDeleteBlockedReason,
			legacy: candidate.legacyArchived ? { archivedSession: { sessionId: candidate.legacyArchived.sessionId, repo: candidate.legacyArchived.repo, source: candidate.legacyArchived.source, selectionCategories: candidate.legacyArchived.selectionCategories, item: candidate.legacyArchived } } : undefined,
		};
	}

	private counts(items: WorktreeInventoryItem[]): WorktreeInventoryReport["counts"] {
		const counts: WorktreeInventoryReport["counts"] = { total: items.length, readyToClean: 0, protectedInUse: 0, archivedOwned: 0, unownedGitWorktrees: 0, poolEntries: 0, alreadyCleaned: 0, needsAttention: 0, scanErrors: 0, defaultSelected: 0, byClassification: {}, byReason: {}, bySource: {} };
		for (const item of items) {
			if (item.disposition === "ready-to-clean") counts.readyToClean++;
			if (item.disposition === "protected") counts.protectedInUse++;
			if (item.classification === "archived-owned") counts.archivedOwned++;
			if (item.classification === "unowned-git-worktree") counts.unownedGitWorktrees++;
			if (item.classification === "pool-entry") counts.poolEntries++;
			if (item.classification === "already-cleaned") counts.alreadyCleaned++;
			if (item.disposition === "needs-attention") counts.needsAttention++;
			if (item.classification === "scan-error") counts.scanErrors++;
			if (item.defaultSelected) counts.defaultSelected++;
			counts.byClassification[item.classification] = (counts.byClassification[item.classification] ?? 0) + 1;
			counts.byReason[item.reason] = (counts.byReason[item.reason] ?? 0) + 1;
			for (const source of item.sources) counts.bySource[source] = (counts.bySource[source] ?? 0) + 1;
		}
		return counts;
	}

	private isArchivedDelegateSharedCandidate(candidate: Candidate): boolean {
		const archived = candidate.legacyArchived;
		return !!archived?.delegateOf && !archived.branch && archived.source === "sessionWorktree";
	}

	private ownerReason(type: WorktreeInventorySource): WorktreeInventoryReason {
		switch (type) {
			case "goal": return "referenced-by-live-goal";
			case "team": return "referenced-by-live-team";
			case "delegate": return "referenced-by-delegate";
			case "staff": return "referenced-by-staff";
			case "pool": return "referenced-by-pool";
			default: return "referenced-by-live-session";
		}
	}

	private branchDeleteBlockedReason(branch: string | undefined, repoPath: string | undefined, guards: GuardIndexes, ownArchivedKey?: string): WorktreeInventoryItem["branchDeleteBlockedReason"] | undefined {
		if (!branch || !repoPath) return undefined;
		const rk = repoKey(repoPath);
		if (guards.liveBranches.get(rk)?.has(branch)) return "branch-referenced-by-live-record";
		const archivedKeys = guards.archivedBranches.get(rk)?.get(branch);
		if (archivedKeys && [...archivedKeys].some(key => key !== ownArchivedKey)) return "branch-referenced-by-archived-record";
		return undefined;
	}

	private async worktreeRemoved(item: WorktreeInventoryItem): Promise<boolean> {
		const pathExists = await this.exists(item.path);
		let metadata = false;
		try {
			const stdout = await this.execGit(item.repoPath, ["worktree", "list", "--porcelain"], { timeoutMs: 10_000 });
			metadata = parseGitWorktreeList(stdout).some(wt => norm(wt.path) === norm(item.path) && (!item.branch || wt.branch === item.branch));
		} catch { metadata = false; }
		return !pathExists && !metadata;
	}

	private async deleteBranchIfStillAllowed(item: WorktreeInventoryItem): Promise<boolean> {
		if (!item.willDeleteBranch || !item.branch) return false;
		const commandRunner = this.deps.commandRunner ?? realCommandRunner;
		if (!(await this.localBranchExists(item.repoPath, item.branch))) return false;
		// All potentially deferred reads precede the final guard rebuild. The local
		// mutation starts immediately after the current ownership snapshot passes.
		let guards = await this.buildGuards(1);
		if (!this.branchMutationAllowed(item, guards)) return false;
		try { await commandRunner.execFile("git", ["branch", "-D", item.branch], { cwd: item.repoPath }); } catch { /* verify below */ }
		if (await this.localBranchExists(item.repoPath, item.branch)) return false;
		const skipRemote = await shouldSkipRemotePushForTests(item.repoPath, "origin", commandRunner, this.deps.remotePolicy ?? {});
		if (!skipRemote) {
			// Remote deletion is a separate mutation and therefore owns a separate
			// final revalidation after the remote-policy I/O.
			guards = await this.buildGuards(1);
			if (this.branchMutationAllowed(item, guards)) {
				try { await commandRunner.execFile("git", ["push", "origin", "--delete", item.branch], { cwd: item.repoPath, timeout: 15_000 }); } catch { /* best-effort */ }
			}
		}
		return true;
	}

	private branchMutationAllowed(item: WorktreeInventoryItem, guards: GuardIndexes): boolean {
		if (!item.branch || isContainerInternalWorktreePath(item.path) || norm(item.path) === norm(item.repoPath)) return false;
		if (this.currentPathBlocker(item.path, guards)) return false;
		const ownArchivedKey = item.legacy?.archivedSession?.item.key;
		if (this.branchDeleteBlockedReason(item.branch, item.repoPath, guards, ownArchivedKey)) return false;
		if (item.classification === "archived-owned") {
			const ownReferences = guards.archivedBranches.get(repoKey(item.repoPath))?.get(item.branch);
			if (!ownArchivedKey || !ownReferences?.has(ownArchivedKey)) return false;
		}
		return true;
	}

	private currentPathBlocker(candidatePath: string, guards: GuardIndexes): WorktreeInventoryReason | undefined {
		const candidate = norm(candidatePath);
		if (!candidate) return "missing-worktree-path";
		const owners: Array<{ type: WorktreeInventorySource; archived?: boolean }> = [];
		for (const [ownerPath, pathOwners] of guards.pathOwners) {
			if (ownerPath === candidate || candidate.startsWith(`${ownerPath}/`)) owners.push(...pathOwners);
		}
		for (const cwd of guards.cwdOwners) if (cwd.path === candidate || cwd.path.startsWith(`${candidate}/`)) owners.push(cwd.owner);
		const liveOwner = owners.find(owner => !owner.archived && owner.type !== "pool");
		if (liveOwner) return this.ownerReason(liveOwner.type);
		if (owners.some(owner => owner.type === "pool")) return "referenced-by-pool";
		return undefined;
	}

	private localBranchExists(repoPath: string | undefined, branch: string | undefined): Promise<boolean> {
		if (!repoPath || !branch) return Promise.resolve(false);
		return (this.deps.commandRunner ?? realCommandRunner).execFile("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: repoPath }).then(() => true).catch(() => false);
	}

	private async execGit(repoPath: string, args: readonly string[], opts?: { timeoutMs?: number }): Promise<string> {
		if (this.deps.execGit) return this.deps.execGit(repoPath, args, opts);
		const { stdout } = await (this.deps.commandRunner ?? realCommandRunner).execFile("git", [...args], { cwd: repoPath, timeout: opts?.timeoutMs ?? 10_000 }) as { stdout: string | Buffer };
		return stdout.toString();
	}

	private async exists(p: string | undefined): Promise<boolean> {
		if (!p) return false;
		try {
			await this.fsa.access(p);
			return true;
		} catch {
			return false;
		}
	}
}
