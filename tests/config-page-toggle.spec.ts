import { test, expect } from "@playwright/test";
import path from "node:path";

const TEST_PAGE = `file://${path.resolve("tests/config-page-toggle.html")}`;

// All config-page routes that should suppress session highlighting
const CONFIG_ROUTES = [
	{ hash: "#/roles", view: "roles", label: "Roles" },
	{ hash: "#/tools", view: "tools", label: "Tools" },
	{ hash: "#/workflows", view: "workflows", label: "Workflows" },
	{ hash: "#/personalities", view: "personalities", label: "Personalities" },
	{ hash: "#/skills", view: "skills", label: "Skills" },
	{ hash: "#/roles/coder", view: "role-edit", label: "Roles sub-route" },
	{ hash: "#/tools/browser_click", view: "tool-edit", label: "Tools sub-route" },
	{ hash: "#/workflows/bug-fix", view: "workflow-edit", label: "Workflows sub-route" },
	{ hash: "#/personalities/friendly", view: "personality-edit", label: "Personalities sub-route" },
];

test.describe("Config page toggle buttons — activeSessionId suppression", () => {

	test("baseline: activeSessionId() returns undefined for #/settings (already works)", async ({ page }) => {
		await page.goto(TEST_PAGE);
		await page.evaluate(() => { window.location.hash = "#/settings"; });
		const result = await page.evaluate(() => (window as any).activeSessionId());
		expect(result).toBeUndefined();
	});

	test("baseline: activeSessionId() returns session ID for #/session/abc route", async ({ page }) => {
		await page.goto(TEST_PAGE);
		await page.evaluate(() => { window.location.hash = "#/session/abc"; });
		const result = await page.evaluate(() => (window as any).activeSessionId());
		expect(result).toBe("mock-session-123");
	});

	test("baseline: activeSessionId() returns session ID on landing page", async ({ page }) => {
		await page.goto(TEST_PAGE);
		await page.evaluate(() => { window.location.hash = "#/"; });
		const result = await page.evaluate(() => (window as any).activeSessionId());
		expect(result).toBe("mock-session-123");
	});

	for (const route of CONFIG_ROUTES) {
		test(`activeSessionId should be undefined on config route ${route.hash}`, async ({ page }) => {
			await page.goto(TEST_PAGE);
			await page.evaluate((h) => { window.location.hash = h; }, route.hash);
			const result = await page.evaluate(() => (window as any).activeSessionId());
			expect(result, `activeSessionId should be undefined on config route ${route.hash} but got "${result}"`).toBeUndefined();
		});
	}

	test("getRouteFromHash correctly identifies config page views", async ({ page }) => {
		await page.goto(TEST_PAGE);
		for (const route of CONFIG_ROUTES) {
			await page.evaluate((h) => { window.location.hash = h; }, route.hash);
			const result = await page.evaluate(() => (window as any).getRouteFromHash());
			expect(result.view, `Expected view "${route.view}" for ${route.hash}`).toBe(route.view);
		}
	});
});
