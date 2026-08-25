import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Locator } from "@playwright/test";
import { apiFetch, createGoal, createSession, deleteGoal, deleteSession, expect, navigateToHash, openApp, registerProject, test, waitForSessionStatus } from "../_helpers/journey-fixture.js";

type GitFixture = {
	root: string;
	repo: string;
	projectId: string;
};

const SETUP_ERROR = "could not lock config file .git/config.lock: File exists";

function git(cwd: string, ...args: string[]): void {
	execFileSync("git", args, { cwd, stdio: "pipe" });
}

async function createGitFixture(): Promise<GitFixture> {
	const root = mkdtempSync(join(tmpdir(), "bobbit-goal-setup-recovery-"));
	const repo = join(root, "repo");
	git(root, "init", "--initial-branch=main", repo);
	git(repo, "config", "user.name", "Goal Setup Recovery Browser Test");
	git(repo, "config", "user.email", "goal-setup-recovery@example.test");
	writeFileSync(join(repo, "README.md"), "goal setup recovery fixture\n");
	git(repo, "add", "README.md");
	git(repo, "commit", "-m", "fixture initial commit");
	const project = await registerProject({
		name: `goal-setup-recovery-${Date.now()}`,
		rootPath: repo,
	});
	return { root, repo, projectId: project.id };
}

async function removeGitFixture(fixture: GitFixture | undefined): Promise<void> {
	if (!fixture) return;
	await apiFetch(`/api/projects/${fixture.projectId}`, { method: "DELETE" }).catch(() => {});
	try {
		rmSync(fixture.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
	} catch {
		// A Git process can retain a short-lived handle after goal cleanup.
	}
}

async function readGoal(goalId: string): Promise<any> {
	const response = await apiFetch(`/api/goals/${goalId}`);
	expect(response.status, `read goal ${goalId}`).toBe(200);
	return response.json();
}

async function waitForGoalSetup(goalId: string, status: string): Promise<void> {
	await expect.poll(async () => (await readGoal(goalId)).setupStatus, {
		timeout: 30_000,
		message: `goal ${goalId} should reach setupStatus=${status}`,
	}).toBe(status);
}

function sidebarGoal(page: any, goalId: string): Locator {
	return page.locator(`[data-nav-id="goal:${goalId}"]`).first();
}

function sidebarAction(goal: Locator, title: string): Locator {
	return goal.locator("xpath=..").locator(`button[title="${title}"]`).first();
}

async function expandSidebarGoal(goal: Locator): Promise<void> {
	const expand = goal.locator('[title="Expand goal"]');
	if (await expand.count()) await expand.click();
	await goal.hover();
}

test.describe("Goal setup recovery journey", () => {
	test("SETUP_RECOVERY_BROWSER keeps current setup errors actionable and clears every recovered surface after the live ready update and reload", async ({ page, gateway }) => {
		test.setTimeout(90_000);
		let fixture: GitFixture | undefined;
		let teamGoalId = "";
		let sessionGoalId = "";
		let sessionGoalSessionId = "";
		let releaseRetry: (() => void) | undefined;
		let restoreSetupWorktree: (() => void) | undefined;

		try {
			fixture = await createGitFixture();
			const teamGoal = await createGoal({
				title: `Goal setup recovery team ${Date.now()}`,
				cwd: fixture.repo,
				projectId: fixture.projectId,
				worktree: true,
				team: true,
				autoStartTeam: false,
			});
			teamGoalId = String(teamGoal.id);
			await waitForGoalSetup(teamGoalId, "ready");

			const sessionGoal = await createGoal({
				title: `Goal setup recovery session ${Date.now()}`,
				cwd: fixture.repo,
				projectId: fixture.projectId,
				worktree: false,
			});
			sessionGoalId = String(sessionGoal.id);

			// The public goal route creates team-capable goals. Persist a real legacy
			// session-scoped goal before starting its actual session so this journey
			// exercises the dashboard's New Session control rather than a mocked DOM.
			const goalStore = gateway.sessionManager!.getGoalStoreForProject(fixture.projectId);
			goalStore.update(sessionGoalId, { team: false });
			sessionGoalSessionId = await createSession({
				cwd: fixture.repo,
				goalId: sessionGoalId,
				projectId: fixture.projectId,
			});
			await waitForSessionStatus(sessionGoalSessionId, "idle");

			goalStore.transitionSetup(teamGoalId, "error", SETUP_ERROR);
			goalStore.transitionSetup(sessionGoalId, "error", SETUP_ERROR);

			await openApp(page);
			await navigateToHash(page, `#/goal/${teamGoalId}`);
			const dashboard = page.getByTestId("goal-dashboard");
			const teamSidebar = sidebarGoal(page, teamGoalId);
			await expect(dashboard.locator(".setup-banner--error")).toContainText(SETUP_ERROR, { timeout: 20_000 });
			await expect(dashboard.getByRole("button", { name: "Retry Setup", exact: true })).toBeVisible();
			await expect(dashboard.getByRole("button", { name: "Start Team", exact: true })).toBeDisabled();
			await expect(teamSidebar).toBeVisible({ timeout: 20_000 });
			await expandSidebarGoal(teamSidebar);
			await expect(teamSidebar.locator('[title="Worktree setup failed"]')).toBeVisible();
			await expect(sidebarAction(teamSidebar, "Worktree setup failed")).toBeDisabled();

			// A non-team goal has the same setup authority: session creation is not a
			// bypass around an active failure.
			await navigateToHash(page, `#/goal/${sessionGoalId}`);
			const sessionDashboard = page.getByTestId("goal-dashboard");
			await expect(sessionDashboard.locator(".setup-banner--error")).toContainText(SETUP_ERROR, { timeout: 20_000 });
			await expect(sessionDashboard.getByRole("button", { name: "New Session", exact: true })).toBeDisabled();

			// Hold the gateway's authoritative retry flight rather than mocking the
			// browser: the real retry route broadcasts retrying, then its settled
			// callback broadcasts ready. Releasing the hold runs the real setup code
			// against the already-provisioned worktree, exercising its reconciliation
			// and postcondition validation without starting an agent.
			const context = (gateway.sessionManager as any).projectContextManager.getOrCreate(fixture.projectId);
			const goalManager = context.goalManager;
			const originalSetupWorktree = goalManager.setupWorktree.bind(goalManager);
			const retryReleased = new Promise<void>((resolve) => { releaseRetry = resolve; });
			goalManager.setupWorktree = async (goalId: string): Promise<void> => {
				if (goalId !== teamGoalId) return originalSetupWorktree(goalId);
				await retryReleased;
				await originalSetupWorktree(goalId);
			};
			restoreSetupWorktree = () => { goalManager.setupWorktree = originalSetupWorktree; };

			await navigateToHash(page, `#/goal/${teamGoalId}`);
			const retryButton = dashboard.getByRole("button", { name: "Retry Setup", exact: true });
			await retryButton.click();
			const retryingBanner = dashboard.locator('.setup-banner--preparing[data-setup-status="retrying"]');
			await expect(retryingBanner).toContainText("Retrying worktree setup", { timeout: 20_000 });
			await expect(retryingBanner.locator("svg.animate-spin")).toBeVisible();
			const retryingStart = dashboard.getByRole("button", { name: "Retrying…", exact: true });
			await expect(retryingStart).toBeDisabled();
			await expect(sidebarAction(teamSidebar, "Retrying worktree setup…")).toBeDisabled();
			expect(gateway.teamManager?.getTeamState(teamGoalId), "retrying setup must not create a team").toBeUndefined();
			expect(await page.evaluate((goalId) => {
				const state = (window as any).__bobbitState ?? (window as any).bobbitState;
				return state.gatewaySessions.filter((session: any) => session.goalId === goalId || session.teamGoalId === goalId).length;
			}, teamGoalId), "retrying setup must not create an agent session").toBe(0);

			releaseRetry?.();
			await expect.poll(async () => (await readGoal(teamGoalId)).setupStatus, { timeout: 20_000 }).toBe("ready");
			await expect(dashboard.locator(".setup-banner--error")).toHaveCount(0, { timeout: 20_000 });
			await expect(dashboard.locator(".setup-banner--preparing")).toHaveCount(0);
			await expect(dashboard.getByRole("button", { name: "Retry Setup", exact: true })).toHaveCount(0);
			await expect(dashboard.getByRole("button", { name: "Start Team", exact: true })).toBeEnabled();
			await expect(teamSidebar.locator('[title="Worktree setup failed"]')).toHaveCount(0);
			await expect(sidebarAction(teamSidebar, "Start team")).toBeEnabled();
			expect(gateway.teamManager?.getTeamState(teamGoalId), "ready recovery alone must not auto-start a manual team").toBeUndefined();

			await page.reload({ waitUntil: "domcontentloaded" });
			await navigateToHash(page, `#/goal/${teamGoalId}`);
			await expect(dashboard).toBeVisible({ timeout: 20_000 });
			await expandSidebarGoal(teamSidebar);
			await expect(dashboard.locator(".setup-banner--error")).toHaveCount(0);
			await expect(dashboard.getByRole("button", { name: "Start Team", exact: true })).toBeEnabled();
			await expect(teamSidebar.locator('[title="Worktree setup failed"]')).toHaveCount(0);
			await expect(sidebarAction(teamSidebar, "Start team")).toBeEnabled();
			const recovered = await readGoal(teamGoalId);
			expect(recovered.setupError, "ready recovery must persist without an active stale error").toBeUndefined();
			expect(gateway.teamManager?.getTeamState(teamGoalId), "reload must not manufacture a team").toBeUndefined();
		} finally {
			releaseRetry?.();
			restoreSetupWorktree?.();
			if (sessionGoalSessionId) await deleteSession(sessionGoalSessionId);
			if (teamGoalId) await deleteGoal(teamGoalId);
			if (sessionGoalId) await deleteGoal(sessionGoalId);
			await removeGitFixture(fixture);
		}
	});
});
