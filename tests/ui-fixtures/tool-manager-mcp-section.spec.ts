import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { buildBundle } from "../fixtures/build-bundle.js";

const SHELL = path.resolve("tests/ui-fixtures/fixture-shell.html");
const ENTRY = path.resolve("tests/ui-fixtures/tool-manager-mcp-section-entry.ts");
const BUNDLE_DIR = path.resolve(".bobbit/tmp/ui-fixtures");
const BUNDLE = path.join(BUNDLE_DIR, "tool-manager-mcp-section-bundle.js");
const TOOL_MANAGER_SRC = path.resolve("src/app/tool-manager-page.ts");
const API_SRC = path.resolve("src/app/api.ts");

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

test.beforeAll(() => {
	fs.mkdirSync(BUNDLE_DIR, { recursive: true });
	buildBundle({
		entry: ENTRY,
		outfile: BUNDLE,
		deps: [ENTRY, TOOL_MANAGER_SRC, API_SRC],
	});
});

async function loadFixture(page: Page): Promise<void> {
	await page.goto(`file://${SHELL.replace(/\\/g, "/")}`);
	await page.addScriptTag({ path: BUNDLE });
	await page.waitForFunction(() => (window as any).__toolMcpReady === true, null, { timeout: 10_000 });
}

async function setupMcp(page: Page, servers: unknown = FAKE_SERVERS, policies: Record<string, string> = {}): Promise<void> {
	await page.evaluate(({ servers: s, policies: p }) => {
		(window as any).__setMcpFixture({ servers: s, policies: p });
	}, { servers, policies });
	await page.evaluate(() => (window as any).__loadToolManager());
	await expect(page.locator('[data-testid="mcp-section"]')).toBeVisible({ timeout: 10_000 });
}

async function reloadWithMcp(page: Page, servers: unknown = FAKE_SERVERS, policies: Record<string, string> = {}): Promise<void> {
	await loadFixture(page);
	await setupMcp(page, servers, policies);
}

async function fetchLog(page: Page): Promise<Array<{ url: string; method: string; body: any }>> {
	return await page.evaluate(() => (window as any).__getMcpFetchLog());
}

test.describe("Tools page → MCP section fixture", () => {
	test.beforeEach(async ({ page }) => {
		await loadFixture(page);
	});

	test("renders flat servers, expands operations, and resets expansion on reload", async ({ page }) => {
		await setupMcp(page);

		const section = page.locator('[data-testid="mcp-section"]');
		await expect(section.getByText("MCP", { exact: true })).toBeVisible();
		await expect(section.getByText("2 servers")).toBeVisible();
		await expect(section.locator('[data-testid="mcp-server-row"]')).toHaveCount(2);

		const halo = section.locator('[data-server-name="halo"]');
		await expect(halo.locator('[data-testid="mcp-server-status"]')).toHaveText("connected");
		await expect(halo.getByText("2 operations").first()).toBeVisible();
		await expect(halo.locator('[data-testid="mcp-server-ops"]')).toHaveCount(0);

		const broken = section.locator('[data-server-name="broken"]');
		await expect(broken.locator('[data-testid="mcp-server-status"]')).toHaveText("error");
		await expect(broken.locator('[data-testid="mcp-server-error"]')).toContainText("stdio transport: ENOENT spawn");

		await halo.locator('[data-testid="mcp-server-toggle"]').click();
		const toolRows = halo.locator('[data-testid="mcp-tool-row"]');
		await expect(toolRows).toHaveCount(1);
		await expect(toolRows.first()).toHaveAttribute("data-tool-name", "halo");

		await toolRows.first().locator('[data-testid="mcp-tool-toggle"]').click();
		const ops = halo.locator('[data-testid="mcp-server-ops"]');
		await expect(ops).toBeVisible();
		await expect(ops.getByText("mcp__halo__get-direct-reports")).toBeVisible();
		await expect(ops.getByText("mcp__halo__list-employees")).toBeVisible();

		await toolRows.first().locator('[data-testid="mcp-tool-toggle"]').click();
		await expect(halo.locator('[data-testid="mcp-server-ops"]')).toHaveCount(0);

		await toolRows.first().locator('[data-testid="mcp-tool-toggle"]').click();
		await expect(halo.locator('[data-testid="mcp-server-ops"]')).toBeVisible();
		await reloadWithMcp(page);
		await expect(page.locator('[data-testid="mcp-section"] [data-server-name="halo"] [data-testid="mcp-server-ops"]')).toHaveCount(0);
	});

	test("groups gateway sub-namespaces and flat servers", async ({ page }) => {
		await setupMcp(page, GATEWAY_SERVERS);

		const section = page.locator('[data-testid="mcp-section"]');
		const gr = section.locator('[data-server-name="gr"]');
		await expect(gr).toHaveCount(1);
		await gr.locator('[data-testid="mcp-server-toggle"]').click();

		const toolRows = gr.locator('[data-testid="mcp-tool-row"]');
		await expect(toolRows).toHaveCount(2);
		await expect(gr.locator('[data-testid="mcp-tool-row"][data-tool-name="ai-adoption"]')).toHaveCount(1);
		await expect(gr.locator('[data-testid="mcp-tool-row"][data-tool-name="jira"]')).toHaveCount(1);

		const pw = section.locator('[data-server-name="playwright"]');
		await pw.locator('[data-testid="mcp-server-toggle"]').click();
		const pwRows = pw.locator('[data-testid="mcp-tool-row"]');
		await expect(pwRows).toHaveCount(1);
		await expect(pwRows.first()).toHaveAttribute("data-tool-name", "playwright");
	});

	test("writes server and tool policy updates", async ({ page }) => {
		await setupMcp(page, GATEWAY_SERVERS);

		const section = page.locator('[data-testid="mcp-section"]');
		const gr = section.locator('[data-server-name="gr"]');
		await gr.locator('[data-testid="mcp-server-policy"]').first().selectOption("never");
		await expect.poll(async () => (await fetchLog(page)).filter(e => e.method === "PUT").at(-1)).toEqual({
			url: "/api/tool-group-policies/mcp__gr",
			method: "PUT",
			body: { policy: "never" },
		});

		await gr.locator('[data-testid="mcp-server-toggle"]').click();
		const aiTool = gr.locator('[data-testid="mcp-tool-row"][data-tool-name="ai-adoption"]');
		await aiTool.locator('[data-testid="mcp-tool-policy"]').selectOption("ask");
		await expect.poll(async () => (await fetchLog(page)).filter(e => e.method === "PUT").at(-1)).toEqual({
			url: "/api/tool-group-policies/mcp__gr__ai-adoption",
			method: "PUT",
			body: { policy: "ask" },
		});
	});

	test("loads default and persisted policies, and reset persists empty", async ({ page }) => {
		await setupMcp(page, GATEWAY_SERVERS);
		let gr = page.locator('[data-testid="mcp-section"] [data-server-name="gr"]');
		await expect(gr.locator('[data-testid="mcp-server-policy"]').first()).toHaveValue("");
		await gr.locator('[data-testid="mcp-server-toggle"]').click();
		await expect(gr.locator('[data-testid="mcp-tool-row"][data-tool-name="ai-adoption"] [data-testid="mcp-tool-policy"]')).toHaveValue("");

		await reloadWithMcp(page, GATEWAY_SERVERS, { "mcp__gr__ai-adoption": "ask", "mcp__gr": "never" });
		gr = page.locator('[data-testid="mcp-section"] [data-server-name="gr"]');
		await expect(gr.locator('[data-testid="mcp-server-policy"]').first()).toHaveValue("never");
		await gr.locator('[data-testid="mcp-server-toggle"]').click();
		await expect(gr.locator('[data-testid="mcp-tool-row"][data-tool-name="ai-adoption"] [data-testid="mcp-tool-policy"]')).toHaveValue("ask");

		const serverSelect = gr.locator('[data-testid="mcp-server-policy"]').first();
		await serverSelect.selectOption("");
		await expect.poll(async () => (await fetchLog(page)).filter(e => e.method === "PUT").at(-1)).toEqual({
			url: "/api/tool-group-policies/mcp__gr",
			method: "PUT",
			body: { policy: null },
		});
		await expect(serverSelect).toHaveValue("");

		await reloadWithMcp(page, GATEWAY_SERVERS);
		await expect(page.locator('[data-testid="mcp-section"] [data-server-name="gr"] [data-testid="mcp-server-policy"]').first()).toHaveValue("");
	});
});
