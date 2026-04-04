/**
 * Mobile staff sidebar E2E test.
 *
 * Verifies that the Staff section is nested inside the project folder
 * on mobile viewports. Currently, render.ts renders it as a top-level
 * sibling after the project content — this test proves that bug exists.
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch, gitCwd } from "../e2e-setup.js";
import { openApp } from "./ui-helpers.js";

test.use({ viewport: { width: 375, height: 667 } });

test("staff section is nested inside project folder on mobile", async ({ page }) => {
	// Create a staff agent so the staff section has content
	const res = await apiFetch("/api/staff", {
		method: "POST",
		body: JSON.stringify({
			name: "Test Bot",
			systemPrompt: "You are a test bot.",
			cwd: gitCwd(),
		}),
	});
	expect(res.status).toBe(201);
	const staff = await res.json();

	try {
		await openApp(page);

		// Wait for the Staff section header to appear
		const staffHeader = page.locator("span.uppercase.tracking-wider").filter({ hasText: "Staff" }).first();
		await expect(staffHeader).toBeVisible({ timeout: 10_000 });

		// The project folder's expanded content is a div with padding-left style
		// (indented content under the project folder toggle).
		// Bug: Staff section is rendered OUTSIDE this indented div, as a sibling.
		// Fix: Staff section should be INSIDE that indented div.
		const projectContent = page.locator('div[style*="padding-left"]').first();
		await expect(projectContent).toBeVisible();

		// The staff section should be a descendant of the project content div
		const staffInsideProject = projectContent.locator("span.uppercase.tracking-wider").filter({ hasText: "Staff" }).first();
		await expect(
			staffInsideProject,
		).toBeVisible({
			timeout: 5_000,
		});
	} finally {
		// Cleanup: retire the staff agent
		await apiFetch(`/api/staff/${staff.id}`, {
			method: "PUT",
			body: JSON.stringify({ state: "retired" }),
		}).catch(() => {});
	}
});
