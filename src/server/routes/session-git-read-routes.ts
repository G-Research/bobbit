// src/server/routes/session-git-read-routes.ts
//
// STR-01 cohort 23: session git read/status routes migrated out of
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

import fs from "node:fs";
import {
	attachCommitFiles,
	batchGitStatus,
	COMMIT_LOG_FORMAT,
	execGit,
	getCachedPrStatus,
	getGitDiff,
	invalidateGitStatusCache,
	parseCommitLogWithShortstat,
	publishCurrentBranchToOrigin,
	sessionGitStatusAutoPublishDecision,
	sessionGitStatusRemotePublication,
	type GitStatusResult,
} from "../skills/git-gh.js";
import { shouldSkipRemotePush } from "../skills/git.js";
import type { CoreRouteCtx } from "./core-route-ctx.js";
import type { RouteTable } from "./route-table.js";

// GET /api/sessions/:id/git-status — get git status for session's working directory (async)
async function handleSessionGitStatus(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const {
		isHeadquartersSession,
		json,
		jsonError,
		projectContextManager,
		sessionGitUnavailablePayload,
		sessionManager,
		url,
	} = ctx;
	const id = params.id;
	const session = sessionManager.getSession(id);
	if (!session) {
		json({ error: "Session not found" }, 404);
		return;
	}
	if (isHeadquartersSession(session)) { json(sessionGitUnavailablePayload(session, "Git status"), 409); return; }
	const cwd = session.cwd;
	const cid = session.sandboxed ? session.containerId : undefined;

	if (!cid && !fs.existsSync(cwd)) { json({ error: "Working directory not found" }, 404); return; }

	// Resolve project `base_ref` config for the `aheadOfPrimary`/`behindPrimary`
	// counter — see `docs/design/base-ref.md` §5.
	let sessionBaseRef: string | undefined;
	try {
		const sessCtx = projectContextManager.getContextForSession(id);
		if (sessCtx) sessionBaseRef = sessCtx.projectConfigStore.get("base_ref") || undefined;
	} catch { /* config unavailable — fall through */ }

	// Optional: run git fetch first when ?fetch=true is passed
	const sessUntracked = url.searchParams.get('untracked') === '1';
	if (url.searchParams.get('fetch') === 'true') {
		try { await execGit('git fetch --quiet', cwd, 15000, cid); } catch { /* best-effort */ }
		invalidateGitStatusCache(cwd, cid);
	}

	// Single attempt — native parallel execFile is fast (50–150 ms p50 on
	// Windows) and errors are not cached, so the client retry loop in
	// `git-status-refresh.ts` (4 attempts × 0/500/2000/5000 ms backoff) is
	// the resilience layer for transient failures.
	// `session.repoWorktrees` is an ARRAY `Array<{repo, repoPath, worktreePath}>`
	// (session-manager.ts), unlike the goal's `Record<string,string>`.
	const sessRepoWorktrees = session.repoWorktrees;
	const isMultiRepo = !!(sessRepoWorktrees && sessRepoWorktrees.length > 1);

	// Root container status. In a TRUE polyrepo (no `repo: "."` git-root
	// component) the container `cwd` is NOT itself a git repo, so this is
	// null/throws — that is non-fatal in multi-repo mode (the per-repo
	// worktrees below are the source of truth). For single-repo it must
	// keep the existing 400/500 behavior.
	let result: Awaited<ReturnType<typeof batchGitStatus>> | undefined;
	try {
		result = await batchGitStatus(cwd, cid, { untracked: sessUntracked, configuredBaseRef: sessionBaseRef });
	} catch (err: any) {
		if (!isMultiRepo) {
			console.error("[git-status handler] error for session", id, "cwd=", cwd, "code=", err?.code, "signal=", err?.signal, "killed=", err?.killed, "stderr=", err?.stderr, "message=", err?.message);
			jsonError(500, err, { error: err?.stderr?.trim() || err?.message || "git status failed" });
			return;
		}
		// Multi-repo: container-cwd failure is expected/non-fatal.
		result = undefined;
	}

	if (!isMultiRepo) {
		// Single-repo / no repoWorktrees: keep back-compat flat shape plus
		// `repos: { ".": result }, aggregate: result`.
		if (!result) { json({ error: "Not a git repository" }, 400); return; }
		const remotePublication = sessionGitStatusRemotePublication(sessionManager, id, session, result.branch);
		const shapedResult = remotePublication ? { ...result, remotePublication } : result;
		json({ ...shapedResult, aggregate: shapedResult, repos: { ".": shapedResult } });

		// Auto-push: for feature branches with unpushed commits, publish the
		// current branch to its matching remote ref regardless of inherited
		// upstream config. Local-only sessions are explicitly durable via their
		// local worktree and must not publish just because status was queried.
		const publishDecision = sessionGitStatusAutoPublishDecision(result, remotePublication);
		if (publishDecision && !shouldSkipRemotePush()) {
			publishCurrentBranchToOrigin(cwd, publishDecision.branch, {
				containerId: cid,
				setUpstream: publishDecision.setUpstream,
			}).catch(() => {});
		}
		return;
	}

	// Multi-repo aware envelope (parity with the goal git-status handler):
	// emit a `repos` map keyed by repo name + an `aggregate`.
	const repos: Record<string, GitStatusResult> = {};
	for (const { repo, worktreePath } of sessRepoWorktrees!) {
		try {
			if (cid || fs.existsSync(worktreePath)) {
				const r = await batchGitStatus(worktreePath, cid, { untracked: sessUntracked, configuredBaseRef: sessionBaseRef });
				if (r) repos[repo] = r;
			}
		} catch { /* per-repo failure non-fatal */ }
	}

	const repoResults = Object.values(repos);
	// Aggregate: prefer the root container status when it IS a git repo
	// (e.g. a `repo: "."` component) for back-compat; otherwise synthesize
	// one from the per-repo results. All sub-repos share the same session
	// branch, so branch/primary fields come from the first repo while the
	// numeric counters are summed and `clean` is the AND across repos.
	let aggregate: GitStatusResult | undefined = result ?? undefined;
	if (!aggregate) {
		if (repoResults.length === 0) { json({ error: "Not a git repository" }, 400); return; }
		const base = repoResults[0];
		const sum = (pick: (r: GitStatusResult) => number) =>
			repoResults.reduce((acc, r) => acc + (typeof pick(r) === "number" ? pick(r) : 0), 0);
		const ahead = sum(r => r.ahead);
		const behind = sum(r => r.behind);
		const insertionsVsPrimary = sum(r => r.insertionsVsPrimary);
		const deletionsVsPrimary = sum(r => r.deletionsVsPrimary);
		aggregate = {
			branch: base.branch,
			primaryBranch: base.primaryBranch,
			primaryRef: base.primaryRef,
			isOnPrimary: base.isOnPrimary,
			hasUpstream: base.hasUpstream,
			mergedIntoPrimary: base.mergedIntoPrimary,
			status: [], // multi-repo mode suppresses the flat list; per-repo sections are authoritative
			ahead,
			behind,
			aheadOfPrimary: sum(r => r.aheadOfPrimary),
			behindPrimary: sum(r => r.behindPrimary),
			insertionsVsPrimary,
			deletionsVsPrimary,
			clean: repoResults.every(r => r.clean),
			unpushed: repoResults.some(r => r.unpushed),
			summary: `${repoResults.length} repos`,
			untrackedIncluded: sessUntracked,
		};
	}

	const remotePublication = sessionGitStatusRemotePublication(sessionManager, id, session, aggregate.branch);
	const shapedAggregate = remotePublication ? { ...aggregate, remotePublication } : aggregate;
	json({ ...shapedAggregate, aggregate: shapedAggregate, repos });

	// Auto-push only when the root container IS a git repo. Session branches
	// are published at worktree-claim time, so skipping container auto-push
	// for a true (non-git-container) polyrepo is fine. Local-only sessions are
	// explicitly durable via their local worktree and must not publish just
	// because status was queried.
	const publishDecision = sessionGitStatusAutoPublishDecision(result, remotePublication);
	if (publishDecision && !shouldSkipRemotePush()) {
		publishCurrentBranchToOrigin(cwd, publishDecision.branch, {
			containerId: cid,
			setUpstream: publishDecision.setUpstream,
		}).catch(() => {});
	}
	return;
}

// GET /api/sessions/:id/git-diff — unified diff for session working directory
async function handleSessionGitDiff(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { isHeadquartersSession, json, jsonError, sessionGitUnavailablePayload, sessionManager, url } = ctx;
	const id = params.id;
	const session = sessionManager.getSession(id);
	if (!session) { json({ error: "Session not found" }, 404); return; }
	if (isHeadquartersSession(session)) { json(sessionGitUnavailablePayload(session, "Git diff"), 409); return; }
	const cwd = session.cwd;
	const cid = session.sandboxed ? session.containerId : undefined;
	if (!cid && !fs.existsSync(cwd)) { json({ error: "Working directory not found" }, 404); return; }
	const file = url.searchParams.get("file") || undefined;
	const commit = url.searchParams.get("commit") || undefined;
	// Per-repo diff routing (multi-repo sessions). `session.repoWorktrees` is
	// an array; resolve the requested repo's worktree path, else fall back to cwd.
	const repoParam = url.searchParams.get("repo") || undefined;
	let diffCwd = cwd;
	if (repoParam && repoParam !== ".") {
		const entry = session.repoWorktrees?.find(w => w.repo === repoParam);
		if (entry) diffCwd = entry.worktreePath;
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

// GET /api/sessions/:id/commits — unpushed commits for session
async function handleSessionCommits(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { isHeadquartersSession, json, sessionGitUnavailablePayload, sessionManager, url } = ctx;
	const id = params.id;
	const session = sessionManager.getSession(id);
	if (!session) { json({ error: 'Session not found' }, 404); return; }
	if (isHeadquartersSession(session)) { json(sessionGitUnavailablePayload(session, "Commit history"), 409); return; }
	const cwd = session.cwd;
	const cid = session.sandboxed ? session.containerId : undefined;
	if (!cid && !fs.existsSync(cwd)) { json({ commits: [] }); return; }
	try {
		let branch = '';
		try { branch = await execGit('git rev-parse --abbrev-ref HEAD', cwd, 5000, cid); }
		catch { json({ commits: [] }); return; }

		let hasUpstream = false;
		try { await execGit(`git rev-parse --abbrev-ref ${branch}@{u}`, cwd, 5000, cid); hasUpstream = true; } catch {}

		const limit = 50;
		const direction = url.searchParams.get('direction'); // 'behind' to show incoming commits
		const vs = url.searchParams.get('vs'); // 'primary' to compare vs origin/master
		let rangeSpec: string;
		if (vs === 'primary') {
			// Compare against origin/<primary>
			let primaryBranch = 'master';
			try {
				const remoteHead = await execGit('git symbolic-ref refs/remotes/origin/HEAD', cwd, 5000, cid);
				primaryBranch = remoteHead.replace('refs/remotes/origin/', '');
			} catch {
				try { await execGit('git rev-parse --verify refs/heads/master', cwd, 5000, cid); primaryBranch = 'master'; }
				catch { try { await execGit('git rev-parse --verify refs/heads/main', cwd, 5000, cid); primaryBranch = 'main'; } catch {} }
			}
			let primaryRef = primaryBranch;
			try { await execGit(`git rev-parse --verify origin/${primaryBranch}`, cwd, 5000, cid); primaryRef = `origin/${primaryBranch}`; } catch {}
			rangeSpec = direction === 'behind' ? `HEAD..${primaryRef}` : `${primaryRef}..HEAD`;
		} else {
			rangeSpec = direction === 'behind' && hasUpstream
				? 'HEAD..@{u}'
				: hasUpstream ? '@{u}..HEAD' : `-${limit} HEAD`;
		}

		const out = await execGit(`git log --format="${COMMIT_LOG_FORMAT}" --shortstat ${rangeSpec}`, cwd, 10000, cid);
		const commits = await attachCommitFiles(parseCommitLogWithShortstat(out), cwd, cid);

		json({ commits });
	} catch (e: any) {
		json({ error: 'Failed to read git log', detail: e.message }, 500);
	}
	return;
}

// GET /api/sessions/:id/pr-status — PR status for session's branch
async function handleSessionPrStatus(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const {
		getGoalAcrossProjects,
		isHeadquartersSession,
		json,
		noContent,
		prStatusStore,
		sessionGitUnavailablePayload,
		sessionManager,
		url,
	} = ctx;
	const id = params.id;
	const session = sessionManager.getSession(id);
	if (!session) { json({ error: "Session not found" }, 404); return; }
	if (isHeadquartersSession(session)) { json(sessionGitUnavailablePayload(session, "PR status"), 409); return; }
	const cwd = session.cwd;
	const cid = session.sandboxed ? session.containerId : undefined;
	if (!cid && !fs.existsSync(cwd)) { json({ error: "Working directory not found" }, 404); return; }
	// Use goal branch if available so we find the right PR even if the worktree HEAD diverged.
	// For non-goal sessions, fall back to the session's persisted branch — needed for sandbox
	// sessions where the host worktree may not have the right branch checked out.
	const goalBranch = session.goalId ? getGoalAcrossProjects(session.goalId)?.branch : undefined;
	let sessionBranch = goalBranch || sessionManager.getPersistedSession(id)?.branch;
	// For sandboxed sessions, the persisted branch may not match the actual container branch
	// (e.g. gateway assigns a different worktree name). Detect the real branch from the container.
	if (cid && cwd) {
		try {
			const actualBranch = await execGit("git rev-parse --abbrev-ref HEAD", cwd, 5000, cid);
			if (actualBranch && actualBranch !== "HEAD") sessionBranch = actualBranch;
		} catch { /* fall back to persisted branch */ }
	}
	// PR status uses `gh` CLI which needs host filesystem — use worktreePath for sandboxed sessions
	const prCwd = cid ? (session.worktreePath || process.cwd()) : cwd;
	const optional = url.searchParams.get("optional") === "1";
	const pr = await getCachedPrStatus(prCwd, sessionBranch, process.cwd());
	if (pr) {
		const goalId = session.goalId;
		if (goalId) prStatusStore.set(goalId, pr);
		json(pr);
	} else if (optional) { noContent(); } else { json({ error: "No PR found" }, 404); }
	return;
}

export function registerSessionGitReadRoutes(table: RouteTable<CoreRouteCtx>): void {
	table.register("GET", "/api/sessions/:id/git-status", handleSessionGitStatus);
	table.register("GET", "/api/sessions/:id/git-diff", handleSessionGitDiff);
	table.register("GET", "/api/sessions/:id/commits", handleSessionCommits);
	table.register("GET", "/api/sessions/:id/pr-status", handleSessionPrStatus);
}
