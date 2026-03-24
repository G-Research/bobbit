import { test, expect } from "@playwright/test";
import { readE2EToken, BASE } from "./e2e-setup.js";

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
		const createRes = await fetch(`${BASE}/api/sessions`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ assistantType: "goal" }),
		});
		expect(createRes.ok).toBe(true);
		const { id: sessionId } = await createRes.json();

		// Create a goal (simulates what the UI does)
		const goalRes = await fetch(`${BASE}/api/goals`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ title: "Test goal for silent cleanup", cwd: ".", spec: "Test spec" }),
		});
		expect(goalRes.status).toBe(201);
		const goal = await goalRes.json();
		expect(goal.id).toBeTruthy();

		// Silently delete the goal-assistant session (no confirmation needed server-side)
		const deleteRes = await fetch(`${BASE}/api/sessions/${sessionId}`, {
			method: "DELETE",
			headers: { Authorization: `Bearer ${token}` },
		});
		// Should succeed — either 200 or 204
		expect(deleteRes.status).toBeLessThan(300);

		// Verify the session is gone
		const listRes = await fetch(`${BASE}/api/sessions`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		const data = await listRes.json();
		const sessions = Array.isArray(data) ? data : data.sessions ?? [];
		const found = sessions.find((s: any) => s.id === sessionId);
		expect(found).toBeUndefined();
	});

	test("createGoal returns goal object with id for dashboard navigation", async () => {
		const goalRes = await fetch(`${BASE}/api/goals`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ title: "Navigation test goal", cwd: ".", spec: "Test" }),
		});
		expect(goalRes.status).toBe(201);
		const goal = await goalRes.json();

		// Goal must have an id that can be used for setHashRoute("goal-dashboard", goal.id)
		expect(goal.id).toBeTruthy();
		expect(typeof goal.id).toBe("string");
		expect(goal.title).toBe("Navigation test goal");

		// Verify the goal exists via GET
		const getRes = await fetch(`${BASE}/api/goals/${goal.id}`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(getRes.ok).toBe(true);
		const fetched = await getRes.json();
		expect(fetched.id).toBe(goal.id);
	});
});
