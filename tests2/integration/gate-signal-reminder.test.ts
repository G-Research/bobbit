// Opt into the non-spawning command-step runner before the shared gateway can
// boot, regardless of which of these integration files Vitest imports first.
import { resetAndInstallFakeCommandStepTestState } from "./_e2e/fake-cmd-setup.js";

import { test, expect } from "./_e2e/in-process-harness.js";
import { apiFetch, createGoal, deleteGoal } from "./_e2e/e2e-setup.js";

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

async function waitForPassedSignal(gateway: any, goalId: string, gateId: string, signalId: string): Promise<any> {
	// Cache lookup reads the project-scoped gate store. Wait for that exact
	// source of truth rather than a derived gate status or an HTTP projection.
	for (let turn = 0; turn < 100; turn++) {
		const signal = gateway.projectContextManager.getContextForGoal(goalId)?.gateStore
			.getGate(goalId, gateId)?.signals.find((entry: any) => entry.id === signalId);
		if (signal?.verification?.status === "passed") return signal;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	throw new Error(`signal ${signalId} did not reach stored passed state within 100 event-loop turns`);
}

async function waitForGoalSetupReady(goalId: string): Promise<any> {
	for (let turn = 0; turn < 100; turn++) {
		const res = await apiFetch(`/api/goals/${goalId}`);
		if (res.ok) {
			const goal = await res.json();
			if (goal.setupStatus === "error") throw new Error(`Goal setup failed: ${JSON.stringify(goal)}`);
			if (goal.setupStatus === "ready") return goal;
		}
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	throw new Error(`goal ${goalId} setup did not become ready within 100 event-loop turns`);
}

function fakeGateCommitSha(gateway: any, sha = "0123456789abcdef0123456789abcdef01234567"): () => void {
	// createGateway installs one CommandRunner object process-wide; TeamManager
	// retains that same DI object. Script only the route's read-only commit probe
	// so cache coverage needs neither a git subprocess nor a repository fixture.
	const runner = gateway.teamManager.commandRunner;
	const original = runner.execFile;
	runner.execFile = async function (file: string, args: readonly string[], options?: unknown) {
		if (/^(?:git|git\.exe)$/i.test(file) && args.length === 2 && args[0] === "rev-parse" && args[1] === "HEAD") {
			return { stdout: sha, stderr: "" };
		}
		return original.call(this, file, args, options);
	};
	return () => { runner.execFile = original; };
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
	test.beforeEach(async ({ gateway }) => resetAndInstallFakeCommandStepTestState(gateway));
	test.afterEach(async ({ gateway }) => resetAndInstallFakeCommandStepTestState(gateway));

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

	test("cached pass response does not include the async wait reminder", async ({ gateway }) => {
		const wf = workflowId("gate-signal-reminder-cache");
		await createWorkflow(wf, [
			{
				id: "cached-gate",
				name: "Cached Gate",
				dependsOn: [],
				verify: [
					{ name: "Fast cached verification", type: "command", run: "echo cache-seed" },
				],
			},
		]);

		const commitSha = "0123456789abcdef0123456789abcdef01234567";
		const restoreCommitSha = fakeGateCommitSha(gateway, commitSha);
		const goal = await createGoal({ title: `Gate Signal Reminder Cache ${Date.now()}`, workflowId: wf, worktree: false, team: false, autoStartTeam: false });
		const goalId = goal.id;
		try {
			await waitForGoalSetupReady(goalId);
			const firstBody = await signalGate(goalId, "cached-gate");
			expect(firstBody.signal.status).toBe("running");

			// Complete the fake command on the shared manual clock, then prove the
			// exact persisted record used by the route cache is a reusable pass.
			gateway.clock.advance(0);
			const cacheSeed = await waitForPassedSignal(gateway, goalId, "cached-gate", firstBody.signal.id);
			expect(cacheSeed.commitSha).toBe(commitSha);
			expect(cacheSeed.verification.steps).toEqual([
				expect.objectContaining({ name: "Fast cached verification", status: "passed" }),
			]);

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
			restoreCommitSha();
			await deleteGoal(goalId).catch(() => {});
			await deleteWorkflow(wf);
		}
	});
});
