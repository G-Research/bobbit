/**
 * Per-project Staff sub-section — browser E2E.
 *
 * Pins the restore-staff-sub-section design (replaces PR #583's
 * "staff folded into Sessions" behaviour):
 *
 *  1. Each project has a dedicated, collapsible "Staff" sub-section, visible
 *     even when zero staff exist (so users can create their first one).
 *  2. Created staff agents render inside that Staff sub-section — NOT inside
 *     the project's Sessions list.
 *  3. Expand/collapse state persists across a reload.
 *  4. Search filters staff inside the sub-section.
 *  5. Archiving (PUT state:retired) removes the row from the sub-section.
 *  6. PATCH /api/staff/:id { projectId } moves the row under the target project
 *     (orphan-banner fix path).
 *  7. Collapsed sidebar surfaces staff under a dedicated STAFF bucket per
 *     project (not flat-merged into the SES bucket).
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch, defaultProject, defaultProjectId } from "../e2e-setup.js";
import { openApp } from "./ui-helpers.js";

const STAFF_SECTION_LOCATOR = (page: import("@playwright/test").Page) =>
	page.locator("[data-testid='sidebar-expanded'] span.uppercase").filter({ hasText: /^Staff$/i });

test.describe("Per-project Staff sub-section", () => {
	const cleanup: string[] = [];

	test.afterAll(async () => {
		for (const id of cleanup) {
			await apiFetch(`/api/staff/${id}`, { method: "DELETE" }).catch(() => {});
		}
	});

	test("Staff sub-section is visible even with zero staff configured", async ({ page }) => {
		await openApp(page);
		// Wait for sidebar fully loaded
		await expect(page.locator("[data-testid='sidebar-expanded']")).toBeVisible({ timeout: 15_000 });

		// Even when no staff exists, every project bucket shows the Staff
		// sub-section header so users can create their first one.
		await expect(STAFF_SECTION_LOCATOR(page).first()).toBeVisible({ timeout: 10_000 });

		// "+ New staff agent" button is reachable on the sub-section header.
		await expect(page.locator("button[title^='New staff agent']").first()).toBeVisible({ timeout: 5_000 });
	});

	test("staff row appears inside Staff sub-section (not in Sessions); reload persists; archive removes", async ({ page }) => {
		const project = await defaultProject();
		const pid = project.id;

		const name = `SubSectionBot${Date.now()}`;
		const resp = await apiFetch("/api/staff", {
			method: "POST",
			body: JSON.stringify({
				name,
				systemPrompt: "You are a sidebar test bot.",
				cwd: project.rootPath,
				projectId: pid,
			}),
		});
		expect(resp.status).toBe(201);
		const staff = await resp.json();
		cleanup.push(staff.id);

		await openApp(page);

		// 1. Row appears somewhere in the sidebar.
		const row = page.getByText(name, { exact: true }).first();
		await expect(row).toBeVisible({ timeout: 15_000 });

		// 2. Row's nearest section is "Staff", NOT "Sessions".
		const placement = await page.evaluate((staffName) => {
			const titleEls = [...document.querySelectorAll("span")]
				.filter((el) => (el.textContent || "").trim() === staffName);
			if (titleEls.length === 0) return { found: false, underStaff: false, underSessions: false };
			const headersWithLabel = (label: string) =>
				[...document.querySelectorAll("span")].filter(
					(el) => (el.textContent || "").trim().toLowerCase() === label.toLowerCase(),
				);
			const sectionWrappersFor = (label: string): Element[] => {
				const wrappers: Element[] = [];
				for (const h of headersWithLabel(label)) {
					const w = h.parentElement?.parentElement;
					if (w) wrappers.push(w);
				}
				return wrappers;
			};
			const staffWrappers = sectionWrappersFor("Staff");
			const sessionWrappers = sectionWrappersFor("Sessions");
			const isInside = (wrappers: Element[], el: Element) =>
				wrappers.some((w) => w !== el && w.contains(el));
			let underStaff = false;
			let underSessions = false;
			for (const t of titleEls) {
				if (isInside(staffWrappers, t)) underStaff = true;
				if (isInside(sessionWrappers, t)) underSessions = true;
			}
			return { found: true, underStaff, underSessions };
		}, name);
		expect(placement.found).toBe(true);
		expect(placement.underStaff).toBe(true);
		expect(placement.underSessions).toBe(false);

		// 3. Reload persists.
		await page.reload();
		await expect(page.getByText(name, { exact: true }).first()).toBeVisible({ timeout: 15_000 });

		// 4. Archive via PUT state:"retired" → row disappears.
		const retireResp = await apiFetch(`/api/staff/${staff.id}`, {
			method: "PUT",
			body: JSON.stringify({ state: "retired" }),
		});
		expect(retireResp.ok).toBeTruthy();
		await page.reload();
		await expect(page.getByText(name, { exact: true })).toHaveCount(0, { timeout: 10_000 });

		// 5. Restore via PUT state:"active" → row reappears.
		const restoreResp = await apiFetch(`/api/staff/${staff.id}`, {
			method: "PUT",
			body: JSON.stringify({ state: "active" }),
		});
		expect(restoreResp.ok).toBeTruthy();
		await page.reload();
		await expect(page.getByText(name, { exact: true }).first()).toBeVisible({ timeout: 10_000 });

		// Final cleanup.
		await apiFetch(`/api/staff/${staff.id}`, { method: "DELETE" });
		const idx = cleanup.indexOf(staff.id);
		if (idx >= 0) cleanup.splice(idx, 1);
	});

	test("collapse/expand state persists across reload", async ({ page }) => {
		const pid = await defaultProjectId();
		expect(pid).toBeTruthy();
		await openApp(page);

		// Section is expanded by default — its header is visible.
		const header = STAFF_SECTION_LOCATOR(page).first();
		await expect(header).toBeVisible({ timeout: 10_000 });

		// Collapse by clicking the header.
		await header.click();

		// localStorage now records the project as collapsed.
		const collapsedAfter = await page.evaluate((projectId) => {
			const raw = localStorage.getItem("bobbit-collapsed-staff");
			if (!raw) return false;
			try {
				const arr = JSON.parse(raw) as string[];
				return Array.isArray(arr) && arr.includes(projectId);
			} catch { return false; }
		}, pid!);
		expect(collapsedAfter).toBe(true);

		// Persist across reload.
		await page.reload();
		const collapsedAfterReload = await page.evaluate((projectId) => {
			const raw = localStorage.getItem("bobbit-collapsed-staff");
			if (!raw) return false;
			try {
				const arr = JSON.parse(raw) as string[];
				return Array.isArray(arr) && arr.includes(projectId);
			} catch { return false; }
		}, pid!);
		expect(collapsedAfterReload).toBe(true);

		// Restore the default expanded state for any later tests.
		await STAFF_SECTION_LOCATOR(page).first().click();
	});

	test("search filters staff inside the sub-section", async ({ page }) => {
		const project = await defaultProject();
		const pid = project.id;

		const tag = Date.now();
		const matchName = `MatchableBot${tag}`;
		const otherName = `OtherBot${tag}`;
		for (const n of [matchName, otherName]) {
			const r = await apiFetch("/api/staff", {
				method: "POST",
				body: JSON.stringify({ name: n, systemPrompt: "x", cwd: project.rootPath, projectId: pid }),
			});
			expect(r.status).toBe(201);
			const s = await r.json();
			cleanup.push(s.id);
		}

		await openApp(page);
		await expect(page.getByText(matchName, { exact: true }).first()).toBeVisible({ timeout: 15_000 });
		await expect(page.getByText(otherName, { exact: true }).first()).toBeVisible({ timeout: 15_000 });

		// Type a query that matches only the first bot.
		const searchInput = page.locator("search-box input").first();
		await expect(searchInput).toBeVisible({ timeout: 5_000 });
		await searchInput.fill(matchName);

		// Match survives; non-match is filtered out.
		await expect(page.getByText(matchName, { exact: true }).first()).toBeVisible({ timeout: 5_000 });
		await expect(page.getByText(otherName, { exact: true })).toHaveCount(0, { timeout: 5_000 });

		// Clear the query.
		await searchInput.fill("");
	});

	test("PATCH /api/staff/:id { projectId } moves the row under the target project", async ({ page }) => {
		// Orphan-banner fix path: PATCH endpoint moves the staff into a project,
		// after which the row should appear inside that project's Staff sub-section.
		const project = await defaultProject();
		const pid = project.id;

		const name = `OrphanBot${Date.now()}`;
		const resp = await apiFetch("/api/staff", {
			method: "POST",
			body: JSON.stringify({ name, systemPrompt: "orphan test bot.", cwd: project.rootPath, projectId: pid }),
		});
		expect(resp.status).toBe(201);
		const staff = await resp.json();
		cleanup.push(staff.id);

		const patch = await apiFetch(`/api/staff/${staff.id}`, {
			method: "PATCH",
			body: JSON.stringify({ projectId: pid }),
		});
		expect(patch.ok).toBeTruthy();
		const patched = await patch.json();
		expect(patched.projectId).toBe(pid);

		await openApp(page);
		await expect(page.getByText(name, { exact: true }).first()).toBeVisible({ timeout: 15_000 });

		await page.reload();
		await expect(page.getByText(name, { exact: true }).first()).toBeVisible({ timeout: 15_000 });
	});

	test("collapsed sidebar surfaces staff under a dedicated STAFF bucket (not in SES)", async ({ page }) => {
		const project = await defaultProject();
		const pid = project.id;

		const name = `CollapsedBot${Date.now()}`;
		const resp = await apiFetch("/api/staff", {
			method: "POST",
			body: JSON.stringify({ name, systemPrompt: "x", cwd: project.rootPath, projectId: pid }),
		});
		expect(resp.status).toBe(201);
		const staff = await resp.json();
		cleanup.push(staff.id);

		await openApp(page);
		// Collapse the sidebar.
		await page.evaluate(() => {
			localStorage.setItem("bobbit-sidebar-collapsed", "true");
		});
		await page.reload();

		const collapsed = page.locator("[data-testid='sidebar-collapsed']");
		await expect(collapsed).toBeVisible({ timeout: 15_000 });

		// A dedicated STAFF bucket header is rendered (separate from SES).
		await expect(collapsed.locator("button[title^='Staff in ']").first()).toBeVisible({ timeout: 5_000 });

		// The staff button (title = staff name) is reachable inside the collapsed
		// sidebar after expanding the STAFF bucket if necessary.
		const staffBucketBtn = collapsed.locator("button[title^='Staff in ']").first();
		const isExpanded = await staffBucketBtn.locator("span").first().textContent();
		if (isExpanded?.trim() !== "▾") {
			await staffBucketBtn.click();
		}
		await expect(collapsed.locator(`button[title='${name}']`)).toHaveCount(1, { timeout: 5_000 });
	});
});
