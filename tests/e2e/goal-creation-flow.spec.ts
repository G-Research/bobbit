import { test, expect } from "./gateway-harness.js";
import { readE2EToken, base } from "./e2e-setup.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * End-to-end tests for the goal creation flow — verifying:
 * 1. Goal-assistant sessions can be silently deleted (no confirmation needed server-side)
 * 2. POST /api/goals returns a goal with an id usable for dashboard navigation
 * 3. Source code doesn't use terminateSession in doSave (which shows confirmation dialog)
 * 4. Source code navigates to goal-dashboard after goal creation, not landing
 */

test.describe("Goal creation flow", () => {
	let token: string;

	test.beforeAll(() => {
		token = readE2EToken();
	});

	test("goal-assistant session can be silently deleted after goal creation", async () => {
		// Create a goal-assistant session
		const createRes = await fetch(`${base()}/api/sessions`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ assistantType: "goal" }),
		});
		expect(createRes.ok).toBe(true);
		const { id: sessionId } = await createRes.json();

		// Create a goal (simulates what the UI does)
		const goalRes = await fetch(`${base()}/api/goals`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ title: "Test goal for silent cleanup", cwd: ".", spec: "Test spec" }),
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

	test("createGoal returns goal object with id for dashboard navigation", async () => {
		const goalRes = await fetch(`${base()}/api/goals`, {
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
		const getRes = await fetch(`${base()}/api/goals/${goal.id}`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(getRes.ok).toBe(true);
		const fetched = await getRes.json();
		expect(fetched.id).toBe(goal.id);
	});

	test("goal proposal panel handleCreateGoal does not call terminateSession (no confirmation dialog)", () => {
		// The goal proposal flow moved from a modal in dialogs.ts to an inline panel in render.ts.
		// Verify the inline panel's handleCreateGoal calls createGoal without terminateSession.
		const renderPath = path.resolve(__dirname, "../../src/app/render.ts");
		const source = fs.readFileSync(renderPath, "utf-8");

		// Find the goalProposalPanel section by locating the second handleCreateGoal
		// (the first one is in the goal-assistant panel; the second is in the proposal panel)
		const allMatches = [...source.matchAll(/const handleCreateGoal = async \(\) => \{/g)];
		expect(allMatches.length).toBeGreaterThanOrEqual(2);

		// Extract the body of the second handleCreateGoal (the proposal panel one)
		const secondMatch = allMatches[1];
		const start = secondMatch.index! + secondMatch[0].length;
		const chunk = source.slice(start, start + 1500);

		// Must call createGoal
		expect(chunk).toContain("createGoal");

		// Must NOT call terminateSession (which shows a confirmation dialog)
		expect(chunk).not.toContain("terminateSession");
	});

	test("render.ts handleCreateGoal navigates to goal-dashboard, not landing", () => {
		// Read the source file and verify navigation target
		const renderPath = path.resolve(__dirname, "../../src/app/render.ts");
		const source = fs.readFileSync(renderPath, "utf-8");

		// Find the handleCreateGoal function
		const fnMatch = source.match(/const handleCreateGoal = async \(\) => \{([\s\S]*?)^\t\};/m);
		expect(fnMatch).toBeTruthy();
		const fnBody = fnMatch![1];

		// The bug: navigated to "landing" before createGoal returned
		// The fix: navigates to "goal-dashboard" after createGoal returns
		expect(fnBody).toContain('setHashRoute("goal-dashboard"');

		// Verify it doesn't navigate to landing as the primary path
		// (landing is acceptable as fallback when goal creation fails)
		const goalDashboardIdx = fnBody.indexOf('setHashRoute("goal-dashboard"');
		const landingIdx = fnBody.indexOf('setHashRoute("landing"');

		if (landingIdx !== -1) {
			// If landing exists, it should be AFTER goal-dashboard (as a fallback)
			expect(goalDashboardIdx).toBeLessThan(landingIdx);
		}
	});
});
