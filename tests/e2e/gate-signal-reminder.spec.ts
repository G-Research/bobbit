import { test, expect } from "./in-process-harness.js";
import { apiFetch, createGoal, deleteGoal, gitCwd } from "./e2e-setup.js";
import { pollUntil } from "./test-utils/cleanup.js";

const DO_NOT_POLL_PATTERN = /Verification is running asynchronously|Do not poll|gate_status|gate_inspect|Go idle|wait for the server/i;

function workflowId(prefix: string): string {
	return `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function createWorkflow(id: string, gates: Array<Record<string, unknown>>): Promise<void> {
	const res = await apiFetch("/api/workflows", {
		method: "POST",
		body: JSON.stringify({
			id,
			name: `Gate Signal Reminder ${id}`,
			description: "Workflow fixture for gate signal reminder API response tests",
			gates,
		}),
	});
	expect(res.status, `workflow create failed: ${res.status} ${await res.text().catch(() => "")}`).toBe(201);
}

async function deleteWorkflow(id: string): Promise<void> {
	await apiFetch(`/api/workflows/${id}`, { method: "DELETE" }).catch(() => {});
}

async function signalGate(goalId: string, gateId: string, body: Record<string, unknown> = {}): Promise<any> {
	const res = await apiFetch(`/api/goals/${goalId}/gates/${gateId}/signal`, {
		method: "POST",
		body: JSON.stringify(body),
	});
	const text = await res.text();
	expect(res.status, `signal ${gateId} failed: ${res.status} ${text}`).toBe(201);
	return text ? JSON.parse(text) : null;
}

async function waitForGateStatus(goalId: string, gateId: string, status: "pending" | "running" | "passed" | "failed", timeoutMs = 15_000): Promise<any> {
	return pollUntil(async () => {
		const res = await apiFetch(`/api/goals/${goalId}/gates/${gateId}`);
		if (!res.ok) return null;
		const gate = await res.json();
		return gate.status === status ? gate : null;
	}, { timeoutMs, intervalMs: 50, label: `gate ${gateId} status=${status}` });
}

async function waitForGoalSetupReady(goalId: string): Promise<any> {
	return pollUntil(async () => {
		const res = await apiFetch(`/api/goals/${goalId}`);
		if (!res.ok) return null;
		const goal = await res.json();
		if (goal.setupStatus === "error") throw new Error(`Goal setup failed: ${JSON.stringify(goal)}`);
		return goal.setupStatus === "ready" ? goal : null;
	}, { timeoutMs: 60_000, intervalMs: 250, label: `goal ${goalId} setup ready` });
}

function expectUiSignalShapePreserved(body: any, expected: { goalId: string; gateId: string; status: string; stepNames: string[] }): void {
	expect(body.signal, "GATE_SIGNAL_AGENT_REMINDER: response must keep the top-level signal object for existing UI renderers").toBeTruthy();
	expect(Object.keys(body.signal).sort(), "GATE_SIGNAL_AGENT_REMINDER: signal object shape used by the UI must not grow a nested reminder field").toEqual(["gateId", "goalId", "id", "status", "steps"].sort());
	expect(body.signal.id).toEqual(expect.any(String));
	expect(body.signal.gateId).toBe(expected.gateId);
	expect(body.signal.goalId).toBe(expected.goalId);
	expect(body.signal.status).toBe(expected.status);
	expect(body.signal.steps.map((s: { name: string }) => s.name)).toEqual(expected.stepNames);
	expect(body.signal.agentReminder, "GATE_SIGNAL_AGENT_REMINDER: reminder must be top-level, never nested under signal").toBeUndefined();
}

test.describe("POST /api/goals/:goalId/gates/:gateId/signal agent reminder", () => {
	test("async verification response includes top-level agentReminder while preserving the UI signal shape", async () => {
		const wf = workflowId("gate-signal-reminder-async");
		await createWorkflow(wf, [
			{
				id: "async-gate",
				name: "Async Gate",
				dependsOn: [],
				verify: [
					{ name: "Slow async verification", type: "command", run: "node -e \"setTimeout(()=>process.exit(0),3000)\"" },
				],
			},
		]);

		const goal = await createGoal({ title: `Gate Signal Reminder Async ${Date.now()}`, workflowId: wf, worktree: false, team: false, autoStartTeam: false });
		const goalId = goal.id;
		try {
			const body = await signalGate(goalId, "async-gate");

			expectUiSignalShapePreserved(body, {
				goalId,
				gateId: "async-gate",
				status: "running",
				stepNames: ["Slow async verification"],
			});
			expect(Object.keys(body), "GATE_SIGNAL_AGENT_REMINDER: agent reminder must be a top-level sibling after signal").toEqual(["signal", "agentReminder"]);
			expect(body.agentReminder, "GATE_SIGNAL_AGENT_REMINDER: async signal response should tell agents not to poll").toEqual(expect.any(String));
			expect(body.agentReminder).toMatch(/Gate signal accepted/i);
			expect(body.agentReminder).toMatch(/Verification is running asynchronously/i);
			expect(body.agentReminder).toMatch(/Do not poll/i);
			expect(body.agentReminder).toMatch(/gate_status/);
			expect(body.agentReminder).toMatch(/gate_inspect/);
			expect(body.agentReminder).toMatch(/Go idle now/i);
		} finally {
			await deleteGoal(goalId).catch(() => {});
			await deleteWorkflow(wf);
		}
	});

	test("cached pass response does not include the async wait reminder", async () => {
		const wf = workflowId("gate-signal-reminder-cache");
		await createWorkflow(wf, [
			{
				id: "cached-gate",
				name: "Cached Gate",
				dependsOn: [],
				verify: [
					{ name: "Fast cached verification", type: "command", run: "node -e \"console.log('CACHEABLE_PASS')\"" },
				],
			},
		]);

		const goal = await createGoal({ title: `Gate Signal Reminder Cache ${Date.now()}`, cwd: gitCwd(), workflowId: wf, worktree: false, team: false, autoStartTeam: false });
		const goalId = goal.id;
		try {
			await waitForGoalSetupReady(goalId);
			await signalGate(goalId, "cached-gate");
			await waitForGateStatus(goalId, "cached-gate", "passed");

			const cachedBody = await signalGate(goalId, "cached-gate");

			expect(cachedBody.signal, "GATE_SIGNAL_AGENT_REMINDER: cached response must still include the signal object").toBeTruthy();
			expect(cachedBody.signal.id).toEqual(expect.any(String));
			expect(cachedBody.signal.gateId).toBe("cached-gate");
			expect(cachedBody.signal.goalId).toBe(goalId);
			expect(cachedBody.signal.status).toBe("passed");
			expect(cachedBody.signal.cached).toBe(true);
			expect(cachedBody.signal.steps.map((s: { name: string }) => s.name)).toEqual(["Fast cached verification"]);
			expect(cachedBody.signal.agentReminder, "GATE_SIGNAL_AGENT_REMINDER: reminder must not be nested under signal on cached responses").toBeUndefined();
			expect(String(cachedBody.agentReminder ?? ""), "GATE_SIGNAL_AGENT_REMINDER: cached/pass responses must not instruct agents to wait for async verification").not.toMatch(DO_NOT_POLL_PATTERN);
		} finally {
			await deleteGoal(goalId).catch(() => {});
			await deleteWorkflow(wf);
		}
	});
});
