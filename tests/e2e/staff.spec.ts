import { test, expect } from "@playwright/test";
import { readE2EToken, BASE, nonGitCwd } from "./e2e-setup.js";

/**
 * End-to-end tests for the Staff Agents feature (persistent session model).
 *
 * Each staff agent has a single permanent session created at staff creation time.
 * Wake cycles enqueue prompts on the existing session instead of creating new ones.
 *
 * Run with:
 *   npm run build:server && npx playwright test tests/e2e/staff.spec.ts --config playwright-e2e.config.ts
 */

const GW_URL = BASE;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function apiCreateStaff(
	token: string,
	data: {
		name: string;
		description?: string;
		systemPrompt: string;
		cwd?: string;
		triggers?: Array<{ type: string; config: Record<string, unknown>; enabled: boolean; prompt?: string }>;
	},
): Promise<any> {
	const res = await fetch(`${GW_URL}/api/staff`, {
		method: "POST",
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
		body: JSON.stringify(data),
	});
	expect(res.status).toBe(201);
	return res.json();
}

async function apiDeleteStaff(token: string, id: string): Promise<void> {
	await fetch(`${GW_URL}/api/staff/${id}`, {
		method: "DELETE",
		headers: { Authorization: `Bearer ${token}` },
	}).catch(() => {});
}

async function apiDeleteSession(token: string, id: string): Promise<void> {
	await fetch(`${GW_URL}/api/sessions/${id}`, {
		method: "DELETE",
		headers: { Authorization: `Bearer ${token}` },
	}).catch(() => {});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("Staff Agents — REST API", () => {
	let token: string;
	const cleanupStaffIds: string[] = [];
	const cleanupSessionIds: string[] = [];

	test.beforeAll(() => {
		token = readE2EToken();
	});

	test.afterAll(async () => {
		for (const id of cleanupSessionIds) {
			await apiDeleteSession(token, id);
		}
		for (const id of cleanupStaffIds) {
			await apiDeleteStaff(token, id);
		}
	});

	test("POST /api/staff creates a staff agent with defaults and a permanent session", async () => {
		const staff = await apiCreateStaff(token, {
			name: "Test Warden",
			description: "A test staff agent",
			systemPrompt: "You are a test warden.",
			cwd: nonGitCwd(),
		});
		cleanupStaffIds.push(staff.id);
		if (staff.currentSessionId) cleanupSessionIds.push(staff.currentSessionId);

		expect(staff.id).toBeTruthy();
		expect(staff.name).toBe("Test Warden");
		expect(staff.description).toBe("A test staff agent");
		expect(staff.systemPrompt).toBe("You are a test warden.");
		expect(staff.state).toBe("active");
		expect(staff.triggers).toEqual([]);
		expect(staff.memory).toBe("");
		expect(staff.createdAt).toBeGreaterThan(0);
		expect(staff.updatedAt).toBeGreaterThan(0);

		// Persistent session model: session is created with the staff agent
		expect(staff.currentSessionId).toBeTruthy();

		// Verify the session exists and is linked to the staff agent
		const sessionRes = await fetch(`${GW_URL}/api/sessions/${staff.currentSessionId}`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(sessionRes.ok).toBe(true);
		const session = await sessionRes.json();
		expect(session.staffId).toBe(staff.id);
	});

	test("POST /api/staff with missing name returns 400", async () => {
		const res = await fetch(`${GW_URL}/api/staff`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ systemPrompt: "test" }),
		});
		expect(res.status).toBe(400);
	});

	test("POST /api/staff with missing systemPrompt returns 400", async () => {
		const res = await fetch(`${GW_URL}/api/staff`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ name: "No Prompt" }),
		});
		expect(res.status).toBe(400);
	});

	test("GET /api/staff lists created staff agents", async () => {
		const staff = await apiCreateStaff(token, {
			name: "Listable Agent",
			systemPrompt: "You are listable.",
			cwd: nonGitCwd(),
		});
		cleanupStaffIds.push(staff.id);
		if (staff.currentSessionId) cleanupSessionIds.push(staff.currentSessionId);

		const res = await fetch(`${GW_URL}/api/staff`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(res.ok).toBe(true);
		const data = await res.json();
		expect(Array.isArray(data.staff)).toBe(true);
		const found = data.staff.find((s: any) => s.id === staff.id);
		expect(found).toBeTruthy();
		expect(found.name).toBe("Listable Agent");
	});

	test("GET /api/staff/:id returns a single staff agent", async () => {
		const created = await apiCreateStaff(token, {
			name: "Fetchable Agent",
			description: "desc",
			systemPrompt: "You are fetchable.",
			cwd: nonGitCwd(),
		});
		cleanupStaffIds.push(created.id);
		if (created.currentSessionId) cleanupSessionIds.push(created.currentSessionId);

		const res = await fetch(`${GW_URL}/api/staff/${created.id}`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(res.ok).toBe(true);
		const staff = await res.json();
		expect(staff.id).toBe(created.id);
		expect(staff.name).toBe("Fetchable Agent");
		expect(staff.description).toBe("desc");
		expect(staff.cwd).toBe(nonGitCwd());
	});

	test("PUT /api/staff/:id updates fields", async () => {
		const created = await apiCreateStaff(token, {
			name: "Updatable Agent",
			systemPrompt: "Original prompt.",
			cwd: nonGitCwd(),
		});
		cleanupStaffIds.push(created.id);
		if (created.currentSessionId) cleanupSessionIds.push(created.currentSessionId);

		const res = await fetch(`${GW_URL}/api/staff/${created.id}`, {
			method: "PUT",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ description: "Updated desc", state: "paused" }),
		});
		expect(res.ok).toBe(true);
		const updated = await res.json();
		expect(updated.description).toBe("Updated desc");
		expect(updated.state).toBe("paused");
		// Name should remain unchanged
		expect(updated.name).toBe("Updatable Agent");
	});

	test("DELETE /api/staff/:id removes the staff agent and its session", async () => {
		const created = await apiCreateStaff(token, {
			name: "Deletable Agent",
			systemPrompt: "To be deleted.",
			cwd: nonGitCwd(),
		});
		const sessionId = created.currentSessionId;
		expect(sessionId).toBeTruthy();

		const delRes = await fetch(`${GW_URL}/api/staff/${created.id}`, {
			method: "DELETE",
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(delRes.ok).toBe(true);

		// Verify staff is gone
		const getRes = await fetch(`${GW_URL}/api/staff/${created.id}`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(getRes.status).toBe(404);

		// Verify the associated session is also gone
		const sessionRes = await fetch(`${GW_URL}/api/sessions/${sessionId}`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(sessionRes.status).toBe(404);
	});

	test("POST /api/staff with triggers auto-generates trigger IDs", async () => {
		const staff = await apiCreateStaff(token, {
			name: "Triggered Agent",
			systemPrompt: "You have triggers.",
			cwd: nonGitCwd(),
			triggers: [
				{ type: "schedule", config: { cron: "0 9 * * *" }, enabled: true, prompt: "Good morning" },
				{ type: "manual", config: {}, enabled: true },
				{ type: "git", config: { branch: "master", event: "push" }, enabled: false },
			],
		});
		cleanupStaffIds.push(staff.id);
		if (staff.currentSessionId) cleanupSessionIds.push(staff.currentSessionId);

		expect(staff.triggers).toHaveLength(3);

		// Each trigger should have an auto-generated ID
		for (const trigger of staff.triggers) {
			expect(trigger.id).toBeTruthy();
			expect(typeof trigger.id).toBe("string");
			expect(trigger.id.length).toBeGreaterThan(0);
		}

		// Verify trigger fields
		const scheduleTrigger = staff.triggers.find((t: any) => t.type === "schedule");
		expect(scheduleTrigger).toBeTruthy();
		expect(scheduleTrigger.config.cron).toBe("0 9 * * *");
		expect(scheduleTrigger.enabled).toBe(true);
		expect(scheduleTrigger.prompt).toBe("Good morning");

		const manualTrigger = staff.triggers.find((t: any) => t.type === "manual");
		expect(manualTrigger).toBeTruthy();
		expect(manualTrigger.enabled).toBe(true);

		const gitTrigger = staff.triggers.find((t: any) => t.type === "git");
		expect(gitTrigger).toBeTruthy();
		expect(gitTrigger.config.branch).toBe("master");
		expect(gitTrigger.enabled).toBe(false);
	});

	test("POST /api/staff/:id/wake enqueues prompt on existing permanent session", async () => {
		const staff = await apiCreateStaff(token, {
			name: "Wakeable Agent",
			systemPrompt: "You can be woken.",
			cwd: nonGitCwd(),
		});
		cleanupStaffIds.push(staff.id);
		if (staff.currentSessionId) cleanupSessionIds.push(staff.currentSessionId);

		// First wake — should return the permanent session ID
		const wakeRes = await fetch(`${GW_URL}/api/staff/${staff.id}/wake`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ prompt: "Hello, wake up!" }),
		});
		expect(wakeRes.status).toBe(201);
		const wakeData = await wakeRes.json();
		expect(wakeData.sessionId).toBe(staff.currentSessionId);

		// Verify the session has staffId
		const sessionRes = await fetch(`${GW_URL}/api/sessions/${wakeData.sessionId}`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(sessionRes.ok).toBe(true);
		const session = await sessionRes.json();
		expect(session.staffId).toBe(staff.id);

		// Verify the staff agent's lastWakeAt is updated
		const staffRes = await fetch(`${GW_URL}/api/staff/${staff.id}`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		const updatedStaff = await staffRes.json();
		expect(updatedStaff.lastWakeAt).toBeGreaterThan(0);
		expect(updatedStaff.currentSessionId).toBe(wakeData.sessionId);

		// Second wake — should return the same session ID
		const wake2Res = await fetch(`${GW_URL}/api/staff/${staff.id}/wake`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ prompt: "Second prompt" }),
		});
		expect(wake2Res.status).toBe(201);
		const wake2Data = await wake2Res.json();
		expect(wake2Data.sessionId).toBe(staff.currentSessionId);
	});

	test("GET /api/staff/:id/sessions returns 410 (deprecated)", async () => {
		const staff = await apiCreateStaff(token, {
			name: "History Agent",
			systemPrompt: "Track my sessions.",
			cwd: nonGitCwd(),
		});
		cleanupStaffIds.push(staff.id);
		if (staff.currentSessionId) cleanupSessionIds.push(staff.currentSessionId);

		const histRes = await fetch(`${GW_URL}/api/staff/${staff.id}/sessions`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(histRes.status).toBe(410);
	});

	test("Staff assistant session can be created via assistantType", async () => {
		const res = await fetch(`${GW_URL}/api/sessions`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ assistantType: "staff" }),
		});
		expect(res.status).toBe(201);
		const session = await res.json();
		cleanupSessionIds.push(session.id);

		expect(session.assistantType).toBe("staff");

		// Verify via GET
		const getRes = await fetch(`${GW_URL}/api/sessions/${session.id}`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(getRes.ok).toBe(true);
		const detail = await getRes.json();
		expect(detail.assistantType).toBe("staff");
	});

	test("GET /api/staff/nonexistent returns 404", async () => {
		const res = await fetch(`${GW_URL}/api/staff/nonexistent-id-12345`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(res.status).toBe(404);
	});

	test("PUT /api/staff/nonexistent returns 404", async () => {
		const res = await fetch(`${GW_URL}/api/staff/nonexistent-id-12345`, {
			method: "PUT",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ description: "nope" }),
		});
		expect(res.status).toBe(404);
	});

	test("DELETE /api/staff/nonexistent returns 404", async () => {
		const res = await fetch(`${GW_URL}/api/staff/nonexistent-id-12345`, {
			method: "DELETE",
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(res.status).toBe(404);
	});

	test("POST /api/staff/nonexistent/wake returns 404", async () => {
		const res = await fetch(`${GW_URL}/api/staff/nonexistent-id-12345/wake`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ prompt: "hello" }),
		});
		expect(res.status).toBe(404);
	});

	test("GET /api/staff/nonexistent/sessions returns 410", async () => {
		// The sessions endpoint is fully deprecated — returns 410 regardless of staff ID
		const res = await fetch(`${GW_URL}/api/staff/nonexistent-id-12345/sessions`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(res.status).toBe(410);
	});

	test("Paused staff agent cannot be woken", async () => {
		const staff = await apiCreateStaff(token, {
			name: "Paused Agent",
			systemPrompt: "I am paused.",
			cwd: nonGitCwd(),
		});
		cleanupStaffIds.push(staff.id);
		if (staff.currentSessionId) cleanupSessionIds.push(staff.currentSessionId);

		// Pause the agent
		await fetch(`${GW_URL}/api/staff/${staff.id}`, {
			method: "PUT",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ state: "paused" }),
		});

		// Attempt to wake should fail
		const wakeRes = await fetch(`${GW_URL}/api/staff/${staff.id}/wake`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ prompt: "wake up!" }),
		});
		expect(wakeRes.status).toBe(400);
	});
});
