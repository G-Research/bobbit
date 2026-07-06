// src/server/routes/session-git-write-routes.ts
//
// STR-01 cohort 24: session git write/PR mutation routes migrated out of
// handleApiRoute's legacy if/else chain into the core route registry. See
// docs/design/route-registry.md.
//
// Mechanical extraction — handler bodies below preserve the legacy behavior,
// with only handleApiRoute locals destructured from ctx.
//
// LEGACY FALL-THROUGH PARITY: no unhandled-method shim needed. Every legacy
// block here gated on path and method in the same `if` condition. A method
// mismatch skipped the block and fell through to the terminal 404; RouteTable's
// method-scoped matching preserves that by leaving other methods unregistered.

import { execFile as execFileCb } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import {
	buildGhPrMergeArgs,
	execGit,
	execGitSafe,
	_prCache,
	invalidateGitStatusCache,
	publishCurrentBranchToOrigin,
} from "../skills/git-gh.js";
import { parseBaseRef, shouldSkipRemotePush } from "../skills/git.js";
import type { CoreRouteCtx } from "./core-route-ctx.js";
import type { RouteTable } from "./route-table.js";

const execFileAsync = promisify(execFileCb);

// POST /api/sessions/:id/git-pull — pull latest from remote
async function handleSessionGitPull(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { isHeadquartersSession, json, sessionGitUnavailablePayload, sessionManager } = ctx;
	const id = params.id;
	const session = sessionManager.getSession(id);
	if (!session) { json({ error: "Session not found" }, 404); return; }
	if (isHeadquartersSession(session)) { json(sessionGitUnavailablePayload(session, "Git pull"), 409); return; }
	const cwd = session.cwd;
	const cid = session.sandboxed ? session.containerId : undefined;
	if (!cid && !fs.existsSync(cwd)) { json({ error: "Working directory not found" }, 404); return; }
	try {
		const output = await execGit('git pull', cwd, 30000, cid);
		invalidateGitStatusCache(cwd, cid);
		json({ ok: true, output });
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		json({ error: msg }, 500);
	}
	return;
}

// POST /api/sessions/:id/git-push — push local commits to remote
async function handleSessionGitPush(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { isHeadquartersSession, json, sessionGitUnavailablePayload, sessionManager } = ctx;
	const id = params.id;
	const session = sessionManager.getSession(id);
	if (!session) { json({ error: "Session not found" }, 404); return; }
	if (isHeadquartersSession(session)) { json(sessionGitUnavailablePayload(session, "Git push"), 409); return; }
	if (shouldSkipRemotePush()) { json({ ok: true, output: "skipped (test mode)" }); return; }
	const cwd = session.cwd;
	const cid = session.sandboxed ? session.containerId : undefined;
	if (!cid && !fs.existsSync(cwd)) { json({ error: "Working directory not found" }, 404); return; }
	try {
		const branch = await execGit('git symbolic-ref --short HEAD', cwd, 5000, cid);
		const upstream = await execGitSafe('git rev-parse --abbrev-ref --symbolic-full-name @{u}', cwd, "", cid);
		const output = await publishCurrentBranchToOrigin(cwd, branch, { containerId: cid, setUpstream: !upstream });
		invalidateGitStatusCache(cwd, cid);
		json({ ok: true, output });
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		json({ error: msg }, 500);
	}
	return;
}

// POST /api/sessions/:id/git-squash-push — squash all branch commits and push directly to project primary
async function handleSessionGitSquashPush(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { isHeadquartersSession, json, projectContextManager, sessionGitUnavailablePayload, sessionManager } = ctx;
	const id = params.id;
	const session = sessionManager.getSession(id);
	if (!session) { json({ error: "Session not found" }, 404); return; }
	if (isHeadquartersSession(session)) { json(sessionGitUnavailablePayload(session, "Squash push"), 409); return; }
	if (shouldSkipRemotePush()) { json({ ok: true, output: "skipped (test mode)" }); return; }
	const cwd = session.cwd;
	const cid = session.sandboxed ? session.containerId : undefined;
	if (!cid && !fs.existsSync(cwd)) { json({ error: "Working directory not found" }, 404); return; }
	try {
		// Honour project `base_ref` config. Squash-push fundamentally needs an
		// `origin/<primary>` (it pushes a single commit to that remote ref) —
		// if the configured base_ref points at a local-only branch with no
		// origin counterpart, fail loudly rather than push to the wrong place.
		let sessionBaseRef: string | undefined;
		try {
			const sessCtx = projectContextManager.getContextForSession(id);
			if (sessCtx) sessionBaseRef = sessCtx.projectConfigStore.get("base_ref") || undefined;
		} catch { /* config unavailable — fall through */ }

		const parsedBase = parseBaseRef(sessionBaseRef ?? "");
		let primaryBranch = parsedBase.branch;
		if (!primaryBranch) {
			try {
				const remoteHead = await execGit("git symbolic-ref refs/remotes/origin/HEAD", cwd, 5000, cid);
				primaryBranch = remoteHead.replace("refs/remotes/origin/", "");
			} catch {
				try { await execGit("git rev-parse --verify refs/heads/master", cwd, 5000, cid); primaryBranch = "master"; }
				catch { try { await execGit("git rev-parse --verify refs/heads/main", cwd, 5000, cid); primaryBranch = "main"; } catch { primaryBranch = "master"; } }
			}
		}

		// Fetch the remote primary; if origin has no such ref, refuse — squash
		// push only makes sense for a remote primary.
		try { await execGit(`git fetch origin ${primaryBranch}`, cwd, 30000, cid); }
		catch { json({ error: `origin has no "${primaryBranch}" branch — squash push needs a remote primary. Check the project's base_ref configuration.` }, 400); return; }
		const primaryRef = `origin/${primaryBranch}`;

		// Check we have commits ahead
		const aheadCount = parseInt(await execGit(`git rev-list --count ${primaryRef}..HEAD`, cwd, 5000, cid), 10) || 0;
		if (aheadCount === 0) { json({ error: `No commits ahead of ${primaryRef}` }, 400); return; }

		// Build commit message from branch commits
		const logOutput = await execGit(`git log --format="%s" ${primaryRef}..HEAD`, cwd, 5000, cid);
		const commitMessages = logOutput.trim().split("\n").filter(Boolean);
		const branch = await execGit("git rev-parse --abbrev-ref HEAD", cwd, 5000, cid);
		const summary = commitMessages.length === 1
			? commitMessages[0]
			: `Squash ${branch} (${commitMessages.length} commits)`;
		const body = commitMessages.length > 1
			? commitMessages.map(m => `- ${m}`).join("\n")
			: "";
		const fullMessage = body ? `${summary}\n\n${body}` : summary;

		// Create squash commit on top of origin/master using plumbing (no checkout needed)
		// 1. Create a tree that represents the merge result
		const mergeTree = await execGit(`git merge-tree --write-tree ${primaryRef} HEAD`, cwd, 5000, cid);
		// 2. Create a commit object with that tree, parented on origin/master
		// For sandboxed sessions, write temp file inside container
		const msgFile = cid ? `/tmp/SQUASH_MSG_${Date.now()}` : path.join(cwd, ".git", "SQUASH_MSG");
		if (cid) {
			await execFileAsync("docker", [
				"exec", "-w", cwd, cid, "/bin/sh", "-c", `cat > ${msgFile} << 'BOBBIT_EOF'\n${fullMessage}\nBOBBIT_EOF`,
			], { encoding: "utf-8", timeout: 5000, env: { ...process.env, MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" } });
		} else {
			fs.writeFileSync(msgFile, fullMessage, "utf-8");
		}
		const squashCommit = await execGit(`git commit-tree ${mergeTree} -p ${primaryRef} -F "${msgFile}"`, cwd, 5000, cid);
		if (cid) {
			await execGit(`rm -f ${msgFile}`, cwd, 5000, cid).catch(() => {});
		} else {
			fs.unlinkSync(msgFile);
		}
		// 3. Push that commit to master
		await execGit(`git push origin ${squashCommit}:refs/heads/${primaryBranch}`, cwd, 30000, cid);
		invalidateGitStatusCache(cwd, cid);

		json({ ok: true, output: `Squash pushed ${aheadCount} commit${aheadCount > 1 ? "s" : ""} to ${primaryBranch}` });
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		// Check for merge conflicts from merge-tree
		if (msg.includes("CONFLICT") || msg.includes("merge-tree")) {
			json({ error: "Merge conflicts with primary. Use 'Rebase on primary' first to resolve." }, 409);
		} else {
			json({ error: msg }, 500);
		}
	}
	return;
}

// POST /api/sessions/:id/git-merge-primary — rebase current branch onto project's primary ref
async function handleSessionGitMergePrimary(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { isHeadquartersSession, json, projectContextManager, sessionGitUnavailablePayload, sessionManager } = ctx;
	const id = params.id;
	const session = sessionManager.getSession(id);
	if (!session) { json({ error: "Session not found" }, 404); return; }
	if (isHeadquartersSession(session)) { json(sessionGitUnavailablePayload(session, "Rebase on primary"), 409); return; }
	const cwd = session.cwd;
	const cid = session.sandboxed ? session.containerId : undefined;
	if (!cid && !fs.existsSync(cwd)) { json({ error: "Working directory not found" }, 404); return; }
	try {
		// Honour project `base_ref` config when set (mirrors the git-status
		// handler at line ~6598). A local-only base_ref (e.g. "MyUpstream")
		// must rebase against the LOCAL branch, not `origin/MyUpstream` which
		// may not exist.
		let sessionBaseRef: string | undefined;
		try {
			const sessCtx = projectContextManager.getContextForSession(id);
			if (sessCtx) sessionBaseRef = sessCtx.projectConfigStore.get("base_ref") || undefined;
		} catch { /* config unavailable — fall through */ }

		const parsedBase = parseBaseRef(sessionBaseRef ?? "");
		let primaryBranch = parsedBase.branch;
		if (!primaryBranch) {
			try {
				const remoteHead = await execGit("git symbolic-ref refs/remotes/origin/HEAD", cwd, 5000, cid);
				primaryBranch = remoteHead.replace("refs/remotes/origin/", "");
			} catch {
				try { await execGit("git rev-parse --verify refs/heads/master", cwd, 5000, cid); primaryBranch = "master"; }
				catch { try { await execGit("git rev-parse --verify refs/heads/main", cwd, 5000, cid); primaryBranch = "main"; } catch { primaryBranch = "master"; } }
			}
		}

		// Resolve actual ref: prefer `origin/<primary>` when origin has it,
		// else fall back to the bare local branch (matches `pref` semantics
		// in `git-status-native.ts`).
		let primaryRef = primaryBranch;
		try { await execGit(`git rev-parse --verify origin/${primaryBranch}`, cwd, 5000, cid); primaryRef = `origin/${primaryBranch}`; } catch { /* use local */ }

		// Only fetch when we're actually targeting the remote.
		if (primaryRef.startsWith("origin/")) {
			await execGit(`git fetch origin ${primaryBranch}`, cwd, 30000, cid);
		}
		const output = await execGit(`git rebase ${primaryRef}`, cwd, 30000, cid);

		// After rebase, check if orphaned commits remain (common after squash-merge PRs).
		// If the tree is identical to the primary ref (no diff), the commits are redundant —
		// reset to the primary ref to clean them up.
		const aheadAfter = parseInt(await execGitSafe(`git rev-list --count ${primaryRef}..HEAD`, cwd, "0", cid), 10) || 0;
		if (aheadAfter > 0) {
			const diff = await execGitSafe(`git diff ${primaryRef}..HEAD`, cwd, "", cid);
			if (diff.trim() === "") {
				// Tree is identical — these are orphaned commits from a squash merge
				await execGit(`git reset --hard ${primaryRef}`, cwd, 10000, cid);
				invalidateGitStatusCache(cwd, cid);
				json({ ok: true, output: `Rebased and reset ${aheadAfter} orphaned commit(s) from squash merge` });
				return;
			}
		}
		invalidateGitStatusCache(cwd, cid);

		json({ ok: true, output });
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		json({ error: msg }, 500);
	}
	return;
}

// POST /api/sessions/:id/pr-merge — merge PR for session's branch
async function handleSessionPrMerge(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { getGoalAcrossProjects, isHeadquartersSession, json, readBody, req, sessionGitUnavailablePayload, sessionManager } = ctx;
	const id = params.id;
	const session = sessionManager.getSession(id);
	if (!session) { json({ error: "Session not found" }, 404); return; }
	if (isHeadquartersSession(session)) { json(sessionGitUnavailablePayload(session, "PR merge"), 409); return; }
	const cwd = session.cwd;
	const cid = session.sandboxed ? session.containerId : undefined;
	if (!cid && !fs.existsSync(cwd)) { json({ error: "Working directory not found" }, 404); return; }
	const body = await readBody(req);
	const method = body?.method ?? "squash";
	if (!["merge", "squash", "rebase"].includes(method)) {
		json({ error: "Invalid merge method. Must be merge, squash, or rebase." }, 400);
		return;
	}
	// Prefer the client-provided branch (headRefName from PR status) so the merge
	// targets the exact PR the widget displayed — avoids mismatches when the session's
	// persisted branch differs from the PR's head ref (e.g. staff/team agent worktrees).
	const clientBranch = typeof body?.branch === "string" ? body.branch : undefined;
	const goalBranch = session.goalId ? getGoalAcrossProjects(session.goalId)?.branch : undefined;
	const sessMergeBranch = clientBranch || goalBranch || sessionManager.getPersistedSession(id)?.branch;
	try {
		// PR merge uses `gh` CLI — for sandboxed sessions, run on host worktree
		const mergeCwd = cid ? (session.worktreePath || cwd) : cwd;
		await execFileAsync("gh", buildGhPrMergeArgs(sessMergeBranch, method, body?.admin), { cwd: mergeCwd, encoding: "utf-8", timeout: 30000 });
		_prCache.delete(cwd);
		if (sessMergeBranch) _prCache.delete(`${cwd}::${sessMergeBranch}`);
		json({ ok: true });
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		json({ error: msg }, 500);
	}
	return;
}

export function registerSessionGitWriteRoutes(table: RouteTable<CoreRouteCtx>): void {
	table.register("POST", "/api/sessions/:id/git-pull", handleSessionGitPull);
	table.register("POST", "/api/sessions/:id/git-push", handleSessionGitPush);
	table.register("POST", "/api/sessions/:id/git-squash-push", handleSessionGitSquashPush);
	table.register("POST", "/api/sessions/:id/git-merge-primary", handleSessionGitMergePrimary);
	table.register("POST", "/api/sessions/:id/pr-merge", handleSessionPrMerge);
}
