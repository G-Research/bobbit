/**
 * Sidebar navigation E2E tests — SB-01, SB-02/SB-03, SB-04, SB-21.
 */
import { test, expect } from "../gateway-harness.js";
import {
	createSession,
	deleteSession,
	createGoal,
	startTeam,
	teardownTeam,
	deleteGoal,
	nonGitCwd,
	waitForSessionStatus,
} from "../e2e-setup.js";
import { openApp, navigateToHash } from "./ui-helpers.js";

test.describe("Sidebar navigation", () => {
	const sessionIds: string[] = [];
	const goalIds: string[] = [];

	test.afterAll(async () => {
		for (const gid of goalIds) {
			await teardownTeam(gid).catch(() => {});
			await deleteGoal(gid).catch(() => {});
		}
		for (const sid of sessionIds) await deleteSession(sid).catch(() => {});
	});

	test("SB-01/SB-04: session navigation highlights active row and rapid switching settles on last @smoke", async ({ page }) => {
		const idA = await createSession();
		const idB = await createSession();
		const idC = await createSession();
		sessionIds.push(idA, idB, idC);
		await waitForSessionStatus(idA, "idle");
		await waitForSessionStatus(idB, "idle");
		await waitForSessionStatus(idC, "idle");

		await openApp(page);

		await navigateToHash(page, `#/session/${idA}`);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 10_000 });
		expect(await page.evaluate(() => window.location.hash)).toContain(idA);
		await expect(page.locator(".sidebar-session-active")).toBeVisible({ timeout: 5_000 });

		await navigateToHash(page, `#/session/${idB}`);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 10_000 });
		expect(await page.evaluate(() => window.location.hash)).toContain(idB);
		await expect(page.locator(".sidebar-session-active")).toHaveCount(1, { timeout: 5_000 });

		await page.evaluate(
			([a, b, c]) => {
				window.location.hash = `#/session/${a}`;
				setTimeout(() => { window.location.hash = `#/session/${b}`; }, 50);
				setTimeout(() => { window.location.hash = `#/session/${c}`; }, 100);
			},
			[idA, idB, idC],
		);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });
		await expect(async () => {
			const hash = await page.evaluate(() => window.location.hash);
			expect(hash).toContain(idC);
		}).toPass({ timeout: 10_000 });
		await expect(page.locator(".sidebar-session-active")).toHaveCount(1, { timeout: 5_000 });
	});

	test("SB-02/SB-03: team goal expands and navigating to team lead highlights it", async ({ page }) => {
		const goal = await createGoal({
			title: "Nav Team Test",
			worktree: false,
			team: true,
		});
		goalIds.push(goal.id);
		const teamLeadId = await startTeam(goal.id);

		await openApp(page);
		const goalHeader = page.getByText("Nav Team Test", { exact: false }).first();
		await expect(goalHeader).toBeVisible({ timeout: 15_000 });
		await expect(goalHeader.locator("xpath=ancestor-or-self::*[contains(@class, 'uppercase')]").first()).toBeVisible();

		const collapseChevron = page.locator("[title='Collapse goal']").first();
		if (!(await collapseChevron.isVisible().catch(() => false))) {
			await page.locator("[title='Expand goal']").first().click();
		}

		await waitForSessionStatus(teamLeadId, "idle");
		await navigateToHash(page, `#/session/${teamLeadId}`);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });
		expect(await page.evaluate(() => window.location.hash)).toContain(teamLeadId);
		await expect(page.locator(".sidebar-session-active")).toBeVisible({ timeout: 10_000 });
	});

	test("SB-21: dashboard button navigates to goal dashboard", async ({ page }) => {
		test.setTimeout(60_000);
		const goal = await createGoal({
			title: "DashNav Test",
			worktree: false,
			team: true,
		});
		goalIds.push(goal.id);

		await openApp(page);
		const goalHeader = page.getByText("DASHNAV TEST", { exact: false }).first();
		await expect(goalHeader).toBeVisible({ timeout: 15_000 });

		const goalRow = goalHeader.locator("xpath=ancestor::div[contains(@class, 'group')]").first();
		await expect.poll(
			() => goalRow.evaluate((row) => !!row.querySelector("button[title='Goal dashboard']")),
			{ timeout: 10_000 },
		).toBe(true);
		await expect(async () => {
			await goalRow.evaluate((row) => {
				const btn = row.querySelector<HTMLButtonElement>("button[title='Goal dashboard']");
				if (!btn) throw new Error("Dashboard button not found in goal row");
				btn.click();
			});
			const h = await page.evaluate(() => window.location.hash);
			expect(h).toContain(goal.id);
			expect(h).toMatch(/goal/i);
		}).toPass({ timeout: 15_000 });

		await expect(page.locator(".dashboard-container").first()).toBeVisible({ timeout: 20_000 });
		await expect(page.locator(".tab").first()).toBeVisible({ timeout: 25_000 });
	});
});
