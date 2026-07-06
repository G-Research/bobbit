import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = process.cwd();
const ROUTE_FILE = path.join(REPO_ROOT, "src/server/routes/goal-crud-routes.ts");
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

describe("goal CRUD routes source shape", () => {
	assertBlock(
		"POST /api/goals",
		"// POST /api/goals",
		"// GET /api/goals/:id",
		[
			"const resolved = resolveProjectForRequest(projectRegistry, { projectId: body.projectId });",
			"// S1 SECURITY: creating a child via `POST /api/goals` with a",
			"mutationClass: \"operator\",",
			"isHumanOperator: cookieTryAuth(req, cookieStore!),",
			"// Derive the AUTHENTIC caller from the per-session secret,\n\t\t\t\t\t// never the forgeable public spawning-session header.",
			"//   - Explicit body values can only tighten/disable, never exceed the ceiling.",
			"const nestingPrefs = readSubgoalNestingPrefs((k) => preferencesStore.get(k));",
			"const outcome = verificationHarness.requestChildStart(goal.id);",
		],
	);

	assertBlock(
		"GET /api/goals/:id",
		"// GET /api/goals/:id",
		"// PUT /api/goals/:id",
		[
			"const goal = getGoalAcrossProjects(id);",
			"if (!goal) { json({ error: \"Goal not found\" }, 404); return; }",
			"json(goal);",
		],
	);

	assertBlock(
		"PUT /api/goals/:id",
		"// PUT /api/goals/:id",
		"export function registerGoalCrudRoutes",
		[
			"if (putGoal?.archived) { json({ error: \"Goal is archived\" }, 409); return; }",
			"// creation rather than forwarding body.cwd unchecked.",
			"validateExecutionCwd(projectRegistry, projectContextManager, goalProjectId, body.cwd, { kind: \"goal\", goalId: id });",
			"// Spec-edit notification: emit goal_spec_changed WS event and nudge the team lead.",
			"type: \"goal_spec_changed\",",
			"teamManager.notifyTeamLeadOfSpecChange(id, prevSpec.length, (body.spec as string).length);",
		],
	);

	assertBlock(
		"registerGoalCrudRoutes",
		"export function registerGoalCrudRoutes",
		"}",
		[
			"table.register(\"POST\", \"/api/goals\", handleGoalsCreate);",
			"table.register(\"GET\", \"/api/goals/:id\", handleGoalGet);",
			"table.register(\"PUT\", \"/api/goals/:id\", handleGoalPut);",
		],
	);
});
