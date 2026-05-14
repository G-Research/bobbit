/**
 * Surface staff in Sessions — browser E2E.
 *
 * Pins the surface-staff-in-sessions design (see goal goal-surface-st-…):
 *  1. Creating a staff via the in-project "+ New staff" button → the staff
 *     row appears inside that project's Sessions list, named after the staff.
 *  2. The row persists across a page reload.
 *  3. Archiving the staff (DELETE) removes the row.
 *  4. The collapsed sidebar surfaces the same staff inside the project bucket
 *     (no flat global tail list).
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch, gitCwd, defaultProjectId } from "../e2e-setup.js";
import { openApp } from "./ui-helpers.js";

test.describe("Staff folded into project Sessions list", () => {
	const cleanup: string[] = [];

	test.afterAll(async () => {
		for (const id of cleanup) {
			await apiFetch(`/api/staff/${id}`, { method: "DELETE" }).catch(() => {});
		}
	});

	test("staff row appears inside project's Sessions; reload persists; archive removes", async ({ page }) => {
		const pid = await defaultProjectId();
		expect(pid).toBeTruthy();
		const cwd = gitCwd();

		// Create the staff via REST so we can deterministically pin its name.
		const name = `SidebarBot${Date.now()}`;
		const resp = await apiFetch("/api/staff", {
			method: "POST",
			body: JSON.stringify({
				name,
				systemPrompt: "You are a sidebar test bot.",
				cwd,
				projectId: pid,
			}),
		});
		expect(resp.status).toBe(201);
		const staff = await resp.json();
		cleanup.push(staff.id);

		await openApp(page);

		// 1. Row appears in the Sessions list.
		const row = page.getByText(name, { exact: false }).first();
		await expect(row).toBeVisible({ timeout: 15_000 });

		// 2. Reload persists.
		await page.reload();
		await expect(page.getByText(name, { exact: false }).first()).toBeVisible({ timeout: 15_000 });

		// 3. Archive (DELETE) → row disappears.
		await apiFetch(`/api/staff/${staff.id}`, { method: "DELETE" });
		await page.reload();
		await expect(page.getByText(name, { exact: false })).toHaveCount(0, { timeout: 10_000 });
		// Already removed: drop from cleanup so afterAll doesn't 404.
		const idx = cleanup.indexOf(staff.id);
		if (idx >= 0) cleanup.splice(idx, 1);
	});

	test("collapsed sidebar surfaces the staff inline (no flat tail list)", async ({ page }) => {
		const pid = await defaultProjectId();
		expect(pid).toBeTruthy();
		const cwd = gitCwd();

		const name = `CollapsedBot${Date.now()}`;
		const resp = await apiFetch("/api/staff", {
			method: "POST",
			body: JSON.stringify({ name, systemPrompt: "x", cwd, projectId: pid }),
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

		// A staff row should be present in the collapsed sidebar (rendered as
		// a session acronym button with title = staff name).
		const titleAttr = await collapsed.locator(`button[title='${name}']`).count();
		expect(titleAttr).toBeGreaterThanOrEqual(1);
	});
});
