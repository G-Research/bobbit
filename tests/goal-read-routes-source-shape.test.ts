import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = process.cwd();
const ROUTE_FILE = path.join(REPO_ROOT, "src/server/routes/goal-read-routes.ts");
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

describe("goal read routes source shape", () => {
	assertBlock(
		"GET /api/goals/:goalId/descendants",
		"// GET /api/goals/:goalId/descendants — live + archived descendants for the Plan tab.",
		"// GET /api/goals/:goalId/tree-cost — cost rollup across descendant tree (live + archived).",
		[
			"Feeds dashboardDescendants in goal-dashboard.ts so archived children render in the DAG",
			"const allGoals = ctx.goalStore.getAll();",
			"enrichDescendantsForPlan(collectDescendants(goalId, allGoals), {",
			"hasActiveVerification: (gid) => verificationHarness.getActiveVerifications(gid).length > 0",
		],
	);

	assertBlock(
		"GET /api/goals/:goalId/tree-cost",
		"// GET /api/goals/:goalId/tree-cost — cost rollup across descendant tree (live + archived).",
		"// GET /api/goals",
		[
			"Dashboard tree-cost is intentionally rooted at the REQUESTED goal",
			"computeTreeCost(",
			"costTracker.getUnattributableLegacyCostWithMetadata()",
			"goalId: \"__unattributable__\"",
		],
	);

	assertBlock(
		"GET /api/goals",
		"// GET /api/goals",
		"// GET /api/goals/:goalId/tasks — list tasks for a goal",
		[
			"// Paginated archived goals — aggregate across all projects",
			"archivedGoalMatchesQuery(g, sessionsForGoalQuery, archivedQuery)",
			"const delegateEnriched = bfsEnrichArchived(affiliatedSessions.map(s => s.id), allArchivedForGoalsBfs);",
			"json({ generation: currentGen, changed: false });",
		],
	);

	assertBlock(
		"GET /api/goals/:goalId/tasks",
		"// GET /api/goals/:goalId/tasks — list tasks for a goal",
		"// POST /api/goals/:goalId/tasks — create a task",
		[
			"getTasksForGoal(params.goalId)",
			"assignedSessionId: t.assignedSessionId",
			"workflowGateId: t.workflowGateId",
			"dependsOn: t.dependsOn || []",
		],
	);

	assertBlock(
		"POST /api/goals/:goalId/tasks",
		"// POST /api/goals/:goalId/tasks — create a task",
		"// GET /api/goals/:goalId/gates — list gates for a goal",
		[
			"if (goal.archived) { json({ error: \"Goal is archived\" }, 409); return; }",
			"json({ error: \"Missing title\" }, 400);",
			"workflowGateId: typeof body.workflowGateId === \"string\" ? body.workflowGateId : undefined",
			"inputGateIds: Array.isArray(body.inputGateIds) ? body.inputGateIds as string[] : undefined",
		],
	);

	assertBlock(
		"GET /api/goals/:goalId/gates",
		"// GET /api/goals/:goalId/gates — list gates for a goal",
		"// GET /api/goals/:goalId/gates/:gateId — gate detail",
		[
			"// Enrich with workflow gate definitions",
			"// Surface human-bypass audit fields as canonical top-level fields so the",
			"buildGateStatusSummary({",
			"verificationHarness.getActiveVerifications(goalId)",
		],
	);

	assertBlock(
		"GET /api/goals/:goalId/gates/:gateId",
		"// GET /api/goals/:goalId/gates/:gateId — gate detail",
		"// GET /api/goals/:goalId/gates/:gateId/signals — signal history",
		[
			"const slim: Record<string, unknown> = {",
			"buildGateVerificationSnapshot({",
			"selectionOptions: { implicitDefault: true }",
			"json({ ...gate, name: def?.name, dependsOn: def?.dependsOn, content: def?.content, injectDownstream: def?.injectDownstream });",
		],
	);

	assertBlock(
		"GET /api/goals/:goalId/gates/:gateId/signals",
		"// GET /api/goals/:goalId/gates/:gateId/signals — signal history",
		"// GET /api/goals/:goalId/verifications/active — get in-flight verification state",
		[
			"const gateSignalsCtx = projectContextManager.getContextForGoal(goalId);",
			"if (!gate) { json({ error: \"Gate not found\" }, 404); return; }",
			"json({ signals: gate.signals });",
		],
	);

	assertBlock(
		"GET /api/goals/:goalId/verifications/active",
		"// GET /api/goals/:goalId/verifications/active — get in-flight verification state",
		"// GET /api/goals/:goalId/gates/:gateId/content — gate content",
		[
			"const active = verificationHarness.getActiveVerifications(goalId);",
			"json({ verifications: active });",
		],
	);

	assertBlock(
		"GET /api/goals/:goalId/gates/:gateId/content",
		"// GET /api/goals/:goalId/gates/:gateId/content — gate content",
		"export function registerGoalReadRoutes",
		[
			"const gateContentCtx = projectContextManager.getContextForGoal(goalId);",
			"if (!gate) { json({ error: \"Gate not found\" }, 404); return; }",
			"json({ content: gate.currentContent, version: gate.currentContentVersion });",
		],
	);
});
