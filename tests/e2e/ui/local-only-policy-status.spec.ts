import type { Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "../gateway-harness.js";
import {
	apiFetch,
	createGoal,
	deleteGoal,
	deleteSession,
	registerProject,
	startTeam,
	teardownTeam,
	waitForSessionStatus,
} from "../e2e-setup.js";
import { awaitableRm, pollUntil } from "../test-utils/cleanup.js";
import { navigateToHash, openApp } from "./ui-helpers.js";

function makeGitRepo(): string {
	const repo = mkdtempSync(join(tmpdir(), `bobbit-e2e-local-only-ui-${process.pid}-`));
	writeFileSync(join(repo, "README.md"), "# local-only branch policy UI fixture\n");
	execFileSync("git", ["init"], { cwd: repo, stdio: "pipe" });
	execFileSync("git", ["checkout", "-B", "master"], { cwd: repo, stdio: "pipe" });
	execFileSync("git", ["add", "README.md"], { cwd: repo, stdio: "pipe" });
	execFileSync("git", ["-c", "user.name=Bobbit E2E", "-c", "user.email=e2e@example.test", "commit", "-m", "init"], { cwd: repo, stdio: "pipe" });
	return repo;
}

async function waitForGoalReady(goalId: string): Promise<void> {
	await pollUntil(async () => {
		const resp = await apiFetch(`/api/goals/${goalId}`);
		if (!resp.ok) return null;
		const goal = await resp.json();
		if (goal.setupStatus === "error") throw new Error(`goal setup failed: ${JSON.stringify(goal)}`);
		return goal.setupStatus === "ready" ? goal : null;
	}, { timeoutMs: 60_000, intervalMs: 250, label: `goal ${goalId} setup ready` });
}

async function spawnTeamMember(goalId: string): Promise<{ sessionId: string; branch: string }> {
	const resp = await apiFetch(`/api/goals/${goalId}/team/spawn`, {
		method: "POST",
		body: JSON.stringify({ role: "coder", task: "Reply OK and go idle." }),
	});
	const text = await resp.text();
	expect(resp.status, `spawn team member failed: ${text}`).toBe(201);
	const body = JSON.parse(text);
	const sessionId = body.sessionId as string;
	await waitForSessionStatus(sessionId, "idle", 30_000);
	const statusResp = await apiFetch(`/api/sessions/${sessionId}/git-status`);
	expect(statusResp.status).toBe(200);
	const status = await statusResp.json();
	expect(status.remotePublication).toBe("local-only-policy");
	expect(status.branch).toMatch(/^goal\/[a-f0-9]{8}\/coder-[a-f0-9]{4}$/);
	return { sessionId, branch: status.branch };
}

async function expandTeamMemberBranch(page: Page, goalId: string, teamLeadId: string, memberId: string): Promise<void> {
	const goalRow = page.locator(`[data-nav-id="goal:${goalId}"]`).first();
	await expect(goalRow).toBeVisible({ timeout: 10_000 });
	const expandGoal = goalRow.locator(`[title="Expand goal"]`).first();
	if (await expandGoal.isVisible().catch(() => false)) await expandGoal.click();

	const leadRow = page.locator(`[data-session-id="${teamLeadId}"]`).first();
	await expect(leadRow).toBeVisible({ timeout: 10_000 });
	const expandAgents = leadRow.locator(`[title="Expand agents"]`).first();
	if (await expandAgents.isVisible().catch(() => false)) await expandAgents.click();

	await expect(page.locator(`[data-session-id="${memberId}"]`).first()).toBeVisible({ timeout: 10_000 });
}

async function openGitDropdown(page: Page, sessionId: string, branch: string): Promise<void> {
	await navigateToHash(page, `#/session/${sessionId}`);
	await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });
	const readyButton = page.locator("git-status-widget button[data-state='ready']").first();
	await expect(readyButton).toBeVisible({ timeout: 30_000 });
	await expect(readyButton).toContainText(branch, { timeout: 10_000 });
	await readyButton.click();
	const dropdown = page.locator("#git-status-dropdown");
	await expect(dropdown).toBeVisible({ timeout: 5_000 });
	await expect(dropdown.getByTestId("git-local-only-policy")).toContainText("Local-only by policy", { timeout: 5_000 });
	await expect(dropdown).toContainText("not published automatically");
	await page.keyboard.press("Escape");
	await expect(dropdown).toBeHidden({ timeout: 5_000 });
}

async function terminateSessionFromSidebar(page: Page, sessionId: string): Promise<void> {
	const row = page.locator(`[data-session-id="${sessionId}"]`).first();
	await expect(row).toBeVisible({ timeout: 10_000 });
	await row.hover();
	const menuTrigger = row.locator(`[data-testid="sidebar-actions-trigger"][data-sidebar-actions-kind="session"][data-sidebar-actions-id="${sessionId}"]`).first();
	await expect(menuTrigger).toBeVisible({ timeout: 5_000 });
	await menuTrigger.click();
	const terminateItem = page.locator(`sidebar-actions-popover [role="menuitem"][data-sidebar-action-id="terminate"]`).first();
	await expect(terminateItem).toBeVisible({ timeout: 5_000 });
	await terminateItem.click();
	await expect(page.getByText(/Are you sure you want to terminate/i).first()).toBeVisible({ timeout: 5_000 });
	await page.getByRole("button", { name: "Terminate", exact: true }).last().click();
}

test.describe("local-only sub-agent branch policy (UI)", () => {
	test("team-member git status shows local-only policy, survives reload, and archives without a remote branch", async ({ page }) => {
		test.setTimeout(120_000);
		const repo = makeGitRepo();
		const project = await registerProject({ name: `local-only-ui-${Date.now()}`, rootPath: repo });
		let goalId = "";
		let teamLeadId = "";
		let memberId = "";
		try {
			const goal = await createGoal({
				title: `Local-only policy UI ${Date.now()}`,
				cwd: repo,
				projectId: project.id,
				team: true,
				worktree: true,
				autoStartTeam: false,
			});
			goalId = goal.id;
			await waitForGoalReady(goalId);
			teamLeadId = await startTeam(goalId);
			await waitForSessionStatus(teamLeadId, "idle", 30_000);

			const member = await spawnTeamMember(goalId);
			memberId = member.sessionId;

			await openApp(page);
			await expandTeamMemberBranch(page, goalId, teamLeadId, memberId);
			await openGitDropdown(page, memberId, member.branch);

			await page.reload();
			await expect(page.locator("button").filter({ hasText: "Settings" }).first()).toBeVisible({ timeout: 20_000 });
			await expandTeamMemberBranch(page, goalId, teamLeadId, memberId);
			await openGitDropdown(page, memberId, member.branch);

			await expandTeamMemberBranch(page, goalId, teamLeadId, memberId);
			await terminateSessionFromSidebar(page, memberId);
			await expect.poll(async () => {
				const resp = await apiFetch(`/api/sessions/${memberId}?include=archived`);
				if (!resp.ok) return false;
				const body = await resp.json();
				return body.archived === true;
			}, { timeout: 20_000, message: "local-only team member should archive cleanly without a remote branch" }).toBe(true);
			memberId = "";
		} finally {
			if (memberId) await deleteSession(memberId).catch(() => {});
			if (goalId) await teardownTeam(goalId).catch(() => {});
			if (teamLeadId) await deleteSession(teamLeadId).catch(() => {});
			if (goalId) await deleteGoal(goalId).catch(() => {});
			await apiFetch(`/api/projects/${project.id}`, { method: "DELETE" }).catch(() => {});
			await awaitableRm(repo, { maxAttempts: 5, backoffMs: 100, onFinalFailure: () => {} });
		}
	});
});
