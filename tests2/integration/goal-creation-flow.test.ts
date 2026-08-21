import { test, expect } from "./_e2e/in-process-harness.js";
import { readE2EToken, base, apiFetch, nonGitCwd } from "./_e2e/e2e-setup.js";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>(done => { resolve = done; });
	return { promise, resolve };
}

/**
 * End-to-end tests for the goal creation flow — verifying:
 * 1. Goal-assistant sessions can be silently deleted (no confirmation needed server-side)
 * 2. POST /api/goals returns a goal with an id usable for dashboard navigation
 */

test.describe("Goal creation flow", () => {
	let token: string;

	test.beforeAll(() => {
		token = readE2EToken();
	});

	test("goal-assistant session can be silently deleted after goal creation", async () => {
		// Create a goal-assistant session
		const createRes = await apiFetch(`/api/sessions`, {
			method: "POST",
			body: JSON.stringify({ assistantType: "goal" }),
		});
		expect(createRes.ok).toBe(true);
		const { id: sessionId } = await createRes.json();

		// Create a goal (simulates what the UI does)
		const goalRes = await apiFetch(`/api/goals`, {
			method: "POST",
			body: JSON.stringify({ title: "Test goal for silent cleanup", cwd: nonGitCwd(), spec: "Test spec" }),
		});
		expect(goalRes.status).toBe(201);
		const goal = await goalRes.json();
		expect(goal.id).toBeTruthy();

		// Silently delete the goal-assistant session (no confirmation needed server-side)
		const deleteRes = await fetch(`${base()}/api/sessions/${sessionId}`, {
			method: "DELETE",
			headers: { Authorization: `Bearer ${token}` },
		});
		// Should succeed — either 200 or 204
		expect(deleteRes.status).toBeLessThan(300);

		// Verify the session is gone
		const listRes = await fetch(`${base()}/api/sessions`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		const data = await listRes.json();
		const sessions = Array.isArray(data) ? data : data.sessions ?? [];
		const found = sessions.find((s: any) => s.id === sessionId);
		expect(found).toBeUndefined();
	});

	test("revalidates workflow state changed while repository preflight is held", async ({ gateway }) => {
		const context = gateway.projectContextManager.getOrCreate(gateway.defaultProjectId)!;
		const workflowId = `held-preflight-${Date.now()}`;
		context.workflowStore.put({
			id: workflowId,
			name: "Held preflight",
			description: "Removed while repository support probing is held.",
			gates: [{ id: "implementation", name: "Implementation", dependsOn: [] }],
			createdAt: 0,
			updatedAt: 0,
		});
		const goalIdsBefore = new Set(context.goalStore.getAll().map((goal: { id: string }) => goal.id));
		const workflowCountBefore = context.workflowStore.getAll().length;
		const entered = deferred();
		const release = deferred();
		const manager = context.goalManager as any;
		const originalPreflight = manager.preflightGoalCreation.bind(manager);
		manager.preflightGoalCreation = async (...args: unknown[]) => {
			const result = await originalPreflight(...args);
			entered.resolve();
			await release.promise;
			return result;
		};
		try {
			const pending = apiFetch("/api/goals", {
				method: "POST",
				body: JSON.stringify({
					title: "Held preflight stale workflow",
					spec: "The selected workflow disappears before the final commit boundary.",
					projectId: gateway.defaultProjectId,
					cwd: nonGitCwd(),
					workflowId,
					autoStartTeam: false,
				}),
			});
			await entered.promise;
			context.workflowStore.remove(workflowId);
			release.resolve();
			const response = await pending;
			expect(response.status, await response.clone().text()).toBe(400);
			expect(await response.json()).toMatchObject({ code: "UNKNOWN_WORKFLOW" });
			expect(context.goalStore.getAll().filter((goal: { id: string }) => !goalIdsBefore.has(goal.id))).toEqual([]);
			expect(context.workflowStore.getAll()).toHaveLength(workflowCountBefore - 1);
		} finally {
			manager.preflightGoalCreation = originalPreflight;
			release.resolve();
			context.workflowStore.remove(workflowId);
		}
	});

	test("createGoal returns goal object with id for dashboard navigation", async () => {
		const goalRes = await apiFetch(`/api/goals`, {
			method: "POST",
			body: JSON.stringify({ title: "Navigation test goal", cwd: nonGitCwd(), spec: "Test" }),
		});
		expect(goalRes.status).toBe(201);
		const goal = await goalRes.json();

		// Goal must have an id that can be used for setHashRoute("goal-dashboard", goal.id)
		expect(goal.id).toBeTruthy();
		expect(typeof goal.id).toBe("string");
		expect(goal.title).toBe("Navigation test goal");

		// Verify the goal exists via GET
		const getRes = await fetch(`${base()}/api/goals/${goal.id}`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(getRes.ok).toBe(true);
		const fetched = await getRes.json();
		expect(fetched.id).toBe(goal.id);
	});

});
