import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = process.cwd();
const ROUTE_FILE = path.join(REPO_ROOT, "src/server/routes/goal-gate-mutation-routes.ts");
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

describe("goal gate mutation routes source shape", () => {
	assertBlock(
		"POST /api/goals/:goalId/gates/:gateId/reset",
		"// POST /api/goals/:goalId/gates/:gateId/reset — reset a gate and downstream dependents",
		"// POST /api/goals/:goalId/gates/:gateId/bypass — human-only gate bypass.",
		[
			"json({ error: \"Forbidden: sandbox token cannot reset gates\" }, 403);",
			"const affectedGateIds = getGateAndTransitiveDependents(goal.workflow, gateId);",
			"await verificationHarness.cancelStaleVerificationsForGates(goalId, affectedGateIds);",
			"resetResult = gateStore.resetGateAndDependents(goalId, gateId, goal.workflow);",
			"type: \"gate_reset\",",
			"\"Invalidated dependent gates:\"",
			"\"Downstream work may have relied on outputs from the reset gate. Please revisit dependent implementation, review, or verification work before continuing.\"",
			"teamLeadNotified,",
		],
	);

	assertBlock(
		"POST /api/goals/:goalId/gates/:gateId/bypass",
		"// POST /api/goals/:goalId/gates/:gateId/bypass — human-only gate bypass.",
		"// POST /api/goals/:goalId/gates/:gateId/cancel-verification — cancel a stuck verification",
		[
			"// NOT advertised to agents: no MCP tool, no prompt/doc mention. The",
			"// isInitiatedByHuman guard is the runtime backstop. Modeled on the reset",
			"json({ error: \"Forbidden: sandbox token cannot bypass gates\" }, 403);",
			"if (bypassBody?.isInitiatedByHuman !== true) {",
			"\"This method is currently intended for human use only. Bypassing a gate as an agent is not acting in the best interest of the outcome.\"",
			"const bypassSignal = gateStore.bypassGate(goalId, gateId, { whyBypassed, whoAmI });",
			"`This gate was forced past verification by a human overseer (${whoAmI}).`,",
			"\"The bypassed gate now counts as satisfied for dependency ordering, but the goal still requires explicit human confirmation before it can be completed.\"",
		],
	);

	assertBlock(
		"POST /api/goals/:goalId/gates/:gateId/cancel-verification",
		"// POST /api/goals/:goalId/gates/:gateId/cancel-verification — cancel a stuck verification",
		"// POST /api/goals/:goalId/gates/:gateId/signoff — resolve a parked human-signoff step.",
		[
			"const activeVers = verificationHarness.getActiveVerifications(goalId);",
			"const running = activeVers.find(v => v.gateId === gateId && v.overallStatus === \"running\");",
			"json({ cancelled: false, message: \"No running verification to cancel\" }, 200);",
			"await verificationHarness.cancelStaleVerifications(goalId, gateId);",
			"// Explicit user cancel: also update gate status to \"failed\"",
			"if (cancelCtx) cancelCtx.gateStore.updateGateStatus(goalId, gateId, \"failed\");",
		],
	);

	assertBlock(
		"POST /api/goals/:goalId/gates/:gateId/signoff",
		"// POST /api/goals/:goalId/gates/:gateId/signoff — resolve a parked human-signoff step.",
		"// GET /api/goals/:goalId/workflow-context/:gateId — get dependency context for a gate",
		[
			"// Body: { signalId, stepName, decision: \"pass\" | \"fail\", feedback? }.",
			"// Idempotent — already-resolved steps respond 409 with the current step state.",
			"json({ error: \"Invalid body: { signalId, stepName, decision: 'pass'|'fail', feedback? }\" }, 400);",
			"// No in-flight verification — the signal may have already completed.",
			"// Distinguish \"signal genuinely unknown\" (404) from \"signal exists but",
			"json({ error: \"The specified step is not a human-signoff step\" }, 409);",
			"json({ error: \"step is no longer awaiting human input\" }, 409);",
			"const resolved = verificationHarness.resolveSignoff(body.signalId, body.stepName, {",
			"// Raced with cancellation or a prior resolve — idempotent surface.",
		],
	);

	assertBlock(
		"GET /api/goals/:goalId/workflow-context/:gateId",
		"// GET /api/goals/:goalId/workflow-context/:gateId — get dependency context for a gate",
		"export function registerGoalGateMutationRoutes",
		[
			"if (!goal.workflow) { json({ error: \"Goal has no workflow\" }, 404); return; }",
			"const gateDef = goal.workflow.gates.find(g => g.id === gateId);",
			"if (!gateDef) { json({ error: \"Gate not found\" }, 404); return; }",
			"const context = teamManager.buildDependencyContext(goalId, gateId);",
			"json({ context, gate: gateDef });",
		],
	);

	assertBlock(
		"registerGoalGateMutationRoutes",
		"export function registerGoalGateMutationRoutes",
		"}",
		[
			"table.register(\"POST\", \"/api/goals/:goalId/gates/:gateId/reset\", handleGoalGateReset);",
			"table.register(\"POST\", \"/api/goals/:goalId/gates/:gateId/bypass\", handleGoalGateBypass);",
			"table.register(\"POST\", \"/api/goals/:goalId/gates/:gateId/signoff\", handleGoalGateSignoff);",
			"table.register(\"POST\", \"/api/goals/:goalId/gates/:gateId/cancel-verification\", handleGoalGateCancelVerification);",
			"table.register(\"GET\", \"/api/goals/:goalId/workflow-context/:gateId\", handleGoalWorkflowContext);",
		],
	);
});
