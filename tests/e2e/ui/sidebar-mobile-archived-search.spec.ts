/**
 * Mobile archived search filtering through the real responsive sidebar.
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch, deleteGoal, nonGitCwd, waitForHealth } from "../e2e-setup.js";
import { openApp } from "./ui-helpers.js";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

async function registerProject(name: string): Promise<{ id: string; rootPath: string }> {
	const rootPath = join(
		tmpdir(),
		`bobbit-e2e-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
	);
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
		body: JSON.stringify({
			title,
			cwd: nonGitCwd(),
			worktree: false,
			projectId,
			autoStartTeam: false,
		}),
	});
	expect(resp.status).toBe(201);
	const goal = await resp.json();
	await apiFetch(`/api/goals/${goal.id}?cascade=true`, { method: "DELETE" });
	return goal.id;
}

test.describe("Mobile sidebar archived search filtering", () => {
	let project: { id: string; rootPath: string };
	const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const matchingTitle = `story-match-${suffix}`;
	const nonMatchingTitle = `unrelated-widget-${suffix}`;
	const goalIds: string[] = [];

	test.beforeEach(async () => {
		await waitForHealth();
		project = await registerProject(`proj-mobile-arch-${suffix}`);
		goalIds.push(await createArchivedGoal(project.id, matchingTitle));
		goalIds.push(await createArchivedGoal(project.id, nonMatchingTitle));
	});

	test.afterEach(async () => {
		for (const id of goalIds.splice(0)) await deleteGoal(id).catch(() => {});
		await apiFetch(`/api/projects/${project.id}`, { method: "DELETE" }).catch(() => {});
	});

	test("typing a search query filters archived goals and highlights the match", async ({ page }) => {
		await openApp(page);
		await page.evaluate(() => {
			localStorage.removeItem("bobbit-archived-collapsed-projects");
			localStorage.setItem("bobbit-show-archived", "true");
		});
		await page.setViewportSize({ width: 375, height: 667 });
		await page.reload();

		await expect(page.locator("input[data-search]")).toBeVisible({ timeout: 20_000 });
		await expect(page.getByText(matchingTitle, { exact: false }).first()).toBeVisible({ timeout: 15_000 });
		await expect(page.getByText(nonMatchingTitle, { exact: false }).first()).toBeVisible({ timeout: 10_000 });

		const searchInput = page.locator("input[data-search]");
		await searchInput.fill("story");

		await expect(page.getByText(matchingTitle, { exact: false }).first()).toBeVisible({ timeout: 5_000 });
		await expect(
			page.getByText(nonMatchingTitle, { exact: false }),
			`Mobile archived search did not filter: non-matching goal "${nonMatchingTitle}" still visible after typing query "story"`,
		).toHaveCount(0, { timeout: 5_000 });

		const strongs = page.locator("strong.font-semibold");
		await expect.poll(async () => strongs.count(), { timeout: 5_000 }).toBeGreaterThan(0);
		const strongTexts = await strongs.allTextContents();
		expect(strongTexts.some(t => t.toLowerCase().includes("story"))).toBe(true);
	});
});
