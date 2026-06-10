/**
 * Route-level coverage for the human-only gate-bypass endpoint:
 *   POST /api/goals/:goalId/gates/:gateId/bypass
 *
 * Verifies the endpoint matrix (design "Human Gate Bypass", acceptance
 * criteria 1–8): happy path flips the gate to "bypassed" with a persisted
 * audit signal + broadcast; the isInitiatedByHuman guard; required-field
 * validation; sandbox/404/409 guards; reset of a bypassed gate; the read-model
 * surfacing whyBypassed/whoAmI/bypassedAt; and the completion-gating contract
 * (agent path blocked, human confirm path allowed).
 *
 * Mirrors tests/e2e/gate-reset-api.spec.ts harness/import patterns.
 */
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
	gitCwd,
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
			name: `Gate Bypass ${id}`,
			description: "Workflow fixture for gate bypass API tests",
			gates,
		}),
	});
	expect(res.status, `workflow create failed: ${res.status} ${await res.text().catch(() => "")}`).toBe(201);
}

async function deleteWorkflow(id: string): Promise<void> {
	await apiFetch(`/api/workflows/${id}`, { method: "DELETE" }).catch(() => {});
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

async function bypassGate(goalId: string, gateId: string, body: Record<string, unknown>): Promise<{ status: number; body: any }> {
	const res = await apiFetch(`/api/goals/${goalId}/gates/${gateId}/bypass`, {
		method: "POST",
		body: JSON.stringify(body),
	});
	const text = await res.text();
	let parsed: any = null;
	try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
	return { status: res.status, body: parsed };
}

async function getGate(goalId: string, gateId: string): Promise<any> {
	const res = await apiFetch(`/api/goals/${goalId}/gates/${gateId}`);
	expect(res.status).toBe(200);
	return res.json();
}

async function listGates(goalId: string): Promise<any[]> {
	const res = await apiFetch(`/api/goals/${goalId}/gates`);
	expect(res.status).toBe(200);
	return (await res.json()).gates || [];
}

async function resetGate(goalId: string, gateId: string): Promise<{ status: number; body: any }> {
	const res = await apiFetch(`/api/goals/${goalId}/gates/${gateId}/reset`, { method: "POST" });
	const text = await res.text();
	let body: any = null;
	try { body = text ? JSON.parse(text) : null; } catch { body = text; }
	return { status: res.status, body };
}

const HUMAN = { whyBypassed: "Verification needs prod creds unavailable in CI", whoAmI: "overseer@example.com", isInitiatedByHuman: true };

test.describe("POST /api/goals/:goalId/gates/:gateId/bypass", () => {
	test("human bypass flips the gate to bypassed, persists audit signal, broadcasts", async () => {
		const wf = workflowId("gate-bypass-happy");
		await createWorkflow(wf, [
			{ id: "root", name: "Root", dependsOn: [], verify: [{ name: "ok", type: "command", run: "echo ok" }] },
		]);
		const goal = await createGoal({ title: `Gate Bypass Happy ${Date.now()}`, cwd: gitCwd(), workflowId: wf, worktree: false, team: false, autoStartTeam: false });
		const goalId = goal.id;
		let sessionId: string | undefined;
		let conn: WsConnection | undefined;
		try {
			await waitForGoalSetupReady(goalId);
			sessionId = await createSession({ goalId });
			conn = await connectWs(sessionId);

			const cursor = conn.messageCount();
			const res = await bypassGate(goalId, "root", HUMAN);
			expect(res.status, JSON.stringify(res.body)).toBe(200);
			expect(res.body.ok).toBe(true);
			expect(res.body.status).toBe("bypassed");
			expect(res.body.gateId).toBe("root");
			expect(res.body.whyBypassed).toBe(HUMAN.whyBypassed);
			expect(res.body.whoAmI).toBe(HUMAN.whoAmI);
			expect(res.body.bypassedAt).toBeTruthy();

			await conn.waitForFrom(cursor, (m) => m.type === "gate_status_changed" && m.goalId === goalId && m.gateId === "root" && m.status === "bypassed", 10_000);

			const gate = await getGate(goalId, "root");
			expect(gate.status).toBe("bypassed");
			const auditSignal = gate.signals.find((s: any) => s?.metadata?.bypass === "true");
			expect(auditSignal, "synthetic bypass audit signal must be persisted").toBeTruthy();
			expect(auditSignal.metadata.whyBypassed).toBe(HUMAN.whyBypassed);
			expect(auditSignal.metadata.whoAmI).toBe(HUMAN.whoAmI);
			expect(auditSignal.metadata.bypassedAt).toBeTruthy();
			expect(auditSignal.sessionId).toBe("human-bypass");
		} finally {
			conn?.close();
			if (sessionId) await deleteSession(sessionId).catch(() => {});
			await deleteGoal(goalId).catch(() => {});
			await deleteWorkflow(wf);
		}
	});

	test("GET /gates surfaces whyBypassed/whoAmI/bypassedAt on a bypassed gate", async () => {
		const wf = workflowId("gate-bypass-readmodel");
		await createWorkflow(wf, [
			{ id: "root", name: "Root", dependsOn: [], verify: [{ name: "ok", type: "command", run: "echo ok" }] },
		]);
		const goal = await createGoal({ title: `Gate Bypass ReadModel ${Date.now()}`, cwd: gitCwd(), workflowId: wf, worktree: false, team: false, autoStartTeam: false });
		const goalId = goal.id;
		try {
			await waitForGoalSetupReady(goalId);
			const res = await bypassGate(goalId, "root", HUMAN);
			expect(res.status, JSON.stringify(res.body)).toBe(200);

			const gates = await listGates(goalId);
			const root = gates.find((g) => g.gateId === "root");
			expect(root.status).toBe("bypassed");
			expect(root.whyBypassed).toBe(HUMAN.whyBypassed);
			expect(root.whoAmI).toBe(HUMAN.whoAmI);
			expect(root.bypassedAt).toBeTruthy();
		} finally {
			await deleteGoal(goalId).catch(() => {});
			await deleteWorkflow(wf);
		}
	});

	test("reset of a bypassed gate returns it to pending", async () => {
		const wf = workflowId("gate-bypass-reset");
		await createWorkflow(wf, [
			{ id: "root", name: "Root", dependsOn: [], verify: [{ name: "ok", type: "command", run: "echo ok" }] },
		]);
		const goal = await createGoal({ title: `Gate Bypass Reset ${Date.now()}`, cwd: gitCwd(), workflowId: wf, worktree: false, team: false, autoStartTeam: false });
		const goalId = goal.id;
		try {
			await waitForGoalSetupReady(goalId);
			expect((await bypassGate(goalId, "root", HUMAN)).status).toBe(200);
			expect((await getGate(goalId, "root")).status).toBe("bypassed");

			const reset = await resetGate(goalId, "root");
			expect(reset.status, JSON.stringify(reset.body)).toBe(200);
			await pollUntil(async () => (await getGate(goalId, "root")).status === "pending" ? true : null, { timeoutMs: 10_000, intervalMs: 50, label: "root pending after reset" });
		} finally {
			await deleteGoal(goalId).catch(() => {});
			await deleteWorkflow(wf);
		}
	});

	test("bypassed upstream unblocks a dependent gate signal", async () => {
		const wf = workflowId("gate-bypass-dep");
		await createWorkflow(wf, [
			{ id: "root", name: "Root", dependsOn: [], verify: [{ name: "ok", type: "command", run: "echo ok" }] },
			{ id: "child", name: "Child", dependsOn: ["root"], verify: [{ name: "ok", type: "command", run: "echo ok" }] },
		]);
		const goal = await createGoal({ title: `Gate Bypass Dep ${Date.now()}`, cwd: gitCwd(), workflowId: wf, worktree: false, team: false, autoStartTeam: false });
		const goalId = goal.id;
		try {
			await waitForGoalSetupReady(goalId);
			expect((await bypassGate(goalId, "root", HUMAN)).status).toBe(200);

			// Signalling the dependent gate must NOT be rejected with a 409
			// "upstream not passed" because the bypassed upstream counts as satisfied.
			const sig = await apiFetch(`/api/goals/${goalId}/gates/child/signal`, { method: "POST", body: JSON.stringify({}) });
			expect(sig.status, await sig.text().catch(() => "")).toBe(201);
		} finally {
			await deleteGoal(goalId).catch(() => {});
			await deleteWorkflow(wf);
		}
	});

	test("validation: isInitiatedByHuman:false → 400 guard; missing why/who → 400", async () => {
		const wf = workflowId("gate-bypass-validate");
		await createWorkflow(wf, [
			{ id: "root", name: "Root", dependsOn: [], verify: [{ name: "ok", type: "command", run: "echo ok" }] },
		]);
		const goal = await createGoal({ title: `Gate Bypass Validate ${Date.now()}`, cwd: gitCwd(), workflowId: wf, worktree: false, team: false, autoStartTeam: false });
		const goalId = goal.id;
		try {
			await waitForGoalSetupReady(goalId);

			const agent = await bypassGate(goalId, "root", { whyBypassed: "x", whoAmI: "y", isInitiatedByHuman: false });
			expect(agent.status).toBe(400);
			expect(agent.body.error).toBe("This method is currently intended for human use only. Bypassing a gate as an agent is not acting in the best interest of the outcome.");

			const noFlag = await bypassGate(goalId, "root", { whyBypassed: "x", whoAmI: "y" });
			expect(noFlag.status).toBe(400);

			const missingWhy = await bypassGate(goalId, "root", { whoAmI: "y", isInitiatedByHuman: true });
			expect(missingWhy.status).toBe(400);
			expect(missingWhy.body.error).toBe("whyBypassed is required");

			const blankWhy = await bypassGate(goalId, "root", { whyBypassed: "   ", whoAmI: "y", isInitiatedByHuman: true });
			expect(blankWhy.status).toBe(400);
			expect(blankWhy.body.error).toBe("whyBypassed is required");

			const missingWho = await bypassGate(goalId, "root", { whyBypassed: "x", isInitiatedByHuman: true });
			expect(missingWho.status).toBe(400);
			expect(missingWho.body.error).toBe("whoAmI is required");

			const blankWho = await bypassGate(goalId, "root", { whyBypassed: "x", whoAmI: "  ", isInitiatedByHuman: true });
			expect(blankWho.status).toBe(400);
			expect(blankWho.body.error).toBe("whoAmI is required");

			// Gate must remain pending after all rejected attempts.
			expect((await getGate(goalId, "root")).status).toBe("pending");
		} finally {
			await deleteGoal(goalId).catch(() => {});
			await deleteWorkflow(wf);
		}
	});

	test("unknown gate → 404; unknown goal → 404", async () => {
		const wf = workflowId("gate-bypass-404");
		await createWorkflow(wf, [
			{ id: "root", name: "Root", dependsOn: [], verify: [{ name: "ok", type: "command", run: "echo ok" }] },
		]);
		const goal = await createGoal({ title: `Gate Bypass 404 ${Date.now()}`, cwd: gitCwd(), workflowId: wf, worktree: false, team: false, autoStartTeam: false });
		const goalId = goal.id;
		try {
			await waitForGoalSetupReady(goalId);
			const unknownGate = await bypassGate(goalId, "does-not-exist", HUMAN);
			expect(unknownGate.status).toBe(404);

			const unknownGoal = await bypassGate("goal-does-not-exist", "root", HUMAN);
			expect(unknownGoal.status).toBe(404);
		} finally {
			await deleteGoal(goalId).catch(() => {});
			await deleteWorkflow(wf);
		}
	});

	test("denies sandbox-scoped tokens with 403", async ({ gateway }) => {
		const wf = workflowId("gate-bypass-sandbox");
		await createWorkflow(wf, [
			{ id: "root", name: "Root", dependsOn: [], verify: [{ name: "ok", type: "command", run: "echo ok" }] },
		]);
		const goal = await createGoal({ title: `Gate Bypass Sandbox ${Date.now()}`, cwd: gitCwd(), workflowId: wf, worktree: false, team: false, autoStartTeam: false });
		const goalId = goal.id;
		try {
			await waitForGoalSetupReady(goalId);
			const projectId = (goal.projectId as string | undefined) || await defaultProjectId();
			expect(projectId).toBeTruthy();
			const sandboxToken = gateway.sessionManager.sandboxTokenStore.register(projectId);
			gateway.sessionManager.sandboxTokenStore.addGoal(projectId, goalId);

			const res = await fetch(`${base()}/api/goals/${goalId}/gates/root/bypass`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: `Bearer ${sandboxToken}` },
				body: JSON.stringify(HUMAN),
			});
			expect(res.status).toBe(403);
		} finally {
			await deleteGoal(goalId).catch(() => {});
			await deleteWorkflow(wf);
		}
	});

	test("archived goal → 409", async () => {
		const wf = workflowId("gate-bypass-archived");
		await createWorkflow(wf, [
			{ id: "root", name: "Root", dependsOn: [], verify: [{ name: "ok", type: "command", run: "echo ok" }] },
		]);
		const goal = await createGoal({ title: `Gate Bypass Archived ${Date.now()}`, cwd: gitCwd(), workflowId: wf, worktree: false, team: false, autoStartTeam: false });
		const goalId = goal.id;
		try {
			await waitForGoalSetupReady(goalId);
			// DELETE archives the goal (sets archived=true). getGoalAcrossProjects
			// still resolves it, so bypass must reject with 409 (mirrors reset).
			await deleteGoal(goalId);
			await pollUntil(async () => {
				const r = await apiFetch(`/api/goals/${goalId}`);
				if (r.status !== 200) return null;
				const g = await r.json();
				return g.archived === true ? true : null;
			}, { timeoutMs: 10_000, intervalMs: 100, label: "goal archived" });

			const res = await bypassGate(goalId, "root", HUMAN);
			expect(res.status).toBe(409);
			expect(res.body.error).toBe("Goal is archived");
		} finally {
			await deleteWorkflow(wf);
		}
	});

	test("completion gating: agent team_complete blocked by bypassed gate; human confirm path succeeds", async () => {
		const wf = workflowId("gate-bypass-complete");
		await createWorkflow(wf, [
			{ id: "root", name: "Root", dependsOn: [], verify: [{ name: "ok", type: "command", run: "echo ok" }] },
		]);
		const goal = await createGoal({ title: `Gate Bypass Complete ${Date.now()}`, cwd: gitCwd(), workflowId: wf, worktree: false, team: true, autoStartTeam: false });
		const goalId = goal.id;
		let teamLeadId: string | undefined;
		try {
			await waitForGoalSetupReady(goalId);
			teamLeadId = await startTeam(goalId);

			expect((await bypassGate(goalId, "root", HUMAN)).status).toBe(200);

			// Without confirmBypassedGates → distinct 400 error.
			const blocked = await apiFetch(`/api/goals/${goalId}/team/complete`, { method: "POST", body: JSON.stringify({}) });
			const blockedBody = await blocked.json();
			expect(blocked.status).toBe(400);
			expect(String(blockedBody.error)).toContain("bypassed and require human confirmation");

			// With confirmBypassedGates:true → succeeds.
			const confirmed = await apiFetch(`/api/goals/${goalId}/team/complete`, { method: "POST", body: JSON.stringify({ confirmBypassedGates: true }) });
			const confirmedBody = await confirmed.json();
			expect(confirmed.status, JSON.stringify(confirmedBody)).toBe(200);
			expect(confirmedBody.ok).toBe(true);
		} finally {
			if (teamLeadId) await teardownTeam(goalId).catch(() => {});
			await deleteGoal(goalId).catch(() => {});
			await deleteWorkflow(wf);
		}
	});
});
