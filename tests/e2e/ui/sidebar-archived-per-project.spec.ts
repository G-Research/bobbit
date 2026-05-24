/**
 * E2E tests for per-project Archived subsections in the sidebar.
 *
 * Consolidated into one browser flow so the expensive project/archived-goal
 * setup is shared while preserving the real desktop render, persistence,
 * search, and toggle paths.
 */
import { test, expect, type Page } from "../gateway-harness.js";
import { apiFetch, deleteGoal, nonGitCwd, waitForHealth } from "../e2e-setup.js";
import { pollUntil } from "../test-utils/cleanup.js";
import { openApp } from "./ui-helpers.js";
import { filtersButton, clickShowArchivedToggle } from "./utils/sidebar-filters.js";
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
	await apiFetch(`/api/goals/${goal.id}`, { method: "DELETE" });
	return goal.id;
}

async function waitForArchivedGoalVisible(projectId: string, goalId: string, timeoutMs = 15_000): Promise<void> {
	await pollUntil(async () => {
		const resp = await apiFetch(`/api/goals?archived=true&projectId=${projectId}&limit=200`);
		if (!resp.ok) return false;
		const data = await resp.json();
		const goals: Array<{ id: string }> = data.goals || [];
		return goals.some(g => g.id === goalId);
	}, { timeoutMs, intervalMs: 50, label: `archived goal ${goalId} visible` });
}

function uniqueSuffix(label: string): string {
	const slug = label.replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 16);
	return `${slug}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function resetSidebarState(page: Page, opts: { showArchived?: boolean } = {}): Promise<void> {
	const showArchived = opts.showArchived ?? true;
	await openApp(page);
	await page.evaluate((show: boolean) => {
		localStorage.removeItem("bobbit-archived-collapsed-projects");
		localStorage.removeItem("bobbit-expanded-projects");
		localStorage.setItem("bobbit-show-archived", show ? "true" : "false");
	}, showArchived);
	await page.reload();
	await page.waitForSelector("button:has-text('Settings')", { timeout: 20_000 });
}

async function assertGoalBetweenProjectHeaders(page: Page, goalTitle: string, projectAPrefix: string, projectBPrefix: string): Promise<void> {
	const goalAIndex = await page.locator(`text=${goalTitle}`).first().evaluate((el) => {
		const all = Array.from(document.querySelectorAll(".sidebar-edge *"));
		return all.indexOf(el);
	});
	const projectAIndex = await page.locator(".sidebar-edge").getByText(projectAPrefix, { exact: false }).first().evaluate((el) => {
		const all = Array.from(document.querySelectorAll(".sidebar-edge *"));
		return all.indexOf(el);
	});
	const projectBIndex = await page.locator(".sidebar-edge").getByText(projectBPrefix, { exact: false }).first().evaluate((el) => {
		const all = Array.from(document.querySelectorAll(".sidebar-edge *"));
		return all.indexOf(el);
	});
	expect(goalAIndex).toBeGreaterThan(projectAIndex);
	expect(goalAIndex).toBeLessThan(projectBIndex);
}

test.describe("Per-project Archived subsections", () => {
	test("desktop archived subsections render per project, persist collapse, filter search, and toggle off", async ({ page }) => {
		test.setTimeout(75_000);
		await waitForHealth();
		const suffix = uniqueSuffix(test.info().title);
		const projectA = await registerProject(`proj-archived-a-${suffix}`);
		const projectB = await registerProject(`proj-archived-b-${suffix}`);
		const goalATitle = `ArchivedAlpha-${suffix}`;
		const goalBTitle = `ArchivedBravo-${suffix}`;
		const goalAId = await createArchivedGoal(projectA.id, goalATitle);
		const goalBId = await createArchivedGoal(projectB.id, goalBTitle);

		try {
			await resetSidebarState(page, { showArchived: true });

			await expect(page.locator(".sidebar-edge").getByText("proj-archived-a-", { exact: false }).first()).toBeVisible({ timeout: 15_000 });
			await expect(page.locator(".sidebar-edge").getByText("proj-archived-b-", { exact: false }).first()).toBeVisible({ timeout: 5_000 });

			const archivedHeaders = page.locator("span.uppercase").filter({ hasText: /^Archived$/ });
			await expect.poll(async () => archivedHeaders.count(), { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
			await expect(page.getByText(goalATitle, { exact: false }).first()).toBeVisible({ timeout: 10_000 });
			await expect(page.getByText(goalBTitle, { exact: false }).first()).toBeVisible({ timeout: 5_000 });
			await assertGoalBetweenProjectHeaders(page, goalATitle, "proj-archived-a-", "proj-archived-b-");

			// Collapse Project B's Archived subsection and verify persistence.
			await page.evaluate((title) => {
				const all = Array.from(document.querySelectorAll(".sidebar-edge *")) as HTMLElement[];
				const titleEl = all.find((el) => {
					if (!el.textContent?.includes(title)) return false;
					return !Array.from(el.children).some((c) => c.textContent?.includes(title));
				});
				if (!titleEl) throw new Error(`goalB title not found: ${title}`);
				const buttons = Array.from(document.querySelectorAll("button")) as HTMLButtonElement[];
				const archivedBefore = buttons.filter((btn) => {
					const span = btn.querySelector("span.uppercase");
					if (span?.textContent?.trim() !== "Archived") return false;
					const pos = btn.compareDocumentPosition(titleEl);
					return !!(pos & Node.DOCUMENT_POSITION_FOLLOWING);
				});
				if (archivedBefore.length === 0) throw new Error("no Archived header preceding goalB");
				archivedBefore[archivedBefore.length - 1].click();
			}, goalBTitle);
			await expect(page.getByText(goalBTitle, { exact: false })).toHaveCount(0, { timeout: 3_000 });
			await expect(page.getByText(goalATitle, { exact: false }).first()).toBeVisible({ timeout: 3_000 });
			const stored = await page.evaluate(() => localStorage.getItem("bobbit-archived-collapsed-projects"));
			expect(JSON.parse(stored!)).toContain(projectB.id);

			await page.reload();
			await expect(page.locator("button").filter({ hasText: "Settings" }).first()).toBeVisible({ timeout: 15_000 });
			await expect(page.getByText(goalATitle, { exact: false }).first()).toBeVisible({ timeout: 10_000 });
			await expect(page.getByText(goalBTitle, { exact: false })).toHaveCount(0, { timeout: 3_000 });

			// Search with Show Archived off exercises the auto-open archived fetch path.
			await waitForArchivedGoalVisible(projectA.id, goalAId);
			await waitForArchivedGoalVisible(projectB.id, goalBId);
			await resetSidebarState(page, { showArchived: false });
			const searchInput = page.locator("input[data-search]");
			await expect(searchInput).toBeVisible({ timeout: 15_000 });
			await searchInput.fill(goalATitle);
			await expect(page.getByText(goalATitle, { exact: false }).first()).toBeVisible({ timeout: 25_000 });
			const filteredArchivedHeaders = page.locator("button").filter({ has: page.locator("span.uppercase", { hasText: /^Archived$/ }) });
			await expect(filteredArchivedHeaders).toHaveCount(1, { timeout: 10_000 });
			await expect(page.getByText(goalBTitle, { exact: false })).toHaveCount(0, { timeout: 3_000 });
			await searchInput.fill("");

			// Toggle off hides all per-project Archived subsections.
			await resetSidebarState(page, { showArchived: true });
			await expect.poll(
				async () => page.locator("span.uppercase").filter({ hasText: /^Archived$/ }).count(),
				{ timeout: 10_000 },
			).toBeGreaterThanOrEqual(2);
			const seeArchived = filtersButton(page);
			await expect(seeArchived).toBeVisible({ timeout: 5_000 });
			await clickShowArchivedToggle(page);
			await expect(page.locator("span.uppercase").filter({ hasText: /^Archived$/ })).toHaveCount(0, { timeout: 5_000 });
			await expect(page.getByText(goalATitle, { exact: false })).toHaveCount(0, { timeout: 3_000 });
			await expect(page.getByText(goalBTitle, { exact: false })).toHaveCount(0, { timeout: 3_000 });
		} finally {
			await deleteGoal(goalAId).catch(() => {});
			await deleteGoal(goalBId).catch(() => {});
			await apiFetch(`/api/projects/${projectA.id}`, { method: "DELETE" }).catch(() => {});
			await apiFetch(`/api/projects/${projectB.id}`, { method: "DELETE" }).catch(() => {});
		}
	});
});
