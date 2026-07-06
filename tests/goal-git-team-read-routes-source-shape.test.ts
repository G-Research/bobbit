import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = process.cwd();
const ROUTE_FILE = path.join(REPO_ROOT, "src/server/routes/goal-git-team-read-routes.ts");
const SOURCE = fs.readFileSync(ROUTE_FILE, "utf-8");

function sliceBetween(start: string, end: string): string {
	const from = SOURCE.indexOf(start);
	assert.notEqual(from, -1, `missing start marker: ${start}`);
	const to = SOURCE.indexOf(end, from + start.length);
	assert.notEqual(to, -1, `missing end marker after ${start}: ${end}`);
	return SOURCE.slice(from, to);
}

function assertBlock(name: string, start: string, end: string, fragments: string[]): void {
	it(`${name} preserves migrated source shape`, () => {
		const block = sliceBetween(start, end);
		assert.ok(block.includes(start), `missing route/comment marker for ${name}: ${start}`);
		for (const fragment of fragments) {
			assert.ok(block.includes(fragment), `missing ${name} body fragment: ${fragment}`);
		}
	});
}

describe("goal git/team read routes source shape", () => {
	assertBlock(
		"GET /api/goals/:id/commits",
		"// GET /api/goals/:id/commits — get commit history for goal branch",
		"// GET /api/goals/:id/git-status — git status for goal worktree (async)",
		[
			"if (!hasGoalGitWorktree(goal)) { json(goalGitUnavailablePayload(goal, \"Commit history\"), 409); return; }",
			"// Validate branch name to prevent injection",
			"const limit = Math.min(Math.max(parseInt(url.searchParams.get(\"limit\") || \"20\", 10) || 20, 1), 100);",
			"const out = await execGit(`git log --format=\"${COMMIT_LOG_FORMAT}\" --shortstat ${rangeSpec}`, goal.cwd);",
			"json({ error: \"Failed to read git log\", detail: e.message }, 500);",
		],
	);

	assertBlock(
		"GET /api/goals/:id/git-status",
		"// GET /api/goals/:id/git-status — git status for goal worktree (async)",
		"// GET /api/goals/:id/git-diff — unified diff for goal worktree",
		[
			"// Resolve container ID for sandboxed goals + project `base_ref` config",
			"const goalUntracked = url.searchParams.get('untracked') === '1';",
			"try { await execGit('git fetch --quiet', cwd, 15000, cid); } catch { /* best-effort */ }",
			"// Multi-repo aware envelope: include `repos` map + `aggregate` for back-compat.",
			"json({ ...result, aggregate: result, repos: { \".\": result } });",
		],
	);

	assertBlock(
		"GET /api/goals/:id/git-diff",
		"// GET /api/goals/:id/git-diff — unified diff for goal worktree",
		"// GET /api/goals/:id/pr-status — PR status for goal branch (async + cached)",
		[
			"// Resolve container ID for sandboxed goals",
			"const repoParam = url.searchParams.get(\"repo\") || undefined;",
			"if (repoParam && goalRepoWorktrees && goalRepoWorktrees[repoParam]) {",
			"if (err.message === \"INVALID_COMMIT\") { json({ error: \"Invalid commit\" }, 400); return; }",
		],
	);

	assertBlock(
		"GET /api/goals/:id/pr-status",
		"// GET /api/goals/:id/pr-status — PR status for goal branch (async + cached)",
		"// GET /api/goals/:id/github-link — PR URL or sanitized GitHub branch fallback",
		[
			"if (!hasGoalGitWorktree(goal)) { json(goalGitUnavailablePayload(goal, \"PR status\"), 409); return; }",
			"// Pass process.cwd() as fallback — if the goal's worktree has a broken git link",
			"const optional = url.searchParams.get(\"optional\") === \"1\";",
			"if (pr) { prStatusStore.set(goalId, pr); json(pr); } else if (optional) { noContent(); } else { json({ error: \"No PR found\" }, 404); }",
		],
	);

	assertBlock(
		"GET /api/goals/:id/github-link",
		"// GET /api/goals/:id/github-link — PR URL or sanitized GitHub branch fallback",
		"// POST /api/goals/:id/pr-cache-bust — invalidate PR cache for a goal",
		[
			"json({ available: false, reason: \"goal-not-found\" } satisfies GoalGithubLinkResponse);",
			"json({ available: false, reason: \"no-worktree\", message: noWorktreeGoalGitMessage(goal) } satisfies GoalGithubLinkResponse);",
			"const branchUrl = buildGithubBranchUrl(stripTokenFromGitUrl(stdout.trim()), goal.branch);",
			"json({ available: false, reason: \"no-github-remote\" } satisfies GoalGithubLinkResponse);",
		],
	);

	assertBlock(
		"POST /api/goals/:id/pr-cache-bust",
		"// POST /api/goals/:id/pr-cache-bust — invalidate PR cache for a goal",
		"// GET /api/goals/:id/team — get team state",
		[
			"const cwd = goal.cwd;",
			"_prCache.delete(cwd);",
			"if (goal.branch) _prCache.delete(`${cwd}::${goal.branch}`);",
			"broadcastToAll({ type: \"pr_status_changed\", goalId });",
		],
	);

	assertBlock(
		"GET /api/goals/:id/team",
		"// GET /api/goals/:id/team — get team state",
		"// GET /api/goals/:id/team/agents — list agents for a team goal",
		[
			"const state = teamManager.getTeamState(goalId);",
			"// S1: `teamLeadSessionId` is intentionally exposed here. It is NO LONGER",
			"// an authorization credential — orchestration/operator Children authz",
			"// team-lead session id grants nothing without the secret. Consumers rely",
		],
	);

	assertBlock(
		"GET /api/goals/:id/team/agents",
		"// GET /api/goals/:id/team/agents — list agents for a team goal",
		"export function registerGoalGitTeamReadRoutes",
		[
			"// Include archived (dismissed) agents when ?include=archived is set",
			"const liveSessionIds = new Set(agents.map((a: any) => a.sessionId));",
			".filter(s => s.teamGoalId === goalId && !liveSessionIds.has(s.id))",
			"delegateOf: s.delegateOf,",
			"json({ agents: [...agents, ...archivedAgents] });",
		],
	);

	assertBlock(
		"registerGoalGitTeamReadRoutes",
		"export function registerGoalGitTeamReadRoutes",
		"}",
		[
			"table.register(\"GET\", \"/api/goals/:goalId/commits\", handleGoalCommits);",
			"table.register(\"GET\", \"/api/goals/:goalId/git-status\", handleGoalGitStatus);",
			"table.register(\"GET\", \"/api/goals/:goalId/git-diff\", handleGoalGitDiff);",
			"table.register(\"GET\", \"/api/goals/:goalId/pr-status\", handleGoalPrStatus);",
			"table.register(\"GET\", \"/api/goals/:goalId/github-link\", handleGoalGithubLink);",
			"table.register(\"POST\", \"/api/goals/:goalId/pr-cache-bust\", handleGoalPrCacheBust);",
			"table.register(\"GET\", \"/api/goals/:goalId/team\", handleGoalTeamState);",
			"table.register(\"GET\", \"/api/goals/:goalId/swarm\", handleGoalTeamState);",
			"table.register(\"GET\", \"/api/goals/:goalId/team/agents\", handleGoalTeamAgents);",
			"table.register(\"GET\", \"/api/goals/:goalId/swarm/agents\", handleGoalTeamAgents);",
		],
	);
});
