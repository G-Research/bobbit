import { vi } from "vitest";
export { vi };
import { test, expect } from "../../../../integration/gateway/_helpers/e2e/in-process-harness.js";
export { test, expect };
import {
	apiFetch,
	base,
	connectWs,
	createGoal,
	createSession,
	defaultProjectId,
	deleteGoal,
	deleteSession,
	gitCwd,
	startTeam,
	teardownTeam,
	type WsConnection,
} from "../../../../integration/gateway/_helpers/e2e/e2e-setup.js";
export {
	apiFetch,
	base,
	connectWs,
	createGoal,
	createSession,
	defaultProjectId,
	deleteGoal,
	deleteSession,
	gitCwd,
	startTeam,
	teardownTeam,
	type WsConnection,
};
import { pollUntil } from "../../../../e2e/_helpers/test-utils/cleanup.js";
export { pollUntil };
import {
	signalAndWaitForAuthoredGateWithFakeCommandBarrier,
	trackGateApiConnection,
	useGateApiTestSupport,
	waitForAuthoredGateStatus,
} from "../../../../integration/gateway/_helpers/gate-api-test-support.js";
export {
	signalAndWaitForAuthoredGateWithFakeCommandBarrier,
	trackGateApiConnection,
	useGateApiTestSupport,
};


export function workflowId(prefix: string): string {
	return `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function createWorkflow(id: string, gates: Array<Record<string, unknown>>): Promise<void> {
	const res = await apiFetch("/api/workflows", {
		method: "POST",
		body: JSON.stringify({
			id,
			name: `Gate Reset ${id}`,
			description: "Workflow fixture for gate reset API tests",
			gates,
		}),
	});
	expect(res.status, `workflow create failed: ${res.status} ${await res.text().catch(() => "")}`).toBe(201);
}

export async function deleteWorkflow(id: string): Promise<void> {
	await apiFetch(`/api/workflows/${id}`, { method: "DELETE" }).catch(() => {});
}

export async function signalGate(goalId: string, gateId: string, body: Record<string, unknown> = {}): Promise<any> {
	const res = await apiFetch(`/api/goals/${goalId}/gates/${gateId}/signal`, {
		method: "POST",
		body: JSON.stringify(body),
	});
	const text = await res.text();
	expect(res.status, `signal ${gateId} failed: ${res.status} ${text}`).toBe(201);
	return text ? JSON.parse(text) : null;
}

export async function waitForGateStatus(goalId: string, gateId: string, status: "pending" | "passed" | "failed"): Promise<any> {
	return waitForAuthoredGateStatus(goalId, gateId, status);
}

export async function getGate(goalId: string, gateId: string): Promise<any> {
	const res = await apiFetch(`/api/goals/${goalId}/gates/${gateId}`);
	expect(res.status).toBe(200);
	return res.json();
}

export async function waitForGoalSetupReady(goalId: string): Promise<any> {
	return pollUntil(async () => {
		const res = await apiFetch(`/api/goals/${goalId}`);
		if (!res.ok) return null;
		const goal = await res.json();
		if (goal.setupStatus === "error") throw new Error(`Goal setup failed: ${JSON.stringify(goal)}`);
		return goal.setupStatus === "ready" ? goal : null;
	}, { timeoutMs: 60_000, intervalMs: 250, label: `goal ${goalId} setup ready` });
}

export async function getSignals(goalId: string, gateId: string): Promise<any[]> {
	const res = await apiFetch(`/api/goals/${goalId}/gates/${gateId}/signals`);
	expect(res.status).toBe(200);
	return (await res.json()).signals || [];
}

export async function latestVerificationOutput(goalId: string, gateId: string): Promise<string> {
	const res = await apiFetch(`/api/goals/${goalId}/gates/${gateId}/inspect?section=verification`);
	expect(res.status).toBe(200);
	const body = await res.json();
	return (body.steps || []).map((s: any) => String(s.output || "")).join("\n");
}

export async function resetGate(goalId: string, gateId: string): Promise<{ status: number; body: any }> {
	const res = await apiFetch(`/api/goals/${goalId}/gates/${gateId}/reset`, { method: "POST" });
	const text = await res.text();
	let body: any = null;
	try { body = text ? JSON.parse(text) : null; } catch { body = text; }
	return { status: res.status, body };
}

export async function activeVerifications(goalId: string): Promise<any[]> {
	const res = await apiFetch(`/api/goals/${goalId}/verifications/active`);
	expect(res.status).toBe(200);
	return (await res.json()).verifications || [];
}

export async function getGoal(goalId: string): Promise<any> {
	const res = await apiFetch(`/api/goals/${goalId}`);
	expect(res.status).toBe(200);
	return res.json();
}

export async function updateGoal(goalId: string, updates: Record<string, unknown>): Promise<any> {
	const res = await apiFetch(`/api/goals/${goalId}`, {
		method: "PUT",
		body: JSON.stringify(updates),
	});
	const text = await res.text();
	expect(res.status, `goal update failed: ${res.status} ${text}`).toBe(200);
	return text ? JSON.parse(text) : null;
}

export async function createCompletedTask(goalId: string): Promise<any> {
	const create = await apiFetch(`/api/goals/${goalId}/tasks`, {
		method: "POST",
		body: JSON.stringify({ title: "Preserved completed task", type: "testing", spec: "Task fixture preserved across gate reset." }),
	});
	expect(create.status).toBe(201);
	const task = await create.json();
	for (const state of ["in-progress", "complete"]) {
		const update = await apiFetch(`/api/tasks/${task.id}`, {
			method: "PUT",
			body: JSON.stringify({ state, ...(state === "complete" ? { resultSummary: "Fixture complete" } : {}) }),
		});
		expect(update.status).toBe(200);
	}
	const read = await apiFetch(`/api/tasks/${task.id}`);
	expect(read.status).toBe(200);
	return read.json();
}

export async function completeTeam(goalId: string): Promise<void> {
	const res = await apiFetch(`/api/goals/${goalId}/team/complete`, {
		method: "POST",
		body: JSON.stringify({}),
	});
	const text = await res.text();
	expect(res.status, `team complete failed: ${res.status} ${text}`).toBe(200);
}

export function resetNotificationCalls(spies: any[], teamLeadId: string): any[][] {
	return spies.flatMap(spy => spy.mock.calls)
		.filter((call: any[]) => call[0] === teamLeadId && String(call[1]).includes("Gate reset:"));
}
