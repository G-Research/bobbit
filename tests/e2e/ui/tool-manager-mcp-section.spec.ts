/**
 * E2E: Tools page renders an "MCP" section with one row per server,
 * collapsible to reveal per-tool (sub-namespace) rows, each of which
 * is itself collapsible to reveal its operations. Mocks
 * `GET /api/mcp-servers` and `GET/PUT /api/tool-group-policies` via
 * Playwright route interception so the test does not depend on a
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
			{ name: "mcp__halo__get-direct-reports", description: "Returns the direct reports for an entity.", op: "get-direct-reports" },
			{ name: "mcp__halo__list-employees", description: "Lists employees.", op: "list-employees" },
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

const GATEWAY_SERVERS = [
	{
		name: "gr",
		status: "connected",
		toolCount: 3,
		tools: [
			{ name: "mcp__gr__ai-adoption__list-articles", description: "List adoption articles.", subNamespace: "ai-adoption", op: "list-articles" },
			{ name: "mcp__gr__ai-adoption__create-article", description: "Create an adoption article.", subNamespace: "ai-adoption", op: "create-article" },
			{ name: "mcp__gr__jira__get-queue", description: "Read the jira queue.", subNamespace: "jira", op: "get-queue" },
		],
	},
	{
		name: "playwright",
		status: "connected",
		toolCount: 2,
		tools: [
			{ name: "mcp__playwright__click", description: "Click a CSS selector.", op: "click" },
			{ name: "mcp__playwright__snap", description: "Snapshot accessibility tree.", op: "snap" },
		],
	},
];

async function mockMcp(page: import("@playwright/test").Page, servers: unknown = FAKE_SERVERS): Promise<void> {
	await page.route("**/api/mcp-servers", async (route) => {
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify(servers),
		});
	});
}

interface PolicyMockState {
	policies: Record<string, string>;
	puts: Array<{ key: string; policy: string | null }>;
}

async function mockPolicies(page: import("@playwright/test").Page, initial: Record<string, string> = {}): Promise<PolicyMockState> {
	const state: PolicyMockState = { policies: { ...initial }, puts: [] };
	await page.route("**/api/tool-group-policies", async (route) => {
		// Cascade format: { group: { policy, origin } }
		const cascade: Record<string, { policy: string; origin: string }> = {};
		for (const [k, v] of Object.entries(state.policies)) cascade[k] = { policy: v, origin: "server" };
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify(cascade),
		});
	});
	await page.route("**/api/tool-group-policies/*", async (route, request) => {
		const url = new URL(request.url());
		const key = decodeURIComponent(url.pathname.split("/").pop() ?? "");
		if (request.method() === "PUT") {
			let body: { policy: string | null } = { policy: null };
			try { body = JSON.parse(request.postData() ?? "{}"); } catch { /* ignore */ }
			state.puts.push({ key, policy: body.policy });
			if (body.policy) state.policies[key] = body.policy;
			else delete state.policies[key];
			await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
		} else {
			await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({}) });
		}
	});
	return state;
}

test.describe("Tools page \u2192 MCP section", () => {
	test("renders one row per MCP server with status pill and op count", async ({ page }) => {
		await mockMcp(page);
		await mockPolicies(page);
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
		await expect(halo.getByText("2 operations").first()).toBeVisible();

		const broken = section.locator('[data-server-name="broken"]');
		await expect(broken.locator('[data-testid="mcp-server-status"]')).toHaveText("error");
		await expect(broken.locator('[data-testid="mcp-server-error"]')).toContainText("stdio transport: ENOENT spawn");

		// Default: collapsed \u2014 ops not yet rendered.
		await expect(halo.locator('[data-testid="mcp-server-ops"]')).toHaveCount(0);
	});

	test("flat server expands to one tool row whose name = server, then operations", async ({ page }) => {
		await mockMcp(page);
		await mockPolicies(page);
		await openApp(page);
		await navigateToHash(page, "#/tools");

		const section = page.locator('[data-testid="mcp-section"]');
		await expect(section).toBeVisible({ timeout: 10_000 });

		const halo = section.locator('[data-server-name="halo"]');
		await halo.locator('[data-testid="mcp-server-toggle"]').click();

		// One tool row, matching the server name (flat server).
		const toolRows = halo.locator('[data-testid="mcp-tool-row"]');
		await expect(toolRows).toHaveCount(1);
		await expect(toolRows.first()).toHaveAttribute("data-tool-name", "halo");

		// Expand the tool row to reveal operations.
		await toolRows.first().locator('[data-testid="mcp-tool-toggle"]').click();
		const ops = halo.locator('[data-testid="mcp-server-ops"]');
		await expect(ops).toBeVisible();
		await expect(ops.getByText("mcp__halo__get-direct-reports")).toBeVisible();
		await expect(ops.getByText("mcp__halo__list-employees")).toBeVisible();

		// Collapse again \u2014 ops disappear.
		await toolRows.first().locator('[data-testid="mcp-tool-toggle"]').click();
		await expect(halo.locator('[data-testid="mcp-server-ops"]')).toHaveCount(0);
	});

	test("expansion state is in-memory only \u2014 reload resets to collapsed", async ({ page }) => {
		await mockMcp(page);
		await mockPolicies(page);
		await openApp(page);
		await navigateToHash(page, "#/tools");

		const section = page.locator('[data-testid="mcp-section"]');
		await expect(section).toBeVisible({ timeout: 10_000 });

		const halo = section.locator('[data-server-name="halo"]');
		await halo.locator('[data-testid="mcp-server-toggle"]').click();
		await halo.locator('[data-testid="mcp-tool-toggle"]').first().click();
		await expect(halo.locator('[data-testid="mcp-server-ops"]')).toBeVisible();

		await page.reload();
		await navigateToHash(page, "#/tools");
		const sectionAfter = page.locator('[data-testid="mcp-section"]');
		await expect(sectionAfter).toBeVisible({ timeout: 10_000 });
		await expect(sectionAfter.locator('[data-server-name="halo"] [data-testid="mcp-server-ops"]')).toHaveCount(0);
	});

	test("gateway server surfaces ONE server row + TWO tool rows (one per sub-namespace)", async ({ page }) => {
		await mockMcp(page, GATEWAY_SERVERS);
		await mockPolicies(page);
		await openApp(page);
		await navigateToHash(page, "#/tools");

		const section = page.locator('[data-testid="mcp-section"]');
		await expect(section).toBeVisible({ timeout: 10_000 });

		const gr = section.locator('[data-server-name="gr"]');
		await expect(gr).toHaveCount(1);
		await gr.locator('[data-testid="mcp-server-toggle"]').click();

		// Two tool rows: ai-adoption and jira.
		const toolRows = gr.locator('[data-testid="mcp-tool-row"]');
		await expect(toolRows).toHaveCount(2);
		await expect(gr.locator('[data-testid="mcp-tool-row"][data-tool-name="ai-adoption"]')).toHaveCount(1);
		await expect(gr.locator('[data-testid="mcp-tool-row"][data-tool-name="jira"]')).toHaveCount(1);

		// Flat playwright server: one tool row whose name = "playwright".
		const pw = section.locator('[data-server-name="playwright"]');
		await pw.locator('[data-testid="mcp-server-toggle"]').click();
		const pwRows = pw.locator('[data-testid="mcp-tool-row"]');
		await expect(pwRows).toHaveCount(1);
		await expect(pwRows.first()).toHaveAttribute("data-tool-name", "playwright");
	});

	test("setting server-level policy fires PUT /api/tool-group-policies/mcp__gr", async ({ page }) => {
		await mockMcp(page, GATEWAY_SERVERS);
		const policyState = await mockPolicies(page);
		await openApp(page);
		await navigateToHash(page, "#/tools");

		const section = page.locator('[data-testid="mcp-section"]');
		await expect(section).toBeVisible({ timeout: 10_000 });

		const gr = section.locator('[data-server-name="gr"]');
		const serverSelect = gr.locator('[data-testid="mcp-server-policy"]').first();
		await serverSelect.selectOption("never");

		await expect.poll(() => policyState.puts.length).toBeGreaterThan(0);
		expect(policyState.puts[policyState.puts.length - 1]).toEqual({ key: "mcp__gr", policy: "never" });
	});

	test("setting tool-level policy fires PUT with key=mcp__gr__ai-adoption", async ({ page }) => {
		await mockMcp(page, GATEWAY_SERVERS);
		const policyState = await mockPolicies(page);
		await openApp(page);
		await navigateToHash(page, "#/tools");

		const section = page.locator('[data-testid="mcp-section"]');
		await expect(section).toBeVisible({ timeout: 10_000 });

		const gr = section.locator('[data-server-name="gr"]');
		await gr.locator('[data-testid="mcp-server-toggle"]').click();

		const aiTool = gr.locator('[data-testid="mcp-tool-row"][data-tool-name="ai-adoption"]');
		const toolSelect = aiTool.locator('[data-testid="mcp-tool-policy"]');
		await toolSelect.selectOption("ask");

		await expect.poll(() => policyState.puts.length).toBeGreaterThan(0);
		expect(policyState.puts[policyState.puts.length - 1]).toEqual({ key: "mcp__gr__ai-adoption", policy: "ask" });
	});

	test("reload reflects persisted tool-level policy in the dropdown", async ({ page }) => {
		await mockMcp(page, GATEWAY_SERVERS);
		await mockPolicies(page, { "mcp__gr__ai-adoption": "ask" });
		await openApp(page);
		await navigateToHash(page, "#/tools");

		const section = page.locator('[data-testid="mcp-section"]');
		await expect(section).toBeVisible({ timeout: 10_000 });

		const gr = section.locator('[data-server-name="gr"]');
		await gr.locator('[data-testid="mcp-server-toggle"]').click();

		const aiTool = gr.locator('[data-testid="mcp-tool-row"][data-tool-name="ai-adoption"]');
		const toolSelect = aiTool.locator('[data-testid="mcp-tool-policy"]');
		await expect(toolSelect).toHaveValue("ask");
	});

	test("fresh install: MCP server-policy dropdown reads empty (Allow default)", async ({ page }) => {
		await mockMcp(page, GATEWAY_SERVERS);
		await mockPolicies(page);
		await openApp(page);
		await navigateToHash(page, "#/tools");

		const section = page.locator('[data-testid="mcp-section"]');
		await expect(section).toBeVisible({ timeout: 10_000 });

		const gr = section.locator('[data-server-name="gr"]');
		const serverSelect = gr.locator('[data-testid="mcp-server-policy"]').first();
		await expect(serverSelect).toHaveValue("");

		await gr.locator('[data-testid="mcp-server-toggle"]').click();
		const aiTool = gr.locator('[data-testid="mcp-tool-row"][data-tool-name="ai-adoption"]');
		const toolSelect = aiTool.locator('[data-testid="mcp-tool-policy"]');
		await expect(toolSelect).toHaveValue("");
	});

	test("resetting policy to default fires PUT with policy=null and removes key", async ({ page }) => {
		await mockMcp(page, GATEWAY_SERVERS);
		const policyState = await mockPolicies(page, { "mcp__gr": "never" });
		await openApp(page);
		await navigateToHash(page, "#/tools");

		const section = page.locator('[data-testid="mcp-section"]');
		await expect(section).toBeVisible({ timeout: 10_000 });

		const gr = section.locator('[data-server-name="gr"]');
		const serverSelect = gr.locator('[data-testid="mcp-server-policy"]').first();
		await expect(serverSelect).toHaveValue("never");

		await serverSelect.selectOption("");

		await expect.poll(() => policyState.puts.length).toBeGreaterThan(0);
		expect(policyState.puts[policyState.puts.length - 1]).toEqual({ key: "mcp__gr", policy: null });
		expect(policyState.policies["mcp__gr"]).toBeUndefined();
	});

	test("reload after reset to default shows empty value persisted", async ({ page }) => {
		await mockMcp(page, GATEWAY_SERVERS);
		const policyState = await mockPolicies(page, { "mcp__gr": "never" });
		await openApp(page);
		await navigateToHash(page, "#/tools");

		const section = page.locator('[data-testid="mcp-section"]');
		await expect(section).toBeVisible({ timeout: 10_000 });

		const gr = section.locator('[data-server-name="gr"]');
		const serverSelect = gr.locator('[data-testid="mcp-server-policy"]').first();
		await serverSelect.selectOption("");
		await expect.poll(() => policyState.puts.length).toBeGreaterThan(0);

		await page.reload();
		await navigateToHash(page, "#/tools");

		const sectionAfter = page.locator('[data-testid="mcp-section"]');
		await expect(sectionAfter).toBeVisible({ timeout: 10_000 });
		const grAfter = sectionAfter.locator('[data-server-name="gr"]');
		const serverSelectAfter = grAfter.locator('[data-testid="mcp-server-policy"]').first();
		await expect(serverSelectAfter).toHaveValue("");
	});
});
