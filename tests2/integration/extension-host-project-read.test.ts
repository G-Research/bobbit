import { randomUUID } from "node:crypto";
import { test, expect } from "./_e2e/in-process-harness.js";
import { apiFetch } from "./_e2e/e2e-setup.js";
import { mintSurfaceToken } from "../../src/server/extension-host/surface-binding.js";

function terminalPanelToken(sessionId: string): string {
	return mintSurfaceToken({
		sessionId,
		packId: "terminal",
		contributionId: "panel:terminal.panel",
	});
}

function projectRead(
	sessionId: string,
	operation: string,
	payload: Record<string, unknown> = {},
	surfaceToken = terminalPanelToken(sessionId),
): Promise<Response> {
	return apiFetch("/api/ext/project/read", {
		method: "POST",
		headers: { "x-bobbit-session-id": sessionId },
		body: JSON.stringify({ operation, surfaceToken, ...payload }),
	});
}

function seedBoundSession(gateway: any): { id: string; store: any } {
	const id = `project-read-session-${randomUUID()}`;
	const store = gateway.sessionManager.getSessionStore(gateway.defaultProjectId);
	store.put({
		id,
		title: "Project read fixture",
		cwd: gateway.bobbitDir,
		createdAt: 1_000,
		lastActivity: 2_000,
		projectId: gateway.defaultProjectId,
	});
	return { id, store };
}

function goalRecord(id: string, projectId: string, title: string) {
	return {
		id,
		title,
		cwd: "/REDACTED_PATH",
		state: "in-progress" as const,
		spec: "REDACTED_SPEC",
		createdAt: 10,
		updatedAt: 20,
		projectId,
		team: true,
		branch: "REDACTED_BRANCH",
		metadata: { secret: "REDACTED_METADATA" },
	};
}

test("POST /api/ext/project/read returns bounded redacted pages and complete ordered ID outcomes", async ({ gateway }) => {
	const bound = seedBoundSession(gateway);
	const context = gateway.projectContextManager.getOrCreate(gateway.defaultProjectId);
	const foreignContext = gateway.projectContextManager.getOrCreate("headquarters");
	const ownedGoalId = `owned-goal-${randomUUID()}`;
	const foreignGoalId = `foreign-goal-${randomUUID()}`;
	const missingGoalId = `missing-goal-${randomUUID()}`;
	const staffId = `staff-${randomUUID()}`;
	context.goalStore.put(goalRecord(ownedGoalId, gateway.defaultProjectId, "Owned goal"));
	foreignContext.goalStore.put(goalRecord(foreignGoalId, "headquarters", "Foreign secret title"));
	context.staffStore.put({
		id: staffId,
		name: "Safe staff name",
		description: "REDACTED_DESCRIPTION",
		systemPrompt: "REDACTED_PROMPT",
		cwd: "/REDACTED_STAFF_PATH",
		state: "active",
		triggers: [],
		memory: "REDACTED_MEMORY",
		accessory: "none",
		createdAt: 1,
		updatedAt: 2,
		projectId: gateway.defaultProjectId,
		sandboxed: false,
		branch: "REDACTED_STAFF_BRANCH",
	});
	try {
		const pageResponse = await projectRead(bound.id, "goals", { selector: { cursor: 0, limit: 1 } });
		expect(pageResponse.status).toBe(200);
		const page = await pageResponse.json();
		expect(page).toMatchObject({ mode: "page", page: { cursor: 0, limit: 1 } });
		expect(page.items).toHaveLength(1);
		expect(page.page.total).toBeGreaterThanOrEqual(1);

		const idsResponse = await projectRead(bound.id, "goals", {
			selector: { mode: "ids", ids: [ownedGoalId, foreignGoalId, missingGoalId, ownedGoalId] },
		});
		expect(idsResponse.status).toBe(200);
		const ids = await idsResponse.json();
		expect(ids).toEqual({
			mode: "ids",
			results: [
				{
					id: ownedGoalId,
					status: "found",
					value: {
						id: ownedGoalId,
						title: "Owned goal",
						state: "in-progress",
						createdAt: 10,
						updatedAt: 20,
						team: true,
						archived: false,
					},
				},
				{ id: foreignGoalId, status: "unauthorized" },
				{ id: missingGoalId, status: "not-found" },
				expect.objectContaining({ id: ownedGoalId, status: "found" }),
			],
		});
		expect(JSON.stringify(ids)).not.toMatch(/REDACTED|cwd|spec|branch|metadata|projectId/);
		expect(JSON.stringify(ids)).not.toContain("Foreign secret title");

		const staffResponse = await projectRead(bound.id, "staff", {
			selector: { mode: "ids", ids: [staffId] },
		});
		expect(staffResponse.status).toBe(200);
		const staff = await staffResponse.json();
		expect(staff.results[0]).toEqual({
			id: staffId,
			status: "found",
			value: {
				id: staffId,
				name: "Safe staff name",
				state: "active",
				accessory: "none",
				createdAt: 1,
				updatedAt: 2,
			},
		});
		expect(JSON.stringify(staff)).not.toMatch(/REDACTED|prompt|memory|cwd|branch|projectId/);
	} finally {
		context.staffStore.remove(staffId);
		context.goalStore.remove(ownedGoalId);
		foreignContext.goalStore.remove(foreignGoalId);
		bound.store.remove(bound.id);
	}
});

test("project child reads authorize the parent first and reread current canonical records", async ({ gateway }) => {
	const bound = seedBoundSession(gateway);
	const context = gateway.projectContextManager.getOrCreate(gateway.defaultProjectId);
	const foreignContext = gateway.projectContextManager.getOrCreate("headquarters");
	const goalId = `goal-${randomUUID()}`;
	const foreignGoalId = `foreign-goal-${randomUUID()}`;
	const taskId = `task-${randomUUID()}`;
	context.goalStore.put(goalRecord(goalId, gateway.defaultProjectId, "Before reread"));
	foreignContext.goalStore.put(goalRecord(foreignGoalId, "headquarters", "Foreign parent"));
	context.taskStore.put({
		id: taskId,
		goalId,
		title: "Safe task",
		type: "implementation",
		state: "complete",
		spec: "REDACTED_TASK_SPEC",
		createdAt: 1,
		updatedAt: 2,
		dependsOn: [],
		branch: "REDACTED_TASK_BRANCH",
		headSha: "REDACTED_SHA",
		resultSummary: "REDACTED_RESULT",
	});
	try {
		const tasksResponse = await projectRead(bound.id, "goal-tasks", {
			goalId,
			selector: { mode: "ids", ids: [taskId] },
		});
		expect(tasksResponse.status).toBe(200);
		const tasks = await tasksResponse.json();
		expect(tasks.results[0]).toMatchObject({ id: taskId, status: "found", value: { title: "Safe task" } });
		expect(JSON.stringify(tasks)).not.toMatch(/REDACTED|spec|branch|headSha|resultSummary/);

		const foreignParent = await projectRead(bound.id, "goal-tasks", { goalId: foreignGoalId });
		expect(foreignParent.status).toBe(200);
		expect(await foreignParent.json()).toEqual({ goalId: foreignGoalId, status: "unauthorized" });
		const missingParent = await projectRead(bound.id, "goal-gates", { goalId: `missing-${randomUUID()}` });
		expect(missingParent.status).toBe(200);
		expect(await missingParent.json()).toMatchObject({ status: "not-found" });

		context.goalStore.put({ ...context.goalStore.get(goalId), title: "After reread", updatedAt: 30 });
		const reread = await projectRead(bound.id, "goals", { selector: { mode: "ids", ids: [goalId] } });
		expect((await reread.json()).results[0].value).toMatchObject({ title: "After reread", updatedAt: 30 });
	} finally {
		context.taskStore.remove(taskId);
		context.goalStore.remove(goalId);
		foreignContext.goalStore.remove(foreignGoalId);
		bound.store.remove(bound.id);
	}
});

test("project reads reject missing, stale, cross-session, caller-selected, and cleaned-up authority", async ({ gateway }) => {
	const bound = seedBoundSession(gateway);
	const other = seedBoundSession(gateway);
	try {
		const missing = await projectRead(bound.id, "goals", {}, "");
		expect(missing.status).toBe(403);

		const stale = await projectRead(
			bound.id,
			"goals",
			{},
			mintSurfaceToken({ sessionId: bound.id, packId: "inactive-pack", contributionId: "panel:gone" }),
		);
		expect(stale.status).toBe(403);

		const crossSession = await projectRead(other.id, "goals", {}, terminalPanelToken(bound.id));
		expect(crossSession.status).toBe(403);

		const callerProject = await projectRead(bound.id, "goals", { projectId: "headquarters" });
		expect(callerProject.status).toBe(400);

		bound.store.remove(bound.id);
		const cleanedUp = await projectRead(bound.id, "goals");
		expect(cleanedUp.status).toBe(403);
	} finally {
		bound.store.remove(bound.id);
		other.store.remove(other.id);
	}
});
