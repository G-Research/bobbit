/**
 * E2E tests for per-project Archived subsections in the MOBILE sidebar.
 *
 * Mirrors `tests/e2e/ui/sidebar-archived-per-project.spec.ts` (desktop)
 * but runs at viewport 375x667 where `renderMobileLanding()` is used.
 *
 * These tests FAIL on master because `renderMobileLanding` currently renders
 * archived items as a single flat global block with two dividers, rather
 * than per-project subsections matching desktop. The implementation task
 * must extract desktop's bucketing logic into a shared helper in
 * `src/app/render-helpers.ts` and reuse it on both views so that:
 *   - One Archived subsection renders per project that has archived items.
 *   - Collapse state persists via the shared `bobbit-archived-collapsed-projects`
 *     localStorage key.
 *   - No global (non-per-project) Archived block renders.
 *   - The global "See Archived" toggle still hides all subsections at once.
 *   - Search filtering applies within each per-project subsection.
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch, deleteGoal, nonGitCwd, waitForHealth } from "../e2e-setup.js";
import { openApp } from "./ui-helpers.js";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const MOBILE = { width: 375, height: 667 };

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

function uniqueSuffix(label: string): string {
	const slug = label.replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 16);
	return `${slug}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Open app, reset localStorage keys, resize to mobile, reload. */
async function openMobileApp(
	page: import("@playwright/test").Page,
	opts: { showArchived?: boolean } = {},
): Promise<void> {
	const showArchived = opts.showArchived ?? true;
	await openApp(page);
	await page.evaluate((show: boolean) => {
		try {
			localStorage.removeItem("bobbit-archived-collapsed-projects");
			localStorage.removeItem("bobbit-expanded-projects");
			localStorage.setItem("bobbit-show-archived", show ? "true" : "false");
		} catch {}
	}, showArchived);
	await page.setViewportSize(MOBILE);
	await page.reload();
	// Mobile landing renders a <search-box>; wait for it.
	await page.waitForSelector("input[data-search]", { timeout: 20_000 });
}

test.describe("Per-project Archived subsections (mobile)", () => {
	let projectA: { id: string; rootPath: string };
	let projectB: { id: string; rootPath: string };
	let goalATitle: string;
	let goalBTitle: string;
	let goalAId: string;
	let goalBId: string;

	test.beforeEach(async () => {
		await waitForHealth();
		const suffix = uniqueSuffix(test.info().title);
		projectA = await registerProject(`proj-m-arch-a-${suffix}`);
		projectB = await registerProject(`proj-m-arch-b-${suffix}`);
		goalATitle = `MobileArchivedAlpha-${suffix}`;
		goalBTitle = `MobileArchivedBravo-${suffix}`;
		goalAId = await createArchivedGoal(projectA.id, goalATitle);
		goalBId = await createArchivedGoal(projectB.id, goalBTitle);
	});

	test.afterEach(async () => {
		await deleteGoal(goalAId).catch(() => {});
		await deleteGoal(goalBId).catch(() => {});
		await apiFetch(`/api/projects/${projectA.id}`, { method: "DELETE" }).catch(() => {});
		await apiFetch(`/api/projects/${projectB.id}`, { method: "DELETE" }).catch(() => {});
	});

	test("each project gets its own Archived subsection; no global block on mobile", async ({ page }) => {
		await openMobileApp(page, { showArchived: true });

		// Both archived goals should be visible.
		await expect(page.getByText(goalATitle, { exact: false }).first()).toBeVisible({ timeout: 15_000 });
		await expect(page.getByText(goalBTitle, { exact: false }).first()).toBeVisible({ timeout: 10_000 });

		// There must be at least one Archived header per project (>=2).
		const archivedHeaders = page.locator("span.uppercase").filter({ hasText: /^Archived$/ });
		await expect
			.poll(async () => archivedHeaders.count(), { timeout: 10_000 })
			.toBeGreaterThanOrEqual(2);

		// Structural: goalA's title must sit between project A's header and
		// project B's header in DOM order — i.e. it lives inside project A's
		// per-project Archived subsection, not in a trailing global block.
		const goalAIndex = await page.getByText(goalATitle, { exact: false }).first().evaluate((el) => {
			const all = Array.from(document.querySelectorAll("*"));
			return all.indexOf(el);
		});
		const projectAIndex = await page.getByText(`proj-m-arch-a-`, { exact: false }).first().evaluate((el) => {
			const all = Array.from(document.querySelectorAll("*"));
			return all.indexOf(el);
		});
		const projectBIndex = await page.getByText(`proj-m-arch-b-`, { exact: false }).first().evaluate((el) => {
			const all = Array.from(document.querySelectorAll("*"));
			return all.indexOf(el);
		});
		expect(
			goalAIndex,
			`Expected goal "${goalATitle}" to render inside project A's per-project Archived subsection (between project A and project B headers). On master, renderMobileLanding renders a flat global Archived block so goalA appears AFTER both project headers.`,
		).toBeGreaterThan(projectAIndex);
		expect(
			goalAIndex,
			`Expected goal "${goalATitle}" to render inside project A's per-project Archived subsection (before project B header). On master, the flat global Archived block places goalA after project B.`,
		).toBeLessThan(projectBIndex);
	});

	test("per-project collapse state persists across reload and uses shared localStorage key", async ({ page }) => {
		await openMobileApp(page, { showArchived: true });

		const archivedButtons = page.locator("button").filter({ has: page.locator("span.uppercase", { hasText: /^Archived$/ }) });
		await expect
			.poll(async () => archivedButtons.count(), { timeout: 10_000 })
			.toBeGreaterThanOrEqual(2);

		await expect(page.getByText(goalATitle, { exact: false }).first()).toBeVisible({ timeout: 10_000 });
		await expect(page.getByText(goalBTitle, { exact: false }).first()).toBeVisible({ timeout: 5_000 });

		// Collapse the Archived subsection containing goal B.
		await page.evaluate((title) => {
			const all = Array.from(document.querySelectorAll("*")) as HTMLElement[];
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
			if (archivedBefore.length === 0) {
				throw new Error(
					"no collapsible Archived header precedes goalB — mobile is still rendering a flat global archived block without per-project collapsible subsections",
				);
			}
			archivedBefore[archivedBefore.length - 1].click();
		}, goalBTitle);

		await expect(page.getByText(goalBTitle, { exact: false })).toHaveCount(0, { timeout: 3_000 });
		await expect(page.getByText(goalATitle, { exact: false }).first()).toBeVisible({ timeout: 3_000 });

		const stored = await page.evaluate(() => localStorage.getItem("bobbit-archived-collapsed-projects"));
		expect(
			stored,
			"Expected mobile to persist per-project collapse state in localStorage under the shared key `bobbit-archived-collapsed-projects` (same key as desktop).",
		).toBeTruthy();
		const ids = JSON.parse(stored!);
		expect(ids).toContain(projectB.id);

		await page.reload();
		await page.waitForSelector("input[data-search]", { timeout: 20_000 });

		await expect(page.getByText(goalATitle, { exact: false }).first()).toBeVisible({ timeout: 10_000 });
		await expect(page.getByText(goalBTitle, { exact: false })).toHaveCount(0, { timeout: 5_000 });
	});

	test("search surfaces archived items in the correct project subsection on mobile", async ({ page }) => {
		await openMobileApp(page, { showArchived: true });

		await expect(page.getByText(goalATitle, { exact: false }).first()).toBeVisible({ timeout: 15_000 });
		await expect(page.getByText(goalBTitle, { exact: false }).first()).toBeVisible({ timeout: 10_000 });

		const searchInput = page.locator("input[data-search]");
		await expect(searchInput).toBeVisible({ timeout: 5_000 });
		await searchInput.click();
		await searchInput.fill(goalATitle);
		await page.waitForTimeout(500);

		// Only project A's archived subsection should render when searching for
		// goal A's unique title.
		await expect(page.getByText(goalATitle, { exact: false }).first()).toBeVisible({ timeout: 10_000 });
		await expect(page.getByText(goalBTitle, { exact: false })).toHaveCount(0, { timeout: 5_000 });

		const archivedHeaders = page.locator("span.uppercase").filter({ hasText: /^Archived$/ });
		const headerCount = await archivedHeaders.count();
		expect(
			headerCount,
			`Expected exactly one per-project Archived subsection to render after searching for goal A (project A's). Got ${headerCount} Archived headers — either mobile is rendering a global flat Archived block or it renders empty per-project subsections for projects with no matching items.`,
		).toBe(1);

		// Structural: the archived goal A title must share a scoped ancestor
		// with project A's name — i.e. it lives inside project A's per-project
		// container. On master, archived items render in a flat global block
		// that is a sibling of all project containers, so the closest shared
		// ancestor is the whole sidebar/body.
		const archivedGoalNestedInProjectA = await page.evaluate(
			({ goalTitle, projectPrefix }) => {
				const all = Array.from(document.querySelectorAll("*")) as HTMLElement[];
				const goalEl = all.find((el) => {
					if (!el.textContent?.includes(goalTitle)) return false;
					return !Array.from(el.children).some((c) => c.textContent?.includes(goalTitle));
				});
				if (!goalEl) return { ok: false, reason: "goal title element not found" };
				const bodyLen = document.body.textContent?.length ?? 0;
				let node: HTMLElement | null = goalEl.parentElement;
				while (node && node.tagName !== "BODY") {
					const txt = node.textContent ?? "";
					if (txt.includes(projectPrefix) && txt.length < bodyLen * 0.9) {
						return { ok: true };
					}
					node = node.parentElement;
				}
				return { ok: false, reason: "no scoped ancestor shared with project A" };
			},
			{ goalTitle: goalATitle, projectPrefix: "proj-m-arch-a-" },
		);
		expect(
			archivedGoalNestedInProjectA.ok,
			`Expected archived goal "${goalATitle}" to render inside project A's per-project container (share a scoped ancestor with 'proj-m-arch-a-'). Got: ${archivedGoalNestedInProjectA.reason ?? ""}. On master, renderMobileLanding renders a flat global archived block, so the goal and the project name share only the sidebar root — not a per-project container.`,
		).toBe(true);

		await searchInput.fill("");
		await page.waitForTimeout(300);
	});

	test("toggling See Archived off hides all per-project Archived subsections on mobile", async ({ page }) => {
		await openMobileApp(page, { showArchived: true });

		await expect
			.poll(
				async () =>
					page.locator("span.uppercase").filter({ hasText: /^Archived$/ }).count(),
				{ timeout: 10_000 },
			)
			.toBeGreaterThanOrEqual(2);

		const seeArchived = page.locator("button").filter({ hasText: "See Archived" }).first();
		await expect(seeArchived).toBeVisible({ timeout: 5_000 });
		await seeArchived.click();

		await expect(page.locator("span.uppercase").filter({ hasText: /^Archived$/ })).toHaveCount(
			0,
			{ timeout: 5_000 },
		);
		await expect(page.getByText(goalATitle, { exact: false })).toHaveCount(0, { timeout: 3_000 });
		await expect(page.getByText(goalBTitle, { exact: false })).toHaveCount(0, { timeout: 3_000 });
	});
});
