import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/verification-modal-output.spec.ts (v2-dom tier).
//
// This is a pure-logic port: the legacy file:// fixture inlined plain-JS mirrors
// of the buggy/fixed output-resolution helpers from GateVerificationLive._openModal(),
// goal-dashboard.ts's modal click handler, and _fetchAndReconcile()'s _stepOutputs
// seeding. The "buggy" variants only ever existed in the fixture (they are the
// pre-fix behaviour), so there is no real src symbol to import — we reproduce the
// exact same helpers here and assert the identical facts.
import { describe, expect, it } from "vitest";

// ── GateVerificationLive._openModal() output resolution ───────────────────────
// OLD (buggy): reads only the WS accumulator, ignoring steps[i].output.
function chatWidgetOpenModal(stepOutputs: Map<number, string>, _steps: any[], index: number): string {
	return stepOutputs.get(index) || "";
}
// FIXED: falls back to the API-reconciled steps[index].output.
function chatWidgetOpenModalFixed(stepOutputs: Map<number, string>, steps: any[], index: number): string {
	return stepOutputs.get(index) || (steps[index] && steps[index].output) || "";
}

// ── goal-dashboard.ts modal click handler ─────────────────────────────────────
function dashboardOpenModal(step: { output?: string; liveOutput?: string }): string {
	return step.liveOutput || "";
}
function dashboardOpenModalFixed(step: { output?: string; liveOutput?: string }): string {
	return step.liveOutput || step.output || "";
}

// ── _fetchAndReconcile() _stepOutputs seeding ─────────────────────────────────
function reconcileStepOutputs(stepOutputs: Map<number, string>, _apiSteps: any[]): Map<number, string> {
	// OLD: does NOT seed _stepOutputs from API steps.
	return new Map(stepOutputs);
}
function reconcileStepOutputsFixed(stepOutputs: Map<number, string>, apiSteps: any[]): Map<number, string> {
	const result = new Map(stepOutputs);
	apiSteps.forEach((step, i) => {
		if (step.output && !result.has(i)) result.set(i, step.output);
	});
	return result;
}

describe("Verification output modal data flow bug", () => {
	it("chat widget _openModal uses API output when WS accumulator is empty", () => {
		const steps = [
			{ name: "Content present", type: "command", status: "passed", output: "ok\n" },
			{ name: "Analysis quality", type: "llm-review", status: "passed", output: "Looks good" },
		];
		const stepOutputs = new Map<number, string>();

		expect(chatWidgetOpenModal(stepOutputs, steps, 0)).toBe("");
		expect(chatWidgetOpenModalFixed(stepOutputs, steps, 0)).toBe("ok\n");
	});

	it("dashboard modal uses API output when liveOutput is empty", () => {
		const step = { output: "ok\n", liveOutput: undefined };
		expect(dashboardOpenModal(step)).toBe("");
		expect(dashboardOpenModalFixed(step)).toBe("ok\n");
	});

	it("_fetchAndReconcile seeds _stepOutputs from API response", () => {
		const existingStepOutputs = new Map<number, string>();
		const apiSteps = [
			{ name: "Step 1", output: "echo output here\n" },
			{ name: "Step 2", output: "test results\n" },
		];

		const buggyMap = reconcileStepOutputs(existingStepOutputs, apiSteps);
		const fixedMap = reconcileStepOutputsFixed(existingStepOutputs, apiSteps);

		expect(buggyMap.has(0)).toBe(false);
		expect(buggyMap.has(1)).toBe(false);
		expect(fixedMap.has(0)).toBe(true);
		expect(fixedMap.get(0)).toBe("echo output here\n");
		expect(fixedMap.has(1)).toBe(true);
	});
});
