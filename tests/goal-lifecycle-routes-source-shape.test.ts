import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = process.cwd();
const ROUTE_FILE = path.join(REPO_ROOT, "src/server/routes/goal-lifecycle-routes.ts");
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

describe("goal lifecycle routes source shape", () => {
	assertBlock(
		"POST /api/goals/:id/retry-setup",
		"// POST /api/goals/:id/retry-setup",
		"/**\n * Archive a goal (root or cascade).",
		[
			"const retryGoalManager = getGoalManagerForGoal(goalId);",
			"const ok = retryGoalManager.retrySetup(goalId);",
			"// Fire-and-forget async worktree setup (and optionally start team)",
			"retryGoalManager.setupWorktreeAndStartTeam(goalId, () => teamManager.startTeam(goalId)).then(() => {",
			"broadcastToAll({ type: \"goal_setup_error\", goalId, error: String(err) });",
		],
	);

	assertBlock(
		"archiveGoalEndpoint",
		"/**\n * Archive a goal (root or cascade).",
		"// DELETE /api/goals/:parentId/archive-child/:childId",
		[
			"`DELETE /api/goals/:parentId/archive-child/:childId` route can\n * reuse the exact same cascade + mergedManually semantics after",
			"// `cascade` is REQUIRED — mirrors pause/resume/teardown. The UI is",
			"const mergedManually = url.searchParams.get(\"mergedManually\") === \"true\";",
			"await cleanupGateDiagnosticsForGoal(g.id, projectContextManager.getContextForGoal(g.id)?.stateDir);",
			"const swarmTerminalStatus = (g.state === \"complete\" || (mergedManually && g.id === id)) ? \"done\" : \"killed\";",
			"const result = await cascadeGoalSubtree(",
			"{ includeRoot: true, includeArchived: true },",
			"{ order: \"bottom-up\", apply: archiveOne },",
		],
	);

	assertBlock(
		"DELETE /api/goals/:parentId/archive-child/:childId",
		"// DELETE /api/goals/:parentId/archive-child/:childId",
		"// DELETE /api/goals/:id",
		[
			"// Pinned by tests/e2e/parent-scoped-archive-child.spec.ts.",
			"// Subgoals feature gate — archive-child is a Children mutation.",
			"// S1: archive-child is an OPERATOR Children verb (the web UI drives it),",
			"mutationClass: \"operator\",",
			"isHumanOperator: cookieTryAuth(req, cookieStore!),",
			"// S1: derive the AUTHENTIC caller from the per-session secret,\n\t\t\t// never the forgeable public spawning-session header.",
			"teamLeadSessionId: teamManager.getTeamState(parentId)?.teamLeadSessionId,",
			"// Security: target must be a DIRECT child of the parent. Reject",
			"code: \"NOT_DIRECT_CHILD\",",
			"// Cross-project guard — child must live in the same project context",
			"await archiveGoalEndpoint(routeCtx, childId);",
		],
	);

	assertBlock(
		"DELETE /api/goals/:id",
		"// DELETE /api/goals/:id",
		"export function registerGoalLifecycleRoutes",
		[
			"const id = params.id;",
			"await archiveGoalEndpoint(routeCtx, id);",
		],
	);

	assertBlock(
		"registerGoalLifecycleRoutes",
		"export function registerGoalLifecycleRoutes",
		"}",
		[
			"table.register(\"POST\", \"/api/goals/:id/retry-setup\", handleGoalRetrySetup);",
			"table.register(\"DELETE\", \"/api/goals/:parentId/archive-child/:childId\", handleGoalArchiveChild);",
			"table.register(\"DELETE\", \"/api/goals/:id\", handleGoalDelete);",
		],
	);
});
