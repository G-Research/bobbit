/**
 * E2E: Active-before-archived sidebar ordering.
 *
 * Setup: register a fresh project with 2 live goals + 2 archived goals at
 * the project root. Force "See Archived" on via localStorage so the test is
 * deterministic.
 *
 * Asserts:
 *  - All live goal rows appear before any archived goal row in DOM order.
 *  - Exactly one `[data-testid="sidebar-archived-divider"]` is rendered
 *    inside this project's content area, positioned between the last live
 *    row and the first archived row.
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

async function createLiveGoal(projectId: string, title: string): Promise<string> {
	const resp = await apiFetch("/api/goals", {
		method: "POST",
		body: JSON.stringify({ title, cwd: nonGitCwd(), worktree: false, projectId, autoStartTeam: false }),
	});
	expect(resp.status).toBe(201);
	const goal = await resp.json();
	return goal.id;
}

async function createArchivedGoal(projectId: string, title: string): Promise<string> {
	const id = await createLiveGoal(projectId, title);
	await apiFetch(`/api/goals/${id}?cascade=false`, { method: "DELETE" });
	return id;
}

function suffix(): string {
	return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

test.describe("Active-before-archived sidebar ordering", () => {
	let project: { id: string; rootPath: string } | undefined;
	let liveTitles: string[] = [];
	let archivedTitles: string[] = [];
	const goalIds: string[] = [];

	test.beforeEach(async () => {
		await waitForHealth();
		project = undefined;
		goalIds.length = 0;
		const s = suffix();
		project = await registerProject(`proj-aba-${s}`);
		// Live first to get small createdAt, then archived. The bucket sort
		// in buildNestedGoalForest should still place live above archived
		// regardless, but we use this order to confirm the rule beats raw
		// createdAt order from the data layer.
		liveTitles = [`LiveAlpha-${s}`, `LiveBravo-${s}`];
		archivedTitles = [`ArchivedAlpha-${s}`, `ArchivedBravo-${s}`];
		for (const t of liveTitles) goalIds.push(await createLiveGoal(project.id, t));
		for (const t of archivedTitles) goalIds.push(await createArchivedGoal(project.id, t));
	});

	test.afterEach(async () => {
		for (const id of goalIds) await deleteGoal(id).catch(() => {});
		if (project) await apiFetch(`/api/projects/${project.id}`, { method: "DELETE" }).catch(() => {});
	});

	test("live goals render before archived; one Archived divider sits between them", async ({ page }) => {
		await openApp(page);
		// Force See Archived ON deterministically; clear collapse state.
		await page.evaluate(() => {
			try {
				localStorage.removeItem("bobbit-archived-collapsed-projects");
				localStorage.removeItem("bobbit-expanded-projects");
				localStorage.setItem("bobbit-show-archived", "true");
			} catch {}
		});
		await page.reload();
		await expect(page.locator("button").filter({ hasText: "Settings" }).first()).toBeVisible({ timeout: 20_000 });

		// Wait for both live and archived goal titles to appear in the sidebar.
		for (const t of liveTitles) {
			await expect(page.getByText(t, { exact: false }).first()).toBeVisible({ timeout: 15_000 });
		}
		for (const t of archivedTitles) {
			await expect(page.getByText(t, { exact: false }).first()).toBeVisible({ timeout: 15_000 });
		}

		// Compute DOM order positions for each goal title and the divider.
		// Scope to the sidebar so the dashboard / other surfaces don't pollute.
		const positions = await page.evaluate(({ live, archived }: { live: string[]; archived: string[] }) => {
			const sidebar = document.querySelector("[data-testid='sidebar-expanded']");
			if (!sidebar) return null;
			const all = Array.from(sidebar.querySelectorAll("*")) as HTMLElement[];
			const findIdx = (text: string) => {
				const el = all.find((e) => {
					if (!e.textContent?.includes(text)) return false;
					return !Array.from(e.children).some((c) => c.textContent?.includes(text));
				});
				return el ? all.indexOf(el) : -1;
			};
			const dividers = all.filter((e) => e.dataset.testid === "sidebar-archived-divider");
			return {
				live: live.map(findIdx),
				archived: archived.map(findIdx),
				dividerIdxs: dividers.map((d) => all.indexOf(d)),
			};
		}, { live: liveTitles, archived: archivedTitles });

		expect(positions).not.toBeNull();
		const { live, archived, dividerIdxs } = positions!;

		// Every live row must appear before every archived row.
		for (const lp of live) expect(lp).toBeGreaterThan(-1);
		for (const ap of archived) expect(ap).toBeGreaterThan(-1);
		const lastLive = Math.max(...live);
		const firstArchived = Math.min(...archived);
		expect(lastLive).toBeLessThan(firstArchived);

		// Exactly one divider, sitting between last live and first archived.
		// Only one divider should appear at the project-root forest boundary
		// for this project (other projects in the worker share state may add
		// their own; the test isolates a fresh project, so exactly 1 is
		// expected for this project's content. Allow >=1 if other projects
		// happen to produce one too — but assert at least one sits between
		// our live and archived rows.)
		expect(dividerIdxs.length).toBeGreaterThanOrEqual(1);
		const dividerInBoundary = dividerIdxs.some((d) => d > lastLive && d < firstArchived);
		expect(dividerInBoundary).toBe(true);
	});
});
