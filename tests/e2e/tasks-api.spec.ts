import { test, expect } from "@playwright/test";
import { readE2EToken, BASE, nonGitCwd } from "./e2e-setup.js";
let token: string;

async function apiFetch(path: string, opts?: RequestInit): Promise<Response> {
	return fetch(`${BASE}${path}`, {
		...opts,
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
			...(opts?.headers || {}),
		},
	});
}

test.beforeAll(async () => {
	token = readE2EToken();
});

let goalId: string;

test.beforeEach(async () => {
	// Create a fresh goal for each test
	const resp = await apiFetch("/api/goals", {
		method: "POST",
		body: JSON.stringify({
			title: "Test Goal " + Date.now(),
			spec: "Test spec",
			cwd: nonGitCwd(),
			team: true,
			worktree: false,
		}),
	});
	const goal = await resp.json();
	goalId = goal.id;
});

test.afterEach(async () => {
	if (goalId) {
		await apiFetch(`/api/goals/${goalId}`, { method: "DELETE" });
	}
});

test.describe("Task creation — no artifact enforcement", () => {
	test("allows any task type without artifact requirements", async () => {
		// Task creation no longer enforces artifact requirements
		const resp = await apiFetch(`/api/goals/${goalId}/tasks`, {
			method: "POST",
			body: JSON.stringify({
				title: "Implement feature X",
				type: "implementation",
				spec: "Build the thing",
			}),
		});
		expect(resp.status).toBe(201);
		const task = await resp.json();
		expect(task.id).toBeTruthy();
	});

	test("accepts any task type string", async () => {
		const resp = await apiFetch(`/api/goals/${goalId}/tasks`, {
			method: "POST",
			body: JSON.stringify({
				title: "Custom type",
				type: "my-custom-type",
			}),
		});
		expect(resp.status).toBe(201);
	});
});

test.describe("Skills API", () => {
	test("GET /api/skills returns skill definitions", async () => {
		const resp = await apiFetch("/api/skills");
		expect(resp.status).toBe(200);
		const { skills } = await resp.json();
		expect(Array.isArray(skills)).toBe(true);
		// Should have the built-in skills
		const ids = skills.map((s: any) => s.id);
		expect(ids).toContain("correctness-review");
		expect(ids).toContain("security-review");
		expect(ids).toContain("design-review");
		expect(ids).toContain("test-suite-report");
	});
});
