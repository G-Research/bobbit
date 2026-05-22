/**
 * Per-project Staff sub-section — browser E2E.
 *
 * Browser coverage is consolidated into the real user-facing flows here. The
 * pure PATCH /api/staff/:id project reassignment data path is covered by the
 * API E2E suite in tests/e2e/staff-patch-reassign.spec.ts.
 */
import { test, expect, type Page } from "../gateway-harness.js";
import { apiFetch, defaultProject } from "../e2e-setup.js";
import { openApp } from "./ui-helpers.js";

const STAFF_SECTION_LOCATOR = (page: Page) =>
	page.locator("[data-testid='sidebar-expanded'] span.uppercase").filter({ hasText: /^Staff$/i });

async function resetStaffSidebarState(page: Page): Promise<void> {
	await page.evaluate(() => {
		localStorage.removeItem("bobbit-collapsed-staff");
		localStorage.removeItem("bobbit-sidebar-collapsed");
	});
	await page.reload();
	await expect(page.locator("button").filter({ hasText: "Settings" }).first()).toBeVisible({ timeout: 15_000 });
}

async function createStaffAgent(project: { id: string; rootPath: string }, name: string): Promise<any> {
	const resp = await apiFetch("/api/staff", {
		method: "POST",
		body: JSON.stringify({ name, systemPrompt: "You are a sidebar test bot.", cwd: project.rootPath, projectId: project.id }),
	});
	expect(resp.status).toBe(201);
	return resp.json();
}

async function staffPlacement(page: Page, staffName: string): Promise<{ found: boolean; underStaff: boolean; underSessions: boolean }> {
	return page.evaluate((name) => {
		const titleEls = [...document.querySelectorAll("span")]
			.filter((el) => (el.textContent || "").trim() === name);
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
	}, staffName);
}

async function staffCollapsed(page: Page, projectId: string): Promise<boolean> {
	return page.evaluate((pid) => {
		const raw = localStorage.getItem("bobbit-collapsed-staff");
		if (!raw) return false;
		try {
			const arr = JSON.parse(raw) as string[];
			return Array.isArray(arr) && arr.includes(pid);
		} catch {
			return false;
		}
	}, projectId);
}

test.describe("Per-project Staff sub-section", () => {
	const cleanup: string[] = [];

	test.afterAll(async () => {
		for (const id of cleanup) {
			await apiFetch(`/api/staff/${id}`, { method: "DELETE" }).catch(() => {});
		}
	});

	test("Staff sub-section header, placement, search, collapse persistence, and archive lifecycle", async ({ page }) => {
		const project = await defaultProject();
		const tag = Date.now();
		const matchName = `MatchableBot${tag}`;
		const otherName = `OtherBot${tag}`;

		await openApp(page);
		await resetStaffSidebarState(page);

		// Header is visible even with zero staff so users can create their first one.
		await expect(STAFF_SECTION_LOCATOR(page).first()).toBeVisible({ timeout: 10_000 });
		await expect(page.locator("button[title^='New staff agent']").first()).toBeVisible({ timeout: 5_000 });

		const matchStaff = await createStaffAgent(project, matchName);
		cleanup.push(matchStaff.id);
		const otherStaff = await createStaffAgent(project, otherName);
		cleanup.push(otherStaff.id);

		await page.reload();
		await expect(page.getByText(matchName, { exact: true }).first()).toBeVisible({ timeout: 15_000 });
		await expect(page.getByText(otherName, { exact: true }).first()).toBeVisible({ timeout: 15_000 });

		const placement = await staffPlacement(page, matchName);
		expect(placement.found).toBe(true);
		expect(placement.underStaff).toBe(true);
		expect(placement.underSessions).toBe(false);

		await page.reload();
		await expect(page.getByText(matchName, { exact: true }).first()).toBeVisible({ timeout: 15_000 });

		const searchInput = page.locator("search-box input").first();
		await expect(searchInput).toBeVisible({ timeout: 5_000 });
		await searchInput.fill(matchName);
		await expect(page.getByText(matchName, { exact: true }).first()).toBeVisible({ timeout: 5_000 });
		await expect(page.getByText(otherName, { exact: true })).toHaveCount(0, { timeout: 5_000 });
		await searchInput.fill("");
		await expect(page.getByText(otherName, { exact: true }).first()).toBeVisible({ timeout: 5_000 });

		const header = STAFF_SECTION_LOCATOR(page).first();
		await header.click();
		expect(await staffCollapsed(page, project.id)).toBe(true);

		await page.reload();
		expect(await staffCollapsed(page, project.id)).toBe(true);
		await STAFF_SECTION_LOCATOR(page).first().click();
		await expect(page.getByText(matchName, { exact: true }).first()).toBeVisible({ timeout: 10_000 });

		const retireResp = await apiFetch(`/api/staff/${matchStaff.id}`, {
			method: "PUT",
			body: JSON.stringify({ state: "retired" }),
		});
		expect(retireResp.ok).toBeTruthy();
		await page.reload();
		await expect(page.getByText(matchName, { exact: true })).toHaveCount(0, { timeout: 10_000 });

		const restoreResp = await apiFetch(`/api/staff/${matchStaff.id}`, {
			method: "PUT",
			body: JSON.stringify({ state: "active" }),
		});
		expect(restoreResp.ok).toBeTruthy();
		await page.reload();
		await expect(page.getByText(matchName, { exact: true }).first()).toBeVisible({ timeout: 10_000 });
	});

	test("collapsed sidebar surfaces staff under a dedicated STAFF bucket (not in SES)", async ({ page }) => {
		const project = await defaultProject();
		const name = `CollapsedBot${Date.now()}`;
		const staff = await createStaffAgent(project, name);
		cleanup.push(staff.id);

		await openApp(page);
		await resetStaffSidebarState(page);
		await page.evaluate(() => {
			localStorage.setItem("bobbit-sidebar-collapsed", "true");
		});
		await page.reload();

		const collapsed = page.locator("[data-testid='sidebar-collapsed']");
		await expect(collapsed).toBeVisible({ timeout: 15_000 });
		await expect(collapsed.locator("button[title^='Staff in ']").first()).toBeVisible({ timeout: 5_000 });

		const staffBucketBtn = collapsed.locator("button[title^='Staff in ']").first();
		const isExpanded = await staffBucketBtn.locator("span").first().textContent();
		if (isExpanded?.trim() !== "▾") {
			await staffBucketBtn.click();
		}
		await expect(collapsed.locator(`button[title='${name}']`)).toHaveCount(1, { timeout: 5_000 });
	});
});
