/**
 * Tier-1 integration contracts for gate verification.
 *
 * Replaces:
 *   tests/e2e/gates-api-heavy.spec.ts
 *   tests/e2e/gate-resign-cancel.spec.ts
 */
import assert from "node:assert";
import { test } from "./_e2e/in-process-harness.js";
import { apiFetch, createGoal, deleteGoal } from "./_e2e/e2e-setup.js";
import { createFakeVerificationCommandRunner } from "../harness/fake-verification-command-runner.js";

let originalCommandStepRunner: unknown;
test.beforeAll(({ gateway }) => {
	const verificationHarness = gateway.teamManager.verificationHarness;
	if (!verificationHarness) throw new Error("verification harness was not wired before gate-verification setup");
	originalCommandStepRunner = verificationHarness.commandStepRunner;
	verificationHarness.commandStepRunner = createFakeVerificationCommandRunner();
});
test.afterAll(({ gateway }) => {
	const verificationHarness = gateway.teamManager.verificationHarness;
	if (verificationHarness && originalCommandStepRunner) verificationHarness.commandStepRunner = originalCommandStepRunner;
});

async function signalGate(goalId: string, gateId: string, body: Record<string, unknown> = {}): Promise<Response> {
	return apiFetch(`/api/goals/${goalId}/gates/${gateId}/signal`, {
		method: "POST",
		body: JSON.stringify(body),
	});
}

async function getGate(goalId: string, gateId: string): Promise<any> {
	const response = await apiFetch(`/api/goals/${goalId}/gates/${gateId}`);
	assert.equal(response.status, 200);
	return response.json();
}

async function waitForGateStatus(goalId: string, gateId: string, expected: string): Promise<any> {
	const deadline = Date.now() + 5_000;
	let gate: any;
	do {
		gate = await getGate(goalId, gateId);
		if (gate.status === expected) return gate;
		await new Promise((resolve) => setTimeout(resolve, 10));
	} while (Date.now() < deadline);
	throw new Error(`Timed out waiting for ${goalId}/${gateId}=${expected}; last=${JSON.stringify(gate)}`);
}

test("cascade reset — re-signaling upstream resets downstream to pending", async () => {
	const goal = await createGoal({ title: "Cascade Reset Test", workflowId: "test-fast" });
	try {
		assert.equal((await signalGate(goal.id, "design-doc", { content: "# Design v1" })).status, 201);
		await waitForGateStatus(goal.id, "design-doc", "passed");

		assert.equal((await signalGate(goal.id, "implementation")).status, 201);
		await waitForGateStatus(goal.id, "implementation", "passed");

		assert.equal((await signalGate(goal.id, "design-doc", { content: "# Design v2" })).status, 201);
		await waitForGateStatus(goal.id, "design-doc", "passed");

		const implementation = await getGate(goal.id, "implementation");
		assert.equal(implementation.status, "pending", "implementation gate should reset after upstream re-signal");
	} finally {
		await deleteGoal(goal.id);
	}
});

test("signaling a gate with unmet upstream dependency returns 409", async () => {
	const goal = await createGoal({ title: "Dependency Test", workflowId: "test-fast" });
	try {
		const response = await signalGate(goal.id, "implementation");
		assert.equal(response.status, 409);
		assert.match((await response.json()).error, /Upstream gate|design-doc/i);
	} finally {
		await deleteGoal(goal.id);
	}
});

test("signaling an unknown gate returns 404", async () => {
	const goal = await createGoal({ title: "Unknown Gate Test", workflowId: "test-fast" });
	try {
		assert.equal((await signalGate(goal.id, "nonexistent-gate")).status, 404);
	} finally {
		await deleteGoal(goal.id);
	}
});

test("metadata variable resolution in command step", async () => {
	const goal = await createGoal({ title: "Metadata Resolution Test", workflowId: "bug-fix" });
	try {
		assert.equal((await signalGate(goal.id, "issue-analysis", {
			content: "# Analysis\n\nSteps: run echo\nRoot cause: src/a.ts:1",
		})).status, 201);
		await waitForGateStatus(goal.id, "issue-analysis", "passed");

		assert.equal((await signalGate(goal.id, "reproducing-test", {
			metadata: {
				test_command: "echo metadata-works",
				error_pattern: "some error",
			},
		})).status, 201);
		const gate = await waitForGateStatus(goal.id, "reproducing-test", "failed");
		const lastSignal = gate.signals[gate.signals.length - 1];
		assert.match(lastSignal.verification.steps[0].output, /metadata-works/);
	} finally {
		await deleteGoal(goal.id);
	}
});
