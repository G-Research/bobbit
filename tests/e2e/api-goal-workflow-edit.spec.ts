import { test, expect } from "./in-process-harness.js";
import {
	apiFetch,
	defaultProjectId,
	deleteGoal,
	nonGitCwd,
} from "./e2e-setup.js";
import { pollUntil } from "./test-utils/cleanup.js";

type Workflow = {
	id: string;
	name: string;
	description: string;
	gates: Array<Record<string, any>>;
	createdAt?: number;
	updatedAt?: number;
};

function workflowId(): string {
	return `workflow-edit-http-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function originalWorkflow(): Workflow {
	return {
		id: workflowId(),
		name: "HTTP lifecycle original",
		description: "Original frozen goal workflow",
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
		name: "HTTP lifecycle replacement",
		description: "Replacement persisted through PUT",
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
				name: "Added slow verification",
				dependsOn: ["retain"],
				metadata: {
					artifact: "Artifact identifier",
					owner: "Responsible owner",
				},
				verify: [{
					name: "Slow command",
					type: "command",
					run: "node -e \"setTimeout(()=>process.exit(0),10000)\"",
					expect: "success",
					timeout: 30,
					phase: 0,
					description: "Keeps verification active while PUT conflict handling is exercised",
				}],
			},
		],
	};
}

async function createGoal(workflow: Workflow): Promise<any> {
	const projectId = await defaultProjectId();
	if (!projectId) throw new Error("workflow edit E2E requires a default project");
	const response = await apiFetch("/api/goals", {
		method: "POST",
		body: JSON.stringify({
			title: `Workflow Edit HTTP ${Date.now()}`,
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

async function waitForGateStatus(goalId: string, gateId: string, status: string): Promise<any> {
	return pollUntil(async () => {
		const response = await apiFetch(`/api/goals/${goalId}/gates/${gateId}`);
		if (!response.ok) return null;
		const gate = await response.json();
		return gate.status === status ? gate : null;
	}, { timeoutMs: 15_000, intervalMs: 50, label: `gate ${gateId} status=${status}` });
}

async function waitForRunningVerification(goalId: string, gateId: string): Promise<any> {
	return pollUntil(async () => {
		const response = await apiFetch(`/api/goals/${goalId}/verifications/active`);
		if (!response.ok) return null;
		const body = await response.json();
		return body.verifications?.find(
			(verification: any) => verification.gateId === gateId && verification.overallStatus === "running",
		) ?? null;
	}, { timeoutMs: 15_000, intervalMs: 50, label: `running verification ${goalId}/${gateId}` });
}

async function waitForNoRunningVerification(goalId: string, gateId: string): Promise<boolean> {
	return pollUntil(async () => {
		const response = await apiFetch(`/api/goals/${goalId}/verifications/active`);
		if (!response.ok) return null;
		const body = await response.json();
		const running = body.verifications?.some(
			(verification: any) => verification.gateId === gateId && verification.overallStatus === "running",
		);
		return running ? null : true;
	}, { timeoutMs: 10_000, intervalMs: 50, label: `verification ${goalId}/${gateId} stopped` });
}

test.describe.configure({ mode: "serial" });

test.describe("PUT /api/goals/:goalId/workflow HTTP lifecycle", () => {
	test.setTimeout(60_000);

	test("persists replacement, reconciles gates, rejects invalid input, and protects active verification @smoke", async () => {
		const goal = await createGoal(originalWorkflow());
		let verificationStarted = false;
		try {
			const signalResponse = await apiFetch(`/api/goals/${goal.id}/gates/retain/signal`, {
				method: "POST",
				body: JSON.stringify({ content: "# Retained signal history" }),
			});
			expect(signalResponse.status, await signalResponse.clone().text()).toBe(201);
			const retainedBefore = await waitForGateStatus(goal.id, "retain", "passed");
			expect(retainedBefore.signals).toHaveLength(1);

			const before = (await readGoal(goal.id)).workflow;
			const replacement = replacementWorkflow(before.id);
			const putResponse = await putWorkflow(goal.id, replacement);
			expect(putResponse.status, await putResponse.clone().text()).toBe(200);
			const replaced = await putResponse.json();

			expect(replaced).toMatchObject({
				id: before.id,
				name: "HTTP lifecycle replacement",
				description: "Replacement persisted through PUT",
			});
			expect(replaced.createdAt).toBe(before.createdAt);
			expect(replaced.updatedAt).toBeGreaterThanOrEqual(before.updatedAt);
			expect(replaced.gates.map((gate: any) => gate.id)).toEqual(["retain", "added"]);
			expect(replaced.gates[1]).toMatchObject({
				dependsOn: ["retain"],
				metadata: {
					artifact: "Artifact identifier",
					owner: "Responsible owner",
				},
			});
			expect(replaced.gates[1].verify[0]).toMatchObject({
				type: "command",
				run: "node -e \"setTimeout(()=>process.exit(0),10000)\"",
				expect: "success",
				timeout: 30,
				phase: 0,
				description: "Keeps verification active while PUT conflict handling is exercised",
			});
			expect((await readGoal(goal.id)).workflow).toEqual(replaced);

			const retainedAfter = await readGate(goal.id, "retain");
			expect(retainedAfter.status).toBe("passed");
			expect(retainedAfter.signals).toEqual(retainedBefore.signals);
			expect(retainedAfter.currentContent).toBe(retainedBefore.currentContent);
			expect((await apiFetch(`/api/goals/${goal.id}/gates/remove`)).status).toBe(404);
			const added = await readGate(goal.id, "added");
			expect(added.status).toBe("pending");
			expect(added.signals).toEqual([]);

			const invalidTimeout = structuredClone(replaced);
			invalidTimeout.gates[1].verify[0].timeout = 0;
			let invalidResponse = await putWorkflow(goal.id, invalidTimeout);
			expect(invalidResponse.status, await invalidResponse.clone().text()).toBe(400);
			expect((await readGoal(goal.id)).workflow).toEqual(replaced);

			const invalidDependency = structuredClone(replaced);
			invalidDependency.gates[1].dependsOn = ["missing-gate"];
			invalidResponse = await putWorkflow(goal.id, invalidDependency);
			expect(invalidResponse.status, await invalidResponse.clone().text()).toBe(400);
			expect((await readGoal(goal.id)).workflow).toEqual(replaced);

			const slowSignal = await apiFetch(`/api/goals/${goal.id}/gates/added/signal`, {
				method: "POST",
				body: JSON.stringify({}),
			});
			expect(slowSignal.status, await slowSignal.clone().text()).toBe(201);
			await waitForRunningVerification(goal.id, "added");
			verificationStarted = true;

			const modifiedActive = structuredClone(replaced);
			modifiedActive.name = "Attempted active modification";
			modifiedActive.gates[1].name = "Changed while active";
			let conflictResponse = await putWorkflow(goal.id, modifiedActive);
			expect(conflictResponse.status, await conflictResponse.clone().text()).toBe(409);
			expect((await readGoal(goal.id)).workflow).toEqual(replaced);

			const removedActive = structuredClone(replaced);
			removedActive.name = "Attempted active removal";
			removedActive.gates = removedActive.gates.filter((gate: any) => gate.id !== "added");
			conflictResponse = await putWorkflow(goal.id, removedActive);
			expect(conflictResponse.status, await conflictResponse.clone().text()).toBe(409);
			expect((await readGoal(goal.id)).workflow).toEqual(replaced);
			expect((await readGate(goal.id, "added")).status).toBe("running");

			const cancelResponse = await apiFetch(`/api/goals/${goal.id}/gates/added/cancel-verification`, {
				method: "POST",
			});
			expect(cancelResponse.status).toBe(200);
			expect((await cancelResponse.json()).cancelled).toBe(true);
			await waitForNoRunningVerification(goal.id, "added");
			verificationStarted = false;
			expect((await readGoal(goal.id)).workflow).toEqual(replaced);
		} finally {
			if (verificationStarted) {
				await apiFetch(`/api/goals/${goal.id}/gates/added/cancel-verification`, { method: "POST" }).catch(() => {});
			}
			await deleteGoal(goal.id).catch(() => {});
		}
	});
});
