import type { IncomingMessage, ServerResponse } from "node:http";
import type { AppContext } from "../app-context.js";
import { readBody, json } from "./utils.js";
import { execGit, execGitSafe } from "../services/github-service.js";
import fs from "node:fs";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export async function handle(
	ctx: AppContext,
	url: URL,
	req: IncomingMessage,
	res: ServerResponse,
): Promise<boolean> {
	const { sessionManager, config, gateStore, workflowManager, prStatusStore, teamManager, broadcastToAll } = ctx;

	// GET /api/goals
	if (url.pathname === "/api/goals" && req.method === "GET") {
		json(res, { goals: sessionManager.goalManager.listGoals() });
		return true;
	}

	// POST /api/goals
	if (url.pathname === "/api/goals" && req.method === "POST") {
		const body = await readBody(req);
		const title = body?.title;
		const cwd = body?.cwd || config.defaultCwd;
		const spec = body?.spec || "";
		const workflowId = (body?.workflowId && typeof body.workflowId === "string") ? body.workflowId : "general";
		if (!title || typeof title !== "string") {
			json(res, { error: "Missing title" }, 400);
			return true;
		}
		try {
			const goal = await sessionManager.goalManager.createGoal(title, cwd, {
				spec,
				workflowId,
				workflowStore: workflowManager.store,
			});
			// Set reattemptOf if provided
			if (body.reattemptOf && typeof body.reattemptOf === "string") {
				sessionManager.goalManager.updateGoal(goal.id, { reattemptOf: body.reattemptOf });
				goal.reattemptOf = body.reattemptOf;
			}
			// Initialize gate states for the workflow
			if (goal.workflow) {
				gateStore.initGatesForGoal(goal.id, goal.workflow.gates.map(g => g.id));
			}
			json(res, goal, 201);

			// Fire-and-forget async worktree setup
			if (goal.setupStatus === "preparing") {
				sessionManager.goalManager.setupWorktree(goal.id).then(() => {
					broadcastToAll({ type: "goal_setup_complete", goalId: goal.id });
				}).catch((err) => {
					broadcastToAll({ type: "goal_setup_error", goalId: goal.id, error: String(err) });
				});
			}
		} catch (err) {
			json(res, { error: String(err) }, 400);
		}
		return true;
	}

	// POST /api/goals/:id/retry-setup — retry worktree setup for a goal in error state
	const retrySetupMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/retry-setup$/);
	if (retrySetupMatch && req.method === "POST") {
		const goalId = retrySetupMatch[1];
		const ok = sessionManager.goalManager.retrySetup(goalId);
		if (!ok) {
			json(res, { error: "Goal not found or not in error state" }, 400);
			return true;
		}
		json(res, { ok: true });
		// Fire-and-forget async worktree setup
		sessionManager.goalManager.setupWorktree(goalId).then(() => {
			broadcastToAll({ type: "goal_setup_complete", goalId });
		}).catch((err) => {
			broadcastToAll({ type: "goal_setup_error", goalId, error: String(err) });
		});
		return true;
	}

	// GET /api/goals/:id/commits — get commit history for goal branch
	const commitsMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/commits$/);
	if (commitsMatch && req.method === "GET") {
		const goalId = commitsMatch[1];
		const goal = sessionManager.goalManager.getGoal(goalId);
		if (!goal) { json(res, { error: "Goal not found" }, 404); return true; }
		if (!fs.existsSync(goal.cwd)) { json(res, { commits: [] }); return true; }
		const branch = goal.branch || "HEAD";
		// Validate branch name to prevent injection
		if (!/^[a-zA-Z0-9/_.\-]+$/.test(branch)) { json(res, { error: "Invalid branch name" }, 400); return true; }
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
			json(res, { commits });
		} catch (e: any) {
			json(res, { error: "Failed to read git log", detail: e.message }, 500);
		}
		return true;
	}

	// GET /api/goals/:id/git-status — git status for goal worktree (async)
	const goalGitMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/git-status$/);
	if (goalGitMatch && req.method === "GET") {
		const goalId = goalGitMatch[1];
		const goal = sessionManager.goalManager.getGoal(goalId);
		if (!goal) { json(res, { error: "Goal not found" }, 404); return true; }
		const cwd = goal.cwd;
		if (!fs.existsSync(cwd)) { json(res, { error: "Working directory not found" }, 404); return true; }
		if (url.searchParams.get('fetch') === 'true') {
			try { await execAsync('git fetch --quiet', { cwd, encoding: 'utf-8', timeout: 15000 }); } catch { /* best-effort */ }
		}
		try {
			let branch = "";
			try { branch = await execGit("git rev-parse --abbrev-ref HEAD", cwd); }
			catch { json(res, { error: "Not a git repository" }, 400); return true; }
			let primaryBranch = "master";
			try {
				const remoteHead = await execGit("git symbolic-ref refs/remotes/origin/HEAD", cwd);
				primaryBranch = remoteHead.replace("refs/remotes/origin/", "");
			} catch {
				try { await execGit("git rev-parse --verify refs/heads/master", cwd); primaryBranch = "master"; }
				catch { try { await execGit("git rev-parse --verify refs/heads/main", cwd); primaryBranch = "main"; } catch { /* keep default */ } }
			}
			const isOnPrimary = branch === primaryBranch;
			let aheadOfPrimary = 0, behindPrimary = 0, mergedIntoPrimary = false;
			if (!isOnPrimary) {
				let primaryRef = primaryBranch;
				try { await execGit(`git rev-parse --verify origin/${primaryBranch}`, cwd); primaryRef = `origin/${primaryBranch}`; } catch { /* use local */ }
				aheadOfPrimary = parseInt(await execGitSafe(`git rev-list --count ${primaryRef}..HEAD`, cwd, "0"), 10) || 0;
				behindPrimary = parseInt(await execGitSafe(`git rev-list --count HEAD..${primaryRef}`, cwd, "0"), 10) || 0;
				mergedIntoPrimary = aheadOfPrimary === 0;
			}
			const statusRaw = await execGitSafe("git status --porcelain", cwd);
			const clean = !statusRaw.trim();
			json(res, { branch, primaryBranch, isOnPrimary, clean, aheadOfPrimary, behindPrimary, mergedIntoPrimary });
		} catch (err) {
			json(res, { error: String(err) }, 500);
		}
		return true;
	}

	// Routes with goal :id parameter
	const goalMatch = url.pathname.match(/^\/api\/goals\/([^/]+)$/);
	if (goalMatch) {
		const id = goalMatch[1];

		if (req.method === "GET") {
			const goal = sessionManager.goalManager.getGoal(id);
			if (!goal) { json(res, { error: "Goal not found" }, 404); return true; }
			json(res, goal);
			return true;
		}

		if (req.method === "PUT") {
			const putGoal = sessionManager.goalManager.getGoal(id);
			if (putGoal?.archived) { json(res, { error: "Goal is archived" }, 409); return true; }
			const body = await readBody(req);
			if (!body) { json(res, { error: "Missing body" }, 400); return true; }
			const ok = await sessionManager.goalManager.updateGoal(id, {
				title: body.title,
				cwd: body.cwd,
				state: body.state,
				spec: body.spec,
				team: true, // Always-on team mode
				repoPath: body.repoPath,
				branch: body.branch,
				prUrl: body.prUrl,
				reattemptOf: body.reattemptOf,
			});
			if (!ok) { json(res, { error: "Goal not found" }, 404); return true; }
			json(res, { ok: true });
			return true;
		}

		if (req.method === "DELETE") {
			// Tear down any active team first (dismisses agents, cleans up their worktrees)
			const teamState = teamManager.getTeamState(id);
			if (teamState) {
				try {
					await teamManager.teardownTeam(id);
				} catch (err) {
					console.error(`[api] Error tearing down team for goal ${id}:`, err);
				}
			}
			// Archive instead of hard-delete — tasks, gates, team state remain intact
			await sessionManager.goalManager.archiveGoal(id);
			prStatusStore.remove(id);
			json(res, { ok: true });
			return true;
		}
	}

	// GET /api/goals/:goalId/cost/breakdown — per-session cost breakdown for a goal
	const goalCostBreakdownMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/cost\/breakdown$/);
	if (goalCostBreakdownMatch && req.method === "GET") {
		const goalId = goalCostBreakdownMatch[1];
		const goal = sessionManager.goalManager.getGoal(goalId);
		if (!goal) {
			json(res, { error: "Goal not found" }, 404);
			return true;
		}
		const sessionIds = sessionManager.getAllSessionIdsForGoal(goalId);
		const costTracker = sessionManager.getCostTracker();
		const allCosts = costTracker.getAllCosts();

		// Build per-session breakdown with metadata
		const sessions: any[] = [];
		for (const sid of sessionIds) {
			const cost = allCosts.get(sid);
			if (!cost || cost.totalCost === 0) continue;

			// Get session metadata from live sessions or store
			const live = sessionManager.listSessions().find(s => s.id === sid);
			const archived = !live ? sessionManager.listArchivedSessions().find(s => s.id === sid) : null;
			const meta = live || archived;

			sessions.push({
				sessionId: sid,
				title: (meta as any)?.title || sid.slice(0, 8),
				role: (meta as any)?.role || null,
				delegateOf: (meta as any)?.delegateOf || null,
				assistantType: (meta as any)?.assistantType || null,
				taskId: (meta as any)?.taskId || null,
				...cost,
			});
		}
		sessions.sort((a, b) => b.totalCost - a.totalCost);
		const aggregate = costTracker.getGoalCost(goalId, sessionIds);
		json(res, { aggregate, sessions });
		return true;
	}

	// GET /api/goals/:goalId/cost — aggregate cost across all sessions linked to a goal
	const goalCostMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/cost$/);
	if (goalCostMatch && req.method === "GET") {
		const goalId = goalCostMatch[1];
		const goal = sessionManager.goalManager.getGoal(goalId);
		if (!goal) {
			json(res, { error: "Goal not found" }, 404);
			return true;
		}
		const sessionIds = sessionManager.getAllSessionIdsForGoal(goalId);
		const cost = sessionManager.getCostTracker().getGoalCost(goalId, sessionIds);
		json(res, cost);
		return true;
	}

	return false;
}
