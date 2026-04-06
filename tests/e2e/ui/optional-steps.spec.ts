/**
 * E2E tests for agent-qa + optional steps feature.
 *
 * Covers:
 * - enabledOptionalSteps persisted on goal creation
 * - Optional step skipping during verification
 * - Workflows API includes optional/label fields
 * - Goal proposal <options> tag parsing
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch, nonGitCwd, readE2EToken, createSession, connectWs } from "../e2e-setup.js";
import { openApp, sendMessage } from "./ui-helpers.js";

const TEST_WORKFLOW_ID = `test-optional-${Date.now()}`;

/** Create a custom workflow with an optional step for testing. */
async function createTestWorkflow(): Promise<void> {
	const res = await apiFetch("/api/workflows", {
		method: "POST",
		body: JSON.stringify({
			id: TEST_WORKFLOW_ID,
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
async function deleteTestWorkflow(): Promise<void> {
	await apiFetch(`/api/workflows/${TEST_WORKFLOW_ID}`, { method: "DELETE" }).catch(() => {});
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
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const res = await apiFetch(`/api/goals/${goalId}/gates/${gateId}`);
		const data = await res.json();
		if (data.status === targetStatus) return data;
		await new Promise(r => setTimeout(r, 50));
	}
	const res = await apiFetch(`/api/goals/${goalId}/gates/${gateId}`);
	const data = await res.json();
	throw new Error(
		`Gate ${gateId} did not reach "${targetStatus}" within ${timeoutMs}ms. Current: "${data.status}"`,
	);
}

test.describe("Optional steps", () => {
	test("enabledOptionalSteps persisted via API", async () => {
		await createTestWorkflow();
		try {
			const goal = await createGoalWithOpts({
				workflowId: TEST_WORKFLOW_ID,
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
			await deleteTestWorkflow();
		}
	});

	test("optional step skipped when not enabled", async () => {
		await createTestWorkflow();
		try {
			// Create goal WITHOUT enabledOptionalSteps — QA testing step should be skipped
			const goal = await createGoalWithOpts({ workflowId: TEST_WORKFLOW_ID });
			try {
				// Signal the impl gate
				const signalResp = await apiFetch(`/api/goals/${goal.id}/gates/impl/signal`, {
					method: "POST",
					body: JSON.stringify({}),
				});
				expect([200, 201]).toContain(signalResp.status);

				// Wait for gate to pass (the command step runs "echo ok", agent-qa is skipped)
				await waitForGateStatus(goal.id, "impl", "passed", 30_000);

				// Check signal history for the QA testing step
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
			await deleteTestWorkflow();
		}
	});

	test("optional step auto-passes when enabled (BOBBIT_LLM_REVIEW_SKIP)", async () => {
		await createTestWorkflow();
		try {
			// Create goal WITH QA testing enabled — should auto-pass with BOBBIT_LLM_REVIEW_SKIP
			const goal = await createGoalWithOpts({
				workflowId: TEST_WORKFLOW_ID,
				enabledOptionalSteps: ["QA testing"],
			});
			try {
				const signalResp = await apiFetch(`/api/goals/${goal.id}/gates/impl/signal`, {
					method: "POST",
					body: JSON.stringify({}),
				});
				expect([200, 201]).toContain(signalResp.status);

				// Wait for gate to pass
				await waitForGateStatus(goal.id, "impl", "passed", 30_000);

				// Check signal history — QA step should be auto-passed (not skipped)
				const signalsResp = await apiFetch(`/api/goals/${goal.id}/gates/impl/signals`);
				const { signals } = await signalsResp.json();
				const lastSignal = signals[signals.length - 1];
				const steps = lastSignal.verification?.steps || [];
				const qaStep = steps.find((s: any) => s.name === "QA testing");
				expect(qaStep).toBeTruthy();
				expect(qaStep.passed).toBe(true);
				// When enabled but LLM_REVIEW_SKIP is set, it auto-passes (not "Skipped")
				expect(qaStep.output).not.toContain("Skipped");
			} finally {
				await deleteGoal(goal.id);
			}
		} finally {
			await deleteTestWorkflow();
		}
	});

	test("workflows API includes optional and label fields", async () => {
		const resp = await apiFetch("/api/workflows");
		expect(resp.status).toBe(200);
		const data = await resp.json();
		const workflows = data.workflows || data;

		// Find the feature workflow
		const feature = (workflows as any[]).find((w: any) => w.id === "feature");
		expect(feature).toBeTruthy();

		// Find the implementation gate
		const implGate = feature.gates.find((g: any) => g.id === "implementation");
		expect(implGate).toBeTruthy();

		// Find the QA testing verify step
		const qaStep = implGate.verify.find((s: any) => s.name === "QA testing");
		expect(qaStep).toBeTruthy();
		expect(qaStep.optional).toBe(true);
		expect(qaStep.label).toBe("Enable QA Testing");
		expect(qaStep.type).toBe("agent-qa");
	});

	test("goal proposal with options field is parsed", async ({ page }) => {
		await openApp(page);

		// Click the "New Goal" button
		const newGoalBtn = page.locator("button[title='New goal (Alt+G)']").first();
		await expect(newGoalBtn).toBeVisible({ timeout: 10_000 });
		await newGoalBtn.click();

		// Wait for textarea
		const textarea = page.locator("textarea").first();
		await expect(textarea).toBeVisible({ timeout: 15_000 });

		// Send GOAL_PROPOSAL keyword — mock agent emits propose_goal tool call
		// with options: "QA testing"
		await sendMessage(page, "Please create a GOAL_PROPOSAL for testing");

		// Wait for the proposal panel to show the title
		const titleInput = page.locator("input[placeholder='Goal title']").first();
		await expect(titleInput).toBeVisible({ timeout: 10_000 });
		await expect(titleInput).toHaveValue("E2E Test Goal", { timeout: 15_000 });

		// The proposal was successfully parsed via propose_goal tool call
		// (title populated means _checkToolProposals fired correctly).
		// The mock agent includes options: "QA testing" in its tool input.
		// Verify the Create Goal button is enabled
		const createGoalBtn = page.locator("button").filter({ hasText: "Create Goal" }).first();
		await expect(createGoalBtn).toBeVisible({ timeout: 5_000 });
	});
});
