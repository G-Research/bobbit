/**
 * Git/GitHub subsystem: shell exec primitives, batched git status (+cache),
 * commit/diff helpers, branch publish, remote-branch cleanup, and PR-status
 * (gh CLI) caching + merge-permission checks.
 *
 * Extracted verbatim from src/server/server.ts (STR-04/W4.1 — see the Fable
 * program's finding STR-02, "A self-contained git/gh subsystem ... embedded
 * inside the server.ts entrypoint"): this surface only
 * shells out to `git`/`gh` and depends on node builtins + each other, not on
 * handleApiRoute's closure state, so it lives here as a leaf module that
 * server.ts imports from instead of defining inline.
 *
 * Kept as a sibling of ./git.ts (worktree creation / branch+base-ref
 * resolution) rather than merged into it: this module's own `execGit` has a
 * different signature (shell-string + timeout + containerId) than git.ts's
 * private `execGit` (argv + options), and the two modules cover distinct
 * domains (worktree/branch setup vs. status/diff/PR-caching) — merging them
 * would collide on the name and blur that boundary for no benefit.
 */
import { exec, execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import type { PersistedGoal } from "../agent/goal-store.js";
import { HEADQUARTERS_PROJECT_ID } from "../agent/project-registry.js";
import type { SessionInfo } from "../agent/session-manager.js";
import { shouldSkipRemotePush } from "./git.js";
import { runBatchGitStatusNative } from "./git-status-native.js";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFileCb);

export function isMissingRemoteRefDeleteError(err: unknown): boolean {
	const texts: string[] = [];
	const addText = (value: unknown) => {
		if (typeof value === "string") texts.push(value);
		else if (Buffer.isBuffer(value)) texts.push(value.toString("utf-8"));
	};

	addText(err);
	if (err instanceof Error) addText(err.message);
	if (err && typeof err === "object") {
		const record = err as Record<string, unknown>;
		addText(record.stderr);
		addText(record.message);
	}

	return texts.some(text => /\bremote\s+ref\s+does\s+not\s+exist\b/i.test(text));
}

export function isIgnorableRemoteBranchDeleteError(err: unknown): boolean {
	if (isMissingRemoteRefDeleteError(err)) return true;
	if (!err || typeof err !== "object") return false;
	const record = err as Record<string, unknown>;
	return record.code === "ENOENT"
		&& record.path === "git"
		&& typeof record.syscall === "string"
		&& record.syscall.startsWith("spawn");
}

/**
 * Delete remote branches associated with a goal (integration + agent worktree branches).
 * Fire-and-forget — idempotent cleanup misses are ignored; other errors are logged but never block the archive flow.
 */
export async function deleteRemoteGoalBranches(
	goal: PersistedGoal,
	extraBranches: readonly string[],
	repoPath: string,
): Promise<void> {
	const branches = new Set<string>();
	if (goal.branch) branches.add(goal.branch);
	for (const b of extraBranches) {
		if (b) branches.add(b);
	}
	if (branches.size === 0) return;
	if (shouldSkipRemotePush()) return;

	// Multi-repo: iterate all configured repos and run `git push --delete` in
	// each one in parallel. Single-repo collapses to a single repoPath.
	const goalRepoWorktrees = (goal as { repoWorktrees?: Record<string, string> }).repoWorktrees;
	const repoPaths: string[] = goalRepoWorktrees && Object.keys(goalRepoWorktrees).length > 0
		? Object.keys(goalRepoWorktrees).map(repo => repo === "." ? repoPath : path.join(repoPath, repo))
		: [repoPath];

	await Promise.allSettled(repoPaths.flatMap(rp => Array.from(branches).map(async (branch) => {
		try {
			await execFileAsync("git", ["push", "origin", "--delete", branch], {
				cwd: rp,
				timeout: 15_000,
			});
			console.log(`[api] Deleted remote branch: ${branch} (repo: ${rp})`);
		} catch (err) {
			if (isIgnorableRemoteBranchDeleteError(err)) return;
			console.warn(`[api] Failed to delete remote branch ${branch} in ${rp}:`, err);
		}
	})));
}

const HEADQUARTERS_NO_WORKTREE_GOAL_GIT_MESSAGE = "This Headquarters goal runs in the Headquarters directory without a git worktree. Git branch, merge, and PR actions are unavailable.";
const GENERIC_NO_WORKTREE_GOAL_GIT_MESSAGE = "This goal runs without a git worktree. Git branch, merge, and PR actions are unavailable.";

export function hasGoalGitWorktree<T extends Pick<PersistedGoal, "branch" | "worktreePath">>(goal: T): goal is T & { branch: string; worktreePath: string } {
	return !!goal.branch && !!goal.worktreePath;
}

export function noWorktreeGoalGitMessage(goal: Pick<PersistedGoal, "projectId">): string {
	return goal.projectId === HEADQUARTERS_PROJECT_ID
		? HEADQUARTERS_NO_WORKTREE_GOAL_GIT_MESSAGE
		: GENERIC_NO_WORKTREE_GOAL_GIT_MESSAGE;
}

export function goalGitUnavailablePayload(goal: Pick<PersistedGoal, "id" | "projectId" | "branch" | "worktreePath">, action: string): Record<string, unknown> {
	return {
		error: `${action} is unavailable. ${noWorktreeGoalGitMessage(goal)}`,
		code: "GOAL_GIT_UNAVAILABLE",
		goalId: goal.id,
		projectId: goal.projectId,
		branch: goal.branch ?? null,
		worktreePath: goal.worktreePath ?? null,
	};
}


// ── PR status cache (avoids blocking event loop with gh CLI every poll) ──
export const _prCache = new Map<string, { data: any; ts: number; ttl: number }>();
const PR_NULL_CACHE_TTL_MS = 30_000; // 30 seconds for null (no-PR) results
const _prInFlight = new Map<string, Promise<any | null>>();
const PR_STATUS_FIELDS = "state,url,number,title,mergeable,headRefName,baseRefName,reviewDecision";
const PR_MERGE_PERMISSIONS_QUERY = "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){viewerPermission pullRequest(number:$number){viewerCanMergeAsAdmin}}}";

type GhExecFileForTests = (args: readonly string[], opts: { cwd: string; timeout: number }) => Promise<string>;
let _ghExecFileForTests: GhExecFileForTests | undefined;

export function buildGhPrViewArgs(branch?: string): string[] {
	return branch ? ["pr", "view", branch, "--json", PR_STATUS_FIELDS] : ["pr", "view", "--json", PR_STATUS_FIELDS];
}

export function buildGhPrMergePermissionsArgs(owner: string, name: string, number: number): string[] {
	return [
		"api", "graphql",
		"-f", `query=${PR_MERGE_PERMISSIONS_QUERY}`,
		"-F", `owner=${owner}`,
		"-F", `name=${name}`,
		"-F", `number=${number}`,
	];
}

export function buildGhBranchRulesArgs(owner: string, name: string, branch: string): string[] {
	return ["api", `repos/${owner}/${name}/rules/branches/${encodeURIComponent(branch)}`];
}

export function buildGhRulesetArgs(owner: string, name: string, rulesetId: number): string[] {
	return ["api", `repos/${owner}/${name}/rulesets/${rulesetId}`];
}

export function buildGhPrMergeArgs(branch: string | undefined, method: string, admin: unknown): string[] {
	return ["pr", "merge", ...(branch ? [branch] : []), `--${method}`, ...(admin ? ["--admin"] : [])];
}

async function execGh(args: readonly string[], cwd: string, timeout = 10_000): Promise<string> {
	if (_ghExecFileForTests) return _ghExecFileForTests(args, { cwd, timeout });
	const { stdout } = await execFileAsync("gh", [...args], { cwd, encoding: "utf-8", timeout });
	return String(stdout);
}

export function __setGhExecFileForPrStatusTests(fn: GhExecFileForTests | undefined): void {
	_ghExecFileForTests = fn;
	__resetPrStatusCachesForTests();
}

export function __resetPrStatusCachesForTests(): void {
	_prCache.clear();
	_prInFlight.clear();
	_repoPermCache.clear();
}

// Cache viewer permission per repo (rarely changes, long TTL)
const _repoPermCache = new Map<string, { perm: string; ts: number }>();
const REPO_PERM_CACHE_TTL_MS = 300_000; // 5 minutes

async function getViewerIsAdmin(cwd: string): Promise<boolean> {
	const cached = _repoPermCache.get(cwd);
	if (cached && Date.now() - cached.ts < REPO_PERM_CACHE_TTL_MS) return cached.perm === "ADMIN";
	try {
		const stdout = await execGh(["repo", "view", "--json", "viewerPermission"], cwd);
		const perm = JSON.parse(stdout).viewerPermission ?? "";
		_repoPermCache.set(cwd, { perm, ts: Date.now() });
		return perm === "ADMIN";
	} catch {
		_repoPermCache.set(cwd, { perm: "", ts: Date.now() });
		return false;
	}
}

function parseGithubPrRepo(url: unknown): { owner: string; name: string } | null {
	if (typeof url !== "string" || !url) return null;
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "https:" || parsed.hostname !== "github.com") return null;
		const [owner, name, pull, number] = parsed.pathname.split("/").filter(Boolean);
		if (!owner || !name || pull !== "pull" || !number || !/^\d+$/.test(number)) return null;
		return { owner, name };
	} catch {
		return null;
	}
}

async function getViewerMergePermissions(
	cwd: string,
	pr: { url?: string; number?: number; baseRefName?: string },
): Promise<{ viewerIsAdmin: boolean; viewerCanMergeAsAdmin: boolean }> {
	const repo = parseGithubPrRepo(pr.url);
	if (repo && typeof pr.number === "number") {
		try {
			const stdout = await execGh(buildGhPrMergePermissionsArgs(repo.owner, repo.name, pr.number), cwd);
			const parsed = JSON.parse(stdout);
			const repository = parsed?.data?.repository;
			const perm = repository?.viewerPermission ?? "";
			_repoPermCache.set(cwd, { perm, ts: Date.now() });

			let viewerCanMergeAsAdmin = repository?.pullRequest?.viewerCanMergeAsAdmin === true;
			if (!viewerCanMergeAsAdmin && typeof pr.baseRefName === "string" && pr.baseRefName) {
				viewerCanMergeAsAdmin = await getViewerCanBypassBranchRules(cwd, repo, pr.baseRefName);
			}

			return { viewerIsAdmin: perm === "ADMIN", viewerCanMergeAsAdmin };
		} catch {
			// Fall through to legacy permission probe.
		}
	}
	return { viewerIsAdmin: await getViewerIsAdmin(cwd), viewerCanMergeAsAdmin: false };
}

async function getViewerCanBypassBranchRules(
	cwd: string,
	repo: { owner: string; name: string },
	branch: string,
): Promise<boolean> {
	try {
		const stdout = await execGh(buildGhBranchRulesArgs(repo.owner, repo.name, branch), cwd);
		const rules = JSON.parse(stdout);
		if (!Array.isArray(rules)) return false;

		if (rules.some((rule) => isBypassMode(rule?.current_user_can_bypass))) return true;

		const rulesetIds = [
			...new Set(rules.map((rule) => rule?.ruleset_id).filter((id): id is number => typeof id === "number")),
		];

		for (const rulesetId of rulesetIds) {
			try {
				const detail = JSON.parse(await execGh(buildGhRulesetArgs(repo.owner, repo.name, rulesetId), cwd));
				if (isBypassMode(detail?.current_user_can_bypass)) return true;
			} catch {
				// Continue checking other matching rulesets.
			}
		}
		return false;
	} catch {
		return false;
	}
}

function isBypassMode(mode: unknown): boolean {
	return mode === "always" || mode === "pull_requests_only";
}

async function _fetchPrStatus(cwd: string, branch?: string, fallbackCwd?: string): Promise<any | null> {
	const cacheKey = branch ? `${cwd}::${branch}` : cwd;
	const args = buildGhPrViewArgs(branch);

	// Try cwd first, then fallback (e.g. main repo when worktree git link is broken)
	const cwdsToTry = [cwd, ...(fallbackCwd && fallbackCwd !== cwd ? [fallbackCwd] : [])];
	for (const dir of cwdsToTry) {
		try {
			const stdout = await execGh(args, dir);
			const pr = JSON.parse(stdout);
			const { viewerIsAdmin, viewerCanMergeAsAdmin } = await getViewerMergePermissions(dir, pr);
			const data = {
				number: pr.number,
				url: pr.url,
				title: pr.title,
				state: pr.state,
				mergeable: pr.mergeable,
				headRefName: pr.headRefName,
				baseRefName: pr.baseRefName,
				reviewDecision: pr.reviewDecision || null,
				viewerIsAdmin,
				viewerCanMergeAsAdmin,
			};
			const ttl = pr.state === "OPEN" ? 10_000 : 900_000; // OPEN: 10s, CLOSED/MERGED: 15min
			_prCache.set(cacheKey, { data, ts: Date.now(), ttl });
			return data;
		} catch {
			// Try next cwd
		}
	}
	_prCache.set(cacheKey, { data: null, ts: Date.now(), ttl: PR_NULL_CACHE_TTL_MS });
	return null;
}

export async function __getCachedPrStatusForTests(cwd: string, branch?: string, fallbackCwd?: string): Promise<any | null> {
	return getCachedPrStatus(cwd, branch, fallbackCwd);
}

export async function getCachedPrStatus(cwd: string, branch?: string, fallbackCwd?: string): Promise<any | null> {
	const cacheKey = branch ? `${cwd}::${branch}` : cwd;
	const cached = _prCache.get(cacheKey);
	if (cached && Date.now() - cached.ts < cached.ttl) return cached.data;

	const existing = _prInFlight.get(cacheKey);
	if (existing) return existing;

	const p = _fetchPrStatus(cwd, branch, fallbackCwd);
	_prInFlight.set(cacheKey, p);
	try { return await p; } finally { _prInFlight.delete(cacheKey); }
}

// ── Async git helpers (avoid blocking event loop) ──
export async function execGit(cmd: string, cwd: string, timeout = 5000, containerId?: string): Promise<string> {
	if (containerId) {
		// Run inside Docker container
		const { stdout } = await execFileAsync("docker", [
			"exec", "-w", cwd, containerId, "/bin/sh", "-c", cmd,
		], { encoding: "utf-8", timeout, env: { ...process.env, MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" } });
		return stdout.trim();
	}
	const { stdout } = await execAsync(cmd, { cwd, encoding: "utf-8", timeout });
	return stdout.trim();
}
export async function execGitSafe(cmd: string, cwd: string, fallback = "", containerId?: string): Promise<string> {
	try { return await execGit(cmd, cwd, 5000, containerId); } catch { return fallback; }
}

async function execGitArgs(args: string[], cwd: string, timeout = 5000, containerId?: string): Promise<string> {
	if (containerId) {
		const { stdout } = await execFileAsync("docker", [
			"exec", "-w", cwd, containerId, "git", ...args,
		], { encoding: "utf-8", timeout, env: { ...process.env, MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" } });
		return stdout.trim();
	}
	const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf-8", timeout });
	return stdout.trim();
}
// Argument-vector variant of execGitSafe: never passes user input through a shell.
async function execGitArgsSafe(args: string[], cwd: string, fallback = "", containerId?: string): Promise<string> {
	try { return await execGitArgs(args, cwd, 5000, containerId); } catch { return fallback; }
}

function branchPublishGitArgs(branch: string): {
	push: string[];
	fetchRemoteTracking: string[];
	setUpstream: string[];
} {
	if (!branch) throw new Error("Cannot push: no current branch");
	return {
		push: ["push", "origin", `HEAD:refs/heads/${branch}`],
		fetchRemoteTracking: ["fetch", "origin", `refs/heads/${branch}:refs/remotes/origin/${branch}`],
		setUpstream: ["branch", `--set-upstream-to=origin/${branch}`, branch],
	};
}

let _publishCurrentBranchToOriginFake: ((cwd: string, branch: string, opts: { containerId?: string; setUpstream?: boolean }) => Promise<string> | string) | undefined;
export function __setPublishCurrentBranchToOriginFake(fn: typeof _publishCurrentBranchToOriginFake): void { _publishCurrentBranchToOriginFake = fn; }
export function __clearPublishCurrentBranchToOriginFake(): void { _publishCurrentBranchToOriginFake = undefined; }

export async function publishCurrentBranchToOrigin(
	cwd: string,
	branch: string,
	opts: { containerId?: string; setUpstream?: boolean } = {},
): Promise<string> {
	if (_publishCurrentBranchToOriginFake) return _publishCurrentBranchToOriginFake(cwd, branch, opts);
	const args = branchPublishGitArgs(branch);
	const output = await execGitArgs(args.push, cwd, 30_000, opts.containerId);
	if (opts.setUpstream) {
		try {
			await execGitArgs(args.fetchRemoteTracking, cwd, 15_000, opts.containerId);
			await execGitArgs(args.setUpstream, cwd, 10_000, opts.containerId);
		} catch {
			// Publishing succeeded; upstream repair is best-effort for compatibility.
		}
	}
	return output;
}

/** Git status result shape (+ optional partial/untrackedIncluded flags). */
export type GitStatusRemotePublication = "local-only-policy";

export interface GitStatusResult {
	branch: string; primaryBranch: string; isOnPrimary: boolean;
	/**
	 * Actual ref used for `aheadOfPrimary`/`behindPrimary` calculations.
	 * Equals `origin/<primaryBranch>` when the remote ref exists, else the
	 * bare local branch name `<primaryBranch>`. Surfaced separately from
	 * `primaryBranch` so the UI can render the truthful target (a configured
	 * `base_ref` of `MyUpstream` is a LOCAL branch — "Merged into
	 * origin/MyUpstream" is misleading when origin has no such ref).
	 */
	primaryRef: string;
	status: { file: string; status: string }[];
	hasUpstream: boolean; ahead: number; behind: number;
	aheadOfPrimary: number; behindPrimary: number; mergedIntoPrimary: boolean;
	insertionsVsPrimary: number; deletionsVsPrimary: number;
	clean: boolean; summary: string; unpushed: boolean;
	/** true if porcelain (Phase B) was skipped or timed-out */
	partial?: boolean;
	/** true only when ?untracked=1 was passed (-uall); false on default -uno */
	untrackedIncluded?: boolean;
	/** Set when status intentionally suppresses default publication by policy. */
	remotePublication?: GitStatusRemotePublication;
}

type GitStatusPublicationPolicy = "legacy-auto-publish" | "local-only-policy";
type WorktreePushPolicy = "local-only" | "publish";
type SessionGitPublicationMetadata = Partial<Pick<SessionInfo, "teamGoalId" | "teamLeadSessionId" | "role" | "branch">> & {
	worktreePushPolicy?: WorktreePushPolicy;
	remotePublicationPolicy?: WorktreePushPolicy;
};

function normalizeWorktreePushPolicy(value: unknown): WorktreePushPolicy | undefined {
	return value === "local-only" || value === "publish" ? value : undefined;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readSessionGitPublicationMetadata(sessionManager: unknown, sessionId: string, liveSession: unknown): SessionGitPublicationMetadata {
	const live = liveSession as SessionGitPublicationMetadata | undefined;
	const persisted = (sessionManager as { getPersistedSession?: (id: string) => unknown })
		.getPersistedSession?.(sessionId) as SessionGitPublicationMetadata | undefined;
	return {
		teamGoalId: live?.teamGoalId ?? persisted?.teamGoalId,
		teamLeadSessionId: live?.teamLeadSessionId ?? persisted?.teamLeadSessionId,
		role: live?.role ?? persisted?.role,
		branch: live?.branch ?? persisted?.branch,
		worktreePushPolicy: normalizeWorktreePushPolicy(live?.worktreePushPolicy) ?? normalizeWorktreePushPolicy(persisted?.worktreePushPolicy),
		remotePublicationPolicy: normalizeWorktreePushPolicy(live?.remotePublicationPolicy) ?? normalizeWorktreePushPolicy(persisted?.remotePublicationPolicy),
	};
}

function explicitWorktreePushPolicy(session: SessionGitPublicationMetadata): WorktreePushPolicy | undefined {
	return normalizeWorktreePushPolicy(session.worktreePushPolicy) ?? normalizeWorktreePushPolicy(session.remotePublicationPolicy);
}

function isLegacyScopedTeamMemberSession(session: SessionGitPublicationMetadata, branch: string | undefined): boolean {
	if (!session.teamGoalId || !session.teamLeadSessionId || !session.role || !branch) return false;
	if (session.role === "team-lead") return false;
	const goalId8 = session.teamGoalId.slice(0, 8);
	if (!/^[0-9a-f]{8}$/i.test(goalId8)) return false;
	const rolePattern = escapeRegExp(session.role);
	const branchPattern = new RegExp(`^goal/${escapeRegExp(goalId8)}/${rolePattern}-[0-9a-f]{4}$`, "i");
	return branchPattern.test(branch);
}

function resolveSessionGitStatusPublicationPolicy(
	session: SessionGitPublicationMetadata,
	branch: string | undefined,
): GitStatusPublicationPolicy {
	const explicitPolicy = explicitWorktreePushPolicy(session);
	if (explicitPolicy === "local-only") return "local-only-policy";
	if (explicitPolicy === "publish") return "legacy-auto-publish";
	return isLegacyScopedTeamMemberSession(session, branch) ? "local-only-policy" : "legacy-auto-publish";
}

export function sessionGitStatusRemotePublication(
	sessionManager: unknown,
	sessionId: string,
	liveSession: unknown,
	branch: string | undefined,
): GitStatusRemotePublication | undefined {
	const metadata = readSessionGitPublicationMetadata(sessionManager, sessionId, liveSession);
	return resolveSessionGitStatusPublicationPolicy(metadata, branch) === "local-only-policy"
		? "local-only-policy"
		: undefined;
}

export function sessionGitStatusAutoPublishDecision(
	result: Pick<GitStatusResult, "isOnPrimary" | "ahead" | "hasUpstream" | "branch"> | null | undefined,
	remotePublication?: GitStatusRemotePublication,
): { branch: string; setUpstream?: boolean } | undefined {
	if (!result || remotePublication) return undefined;
	if (!result.isOnPrimary && result.ahead > 0 && result.hasUpstream && result.branch) {
		return { branch: result.branch };
	}
	if (!result.isOnPrimary && !result.hasUpstream && result.branch && /^session\//.test(result.branch)) {
		return { branch: result.branch, setUpstream: true };
	}
	return undefined;
}

export function __resolveSessionGitStatusPublicationPolicyForTests(
	session: SessionGitPublicationMetadata,
	branch: string | undefined,
): GitStatusPublicationPolicy {
	return resolveSessionGitStatusPublicationPolicy(session, branch);
}

export function __resolveSessionGitStatusPublicationForTests(
	session: SessionGitPublicationMetadata,
	result: GitStatusResult,
): { policy: GitStatusPublicationPolicy; result: GitStatusResult; autoPublish: boolean } {
	const policy = resolveSessionGitStatusPublicationPolicy(session, result.branch);
	const remotePublication = policy === "local-only-policy" ? "local-only-policy" : undefined;
	return {
		policy,
		result: remotePublication ? { ...result, remotePublication } : result,
		autoPublish: !!sessionGitStatusAutoPublishDecision(result, remotePublication),
	};
}

// ── Git status cache + single-flight ──
// Short TTL (2000ms) to coalesce the storm of event-driven refreshes (reconnect,
// agent-idle, session-switch, goal-dashboard fan-out across N sessions sharing
// a cwd) into one underlying git invocation. Native parallel execFile typically
// returns in 50-150 ms on Windows / 10-30 ms on Linux, so 2 s of staleness is
// imperceptible to the widget (which polls every 10 s) and high-value for
// coalescing. Errors are NOT cached (so a transient failure doesn't stick).
// Key includes the untracked flag so dropdown (full) and pill-strip (summary)
// responses never cross-contaminate each other.
const GIT_STATUS_TTL_MS = 2000;
interface GitStatusCacheEntry {
	promise: Promise<GitStatusResult | null>;
	resolvedAt: number; // 0 while in flight
	result: GitStatusResult | null | undefined; // undefined while in flight
}
const gitStatusCache = new Map<string, GitStatusCacheEntry>();

/** Test-only invocation counter (underlying git script runs). */
let _runBatchGitStatusCount = 0;
export function __getGitStatusInvocationCount(): number { return _runBatchGitStatusCount; }
export function __resetGitStatusInvocationCount(): void { _runBatchGitStatusCount = 0; }

/** Test-only hook: if set, replaces the real `runBatchGitStatus` git-spawn
 *  path with a fake. Used by `tests/e2e/git-status-caching.spec.ts` to
 *  exercise the TTL/single-flight/coalesce logic deterministically without
 *  spawning Git Bash under CI load (which fails unpredictably). Production
 *  code never sets this. */
let _gitStatusFake: ((cwd: string, containerId?: string, opts?: { untracked?: boolean; configuredBaseRef?: string }) => Promise<GitStatusResult | null>) | undefined;
export function __setGitStatusFake(fn: typeof _gitStatusFake): void { _gitStatusFake = fn; }
export function __clearGitStatusFake(): void { _gitStatusFake = undefined; }

function gitStatusCacheKey(cwd: string, containerId?: string, untracked?: boolean): string {
	return `${containerId ?? 'host'}::${cwd}::${untracked ? 'u' : 's'}`;
}

/** Invalidate both summary and untracked cache entries for a cwd (optionally
 *  scoped to a container). Call after any local git mutation (commit, pull,
 *  push, rebase, merge). */
export function invalidateGitStatusCache(cwd: string, containerId?: string): void {
	gitStatusCache.delete(gitStatusCacheKey(cwd, containerId, true));
	gitStatusCache.delete(gitStatusCacheKey(cwd, containerId, false));
}

/** Test-only: mark all cache entries for a cwd as TTL-expired without
 *  sleeping. Used by `tests/e2e/git-status-caching.spec.ts` to deterministically
 *  exercise the TTL re-run path without inflating wall-clock time. Sets
 *  `resolvedAt` to a timestamp older than `GIT_STATUS_TTL_MS` so the next
 *  call falls through to a fresh invocation. */
export function __forceGitStatusCacheExpiry(cwd: string, containerId?: string): void {
	const staleAt = Date.now() - GIT_STATUS_TTL_MS - 1000;
	for (const untracked of [true, false]) {
		const entry = gitStatusCache.get(gitStatusCacheKey(cwd, containerId, untracked));
		if (entry && entry.result !== undefined) entry.resolvedAt = staleAt;
	}
}

function evictExpired(now: number): void {
	if (gitStatusCache.size <= 200) return;
	for (const [k, v] of gitStatusCache) {
		if (v.resolvedAt !== 0 && now - v.resolvedAt > 5000) gitStatusCache.delete(k);
	}
}

/** Cached wrapper over runBatchGitStatus with TTL + single-flight.
 *
 * `opts.configuredBaseRef` (when set) drives the `primaryBranch` used for
 * `aheadOfPrimary`/`behindPrimary` counters — see
 * `docs/design/base-ref.md` §5. It's not part of the cache key: each
 * (cwd, containerId) is a project-scoped worktree so `base_ref` is constant
 * for the lifetime of an entry, and the 2 s TTL absorbs the corner case of a
 * mid-flight setting change. */
export async function batchGitStatus(
	cwd: string,
	containerId?: string,
	opts?: { untracked?: boolean; configuredBaseRef?: string },
): Promise<GitStatusResult | null> {
	const key = gitStatusCacheKey(cwd, containerId, opts?.untracked);
	const now = Date.now();
	evictExpired(now);
	const existing = gitStatusCache.get(key);
	if (existing) {
		if (existing.result === undefined) return existing.promise; // in flight
		if (now - existing.resolvedAt < GIT_STATUS_TTL_MS) return existing.result; // fresh
		// stale — fall through and re-run
	}

	const promise = runBatchGitStatus(cwd, containerId, opts).then(
		(result) => {
			const entry = gitStatusCache.get(key);
			if (entry && entry.promise === promise) {
				entry.result = result;
				entry.resolvedAt = Date.now();
			}
			return result;
		},
		(err) => {
			// Do NOT cache errors — next caller will retry fresh.
			const entry = gitStatusCache.get(key);
			if (entry && entry.promise === promise) gitStatusCache.delete(key);
			throw err;
		},
	);
	gitStatusCache.set(key, { promise, resolvedAt: 0, result: undefined });
	return promise;
}

/** Batched git status — host path uses native parallel execFile (no shell);
 *  container path keeps the legacy `docker exec sh -c <batch>` round-trip.
 *  Implementation lives in `./skills/git-status-native.ts`. Returns null if
 *  not a git repository. `partial` is reserved for a future degraded-mode
 *  flag and is currently always `false` on success. */
async function runBatchGitStatus(
	cwd: string,
	containerId?: string,
	opts?: { untracked?: boolean; configuredBaseRef?: string },
): Promise<GitStatusResult | null> {
	_runBatchGitStatusCount++;
	if (_gitStatusFake) return _gitStatusFake(cwd, containerId, opts);
	return runBatchGitStatusNative(cwd, { ...opts, containerId });
}

// ── Git diff / commit helpers (shared between session and goal endpoints) ──
const DIFF_MAX_BYTES = 500 * 1024; // 500KB
export const COMMIT_LOG_FORMAT = "%H%x1f%h%x1f%s%x1f%an%x1f%aI";
const COMMIT_LOG_SEPARATOR = "\x1f";

type CommitChangedFile = {
	path: string;
	oldPath?: string;
	status: string;
	statusLabel: string;
};

type CommitInfo = {
	sha: string;
	shortSha: string;
	message: string;
	author: string;
	timestamp: string;
	filesChanged: number;
	insertions: number;
	deletions: number;
	files: CommitChangedFile[];
};

function isUnsafeGitPath(file: string): boolean {
	return !file
		|| file.includes("..")
		|| path.posix.isAbsolute(file)
		|| path.win32.isAbsolute(file)
		|| /^[a-zA-Z]:/.test(file);
}

function isValidCommitSha(commit: string): boolean {
	return /^[0-9a-fA-F]{4,40}$/.test(commit);
}

function statusLabelForCommitFile(status: string): string {
	switch (status) {
		case "M": return "modified";
		case "A": return "added";
		case "D": return "deleted";
		case "R": return "renamed";
		default: return status ? status.toLowerCase() : "unknown";
	}
}

function parseCommitChangedFiles(output: string): CommitChangedFile[] {
	return output.split("\n").map(line => line.trim()).filter(Boolean).flatMap((line): CommitChangedFile[] => {
		const parts = line.split("\t");
		const rawStatus = parts[0] || "";
		const status = rawStatus.startsWith("R") ? "R" : rawStatus;
		if (status === "R") {
			const oldPath = parts[1];
			const newPath = parts[2];
			if (!oldPath || !newPath) return [];
			return [{ path: newPath, oldPath, status, statusLabel: statusLabelForCommitFile(status) }];
		}
		const filePath = parts[1];
		if (!filePath) return [];
		return [{ path: filePath, status, statusLabel: statusLabelForCommitFile(status) }];
	});
}

async function assertCommitExists(cwd: string, commit: string, containerId?: string): Promise<void> {
	if (!isValidCommitSha(commit)) throw new Error("INVALID_COMMIT");
	try {
		await execGitArgs(["cat-file", "-e", `${commit}^{commit}`], cwd, 5000, containerId);
	} catch {
		throw new Error("INVALID_COMMIT");
	}
}

async function getCommitChangedFiles(cwd: string, sha: string, containerId?: string): Promise<CommitChangedFile[]> {
	await assertCommitExists(cwd, sha, containerId);
	const out = await execGitArgs(["show", "--format=", "--name-status", "--find-renames", sha], cwd, 10000, containerId);
	return parseCommitChangedFiles(out);
}

export function parseCommitLogWithShortstat(output: string): CommitInfo[] {
	const lines = output.split("\n");
	const commits: CommitInfo[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line.includes(COMMIT_LOG_SEPARATOR)) continue;
		const parts = line.split(COMMIT_LOG_SEPARATOR);
		if (parts.length < 5) continue;
		const [sha, shortSha, message, author, timestamp] = parts;
		let filesChanged = 0, insertions = 0, deletions = 0;
		for (let j = i + 1; j < lines.length && !lines[j].includes(COMMIT_LOG_SEPARATOR); j++) {
			const statLine = lines[j].trim();
			if (!statLine.includes("changed")) continue;
			const fm = statLine.match(/(\d+) file/);
			const im = statLine.match(/(\d+) insertion/);
			const dm = statLine.match(/(\d+) deletion/);
			if (fm) filesChanged = parseInt(fm[1], 10);
			if (im) insertions = parseInt(im[1], 10);
			if (dm) deletions = parseInt(dm[1], 10);
			break;
		}
		commits.push({ sha, shortSha, message, author, timestamp, filesChanged, insertions, deletions, files: [] });
	}
	return commits;
}

export async function attachCommitFiles(commits: CommitInfo[], cwd: string, containerId?: string): Promise<CommitInfo[]> {
	return Promise.all(commits.map(async commit => ({
		...commit,
		files: await getCommitChangedFiles(cwd, commit.sha, containerId),
	})));
}

export async function getGitDiff(cwd: string, file?: string, containerId?: string, commit?: string): Promise<string> {
	const opts = { cwd, encoding: "utf-8" as const, timeout: 5000 };
	let hasHead = true;
	try { await execGit("git rev-parse --verify HEAD", cwd, 5000, containerId); } catch { hasHead = false; }

	let diff = "";
	if (commit) {
		if (!file || isUnsafeGitPath(file)) throw new Error("INVALID_PATH");
		await assertCommitExists(cwd, commit, containerId);
		const changedFiles = await getCommitChangedFiles(cwd, commit, containerId);
		const renamedFile = changedFiles.find(f => f.status === "R" && (f.path === file || f.oldPath === file));
		const pathspecs = renamedFile?.oldPath ? [renamedFile.oldPath, renamedFile.path] : [file];
		diff = await execGitArgs(["show", "--format=", "--find-renames", commit, "--", ...pathspecs], cwd, 10000, containerId);
	} else if (file) {
		// Sanitize: reject path traversal, absolute paths, drive letters
		if (isUnsafeGitPath(file)) {
			throw new Error("INVALID_PATH");
		}
		if (containerId) {
			// Run git diff inside container
			// Argument-vector execution — `file` is never parsed by a shell.
			if (hasHead) {
				diff = await execGitArgsSafe(["diff", "HEAD", "--", file], cwd, "", containerId);
			} else {
				diff = await execGitArgsSafe(["diff", "--cached", "--", file], cwd, "", containerId)
					+ await execGitArgsSafe(["diff", "--", file], cwd, "", containerId);
			}
			if (!diff.trim()) {
				diff = await execGitArgsSafe(["diff", "--no-index", "/dev/null", "--", file], cwd, "", containerId);
			}
		} else if (hasHead) {
			const { stdout } = await execFileAsync("git", ["diff", "HEAD", "--", file], opts);
			diff = stdout;
		} else {
			const { stdout: s1 } = await execFileAsync("git", ["diff", "--cached", "--", file], opts);
			const { stdout: s2 } = await execFileAsync("git", ["diff", "--", file], opts);
			diff = s1 + s2;
		}
		// Try untracked if empty (host path only — container path handled above)
		if (!diff.trim() && !containerId) {
			try {
				const devNull = process.platform === "win32" ? "NUL" : "/dev/null";
				const { stdout } = await execFileAsync("git", ["diff", "--no-index", devNull, "--", file], opts);
				diff = stdout;
			} catch (e: any) {
				// git diff --no-index exits 1 when there are differences
				if (e.stdout) diff = e.stdout;
			}
		}
	} else {
		if (containerId) {
			if (hasHead) {
				diff = await execGitSafe("git diff HEAD", cwd, "", containerId);
			} else {
				diff = await execGitSafe("git diff --cached", cwd, "", containerId)
					+ await execGitSafe("git diff", cwd, "", containerId);
			}
		} else if (hasHead) {
			const { stdout } = await execFileAsync("git", ["diff", "HEAD"], opts);
			diff = stdout;
		} else {
			const { stdout: s1 } = await execFileAsync("git", ["diff", "--cached"], opts);
			const { stdout: s2 } = await execFileAsync("git", ["diff"], opts);
			diff = s1 + s2;
		}
	}

	if (!diff.trim()) throw new Error("NO_DIFF");

	if (Buffer.byteLength(diff, "utf-8") > DIFF_MAX_BYTES) {
		diff = diff.slice(0, DIFF_MAX_BYTES) + "\n\n--- Diff truncated (exceeded 500KB) ---";
	}
	return diff;
}
