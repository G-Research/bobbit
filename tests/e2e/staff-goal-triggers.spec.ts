/**
 * E2E tests for goal lifecycle staff triggers (`goal_created`, `goal_archived`).
 *
 * Covers (per design doc "Goal lifecycle staff triggers"):
 *   - POST /api/goals    fires `goal_created` triggers on every active staff
 *   - DELETE /api/goals/:id (archive) fires `goal_archived` triggers
 *   - Second archive call does NOT re-fire
 *   - Validation: empty prompt on goal_created/goal_archived → 400 on
 *     POST /api/staff and PUT /api/staff/:id
 *
 * Uses the in-process gateway harness so the dispatcher wiring (server.ts
 * → ProjectContextManager → ProjectContext → GoalStore callbacks) is
 * exercised end-to-end.
 */
import { test, expect } from "./in-process-harness.js";
import { apiFetch, defaultProject, readE2EToken } from "./e2e-setup.js";

async function createStaffWithTrigger(opts: {
	name: string;
	triggers: Array<{ type: string; config?: Record<string, unknown>; enabled?: boolean; prompt?: string }>;
}): Promise<any> {
	const project = await defaultProject();
	const res = await apiFetch("/api/staff", {
		method: "POST",
		body: JSON.stringify({
			name: opts.name,
			systemPrompt: "Test goal-trigger staff agent.",
			cwd: project.rootPath,
			projectId: project.id,
			triggers: opts.triggers.map((t) => ({
				type: t.type,
				config: t.config ?? {},
				enabled: t.enabled ?? true,
				...(t.prompt !== undefined ? { prompt: t.prompt } : {}),
			})),
		}),
	});
	expect(res.status).toBe(201);
	return res.json();
}

async function listInbox(staffId: string, state: string = "pending"): Promise<any[]> {
	const res = await apiFetch(`/api/staff/${staffId}/inbox?state=${state}`);
	expect(res.ok).toBe(true);
	const body = await res.json();
	return body.entries ?? [];
}

async function createGoal(title: string): Promise<any> {
	const project = await defaultProject();
	const res = await apiFetch("/api/goals", {
		method: "POST",
		body: JSON.stringify({
			title,
			cwd: project.rootPath,
			projectId: project.id,
			worktree: false,
			autoStartTeam: false,
		}),
	});
	expect(res.status).toBe(201);
	return res.json();
}

test.describe("Staff goal lifecycle triggers — REST API", () => {
	const cleanupStaffIds: string[] = [];
	const cleanupGoalIds: string[] = [];

	test.beforeAll(() => {
		void readE2EToken();
	});

	test.afterAll(async () => {
		for (const id of cleanupGoalIds) {
			await apiFetch(`/api/goals/${id}`, { method: "DELETE" }).catch(() => {});
		}
		for (const id of cleanupStaffIds) {
			await apiFetch(`/api/staff/${id}`, { method: "DELETE" }).catch(() => {});
		}
	});

	test("POST /api/goals enqueues a goal_created inbox entry for matching staff", async () => {
		const staff = await createStaffWithTrigger({
			name: "Goal-Created Watcher",
			triggers: [{ type: "goal_created", prompt: "Investigate the new goal" }],
		});
		cleanupStaffIds.push(staff.id);

		const triggerId = staff.triggers[0].id;
		expect(triggerId).toBeTruthy();

		const goal = await createGoal("Triggered-create test goal");
		cleanupGoalIds.push(goal.id);

		const entries = await listInbox(staff.id, "pending");
		// Should be exactly one entry from the goal_created event.
		expect(entries.length).toBe(1);
		const e = entries[0];
		expect(e.source.type).toBe("trigger");
		expect(e.source.triggerId).toBe(triggerId);
		expect(e.prompt).toBe("Investigate the new goal");
		expect(e.title).toContain("goal_created");
		expect(e.title).toContain("Triggered-create test goal");
		expect(typeof e.context).toBe("string");
		expect(e.context).toContain(goal.id);
		expect(e.context).toContain("Triggered-create test goal");
	});

	test("DELETE /api/goals/:id (archive) fires goal_archived once; re-archive does not re-fire", async () => {
		const staff = await createStaffWithTrigger({
			name: "Goal-Archived Watcher",
			triggers: [{ type: "goal_archived", prompt: "Goal was archived" }],
		});
		cleanupStaffIds.push(staff.id);
		const triggerId = staff.triggers[0].id;

		const goal = await createGoal("Triggered-archive test goal");
		// Don't add to cleanupGoalIds — we're archiving it here.

		// Sanity: no goal_archived entry yet.
		const pre = await listInbox(staff.id, "pending");
		expect(pre.find((e: any) => e.source.triggerId === triggerId)).toBeUndefined();

		// First archive: should fire.
		const arch1 = await apiFetch(`/api/goals/${goal.id}`, { method: "DELETE" });
		expect(arch1.ok).toBe(true);

		const afterOne = await listInbox(staff.id, "pending");
		const matches1 = afterOne.filter((e: any) => e.source.triggerId === triggerId);
		expect(matches1.length).toBe(1);
		expect(matches1[0].prompt).toBe("Goal was archived");
		expect(matches1[0].title).toContain("goal_archived");

		// Second archive: idempotent at the API level (returns ok), but MUST NOT
		// re-fire the inbox entry. Some implementations may 404 here — also
		// acceptable as long as the entry count stays at 1.
		await apiFetch(`/api/goals/${goal.id}`, { method: "DELETE" }).catch(() => { /* ok */ });

		const afterTwo = await listInbox(staff.id, "pending");
		const matches2 = afterTwo.filter((e: any) => e.source.triggerId === triggerId);
		expect(matches2.length).toBe(1);
	});

	test("goal_created fires only goal_created triggers; goal_archived only goal_archived", async () => {
		const staff = await createStaffWithTrigger({
			name: "Both-Watcher",
			triggers: [
				{ type: "goal_created", prompt: "created prompt" },
				{ type: "goal_archived", prompt: "archived prompt" },
			],
		});
		cleanupStaffIds.push(staff.id);
		const createdTriggerId = staff.triggers.find((t: any) => t.type === "goal_created").id;
		const archivedTriggerId = staff.triggers.find((t: any) => t.type === "goal_archived").id;

		const goal = await createGoal("Both-watcher test goal");

		// After create: exactly one entry from the goal_created trigger.
		let entries = await listInbox(staff.id, "pending");
		let created = entries.filter((e: any) => e.source.triggerId === createdTriggerId);
		let archived = entries.filter((e: any) => e.source.triggerId === archivedTriggerId);
		expect(created.length).toBe(1);
		expect(archived.length).toBe(0);

		// Archive: now exactly one entry from the goal_archived trigger too.
		const arch = await apiFetch(`/api/goals/${goal.id}`, { method: "DELETE" });
		expect(arch.ok).toBe(true);

		entries = await listInbox(staff.id, "pending");
		created = entries.filter((e: any) => e.source.triggerId === createdTriggerId);
		archived = entries.filter((e: any) => e.source.triggerId === archivedTriggerId);
		expect(created.length).toBe(1);
		expect(archived.length).toBe(1);
		expect(archived[0].prompt).toBe("archived prompt");
	});

	test("disabled goal_created triggers do not fire", async () => {
		const staff = await createStaffWithTrigger({
			name: "Disabled-Trigger Watcher",
			triggers: [{ type: "goal_created", enabled: false, prompt: "should not fire" }],
		});
		cleanupStaffIds.push(staff.id);
		const triggerId = staff.triggers[0].id;

		const goal = await createGoal("Disabled-trigger test goal");
		cleanupGoalIds.push(goal.id);

		const entries = await listInbox(staff.id, "pending");
		expect(entries.find((e: any) => e.source.triggerId === triggerId)).toBeUndefined();
	});

	test("POST /api/staff with empty-prompt goal_created trigger → 400", async () => {
		const project = await defaultProject();
		const res = await apiFetch("/api/staff", {
			method: "POST",
			body: JSON.stringify({
				name: "Bad-Trigger Staff",
				systemPrompt: "x",
				cwd: project.rootPath,
				projectId: project.id,
				triggers: [
					{ type: "goal_created", config: {}, enabled: true, prompt: "" },
				],
			}),
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(typeof body.error).toBe("string");
		expect(body.error.toLowerCase()).toContain("prompt");
	});

	test("POST /api/staff with whitespace-only prompt → 400", async () => {
		const project = await defaultProject();
		const res = await apiFetch("/api/staff", {
			method: "POST",
			body: JSON.stringify({
				name: "Whitespace-Trigger Staff",
				systemPrompt: "x",
				cwd: project.rootPath,
				projectId: project.id,
				triggers: [
					{ type: "goal_archived", config: {}, enabled: true, prompt: "   \n\t " },
				],
			}),
		});
		expect(res.status).toBe(400);
	});

	test("POST /api/staff with missing prompt on goal_archived → 400", async () => {
		const project = await defaultProject();
		const res = await apiFetch("/api/staff", {
			method: "POST",
			body: JSON.stringify({
				name: "Missing-Prompt Staff",
				systemPrompt: "x",
				cwd: project.rootPath,
				projectId: project.id,
				triggers: [
					{ type: "goal_archived", config: {}, enabled: true },
				],
			}),
		});
		expect(res.status).toBe(400);
	});

	test("PUT /api/staff/:id with empty-prompt goal_created trigger → 400", async () => {
		// Create a valid staff first, then attempt to PUT an invalid trigger.
		const staff = await createStaffWithTrigger({
			name: "PUT-Validation Staff",
			triggers: [{ type: "goal_created", prompt: "valid initial" }],
		});
		cleanupStaffIds.push(staff.id);

		const res = await apiFetch(`/api/staff/${staff.id}`, {
			method: "PUT",
			body: JSON.stringify({
				triggers: [
					{ type: "goal_created", config: {}, enabled: true, prompt: "" },
				],
			}),
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(typeof body.error).toBe("string");
		expect(body.error.toLowerCase()).toContain("prompt");
	});

	test("PUT /api/staff/:id without triggers field does NOT trigger validation", async () => {
		// PUTs that omit triggers should be unchanged — validation only runs
		// when the caller is actually updating the triggers array.
		const staff = await createStaffWithTrigger({
			name: "Untouched-Triggers Staff",
			triggers: [{ type: "goal_created", prompt: "valid" }],
		});
		cleanupStaffIds.push(staff.id);

		const res = await apiFetch(`/api/staff/${staff.id}`, {
			method: "PUT",
			body: JSON.stringify({ description: "updated description" }),
		});
		expect(res.ok).toBe(true);
	});

	test("POST /api/staff with empty prompt on schedule/manual triggers is allowed (back-compat)", async () => {
		// Pinning: validation must only fire for goal_created/goal_archived.
		// schedule/git/manual continue to allow empty/missing prompts.
		const project = await defaultProject();
		const res = await apiFetch("/api/staff", {
			method: "POST",
			body: JSON.stringify({
				name: "Legacy-Trigger Staff",
				systemPrompt: "x",
				cwd: project.rootPath,
				projectId: project.id,
				triggers: [
					{ type: "manual", config: {}, enabled: true },
					{ type: "schedule", config: { cron: "0 9 * * *" }, enabled: true },
				],
			}),
		});
		expect(res.status).toBe(201);
		const staff = await res.json();
		cleanupStaffIds.push(staff.id);
	});
});
