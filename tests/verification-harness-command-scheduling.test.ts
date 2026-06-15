import { test } from "node:test";
import assert from "node:assert/strict";
import {
	resolveCommandStepTimeoutSec,
	runVerificationPhaseSteps,
	shouldSerializeVerificationStepWithinPhase,
} from "../src/server/agent/verification-harness.js";
import type { VerifyStep } from "../src/server/agent/workflow-store.js";

test("resolveCommandStepTimeoutSec gives component unit commands a longer default", () => {
	const unitStep = {
		name: "Unit tests",
		type: "command",
		component: "bobbit",
		command: "unit",
	} satisfies VerifyStep;
	assert.equal(resolveCommandStepTimeoutSec(unitStep), 1200);

	const explicitUnitStep = { ...unitStep, timeout: 42 } satisfies VerifyStep;
	assert.equal(resolveCommandStepTimeoutSec(explicitUnitStep), 42);

	const e2eStep = {
		name: "E2E tests",
		type: "command",
		component: "bobbit",
		command: "e2e",
	} satisfies VerifyStep;
	assert.equal(resolveCommandStepTimeoutSec(e2eStep), 300);

	const freeformCommandStep = {
		name: "Smoke",
		type: "command",
		run: "npm test",
	} satisfies VerifyStep;
	assert.equal(resolveCommandStepTimeoutSec(freeformCommandStep), 300);
});

test("runVerificationPhaseSteps serializes command steps while non-command steps remain parallel", async () => {
	type PhaseStep = { step: Pick<VerifyStep, "name" | "type">; index: number };
	const phaseSteps: PhaseStep[] = [
		{ step: { name: "check", type: "command" }, index: 0 },
		{ step: { name: "unit", type: "command" }, index: 1 },
		{ step: { name: "review", type: "llm-review" }, index: 2 },
		{ step: { name: "qa", type: "agent-qa" }, index: 3 },
	];

	let activeCommands = 0;
	let maxActiveCommands = 0;
	let activeNonCommands = 0;
	let maxActiveNonCommands = 0;
	const starts: string[] = [];
	const finishes: string[] = [];

	const results = await runVerificationPhaseSteps(
		phaseSteps,
		async ({ step, index }) => {
			starts.push(step.name);
			if (step.type === "command") {
				activeCommands += 1;
				maxActiveCommands = Math.max(maxActiveCommands, activeCommands);
			} else {
				activeNonCommands += 1;
				maxActiveNonCommands = Math.max(maxActiveNonCommands, activeNonCommands);
			}

			await new Promise(resolve => setTimeout(resolve, step.type === "command" ? 25 : 40));

			if (step.type === "command") activeCommands -= 1;
			else activeNonCommands -= 1;
			finishes.push(step.name);
			return { index, name: step.name };
		},
		{ shouldSerialize: ({ step }) => shouldSerializeVerificationStepWithinPhase(step) },
	);

	assert.equal(maxActiveCommands, 1, "command steps must not overlap within a phase");
	assert.ok(maxActiveNonCommands > 1, "non-command steps should still be able to run in parallel");
	assert.ok(finishes.indexOf("check") < starts.indexOf("unit"), "second command should start only after first command finishes");
	assert.deepEqual(results.map(r => r.index), [0, 1, 2, 3]);
});
