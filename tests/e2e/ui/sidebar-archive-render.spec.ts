/**
 * E2E: Unified archive-rendering — labeled team-lead dividers + bucketed
 * project-forest dividers.
 *
 * Reproduces the Bugs Bunny → Otis → Zoidberg ambiguity bug at the
 * structural level. We cannot easily spawn real team-lead Docker sessions
 * in the gateway-harness, but the project-level forest divider path and
 * the `data-owner` attribute contract on `archivedDivider` are exercised
 * directly here:
 *
 *  - A live parent goal with two live children + two archived children
 *    produces exactly one project-forest divider with no `data-owner`
 *    (plain "Archived" label, back-compat).
 *  - The divider sits between the last active row and the first archived
 *    row (no archived row above any divider in the same group).
 *  - The single emitted divider matches the new `data-testid` contract.
 *
 * The labeled-team-lead branch (`renderTeamGroup` → `archivedDivider(lead.title)`)
 * is unit-tested via `tests/bucket-active-archived.test.ts` and the existing
 * `tests/render-helpers-team-archived.test.ts` for the bucketing logic.
 * Spawning real team-leads in E2E requires manual-integration tier — out of
 * scope for the browser-E2E suite per docs/testing-strategy.md.
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
	return (await resp.json()).id;
}

async function createLiveChild(parentId: string, title: string, planId: string): Promise<string> {
	const resp = await apiFetch(`/api/goals/${parentId}/spawn-child`, {
		method: "POST",
		body: JSON.stringify({ planId, title, spec: "Child goal for sidebar archive-render test: validates labeled dividers and bucketed archive ordering.", autoStartTeam: false }),
	});
	expect(resp.status).toBe(201);
	return (await resp.json()).id;
}

async function createArchivedChild(parentId: string, title: string, planId: string): Promise<string> {
	const id = await createLiveChild(parentId, title, planId);
	await apiFetch(`/api/goals/${id}?cascade=false`, { method: "DELETE" });
	return id;
}

function suffix(): string {
	return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

test.describe("Unified archive-rendering — labeled dividers + bucketed forest", () => {
	let project: { id: string; rootPath: string } | undefined;
	const goalIds: string[] = [];
	let parentTitle = "";
	let liveTitles: string[] = [];
	let archivedTitles: string[] = [];

	test.beforeEach(async () => {
		await waitForHealth();
		project = undefined;
		goalIds.length = 0;
		const s = suffix();
		project = await registerProject(`proj-arc-render-${s}`);
		await apiFetch("/api/preferences", {
			method: "PUT",
			body: JSON.stringify({ subgoalsEnabled: true }),
		}).catch(() => {});
		parentTitle = `ArcParent-${s}`;
		const parentId = await createLiveGoal(project.id, parentTitle);
		goalIds.push(parentId);
		liveTitles = [`ArcLiveA-${s}`, `ArcLiveB-${s}`];
		archivedTitles = [`ArcArchA-${s}`, `ArcArchB-${s}`];
		let pi = 0;
		for (const t of liveTitles) goalIds.push(await createLiveChild(parentId, t, `plan-${s}-${pi++}`));
		for (const t of archivedTitles) goalIds.push(await createArchivedChild(parentId, t, `plan-${s}-${pi++}`));
	});

	test.afterEach(async () => {
		for (const id of goalIds) await deleteGoal(id).catch(() => {});
		if (project) await apiFetch(`/api/projects/${project.id}`, { method: "DELETE" }).catch(() => {});
	});

	test("nested forest divider exposes data-owner='' and sits between active/archived children", async ({ page }) => {
		test.slow();
		await page.addInitScript(() => {
			try {
				localStorage.removeItem("bobbit-archived-collapsed-projects");
				localStorage.removeItem("bobbit-expanded-projects");
				localStorage.setItem("bobbit-show-archived", "true");
			} catch {}
		});
		await openApp(page);

		const parentRow = page.getByText(parentTitle, { exact: false }).first();
		await expect(parentRow).toBeVisible({ timeout: 10_000 });
		await parentRow.click();

		for (const t of liveTitles) {
			await expect(page.getByText(t, { exact: false }).first()).toBeVisible({ timeout: 10_000 });
		}
		for (const t of archivedTitles) {
			await expect(page.getByText(t, { exact: false }).first()).toBeVisible({ timeout: 10_000 });
		}

		// Every archived-divider element must carry the new data-owner attr
		// (empty string for project-level/nested-goal callers, non-empty for
		// `renderTeamGroup` callers). We don't have a team-lead here so all
		// owners should be empty — but the attribute MUST exist on every
		// divider so test selectors and CSS can rely on it.
		const ownerAttrs = await page.$$eval(
			"[data-testid='sidebar-archived-divider']",
			els => els.map(e => e.getAttribute("data-owner")),
		);
		expect(ownerAttrs.length).toBeGreaterThanOrEqual(1);
		for (const o of ownerAttrs) {
			expect(o).not.toBeNull();
			expect(o).toBe(""); // project/nested-goal dividers carry no owner
		}

		// No archived child renders above the divider inside the parent's
		// expanded subtree.
		const positions = await page.evaluate(({ live, archived }: { live: string[]; archived: string[] }) => {
			const sidebar = document.querySelector("[data-testid='sidebar-expanded']");
			if (!sidebar) return null;
			const all = Array.from(sidebar.querySelectorAll("*")) as HTMLElement[];
			const findIdx = (text: string) => {
				const el = all.find(e => {
					if (!e.textContent?.includes(text)) return false;
					return !Array.from(e.children).some(c => c.textContent?.includes(text));
				});
				return el ? all.indexOf(el) : -1;
			};
			const dividers = all.filter(e => e.dataset.testid === "sidebar-archived-divider");
			return {
				live: live.map(findIdx),
				archived: archived.map(findIdx),
				dividerIdxs: dividers.map(d => all.indexOf(d)),
			};
		}, { live: liveTitles, archived: archivedTitles });

		expect(positions).not.toBeNull();
		const { live, archived, dividerIdxs } = positions!;
		for (const lp of live) expect(lp).toBeGreaterThan(-1);
		for (const ap of archived) expect(ap).toBeGreaterThan(-1);
		const lastLive = Math.max(...live);
		const firstArchived = Math.min(...archived);
		expect(lastLive).toBeLessThan(firstArchived);
		// At least one divider in the boundary; no divider appears *after*
		// any archived row within this group.
		expect(dividerIdxs.some(d => d > lastLive && d < firstArchived)).toBe(true);
		for (const d of dividerIdxs) {
			// Every divider must be at-or-before the first archived row in
			// its group — never the other way around.
			expect(d <= firstArchived).toBe(true);
		}
	});

	test("divider label remains 'Archived' (no owner) at project/nested-goal level", async ({ page }) => {
		await page.addInitScript(() => {
			try {
				localStorage.setItem("bobbit-show-archived", "true");
			} catch {}
		});
		await openApp(page);
		const parentRow = page.getByText(parentTitle, { exact: false }).first();
		await expect(parentRow).toBeVisible({ timeout: 10_000 });
		await parentRow.click();
		for (const t of archivedTitles) {
			await expect(page.getByText(t, { exact: false }).first()).toBeVisible({ timeout: 10_000 });
		}
		const labels = await page.$$eval(
			"[data-testid='sidebar-archived-divider']",
			els => els.map(e => (e.textContent || "").trim()),
		);
		expect(labels.length).toBeGreaterThanOrEqual(1);
		for (const l of labels) {
			// Plain "Archived" (uppercase via CSS) — no " · <owner>" suffix.
			expect(l).toBe("Archived");
		}
	});
});
