import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = process.cwd();
const ROUTE_FILE = path.join(REPO_ROOT, "src/server/routes/goal-team-mutation-routes.ts");
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

describe("goal team mutation routes source shape", () => {
	assertBlock(
		"own-child fallback helpers",
		"// Finding #6 fallback: a team-lead's `team_delegate(non_blocking)` child is NOT a",
		"// POST /api/goals/:id/team/start — start a team for a goal",
		[
			"// H3 authz — the own-child fallback MUST enforce owner→caller authz, exactly",
			"// like /orchestrate/* (server.ts ~9310). The goal /team/* routes accept a",
			"const authenticCaller = resolveAuthenticCallerFromSessionSecret(ctx);",
			"if (!authenticCaller || authenticCaller !== owner) return { denied: true };",
			"if (err.code === \"NOT_STREAMING\") return 409;",
		],
	);

	assertBlock(
		"POST /api/goals/:id/team/start",
		"// POST /api/goals/:id/team/start — start a team for a goal",
		"// POST /api/goals/:id/team/spawn — spawn a role agent",
		[
			"// Guard: goal spec must be set before starting the team.",
			"if (!trimmedSpec || trimmedSpec.length < 20 || trimmedSpec.toLowerCase() === \"placeholder\") {",
			"json({ error: \"Goal spec must be set before starting the team. Update via PUT /api/goals/:id.\", code: \"SPEC_REQUIRED\" }, 400);",
			"const session = await teamManager.startTeam(goalId);",
		],
	);

	assertBlock(
		"POST /api/goals/:id/team/spawn",
		"// POST /api/goals/:id/team/spawn — spawn a role agent",
		"// POST /api/goals/:id/team/dismiss — dismiss a role agent",
		[
			"// Guard: reject spawn if goal is archived",
			"// Pause-cascade: refuse to spawn role agents on a paused goal.",
			"if (spawnGoal && spawnGoal.setupStatus !== \"ready\") {",
			"const result = await teamManager.spawnRole(goalId, body.role, body.task, spawnOpts);",
			"if (err instanceof GateDependencyError) {",
			"} else if (err instanceof GoalPausedError) {",
		],
	);

	assertBlock(
		"POST /api/goals/:id/team/dismiss",
		"// POST /api/goals/:id/team/dismiss — dismiss a role agent",
		"// POST /api/goals/:id/pr-merge — merge PR for goal branch",
		[
			"// Own-child fallback: dismissRole only knows goal team members; a team-lead's",
			"const authz = authorizeChildrenMutation({",
			"mutationClass: \"orchestration\",",
			"authenticCallerSessionId: resolveAuthenticCallerFromSessionSecret(ctx),",
			"denyDismissNotOwned(ctx, body.sessionId);",
			"const result = await teamManager.dismissRoleForGoal(goalId, body.sessionId);",
		],
	);

	assertBlock(
		"POST /api/goals/:id/pr-merge",
		"// POST /api/goals/:id/pr-merge — merge PR for goal branch",
		"// POST /api/goals/:id/team/steer — steer a team agent mid-turn",
		[
			"if (!hasGoalGitWorktree(goal)) { json(goalGitUnavailablePayload(goal, \"PR merge\"), 409); return; }",
			"const method = body?.method ?? \"squash\";",
			"if (![\"merge\", \"squash\", \"rebase\"].includes(method)) {",
			"json({ error: \"Invalid merge method. Must be merge, squash, or rebase.\" }, 400);",
			"await execFileAsync(\"gh\", buildGhPrMergeArgs(resolvedGoalBranch, method, body?.admin), { cwd, encoding: \"utf-8\", timeout: 30000 });",
		],
	);

	assertBlock(
		"POST /api/goals/:id/team/steer",
		"// POST /api/goals/:id/team/steer — steer a team agent mid-turn",
		"// POST /api/goals/:id/team/abort — force-abort a stuck team agent",
		[
			"if (!body?.sessionId || !body?.message) {",
			"// Validate target is a team agent",
			"if (\"denied\" in ownerResult) { denyOwnChild(ctx); return; }",
			"json({ error: \"Agent is not currently streaming — use team/prompt instead\" }, 409);",
			"await sessionManager.deliverLiveSteer(session.id, body.message);",
		],
	);

	assertBlock(
		"POST /api/goals/:id/team/abort",
		"// POST /api/goals/:id/team/abort — force-abort a stuck team agent",
		"// POST /api/goals/:id/team/prompt — prompt or steer a team agent, direct-child lead, or owned helper.",
		[
			"if (!body?.sessionId) {",
			"// Validate target is a team agent",
			"await orchestrationCore.abort(ownerResult.owner, body.sessionId);",
			"await sessionManager.forceAbort(body.sessionId);",
			"json({ ok: true, status: afterSession?.status || \"idle\" });",
		],
	);

	assertBlock(
		"POST /api/goals/:id/team/prompt",
		"// POST /api/goals/:id/team/prompt — prompt or steer a team agent, direct-child lead, or owned helper.",
		"// POST /api/goals/:id/team/complete — complete a team (dismiss agents, keep team lead)",
		[
			"mode = parseSessionPromptMode(body.mode, \"steer\");",
			"// Validate target is a team agent OR a direct-child team-lead OR an owned helper child.",
			"code: \"NOT_TEAM_MEMBER_OR_DIRECT_CHILD\",",
			"// Enforce gate dependency check for team/prompt.",
			"const depError = checkGateDependencies(wfGateId, goal.workflow.gates, gateStates);",
			"message = ctx + \"\\n\\n---\\n\\n\" + message;",
			"await deliverSessionPrompt({",
		],
	);

	assertBlock(
		"POST /api/goals/:id/team/complete",
		"// POST /api/goals/:id/team/complete — complete a team (dismiss agents, keep team lead)",
		"// POST /api/goals/:id/team/teardown — fully tear down a team (dismiss agents + terminate team lead).",
		[
			"// Guard: a goal cannot be marked complete while it still has unresolved",
			"const unresolvedChildIds = walkGoalSubtree(goalId, completeAllGoals, { includeRoot: false, includeArchived: false })",
			"code: \"UNRESOLVED_CHILDREN\",",
			"// Bypassed-gate confirmation is a HUMAN-only override. A sandbox-scoped",
			"json({ error: \"Forbidden: sandbox token cannot confirm completion of bypassed gates\" }, 403);",
			"await teamManager.completeTeam(goalId, { allowBypassedGates: confirmBypassedGates });",
		],
	);

	assertBlock(
		"POST /api/goals/:id/team/teardown",
		"// POST /api/goals/:id/team/teardown — fully tear down a team (dismiss agents + terminate team lead).",
		"export function registerGoalTeamMutationRoutes",
		[
			"// Cascade required — mirror of `tests/api-team-teardown-cascade.test.ts::teardownRoute`.",
			"json({ error: \"cascade=true|false query parameter is required\", code: \"CASCADE_REQUIRED\" }, 422);",
			"// cascade=false + live descendant teams → 409 HAS_DESCENDANT_TEAMS.",
			"code: \"HAS_DESCENDANT_TEAMS\",",
			"// Bottom-up: children torn down before parents. Skip archived",
			"await teamManager.teardownTeam(g.id);",
		],
	);

	assertBlock(
		"registerGoalTeamMutationRoutes",
		"export function registerGoalTeamMutationRoutes",
		"}",
		[
			"table.register(\"POST\", \"/api/goals/:goalId/team/start\", handleGoalTeamStart);",
			"table.register(\"POST\", \"/api/goals/:goalId/swarm/start\", handleGoalTeamStart);",
			"table.register(\"POST\", \"/api/goals/:goalId/team/spawn\", handleGoalTeamSpawn);",
			"table.register(\"POST\", \"/api/goals/:goalId/swarm/spawn\", handleGoalTeamSpawn);",
			"table.register(\"POST\", \"/api/goals/:goalId/team/dismiss\", handleGoalTeamDismiss);",
			"table.register(\"POST\", \"/api/goals/:goalId/swarm/dismiss\", handleGoalTeamDismiss);",
			"table.register(\"POST\", \"/api/goals/:goalId/pr-merge\", handleGoalPrMerge);",
			"table.register(\"POST\", \"/api/goals/:goalId/team/steer\", handleGoalTeamSteer);",
			"table.register(\"POST\", \"/api/goals/:goalId/swarm/steer\", handleGoalTeamSteer);",
			"table.register(\"POST\", \"/api/goals/:goalId/team/abort\", handleGoalTeamAbort);",
			"table.register(\"POST\", \"/api/goals/:goalId/swarm/abort\", handleGoalTeamAbort);",
			"table.register(\"POST\", \"/api/goals/:goalId/team/prompt\", handleGoalTeamPrompt);",
			"table.register(\"POST\", \"/api/goals/:goalId/swarm/prompt\", handleGoalTeamPrompt);",
			"table.register(\"POST\", \"/api/goals/:goalId/team/complete\", handleGoalTeamComplete);",
			"table.register(\"POST\", \"/api/goals/:goalId/swarm/complete\", handleGoalTeamComplete);",
			"table.register(\"POST\", \"/api/goals/:goalId/team/teardown\", handleGoalTeamTeardown);",
			"table.register(\"POST\", \"/api/goals/:goalId/swarm/teardown\", handleGoalTeamTeardown);",
		],
	);
});
