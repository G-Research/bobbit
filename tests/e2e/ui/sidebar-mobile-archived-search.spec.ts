/**
 * Reproducing test for Bug 1: Mobile archived search doesn't filter.
 *
 * On mobile (< 768px viewport), `renderMobileLanding()` in `src/app/render.ts`
 * applies the search filter only to `liveGoals` and `ungroupedSessions`. The
 * `archivedGoals` array is rendered unfiltered, so every archived goal appears
 * regardless of the search query. Desktop behaviour is correct.
 *
 * This test forces See Archived on via localStorage, renders at 375x667, and
 * types a query that matches exactly one of two archived goals. It expects the
 * non-matching goal to be hidden — which will FAIL on master.
 *
 * Uses per-test isolated setup (beforeEach/afterEach) to set a precedent for
 * the flaky-tests fix in Bug 2.
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
	await apiFetch(`/api/goals/${goal.id}`, { method: "DELETE" });
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

	test("typing a search query on mobile filters archived goals", async ({ page }) => {
		// Open app at default viewport so openApp's Settings-button wait
		// succeeds, set localStorage, then resize to mobile and reload.
		await openApp(page);
		await page.evaluate(() => {
			localStorage.removeItem("bobbit-archived-collapsed-projects");
			localStorage.setItem("bobbit-show-archived", "true");
		});
		await page.setViewportSize({ width: 375, height: 667 });
		await page.reload();

		// At mobile viewport renderMobileLanding() runs — it contains a
		// <search-box> and the archived subsection (because showArchived=true).
		await expect(page.locator("input[data-search]")).toBeVisible({ timeout: 20_000 });

		// Wait for both archived goals to render (both should be visible initially
		// with no search active).
		await expect(page.getByText(matchingTitle, { exact: false }).first()).toBeVisible({
			timeout: 15_000,
		});
		await expect(page.getByText(nonMatchingTitle, { exact: false }).first()).toBeVisible({
			timeout: 10_000,
		});

		// Type query that matches only the first goal.
		const searchInput = page.locator("input[data-search]");
		await expect(searchInput).toBeVisible({ timeout: 5_000 });
		await searchInput.click();
		await searchInput.fill("story");
		// debounce + re-render
		await page.waitForTimeout(500);

		// Matching goal still visible
		await expect(page.getByText(matchingTitle, { exact: false }).first()).toBeVisible({
			timeout: 5_000,
		});

		// Non-matching goal must be hidden. On current master this FAILS because
		// renderMobileLanding() renders archivedGoals unfiltered.
		const nonMatchingCount = await page
			.getByText(nonMatchingTitle, { exact: false })
			.count();
		if (nonMatchingCount > 0) {
			throw new Error(
				`Mobile archived search did not filter: non-matching goal "${nonMatchingTitle}" still visible (count=${nonMatchingCount}) after typing query "story"`,
			);
		}
	});
});
