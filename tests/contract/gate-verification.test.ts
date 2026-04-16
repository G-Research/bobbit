/**
 * Tier 2 contract tests for gate verification.
 *
 * Replaces:
 *   tests/e2e/gates-api-heavy.spec.ts
 *   tests/e2e/gate-resign-cancel.spec.ts
 */
import { test } from "node:test";
import assert from "node:assert";
import { createTestGateway } from "./fixtures/gateway.js";

test("cascade reset — re-signaling upstream resets downstream to pending", async () => {
	await using gw = await createTestGateway();

	const goal = await gw.createGoal({
		title: "Cascade Reset Test",
		workflowId: "test-fast",
	});

	await gw.signalGate(goal.id, "design-doc", { content: "# Design v1" });
	await gw.waitForGateStatus(goal.id, "design-doc", "passed");

	await gw.signalGate(goal.id, "implementation");
	await gw.waitForGateStatus(goal.id, "implementation", "passed");

	// Re-signal upstream with new content — downstream should reset to pending
	await gw.signalGate(goal.id, "design-doc", { content: "# Design v2" });
	await gw.waitForGateStatus(goal.id, "design-doc", "passed");

	const impl = await gw.getGate(goal.id, "implementation");
	assert.equal(impl.status, "pending", "implementation gate should reset after upstream re-signal");
});

test("signaling a gate with unmet upstream dependency returns 409", async () => {
	await using gw = await createTestGateway();

	const goal = await gw.createGoal({
		title: "Dependency Test",
		workflowId: "test-fast",
	});

	// Signal implementation without passing design-doc first
	const res = await gw.signalGate(goal.id, "implementation");
	assert.equal(res.status, 409);
	assert.match(res.body.error, /Upstream gate|design-doc/i);
});

test("signaling an unknown gate returns 404", async () => {
	await using gw = await createTestGateway();

	const goal = await gw.createGoal({
		title: "Unknown Gate Test",
		workflowId: "test-fast",
	});

	const res = await gw.signalGate(goal.id, "nonexistent-gate");
	assert.equal(res.status, 404);
});

test("metadata variable resolution in command step", async () => {
	await using gw = await createTestGateway();

	const goal = await gw.createGoal({
		title: "Metadata Resolution Test",
		workflowId: "bug-fix",
	});

	// Signal issue-analysis first (upstream)
	await gw.signalGate(goal.id, "issue-analysis", {
		content: "# Analysis\n\nSteps: run echo\nRoot cause: src/a.ts:1",
	});
	await gw.waitForGateStatus(goal.id, "issue-analysis", "passed");

	// Signal reproducing-test with metadata — expect:failure gate
	await gw.signalGate(goal.id, "reproducing-test", {
		metadata: {
			test_command: "echo metadata-works",
			error_pattern: "some error",
		},
	});
	// echo metadata-works exits 0 → gate fails (expect:failure semantics)
	await gw.waitForGateStatus(goal.id, "reproducing-test", "failed");

	// Verify the {{test_command}} resolution reached the step output
	const gate = await gw.getGate(goal.id, "reproducing-test");
	const lastSignal = gate.signals[gate.signals.length - 1];
	const step = lastSignal.verification.steps[0];
	assert.match(step.output, /metadata-works/);
});
