// Select the fork-local fake runner before either harness import can boot the
// process-global gateway; file collection order must not select the real runner.
import { resetAndInstallFakeCommandStepTestState } from "./_e2e/fake-cmd-setup.js";

import { expect } from "./_e2e/in-process-harness.js";
import { test } from "./_e2e/in-process-harness.js";
import { apiFetch, createGoal, defaultProjectId, deleteGoal } from "./_e2e/e2e-setup.js";

const GATE_ID = "slow-gate";
const SLOW_CMD = `node -e "setTimeout(()=>process.exit(0),30000)"`;

function workflowId(): string {
	return `gate-status-summary-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function createWorkflow(id: string, projectId: string): Promise<void> {
	const res = await apiFetch("/api/workflows", {
		method: "POST",
		body: JSON.stringify({
			projectId,
			id,
			name: "Gate Status Summary Active",
			description: "One slow command gate for authoritative summary coverage.",
			gates: [{
				id: GATE_ID,
				name: "Slow Gate",
				dependsOn: [],
				verify: [{ name: "Slow verification", type: "command", run: SLOW_CMD }],
			}],
		}),
	});
	expect(res.status, `create workflow failed: ${await res.text()}`).toBe(201);
}

async function deleteWorkflow(id: string, projectId: string): Promise<void> {
	await apiFetch(`/api/workflows/${encodeURIComponent(id)}?projectId=${encodeURIComponent(projectId)}`, { method: "DELETE" }).catch(() => { /* best-effort */ });
}

async function waitForActive(goalId: string): Promise<void> {
	// beginVerification seeds the active record before the signal response. Read
	// that synchronous contract directly instead of paying expect.poll's default
	// wall-clock interval (which previously let a 30s real command dominate).
	const res = await apiFetch(`/api/goals/${goalId}/verifications/active`);
	expect(res.status).toBe(200);
	const body = await res.json();
	expect(Array.isArray(body.verifications)
		&& body.verifications.some((v: any) => v.gateId === GATE_ID && v.overallStatus === "running")).toBe(true);
}

test.describe("authoritative gate status summary", () => {
	test.beforeEach(async ({ gateway }) => resetAndInstallFakeCommandStepTestState(gateway));
	test.afterEach(async ({ gateway }) => resetAndInstallFakeCommandStepTestState(gateway));

	test("summary reports active verification from VerificationHarness state", async () => {
		const projectId = await defaultProjectId();
		expect(projectId).toBeTruthy();
		const wfId = workflowId();
		let goalId: string | undefined;
		try {
			await createWorkflow(wfId, projectId!);
			const goal = await createGoal({
				title: `Gate Status Summary ${Date.now()}`,
				workflowId: wfId,
				projectId,
				worktree: false,
			});
			goalId = goal.id;
			const beforeSignalGoalsResp = await apiFetch("/api/goals");
			expect(beforeSignalGoalsResp.status).toBe(200);
			const beforeSignalGoals = await beforeSignalGoalsResp.json();
			expect(typeof beforeSignalGoals.generation).toBe("number");

			const signal = await apiFetch(`/api/goals/${goalId}/gates/${GATE_ID}/signal`, {
				method: "POST",
				body: JSON.stringify({ content: "# Slow Gate\n\nRun active verification." }),
			});
			expect(signal.status, `signal failed: ${await signal.text()}`).toBe(201);
			await waitForActive(goalId);

			const changedGoalsResp = await apiFetch(`/api/goals?since=${beforeSignalGoals.generation}`);
			expect(changedGoalsResp.status).toBe(200);
			const changedGoals = await changedGoalsResp.json();
			expect(changedGoals.changed, "goal generation must bump when active verification starts so polling sidebars rehydrate summaries without a mounted goal subscriber").not.toBe(false);

			const summaryResp = await apiFetch(`/api/goals/${goalId}/gates?view=summary`);
			expect(summaryResp.status).toBe(200);
			const summaryBody = await summaryResp.json();
			expect(summaryBody.summary).toMatchObject({
				passed: 0,
				total: 1,
				verifying: true,
				verifyingCount: 1,
				awaitingSignoffCount: 0,
			});
			expect(summaryBody.summary.runningGateIds).toContain(GATE_ID);
			expect(summaryBody.summary.gates).toEqual(expect.arrayContaining([
				expect.objectContaining({ gateId: GATE_ID, status: "pending", effectiveStatus: "running", running: true }),
			]));
		} finally {
			if (goalId) {
				await apiFetch(`/api/goals/${goalId}/gates/${GATE_ID}/cancel-verification`, { method: "POST" }).catch(() => { /* best-effort */ });
				await deleteGoal(goalId);
			}
			await deleteWorkflow(wfId, projectId!);
		}
	});
});
