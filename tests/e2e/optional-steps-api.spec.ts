/**
 * API coverage for optional workflow verification steps.
 *
 * Browser proposal parsing stays in tests/e2e/ui/optional-steps.spec.ts.
 */
import { test, expect } from "./in-process-harness.js";
import { apiFetch, nonGitCwd } from "./e2e-setup.js";
import { pollUntil } from "./test-utils/cleanup.js";

function uniqueWorkflowId(): string {
	return `test-optional-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Create a custom workflow with an optional step for testing. */
async function createTestWorkflow(workflowId: string): Promise<void> {
	const res = await apiFetch("/api/workflows", {
		method: "POST",
		body: JSON.stringify({
			id: workflowId,
			name: "Test Optional Steps",
			description: "Workflow for testing optional step skipping",
			gates: [
				{
					id: "impl",
					name: "Implementation",
					dependsOn: [],
					verify: [
						{
							name: "Quick check",
							type: "command",
							run: "echo ok",
						},
						{
							name: "QA testing",
							type: "agent-qa",
							phase: 1,
							optional: true,
							label: "Enable QA Testing",
							prompt: "Run QA tests",
						},
					],
				},
			],
		}),
	});
	expect(res.status).toBe(201);
}

/** Delete the test workflow (cleanup). */
async function deleteTestWorkflow(workflowId: string): Promise<void> {
	await apiFetch(`/api/workflows/${workflowId}`, { method: "DELETE" }).catch(() => {});
}

/** Create a goal with specific options. */
async function createGoalWithOpts(opts: Record<string, unknown>): Promise<any> {
	const resp = await apiFetch("/api/goals", {
		method: "POST",
		body: JSON.stringify({
			title: `Optional Steps Test ${Date.now()}`,
			cwd: nonGitCwd(),
			worktree: false,
			...opts,
		}),
	});
	expect(resp.status).toBe(201);
	return resp.json();
}

/** Delete a goal (best-effort). */
async function deleteGoal(goalId: string): Promise<void> {
	await apiFetch(`/api/goals/${goalId}`, { method: "DELETE" }).catch(() => {});
}

/** Poll until a gate reaches the target status. */
async function waitForGateStatus(
	goalId: string,
	gateId: string,
	targetStatus: string,
	timeoutMs = 30_000,
): Promise<any> {
	return pollUntil(
		async () => {
			const res = await apiFetch(`/api/goals/${goalId}/gates/${gateId}`);
			const data = await res.json();
			return data.status === targetStatus ? data : null;
		},
		{ timeoutMs, intervalMs: 50, label: `gate ${gateId} -> ${targetStatus}` },
	);
}

test.describe("Optional steps API @quarantine", () => {
	test("enabledOptionalSteps persisted via API", async () => {
		const workflowId = uniqueWorkflowId();
		await createTestWorkflow(workflowId);
		try {
			const goal = await createGoalWithOpts({
				workflowId,
				enabledOptionalSteps: ["QA testing"],
			});
			try {
				const resp = await apiFetch(`/api/goals/${goal.id}`);
				expect(resp.status).toBe(200);
				const data = await resp.json();
				expect(data.enabledOptionalSteps).toContain("QA testing");
			} finally {
				await deleteGoal(goal.id);
			}
		} finally {
			await deleteTestWorkflow(workflowId);
		}
	});

	test("optional step skipped when not enabled", async () => {
		const workflowId = uniqueWorkflowId();
		await createTestWorkflow(workflowId);
		try {
			// Create goal WITHOUT enabledOptionalSteps — QA testing step should be skipped.
			const goal = await createGoalWithOpts({ workflowId });
			try {
				// Signal the impl gate.
				const signalResp = await apiFetch(`/api/goals/${goal.id}/gates/impl/signal`, {
					method: "POST",
					body: JSON.stringify({}),
				});
				expect([200, 201]).toContain(signalResp.status);

				// Wait for gate to pass (the command step runs "echo ok", agent-qa is skipped).
				await waitForGateStatus(goal.id, "impl", "passed", 30_000);

				// Check signal history for the QA testing step.
				const signalsResp = await apiFetch(`/api/goals/${goal.id}/gates/impl/signals`);
				expect(signalsResp.status).toBe(200);
				const { signals } = await signalsResp.json();
				expect(signals.length).toBeGreaterThan(0);

				const lastSignal = signals[signals.length - 1];
				const steps = lastSignal.verification?.steps || [];
				const qaStep = steps.find((s: any) => s.name === "QA testing");
				expect(qaStep).toBeTruthy();
				expect(qaStep.passed).toBe(true);
				expect(qaStep.output).toContain("Skipped");
			} finally {
				await deleteGoal(goal.id);
			}
		} finally {
			await deleteTestWorkflow(workflowId);
		}
	});

	test("optional step auto-passes when enabled (BOBBIT_LLM_REVIEW_SKIP)", async () => {
		const workflowId = uniqueWorkflowId();
		await createTestWorkflow(workflowId);
		try {
			// Create goal WITH QA testing enabled — should auto-pass with BOBBIT_LLM_REVIEW_SKIP.
			const goal = await createGoalWithOpts({
				workflowId,
				enabledOptionalSteps: ["QA testing"],
			});
			try {
				const signalResp = await apiFetch(`/api/goals/${goal.id}/gates/impl/signal`, {
					method: "POST",
					body: JSON.stringify({}),
				});
				expect([200, 201]).toContain(signalResp.status);

				// Wait for gate to pass.
				await waitForGateStatus(goal.id, "impl", "passed", 30_000);

				// Check signal history — QA step should be auto-passed (not skipped).
				const signalsResp = await apiFetch(`/api/goals/${goal.id}/gates/impl/signals`);
				const { signals } = await signalsResp.json();
				const lastSignal = signals[signals.length - 1];
				const steps = lastSignal.verification?.steps || [];
				const qaStep = steps.find((s: any) => s.name === "QA testing");
				expect(qaStep).toBeTruthy();
				expect(qaStep.passed).toBe(true);
				// When enabled but LLM_REVIEW_SKIP is set, it auto-passes (not "Skipped").
				expect(qaStep.output).not.toContain("Skipped");
			} finally {
				await deleteGoal(goal.id);
			}
		} finally {
			await deleteTestWorkflow(workflowId);
		}
	});

	test("workflows API includes optional and label fields", async () => {
		const resp = await apiFetch("/api/workflows");
		expect(resp.status).toBe(200);
		const data = await resp.json();
		const workflows = data.workflows || data;

		// Find the feature workflow.
		const feature = (workflows as any[]).find((w: any) => w.id === "feature");
		expect(feature).toBeTruthy();

		// Find the implementation gate.
		const implGate = feature.gates.find((g: any) => g.id === "implementation");
		expect(implGate).toBeTruthy();

		// Find the QA testing verify step.
		const qaStep = implGate.verify.find((s: any) => s.name === "QA testing");
		expect(qaStep).toBeTruthy();
		expect(qaStep.optional).toBe(true);
		// After the `label` / `optionalLabel` schema split, optional non-human-
		// signoff steps emit the toggle text as `optionalLabel`. Old YAML using
		// `label` is migrated forward in `workflow-store::normalizeStep`.
		expect(qaStep.optionalLabel).toBe("Enable QA Testing");
		expect(qaStep.label).toBeUndefined();
		expect(qaStep.type).toBe("agent-qa");
	});
});
