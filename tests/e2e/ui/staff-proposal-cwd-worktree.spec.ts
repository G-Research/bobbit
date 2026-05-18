import { test, expect } from "../gateway-harness.js";
import type { Page } from "@playwright/test";
import { openApp, createSessionViaUI, sendMessage } from "./ui-helpers.js";

interface UiProject {
	id: string;
	name: string;
	rootPath: string;
}

async function waitForActiveProject(page: Page): Promise<UiProject> {
	await page.waitForFunction(() => {
		const state = (window as any).bobbitState ?? (window as any).__bobbitState;
		const project = state?.projects?.find((p: any) => p.id === state?.activeProjectId);
		return !!project?.id && !!project?.rootPath;
	}, null, { timeout: 15_000 });
	const project = await page.evaluate(() => {
		const state = (window as any).bobbitState ?? (window as any).__bobbitState;
		return state.projects.find((p: any) => p.id === state.activeProjectId);
	});
	expect(project?.id).toBeTruthy();
	expect(project?.rootPath).toBeTruthy();
	return project as UiProject;
}

async function openStaffProposalPanel(page: Page) {
	const panel = page.locator('[data-panel="staff-proposal"]').first();
	if (!(await panel.isVisible().catch(() => false))) {
		const tab = page.locator('button.goal-tab-pill[title="Staff"]').first();
		if (await tab.isVisible().catch(() => false)) {
			await tab.click();
		} else {
			const openButton = page.locator('[data-testid="proposal-open-button"]').last();
			await expect(openButton).toBeVisible({ timeout: 15_000 });
			await openButton.click();
		}
	}
	await expect(panel).toBeVisible({ timeout: 10_000 });
	return panel;
}

test.describe("Staff proposal cwd/worktree controls", () => {
	test.describe.configure({ timeout: 90_000 });

	test("blank proposal cwd displays project root and worktree opt-out posts worktree:false", async ({ page }) => {
		let staffPostPayload: Record<string, unknown> | null = null;
		await page.route("**/api/staff", async (route) => {
			const req = route.request();
			if (req.method() !== "POST") {
				await route.continue();
				return;
			}
			staffPostPayload = req.postDataJSON() as Record<string, unknown>;
			await route.fulfill({
				status: 201,
				contentType: "application/json",
				body: JSON.stringify({
					id: "ui-staff-cwd-worktree",
					name: staffPostPayload.name,
					description: staffPostPayload.description ?? "",
					state: "active",
					triggers: staffPostPayload.triggers ?? [],
					projectId: staffPostPayload.projectId,
					cwd: staffPostPayload.cwd,
					sandboxed: staffPostPayload.sandboxed ?? false,
				}),
			});
		});

		await openApp(page);
		await createSessionViaUI(page);
		const project = await waitForActiveProject(page);

		await sendMessage(page, "STAFF_PROPOSAL_PARITY");
		await expect(page.getByText("Staff Proposal").first()).toBeVisible({ timeout: 15_000 });
		let panel = await openStaffProposalPanel(page);

		const proposalCwd = await page.evaluate(() => {
			const state = (window as any).bobbitState ?? (window as any).__bobbitState;
			return state?.activeProposals?.staff?.fields?.cwd;
		});
		expect(proposalCwd).toBe("");

		const cwdInput = panel.locator('[data-testid="staff-proposal-cwd-input"]');
		await expect(cwdInput).toHaveValue(project.rootPath, { timeout: 10_000 });
		await expect(panel.locator('[data-testid="staff-proposal-cwd-hint"]')).toContainText(project.rootPath);

		const sessionId = await page.evaluate(() => {
			const state = (window as any).bobbitState ?? (window as any).__bobbitState;
			return state?.selectedSessionId;
		});
		expect(sessionId).toBeTruthy();
		await page.reload();
		await page.waitForFunction((sid) => {
			const state = (window as any).bobbitState ?? (window as any).__bobbitState;
			return state?.selectedSessionId === sid
				&& state?.connectionStatus === "connected"
				&& state?.activeProposals?.staff?.fields?.name === "parity-staff";
		}, sessionId, { timeout: 20_000 });
		const reopenButton = page.locator('[data-testid="proposal-open-button"]').last();
		await expect(reopenButton).toBeVisible({ timeout: 15_000 });
		await reopenButton.scrollIntoViewIfNeeded();
		await reopenButton.click();
		panel = await openStaffProposalPanel(page);
		await expect(panel.locator('[data-testid="staff-proposal-cwd-input"]')).toHaveValue(project.rootPath, { timeout: 10_000 });

		const worktreeToggle = panel.locator('[data-testid="staff-proposal-worktree-checkbox"]');
		await expect(worktreeToggle).toBeChecked({ timeout: 5_000 });
		await expect(panel.locator('[data-testid="staff-proposal-worktree-mode"]')).toContainText("worktree");
		await worktreeToggle.uncheck();
		await expect(panel.locator('[data-testid="staff-proposal-worktree-mode"]')).toContainText("project directory");

		const createButton = panel.getByRole("button", { name: /Create Staff/ });
		await expect(createButton).toBeEnabled({ timeout: 5_000 });
		await createButton.click();
		await expect.poll(() => staffPostPayload?.cwd, { timeout: 10_000 }).toBe(project.rootPath);
		expect(staffPostPayload).toMatchObject({
			name: "parity-staff",
			projectId: project.id,
			cwd: project.rootPath,
			worktree: false,
		});
	});
});
