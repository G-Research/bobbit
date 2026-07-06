// src/server/routes/goal-git-team-read-routes.ts
//
// STR-01 goals cohort G4a: goal git/PR/team read routes migrated out of
// handleApiRoute's legacy if/else chain into the core route registry.
// See docs/design/route-registry.md.
//
// Mechanical extraction — handler bodies below preserve the legacy behavior,
// with only handleApiRoute locals destructured from ctx and registry params
// replacing regex captures.
//
// LEGACY FALL-THROUGH PARITY: no unhandled-method shim needed. Every legacy
// block here gated on path and method in the same `if` condition. A method
// mismatch skipped the block and fell through to the terminal 404; RouteTable's
// method-scoped matching preserves that by leaving other methods unregistered.

import { execFile as execFileCb } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";
import { stripTokenFromGitUrl } from "../skills/git.js";
import {
	_prCache,
	attachCommitFiles,
	batchGitStatus,
	COMMIT_LOG_FORMAT,
	execGit,
	getCachedPrStatus,
	getGitDiff,
	goalGitUnavailablePayload,
	hasGoalGitWorktree,
	invalidateGitStatusCache,
	noWorktreeGoalGitMessage,
	parseCommitLogWithShortstat,
} from "../skills/git-gh.js";
import { buildGithubBranchUrl, type GoalGithubLinkResponse } from "../sidebar-actions.js";
import type { CoreRouteCtx } from "./core-route-ctx.js";
import type { RouteTable } from "./route-table.js";

const execFileAsync = promisify(execFileCb);

// GET /api/goals/:id/commits — get commit history for goal branch
async function handleGoalCommits(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { getGoalAcrossProjects, json, url } = ctx;
	const goalId = params.goalId;
	const goal = getGoalAcrossProjects(goalId);
	if (!goal) { json({ error: "Goal not found" }, 404); return; }
	if (!hasGoalGitWorktree(goal)) { json(goalGitUnavailablePayload(goal, "Commit history"), 409); return; }
	if (!fs.existsSync(goal.cwd)) { json({ commits: [] }); return; }
	const branch = goal.branch;
	// Validate branch name to prevent injection
	if (!/^[a-zA-Z0-9/_.\-]+$/.test(branch)) { json({ error: "Invalid branch name" }, 400); return; }
	const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "20", 10) || 20, 1), 100);
	try {
		let primaryBranch = "master";
		try {
			const remoteHead = await execGit("git symbolic-ref refs/remotes/origin/HEAD", goal.cwd);
			primaryBranch = remoteHead.replace("refs/remotes/origin/", "");
		} catch {
			try { await execGit("git rev-parse --verify refs/heads/master", goal.cwd); primaryBranch = "master"; }
			catch { try { await execGit("git rev-parse --verify refs/heads/main", goal.cwd); primaryBranch = "main"; } catch { /* keep default */ } }
		}

		let rangeSpec = `-${limit} ${branch}`;
		if (branch !== primaryBranch && branch !== "HEAD") {
			let primaryRef = primaryBranch;
			try { await execGit(`git rev-parse --verify origin/${primaryBranch}`, goal.cwd); primaryRef = `origin/${primaryBranch}`; } catch { /* use local */ }
			try { await execGit(`git rev-parse ${primaryRef}`, goal.cwd); rangeSpec = `-${limit} ${primaryRef}..${branch}`; } catch { /* fall back */ }
		}

		const out = await execGit(`git log --format="${COMMIT_LOG_FORMAT}" --shortstat ${rangeSpec}`, goal.cwd);
		const commits = await attachCommitFiles(parseCommitLogWithShortstat(out), goal.cwd);
		json({ commits });
	} catch (e: any) {
		json({ error: "Failed to read git log", detail: e.message }, 500);
	}
	return;
}

// GET /api/goals/:id/git-status — git status for goal worktree (async)
async function handleGoalGitStatus(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const {
		getGoalAcrossProjects,
		json,
		jsonError,
		projectContextManager,
		sessionManager,
		url,
	} = ctx;
	const goalId = params.goalId;
	const goal = getGoalAcrossProjects(goalId);
	if (!goal) { json({ error: "Goal not found" }, 404); return; }
	if (!hasGoalGitWorktree(goal)) { json(goalGitUnavailablePayload(goal, "Git status"), 409); return; }
	const cwd = goal.cwd;

	// Resolve container ID for sandboxed goals + project `base_ref` config
	// for the `aheadOfPrimary`/`behindPrimary` counter — see
	// `docs/design/base-ref.md` §5.
	let cid: string | undefined;
	let goalBaseRef: string | undefined;
	try {
		const goalCtx = projectContextManager.getContextForGoal(goalId);
		if (goalCtx) {
			goalBaseRef = goalCtx.projectConfigStore.get("base_ref") || undefined;
			if (goal.sandboxed) {
				const sandbox = sessionManager.getSandboxManager()?.get(goalCtx.project.id);
				cid = sandbox ? await sandbox.getContainerId() : undefined;
			}
		}
	} catch { /* container/config unavailable — fall through */ }

	if (!cid && !fs.existsSync(cwd)) { json({ error: "Working directory not found" }, 404); return; }
	const goalUntracked = url.searchParams.get('untracked') === '1';
	if (url.searchParams.get('fetch') === 'true') {
		try { await execGit('git fetch --quiet', cwd, 15000, cid); } catch { /* best-effort */ }
		invalidateGitStatusCache(cwd, cid);
	}
	try {
		const result = await batchGitStatus(cwd, cid, { untracked: goalUntracked, configuredBaseRef: goalBaseRef });
		if (!result) { json({ error: "Not a git repository" }, 400); return; }

		// Multi-repo aware envelope: include `repos` map + `aggregate` for back-compat.
		const repoWorktrees = (goal as { repoWorktrees?: Record<string, string> }).repoWorktrees;
		if (repoWorktrees && Object.keys(repoWorktrees).length > 0) {
			const repos: Record<string, typeof result> = {};
			for (const [repoName, repoPath] of Object.entries(repoWorktrees)) {
				try {
					if (cid || fs.existsSync(repoPath)) {
						const r = await batchGitStatus(repoPath, cid, { untracked: goalUntracked, configuredBaseRef: goalBaseRef });
						if (r) repos[repoName] = r;
					}
				} catch { /* per-repo failure non-fatal */ }
			}
			json({ ...result, aggregate: result, repos });
		} else {
			// Single-repo: include `repos: { ".": result }, aggregate: result` for back-compat.
			json({ ...result, aggregate: result, repos: { ".": result } });
		}
	} catch (err: any) {
		jsonError(500, err, { error: err.stderr?.trim() || err.message || "git status failed" });
	}
	return;
}

// GET /api/goals/:id/git-diff — unified diff for goal worktree
async function handleGoalGitDiff(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const {
		getGoalAcrossProjects,
		json,
		jsonError,
		projectContextManager,
		sessionManager,
		url,
	} = ctx;
	const goalId = params.goalId;
	const goal = getGoalAcrossProjects(goalId);
	if (!goal) { json({ error: "Goal not found" }, 404); return; }
	if (!hasGoalGitWorktree(goal)) { json(goalGitUnavailablePayload(goal, "Git diff"), 409); return; }
	const cwd = goal.cwd;

	// Resolve container ID for sandboxed goals
	let cid: string | undefined;
	if (goal.sandboxed) {
		try {
			const goalCtx = projectContextManager.getContextForGoal(goalId);
			const sandbox = goalCtx ? sessionManager.getSandboxManager()?.get(goalCtx.project.id) : undefined;
			cid = sandbox ? await sandbox.getContainerId() : undefined;
		} catch { /* container unavailable */ }
	}

	if (!cid && !fs.existsSync(cwd)) { json({ error: "Working directory not found" }, 404); return; }
	const file = url.searchParams.get("file") || undefined;
	const commit = url.searchParams.get("commit") || undefined;
	const repoParam = url.searchParams.get("repo") || undefined;
	const goalRepoWorktrees = (goal as { repoWorktrees?: Record<string, string> }).repoWorktrees;
	let diffCwd = cwd;
	if (repoParam && goalRepoWorktrees && goalRepoWorktrees[repoParam]) {
		diffCwd = goalRepoWorktrees[repoParam];
	}
	try {
		const diff = await getGitDiff(diffCwd, file, cid, commit);
		json({ diff });
	} catch (err: any) {
		if (err.message === "INVALID_PATH") { json({ error: "Invalid file path" }, 400); return; }
		if (err.message === "INVALID_COMMIT") { json({ error: "Invalid commit" }, 400); return; }
		if (err.message === "NO_DIFF") { json({ error: "No diff found" }, 404); return; }
		jsonError(500, err);
	}
	return;
}

// GET /api/goals/:id/pr-status — PR status for goal branch (async + cached)
async function handleGoalPrStatus(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { getGoalAcrossProjects, json, noContent, prStatusStore, url } = ctx;
	const goalId = params.goalId;
	const goal = getGoalAcrossProjects(goalId);
	if (!goal) { json({ error: "Goal not found" }, 404); return; }
	if (!hasGoalGitWorktree(goal)) { json(goalGitUnavailablePayload(goal, "PR status"), 409); return; }
	const cwd = goal.cwd;
	if (!fs.existsSync(cwd)) { json({ error: "Working directory not found" }, 404); return; }
	// Pass process.cwd() as fallback — if the goal's worktree has a broken git link
	// (e.g. pruned worktree), gh can still query by branch name from the main repo.
	const optional = url.searchParams.get("optional") === "1";
	const pr = await getCachedPrStatus(cwd, goal.branch, process.cwd());
	if (pr) { prStatusStore.set(goalId, pr); json(pr); } else if (optional) { noContent(); } else { json({ error: "No PR found" }, 404); }
	return;
}

// GET /api/goals/:id/github-link — PR URL or sanitized GitHub branch fallback
async function handleGoalGithubLink(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { getGoalAcrossProjects, json, prStatusStore } = ctx;
	const goalId = params.goalId;
	const goal = getGoalAcrossProjects(goalId);
	if (!goal) { json({ available: false, reason: "goal-not-found" } satisfies GoalGithubLinkResponse); return; }
	if (!hasGoalGitWorktree(goal)) { json({ available: false, reason: "no-worktree", message: noWorktreeGoalGitMessage(goal) } satisfies GoalGithubLinkResponse); return; }

	const cached = prStatusStore.get(goalId);
	if (cached?.url) {
		json({ available: true, kind: "pr", url: cached.url } satisfies GoalGithubLinkResponse);
		return;
	}

	if (goal.branch && fs.existsSync(goal.cwd)) {
		const fresh = await getCachedPrStatus(goal.cwd, goal.branch, process.cwd()).catch(() => null);
		if (fresh?.url) {
			prStatusStore.set(goalId, fresh);
			json({ available: true, kind: "pr", url: fresh.url } satisfies GoalGithubLinkResponse);
			return;
		}
	}

	if (!goal.branch) { json({ available: false, reason: "no-branch" } satisfies GoalGithubLinkResponse); return; }

	const remoteCwd = goal.repoPath || goal.cwd;
	try {
		const { stdout } = await execFileAsync("git", ["remote", "get-url", "origin"], {
			cwd: remoteCwd,
			encoding: "utf-8",
			timeout: 5_000,
		});
		const branchUrl = buildGithubBranchUrl(stripTokenFromGitUrl(stdout.trim()), goal.branch);
		if (!branchUrl) { json({ available: false, reason: "no-github-remote" } satisfies GoalGithubLinkResponse); return; }
		json({ available: true, kind: "branch", url: branchUrl } satisfies GoalGithubLinkResponse);
	} catch {
		json({ available: false, reason: "no-github-remote" } satisfies GoalGithubLinkResponse);
	}
	return;
}

// POST /api/goals/:id/pr-cache-bust — invalidate PR cache for a goal
async function handleGoalPrCacheBust(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { broadcastToAll, getGoalAcrossProjects, json } = ctx;
	const goalId = params.goalId;
	const goal = getGoalAcrossProjects(goalId);
	if (!goal) { json({ error: "Goal not found" }, 404); return; }
	const cwd = goal.cwd;
	_prCache.delete(cwd);
	if (goal.branch) _prCache.delete(`${cwd}::${goal.branch}`);
	broadcastToAll({ type: "pr_status_changed", goalId });
	json({ ok: true });
	return;
}

// GET /api/goals/:id/team — get team state
async function handleGoalTeamState(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { json, teamManager } = ctx;
	const goalId = params.goalId;
	const state = teamManager.getTeamState(goalId);
	if (!state) {
		json({ error: "No active team for this goal" }, 404);
		return;
	}
	// S1: `teamLeadSessionId` is intentionally exposed here. It is NO LONGER
	// an authorization credential — orchestration/operator Children authz
	// binds to the unforgeable per-session `X-Bobbit-Session-Secret` (see
	// children-mutation-authz.ts + session-secret.ts), so knowing the public
	// team-lead session id grants nothing without the secret. Consumers rely
	// on it (the UI, auto-start-team E2E, team-state polling), so we keep it.
	json(state);
	return;
}

// GET /api/goals/:id/team/agents — list agents for a team goal
async function handleGoalTeamAgents(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { json, sessionManager, teamManager, url } = ctx;
	const goalId = params.goalId;
	const agents = teamManager.listAgents(goalId);

	// Include archived (dismissed) agents when ?include=archived is set
	const includeArchived = url.searchParams.get("include") === "archived";
	let archivedAgents: unknown[] = [];
	if (includeArchived) {
		const liveSessionIds = new Set(agents.map((a: any) => a.sessionId));
		archivedAgents = sessionManager.listArchivedSessions()
			.filter(s => s.teamGoalId === goalId && !liveSessionIds.has(s.id))
			.map(s => ({
				sessionId: s.id,
				role: s.role || "unknown",
				status: "archived",
				worktreePath: s.worktreePath || "",
				branch: "",
				task: "",
				createdAt: s.createdAt,
				archivedAt: s.archivedAt,
				title: s.title,
				accessory: s.accessory,
				taskId: s.taskId,
				teamLeadSessionId: s.teamLeadSessionId,
				teamGoalId: s.teamGoalId,
				delegateOf: s.delegateOf,
			}));
	}

	json({ agents: [...agents, ...archivedAgents] });
	return;
}

export function registerGoalGitTeamReadRoutes(table: RouteTable<CoreRouteCtx>): void {
	table.register("GET", "/api/goals/:goalId/commits", handleGoalCommits);
	table.register("GET", "/api/goals/:goalId/git-status", handleGoalGitStatus);
	table.register("GET", "/api/goals/:goalId/git-diff", handleGoalGitDiff);
	table.register("GET", "/api/goals/:goalId/pr-status", handleGoalPrStatus);
	table.register("GET", "/api/goals/:goalId/github-link", handleGoalGithubLink);
	table.register("POST", "/api/goals/:goalId/pr-cache-bust", handleGoalPrCacheBust);
	table.register("GET", "/api/goals/:goalId/team", handleGoalTeamState);
	table.register("GET", "/api/goals/:goalId/swarm", handleGoalTeamState);
	table.register("GET", "/api/goals/:goalId/team/agents", handleGoalTeamAgents);
	table.register("GET", "/api/goals/:goalId/swarm/agents", handleGoalTeamAgents);
}
