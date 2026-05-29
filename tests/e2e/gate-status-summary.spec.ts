import { expect } from "@playwright/test";
import { test } from "./in-process-harness.js";
import { apiFetch, createGoal, defaultProjectId, deleteGoal } from "./e2e-setup.js";

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
	await expect.poll(async () => {
		const res = await apiFetch(`/api/goals/${goalId}/verifications/active`);
		if (!res.ok) return false;
		const body = await res.json();
		return Array.isArray(body.verifications)
			&& body.verifications.some((v: any) => v.gateId === GATE_ID && v.overallStatus === "running");
	}, { timeout: 10_000 }).toBe(true);
}

test.describe("authoritative gate status summary", () => {
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

			const signal = await apiFetch(`/api/goals/${goalId}/gates/${GATE_ID}/signal`, {
				method: "POST",
				body: JSON.stringify({ content: "# Slow Gate\n\nRun active verification." }),
			});
			expect(signal.status, `signal failed: ${await signal.text()}`).toBe(201);
			await waitForActive(goalId);

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
