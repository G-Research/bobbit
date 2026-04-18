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

		// Each project gets its own nested Archived subsection header (no single
		// global block). Prior revisions asserted toHaveCount(2), but in a shared
		// worker the default project or sibling specs may also have archived
		// items, producing a 3rd subsection. Instead assert >= 2 (both of ours
		// present) plus absence of a global archived block below all projects.
		const archivedHeaders = page.locator("span.uppercase").filter({ hasText: /^Archived$/ });
		await expect.poll(async () => archivedHeaders.count(), { timeout: 10_000 }).toBeGreaterThanOrEqual(2);

		// Per-project Archived subsections default to expanded — each archived goal
		// title should appear immediately under its project without needing an extra click.
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

	test("per-project collapse state persists across reload", async ({ page }) => {
		await openApp(page);

		// Turn See Archived on if not already
		const seeArchived = page.locator("button").filter({ hasText: "See Archived" }).first();
		await expect(seeArchived).toBeVisible({ timeout: 10_000 });
		const isOn = await seeArchived.evaluate((el) => el.className.includes("text-primary"));
		if (!isOn) await seeArchived.click();

		// Wait for per-project Archived headers (default expanded). Sibling
		// specs sharing this worker may have added archived items to the default
		// project, producing an extra subsection, so assert >= 2 rather than ==.
		const archivedButtons = page.locator("button").filter({ has: page.locator("span.uppercase", { hasText: /^Archived$/ }) });
		await expect.poll(async () => archivedButtons.count(), { timeout: 10_000 }).toBeGreaterThanOrEqual(2);

		// Both archived goals should be visible initially (default expanded)
		await expect(page.getByText(goalATitle, { exact: false }).first()).toBeVisible({ timeout: 5_000 });
		await expect(page.getByText(goalBTitle, { exact: false }).first()).toBeVisible({ timeout: 5_000 });

		// Collapse the Archived subsection that contains goal B. Find it by
		// DOM proximity rather than by nth-index, so an extra Archived
		// subsection from the default project (which sibling specs on the
		// same worker may have populated) doesn't shift the index and make
		// us click the wrong project's toggle.
		await page.evaluate((title) => {
			// Find the deepest element whose own text content matches the title.
			const all = Array.from(document.querySelectorAll(".sidebar-edge *")) as HTMLElement[];
			const titleEl = all.find((el) => {
				if (!el.textContent?.includes(title)) return false;
				return !Array.from(el.children).some((c) => c.textContent?.includes(title));
			});
			if (!titleEl) throw new Error(`goalB title not found: ${title}`);
			// Scan all Archived header buttons; pick the last one that precedes
			// titleEl in document order.
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

		// Goal B should disappear (project B collapsed); Goal A still visible
		await expect(page.getByText(goalBTitle, { exact: false })).toHaveCount(0, { timeout: 3_000 });
		await expect(page.getByText(goalATitle, { exact: false }).first()).toBeVisible({ timeout: 3_000 });

		// localStorage should record project B as collapsed
		const stored = await page.evaluate(() => localStorage.getItem("bobbit-archived-collapsed-projects"));
		expect(stored).toBeTruthy();
		const ids = JSON.parse(stored!);
		expect(ids).toContain(projectB.id);

		// Reload — collapse state should persist
		await page.reload();
		await expect(page.locator("button").filter({ hasText: "Settings" }).first()).toBeVisible({ timeout: 15_000 });

		// Goal A visible, Goal B still collapsed
		await expect(page.getByText(goalATitle, { exact: false }).first()).toBeVisible({ timeout: 10_000 });
		await expect(page.getByText(goalBTitle, { exact: false })).toHaveCount(0, { timeout: 3_000 });
	});

	test("search surfaces archived items in the correct project subsection", async ({ page }) => {
		await openApp(page);

		// Ensure clean state: clear the per-project archived collapse pref
		await page.evaluate(() => localStorage.removeItem("bobbit-archived-collapsed-projects"));
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

		// Auto-open flips showArchived on; per-project subsections default expanded
		// so the matching item appears without extra clicks. Only projects whose
		// archived goals match the search should render an Archived subsection
		// — project A matches, project B does not. The default project may also
		// contain archived items from sibling specs, but none of them match a
		// unique timestamped search string, so it will also be hidden.
		//
		// The search auto-open triggers an async fetch of archived goals; under
		// parallel load that fetch can take noticeably longer than the default
		// 5s Playwright assertion timeout, so poll for goalA visible first and
		// then assert the subsection count.
		await expect(page.getByText(goalATitle, { exact: false }).first()).toBeVisible({ timeout: 15_000 });
		const archivedButtons = page.locator("button").filter({ has: page.locator("span.uppercase", { hasText: /^Archived$/ }) });
		await expect(archivedButtons).toHaveCount(1, { timeout: 10_000 });
		await expect(page.getByText(goalBTitle, { exact: false })).toHaveCount(0, { timeout: 3_000 });

		// Clear search
		await searchInput.fill("");
		await page.waitForTimeout(400);
	});

	test("toggling See Archived off hides all per-project Archived subsections", async ({ page }) => {
		await openApp(page);
		// Reset sidebar state so prior tests in this file (especially a failed
		// search test that leaves showArchived auto-flipped on) don't bleed in.
		await page.evaluate(() => {
			localStorage.removeItem("bobbit-show-archived");
			localStorage.removeItem("bobbit-archived-collapsed-projects");
		});
		await page.reload();
		await expect(page.locator("button").filter({ hasText: "Settings" }).first()).toBeVisible({ timeout: 15_000 });

		const seeArchived = page.locator("button").filter({ hasText: "See Archived" }).first();
		const isOn = await seeArchived.evaluate((el) => el.className.includes("text-primary"));
		if (!isOn) {
			await seeArchived.click();
			// verify subsections appear (>= 2 — sibling specs may add a 3rd on
			// the default project when sharing a worker).
			await expect.poll(
				async () => page.locator("span.uppercase").filter({ hasText: /^Archived$/ }).count(),
				{ timeout: 10_000 },
			).toBeGreaterThanOrEqual(2);
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
