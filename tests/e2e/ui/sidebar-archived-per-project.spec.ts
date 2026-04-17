/**
 * E2E tests for per-project Archived subsections in the sidebar.
 *
 * Covers the design in goal `per-projec-91933e61`: the single global Archived
 * block at the bottom of the sidebar is replaced by a collapsible Archived
 * subsection nested inside each project group.
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
	// Archive via DELETE
	await apiFetch(`/api/goals/${goal.id}`, { method: "DELETE" });
	return goal.id;
}

test.describe("Per-project Archived subsections", () => {
	const created: { projectId: string; goalId: string; title: string }[] = [];
	let projectA: { id: string; rootPath: string };
	let projectB: { id: string; rootPath: string };
	const goalATitle = `ArchivedAlpha-${Date.now()}`;
	const goalBTitle = `ArchivedBravo-${Date.now()}`;

	test.beforeAll(async () => {
		await waitForHealth();
		projectA = await registerProject("proj-archived-a");
		projectB = await registerProject("proj-archived-b");
		const goalA = await createArchivedGoal(projectA.id, goalATitle);
		const goalB = await createArchivedGoal(projectB.id, goalBTitle);
		created.push({ projectId: projectA.id, goalId: goalA, title: goalATitle });
		created.push({ projectId: projectB.id, goalId: goalB, title: goalBTitle });
	});

	test.afterAll(async () => {
		for (const g of created) await deleteGoal(g.goalId).catch(() => {});
		// Best-effort project cleanup
		await apiFetch(`/api/projects/${projectA.id}`, { method: "DELETE" }).catch(() => {});
		await apiFetch(`/api/projects/${projectB.id}`, { method: "DELETE" }).catch(() => {});
	});

	test("each project gets its own Archived subsection; no global block", async ({ page }) => {
		await openApp(page);

		// Wait for both project headers to render
		await expect(page.locator(".sidebar-edge").getByText("proj-archived-a", { exact: false }).first()).toBeVisible({ timeout: 15_000 });
		await expect(page.locator(".sidebar-edge").getByText("proj-archived-b", { exact: false }).first()).toBeVisible({ timeout: 5_000 });

		// Click "See Archived" in the bottom toolbar
		const seeArchived = page.locator("button").filter({ hasText: "See Archived" }).first();
		await expect(seeArchived).toBeVisible({ timeout: 10_000 });
		await seeArchived.click();

		// There should be TWO Archived subsection headers (one per project), not one global.
		// Header label has class "uppercase" and text "Archived".
		const archivedHeaders = page.locator("span.uppercase").filter({ hasText: /^Archived$/ });
		await expect(archivedHeaders).toHaveCount(2, { timeout: 10_000 });

		// Expand both per-project Archived subsections — locate the header buttons
		// (the <button> that contains the "Archived" uppercase label).
		const archivedButtons = page.locator("button").filter({ has: page.locator("span.uppercase", { hasText: /^Archived$/ }) });
		await expect(archivedButtons).toHaveCount(2, { timeout: 5_000 });
		await archivedButtons.nth(0).click();
		await archivedButtons.nth(1).click();

		// Each archived goal title must appear once, under its project.
		await expect(page.getByText(goalATitle, { exact: false }).first()).toBeVisible({ timeout: 10_000 });
		await expect(page.getByText(goalBTitle, { exact: false }).first()).toBeVisible({ timeout: 5_000 });

		// Structural check: goal A's title appears inside project A's section, not project B.
		// The project content is rendered under a single flex container nested below each
		// project header. We verify by DOM order: the archived subsection that contains
		// goal A's title should also contain project A's name earlier in the DOM.
		const goalAIndex = await page.locator(`text=${goalATitle}`).first().evaluate((el) => {
			const all = Array.from(document.querySelectorAll(".sidebar-edge *"));
			return all.indexOf(el);
		});
		const projectAIndex = await page.locator(".sidebar-edge").getByText("proj-archived-a", { exact: false }).first().evaluate((el) => {
			const all = Array.from(document.querySelectorAll(".sidebar-edge *"));
			return all.indexOf(el);
		});
		const projectBIndex = await page.locator(".sidebar-edge").getByText("proj-archived-b", { exact: false }).first().evaluate((el) => {
			const all = Array.from(document.querySelectorAll(".sidebar-edge *"));
			return all.indexOf(el);
		});
		expect(goalAIndex).toBeGreaterThan(projectAIndex);
		expect(goalAIndex).toBeLessThan(projectBIndex);
	});

	test("per-project expand state persists across reload", async ({ page }) => {
		await openApp(page);

		// Turn See Archived on if not already
		const seeArchived = page.locator("button").filter({ hasText: "See Archived" }).first();
		await expect(seeArchived).toBeVisible({ timeout: 10_000 });
		const isOn = await seeArchived.evaluate((el) => el.className.includes("text-primary"));
		if (!isOn) await seeArchived.click();

		// Wait for per-project Archived headers
		const archivedButtons = page.locator("button").filter({ has: page.locator("span.uppercase", { hasText: /^Archived$/ }) });
		await expect(archivedButtons).toHaveCount(2, { timeout: 10_000 });

		// Expand project A's (the first one in DOM) archived subsection
		await archivedButtons.nth(0).click();

		// Goal A should now be visible
		await expect(page.getByText(goalATitle, { exact: false }).first()).toBeVisible({ timeout: 5_000 });

		// localStorage should record project A as expanded
		const stored = await page.evaluate(() => localStorage.getItem("bobbit-archived-expanded-projects"));
		expect(stored).toBeTruthy();
		const ids = JSON.parse(stored!);
		expect(ids).toContain(projectA.id);

		// Reload — expand state should persist
		await page.reload();
		await expect(page.locator("button").filter({ hasText: "Settings" }).first()).toBeVisible({ timeout: 15_000 });

		// Goal A should still be visible (project A archived subsection still expanded)
		await expect(page.getByText(goalATitle, { exact: false }).first()).toBeVisible({ timeout: 10_000 });

		// Goal B should not be visible (project B archived still collapsed)
		await expect(page.getByText(goalBTitle, { exact: false })).toHaveCount(0, { timeout: 3_000 });
	});

	test("search surfaces archived items in the correct project subsection", async ({ page }) => {
		await openApp(page);

		// Ensure clean state: clear the expanded archived projects pref
		await page.evaluate(() => localStorage.removeItem("bobbit-archived-expanded-projects"));
		// Make sure See Archived is off so the search-auto-open behaviour kicks in
		await page.evaluate(() => localStorage.setItem("bobbit-show-archived", "false"));
		await page.reload();
		await expect(page.locator("button").filter({ hasText: "Settings" }).first()).toBeVisible({ timeout: 15_000 });

		// Type goal A's unique title into search
		const searchInput = page.locator("input[data-search]");
		await searchInput.click();
		await searchInput.fill(goalATitle);
		// Debounce
		await page.waitForTimeout(400);

		// Auto-open should have flipped showArchived on; still need to expand project A's subsection
		const archivedButtons = page.locator("button").filter({ has: page.locator("span.uppercase", { hasText: /^Archived$/ }) });
		// Only project A's archived subsection has matches → only one header visible.
		await expect(archivedButtons).toHaveCount(1, { timeout: 10_000 });
		await archivedButtons.nth(0).click();

		// Goal A matches, goal B does not
		await expect(page.getByText(goalATitle, { exact: false }).first()).toBeVisible({ timeout: 5_000 });
		await expect(page.getByText(goalBTitle, { exact: false })).toHaveCount(0, { timeout: 3_000 });

		// Clear search
		await searchInput.fill("");
		await page.waitForTimeout(400);
	});

	test("toggling See Archived off hides all per-project Archived subsections", async ({ page }) => {
		await openApp(page);

		const seeArchived = page.locator("button").filter({ hasText: "See Archived" }).first();
		const isOn = await seeArchived.evaluate((el) => el.className.includes("text-primary"));
		if (!isOn) {
			await seeArchived.click();
			// verify subsections appear
			await expect(page.locator("span.uppercase").filter({ hasText: /^Archived$/ })).toHaveCount(2, { timeout: 10_000 });
		}

		// Turn off
		await seeArchived.click();

		// All Archived subsection headers should be gone
		await expect(page.locator("span.uppercase").filter({ hasText: /^Archived$/ })).toHaveCount(0, { timeout: 5_000 });
		// Archived goal titles should no longer be visible
		await expect(page.getByText(goalATitle, { exact: false })).toHaveCount(0, { timeout: 3_000 });
		await expect(page.getByText(goalBTitle, { exact: false })).toHaveCount(0, { timeout: 3_000 });
	});
});
