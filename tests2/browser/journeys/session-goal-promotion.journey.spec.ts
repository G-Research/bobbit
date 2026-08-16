/**
 * Journey: Current-session goal promotion
 * Covers the proposal selector, owner-scoped acceptance, continuity across page
 * reload, the unavailable reason, and the unchanged new-worktree control path.
 */
import {
	test,
	expect,
	apiFetch,
	deleteSession,
	defaultProject,
	openApp,
	navigateToHash,
	waitForSessionStatus,
} from "../_helpers/journey-fixture.js";

async function responseJson(response: Response): Promise<any> {
	const text = await response.text();
	expect(response.ok, text).toBe(true);
	return text ? JSON.parse(text) : {};
}

async function createWorktreeSession(): Promise<{ id: string; projectId: string }> {
	const project = await defaultProject();
	const response = await apiFetch("/api/sessions", {
		method: "POST",
		body: JSON.stringify({ cwd: project.rootPath, projectId: project.id, worktree: true }),
	});
	const created = await responseJson(response);
	await waitForSessionStatus(created.id, "idle", 30_000);
	return { id: created.id, projectId: project.id };
}

async function sessionRecord(id: string): Promise<any> {
	return responseJson(await apiFetch(`/api/sessions/${id}?include=archived`));
}

async function seedGoalProposal(sessionId: string, projectId: string, title: string): Promise<void> {
	const workflowsBody = await responseJson(await apiFetch(`/api/workflows?projectId=${encodeURIComponent(projectId)}`));
	const workflows = Array.isArray(workflowsBody) ? workflowsBody : workflowsBody.workflows;
	expect(workflows?.length, "journey project needs a workflow").toBeGreaterThan(0);
	await responseJson(await apiFetch(`/api/sessions/${sessionId}/proposal/goal/seed`, {
		method: "POST",
		body: JSON.stringify({
			args: {
				title,
				spec: "Promote the exact proposal owner without replacing its checkout or transcript.",
				workflow: workflows[0].id,
				projectId,
			},
		}),
	}));
}

async function liveGoals(): Promise<any[]> {
	const body = await responseJson(await apiFetch("/api/goals"));
	return Array.isArray(body) ? body : body.goals ?? [];
}

async function waitForGoalOwnedBy(sessionId: string): Promise<any> {
	let found: any;
	await expect.poll(async () => {
		found = (await liveGoals()).find((goal) => goal.worktreeOwnerSessionId === sessionId || goal.teamLeadSessionId === sessionId);
		return found?.id || "";
	}, { timeout: 40_000, intervals: [100, 250, 500] }).not.toBe("");
	return found;
}

async function openSeededProposal(page: import("@playwright/test").Page, sessionId: string): Promise<void> {
	await openApp(page);
	await navigateToHash(page, `#/session/${sessionId}`);
	await expect(page.locator("[data-testid='goal-form-worktree-mode']")).toBeVisible({ timeout: 20_000 });
}

test.describe("Journey: Current-session goal promotion", () => {
	test("selects Current session, promotes the original lead, and survives reload", async ({ page }) => {
		test.setTimeout(120_000);
		const source = await createWorktreeSession();
		let goalId: string | undefined;
		try {
			const before = await sessionRecord(source.id);
			expect(before.branch).toBeTruthy();
			expect(before.worktreePath).toBeTruthy();
			await seedGoalProposal(source.id, source.projectId, `Promote browser session ${Date.now()}`);
			await openSeededProposal(page, source.id);

			const newMode = page.locator("[data-testid='goal-form-worktree-new']");
			const currentMode = page.locator("[data-testid='goal-form-worktree-current-session']");
			await expect(newMode).toBeChecked();
			await expect(currentMode).toBeEnabled({ timeout: 20_000 });
			await currentMode.check();
			await expect(currentMode).toBeChecked();
			await expect(page.locator("[data-testid='goal-form-worktree-branch']")).toHaveText(before.branch);
			await expect(page.locator("[data-testid='goal-form-worktree-path']")).toHaveText(before.worktreePath);

			await page.reload();
			await expect(page.locator("body[data-shortcuts-ready='1']")).toBeVisible({ timeout: 20_000 });
			await expect(page.locator("[data-testid='goal-form-worktree-current-session']")).toBeChecked({ timeout: 20_000 });
			await expect(page.locator("[data-testid='goal-form-worktree-path']")).toHaveText(before.worktreePath);

			await page.locator("[data-testid='proposal-primary-submit'] button").click();
			const goal = await waitForGoalOwnedBy(source.id);
			goalId = goal.id;
			const after = await sessionRecord(source.id);
			expect(after.id).toBe(source.id);
			expect(after.branch).toBe(before.branch);
			expect(after.worktreePath).toBe(before.worktreePath);
			expect(after.goalId).toBe(goal.id);
			expect(after.teamGoalId).toBe(goal.id);
			expect(goal.teamLeadSessionId).toBe(source.id);

			await page.reload();
			await expect(page.locator("body[data-shortcuts-ready='1']")).toBeVisible({ timeout: 20_000 });
			const restored = await sessionRecord(source.id);
			expect(restored.goalId).toBe(goal.id);
			expect(restored.worktreePath).toBe(before.worktreePath);
		} finally {
			if (goalId) await apiFetch(`/api/goals/${goalId}?cascade=true`, { method: "DELETE" }).catch(() => {});
			await deleteSession(source.id).catch(() => {});
		}
	});

	test("shows the authoritative reason when Current session is unavailable", async ({ page }) => {
		const project = await defaultProject();
		const created = await responseJson(await apiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ cwd: project.rootPath, projectId: project.id, worktree: false }),
		}));
		await waitForSessionStatus(created.id, "idle", 30_000);
		try {
			await seedGoalProposal(created.id, project.id, `Unavailable promotion ${Date.now()}`);
			await openSeededProposal(page, created.id);
			const current = page.locator("[data-testid='goal-form-worktree-current-session']");
			await expect(current).toBeDisabled({ timeout: 20_000 });
			await expect(page.locator("[data-testid='goal-form-worktree-current-unavailable']")).toContainText(/.+/);
			await expect(page.locator("[data-testid='goal-form-worktree-new']")).toBeChecked();
			await expect(page.locator("[data-testid='proposal-primary-submit'] button")).toBeEnabled();
		} finally {
			await deleteSession(created.id).catch(() => {});
		}
	});

	test("keeps New worktree goal creation distinct from the proposal owner", async ({ page }) => {
		test.setTimeout(120_000);
		const source = await createWorktreeSession();
		let goalId: string | undefined;
		try {
			const before = await sessionRecord(source.id);
			await seedGoalProposal(source.id, source.projectId, `New worktree control ${Date.now()}`);
			await openSeededProposal(page, source.id);
			await expect(page.locator("[data-testid='goal-form-worktree-new']")).toBeChecked();
			await page.locator("[data-testid='proposal-primary-submit'] button").click();
			await expect.poll(async () => {
				const goals = await liveGoals();
				const goal = goals.find((candidate) => candidate.title?.startsWith("New worktree control"));
				if (goal) goalId = goal.id;
				return goal?.id || "";
			}, { timeout: 40_000, intervals: [100, 250, 500] }).not.toBe("");
			const goal = (await liveGoals()).find((candidate) => candidate.id === goalId)!;
			expect(goal.worktreePath).toBeTruthy();
			expect(goal.worktreePath).not.toBe(before.worktreePath);
			expect(goal.branch).not.toBe(before.branch);
			expect(goal.teamLeadSessionId).not.toBe(source.id);
			const ownerAfter = await sessionRecord(source.id);
			expect(ownerAfter.goalId).toBeFalsy();
		} finally {
			if (goalId) await apiFetch(`/api/goals/${goalId}?cascade=true`, { method: "DELETE" }).catch(() => {});
			await deleteSession(source.id).catch(() => {});
		}
	});
});
