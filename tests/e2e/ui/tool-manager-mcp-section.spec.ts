/**
 * E2E: Tools page renders an "MCP" section with one row per server,
 * collapsible to reveal per-operation rows. Mocks `GET /api/mcp-servers`
 * via Playwright route interception so the test does not depend on a
 * real MCP server being registered.
 */
import { test, expect } from "../gateway-harness.js";
import { openApp, navigateToHash } from "./ui-helpers.js";

const FAKE_SERVERS = [
	{
		name: "halo",
		status: "connected",
		toolCount: 2,
		tools: [
			{ name: "mcp__halo__get-direct-reports", description: "Returns the direct reports for an entity." },
			{ name: "mcp__halo__list-employees", description: "Lists employees." },
		],
	},
	{
		name: "broken",
		status: "error",
		toolCount: 0,
		error: "stdio transport: ENOENT spawn",
		tools: [],
	},
];

async function mockMcp(page: import("@playwright/test").Page): Promise<void> {
	await page.route("**/api/mcp-servers", async (route) => {
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify(FAKE_SERVERS),
		});
	});
}

test.describe("Tools page \u2192 MCP section", () => {
	test("renders one row per MCP server with status pill and op count", async ({ page }) => {
		await mockMcp(page);
		await openApp(page);
		await navigateToHash(page, "#/tools");

		// MCP section is rendered.
		const section = page.locator('[data-testid="mcp-section"]');
		await expect(section).toBeVisible({ timeout: 10_000 });
		await expect(section.getByText("MCP", { exact: true })).toBeVisible();
		await expect(section.getByText("2 servers")).toBeVisible();

		// Per-server rows.
		const rows = section.locator('[data-testid="mcp-server-row"]');
		await expect(rows).toHaveCount(2);

		const halo = section.locator('[data-server-name="halo"]');
		await expect(halo.locator('[data-testid="mcp-server-status"]')).toHaveText("connected");
		await expect(halo.getByText("2 operations")).toBeVisible();

		const broken = section.locator('[data-server-name="broken"]');
		await expect(broken.locator('[data-testid="mcp-server-status"]')).toHaveText("error");
		await expect(broken.locator('[data-testid="mcp-server-error"]')).toContainText("stdio transport: ENOENT spawn");

		// Default: collapsed \u2014 ops not yet rendered.
		await expect(halo.locator('[data-testid="mcp-server-ops"]')).toHaveCount(0);
	});

	test("expanding a server row reveals its operations", async ({ page }) => {
		await mockMcp(page);
		await openApp(page);
		await navigateToHash(page, "#/tools");

		const section = page.locator('[data-testid="mcp-section"]');
		await expect(section).toBeVisible({ timeout: 10_000 });

		const halo = section.locator('[data-server-name="halo"]');
		await halo.locator('[data-testid="mcp-server-toggle"]').click();

		const ops = halo.locator('[data-testid="mcp-server-ops"]');
		await expect(ops).toBeVisible();
		await expect(ops.getByText("mcp__halo__get-direct-reports")).toBeVisible();
		await expect(ops.getByText("mcp__halo__list-employees")).toBeVisible();

		// Collapse again \u2014 ops disappear.
		await halo.locator('[data-testid="mcp-server-toggle"]').click();
		await expect(halo.locator('[data-testid="mcp-server-ops"]')).toHaveCount(0);
	});

	test("expansion state is in-memory only \u2014 reload resets to collapsed", async ({ page }) => {
		await mockMcp(page);
		await openApp(page);
		await navigateToHash(page, "#/tools");

		const section = page.locator('[data-testid="mcp-section"]');
		await expect(section).toBeVisible({ timeout: 10_000 });

		const halo = section.locator('[data-server-name="halo"]');
		await halo.locator('[data-testid="mcp-server-toggle"]').click();
		await expect(halo.locator('[data-testid="mcp-server-ops"]')).toBeVisible();

		// Reload \u2014 expansion is local-state, so it resets.
		await page.reload();
		// Re-mock after reload (route handlers persist for the page, but be explicit).
		await navigateToHash(page, "#/tools");
		const sectionAfter = page.locator('[data-testid="mcp-section"]');
		await expect(sectionAfter).toBeVisible({ timeout: 10_000 });
		await expect(sectionAfter.locator('[data-server-name="halo"] [data-testid="mcp-server-ops"]')).toHaveCount(0);
	});
});
