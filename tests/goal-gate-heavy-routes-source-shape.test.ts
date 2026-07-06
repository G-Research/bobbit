import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = process.cwd();
const ROUTE_FILE = path.join(REPO_ROOT, "src/server/routes/goal-gate-heavy-routes.ts");
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

describe("goal gate heavy routes source shape", () => {
	assertBlock(
		"GET /api/goals/:goalId/gates/:gateId/inspect",
		"// GET /api/goals/:goalId/gates/:gateId/inspect — scoped gate data retrieval",
		"// POST /api/goals/:goalId/gates/:gateId/signal — signal a gate",
		[
			"selectionOptions = { ...parseGateInspectSelectionOptions(url.searchParams), includeDiagnostics: true };",
			"if (section === \"artifact\" && selectionOptions.mode === undefined) {",
			"const snapshot = buildGateVerificationSnapshot({",
			"activeVerification: verificationHarness.getActiveVerification(resolved.signal.id),",
			"if (err instanceof UnknownVerificationStepError) { json({ error: err.message }, 400); return; }",
			"const matches: Array<{ stepName: string; diagnostics: NonNullable<typeof candidateSteps[number][\"diagnostics\"]>; artifact: ReturnType<typeof resolveArtifactFromLookup> }> = [];",
			"validArtifacts: lookup.index.files.map(file => ({ id: file.id, relativePath: file.relativePath, retry: file.retry })),",
			"if (!isTextInspectableArtifact(match.artifact)) {",
			"text = stripPlaywrightErrorContextBoilerplate(text);",
			"const summaries = gate.signals.map((s, i) => ({",
			"signalsTruncated: signals.length < summaries.length,",
		],
	);

	assertBlock(
		"POST /api/goals/:goalId/gates/:gateId/signal",
		"// POST /api/goals/:goalId/gates/:gateId/signal — signal a gate",
		"export function registerGoalGateHeavyRoutes",
		[
			"// Pause-cascade: a paused goal must reject gate signals. This is the",
			"// Gov-2: an ACCEPTED signal of the `goal-plan` gate on a parent-workflow",
			"// a harmless no-op write. After this, GET /api/goals/:id/plan reports",
			"const freezeResult = computePlanFreezeUpdate(goal, gateId);",
			"gateSignalCtx.goalManager.getGoalStore().update(goalId, { workflow: freezeResult.workflow });",
			"commitSha = await execGitSafe(\"git rev-parse HEAD\", goal.cwd, \"unknown\");",
			"// Reject if verification is already running for this gate+commit",
			"// Check if sessions are actually alive — auto-cancel zombies",
			"console.warn(`[api] Rejecting gate_signal as duplicate: gate=${gateId} signalId=${runningDup.signalId} aliveCheck=true steps=${JSON.stringify(stepSummary)}`);",
			"// Manual reset preserves signal history for auditability, so this route-level",
			"&& !s.verification.steps.some(step => step.type === \"human-signoff\")",
			"// Create a signal record with cached results",
			"json({ signal: { id: cachedSignal.id, gateId, goalId, status: \"passed\", steps: verifySteps, cached: true } }, 201);",
			"// Cancel any in-flight verifications for the same gate BEFORE seeding",
			"const initialSteps = verificationHarness.beginVerification(signal as any, gateDef);",
			"gateStore.recordSignal(signal);",
			"// Broadcast verification started AFTER signal received — WS clients",
			"steps: (gateDef.verify || []).map((s: any) => ({ name: s.name, type: s.type, phase: s.phase ?? 0 })),",
			"const configuredBase = parseBaseRef(gateSignalCtx.projectConfigStore.get(\"base_ref\") || \"\");",
			"response.agentReminder = \"Gate signal accepted. Verification is running asynchronously. Do not poll with `gate_status` or `gate_inspect`. Go idle now and wait for the server to deliver verification results or further instructions.\";",
		],
	);

	assertBlock(
		"registerGoalGateHeavyRoutes",
		"export function registerGoalGateHeavyRoutes",
		"}",
		[
			"table.register(\"GET\", \"/api/goals/:goalId/gates/:gateId/inspect\", handleGoalGateInspect);",
			"table.register(\"POST\", \"/api/goals/:goalId/gates/:gateId/signal\", handleGoalGateSignal);",
		],
	);
});
