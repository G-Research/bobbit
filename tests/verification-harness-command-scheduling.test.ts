import { test } from "node:test";
import assert from "node:assert/strict";
import {
	resolveCommandStepTimeoutSec,
	runVerificationPhaseSteps,
	shouldSerializeVerificationStepWithinPhase,
} from "../src/server/agent/verification-harness.js";
import { groupStepsByPhase, getSortedPhases } from "../src/server/agent/verification-logic.js";
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

test("runVerificationPhaseSteps runs same-phase command steps concurrently", async () => {
	type PhaseStep = { step: Pick<VerifyStep, "name" | "type">; index: number };
	const phaseSteps: PhaseStep[] = [
		{ step: { name: "check", type: "command" }, index: 0 },
		{ step: { name: "unit", type: "command" }, index: 1 },
	];

	let activeCommands = 0;
	let maxActiveCommands = 0;
	const starts: string[] = [];
	const finishes: string[] = [];

	const results = await runVerificationPhaseSteps(
		phaseSteps,
		async ({ step, index }) => {
			starts.push(step.name);
			activeCommands += 1;
			maxActiveCommands = Math.max(maxActiveCommands, activeCommands);

			await new Promise(resolve => setTimeout(resolve, 25));

			activeCommands -= 1;
			finishes.push(step.name);
			return { index, name: step.name };
		},
		{ shouldSerialize: ({ step }) => shouldSerializeVerificationStepWithinPhase(step) },
	);

	assert.equal(maxActiveCommands, 2, "same-phase command steps should run concurrently");
	assert.deepEqual(starts, ["check", "unit"]);
	assert.deepEqual(finishes.sort(), ["check", "unit"]);
	assert.deepEqual(results.map(r => r.index), [0, 1]);
});

test("verification phases run sequentially in ascending phase order", async () => {
	const steps: VerifyStep[] = [
		{ name: "phase two", type: "command", phase: 2 },
		{ name: "phase zero", type: "command", phase: 0 },
		{ name: "phase one", type: "command", phase: 1 },
	];
	const phaseGroups = groupStepsByPhase(steps, steps);
	const sortedPhases = getSortedPhases(phaseGroups);
	const events: string[] = [];
	let activeSteps = 0;
	let maxActiveSteps = 0;

	for (const phase of sortedPhases) {
		events.push(`phase:${phase}:start`);
		const phaseSteps = phaseGroups.get(phase) ?? [];
		await runVerificationPhaseSteps(
			phaseSteps,
			async ({ step, index }) => {
				activeSteps += 1;
				maxActiveSteps = Math.max(maxActiveSteps, activeSteps);
				events.push(`step:${step.name}:start`);

				await new Promise(resolve => setTimeout(resolve, 5));

				events.push(`step:${step.name}:finish`);
				activeSteps -= 1;
				return index;
			},
			{ shouldSerialize: ({ step }) => shouldSerializeVerificationStepWithinPhase(step) },
		);
		events.push(`phase:${phase}:finish`);
	}

	assert.deepEqual(sortedPhases, [0, 1, 2]);
	assert.equal(maxActiveSteps, 1, "different phases should not overlap");
	assert.deepEqual(events, [
		"phase:0:start",
		"step:phase zero:start",
		"step:phase zero:finish",
		"phase:0:finish",
		"phase:1:start",
		"step:phase one:start",
		"step:phase one:finish",
		"phase:1:finish",
		"phase:2:start",
		"step:phase two:start",
		"step:phase two:finish",
		"phase:2:finish",
	]);
});
