/**
 * Per-goal git endpoints + global pr-status-cache.
 * Extracted from server.ts (commit: split server.ts).
 */
import { exec } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import { execGit } from "../git/git-exec.js";
import { batchGitStatus, invalidateGitStatusCache } from "../git/git-status.js";
import { getGitDiff } from "../git/git-diff.js";
import { getCachedPrStatus, clearPrStatusCache } from "../git/pr-status.js";
import { getGoalAcrossProjects } from "./cross-project.js";
import type { Route } from "./types.js";

const execAsync = promisify(exec);

export const goalsGitRoutes: Route[] = [
	{
		method: "GET",
		pattern: "/api/pr-status-cache",
		handler: ({ deps, json }) => {
			json(deps.prStatusStore.getAll());
		},
	},
	{
		method: "GET",
		pattern: /^\/api\/goals\/([^/]+)\/commits$/,
		handler: async ({ deps, params, url, json, jsonError }) => {
			const goalId = params[1];
			const goal = getGoalAcrossProjects(deps, goalId);
			if (!goal) { jsonError(404, new Error("Goal not found")); return; }
			if (!fs.existsSync(goal.cwd)) { json({ commits: [] }); return; }
			const branch = goal.branch || "HEAD";
			if (!/^[a-zA-Z0-9/_.\-]+$/.test(branch)) { jsonError(400, new Error("Invalid branch name")); return; }
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

				const out = await execGit(`git log --format="%H|%h|%s|%an|%aI" ${rangeSpec}`, goal.cwd);
				const commits = out.trim().split("\n").filter(Boolean).map((line: string) => {
					const [sha, shortSha, message, author, timestamp] = line.split("|");
					return { sha, shortSha, message, author, timestamp };
				});
				json({ commits });
			} catch (e: any) {
				jsonError(500, new Error("Failed to read git log"), { detail: e.message });
			}
		},
	},
	{
		method: "GET",
		pattern: /^\/api\/goals\/([^/]+)\/git-status$/,
		handler: async ({ deps, params, url, json, jsonError }) => {
			const goalId = params[1];
			const goal = getGoalAcrossProjects(deps, goalId);
			if (!goal) { jsonError(404, new Error("Goal not found")); return; }
			const cwd = goal.cwd;

			let cid: string | undefined;
			if (goal.sandboxed) {
				try {
					const goalCtx = deps.projectContextManager.getContextForGoal(goalId);
					const sandbox = goalCtx ? deps.sessionManager.getSandboxManager()?.get(goalCtx.project.id) : undefined;
					cid = sandbox ? await sandbox.getContainerId() : undefined;
				} catch { /* container unavailable */ }
			}

			if (!cid && !fs.existsSync(cwd)) { jsonError(404, new Error("Working directory not found")); return; }
			const goalUntracked = url.searchParams.get('untracked') === '1';
			if (url.searchParams.get('fetch') === 'true') {
				try { await execGit('git fetch --quiet', cwd, 15000, cid); } catch { /* best-effort */ }
				invalidateGitStatusCache(cwd, cid);
			}
			try {
				const result = await batchGitStatus(cwd, cid, { untracked: goalUntracked });
				if (!result) { jsonError(400, new Error("Not a git repository")); return; }

				const repoWorktrees = (goal as { repoWorktrees?: Record<string, string> }).repoWorktrees;
				if (repoWorktrees && Object.keys(repoWorktrees).length > 0) {
					const repos: Record<string, typeof result> = {};
					for (const [repoName, repoPath] of Object.entries(repoWorktrees)) {
						try {
							if (cid || fs.existsSync(repoPath)) {
								const r = await batchGitStatus(repoPath, cid, { untracked: goalUntracked });
								if (r) repos[repoName] = r;
							}
						} catch { /* per-repo failure non-fatal */ }
					}
					json({ ...result, aggregate: result, repos });
				} else {
					json({ ...result, aggregate: result, repos: { ".": result } });
				}
			} catch (err: any) {
				jsonError(500, err, { error: err.stderr?.trim() || err.message || "git status failed" });
			}
		},
	},
	{
		method: "GET",
		pattern: /^\/api\/goals\/([^/]+)\/git-diff$/,
		handler: async ({ deps, params, url, json, jsonError }) => {
			const goalId = params[1];
			const goal = getGoalAcrossProjects(deps, goalId);
			if (!goal) { jsonError(404, new Error("Goal not found")); return; }
			const cwd = goal.cwd;

			let cid: string | undefined;
			if (goal.sandboxed) {
				try {
					const goalCtx = deps.projectContextManager.getContextForGoal(goalId);
					const sandbox = goalCtx ? deps.sessionManager.getSandboxManager()?.get(goalCtx.project.id) : undefined;
					cid = sandbox ? await sandbox.getContainerId() : undefined;
				} catch { /* container unavailable */ }
			}

			if (!cid && !fs.existsSync(cwd)) { jsonError(404, new Error("Working directory not found")); return; }
			const file = url.searchParams.get("file") || undefined;
			const repoParam = url.searchParams.get("repo") || undefined;
			const goalRepoWorktrees = (goal as { repoWorktrees?: Record<string, string> }).repoWorktrees;
			let diffCwd = cwd;
			if (repoParam && goalRepoWorktrees && goalRepoWorktrees[repoParam]) {
				diffCwd = goalRepoWorktrees[repoParam];
			}
			try {
				const diff = await getGitDiff(diffCwd, file, cid);
				json({ diff });
			} catch (err: any) {
				if (err.message === "INVALID_PATH") { jsonError(400, new Error("Invalid file path")); return; }
				if (err.message === "NO_DIFF") { jsonError(404, new Error("No diff found")); return; }
				jsonError(500, err);
			}
		},
	},
	{
		method: "GET",
		pattern: /^\/api\/goals\/([^/]+)\/pr-status$/,
		handler: async ({ deps, params, json, jsonError }) => {
			const goalId = params[1];
			const goal = getGoalAcrossProjects(deps, goalId);
			if (!goal) { jsonError(404, new Error("Goal not found")); return; }
			const cwd = goal.cwd;
			if (!fs.existsSync(cwd)) { jsonError(404, new Error("Working directory not found")); return; }
			const pr = await getCachedPrStatus(cwd, goal.branch, process.cwd());
			if (pr) { deps.prStatusStore.set(goalId, pr); json(pr); } else { jsonError(404, new Error("No PR found")); }
		},
	},
	{
		method: "POST",
		pattern: /^\/api\/goals\/([^/]+)\/pr-cache-bust$/,
		handler: ({ deps, params, json, jsonError }) => {
			const goalId = params[1];
			const goal = getGoalAcrossProjects(deps, goalId);
			if (!goal) { jsonError(404, new Error("Goal not found")); return; }
			const cwd = goal.cwd;
			clearPrStatusCache(cwd, goal.branch);
			deps.broadcastToAll({ type: "pr_status_changed", goalId });
			json({ ok: true });
		},
	},
	{
		method: "POST",
		pattern: /^\/api\/goals\/([^/]+)\/pr-merge$/,
		handler: async ({ deps, params, readBody, json, jsonError }) => {
			const goalId = params[1];
			const goal = getGoalAcrossProjects(deps, goalId);
			if (!goal) { jsonError(404, new Error("Goal not found")); return; }
			const cwd = goal.cwd;
			if (!fs.existsSync(cwd)) { jsonError(404, new Error("Working directory not found")); return; }
			const body = await readBody();
			const method = body?.method ?? "squash";
			if (!["merge", "squash", "rebase"].includes(method)) {
				jsonError(400, new Error("Invalid merge method. Must be merge, squash, or rebase."));
				return;
			}
			const goalAdminFlag = body?.admin ? " --admin" : "";
			const clientGoalBranch = typeof body?.branch === "string" ? body.branch : undefined;
			const resolvedGoalBranch = clientGoalBranch || goal.branch;
			const goalMergeBranch = resolvedGoalBranch ? ` ${resolvedGoalBranch}` : "";
			try {
				await execAsync(`gh pr merge${goalMergeBranch} --${method}${goalAdminFlag}`, { cwd, encoding: "utf-8", timeout: 30000 });
				clearPrStatusCache(cwd, goal.branch);
				json({ ok: true });
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				jsonError(500, new Error(msg));
			}
		},
	},
];
