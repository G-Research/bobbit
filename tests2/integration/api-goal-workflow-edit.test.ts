import { test, expect } from "./_e2e/in-process-harness.js";
import {
	apiFetch,
	defaultProjectId,
	deleteGoal,
	nonGitCwd,
} from "./_e2e/e2e-setup.js";

type Workflow = {
	id: string;
	name: string;
	description: string;
	gates: Array<Record<string, any>>;
	createdAt?: number;
	updatedAt?: number;
};

function uniqueId(prefix: string): string {
	return `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function initialWorkflow(id = uniqueId("goal-workflow-edit")): Workflow {
	return {
		id,
		name: "Original workflow",
		description: "Snapshot before replacement",
		gates: [
			{
				id: "retain",
				name: "Retain",
				dependsOn: [],
				content: true,
				injectDownstream: true,
			},
			{
				id: "remove",
				name: "Remove",
				dependsOn: ["retain"],
			},
		],
	};
}

function replacementWorkflow(id: string): Workflow {
	return {
		id,
		name: "Replacement workflow",
		description: "Complete replacement with nested gate and verification metadata",
		gates: [
			{
				id: "retain",
				name: "Retain",
				dependsOn: [],
				content: true,
				injectDownstream: true,
			},
			{
				id: "added",
				name: "Added",
				dependsOn: ["retain"],
				optional: true,
				manual: true,
				metadata: {
					artifact: "Artifact identifier",
					owner: "Responsible owner",
				},
				verify: [
					{
						name: "Command check",
						type: "command",
						run: "echo replacement-command",
						expect: "success",
						timeout: 7,
						phase: 0,
						optional: true,
						optionalLabel: "Run command check",
						description: "Representative command metadata",
					},
					{
						name: "Review check",
						type: "llm-review",
						prompt: "Review the replacement snapshot.",
						role: "reviewer",
						phase: 1,
						description: "Representative reviewer metadata",
					},
					{
						name: "Child check",
						type: "subgoal",
						phase: 2,
						description: "Representative nested subgoal metadata",
						subgoal: {
							planId: "child-plan",
							title: "Child verification",
							spec: "Verify the nested replacement payload and report the result.",
							workflowId: "feature",
							suggestedRole: "test-engineer",
							dependsOn: [],
						},
					},
				],
			},
		],
	};
}

async function createGoalWithWorkflow(workflow = initialWorkflow()): Promise<any> {
	const projectId = await defaultProjectId();
	if (!projectId) throw new Error("workflow edit test requires a default project");
	const response = await apiFetch("/api/goals", {
		method: "POST",
		body: JSON.stringify({
			title: `Workflow Edit ${Date.now()}`,
			cwd: nonGitCwd(),
			projectId,
			workflowId: workflow.id,
			workflow,
			team: false,
			autoStartTeam: false,
			worktree: false,
		}),
	});
	expect(response.status, await response.clone().text()).toBe(201);
	return response.json();
}

async function readGoal(goalId: string): Promise<any> {
	const response = await apiFetch(`/api/goals/${goalId}`);
	expect(response.status).toBe(200);
	return response.json();
}

async function readGate(goalId: string, gateId: string): Promise<any> {
	const response = await apiFetch(`/api/goals/${goalId}/gates/${gateId}`);
	expect(response.status).toBe(200);
	return response.json();
}

async function putWorkflow(goalId: string, workflow: Workflow): Promise<Response> {
	return apiFetch(`/api/goals/${goalId}/workflow`, {
		method: "PUT",
		body: JSON.stringify(workflow),
	});
}

function seedRunningVerification(gateway: any, goalId: string, gateId: string): () => void {
	const harness = gateway.sessionManager._verificationHarness;
	expect(harness, "verification harness must be wired").toBeTruthy();
	const active: Map<string, any> = harness.activeVerifications;
	expect(active instanceof Map, "active-verification map must be available to the fixture").toBe(true);
	const signalId = uniqueId("active-signal");
	active.set(signalId, {
		goalId,
		gateId,
		signalId,
		steps: [{
			name: "Active check",
			type: "command",
			status: "running",
			startedAt: Date.now(),
		}],
		overallStatus: "running",
		startedAt: Date.now(),
	});
	return () => active.delete(signalId);
}

function removeWorkflowSnapshot(gateway: any, goalId: string): void {
	for (const context of gateway.projectContextManager.visible()) {
		const goal = context.goalStore.get(goalId);
		if (!goal) continue;
		context.goalStore.update(goalId, { workflow: undefined });
		goal.workflow = undefined;
		return;
	}
	throw new Error(`goal ${goalId} was not found in a project context`);
}

test.describe("PUT /api/goals/:goalId/workflow", () => {
	test("persists a full snapshot and reconciles retained, removed, and new gates", async () => {
		const goal = await createGoalWithWorkflow();
		try {
			const signalResponse = await apiFetch(`/api/goals/${goal.id}/gates/retain/signal`, {
				method: "POST",
				body: JSON.stringify({ content: "# Retained audit history" }),
			});
			expect(signalResponse.status, await signalResponse.clone().text()).toBe(201);
			const retainedBefore = await readGate(goal.id, "retain");
			expect(retainedBefore.status).toBe("passed");
			expect(retainedBefore.signals).toHaveLength(1);

			const original = (await readGoal(goal.id)).workflow;
			const response = await putWorkflow(goal.id, replacementWorkflow(original.id));
			expect(response.status, await response.clone().text()).toBe(200);
			const replaced = await response.json();

			expect(replaced.id).toBe(original.id);
			expect(replaced.createdAt).toBe(original.createdAt);
			expect(replaced.updatedAt).toBeGreaterThanOrEqual(original.updatedAt);
			expect(replaced.name).toBe("Replacement workflow");
			expect(replaced.gates.map((gate: any) => gate.id)).toEqual(["retain", "added"]);
			expect(replaced.gates[1]).toMatchObject({
				optional: true,
				manual: true,
				metadata: {
					artifact: "Artifact identifier",
					owner: "Responsible owner",
				},
			});
			expect(replaced.gates[1].verify[0]).toMatchObject({
				type: "command",
				run: "echo replacement-command",
				expect: "success",
				timeout: 7,
				phase: 0,
				optional: true,
				optionalLabel: "Run command check",
				description: "Representative command metadata",
			});
			expect(replaced.gates[1].verify[1]).toMatchObject({
				type: "llm-review",
				prompt: "Review the replacement snapshot.",
				role: "reviewer",
				phase: 1,
				description: "Representative reviewer metadata",
			});
			expect(replaced.gates[1].verify[2].subgoal).toEqual({
				planId: "child-plan",
				title: "Child verification",
				spec: "Verify the nested replacement payload and report the result.",
				workflowId: "feature",
				suggestedRole: "test-engineer",
				dependsOn: [],
			});

			const persisted = (await readGoal(goal.id)).workflow;
			expect(persisted).toEqual(replaced);

			const retainedAfter = await readGate(goal.id, "retain");
			expect(retainedAfter.status).toBe("passed");
			expect(retainedAfter.signals).toEqual(retainedBefore.signals);
			expect(retainedAfter.currentContent).toBe(retainedBefore.currentContent);

			const removedResponse = await apiFetch(`/api/goals/${goal.id}/gates/remove`);
			expect(removedResponse.status).toBe(404);
			const added = await readGate(goal.id, "added");
			expect(added.status).toBe("pending");
			expect(added.signals).toEqual([]);
		} finally {
			await deleteGoal(goal.id).catch(() => {});
		}
	});

	test("rejects malformed snapshots with 400 and leaves workflow and gates unchanged", async () => {
		const goal = await createGoalWithWorkflow();
		try {
			const beforeGoal = await readGoal(goal.id);
			const beforeGatesResponse = await apiFetch(`/api/goals/${goal.id}/gates`);
			const beforeGates = await beforeGatesResponse.json();

			const invalidSnapshots: Workflow[] = [
				{
					...replacementWorkflow(beforeGoal.workflow.id),
					gates: [{
						id: "bad-timeout",
						name: "Bad timeout",
						dependsOn: [],
						verify: [{ name: "Bad", type: "command", run: "echo bad", timeout: 0 }],
					}],
				},
				{
					...replacementWorkflow(beforeGoal.workflow.id),
					gates: [{ id: "dangling", name: "Dangling", dependsOn: ["missing"] }],
				},
			];

			for (const invalid of invalidSnapshots) {
				const response = await putWorkflow(goal.id, invalid);
				expect(response.status, await response.clone().text()).toBe(400);
				expect((await readGoal(goal.id)).workflow).toEqual(beforeGoal.workflow);
				const gatesResponse = await apiFetch(`/api/goals/${goal.id}/gates`);
				expect(await gatesResponse.json()).toEqual(beforeGates);
			}
		} finally {
			await deleteGoal(goal.id).catch(() => {});
		}
	});

	test("returns 400 when the goal has no workflow snapshot", async ({ gateway }) => {
		const goal = await createGoalWithWorkflow();
		try {
			removeWorkflowSnapshot(gateway, goal.id);
			const response = await putWorkflow(goal.id, replacementWorkflow(goal.workflowId));
			expect(response.status, await response.clone().text()).toBe(400);
			expect((await readGoal(goal.id)).workflow).toBeUndefined();
		} finally {
			await deleteGoal(goal.id).catch(() => {});
		}
	});

	test("blocks modified and removed active gates but permits an unchanged active gate", async ({ gateway }) => {
		const workflow = initialWorkflow();
		workflow.gates[0].verify = [{ name: "Active check", type: "command", run: "echo active" }];
		const goal = await createGoalWithWorkflow(workflow);
		const clearActive = seedRunningVerification(gateway, goal.id, "retain");
		try {
			const before = (await readGoal(goal.id)).workflow;

			const modified = structuredClone(before);
			modified.name = "Attempted active modification";
			modified.gates[0].name = "Changed active gate";
			let response = await putWorkflow(goal.id, modified);
			expect(response.status, await response.clone().text()).toBe(409);
			expect((await readGoal(goal.id)).workflow).toEqual(before);

			const removed = structuredClone(before);
			removed.name = "Attempted active removal";
			removed.gates = removed.gates.filter((gate: any) => gate.id !== "retain");
			removed.gates[0].dependsOn = [];
			response = await putWorkflow(goal.id, removed);
			expect(response.status, await response.clone().text()).toBe(409);
			expect((await readGoal(goal.id)).workflow).toEqual(before);

			const unchangedActive = structuredClone(before);
			unchangedActive.name = "Allowed unrelated replacement";
			unchangedActive.gates = [
				unchangedActive.gates.find((gate: any) => gate.id === "retain"),
				{ id: "unrelated", name: "Unrelated", dependsOn: ["retain"] },
			];
			response = await putWorkflow(goal.id, unchangedActive);
			expect(response.status, await response.clone().text()).toBe(200);
			const accepted = await response.json();
			expect(accepted.gates.map((gate: any) => gate.id)).toEqual(["retain", "unrelated"]);
			expect((await readGoal(goal.id)).workflow).toEqual(accepted);
			expect((await readGate(goal.id, "retain")).status).toBe("pending");
			expect((await readGate(goal.id, "unrelated")).status).toBe("pending");
			expect((await apiFetch(`/api/goals/${goal.id}/gates/remove`)).status).toBe(404);
		} finally {
			clearActive();
			await deleteGoal(goal.id).catch(() => {});
		}
	});
});
