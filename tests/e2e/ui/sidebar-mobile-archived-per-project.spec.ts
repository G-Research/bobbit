/**
 * E2E tests for per-project Archived subsections in the MOBILE sidebar.
 *
 * Consolidated into one browser flow that preserves the real responsive render,
 * collapse persistence, search filtering, and global toggle behavior while
 * sharing the expensive two-project archive setup.
 */
import { test, expect, type Page } from "../gateway-harness.js";
import { apiFetch, deleteGoal, nonGitCwd, waitForHealth } from "../e2e-setup.js";
import { openApp } from "./ui-helpers.js";
import { filtersButton, clickShowArchivedToggle } from "./utils/sidebar-filters.js";
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

async function openMobileApp(page: Page, opts: { showArchived?: boolean } = {}): Promise<void> {
	const showArchived = opts.showArchived ?? true;
	await openApp(page);
	await page.evaluate((show: boolean) => {
		localStorage.removeItem("bobbit-archived-collapsed-projects");
		localStorage.removeItem("bobbit-expanded-projects");
		localStorage.setItem("bobbit-show-archived", show ? "true" : "false");
	}, showArchived);
	await page.setViewportSize(MOBILE);
	await page.reload();
	await page.waitForSelector("input[data-search]", { timeout: 20_000 });
}

async function goalIndex(page: Page, title: string): Promise<number> {
	return page.getByText(title, { exact: false }).first().evaluate((el) => {
		const all = Array.from(document.querySelectorAll("*"));
		return all.indexOf(el);
	});
}

async function projectIndex(page: Page, prefix: string): Promise<number> {
	return page.getByText(prefix, { exact: false }).first().evaluate((el) => {
		const all = Array.from(document.querySelectorAll("*"));
		return all.indexOf(el);
	});
}

test.describe("Per-project Archived subsections (mobile)", () => {
	test("mobile archived subsections render per project, persist collapse, filter search, and toggle off", async ({ page }) => {
		test.setTimeout(75_000);
		await waitForHealth();
		const suffix = uniqueSuffix(test.info().title);
		const projectA = await registerProject(`proj-m-arch-a-${suffix}`);
		const projectB = await registerProject(`proj-m-arch-b-${suffix}`);
		const goalATitle = `MobileArchivedAlpha-${suffix}`;
		const goalBTitle = `MobileArchivedBravo-${suffix}`;
		const goalAId = await createArchivedGoal(projectA.id, goalATitle);
		const goalBId = await createArchivedGoal(projectB.id, goalBTitle);

		try {
			await openMobileApp(page, { showArchived: true });

			await expect(page.getByText(goalATitle, { exact: false }).first()).toBeVisible({ timeout: 15_000 });
			await expect(page.getByText(goalBTitle, { exact: false }).first()).toBeVisible({ timeout: 10_000 });
			const archivedHeaders = page.locator("span.uppercase").filter({ hasText: /^Archived$/ });
			await expect.poll(async () => archivedHeaders.count(), { timeout: 10_000 }).toBeGreaterThanOrEqual(2);

			const goalAIdx = await goalIndex(page, goalATitle);
			expect(goalAIdx).toBeGreaterThan(await projectIndex(page, "proj-m-arch-a-"));
			expect(goalAIdx).toBeLessThan(await projectIndex(page, "proj-m-arch-b-"));

			// Collapse Project B's Archived subsection and verify the shared localStorage key survives reload.
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
				if (archivedBefore.length === 0) throw new Error("no collapsible Archived header precedes goalB");
				archivedBefore[archivedBefore.length - 1].click();
			}, goalBTitle);

			await expect(page.getByText(goalBTitle, { exact: false })).toHaveCount(0, { timeout: 3_000 });
			await expect(page.getByText(goalATitle, { exact: false }).first()).toBeVisible({ timeout: 3_000 });
			const stored = await page.evaluate(() => localStorage.getItem("bobbit-archived-collapsed-projects"));
			expect(JSON.parse(stored!)).toContain(projectB.id);

			await page.reload();
			await page.waitForSelector("input[data-search]", { timeout: 20_000 });
			await expect(page.getByText(goalATitle, { exact: false }).first()).toBeVisible({ timeout: 10_000 });
			await expect(page.getByText(goalBTitle, { exact: false })).toHaveCount(0, { timeout: 5_000 });

			// Search should filter to Project A's archived subsection and keep the goal nested in that project.
			await openMobileApp(page, { showArchived: true });
			const searchInput = page.locator("input[data-search]");
			await searchInput.fill(goalATitle);
			await expect(page.getByText(goalATitle, { exact: false }).first()).toBeVisible({ timeout: 10_000 });
			await expect(page.getByText(goalBTitle, { exact: false })).toHaveCount(0, { timeout: 5_000 });
			await expect(archivedHeaders).toHaveCount(1, { timeout: 10_000 });

			const nestedInProjectA = await page.evaluate(
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
						if (txt.includes(projectPrefix) && txt.length < bodyLen * 0.9) return { ok: true };
						node = node.parentElement;
					}
					return { ok: false, reason: "no scoped ancestor shared with project A" };
				},
				{ goalTitle: goalATitle, projectPrefix: "proj-m-arch-a-" },
			);
			expect(nestedInProjectA.ok, nestedInProjectA.reason).toBe(true);

			// Toggle off hides all per-project Archived subsections.
			await openMobileApp(page, { showArchived: true });
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
