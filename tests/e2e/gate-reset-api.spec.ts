import { test, expect } from "./in-process-harness.js";
import {
	apiFetch,
	base,
	connectWs,
	createGoal,
	createSession,
	defaultProjectId,
	deleteGoal,
	deleteSession,
	startTeam,
	teardownTeam,
	type WsConnection,
} from "./e2e-setup.js";
import { pollUntil } from "./test-utils/cleanup.js";

function workflowId(prefix: string): string {
	return `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function createWorkflow(id: string, gates: Array<Record<string, unknown>>): Promise<void> {
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

async function waitForGateStatus(goalId: string, gateId: string, status: "pending" | "passed" | "failed", timeoutMs = 15_000): Promise<any> {
	return pollUntil(async () => {
		const res = await apiFetch(`/api/goals/${goalId}/gates/${gateId}`);
		if (!res.ok) return null;
		const gate = await res.json();
		return gate.status === status ? gate : null;
	}, { timeoutMs, intervalMs: 50, label: `gate ${gateId} status=${status}` });
}

async function getGate(goalId: string, gateId: string): Promise<any> {
	const res = await apiFetch(`/api/goals/${goalId}/gates/${gateId}`);
	expect(res.status).toBe(200);
	return res.json();
}

async function getSignals(goalId: string, gateId: string): Promise<any[]> {
	const res = await apiFetch(`/api/goals/${goalId}/gates/${gateId}/signals`);
	expect(res.status).toBe(200);
	return (await res.json()).signals || [];
}

async function resetGate(goalId: string, gateId: string): Promise<{ status: number; body: any }> {
	const res = await apiFetch(`/api/goals/${goalId}/gates/${gateId}/reset`, { method: "POST" });
	const text = await res.text();
	let body: any = null;
	try { body = text ? JSON.parse(text) : null; } catch { body = text; }
	return { status: res.status, body };
}

async function activeVerifications(goalId: string): Promise<any[]> {
	const res = await apiFetch(`/api/goals/${goalId}/verifications/active`);
	expect(res.status).toBe(200);
	return (await res.json()).verifications || [];
}

test.describe("POST /api/goals/:goalId/gates/:gateId/reset", () => {
	test("invalidates the selected gate plus transitive dependents by DAG, preserves history/content, and is idempotent", async () => {
		const wf = workflowId("gate-reset-dag");
		await createWorkflow(wf, [
			{ id: "root", name: "Root", content: true, injectDownstream: true, dependsOn: [], verify: [{ name: "root ok", type: "command", run: "echo ok" }] },
			// Intentionally before its dependency in display order. Reset must not report/use this order.
			{ id: "leaf", name: "Leaf", dependsOn: ["middle"], verify: [{ name: "leaf ok", type: "command", run: "echo ok" }] },
			{ id: "failed-child", name: "Failed Child", dependsOn: ["root"], verify: [{ name: "fails", type: "command", run: "node -e \"process.exit(1)\"" }] },
			{ id: "pending-child", name: "Pending Child", dependsOn: ["root"], verify: [{ name: "pending ok", type: "command", run: "echo ok" }] },
			{ id: "middle", name: "Middle", dependsOn: ["root"], verify: [{ name: "middle ok", type: "command", run: "echo ok" }] },
			{ id: "unrelated", name: "Unrelated", dependsOn: [], verify: [{ name: "unrelated ok", type: "command", run: "echo ok" }] },
		]);

		const goal = await createGoal({ title: `Gate Reset DAG ${Date.now()}`, workflowId: wf, worktree: false, team: false });
		const goalId = goal.id;
		let conn: WsConnection | undefined;
		let sessionId: string | undefined;
		try {
			sessionId = await createSession({ goalId });
			conn = await connectWs(sessionId);

			const rootSignal = await signalGate(goalId, "root", {
				content: "# Root content\n\nReset must preserve this content.",
				metadata: { ticket: "GATE-RESET", owner: "test" },
			});
			await waitForGateStatus(goalId, "root", "passed");
			await signalGate(goalId, "middle");
			await waitForGateStatus(goalId, "middle", "passed");
			const leafSignal = await signalGate(goalId, "leaf", { content: "leaf signal body" });
			await waitForGateStatus(goalId, "leaf", "passed");
			await signalGate(goalId, "failed-child");
			await waitForGateStatus(goalId, "failed-child", "failed");
			await signalGate(goalId, "unrelated");
			await waitForGateStatus(goalId, "unrelated", "passed");

			const beforeRoot = await getGate(goalId, "root");
			expect(beforeRoot.currentContent).toContain("Reset must preserve this content");
			expect(beforeRoot.currentContentVersion).toBe(1);
			expect(beforeRoot.currentMetadata).toEqual({ ticket: "GATE-RESET", owner: "test" });

			const cursor = conn.messageCount();
			const first = await resetGate(goalId, "root");
			expect(first.status, JSON.stringify(first.body)).toBe(200);
			expect(first.body.ok).toBe(true);
			expect(first.body.gateId).toBe("root");
			expect(first.body.affectedGateIds[0]).toBe("root");
			expect(first.body.affectedGateIds).toEqual(expect.arrayContaining(["root", "middle", "leaf", "failed-child", "pending-child"]));
			expect(first.body.affectedGateIds).not.toContain("unrelated");
			expect(first.body.affectedGateIds.indexOf("middle"), "dependency must appear before dependent leaf").toBeLessThan(first.body.affectedGateIds.indexOf("leaf"));
			expect(first.body.changedGateIds).toEqual(expect.arrayContaining(["root", "middle", "leaf", "failed-child"]));
			expect(first.body.changedGateIds).not.toContain("pending-child");
			expect(first.body.unchangedGateIds).toContain("pending-child");
			expect(first.body.previousStatuses).toMatchObject({
				root: "passed",
				middle: "passed",
				leaf: "passed",
				"failed-child": "failed",
				"pending-child": "pending",
			});

			for (const gateId of ["root", "middle", "leaf", "failed-child", "pending-child"]) {
				await conn.waitForFrom(cursor, (m) => m.type === "gate_status_changed" && m.goalId === goalId && m.gateId === gateId && m.status === "pending", 10_000);
				await waitForGateStatus(goalId, gateId, "pending");
			}
			await waitForGateStatus(goalId, "unrelated", "passed");

			const afterRoot = await getGate(goalId, "root");
			expect(afterRoot.status).toBe("pending");
			expect(afterRoot.currentContent).toBe(beforeRoot.currentContent);
			expect(afterRoot.currentContentVersion).toBe(1);
			expect(afterRoot.currentMetadata).toEqual(beforeRoot.currentMetadata);
			expect(afterRoot.signals.map((s: any) => s.id)).toContain(rootSignal.signal.id);
			expect((await getSignals(goalId, "leaf")).map((s) => s.id)).toContain(leafSignal.signal.id);

			const second = await resetGate(goalId, "root");
			expect(second.status, JSON.stringify(second.body)).toBe(200);
			expect(second.body.affectedGateIds).toEqual(first.body.affectedGateIds);
			expect(second.body.changedGateIds).toEqual([]);
			expect(second.body.unchangedGateIds).toEqual(expect.arrayContaining(first.body.affectedGateIds));
		} finally {
			conn?.close();
			if (sessionId) await deleteSession(sessionId).catch(() => {});
			await deleteGoal(goalId).catch(() => {});
			await deleteWorkflow(wf);
		}
	});

	test("denies sandbox-scoped tokens", async ({ gateway }) => {
		const wf = workflowId("gate-reset-sandbox");
		await createWorkflow(wf, [
			{ id: "root", name: "Root", dependsOn: [], verify: [{ name: "ok", type: "command", run: "echo ok" }] },
		]);
		const goal = await createGoal({ title: `Gate Reset Sandbox ${Date.now()}`, workflowId: wf, worktree: false, team: false });
		const goalId = goal.id;
		try {
			const projectId = (goal.projectId as string | undefined) || await defaultProjectId();
			expect(projectId).toBeTruthy();
			const sandboxToken = gateway.sessionManager.sandboxTokenStore.register(projectId);
			gateway.sessionManager.sandboxTokenStore.addGoal(projectId, goalId);

			const res = await fetch(`${base()}/api/goals/${goalId}/gates/root/reset`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: `Bearer ${sandboxToken}` },
			});
			expect(res.status).toBe(403);
			const body = await res.json();
			expect(String(body.error)).toMatch(/sandbox token cannot access|forbidden/i);
		} finally {
			await deleteGoal(goalId).catch(() => {});
			await deleteWorkflow(wf);
		}
	});

	test("cancels active verifications for affected gates", async () => {
		const wf = workflowId("gate-reset-cancel");
		await createWorkflow(wf, [
			{ id: "slow-root", name: "Slow Root", dependsOn: [], verify: [{ name: "slow", type: "command", run: "node -e \"setTimeout(()=>process.exit(0), 3000)\"" }] },
			{ id: "downstream", name: "Downstream", dependsOn: ["slow-root"], verify: [{ name: "ok", type: "command", run: "echo ok" }] },
		]);
		const goal = await createGoal({ title: `Gate Reset Cancel ${Date.now()}`, workflowId: wf, worktree: false, team: false });
		const goalId = goal.id;
		const sessionId = await createSession({ goalId });
		let conn: WsConnection | undefined;
		try {
			conn = await connectWs(sessionId);
			const cursor = conn.messageCount();
			const signal = await signalGate(goalId, "slow-root", { content: "slow verification" });
			const signalId = signal.signal.id;
			await conn.waitForFrom(cursor, (m) => m.type === "gate_verification_started" && m.goalId === goalId && m.gateId === "slow-root" && m.signalId === signalId, 10_000);
			expect((await activeVerifications(goalId)).some((v) => v.signalId === signalId)).toBe(true);

			const resetCursor = conn.messageCount();
			const reset = await resetGate(goalId, "slow-root");
			expect(reset.status, JSON.stringify(reset.body)).toBe(200);
			expect(reset.body.affectedGateIds).toEqual(expect.arrayContaining(["slow-root", "downstream"]));
			await conn.waitForFrom(resetCursor, (m) => m.type === "gate_verification_complete" && m.goalId === goalId && m.gateId === "slow-root" && m.signalId === signalId && m.status === "cancelled", 10_000);
			expect((await activeVerifications(goalId)).some((v) => v.signalId === signalId)).toBe(false);
			await waitForGateStatus(goalId, "slow-root", "pending");
		} finally {
			conn?.close();
			await deleteSession(sessionId).catch(() => {});
			await deleteGoal(goalId).catch(() => {});
			await deleteWorkflow(wf);
		}
	});

	test("notifies the team lead with reset, invalidation, and downstream-work context", async ({ gateway }) => {
		const wf = workflowId("gate-reset-team");
		await createWorkflow(wf, [
			{ id: "root", name: "Root Gate", dependsOn: [], verify: [{ name: "ok", type: "command", run: "echo ok" }] },
			{ id: "child", name: "Child Gate", dependsOn: ["root"], verify: [{ name: "ok", type: "command", run: "echo ok" }] },
		]);
		const goal = await createGoal({ title: `Gate Reset Team ${Date.now()}`, workflowId: wf, worktree: false, team: true, autoStartTeam: false });
		const goalId = goal.id;
		let teamLeadId: string | undefined;
		try {
			await signalGate(goalId, "root");
			await waitForGateStatus(goalId, "root", "passed");
			await signalGate(goalId, "child");
			await waitForGateStatus(goalId, "child", "passed");

			teamLeadId = await startTeam(goalId);
			const reset = await resetGate(goalId, "root");
			expect(reset.status, JSON.stringify(reset.body)).toBe(200);
			expect(reset.body.teamLeadNotified).toBe(true);

			await pollUntil(async () => {
				const session = gateway.sessionManager.getSession(teamLeadId);
				if (!session) return null;
				const messagesResp = await session.rpcClient.getMessages();
				const messages = messagesResp.data?.messages || messagesResp.data || [];
				const queued = session.promptQueue?.toArray?.() || [];
				const text = JSON.stringify({ messages, queued, lastPromptText: session.lastPromptText, inFlightSteerTexts: session.inFlightSteerTexts });
				return text.includes("Gate reset: Root Gate")
					&& text.includes("Child Gate")
					&& /downstream work|revisit dependent implementation|Why this matters/i.test(text)
					? text
					: null;
			}, { timeoutMs: 10_000, intervalMs: 100, label: "team lead reset notification" });
		} finally {
			if (teamLeadId) await deleteSession(teamLeadId).catch(() => {});
			await teardownTeam(goalId).catch(() => {});
			await deleteGoal(goalId).catch(() => {});
			await deleteWorkflow(wf);
		}
	});
});
