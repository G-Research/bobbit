/**
 * Reproducing test for Bug 4: Sidebar collapse state bleeding across projects.
 *
 * The current implementation uses a single global boolean for ungrouped/staff
 * section collapse state. Collapsing Sessions in Project A also collapses
 * Sessions in Project B. After the fix, each project should have independent
 * collapse state.
 *
 * These tests assert the DESIRED (post-fix) behavior and are expected to FAIL
 * on the current (pre-fix) codebase.
 */
import { test, expect } from "@playwright/test";
import path from "node:path";

const TEST_PAGE = `file://${path.resolve("tests/sidebar-collapse.html")}`;

test.describe("Bug 4: Sidebar collapse state per-project", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(TEST_PAGE);
		// Clear localStorage to start fresh
		await page.evaluate(() => localStorage.clear());
		// Reload to re-initialize state from clean localStorage
		await page.goto(TEST_PAGE);
	});

	test("collapsing ungrouped section for project-A does not affect project-B", async ({ page }) => {
		const result = await page.evaluate(() => {
			const s = (window as any).__collapseState;

			// Both projects start expanded (default)
			const aExpandedBefore = s.isUngroupedExpandedForProject("project-A");
			const bExpandedBefore = s.isUngroupedExpandedForProject("project-B");

			// Collapse project-A's ungrouped section
			s.setUngroupedExpandedForProject("project-A", false);

			// Check both projects
			const aExpandedAfter = s.isUngroupedExpandedForProject("project-A");
			const bExpandedAfter = s.isUngroupedExpandedForProject("project-B");

			return { aExpandedBefore, bExpandedBefore, aExpandedAfter, bExpandedAfter };
		});

		// Both start expanded
		expect(result.aExpandedBefore).toBe(true);
		expect(result.bExpandedBefore).toBe(true);

		// After collapsing A: A is collapsed, B is still expanded
		expect(result.aExpandedAfter).toBe(false);
		// BUG: This fails because the global boolean affects both projects
		expect(result.bExpandedAfter).toBe(true);
	});

	test("collapsing staff section for project-A does not affect project-B", async ({ page }) => {
		const result = await page.evaluate(() => {
			const s = (window as any).__collapseState;

			// Collapse project-A's staff section
			s.setStaffExpandedForProject("project-A", false);

			const aExpanded = s.isStaffExpandedForProject("project-A");
			const bExpanded = s.isStaffExpandedForProject("project-B");

			return { aExpanded, bExpanded };
		});

		expect(result.aExpanded).toBe(false);
		// BUG: This fails because the global boolean affects both projects
		expect(result.bExpanded).toBe(true);
	});

	test("each project maintains independent collapse state", async ({ page }) => {
		const result = await page.evaluate(() => {
			const s = (window as any).__collapseState;

			// Collapse A, expand B explicitly
			s.setUngroupedExpandedForProject("project-A", false);
			s.setUngroupedExpandedForProject("project-B", true);

			// Collapse B's staff, keep A's staff expanded
			s.setStaffExpandedForProject("project-B", false);

			return {
				aUngrouped: s.isUngroupedExpandedForProject("project-A"),
				bUngrouped: s.isUngroupedExpandedForProject("project-B"),
				aStaff: s.isStaffExpandedForProject("project-A"),
				bStaff: s.isStaffExpandedForProject("project-B"),
			};
		});

		// BUG: With global booleans, the last-set value wins for ALL projects
		expect(result.aUngrouped).toBe(false); // Should be collapsed
		expect(result.bUngrouped).toBe(true);  // Should be expanded
		expect(result.aStaff).toBe(true);       // Should be expanded (default)
		expect(result.bStaff).toBe(false);      // Should be collapsed
	});
});
