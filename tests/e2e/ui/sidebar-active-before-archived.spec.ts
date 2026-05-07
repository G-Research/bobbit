/**
 * E2E: Active-before-archived sidebar ordering.
 *
 * Setup: register a fresh project with one live PARENT goal that has two
 * live children + two archived children. Top-level archived goals are
 * routed to the bottom "Archived" collapsible (unchanged by this goal); the
 * divider applies WITHIN a group that mixes active + archived. Nested
 * children of a live parent are exactly that group.
 *
 * Force "See Archived" on via localStorage so the test is deterministic.
 *
 * Asserts:
 *  - All live child rows appear before any archived child row under the
 *    parent in DOM order.
 *  - At least one `[data-testid="sidebar-archived-divider"]` sits between
 *    the last live child row and the first archived child row.
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

async function createLiveChild(parentId: string, title: string, planId: string): Promise<string> {
	// Children are created via POST /api/goals/:id/spawn-child — the
	// top-level POST /api/goals endpoint doesn't honour parentGoalId.
	const resp = await apiFetch(`/api/goals/${parentId}/spawn-child`, {
		method: "POST",
		body: JSON.stringify({ planId, title, spec: "placeholder", autoStartTeam: false }),
	});
	expect(resp.status).toBe(201);
	const data = await resp.json();
	return data.id;
}

async function createArchivedChild(parentId: string, title: string, planId: string): Promise<string> {
	const id = await createLiveChild(parentId, title, planId);
	await apiFetch(`/api/goals/${id}?cascade=false`, { method: "DELETE" });
	return id;
}

test.describe("Active-before-archived sidebar ordering", () => {
	let project: { id: string; rootPath: string } | undefined;
	let parentTitle = "";
	let liveTitles: string[] = [];
	let archivedTitles: string[] = [];
	const goalIds: string[] = [];

	test.beforeEach(async () => {
		await waitForHealth();
		project = undefined;
		goalIds.length = 0;
		const s = suffix();
		project = await registerProject(`proj-aba-${s}`);
		// Enable subgoals (Experimental) so the nested forest renders.
		await apiFetch("/api/preferences", {
			method: "PUT",
			body: JSON.stringify({ subgoalsEnabled: true }),
		}).catch(() => {});
		parentTitle = `Parent-${s}`;
		const parentId = await createLiveGoal(project.id, parentTitle);
		goalIds.push(parentId);
		// Live children first (smaller createdAt), then archived. The bucket
		// sort in buildNestedGoalForest must still place live above archived
		// regardless of createdAt — the divider sits at the boundary.
		liveTitles = [`LiveChildAlpha-${s}`, `LiveChildBravo-${s}`];
		archivedTitles = [`ArchivedChildAlpha-${s}`, `ArchivedChildBravo-${s}`];
		let pi = 0;
		for (const t of liveTitles) goalIds.push(await createLiveChild(parentId, t, `plan-${s}-${pi++}`));
		for (const t of archivedTitles) goalIds.push(await createArchivedChild(parentId, t, `plan-${s}-${pi++}`));
	});

	test.afterEach(async () => {
		for (const id of goalIds) await deleteGoal(id).catch(() => {});
		if (project) await apiFetch(`/api/projects/${project.id}`, { method: "DELETE" }).catch(() => {});
	});

	test("live children render before archived; Archived divider sits between them", async ({ page }) => {
		await openApp(page);
		// Clear collapse state. Archived load is triggered via the toggle
		// click below — setting `bobbit-show-archived` directly only flips the
		// initial flag and does NOT fire `fetchArchivedGoalsPaginated`, so
		// archived child goals never enter `state.goals`. The toggle click
		// fires the fetch.
		await page.evaluate(() => {
			try {
				localStorage.removeItem("bobbit-archived-collapsed-projects");
				localStorage.removeItem("bobbit-expanded-projects");
				localStorage.setItem("bobbit-show-archived", "false");
			} catch {}
		});
		await page.reload();
		await expect(page.locator("button").filter({ hasText: "Settings" }).first()).toBeVisible({ timeout: 20_000 });

		// Click the See Archived toggle so archived goals are fetched into
		// state.goals and folded into the live forest.
		await page.locator("button").filter({ hasText: "See Archived" }).first().click();
		await page.waitForTimeout(500);

		// Expand the parent goal so its children render.
		const parentRow = page.getByText(parentTitle, { exact: false }).first();
		await expect(parentRow).toBeVisible({ timeout: 15_000 });
		await parentRow.click();

		// Wait for both live and archived child titles to appear in the sidebar.
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
