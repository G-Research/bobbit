import { test, expect } from "./in-process-harness.js";
import { readE2EToken, base, gitCwd, apiFetch } from "./e2e-setup.js";

/**
 * End-to-end tests for the Staff Agents feature (persistent session model).
 *
 * Each staff agent has a single permanent session created at staff creation time.
 * Wake cycles enqueue prompts on the existing session instead of creating new ones.
 *
 * Run with:
 *   npm run build:server && npx playwright test tests/e2e/staff.spec.ts --config playwright-e2e.config.ts
 */

function GW_URL() { return base(); }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function apiCreateStaff(
	_token: string,
	data: {
		name: string;
		description?: string;
		systemPrompt: string;
		cwd?: string;
		triggers?: Array<{ type: string; config: Record<string, unknown>; enabled: boolean; prompt?: string }>;
	},
): Promise<any> {
	const res = await apiFetch("/api/staff", {
		method: "POST",
		body: JSON.stringify(data),
	});
	expect(res.status).toBe(201);
	return res.json();
}

async function apiDeleteStaff(_token: string, id: string): Promise<void> {
	await apiFetch(`/api/staff/${id}`, { method: "DELETE" }).catch(() => {});
}

async function apiDeleteSession(_token: string, id: string): Promise<void> {
	await apiFetch(`/api/sessions/${id}`, { method: "DELETE" }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("Staff Agents — REST API", () => {
	let token: string;
	const cleanupStaffIds: string[] = [];
	const cleanupSessionIds: string[] = [];
	/** Shared staff agent created once for read-only and update tests. */
	let sharedStaff: any;

	test.beforeAll(async () => {
		token = readE2EToken();
		// Pre-create a shared staff agent used by list, get-by-id, update, wake, and paused tests
		sharedStaff = await apiCreateStaff(token, {
			name: "Shared Test Agent",
			description: "Shared for multiple tests",
			systemPrompt: "You are a shared test agent.",
			cwd: gitCwd(),
		});
		cleanupStaffIds.push(sharedStaff.id);
		if (sharedStaff.currentSessionId) cleanupSessionIds.push(sharedStaff.currentSessionId);
	});

	test.afterAll(async () => {
		await Promise.all(cleanupSessionIds.map((id) => apiDeleteSession(token, id)));
		await Promise.all(cleanupStaffIds.map((id) => apiDeleteStaff(token, id)));
	});

	test("POST /api/staff creates a staff agent with defaults and a permanent session", async () => {
		const staff = await apiCreateStaff(token, {
			name: "Test Warden",
			description: "A test staff agent",
			systemPrompt: "You are a test warden.",
			cwd: gitCwd(),
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
		const sessionRes = await apiFetch(`/api/sessions/${staff.currentSessionId}`, {
		});
		expect(sessionRes.ok).toBe(true);
		const session = await sessionRes.json();
		expect(session.staffId).toBe(staff.id);
	});

	test("POST /api/staff with missing name returns 400", async () => {
		const res = await apiFetch(`/api/staff`, {
			method: "POST",
			body: JSON.stringify({ systemPrompt: "test" }),
		});
		expect(res.status).toBe(400);
	});

	test("POST /api/staff with missing systemPrompt returns 400", async () => {
		const res = await apiFetch(`/api/staff`, {
			method: "POST",
			body: JSON.stringify({ name: "No Prompt" }),
		});
		expect(res.status).toBe(400);
	});

	test("GET /api/staff lists created staff agents", async () => {
		const res = await apiFetch(`/api/staff`, {
		});
		expect(res.ok).toBe(true);
		const data = await res.json();
		expect(Array.isArray(data.staff)).toBe(true);
		const found = data.staff.find((s: any) => s.id === sharedStaff.id);
		expect(found).toBeTruthy();
		expect(found.name).toBe("Shared Test Agent");
	});

	test("GET /api/staff/:id returns a single staff agent", async () => {
		const res = await apiFetch(`/api/staff/${sharedStaff.id}`, {
		});
		expect(res.ok).toBe(true);
		const staff = await res.json();
		expect(staff.id).toBe(sharedStaff.id);
		expect(staff.name).toBe("Shared Test Agent");
		expect(staff.description).toBe("Shared for multiple tests");
		expect(staff.cwd).toBe(gitCwd());
	});

	test("PUT /api/staff/:id updates fields", async () => {
		const res = await apiFetch(`/api/staff/${sharedStaff.id}`, {
			method: "PUT",
			body: JSON.stringify({ description: "Updated desc" }),
		});
		expect(res.ok).toBe(true);
		const updated = await res.json();
		expect(updated.description).toBe("Updated desc");
		// Name should remain unchanged
		expect(updated.name).toBe("Shared Test Agent");
		// Restore original description for other tests
		await apiFetch(`/api/staff/${sharedStaff.id}`, {
			method: "PUT",
			body: JSON.stringify({ description: "Shared for multiple tests" }),
		});
	});

	test("DELETE /api/staff/:id removes the staff agent and its session", async () => {
		const created = await apiCreateStaff(token, {
			name: "Deletable Agent",
			systemPrompt: "To be deleted.",
			cwd: gitCwd(),
		});
		const sessionId = created.currentSessionId;
		expect(sessionId).toBeTruthy();

		const delRes = await apiFetch(`/api/staff/${created.id}`, {
			method: "DELETE",
		});
		expect(delRes.ok).toBe(true);

		// Verify staff is gone
		const getRes = await apiFetch(`/api/staff/${created.id}`, {
		});
		expect(getRes.status).toBe(404);

		// Session is archived (not deleted) — verify it still exists but is archived
		const sessionRes = await apiFetch(`/api/sessions/${sessionId}`, {
		});
		expect(sessionRes.status).toBe(200);
		const sessionBody = await sessionRes.json();
		expect(sessionBody.archived).toBe(true);
	});

	test("POST /api/staff with triggers auto-generates trigger IDs", async () => {
		const staff = await apiCreateStaff(token, {
			name: "Triggered Agent",
			systemPrompt: "You have triggers.",
			cwd: gitCwd(),
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
			cwd: gitCwd(),
		});
		cleanupStaffIds.push(staff.id);
		if (staff.currentSessionId) cleanupSessionIds.push(staff.currentSessionId);

		// First wake — should return the permanent session ID
		const wakeRes = await apiFetch(`/api/staff/${staff.id}/wake`, {
			method: "POST",
			body: JSON.stringify({ prompt: "Hello, wake up!" }),
		});
		expect(wakeRes.status).toBe(201);
		const wakeData = await wakeRes.json();
		expect(wakeData.sessionId).toBe(staff.currentSessionId);

		// Verify the session has staffId
		const sessionRes = await apiFetch(`/api/sessions/${wakeData.sessionId}`, {
		});
		expect(sessionRes.ok).toBe(true);
		const session = await sessionRes.json();
		expect(session.staffId).toBe(staff.id);

		// Verify the staff agent's lastWakeAt is updated
		const staffRes = await apiFetch(`/api/staff/${staff.id}`, {
		});
		const updatedStaff = await staffRes.json();
		expect(updatedStaff.lastWakeAt).toBeGreaterThan(0);
		expect(updatedStaff.currentSessionId).toBe(wakeData.sessionId);

		// Second wake — should return the same session ID
		const wake2Res = await apiFetch(`/api/staff/${staff.id}/wake`, {
			method: "POST",
			body: JSON.stringify({ prompt: "Second prompt" }),
		});
		expect(wake2Res.status).toBe(201);
		const wake2Data = await wake2Res.json();
		expect(wake2Data.sessionId).toBe(staff.currentSessionId);
	});

	test("GET /api/staff/:id/sessions returns 410 (deprecated)", async () => {
		const histRes = await apiFetch(`/api/staff/${sharedStaff.id}/sessions`, {
		});
		expect(histRes.status).toBe(410);
	});

	test("Staff assistant session can be created via assistantType", async () => {
		const res = await apiFetch(`/api/sessions`, {
			method: "POST",
			body: JSON.stringify({ assistantType: "staff" }),
		});
		expect(res.status).toBe(201);
		const session = await res.json();
		cleanupSessionIds.push(session.id);

		expect(session.assistantType).toBe("staff");

		// Verify via GET
		const getRes = await apiFetch(`/api/sessions/${session.id}`, {
		});
		expect(getRes.ok).toBe(true);
		const detail = await getRes.json();
		expect(detail.assistantType).toBe("staff");
	});

	test("Nonexistent staff returns 404/410 for all endpoints", async () => {
		const getRes = await apiFetch(`/api/staff/nonexistent-id-12345`, {
		});
		expect(getRes.status).toBe(404);

		const putRes = await apiFetch(`/api/staff/nonexistent-id-12345`, {
			method: "PUT",
			body: JSON.stringify({ description: "nope" }),
		});
		expect(putRes.status).toBe(404);

		const delRes = await apiFetch(`/api/staff/nonexistent-id-12345`, {
			method: "DELETE",
		});
		expect(delRes.status).toBe(404);

		const wakeRes = await apiFetch(`/api/staff/nonexistent-id-12345/wake`, {
			method: "POST",
			body: JSON.stringify({ prompt: "hello" }),
		});
		expect(wakeRes.status).toBe(404);

		// The sessions endpoint is fully deprecated — returns 410 regardless of staff ID
		const sessionsRes = await apiFetch(`/api/staff/nonexistent-id-12345/sessions`, {
		});
		expect(sessionsRes.status).toBe(410);
	});

	test("Paused staff agent cannot be woken", async () => {
		const staff = await apiCreateStaff(token, {
			name: "Paused Agent",
			systemPrompt: "I am paused.",
			cwd: gitCwd(),
		});
		cleanupStaffIds.push(staff.id);
		if (staff.currentSessionId) cleanupSessionIds.push(staff.currentSessionId);

		// Pause the agent
		await apiFetch(`/api/staff/${staff.id}`, {
			method: "PUT",
			body: JSON.stringify({ state: "paused" }),
		});

		// Attempt to wake should fail
		const wakeRes = await apiFetch(`/api/staff/${staff.id}/wake`, {
			method: "POST",
			body: JSON.stringify({ prompt: "wake up!" }),
		});
		expect(wakeRes.status).toBe(400);
	});

	test("GET /api/staff/:id includes sandboxed field", async () => {
		const res = await apiFetch(`/api/staff/${sharedStaff.id}`, {});
		expect(res.ok).toBe(true);
		const staff = await res.json();
		expect(typeof staff.sandboxed).toBe("boolean");
		// Test environment has no Docker — sandboxed should be false
		expect(staff.sandboxed).toBe(false);
	});

	test("GET /api/staff list includes sandboxed field on each item", async () => {
		const res = await apiFetch(`/api/staff`, {});
		expect(res.ok).toBe(true);
		const data = await res.json();
		expect(Array.isArray(data.staff)).toBe(true);
		for (const s of data.staff) {
			expect(typeof s.sandboxed).toBe("boolean");
		}
	});

	test("POST /api/staff/:id/wake refreshes worktree from primary branch", async () => {
		// Get staff details to find worktreePath
		const getRes = await apiFetch(`/api/staff/${sharedStaff.id}`, {});
		const staff = await getRes.json();
		const worktreePath = staff.worktreePath;
		if (!worktreePath) {
			console.warn("No worktreePath on shared staff — skipping refresh test");
			return;
		}

		const { execFileSync } = await import("node:child_process");
		const fs = await import("node:fs");
		const path = await import("node:path");

		// Set up origin pointing to the test repo itself so git fetch/rebase work
		try {
			execFileSync("git", ["remote", "add", "origin", gitCwd()], { cwd: gitCwd(), stdio: "pipe" });
		} catch { /* already exists */ }
		execFileSync("git", ["fetch", "origin"], { cwd: gitCwd(), stdio: "pipe" });

		// Detect primary branch name and set symbolic ref
		const primaryBranch = execFileSync("git", ["branch", "--show-current"], { cwd: gitCwd(), encoding: "utf-8" }).trim();
		execFileSync("git", ["symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${primaryBranch}`], { cwd: gitCwd(), stdio: "pipe" });

		// Create a unique marker commit on the test repo's primary branch
		const marker = `wake-refresh-${Date.now()}`;
		fs.writeFileSync(path.join(gitCwd(), `${marker}.txt`), marker);
		execFileSync("git", ["add", `${marker}.txt`], { cwd: gitCwd(), stdio: "pipe" });
		execFileSync("git", ["commit", "-m", `test: ${marker}`], { cwd: gitCwd(), stdio: "pipe" });

		// Wake the staff agent — triggers refreshWorktree (fetch + rebase onto primary)
		const wakeRes = await apiFetch(`/api/staff/${sharedStaff.id}/wake`, {
			method: "POST",
			body: JSON.stringify({ prompt: "refresh test" }),
		});
		expect(wakeRes.status).toBe(201);

		// Wait for the async refreshWorktree to complete
		await new Promise((r) => setTimeout(r, 5_000));

		// Verify the marker commit is now in the worktree's log
		const log = execFileSync("git", ["log", "--oneline", "-5"], { cwd: worktreePath, encoding: "utf-8" });
		expect(log).toContain(marker);
	});
});
