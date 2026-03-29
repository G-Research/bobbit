import { exec } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import http from "node:http";
import type { AppContext } from "../app-context.js";
import { readBody, json } from "./utils.js";
import { execGit, execGitSafe, getCachedPrStatus, bustPrCache } from "../services/github-service.js";

const execAsync = promisify(exec);

export async function handle(ctx: AppContext, url: URL, req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
	const { sessionManager, prStatusStore, broadcastToAll } = ctx;

	// GET /api/sessions/:id/git-status — get git status for session's working directory (async)
	if (req.method === 'GET' && url.pathname.startsWith('/api/sessions/') && url.pathname.endsWith('/git-status')) {
		const id = url.pathname.split('/')[3];
		const session = sessionManager.getSession(id);
		if (!session) {
			json(res, { error: "Session not found" }, 404);
			return true;
		}
		const cwd = session.cwd;

		// Optional: run git fetch first when ?fetch=true is passed
		if (url.searchParams.get('fetch') === 'true') {
			try { await execAsync('git fetch --quiet', { cwd, encoding: 'utf-8', timeout: 15000 }); } catch { /* best-effort */ }
		}

		try {
			let branch = '';
			try { branch = await execGit('git rev-parse --abbrev-ref HEAD', cwd); }
			catch { json(res, { error: "Not a git repository" }, 400); return true; }

			let primaryBranch = 'master';
			try {
				const remoteHead = await execGit('git symbolic-ref refs/remotes/origin/HEAD', cwd);
				primaryBranch = remoteHead.replace('refs/remotes/origin/', '');
			} catch {
				try { await execGit('git rev-parse --verify refs/heads/master', cwd); primaryBranch = 'master'; }
				catch { try { await execGit('git rev-parse --verify refs/heads/main', cwd); primaryBranch = 'main'; } catch { /* keep default */ } }
			}

			const isOnPrimary = branch === primaryBranch;
			// Don't use execGit here — its trim() strips the leading space from
			// porcelain status lines like " M file.txt", corrupting the first filename.
			let statusRaw = "";
			try {
				const { stdout } = await execAsync('git status --porcelain', { cwd, encoding: "utf-8", timeout: 5000 });
				statusRaw = stdout.replace(/\s+$/, '');
			} catch {}
			const statusLines = statusRaw ? statusRaw.split("\n") : [];
			const status = statusLines.map(line => {
				const l = line.endsWith("\r") ? line.slice(0, -1) : line;
				return { file: l.substring(3), status: l.substring(0, 2).trim() };
			});

			let hasUpstream = false;
			try { await execGit(`git rev-parse --abbrev-ref ${branch}@{u}`, cwd); hasUpstream = true; } catch { /* no upstream */ }

			let ahead = 0, behind = 0;
			if (hasUpstream) {
				ahead = parseInt(await execGitSafe('git rev-list --count @{u}..HEAD', cwd, '0'), 10) || 0;
				behind = parseInt(await execGitSafe('git rev-list --count HEAD..@{u}', cwd, '0'), 10) || 0;
			}

			let aheadOfPrimary = 0, behindPrimary = 0, mergedIntoPrimary = false;
			if (!isOnPrimary) {
				let primaryRef = primaryBranch;
				try { await execGit(`git rev-parse --verify origin/${primaryBranch}`, cwd); primaryRef = `origin/${primaryBranch}`; } catch { /* use local */ }
				aheadOfPrimary = parseInt(await execGitSafe(`git rev-list --count ${primaryRef}..HEAD`, cwd, '0'), 10) || 0;
				behindPrimary = parseInt(await execGitSafe(`git rev-list --count HEAD..${primaryRef}`, cwd, '0'), 10) || 0;
				mergedIntoPrimary = aheadOfPrimary === 0;
			}

			const clean = statusLines.length === 0;
			let summary = 'clean';
			if (!clean) {
				const counts: Record<string, number> = {};
				for (const line of statusLines) {
					const code = line.substring(0, 2).trim();
					let key: string;
					if (code.includes('?')) key = '?';
					else if (code.includes('M')) key = 'M';
					else if (code.includes('A')) key = 'A';
					else if (code.includes('D')) key = 'D';
					else if (code.includes('R')) key = 'R';
					else if (code.includes('U')) key = 'U';
					else key = code;
					counts[key] = (counts[key] || 0) + 1;
				}
				summary = Object.entries(counts).map(([k, v]) => `${v}${k}`).join(' ');
			}

			json(res, {
				branch, primaryBranch, isOnPrimary, status, hasUpstream,
				ahead, behind, aheadOfPrimary, behindPrimary, mergedIntoPrimary,
				clean, summary, unpushed: hasUpstream ? ahead > 0 : !mergedIntoPrimary,
			});
		} catch (err) {
			json(res, { error: String(err) }, 500);
		}
		return true;
	}

	// GET /api/sessions/:id/pr-status — PR status for session's branch
	if (req.method === 'GET' && url.pathname.startsWith('/api/sessions/') && url.pathname.endsWith('/pr-status')) {
		const id = url.pathname.split('/')[3];
		const session = sessionManager.getSession(id);
		if (!session) { json(res, { error: "Session not found" }, 404); return true; }
		const cwd = session.cwd;
		if (!fs.existsSync(cwd)) { json(res, { error: "Working directory not found" }, 404); return true; }
		// Use goal branch if available so we find the right PR even if the worktree HEAD diverged
		const goalBranch = session.goalId ? sessionManager.goalManager.getGoal(session.goalId)?.branch : undefined;
		const pr = await getCachedPrStatus(cwd, goalBranch);
		if (pr) {
			const goalId = session.goalId;
			if (goalId) prStatusStore.set(goalId, pr);
			json(res, pr);
		} else { json(res, { error: "No PR found" }, 404); }
		return true;
	}

	// POST /api/sessions/:id/git-pull — pull latest from remote
	if (req.method === 'POST' && url.pathname.startsWith('/api/sessions/') && url.pathname.endsWith('/git-pull')) {
		const id = url.pathname.split('/')[3];
		const session = sessionManager.getSession(id);
		if (!session) { json(res, { error: "Session not found" }, 404); return true; }
		const cwd = session.cwd;
		if (!fs.existsSync(cwd)) { json(res, { error: "Working directory not found" }, 404); return true; }
		try {
			const { stdout } = await execAsync('git pull', { cwd, encoding: "utf-8", timeout: 30000 });
			json(res, { ok: true, output: stdout.trim() });
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			json(res, { error: msg }, 500);
		}
		return true;
	}

	// POST /api/sessions/:id/git-push — push local commits to remote
	if (req.method === 'POST' && url.pathname.startsWith('/api/sessions/') && url.pathname.endsWith('/git-push')) {
		const id = url.pathname.split('/')[3];
		const session = sessionManager.getSession(id);
		if (!session) { json(res, { error: "Session not found" }, 404); return true; }
		const cwd = session.cwd;
		if (!fs.existsSync(cwd)) { json(res, { error: "Working directory not found" }, 404); return true; }
		try {
			const { stdout } = await execAsync('git push', { cwd, encoding: "utf-8", timeout: 30000 });
			json(res, { ok: true, output: stdout.trim() });
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			json(res, { error: msg }, 500);
		}
		return true;
	}

	// POST /api/sessions/:id/pr-merge — merge PR for session's branch
	if (req.method === 'POST' && url.pathname.startsWith('/api/sessions/') && url.pathname.endsWith('/pr-merge')) {
		const id = url.pathname.split('/')[3];
		const session = sessionManager.getSession(id);
		if (!session) { json(res, { error: "Session not found" }, 404); return true; }
		const cwd = session.cwd;
		if (!fs.existsSync(cwd)) { json(res, { error: "Working directory not found" }, 404); return true; }
		const body = await readBody(req);
		const method = body?.method ?? "squash";
		if (!["merge", "squash", "rebase"].includes(method)) {
			json(res, { error: "Invalid merge method. Must be merge, squash, or rebase." }, 400);
			return true;
		}
		const sessAdminFlag = body?.admin ? " --admin" : "";
		const sessMergeBranch = session.goalId ? sessionManager.goalManager.getGoal(session.goalId)?.branch : undefined;
		try {
			await execAsync(`gh pr merge --${method}${sessAdminFlag}`, { cwd, encoding: "utf-8", timeout: 30000 });
			bustPrCache(cwd, sessMergeBranch);
			json(res, { ok: true });
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			json(res, { error: msg }, 500);
		}
		return true;
	}

	// GET /api/pr-status-cache — bulk PR status from disk cache (startup hydration)
	if (req.method === "GET" && url.pathname === "/api/pr-status-cache") {
		json(res, prStatusStore.getAll());
		return true;
	}

	// ── Goal PR routes ──

	// GET /api/goals/:id/pr-status — PR status for goal branch (async + cached)
	const goalPrStatusMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/pr-status$/);
	if (goalPrStatusMatch && req.method === "GET") {
		const goalId = goalPrStatusMatch[1];
		const goal = sessionManager.goalManager.getGoal(goalId);
		if (!goal) { json(res, { error: "Goal not found" }, 404); return true; }
		const cwd = goal.cwd;
		if (!fs.existsSync(cwd)) { json(res, { error: "Working directory not found" }, 404); return true; }
		const pr = await getCachedPrStatus(cwd, goal.branch);
		if (pr) { prStatusStore.set(goalId, pr); json(res, pr); } else { json(res, { error: "No PR found" }, 404); }
		return true;
	}

	// POST /api/goals/:id/pr-cache-bust — invalidate PR cache for a goal
	const goalPrCacheBustMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/pr-cache-bust$/);
	if (req.method === 'POST' && goalPrCacheBustMatch) {
		const goalId = goalPrCacheBustMatch[1];
		const goal = sessionManager.goalManager.getGoal(goalId);
		if (!goal) { json(res, { error: "Goal not found" }, 404); return true; }
		bustPrCache(goal.cwd, goal.branch);
		broadcastToAll({ type: "pr_status_changed", goalId });
		json(res, { ok: true });
		return true;
	}

	// POST /api/goals/:id/pr-merge — merge PR for goal branch
	const goalPrMergeMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/pr-merge$/);
	if (goalPrMergeMatch && req.method === "POST") {
		const goalId = goalPrMergeMatch[1];
		const goal = sessionManager.goalManager.getGoal(goalId);
		if (!goal) { json(res, { error: "Goal not found" }, 404); return true; }
		const cwd = goal.cwd;
		if (!fs.existsSync(cwd)) { json(res, { error: "Working directory not found" }, 404); return true; }
		const body = await readBody(req);
		const method = body?.method ?? "squash";
		if (!["merge", "squash", "rebase"].includes(method)) {
			json(res, { error: "Invalid merge method. Must be merge, squash, or rebase." }, 400);
			return true;
		}
		const goalAdminFlag = body?.admin ? " --admin" : "";
		try {
			await execAsync(`gh pr merge --${method}${goalAdminFlag}`, { cwd, encoding: "utf-8", timeout: 30000 });
			bustPrCache(cwd, goal.branch);
			json(res, { ok: true });
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			json(res, { error: msg }, 500);
		}
		return true;
	}

	return false;
}
