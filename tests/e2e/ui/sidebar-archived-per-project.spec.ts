/**
 * Minimal desktop full-stack smoke for per-project Archived subsections.
 * Collapse/search/order matrices live in tests/ui-fixtures/sidebar-archived-fixture.spec.ts.
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch, deleteGoal, nonGitCwd, waitForHealth } from "../e2e-setup.js";
import { openApp } from "./ui-helpers.js";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

async function registerProject(name: string): Promise<{ id: string; rootPath: string }> {
	const rootPath = join(tmpdir(), `bobbit-e2e-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
	mkdirSync(rootPath, { recursive: true });
	const resp = await apiFetch("/api/projects", {
		method: "POST",
		body: JSON.stringify({ name, rootPath }),
	});
	expect(resp.status).toBe(201);
	const data = await resp.json();
	return { id: data.id, rootPath };
}

async function createArchivedGoal(projectId: string, title: string): Promise<string> {
	const resp = await apiFetch("/api/goals", {
		method: "POST",
		body: JSON.stringify({ title, cwd: nonGitCwd(), worktree: false, projectId, autoStartTeam: false }),
	});
	expect(resp.status).toBe(201);
	const goal = await resp.json();
	await apiFetch(`/api/goals/${goal.id}?cascade=false`, { method: "DELETE" });
	return goal.id;
}

function uniqueSuffix(label: string): string {
	const slug = label.replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 16);
	return `${slug}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

test.describe("Per-project Archived subsection full-stack smoke", () => {
	test("desktop renders archived goals under their owning projects", async ({ page }) => {
		test.setTimeout(45_000);
		await waitForHealth();
		const suffix = uniqueSuffix(test.info().title);
		const projectA = await registerProject(`proj-archived-a-${suffix}`);
		const projectB = await registerProject(`proj-archived-b-${suffix}`);
		const goalATitle = `ArchivedAlpha-${suffix}`;
		const goalBTitle = `ArchivedBravo-${suffix}`;
		const goalAId = await createArchivedGoal(projectA.id, goalATitle);
		const goalBId = await createArchivedGoal(projectB.id, goalBTitle);

		try {
			await openApp(page);
			await page.evaluate(() => {
				localStorage.removeItem("bobbit-archived-collapsed-projects");
				localStorage.setItem("bobbit-show-archived", "true");
			});
			await page.reload();
			await expect(page.locator("button").filter({ hasText: "Settings" }).first()).toBeVisible({ timeout: 20_000 });

			await expect(page.locator(".sidebar-edge").getByText("proj-archived-a-", { exact: false }).first()).toBeVisible({ timeout: 15_000 });
			await expect(page.locator(".sidebar-edge").getByText("proj-archived-b-", { exact: false }).first()).toBeVisible({ timeout: 15_000 });
			await expect(page.getByText(goalATitle, { exact: false }).first()).toBeVisible({ timeout: 15_000 });
			await expect(page.getByText(goalBTitle, { exact: false }).first()).toBeVisible({ timeout: 15_000 });

			const scopedProjectNames = await page.locator(".sidebar-edge [data-testid='project-header']").allTextContents();
			expect(scopedProjectNames.some(text => text.includes("proj-archived-a-"))).toBe(true);
			expect(scopedProjectNames.some(text => text.includes("proj-archived-b-"))).toBe(true);
		} finally {
			await deleteGoal(goalAId).catch(() => {});
			await deleteGoal(goalBId).catch(() => {});
			await apiFetch(`/api/projects/${projectA.id}`, { method: "DELETE" }).catch(() => {});
			await apiFetch(`/api/projects/${projectB.id}`, { method: "DELETE" }).catch(() => {});
		}
	});
});
