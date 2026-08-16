/**
 * Journey: Current-session goal promotion
 * Covers the proposal selector, owner-scoped acceptance, continuity across page
 * reload, the unavailable reason, and the unchanged new-worktree control path.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GatewayInfo } from "../gateway-harness.js";
import {
	test,
	expect,
	apiFetch,
	deleteSession,
	openApp,
	navigateToHash,
	registerProject,
	waitForSessionStatus,
} from "../_helpers/journey-fixture.js";

async function responseJson(response: Response): Promise<any> {
	const text = await response.text();
	expect(response.ok, text).toBe(true);
	return text ? JSON.parse(text) : {};
}

type GitSessionFixture = {
	root: string;
	id: string;
	projectId: string;
};

function git(cwd: string, ...args: string[]): void {
	execFileSync("git", args, { cwd, stdio: "pipe" });
}

async function createGitSession(worktree: boolean): Promise<GitSessionFixture> {
	const runRoot = process.env.BOBBIT_E2E_TMP_ROOT;
	if (!runRoot) throw new Error("BOBBIT_E2E_TMP_ROOT must identify the browser run root");
	const root = mkdtempSync(join(runRoot, "session-goal-promotion-"));
	const repo = join(root, "repo");
	let projectId = "";
	try {
		git(root, "init", "--initial-branch=main", repo);
		git(repo, "config", "user.name", "Session Goal Promotion Journey");
		git(repo, "config", "user.email", "session-goal-promotion@example.invalid");
		writeFileSync(join(repo, "README.md"), "session goal promotion fixture\n");
		git(repo, "add", "README.md");
		git(repo, "commit", "-m", "initial fixture");
		projectId = (await registerProject({
			name: `session-goal-promotion-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			rootPath: repo,
		})).id;
		const response = await apiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ cwd: repo, projectId, worktree }),
		});
		const created = await responseJson(response);
		await waitForSessionStatus(created.id, "idle", 30_000);
		return { root, id: created.id, projectId };
	} catch (error) {
		if (projectId) await apiFetch(`/api/projects/${projectId}`, { method: "DELETE" }).catch(() => {});
		rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
		throw error;
	}
}

async function removeGitSession(fixture: GitSessionFixture): Promise<void> {
	await deleteSession(fixture.id).catch(() => {});
	await apiFetch(`/api/projects/${fixture.projectId}`, { method: "DELETE" }).catch(() => {});
	try {
		rmSync(fixture.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
	} catch {
		// Git can retain a short-lived handle after session or goal cleanup on Windows.
	}
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

async function waitForGoalSetup(goalId: string): Promise<any> {
	let goal: any;
	await expect.poll(async () => {
		goal = await responseJson(await apiFetch(`/api/goals/${goalId}`));
		return goal.setupStatus;
	}, { timeout: 40_000, intervals: [100, 250, 500] }).toBe("ready");
	return goal;
}

async function teamRecord(goalId: string): Promise<any> {
	return responseJson(await apiFetch(`/api/goals/${goalId}/team`));
}

function transcriptSnapshot(gateway: GatewayInfo, sessionId: string): { path: string; bytes: string } {
	const transcriptPath = gateway.sessionManager?.getPersistedSession(sessionId)?.agentSessionFile;
	expect(transcriptPath, `session ${sessionId} should retain its transcript path`).toEqual(expect.any(String));
	return { path: transcriptPath, bytes: readFileSync(transcriptPath, "utf8") };
}

async function restartGateway(gateway: GatewayInfo): Promise<void> {
	await gateway.crash();
	await gateway.restart();
	await expect.poll(async () => {
		try {
			return (await apiFetch("/health")).ok;
		} catch {
			return false;
		}
	}, { timeout: 20_000, intervals: [250], message: "gateway should be healthy after restart" }).toBe(true);
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
	test("selects Current session, promotes the original lead, survives restart, and cleans up in order", async ({ page, gateway }) => {
		test.setTimeout(180_000);
		const source = await createGitSession(true);
		let goalId: string | undefined;
		try {
			const before = await sessionRecord(source.id);
			expect(before.branch).toBeTruthy();
			expect(before.worktreePath).toBeTruthy();
			const transcriptBefore = transcriptSnapshot(gateway, source.id);
			await seedGoalProposal(source.id, source.projectId, `Promote browser session ${Date.now()}`);
			await openSeededProposal(page, source.id);

			const newMode = page.locator("[data-testid='goal-form-worktree-new']");
			const currentMode = page.locator("[data-testid='goal-form-worktree-current-session']");
			await expect(newMode).toBeChecked();
			await expect(currentMode).toBeEnabled({ timeout: 20_000 });
			await currentMode.locator("xpath=..").click();
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
			const team = await teamRecord(goal.id);
			expect(after.id).toBe(source.id);
			expect(after.branch).toBe(before.branch);
			expect(after.worktreePath).toBe(before.worktreePath);
			expect(after.goalId).toBe(goal.id);
			expect(after.teamGoalId).toBe(goal.id);
			expect(team.teamLeadSessionId).toBe(source.id);
			expect(team.agents ?? []).toHaveLength(0);
			expect(transcriptSnapshot(gateway, source.id)).toEqual(transcriptBefore);

			await restartGateway(gateway);
			await waitForSessionStatus(source.id, "idle", 40_000);
			await page.reload({ waitUntil: "domcontentloaded" });
			await expect(page.locator("body[data-shortcuts-ready='1']")).toBeVisible({ timeout: 20_000 });
			await navigateToHash(page, `#/session/${source.id}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 20_000 });

			const restored = await sessionRecord(source.id);
			const restoredGoal = await responseJson(await apiFetch(`/api/goals/${goal.id}`));
			const restoredTeam = await teamRecord(goal.id);
			expect(restored.id).toBe(source.id);
			expect(restored.goalId).toBe(goal.id);
			expect(restored.teamGoalId).toBe(goal.id);
			expect(restored.branch).toBe(before.branch);
			expect(restored.worktreePath).toBe(before.worktreePath);
			expect(restoredGoal.worktreeOwnerSessionId).toBe(source.id);
			expect(restoredGoal.branch).toBe(before.branch);
			expect(restoredGoal.worktreePath).toBe(before.worktreePath);
			expect(restoredTeam.teamLeadSessionId).toBe(source.id);
			expect(restoredTeam.agents ?? []).toHaveLength(0);
			const transcriptAfterRestart = transcriptSnapshot(gateway, source.id);
			expect(transcriptAfterRestart.path).toBe(transcriptBefore.path);
			expect(transcriptAfterRestart.bytes.startsWith(transcriptBefore.bytes), "restart must preserve the complete pre-promotion transcript prefix").toBe(true);

			for (const suffix of ["", "?purge=true"]) {
				const blocked = await apiFetch(`/api/sessions/${source.id}${suffix}`, { method: "DELETE" });
				expect(blocked.status, `direct promoted-session cleanup ${suffix || "archive"} must be blocked`).toBe(409);
				const blockedBody = await blocked.json() as { code?: string };
				expect(blockedBody.code).toBe("PROMOTED_SESSION_LIFECYCLE_CONFLICT");
			}

			const guarded = await sessionRecord(source.id);
			const guardedGoal = await responseJson(await apiFetch(`/api/goals/${goal.id}`));
			const guardedTeam = await teamRecord(goal.id);
			expect(guarded).toMatchObject({
				id: source.id,
				goalId: goal.id,
				teamGoalId: goal.id,
				branch: before.branch,
				worktreePath: before.worktreePath,
			});
			expect(guardedGoal.archived).not.toBe(true);
			expect(guardedTeam.teamLeadSessionId).toBe(source.id);
			expect(existsSync(before.worktreePath)).toBe(true);
			expect(transcriptSnapshot(gateway, source.id)).toEqual(transcriptAfterRestart);

			const archived = await apiFetch(`/api/goals/${goal.id}?cascade=true`, { method: "DELETE" });
			expect(archived.status, await archived.clone().text()).toBe(200);
			await expect.poll(async () => (await responseJson(await apiFetch(`/api/goals/${goal.id}`))).archived, {
				timeout: 20_000,
				message: "goal archival must be durable before promoted lead teardown",
			}).toBe(true);
			await expect.poll(async () => (await apiFetch(`/api/goals/${goal.id}/team`)).status, {
				timeout: 20_000,
				message: "ordered archive must remove the active team reservation",
			}).toBe(404);
			await expect.poll(async () => (await sessionRecord(source.id)).status, {
				timeout: 20_000,
				message: "ordered archive must archive the original promoted lead",
			}).toBe("archived");
			expect((await liveGoals()).some(candidate => candidate.id === goal.id)).toBe(false);
			expect(existsSync(before.worktreePath), "archive alone must preserve the session-owned worktree").toBe(true);

			const purged = await apiFetch(`/api/sessions/${source.id}?purge=true`, { method: "DELETE" });
			expect(purged.status, await purged.clone().text()).toBe(200);
			await expect.poll(async () => (await apiFetch(`/api/sessions/${source.id}?include=archived`)).status, {
				timeout: 20_000,
				message: "final source purge must remove the archived session row",
			}).toBe(404);
			expect((await apiFetch(`/api/goals/${goal.id}/team`)).status).toBe(404);
			expect((await responseJson(await apiFetch(`/api/goals/${goal.id}`))).archived).toBe(true);
			expect(existsSync(before.worktreePath), "final purge may clean the unreferenced adopted worktree").toBe(false);
		} finally {
			if (goalId) await apiFetch(`/api/goals/${goalId}?cascade=true`, { method: "DELETE" }).catch(() => {});
			await removeGitSession(source);
		}
	});

	test("shows the authoritative reason when Current session is unavailable", async ({ page }) => {
		const source = await createGitSession(false);
		try {
			await seedGoalProposal(source.id, source.projectId, `Unavailable promotion ${Date.now()}`);
			await openSeededProposal(page, source.id);
			const current = page.locator("[data-testid='goal-form-worktree-current-session']");
			await expect(current).toBeDisabled({ timeout: 20_000 });
			await expect(page.locator("[data-testid='goal-form-worktree-current-unavailable']")).toContainText(/.+/);
			await expect(page.locator("[data-testid='goal-form-worktree-new']")).toBeChecked();
			await expect(page.locator("[data-testid='proposal-primary-submit'] button")).toBeEnabled();
		} finally {
			await removeGitSession(source);
		}
	});

	test("keeps New worktree goal creation distinct from the proposal owner", async ({ page }) => {
		test.setTimeout(120_000);
		const source = await createGitSession(true);
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
			const goal = await waitForGoalSetup(goalId!);
			const team = await teamRecord(goal.id);
			expect(goal.worktreePath).toBeTruthy();
			expect(goal.worktreePath).not.toBe(before.worktreePath);
			expect(goal.branch).not.toBe(before.branch);
			expect(team.teamLeadSessionId).toBeTruthy();
			expect(team.teamLeadSessionId).not.toBe(source.id);
			const ownerAfter = await sessionRecord(source.id);
			expect(ownerAfter.goalId).toBeFalsy();
		} finally {
			if (goalId) await apiFetch(`/api/goals/${goalId}?cascade=true`, { method: "DELETE" }).catch(() => {});
			await removeGitSession(source);
		}
	});
});
