import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { buildBundle } from "../../support/helpers/browser/fixtures/build-bundle.js";

const SHELL = path.resolve("tests/ui-fixtures/fixture-shell.html");
const ENTRY = path.resolve("tests/ui-fixtures/tool-manager-mcp-section-entry.ts");
const BUNDLE_DIR = path.resolve(".bobbit/tmp/ui-fixtures");
const BUNDLE = path.join(BUNDLE_DIR, "tool-manager-mcp-section-bundle.js");
const TOOL_MANAGER_SRC = path.resolve("src/app/tool-manager-page.ts");
const TOOL_MANAGER_CSS = path.resolve("src/app/tool-manager.css");
const API_SRC = path.resolve("src/app/api.ts");
const GATEWAY_FETCH_SRC = path.resolve("src/app/gateway-fetch.ts");
const FIXTURE_GATEWAY_BASE_URL = "https://fixture.test/team/bobbit";
const FIXTURE_GATEWAY_TOKEN = "fixture-token";

type FetchLogEntry = {
	url: string;
	method: string;
	body: any;
	credentials: RequestCredentials | null;
	authorization: string | null;
};

function expectedGatewayRequest(route: string, method = "GET", body: any = null): FetchLogEntry {
	return {
		url: `${FIXTURE_GATEWAY_BASE_URL}${route}`,
		method,
		body,
		credentials: null,
		authorization: `Bearer ${FIXTURE_GATEWAY_TOKEN}`,
	};
}

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

const APPROVAL_SERVERS = [
	{
		name: "local-project",
		status: "disconnected",
		toolCount: 0,
		tools: [],
		approval: { required: true, state: "pending", fingerprint: "0123456789abcdef" },
		source: { sourceId: "project-file:.mcp.json", authority: "project", projectId: "project-a", projectName: "Acme Portal", file: ".mcp.json" },
		reviewConfig: { transport: "stdio", command: "node", args: ["server.js", "--token", "[redacted]"], cwd: "./services/mcp", env: { API_TOKEN: "[redacted]" } },
		diagnostics: [{ code: "MCP_APPROVAL_PENDING", message: "Review this project-defined server before Bobbit starts it." }],
	},
	{
		name: "remote-changed",
		status: "disconnected",
		toolCount: 0,
		tools: [],
		approval: { required: true, state: "changed", fingerprint: "fedcba9876543210" },
		source: { sourceId: "project-file:.claude/.mcp.json", authority: "project", projectId: "project-b", projectName: "Data Service", file: ".claude/.mcp.json" },
		reviewConfig: { transport: "http", url: "https://mcp.example.test/events", headers: { Authorization: "[redacted]" } },
		diagnostics: [{ code: "MCP_APPROVAL_CHANGED", message: "The server configuration changed." }],
	},
	{
		name: "rejected-project",
		status: "disconnected",
		toolCount: 0,
		tools: [],
		approval: { required: true, state: "rejected", fingerprint: "aaaaaaaaaaaaaaaa" },
		source: { sourceId: "project-file:.bobbit/config/mcp.json", authority: "project", projectId: "project-a", projectName: "Acme Portal", file: ".bobbit/config/mcp.json" },
		reviewConfig: { transport: "stdio", command: "python", args: ["mcp.py"] },
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
		deps: [ENTRY, TOOL_MANAGER_SRC, API_SRC, GATEWAY_FETCH_SRC],
	});
});

async function loadFixture(page: Page): Promise<void> {
	await page.goto(`file://${SHELL.replace(/\\/g, "/")}`);
	await page.addStyleTag({ path: TOOL_MANAGER_CSS });
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

async function fetchLog(page: Page): Promise<FetchLogEntry[]> {
	return await page.evaluate(() => (window as any).__getMcpFetchLog());
}

test.describe("Tools page → MCP section fixture", () => {
	test.beforeEach(async ({ page }) => {
		await loadFixture(page);
	});

	test("renders flat servers, expands operations, and resets expansion on reload", async ({ page }) => {
		await setupMcp(page);
		await expect.poll(() => fetchLog(page)).toEqual([
			expectedGatewayRequest("/api/tools?projectId=headquarters"),
			expectedGatewayRequest("/api/roles?projectId=headquarters"),
			expectedGatewayRequest("/api/tool-group-policies?projectId=headquarters"),
			expectedGatewayRequest("/api/mcp-servers?projectId=headquarters&ensure=true"),
		]);

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
		await expect.poll(async () => (await fetchLog(page)).filter(e => e.method === "PUT").at(-1)).toEqual(
			expectedGatewayRequest("/api/tool-group-policies/mcp__gr", "PUT", { policy: "never", projectId: "headquarters" }),
		);

		await gr.locator('[data-testid="mcp-server-toggle"]').click();
		const aiTool = gr.locator('[data-testid="mcp-tool-row"][data-tool-name="ai-adoption"]');
		await aiTool.locator('[data-testid="mcp-tool-policy"]').selectOption("ask");
		await expect.poll(async () => (await fetchLog(page)).filter(e => e.method === "PUT").at(-1)).toEqual(
			expectedGatewayRequest("/api/tool-group-policies/mcp__gr__ai-adoption", "PUT", { policy: "ask", projectId: "headquarters" }),
		);
	});

	test("uses supplied public MCP policy keys when gateway runtime names differ", async ({ page }) => {
		await setupMcp(page, [{
			name: "gateway_gr_jira_source_a_deadbeef",
			status: "connected",
			toolCount: 1,
			serverPolicyKey: "mcp__gr",
			policyKey: "mcp__gr",
			tools: [{
				name: "mcp__gr__jira__jira_search",
				description: "Search Jira issues.",
				subNamespace: "jira",
				op: "jira_search",
				serverPolicyKey: "mcp__gr",
				packagePolicyKey: "mcp__gr__jira",
				operationPolicyKey: "mcp__gr__jira__jira_search",
				policyKey: "mcp__gr__jira__jira_search",
			}],
		}]);

		const section = page.locator('[data-testid="mcp-section"]');
		const gateway = section.locator('[data-server-name="gateway_gr_jira_source_a_deadbeef"]');
		await expect(gateway).toHaveAttribute("data-policy-key", "mcp__gr");
		await gateway.locator('[data-testid="mcp-server-toggle"]').click({ position: { x: 10, y: 10 } });
		const jiraTool = gateway.locator('[data-testid="mcp-tool-row"][data-tool-name="jira"]');
		await gateway.locator('[data-testid="mcp-server-policy"]').first().selectOption("never");
		await expect.poll(async () => (await fetchLog(page)).filter(e => e.method === "PUT").at(-1)).toEqual(
			expectedGatewayRequest("/api/tool-group-policies/mcp__gr", "PUT", { policy: "never", projectId: "headquarters" }),
		);
		await expect(jiraTool).toHaveAttribute("data-policy-key", "mcp__gr__jira");
		await jiraTool.locator('[data-testid="mcp-tool-policy"]').selectOption("ask");
		await expect.poll(async () => (await fetchLog(page)).filter(e => e.method === "PUT").at(-1)).toEqual(
			expectedGatewayRequest("/api/tool-group-policies/mcp__gr__jira", "PUT", { policy: "ask", projectId: "headquarters" }),
		);

		await jiraTool.locator('[data-testid="mcp-tool-toggle"]').click();
		const op = gateway.locator('[data-testid="mcp-operation-row"][data-tool-name="mcp__gr__jira__jira_search"]');
		await expect(op).toHaveAttribute("data-policy-key", "mcp__gr__jira__jira_search");
	});

	test("shows inherited parent MCP policy for unset sub-namespace rows without storing override", async ({ page }) => {
		await setupMcp(page, GATEWAY_SERVERS, { "mcp__gr": "never" });

		const section = page.locator('[data-testid="mcp-section"]');
		const gr = section.locator('[data-server-name="gr"]');
		await expect(gr.locator('[data-testid="mcp-server-policy"]').first()).toHaveValue("never");
		await gr.locator('[data-testid="mcp-server-toggle"]').click();

		const jiraPolicy = gr.locator('[data-testid="mcp-tool-row"][data-tool-name="jira"] [data-testid="mcp-tool-policy"]');
		await expect(jiraPolicy).toHaveValue("");
		await expect(jiraPolicy.locator("option:checked")).toHaveText(/Never.*inherited/i);

		await jiraPolicy.selectOption("ask");
		await expect.poll(async () => (await fetchLog(page)).filter(e => e.method === "PUT").at(-1)).toEqual(
			expectedGatewayRequest("/api/tool-group-policies/mcp__gr__jira", "PUT", { policy: "ask", projectId: "headquarters" }),
		);
		await expect(jiraPolicy).toHaveValue("ask");
		await expect(jiraPolicy.locator("option:checked")).toHaveText("Ask");

		await jiraPolicy.selectOption("");
		await expect.poll(async () => (await fetchLog(page)).filter(e => e.method === "PUT").at(-1)).toEqual(
			expectedGatewayRequest("/api/tool-group-policies/mcp__gr__jira", "PUT", { policy: null, projectId: "headquarters" }),
		);
		await expect(jiraPolicy).toHaveValue("");
		await expect(jiraPolicy.locator("option:checked")).toHaveText(/Never.*inherited/i);

		await reloadWithMcp(page, GATEWAY_SERVERS, { "mcp__gr": "never" });
		const reloadedGr = page.locator('[data-testid="mcp-section"] [data-server-name="gr"]');
		await reloadedGr.locator('[data-testid="mcp-server-toggle"]').click();
		const reloadedJiraPolicy = reloadedGr.locator('[data-testid="mcp-tool-row"][data-tool-name="jira"] [data-testid="mcp-tool-policy"]');
		await expect(reloadedJiraPolicy).toHaveValue("");
		await expect(reloadedJiraPolicy.locator("option:checked")).toHaveText(/Never.*inherited/i);

		const playwright = page.locator('[data-testid="mcp-section"] [data-server-name="playwright"]');
		await playwright.locator('[data-testid="mcp-server-toggle"]').click();
		const flatPolicy = playwright.locator('[data-testid="mcp-tool-row"][data-tool-name="playwright"] [data-testid="mcp-tool-policy"]');
		await expect(flatPolicy).toHaveValue("");
		await expect(flatPolicy.locator("option:checked")).toHaveText("Allow (default)");
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
		await expect.poll(async () => (await fetchLog(page)).filter(e => e.method === "PUT").at(-1)).toEqual(
			expectedGatewayRequest("/api/tool-group-policies/mcp__gr", "PUT", { policy: null, projectId: "headquarters" }),
		);
		await expect(serverSelect).toHaveValue("");

		await reloadWithMcp(page, GATEWAY_SERVERS);
		await expect(page.locator('[data-testid="mcp-section"] [data-server-name="gr"] [data-testid="mcp-server-policy"]').first()).toHaveValue("");
	});

	test("reviews safe project configuration with approval separate from health and tool calls", async ({ page }) => {
		await setupMcp(page, APPROVAL_SERVERS);
		const section = page.locator('[data-testid="mcp-section"]');
		await expect(section.getByText("3 servers · 2 need review")).toBeVisible();
		await expect(section.getByText(/Startup approval is separate from/)).toBeVisible();
		await expect(section.getByText("Approve all", { exact: false })).toHaveCount(0);

		const pending = section.locator('[data-server-name="local-project"]');
		await expect(pending.locator('[data-testid="mcp-approval-status"]')).toHaveText("Pending approval");
		await expect(pending.locator('[data-testid="mcp-server-status"]')).toHaveText("Not started");
		await expect(pending.locator('[data-testid="mcp-server-policy"]')).toBeVisible();
		await expect(pending.locator('[data-testid="mcp-server-toggle"]')).toHaveAttribute("aria-expanded", "false");
		await pending.locator('[data-testid="mcp-server-toggle"]').press("Enter");
		await expect(pending.locator('[data-testid="mcp-server-toggle"]')).toHaveAttribute("aria-expanded", "true");
		const review = pending.locator('[data-testid="mcp-review-panel"]');
		await expect(review).toContainText("Acme Portal");
		await expect(review).toContainText(".mcp.json");
		await expect(review).toContainText("node");
		await expect(review).toContainText("server.js --token [redacted]");
		await expect(review).toContainText("API_TOKEN=[redacted]");
		await expect(review).toContainText("0123456789ab");
		await expect(page.locator("body")).not.toContainText("super-secret-value");

		const changed = section.locator('[data-server-name="remote-changed"]');
		await expect(changed.locator('[data-testid="mcp-approval-status"]')).toHaveText("Configuration changed — review again");
		await expect(changed.locator('[data-testid="mcp-approve-server"]')).toHaveText("Approve current configuration");
		await changed.locator('[data-testid="mcp-server-toggle"]').click();
		await expect(changed.locator('[data-testid="mcp-review-panel"]')).toContainText("Data Service");
		await expect(changed.locator('[data-testid="mcp-review-panel"]')).toContainText("Authorization: [redacted]");

		const rejected = section.locator('[data-server-name="rejected-project"]');
		await expect(rejected.locator('[data-testid="mcp-approval-status"]')).toHaveText("Rejected");
		await expect(rejected.locator('[data-testid="mcp-reject-server"]')).toHaveCount(0);
		await expect(rejected.locator('[data-testid="mcp-approve-server"]')).toHaveText("Approve current configuration");
	});

	test("approves and rejects individually, refetches state, and returns focus", async ({ page }) => {
		await setupMcp(page, [APPROVAL_SERVERS[0]]);
		let row = page.locator('[data-server-name="local-project"]');
		await row.locator('[data-testid="mcp-approve-server"]').click();
		await expect.poll(async () => (await fetchLog(page)).find((entry) => entry.method === "POST")).toEqual(
			expectedGatewayRequest("/api/mcp-servers/local-project/approval?projectId=headquarters", "POST", {
				decision: "approved",
				fingerprint: "0123456789abcdef",
				sourceProjectId: "project-a",
				sourceId: "project-file:.mcp.json",
			}),
		);
		row = page.locator('[data-server-name="local-project"]');
		await expect(row.locator('[data-testid="mcp-approval-status"]')).toHaveText("Approved");
		await expect(row.locator('[data-testid="mcp-server-status"]')).toHaveText("connected");
		await expect(row.locator('[data-testid="mcp-server-toggle"]')).toBeFocused();

		await row.locator('[data-testid="mcp-reject-server"]').click();
		await expect(page.getByText("Reject local-project?", { exact: true })).toBeVisible();
		await page.keyboard.press("Enter");
		await expect(row.locator('[data-testid="mcp-approval-status"]')).toHaveText("Rejected");
		await expect(row.locator('[data-testid="mcp-server-status"]')).toHaveText("Not started");
		await expect(row.locator('[data-testid="mcp-server-toggle"]')).toBeFocused();
	});

	test("keeps review open and refreshes metadata after a stale decision", async ({ page }) => {
		await setupMcp(page, [APPROVAL_SERVERS[0]]);
		const changed = structuredClone(APPROVAL_SERVERS[0]);
		changed.approval = { ...changed.approval, state: "changed", fingerprint: "9999999999999999" };
		changed.reviewConfig.args = ["server-v2.js"];
		await page.evaluate((servers) => (window as any).__failNextMcpApproval({
			status: 409,
			code: "MCP_APPROVAL_STALE",
			error: "Definition changed",
			servers,
		}), [changed]);
		const row = page.locator('[data-server-name="local-project"]');
		await row.locator('[data-testid="mcp-approve-server"]').click();
		await expect(row.locator('[data-testid="mcp-approval-error"]')).toHaveText("Configuration changed while you were reviewing it. Review the current configuration before deciding.");
		await expect(row.locator('[data-testid="mcp-server-toggle"]')).toHaveAttribute("aria-expanded", "true");
		await expect(row.locator('[data-testid="mcp-review-panel"]')).toContainText("server-v2.js");
		await expect(row.locator('[data-testid="mcp-review-panel"]')).toContainText("999999999999");
	});

	test("renders zero-tool review rows and uses one-column review metadata at 767px", async ({ page }) => {
		await page.setViewportSize({ width: 767, height: 800 });
		await page.evaluate((servers) => (window as any).__setMcpFixture({ servers, tools: [] }), APPROVAL_SERVERS);
		await page.evaluate(() => (window as any).__loadToolManager());
		const section = page.locator('[data-testid="mcp-section"]');
		await expect(section).toBeVisible();
		await expect(page.getByText("No tools found")).toHaveCount(0);
		const row = section.locator('[data-server-name="local-project"]');
		await row.locator('[data-testid="mcp-server-toggle"]').click();
		await expect(row.getByText("No operations available.")).toBeVisible();
		await expect(row.locator(".mcp-review-grid")).toHaveCSS("grid-template-columns", /\d+(\.\d+)?px/);
		const buttonBox = await row.locator('[data-testid="mcp-approve-server"]').boundingBox();
		expect(buttonBox?.height).toBeGreaterThanOrEqual(44);
	});

	test("does not offer decisions for invalid definitions", async ({ page }) => {
		const invalid = structuredClone(APPROVAL_SERVERS[0]);
		invalid.name = "invalid-project";
		invalid.diagnostics = [{ code: "MCP_CONFIG_INVALID", message: "A supported command or HTTP URL is required." }];
		await setupMcp(page, [invalid]);
		const row = page.locator('[data-server-name="invalid-project"]');
		await expect(row.locator('[data-testid="mcp-approve-server"]')).toHaveCount(0);
		await expect(row.locator('[data-testid="mcp-reject-server"]')).toHaveCount(0);
		await row.locator('[data-testid="mcp-server-toggle"]').click();
		await expect(row.locator('[data-testid="mcp-review-panel"]')).toContainText("MCP_CONFIG_INVALID");
	});

	test("reloads every scoped Tools resource when the project scope changes", async ({ page }) => {
		await page.evaluate((servers) => (window as any).__setMcpFixture({
			servers,
			projects: [{ id: "project-a", name: "Acme Portal", rootPath: "C:/acme" }],
		}), APPROVAL_SERVERS);
		await page.evaluate(() => (window as any).__loadToolManager());
		await page.getByRole("button", { name: "Acme Portal" }).click();
		await expect.poll(async () => (await fetchLog(page)).slice(-4).map((entry) => entry.url)).toEqual([
			`${FIXTURE_GATEWAY_BASE_URL}/api/tools?projectId=project-a`,
			`${FIXTURE_GATEWAY_BASE_URL}/api/roles?projectId=project-a`,
			`${FIXTURE_GATEWAY_BASE_URL}/api/tool-group-policies?projectId=project-a`,
			`${FIXTURE_GATEWAY_BASE_URL}/api/mcp-servers?projectId=project-a&ensure=true`,
		]);
	});
});
