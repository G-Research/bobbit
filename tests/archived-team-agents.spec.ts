import { test, expect } from "@playwright/test";
import path from "node:path";

const TEST_PAGE = `file://${path.resolve("tests/fixtures/archived-team-agents.html")}`;

test.describe("Archived team agents filtering", () => {
	test("mapped member appears under live lead", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const ids = JSON.parse(await page.locator("#archivedForLiveLead").textContent() ?? "[]");
		expect(ids).toContain("member-mapped");
	});

	test("unmapped member (no teamLeadSessionId) appears under live lead", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const ids = JSON.parse(await page.locator("#archivedForLiveLead").textContent() ?? "[]");
		expect(ids).toContain("member-unmapped");
	});

	test("member with empty teamLeadSessionId appears under live lead", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const ids = JSON.parse(await page.locator("#archivedForLiveLead").textContent() ?? "[]");
		expect(ids).toContain("member-empty-lead");
	});

	test("member with archived lead stays with archived lead (not in live lead list)", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const ids = JSON.parse(await page.locator("#archivedForLiveLead").textContent() ?? "[]");
		expect(ids).not.toContain("member-archived-lead");
	});

	test("delegates are excluded from live lead list", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const ids = JSON.parse(await page.locator("#archivedForLiveLead").textContent() ?? "[]");
		expect(ids).not.toContain("member-delegate");
	});

	test("team-lead role sessions are excluded from live lead list", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const ids = JSON.parse(await page.locator("#archivedForLiveLead").textContent() ?? "[]");
		expect(ids).not.toContain("archived-lead-1");
	});

	test("member with orphan teamLeadSessionId appears under live lead", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const ids = JSON.parse(await page.locator("#archivedForLiveLead").textContent() ?? "[]");
		expect(ids).toContain("member-orphan-lead");
	});

	test("members from other goals are excluded", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const ids = JSON.parse(await page.locator("#archivedForLiveLead").textContent() ?? "[]");
		expect(ids).not.toContain("member-other-goal");
	});

	test("unmapped members returned when leads are known", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const ids = JSON.parse(await page.locator("#unmappedArchived").textContent() ?? "[]");
		// unmapped, empty-lead, and orphan-lead are not mapped to any known lead
		expect(ids).toContain("member-unmapped");
		expect(ids).toContain("member-empty-lead");
		expect(ids).toContain("member-orphan-lead");
		// mapped and archived-lead members ARE mapped
		expect(ids).not.toContain("member-mapped");
		expect(ids).not.toContain("member-archived-lead");
	});

	test("unmapped fallback: no archived leads, unmapped members still returned", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const ids = JSON.parse(await page.locator("#unmappedNoArchivedLeads").textContent() ?? "[]");
		// With no leads at all, ALL non-delegate non-lead members are unmapped
		expect(ids.length).toBeGreaterThan(0);
		expect(ids).toContain("member-unmapped");
		expect(ids).toContain("member-empty-lead");
		expect(ids).toContain("member-mapped");
		expect(ids).toContain("member-archived-lead");
		expect(ids).toContain("member-orphan-lead");
		// Delegate and other-goal members still excluded
		expect(ids).not.toContain("member-delegate");
		expect(ids).not.toContain("member-other-goal");
	});
});
