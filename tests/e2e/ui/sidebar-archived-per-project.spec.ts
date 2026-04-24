/**
 * E2E tests for per-project Archived subsections in the sidebar.
 *
 * Each test gets its own fresh projects + archived goals and resets the
 * relevant localStorage keys before opening the app, so state never leaks
 * between tests or retries.
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
	await apiFetch(`/api/goals/${goal.id}`, { method: "DELETE" });
	return goal.id;
}

/**
 * Poll `/api/goals?archived=true&projectId=<id>` until the given goal id is
 * present in the response. Confirms the archive write is durable and visible
 * via REST before the UI search path tries to fetch+filter it. Without this,
 * typing into the search box can race: the client's lazy `fetchArchivedGoalsPaginated`
 * resolves after the 15s visibility timeout because a concurrent `refreshSessions`
 * overwrites `state.goals` with live-only goals mid-flight.
 */
async function waitForArchivedGoalVisible(projectId: string, goalId: string, timeoutMs = 15_000): Promise<void> {
	const start = Date.now();
	let lastStatus = 0;
	while (Date.now() - start < timeoutMs) {
		const resp = await apiFetch(`/api/goals?archived=true&projectId=${projectId}&limit=200`);
		lastStatus = resp.status;
		if (resp.ok) {
			const data = await resp.json();
			const goals: Array<{ id: string }> = data.goals || [];
			if (goals.some(g => g.id === goalId)) return;
		}
		await new Promise(r => setTimeout(r, 50));
	}
	throw new Error(`Archived goal ${goalId} not visible via REST within ${timeoutMs}ms (last status ${lastStatus})`);
}

function uniqueSuffix(label: string): string {
	// Per-test unique suffix: label + hi-res time + random. Avoids collisions
	// with sibling tests/workers and retries.
	const slug = label.replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 16);
	return `${slug}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** One-shot reset of sidebar-related localStorage keys before the app loads.
 *  Navigates to the app origin, clears the keys once, then returns. Unlike
 *  `addInitScript` this does not fire again on subsequent reloads — which is
 *  critical for tests that verify persistence across reload. */
async function resetSidebarState(page: import("@playwright/test").Page, opts: { showArchived?: boolean } = {}): Promise<void> {
	const showArchived = opts.showArchived ?? true;
	// Load a page from the app origin so localStorage can be accessed.
	await openApp(page);
	await page.evaluate((show: boolean) => {
		try {
			localStorage.removeItem("bobbit-archived-collapsed-projects");
			localStorage.removeItem("bobbit-expanded-projects");
			localStorage.setItem("bobbit-show-archived", show ? "true" : "false");
		} catch {}
	}, showArchived);
	await page.reload();
	await page.waitForSelector("button:has-text('Settings')", { timeout: 20_000 });
}

test.describe("Per-project Archived subsections", () => {
	// Per-test state — set in beforeEach, torn down in afterEach.
	// All per-test state is optional so a partially-failed beforeEach (e.g.
	// Windows playwright-transform-cache EPERM before projectA is assigned)
	// doesn't crash afterEach with `Cannot read properties of undefined`.
	let projectA: { id: string; rootPath: string } | undefined;
	let projectB: { id: string; rootPath: string } | undefined;
	let goalATitle: string;
	let goalBTitle: string;
	let goalAId: string | undefined;
	let goalBId: string | undefined;

	test.beforeEach(async () => {
		// Reset between tests so a previous failure doesn't leak ids.
		projectA = undefined;
		projectB = undefined;
		goalAId = undefined;
		goalBId = undefined;
		await waitForHealth();
		const suffix = uniqueSuffix(test.info().title);
		projectA = await registerProject(`proj-archived-a-${suffix}`);
		projectB = await registerProject(`proj-archived-b-${suffix}`);
		goalATitle = `ArchivedAlpha-${suffix}`;
		goalBTitle = `ArchivedBravo-${suffix}`;
		goalAId = await createArchivedGoal(projectA.id, goalATitle);
		goalBId = await createArchivedGoal(projectB.id, goalBTitle);
	});

	test.afterEach(async () => {
		if (goalAId) await deleteGoal(goalAId).catch(() => {});
		if (goalBId) await deleteGoal(goalBId).catch(() => {});
		if (projectA) await apiFetch(`/api/projects/${projectA.id}`, { method: "DELETE" }).catch(() => {});
		if (projectB) await apiFetch(`/api/projects/${projectB.id}`, { method: "DELETE" }).catch(() => {});
	});

	test("each project gets its own Archived subsection; no global block", async ({ page }) => {
		await resetSidebarState(page, { showArchived: true });

		// Wait for both project headers
		await expect(page.locator(".sidebar-edge").getByText(`proj-archived-a-`, { exact: false }).first()).toBeVisible({ timeout: 15_000 });
		await expect(page.locator(".sidebar-edge").getByText(`proj-archived-b-`, { exact: false }).first()).toBeVisible({ timeout: 5_000 });

		// Because we forced `bobbit-show-archived=true` via init-script, the
		// archived section should render without needing to click the button.
		const archivedHeaders = page.locator("span.uppercase").filter({ hasText: /^Archived$/ });
		await expect.poll(async () => archivedHeaders.count(), { timeout: 10_000 }).toBeGreaterThanOrEqual(2);

		await expect(page.getByText(goalATitle, { exact: false }).first()).toBeVisible({ timeout: 10_000 });
		await expect(page.getByText(goalBTitle, { exact: false }).first()).toBeVisible({ timeout: 5_000 });

		// Structural check: goal A precedes project B header in DOM order.
		const goalAIndex = await page.locator(`text=${goalATitle}`).first().evaluate((el) => {
			const all = Array.from(document.querySelectorAll(".sidebar-edge *"));
			return all.indexOf(el);
		});
		const projectAIndex = await page.locator(".sidebar-edge").getByText(`proj-archived-a-`, { exact: false }).first().evaluate((el) => {
			const all = Array.from(document.querySelectorAll(".sidebar-edge *"));
			return all.indexOf(el);
		});
		const projectBIndex = await page.locator(".sidebar-edge").getByText(`proj-archived-b-`, { exact: false }).first().evaluate((el) => {
			const all = Array.from(document.querySelectorAll(".sidebar-edge *"));
			return all.indexOf(el);
		});
		expect(goalAIndex).toBeGreaterThan(projectAIndex);
		expect(goalAIndex).toBeLessThan(projectBIndex);
	});

	test("per-project collapse state persists across reload", async ({ page }) => {
		await resetSidebarState(page, { showArchived: true });

		// Wait for the per-project Archived headers.
		const archivedButtons = page.locator("button").filter({ has: page.locator("span.uppercase", { hasText: /^Archived$/ }) });
		await expect.poll(async () => archivedButtons.count(), { timeout: 10_000 }).toBeGreaterThanOrEqual(2);

		await expect(page.getByText(goalATitle, { exact: false }).first()).toBeVisible({ timeout: 5_000 });
		await expect(page.getByText(goalBTitle, { exact: false }).first()).toBeVisible({ timeout: 5_000 });

		// Collapse the Archived subsection containing goal B. Find it by DOM
		// proximity so extra Archived subsections (from sibling tests sharing
		// the worker) don't shift indices.
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
		expect(stored).toBeTruthy();
		const ids = JSON.parse(stored!);
		expect(ids).toContain(projectB.id);

		await page.reload();
		await expect(page.locator("button").filter({ hasText: "Settings" }).first()).toBeVisible({ timeout: 15_000 });

		await expect(page.getByText(goalATitle, { exact: false }).first()).toBeVisible({ timeout: 10_000 });
		await expect(page.getByText(goalBTitle, { exact: false })).toHaveCount(0, { timeout: 3_000 });
	});

	test("search surfaces archived items in the correct project subsection", async ({ page }) => {
		// Event-driven readiness: confirm BOTH archived goals are persisted and
		// returned by the server BEFORE the UI is even loaded. This closes the
		// race where the client's lazy archived-goals fetch (kicked off by the
		// search handler) resolves after the visibility timeout because a
		// concurrent refreshSessions overwrites state.goals with live-only goals.
		await waitForArchivedGoalVisible(projectA!.id, goalAId!);
		await waitForArchivedGoalVisible(projectB!.id, goalBId!);

		// Start with See Archived OFF so the search auto-open path runs.
		await resetSidebarState(page, { showArchived: false });

		const searchInput = page.locator("input[data-search]");
		await expect(searchInput).toBeVisible({ timeout: 15_000 });
		await searchInput.click();
		await searchInput.fill(goalATitle);
		await page.waitForTimeout(500);

		// Only project A's archived subsection should match (unique suffix guarantees this).
		await expect(page.getByText(goalATitle, { exact: false }).first()).toBeVisible({ timeout: 15_000 });
		const archivedButtons = page.locator("button").filter({ has: page.locator("span.uppercase", { hasText: /^Archived$/ }) });
		await expect(archivedButtons).toHaveCount(1, { timeout: 10_000 });
		await expect(page.getByText(goalBTitle, { exact: false })).toHaveCount(0, { timeout: 3_000 });

		// Clear search for good hygiene.
		await searchInput.fill("");
		await page.waitForTimeout(300);
	});

	test("toggling See Archived off hides all per-project Archived subsections", async ({ page }) => {
		// Force See Archived ON deterministically via localStorage.
		await resetSidebarState(page, { showArchived: true });

		// Subsections must be present before we toggle off.
		await expect.poll(
			async () => page.locator("span.uppercase").filter({ hasText: /^Archived$/ }).count(),
			{ timeout: 10_000 },
		).toBeGreaterThanOrEqual(2);

		const seeArchived = page.locator("button").filter({ hasText: "See Archived" }).first();
		await expect(seeArchived).toBeVisible({ timeout: 5_000 });
		await seeArchived.click();

		await expect(page.locator("span.uppercase").filter({ hasText: /^Archived$/ })).toHaveCount(0, { timeout: 5_000 });
		await expect(page.getByText(goalATitle, { exact: false })).toHaveCount(0, { timeout: 3_000 });
		await expect(page.getByText(goalBTitle, { exact: false })).toHaveCount(0, { timeout: 3_000 });
	});
});
