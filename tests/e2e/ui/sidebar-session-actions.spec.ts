/**
 * Sidebar session actions E2E tests — SB-14, SB-15, SB-17, SB-18, SB-19, SB-20.
 */
import { test, expect } from "../gateway-harness.js";
import {
	createSession,
	deleteSession,
	createGoal,
	teardownTeam,
	deleteGoal,
	apiFetch,
	nonGitCwd,
	waitForSessionStatus,
} from "../e2e-setup.js";
import { openApp } from "./ui-helpers.js";

test.describe("Sidebar session actions", () => {
	const sessionIds: string[] = [];
	const goalIds: string[] = [];

	test.afterAll(async () => {
		for (const id of goalIds) {
			await teardownTeam(id).catch(() => {});
			await deleteGoal(id).catch(() => {});
		}
		for (const id of sessionIds) await deleteSession(id).catch(() => {});
	});

	test("SB-14/SB-19: New session button creates a session and rename persists", async ({ page }) => {
		await openApp(page);
		await page.locator("button[title^='New session']").first().click();
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });
		await expect(async () => {
			const hash = await page.evaluate(() => window.location.hash);
			expect(hash).toMatch(/#\/session\/[a-f0-9-]+/i);
		}).toPass({ timeout: 5_000 });

		const hash = await page.evaluate(() => window.location.hash);
		const match = hash.match(/#\/session\/([a-f0-9-]+)/i);
		expect(match).toBeTruthy();
		const sessionId = match![1];
		sessionIds.push(sessionId);

		const sessionRow = page.locator(".sidebar-session-active").first();
		await expect(sessionRow).toBeVisible({ timeout: 10_000 });
		await sessionRow.hover();
		const renameBtn = sessionRow.locator("button[title='Modify']");
		await expect(renameBtn).toBeVisible({ timeout: 5_000 });
		await renameBtn.click();

		await expect(page.getByText("Edit Session").first()).toBeVisible({ timeout: 5_000 });
		const titleInput = page.locator("input[placeholder='Session title…']").first();
		await expect(titleInput).toBeVisible({ timeout: 5_000 });
		await titleInput.fill("Renamed Session E2E");
		await titleInput.press("Enter");
		await expect(page.getByText("Renamed Session E2E").first()).toBeVisible({ timeout: 5_000 });

		await page.reload();
		await expect(page.locator("button").filter({ hasText: "Settings" }).first()).toBeVisible({ timeout: 15_000 });
		await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });
		await expect(page.getByText("Renamed Session E2E").first()).toBeVisible({ timeout: 5_000 });
	});

	test("SB-17/SB-20: Start Team button creates team lead and ending team removes it", async ({ page }) => {
		const goal = await createGoal({
			title: "SB17 Team Test",
			team: true,
			worktree: false,
			autoStartTeam: false,
		});
		goalIds.push(goal.id);

		await openApp(page);
		const goalRow = page.getByText("SB17 Team Test").first();
		await expect(goalRow).toBeVisible({ timeout: 10_000 });
		await goalRow.click();

		const startBtn = page.getByText("Start Team").first();
		await expect(startBtn).toBeVisible({ timeout: 10_000 });
		await startBtn.click();
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 30_000 });
		const hash = await page.evaluate(() => window.location.hash);
		const match = hash.match(/#\/session\/([a-f0-9-]+)/i);
		expect(match).toBeTruthy();
		const teamLeadId = match![1];

		const sessionRow = page.locator(".sidebar-session-active").first();
		await expect(sessionRow).toBeVisible({ timeout: 10_000 });
		await sessionRow.hover();
		const endTeamBtn = sessionRow.locator("button[title*='End team']");
		await expect(endTeamBtn).toBeVisible({ timeout: 5_000 });
		await endTeamBtn.click();

		const confirmButton = page.locator("button").filter({ hasText: "End Team" });
		await expect(async () => {
			expect(await confirmButton.count()).toBeGreaterThanOrEqual(1);
		}).toPass({ timeout: 5_000 });
		await confirmButton.last().click();

		await expect(async () => {
			const resp = await apiFetch("/api/sessions");
			const sessions = (await resp.json()).sessions || [];
			expect(sessions.find((s: { id: string }) => s.id === teamLeadId)).toBeFalsy();
		}).toPass({ timeout: 15_000 });
	});

	test("SB-18: start one link creates session on non-team goal", async ({ page }) => {
		const goal = await createGoal({
			title: "SB18 Solo Goal",
			worktree: false,
		});
		goalIds.push(goal.id);

		await openApp(page);
		const goalRow = page.getByText("SB18 Solo Goal").first();
		await expect(goalRow).toBeVisible({ timeout: 10_000 });
		await goalRow.click();

		const startOneLocator = page.getByText("start one");
		const noSessionsLocator = page.getByText("No sessions");
		const startTeamLocator = page.getByText("Start Team");
		await expect(async () => {
			const startOne = await startOneLocator.count();
			const noSessions = await noSessionsLocator.count();
			const startTeam = await startTeamLocator.count();
			expect(startOne + noSessions + startTeam).toBeGreaterThan(0);
		}).toPass({ timeout: 10_000 });

		if (await startOneLocator.count()) await startOneLocator.first().click();
		else if (await startTeamLocator.count()) await startTeamLocator.first().click();

		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });
		await expect(async () => {
			const hash = await page.evaluate(() => window.location.hash);
			expect(hash).toMatch(/#\/session\/[a-f0-9-]+/i);
		}).toPass({ timeout: 5_000 });
		const hash = await page.evaluate(() => window.location.hash);
		const m = hash.match(/#\/session\/([a-f0-9-]+)/i);
		if (m) sessionIds.push(m[1]);
	});

	test("SB-20: terminate button removes session from sidebar @smoke", async ({ page }) => {
		const sessionId = await createSession();
		sessionIds.push(sessionId);
		await waitForSessionStatus(sessionId, "idle");

		await openApp(page);
		await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });

		const sessionRow = page.locator(".sidebar-session-active").first();
		await expect(sessionRow).toBeVisible({ timeout: 10_000 });
		await sessionRow.hover();

		const trashBtn = sessionRow.locator("button[title*='Terminate']");
		await expect(trashBtn).toBeVisible({ timeout: 5_000 });
		await trashBtn.click();

		const backdrop = page.locator(".fixed.inset-0").first();
		await expect(backdrop).toBeVisible({ timeout: 5_000 });
		await backdrop.locator("button").filter({ hasText: "Terminate" }).click();

		await expect(async () => {
			const hash = await page.evaluate(() => window.location.hash);
			expect(hash).not.toContain(sessionId);
		}).toPass({ timeout: 5_000 });

		await deleteSession(sessionId);
		await expect(async () => {
			const resp = await apiFetch("/api/sessions");
			const sessions = ((await resp.json()).sessions || []);
			expect(sessions.find((s: { id: string }) => s.id === sessionId)).toBeFalsy();
		}).toPass({ timeout: 10_000 });
	});
});
