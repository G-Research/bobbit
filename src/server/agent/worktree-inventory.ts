import { execFile as execFileCb } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { ProjectContextManager } from "./project-context-manager.js";
import type { SessionManager, ArchivedSessionWorktreeItem, ArchivedSessionWorktreeScanResponse, CleanupArchivedSessionWorktreesRequest, CleanupArchivedSessionWorktreesResponse } from "./session-manager.js";
import type { PersistedGoal } from "./goal-store.js";
import type { PersistedStaff } from "./staff-store.js";
import type { PersistedTeamEntry } from "./team-store.js";
import type { Component } from "./project-config-store.js";
import { normalizeWorktreeHostPath } from "./worktree-reference-guard.js";
import { branchToSlug, worktreeRoot as resolveWorktreeRoot } from "../skills/worktree-paths.js";
import { cleanupWorktree, shouldSkipRemotePushForTests } from "../skills/git.js";

const execFile = promisify(execFileCb);

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

export interface WorktreeInventoryDeps {
	projectContextManager: ProjectContextManager;
	sessionManager: SessionManager;
	clock?: () => number;
	fs?: Pick<typeof fs, "existsSync" | "readdirSync" | "statSync">;
	execGit?: (repoPath: string, args: readonly string[], opts?: { timeoutMs?: number }) => Promise<string>;
}

interface ParsedGitWorktree { path: string; branch?: string }
interface RepoDescriptor { projectId: string; projectName: string; repo: string; componentName?: string; repoPath: string; worktreeRoot: string; components: Component[]; primary: boolean }
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
	private readonly fsa: Pick<typeof fs, "existsSync" | "readdirSync" | "statSync">;

	constructor(deps: WorktreeInventoryDeps) {
		this.deps = deps;
		this.clock = deps.clock ?? (() => Date.now());
		this.fsa = deps.fs ?? fs;
	}

	async scan(opts?: WorktreeInventoryScanOptions): Promise<WorktreeInventoryReport> {
		const repos = this.discoverRepos();
		const guards = this.buildGuards();
		const candidates = new Map<string, Candidate>();
		const addCandidate = (repo: RepoDescriptor, wtPath: string, source: WorktreeInventorySource, branch?: string, extra?: Partial<Candidate>) => {
			const key = `${repo.projectId}|${repo.repo}|${norm(wtPath) ?? wtPath}`;
			let c = candidates.get(key);
			if (!c) {
				c = { projectId: repo.projectId, projectName: repo.projectName, componentName: repo.componentName, repo: repo.repo, repoPath: repo.repoPath, worktreeRoot: repo.worktreeRoot, path: wtPath, branch, sources: new Set(), owners: [], pathExists: this.exists(wtPath), gitWorktreeMetadataExists: false };
				candidates.set(key, c);
			}
			c.sources.add(source);
			if (branch && !c.branch) c.branch = branch;
			Object.assign(c, extra);
			return c;
		};

		for (const repo of repos) {
			try {
				if (!this.exists(repo.repoPath) || !this.exists(path.join(repo.repoPath, ".git"))) continue;
				const stdout = await this.execGit(repo.repoPath, ["worktree", "list", "--porcelain"], { timeoutMs: 10_000 });
				for (const wt of parseGitWorktreeList(stdout)) {
					const primary = norm(wt.path) === norm(repo.repoPath);
					addCandidate(repo, wt.path, "git-worktree", wt.branch, { gitWorktreeMetadataExists: true, primary });
				}
			} catch (err) {
				const scanPath = path.join(repo.worktreeRoot, `.scan-error-${branchToSlug(repo.repo)}`);
				addCandidate(repo, scanPath, "git-worktree", undefined, { scanError: { reason: "git-scan-error", detail: err instanceof Error ? err.message : String(err) } });
			}
		}

		this.addFilesystemCandidates(repos, addCandidate);
		this.addPoolCandidates(repos, addCandidate);
		await this.addArchivedCandidates(repos, candidates);

		for (const candidate of candidates.values()) this.attachOwners(candidate, guards);
		let items = await Promise.all([...candidates.values()].map(candidate => this.classify(candidate, guards)));
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

		for (const item of selected) {
			if (item.classification === "already-cleaned") {
				record({ itemId: item.id, path: item.path, repoPath: item.repoPath, branch: item.branch, status: "already-cleaned", reason: item.reason, detail: item.detail, worktreeRemoved: false, branchDeleted: false });
				continue;
			}
			if (!item.actionable) {
				response.counts.notActionable++;
				record({ itemId: item.id, path: item.path, repoPath: item.repoPath, branch: item.branch, status: "skipped", reason: item.reason, detail: item.detail, worktreeRemoved: false, branchDeleted: false });
				continue;
			}
			try {
				await cleanupWorktree(item.repoPath, item.path, item.branch, false);
				const removed = await this.worktreeRemoved(item);
				if (!removed) {
					record({ itemId: item.id, path: item.path, repoPath: item.repoPath, branch: item.branch, status: "failed", reason: "git-scan-error", error: "cleanup did not remove worktree path or git metadata", worktreeRemoved: false, branchDeleted: false });
					continue;
				}
				const branchDeleted = await this.deleteBranchIfStillAllowed(item);
				record({ itemId: item.id, path: item.path, repoPath: item.repoPath, branch: item.branch, status: "cleaned", reason: item.reason, worktreeRemoved: true, branchDeleted });
			} catch (err) {
				record({ itemId: item.id, path: item.path, repoPath: item.repoPath, branch: item.branch, status: "failed", reason: "git-scan-error", error: err instanceof Error ? err.message : String(err), worktreeRemoved: false, branchDeleted: false });
			}
		}
		return response;
	}

	async legacyOrphanedWorktrees(): Promise<{ worktrees: Array<{ path: string; branch: string; repoPath: string }> }> {
		const report = await this.scan({ include: "all" });
		return { worktrees: report.items.filter(item => item.legacy?.orphanedWorktree && item.actionable && item.branch).map(item => ({ path: item.path, branch: item.branch!, repoPath: item.repoPath })) };
	}

	async legacyArchivedSessionWorktrees(includeAlreadyCleaned = false): Promise<ArchivedSessionWorktreeScanResponse> {
		return this.deps.sessionManager.listArchivedSessionWorktrees(includeAlreadyCleaned);
	}

	async cleanupLegacyArchivedSessionWorktrees(request: CleanupArchivedSessionWorktreesRequest): Promise<CleanupArchivedSessionWorktreesResponse> {
		return this.deps.sessionManager.cleanupArchivedSessionWorktrees(request);
	}

	private discoverRepos(): RepoDescriptor[] {
		const repos: RepoDescriptor[] = [];
		for (const ctx of this.deps.projectContextManager.visible()) {
			const components = ctx.projectConfigStore.getComponents();
			const worktreeRoot = resolveWorktreeRoot({ rootPath: ctx.project.rootPath, worktreeRoot: ctx.projectConfigStore.get("worktree_root") || undefined });
			const repoNames = new Set<string>();
			if (components.length === 0 || !components.some(c => c.repo !== ".")) repoNames.add(".");
			else for (const component of components) repoNames.add(component.repo);
			for (const repo of repoNames) {
				const repoPath = repo === "." ? ctx.project.rootPath : path.join(ctx.project.rootPath, repo);
				repos.push({ projectId: ctx.project.id, projectName: ctx.project.name, repo, componentName: components.find(c => c.repo === repo)?.name, repoPath, worktreeRoot, components, primary: repo === "." });
			}
		}
		return repos;
	}

	private addFilesystemCandidates(repos: RepoDescriptor[], addCandidate: (repo: RepoDescriptor, wtPath: string, source: WorktreeInventorySource, branch?: string, extra?: Partial<Candidate>) => void): void {
		const reposByRoot = new Map<string, RepoDescriptor[]>();
		for (const repo of repos) {
			const arr = reposByRoot.get(repo.worktreeRoot) ?? [];
			arr.push(repo);
			reposByRoot.set(repo.worktreeRoot, arr);
		}
		for (const [root, group] of reposByRoot) {
			try {
				if (!this.exists(root)) continue;
				for (const dirent of this.fsa.readdirSync(root, { withFileTypes: true })) {
					if (!dirent.isDirectory()) continue;
					const container = path.join(root, dirent.name);
					const multi = group.some(repo => repo.repo !== ".");
					for (const repo of group) {
						const wtPath = multi && repo.repo !== "." ? path.join(container, repo.repo) : container;
						if (multi && !this.exists(wtPath)) continue;
						addCandidate(repo, wtPath, "filesystem");
					}
				}
			} catch (err) {
				const repo = group[0];
				if (repo) addCandidate(repo, path.join(root, ".fs-scan-error"), "filesystem", undefined, { scanError: { reason: "fs-scan-error", detail: err instanceof Error ? err.message : String(err) } });
			}
		}
	}

	private addPoolCandidates(repos: RepoDescriptor[], addCandidate: (repo: RepoDescriptor, wtPath: string, source: WorktreeInventorySource, branch?: string, extra?: Partial<Candidate>) => void): void {
		for (const [projectId, pool] of this.deps.sessionManager.getAllWorktreePools()) {
			const snapshot = pool.snapshotEntries();
			const projectRepos = repos.filter(repo => repo.projectId === projectId);
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
		let archived: ArchivedSessionWorktreeScanResponse;
		try { archived = await this.deps.sessionManager.listArchivedSessionWorktrees(true); } catch { return; }
		for (const item of archived.items) {
			const repo = repos.find(candidate => norm(candidate.repoPath) === norm(item.repoPath) || (candidate.projectId === item.projectId && candidate.repo === item.repo))
				?? { projectId: item.projectId ?? "", projectName: item.projectName ?? "Unknown project", repo: item.repo, repoPath: item.repoPath, worktreeRoot: item.path ? path.dirname(item.path) : undefined, components: [], primary: item.repo === "." } as RepoDescriptor;
			const key = item.path ? `${repo.projectId}|${repo.repo}|${norm(item.path) ?? item.path}` : `archived|${item.key}`;
			let c = candidates.get(key);
			if (!c) {
				c = { projectId: repo.projectId, projectName: repo.projectName, repo: repo.repo, repoPath: item.repoPath, worktreeRoot: repo.worktreeRoot, path: item.path, branch: item.branch, sources: new Set(), owners: [], pathExists: item.pathExists, gitWorktreeMetadataExists: item.gitWorktreeMetadataExists };
				candidates.set(key, c);
			}
			c.sources.add("archived-session");
			c.owners.push({ type: "archived-session", id: item.sessionId, archived: true, title: item.title });
			c.branch = c.branch ?? item.branch;
			c.pathExists = item.pathExists;
			c.gitWorktreeMetadataExists = item.gitWorktreeMetadataExists;
			c.legacyArchived = item;
		}
	}

	private buildGuards(): GuardIndexes {
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
		const addRecord = (record: { id: string; title?: string; repoPath?: string; branch?: string; worktreePath?: string; cwd?: string; repoWorktrees?: Record<string, string>; archived?: boolean }, type: WorktreeInventorySource) => {
			const owner = { type, id: record.id, archived: record.archived, title: record.title };
			addPath(record.worktreePath, owner); addCwd(record.cwd, owner);
			if (record.repoWorktrees) {
				for (const [repo, wt] of Object.entries(record.repoWorktrees)) {
					addPath(wt, owner);
					addBranch(record.repoPath ? (repo === "." ? record.repoPath : path.join(record.repoPath, repo)) : undefined, record.branch, !!record.archived, `${record.id}:${repo}:${norm(wt) ?? ""}`);
				}
			} else addBranch(record.repoPath, record.branch, !!record.archived, `${record.id}:.:${norm(record.worktreePath) ?? ""}`);
		};
		for (const session of this.deps.sessionManager.listSessions()) addRecord(session, session.delegateOf || session.parentSessionId || session.childKind ? "delegate" : "runtime-session");
		for (const ctx of this.deps.projectContextManager.all()) {
			for (const session of ctx.sessionStore.getLive()) addRecord(session, session.delegateOf || session.parentSessionId || session.childKind ? "delegate" : "persisted-live-session");
			for (const session of ctx.sessionStore.getArchived()) addRecord(session, "archived-session");
			for (const goal of ctx.goalStore.getAll() as PersistedGoal[]) addRecord({ ...goal, archived: goal.archived }, "goal");
			for (const team of ctx.teamStore.getAll() as PersistedTeamEntry[]) {
				for (const agent of team.agents) addRecord({ id: agent.sessionId, repoPath: ctx.project.rootPath, branch: agent.branch, worktreePath: agent.worktreePath }, "team");
			}
			for (const staff of ctx.staffStore.getAll() as PersistedStaff[]) addRecord(staff, "staff");
		}
		for (const [projectId, pool] of this.deps.sessionManager.getAllWorktreePools()) {
			for (const entry of pool.snapshotEntries().entries) {
				const owner = { type: "pool" as const, id: `${projectId}:${entry.branchName}` };
				addPath(entry.worktreePath, owner);
				if (entry.worktrees) for (const wt of entry.worktrees) addPath(wt.worktreePath, owner);
				if (entry.worktrees) for (const wt of entry.worktrees) addBranch(wt.repoPath, entry.branchName, false, owner.id);
			}
		}
		return guards;
	}

	private attachOwners(candidate: Candidate, guards: GuardIndexes): void {
		const seen = new Set(candidate.owners.map(o => `${o.type}:${o.id}`));
		const add = (owner: { type: WorktreeInventorySource; id: string; archived?: boolean; title?: string }) => { const key = `${owner.type}:${owner.id}`; if (!seen.has(key)) { candidate.owners.push(owner); seen.add(key); candidate.sources.add(owner.type); } };
		const n = norm(candidate.path);
		if (n) for (const owner of guards.pathOwners.get(n) ?? []) add(owner);
		if (n) for (const cwd of guards.cwdOwners) if (cwd.path === n || cwd.path.startsWith(`${n}/`)) add(cwd.owner);
	}

	private async classify(candidate: Candidate, guards: GuardIndexes): Promise<WorktreeInventoryItem> {
		const item = await this.baseItem(candidate, guards);
		const liveOwner = candidate.owners.find(o => !o.archived && o.type !== "pool");
		const archivedOwner = candidate.owners.find(o => o.archived || o.type === "archived-session");
		if (candidate.scanError) return { ...item, classification: "scan-error", disposition: "failed", reason: candidate.scanError.reason, detail: candidate.scanError.detail };
		if (!candidate.path) return { ...item, classification: "scan-error", disposition: "failed", reason: "missing-worktree-path", detail: "No worktree path is recorded." };
		if (!candidate.repoPath) return { ...item, classification: "scan-error", disposition: "failed", reason: "missing-repo-path", detail: "No repository path is recorded." };
		if (isContainerInternalWorktreePath(candidate.path)) return { ...item, classification: "protected-in-use", disposition: "protected", reason: "sandbox-container-path", detail: "Container-internal paths are not host cleanup targets." };
		if (candidate.primary || norm(candidate.path) === norm(candidate.repoPath)) return { ...item, classification: "protected-in-use", disposition: "protected", reason: "primary-worktree", detail: "Primary repository worktrees are never cleanup targets." };
		if (liveOwner) return { ...item, classification: "protected-in-use", disposition: "protected", reason: this.ownerReason(liveOwner.type), detail: "A live Bobbit record still references this worktree." };
		if (candidate.branch && guards.liveBranches.get(repoKey(candidate.repoPath))?.has(candidate.branch)) return { ...item, classification: "protected-in-use", disposition: "protected", reason: "branch-referenced-by-live-record", detail: "A live Bobbit record still references this branch." };
		if (candidate.sources.has("pool") || isBobbitPoolBranch(candidate.branch)) return { ...item, classification: "pool-entry", disposition: "needs-attention", reason: "safe-pool-entry", detail: "Pool entries are inventoried for troubleshooting and reclaimed by the worktree pool, not selected by maintenance cleanup." };
		if (candidate.legacyArchived) return this.fromLegacyArchived(item, candidate.legacyArchived);
		if (archivedOwner && candidate.gitWorktreeMetadataExists) return { ...item, classification: "archived-owned", disposition: "ready-to-clean", reason: "safe-archived-session-worktree", detail: "Archived-owned worktree is safe to remove.", actionable: true, selectable: true, defaultSelected: true };
		if (candidate.gitWorktreeMetadataExists && isBobbitOwnedBranch(candidate.branch)) return { ...item, classification: "unowned-git-worktree", disposition: "ready-to-clean", reason: "safe-unowned-session-worktree", detail: "Unowned Bobbit git worktree is safe to remove.", actionable: true, selectable: true, defaultSelected: true, legacy: isLegacySessionOrphanBranch(candidate.branch) ? { ...item.legacy, orphanedWorktree: true } : item.legacy };
		if (archivedOwner && !candidate.pathExists && !candidate.gitWorktreeMetadataExists) return { ...item, classification: "already-cleaned", disposition: "already-cleaned", reason: "git-worktree-metadata-missing", detail: "Archived-owned worktree is already absent." };
		return { ...item, classification: "stale-filesystem-only", disposition: "needs-attention", reason: "filesystem-only-needs-attention", detail: "Filesystem-only directory under a Bobbit worktree root requires manual attention." };
	}

	private async baseItem(candidate: Candidate, guards: GuardIndexes): Promise<WorktreeInventoryItem> {
		const branchDeleteBlockedReason = this.branchDeleteBlockedReason(candidate.branch, candidate.repoPath, guards, candidate.legacyArchived?.key);
		const localBranchExists = await this.localBranchExists(candidate.repoPath, candidate.branch);
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
			willDeleteBranch: !!candidate.branch && localBranchExists && !branchDeleteBlockedReason,
			branchDeleteBlockedReason,
			legacy: candidate.legacyArchived ? { archivedSession: { sessionId: candidate.legacyArchived.sessionId, repo: candidate.legacyArchived.repo, source: candidate.legacyArchived.source, selectionCategories: candidate.legacyArchived.selectionCategories, item: candidate.legacyArchived } } : undefined,
		};
	}

	private fromLegacyArchived(base: WorktreeInventoryItem, legacy: ArchivedSessionWorktreeItem): WorktreeInventoryItem {
		const reasonMap: Partial<Record<ArchivedSessionWorktreeItem["reason"], WorktreeInventoryReason>> = {
			"safe-archived-session-worktree": "safe-archived-session-worktree",
			"already-cleaned": "git-worktree-metadata-missing",
			"no-worktree-path": "missing-worktree-path",
			"missing-repo-path": "missing-repo-path",
			"sandbox-container-path": "sandbox-container-path",
			"stale-worktree-directory": "filesystem-only-needs-attention",
			"referenced-by-live-session": "referenced-by-live-session",
			"referenced-by-live-goal": "referenced-by-live-goal",
			"referenced-by-live-team": "referenced-by-live-team",
			"referenced-by-staff": "referenced-by-staff",
			"scan-error": "git-scan-error",
		};
		const classification: WorktreeInventoryClassification = legacy.status === "removable" ? "archived-owned" : legacy.status === "already-cleaned" ? "already-cleaned" : legacy.reason === "stale-worktree-directory" ? "stale-filesystem-only" : legacy.reason === "scan-error" ? "scan-error" : "protected-in-use";
		const disposition = legacy.disposition === "ready-to-clean" ? "ready-to-clean" : legacy.disposition === "already-cleaned" ? "already-cleaned" : legacy.disposition === "failed" ? "failed" : legacy.disposition === "needs-attention" ? "needs-attention" : "protected";
		return { ...base, classification, disposition, reason: reasonMap[legacy.reason] ?? "git-scan-error", detail: legacy.detail, actionable: legacy.actionable, selectable: legacy.selectable, defaultSelected: legacy.defaultSelected, willDeleteBranch: legacy.willDeleteBranch, branchDeleteBlockedReason: legacy.branchDeleteBlockedReason };
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
		const pathExists = this.exists(item.path);
		let metadata = false;
		try {
			const stdout = await this.execGit(item.repoPath, ["worktree", "list", "--porcelain"], { timeoutMs: 10_000 });
			metadata = parseGitWorktreeList(stdout).some(wt => norm(wt.path) === norm(item.path) && (!item.branch || wt.branch === item.branch));
		} catch { metadata = false; }
		return !pathExists && !metadata;
	}

	private async deleteBranchIfStillAllowed(item: WorktreeInventoryItem): Promise<boolean> {
		if (!item.willDeleteBranch || !item.branch) return false;
		const guards = this.buildGuards();
		if (this.branchDeleteBlockedReason(item.branch, item.repoPath, guards, item.legacy?.archivedSession?.item.key)) return false;
		if (!(await this.localBranchExists(item.repoPath, item.branch))) return false;
		try { await execFile("git", ["branch", "-D", item.branch], { cwd: item.repoPath }); } catch { /* verify below */ }
		if (await this.localBranchExists(item.repoPath, item.branch)) return false;
		if (!(await shouldSkipRemotePushForTests(item.repoPath))) {
			try { await execFile("git", ["push", "origin", "--delete", item.branch], { cwd: item.repoPath, timeout: 15_000 }); } catch { /* best-effort */ }
		}
		return true;
	}

	private localBranchExists(repoPath: string | undefined, branch: string | undefined): Promise<boolean> {
		if (!repoPath || !branch) return Promise.resolve(false);
		return execFile("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: repoPath }).then(() => true).catch(() => false);
	}

	private async execGit(repoPath: string, args: readonly string[], opts?: { timeoutMs?: number }): Promise<string> {
		if (this.deps.execGit) return this.deps.execGit(repoPath, args, opts);
		const { stdout } = await execFile("git", [...args], { cwd: repoPath, timeout: opts?.timeoutMs ?? 10_000 }) as { stdout: string };
		return stdout;
	}

	private exists(p: string | undefined): boolean { try { return !!p && this.fsa.existsSync(p); } catch { return false; } }
}
