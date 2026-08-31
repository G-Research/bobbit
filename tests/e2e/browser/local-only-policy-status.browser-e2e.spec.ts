import type { Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
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
import { navigateToHash, openApp } from "../ui/ui-helpers.js";

function makeGitRepo(): string {
	const repo = mkdtempSync(join(tmpdir(), `bobbit-e2e-local-only-ui-${process.pid}-`));
	writeFileSync(join(repo, "README.md"), "# local-only branch policy UI fixture\n");
	execFileSync("git", ["init"], { cwd: repo, stdio: "pipe" });
	execFileSync("git", ["checkout", "-B", "master"], { cwd: repo, stdio: "pipe" });
	execFileSync("git", ["add", "README.md"], { cwd: repo, stdio: "pipe" });
	execFileSync("git", ["-c", "user.name=Bobbit E2E", "-c", "user.email=e2e@example.test", "commit", "-m", "init"], { cwd: repo, stdio: "pipe" });
	return realpathSync(repo);
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

type MockBarrierCore = {
	armBarrier(name: string): string;
	waitForBarrier(name: string): Promise<unknown>;
	releaseBarrier(name: string): boolean;
};

type MockBridge = {
	options?: { sessionId?: string; env?: Record<string, string> };
	_agent?: MockBarrierCore | null;
};

type MockBridgePrototype = {
	start(this: MockBridge): Promise<void>;
};

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
	await expect(dropdown.getByTestId("git-local-only-policy")).toHaveCount(0);
	await expect(dropdown.getByRole("button", { name: "Push", exact: true })).toHaveCount(0);
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
	test("team-member git status stays local-only, survives reload, and archives without a remote branch", async ({ page, gateway }) => {
		test.setTimeout(120_000);
		const repo = makeGitRepo();
		const project = await registerProject({ name: `local-only-ui-${Date.now()}`, rootPath: repo });
		expect(project.rootPath).toBe(repo);
		let goalId = "";
		let teamLeadId = "";
		let memberId = "";
		let bridgePrototype: MockBridgePrototype | undefined;
		let originalBridgeStart: MockBridgePrototype["start"] | undefined;
		let heldBridge: MockBridge | undefined;
		let heldCore: MockBarrierCore | undefined;
		let capturedSessionId = "";
		try {
			const goal = await createGoal({
				title: `Local-only policy UI ${Date.now()}`,
				cwd: repo,
				projectId: project.id,
				team: true,
				worktree: true,
				autoStartTeam: false,
			});
			expect(goal.cwd).toBe(repo);
			goalId = goal.id;
			await waitForGoalReady(goalId);
			teamLeadId = await startTeam(goalId);
			await waitForSessionStatus(teamLeadId, "idle", 30_000);

			const sessionsBeforeSpawn = new Set<string>(
				gateway.sessionManager.getAllSessionsRaw().map((session: { id: string }) => session.id),
			);
			const bridgeModule = await import("../in-process-mock-bridge.mjs");
			bridgePrototype = bridgeModule.InProcessMockBridge.prototype as MockBridgePrototype;
			originalBridgeStart = bridgePrototype.start;
			const startBridge = originalBridgeStart;
			bridgePrototype.start = async function holdSpawnedWorker() {
				await startBridge.call(this);
				const sessionId = this.options?.sessionId ?? this.options?.env?.BOBBIT_SESSION_ID;
				if (!sessionId || sessionsBeforeSpawn.has(sessionId)) return;
				expect(heldBridge, "only the newly spawned worker bridge may be captured").toBeUndefined();
				const core = this._agent;
				expect(core, "spawned worker must expose the in-process mock barrier seam").toBeTruthy();
				core!.armBarrier("tool:before-end");
				heldBridge = this;
				heldCore = core!;
				capturedSessionId = sessionId;
			};

			let spawnResp: Response;
			try {
				spawnResp = await apiFetch(`/api/goals/${goalId}/team/spawn`, {
					method: "POST",
					body: JSON.stringify({ role: "coder", task: "RELIABLE_TOOL_HOLD" }),
				});
			} finally {
				bridgePrototype.start = originalBridgeStart;
			}
			const spawnText = await spawnResp.text();
			expect(spawnResp.status, `spawn team member failed: ${spawnText}`).toBe(201);
			memberId = (JSON.parse(spawnText) as { sessionId: string }).sessionId;

			expect(heldCore, "the spawned worker must own the named tool barrier").toBeTruthy();
			await heldCore!.waitForBarrier("tool:before-end");
			expect(capturedSessionId, "the prototype seam must capture the spawned worker identity").toBe(memberId);
			const streamingWorker = gateway.sessionManager.getSession(memberId);
			expect(streamingWorker, "spawned worker must remain live while held at the tool boundary").toBeTruthy();
			expect(streamingWorker?.rpcClient).toBe(heldBridge);
			expect(streamingWorker?.rpcClient?._agent).toBe(heldCore);
			expect(streamingWorker?.status).toBe("streaming");

			const statusResp = await apiFetch(`/api/sessions/${memberId}/git-status`);
			expect(statusResp.status).toBe(200);
			const status = await statusResp.json();
			expect(status.branch).toMatch(/^goal\/[a-f0-9]{8}\/coder-[a-f0-9]{4}$/);
			expect(status.hasUpstream).toBe(false);
			expect(status).not.toHaveProperty("remotePublication");

			await openApp(page);
			await expandTeamMemberBranch(page, goalId, teamLeadId, memberId);
			await openGitDropdown(page, memberId, status.branch);

			await page.reload();
			await expect(page.locator("button").filter({ hasText: "Settings" }).first()).toBeVisible({ timeout: 20_000 });
			await expandTeamMemberBranch(page, goalId, teamLeadId, memberId);
			await openGitDropdown(page, memberId, status.branch);

			const idleAfterRelease = gateway.sessionManager.waitForIdle(memberId);
			heldCore?.releaseBarrier("tool:before-end");
			await idleAfterRelease;
			const idleWorker = gateway.sessionManager.getSession(memberId);
			expect(idleWorker, "released worker must remain live through authoritative idle").toBe(streamingWorker);
			expect(idleWorker?.rpcClient).toBe(heldBridge);
			expect(idleWorker?.status).toBe("idle");

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
			if (bridgePrototype && originalBridgeStart) bridgePrototype.start = originalBridgeStart;
			heldCore?.releaseBarrier("tool:before-end");
			if (memberId) await deleteSession(memberId).catch(() => {});
			if (goalId) await teardownTeam(goalId).catch(() => {});
			if (teamLeadId) await deleteSession(teamLeadId).catch(() => {});
			if (goalId) await deleteGoal(goalId).catch(() => {});
			await apiFetch(`/api/projects/${project.id}`, { method: "DELETE" }).catch(() => {});
			await awaitableRm(repo, { maxAttempts: 5, backoffMs: 100, onFinalFailure: () => {} });
		}
	});
});
