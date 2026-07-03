/**
 * Browser E2E scaffold — Marketplace MCP Gateway UI.
 *
 * This is intentionally client-focused: the server-side gateway catalogue /
 * materialisation implementation lands in sibling tasks, so this spec mocks the
 * Marketplace MCP REST contract and drives the real Market page UI end-to-end.
 */
import type { Page, Route } from "@playwright/test";
import { test, expect } from "../gateway-harness.js";
import { openApp, navigateToHash } from "./ui-helpers.js";

test.describe.configure({ mode: "serial" });

type Source = { id: string; url: string; displayName?: string; normalizedName?: string; type?: "pack" | "mcp-gateway"; addedAt: string; lastSyncedAt?: string; mcpProviderCount?: number };
type Disabled = { roles?: string[]; tools?: string[]; skills?: string[]; entrypoints?: string[]; mcp?: string[]; mcpOperations?: Record<string, string[]> };

type Provider = { id: string; label: string; description: string; ops: Array<{ op: string; description: string }> };

const GATEWAY_URL = "http://mcp-local.t3.zone/readonly/mcp";
const SOURCE_ID = "mcp-gateway-1";
const JIRA_REF = "jira";
const JIRA_PACK = `mcp-jira-${SOURCE_ID}`;
const RUNTIME_SERVER = "gr";

const PROVIDERS: Provider[] = [
	{ id: "confluence", label: "Confluence", description: "Confluence pages and spaces", ops: [{ op: "confluence_search", description: "Search Confluence" }] },
	{ id: "jira", label: "Jira", description: "Jira issue tools", ops: [{ op: "jira_search", description: "Search Jira issues" }, { op: "jira_get_issue", description: "Read a Jira issue" }] },
	{ id: "jira-readonly", label: "Jira readonly", description: "Read-only Jira issue tools", ops: [{ op: "jira_search", description: "Search Jira issues read-only" }] },
];

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
	await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

function providerPack(provider: Provider) {
	const source = { id: SOURCE_ID, name: "mcp-local.t3.zone/readonly/mcp", type: "mcp-gateway" };
	const packName = `mcp-${provider.id}-${SOURCE_ID}`;
	return {
		name: packName,
		dirName: packName,
		description: provider.description,
		version: "2025.1.1",
		hasTools: false,
		virtual: true,
		sourceType: "mcp-gateway",
		gatewayProviderId: provider.id,
		browseKey: `${SOURCE_ID}:${packName}`,
		source,
		contents: { roles: [], tools: [], skills: [], entrypoints: [], mcp: [provider.id] },
		descriptions: { mcp: { [provider.id]: provider.description } },
		mcp: [{
			ref: provider.id,
			listName: provider.id,
			serverName: RUNTIME_SERVER,
			subNamespace: provider.id,
			label: provider.label,
			description: provider.description,
			transport: "http",
			url: GATEWAY_URL,
			operations: provider.ops.map((op) => ({ name: op.op, description: op.description, policyKey: `mcp__${RUNTIME_SERVER}__${provider.id}__${op.op}` })),
		}],
	};
}

async function installMarketplaceMcpMocks(page: Page): Promise<{ posts: { addSource: unknown[]; activation: unknown[]; syncSource: unknown[]; removeSource: unknown[] } }> {
	let sourceAdded = false;
	let installed = false;
	let disabled: Disabled = { mcp: [], mcpOperations: { [JIRA_REF]: ["retired_op"] } };
	const posts = { addSource: [] as unknown[], activation: [] as unknown[], syncSource: [] as unknown[], removeSource: [] as unknown[] };

	const source = (): Source => ({
		id: SOURCE_ID,
		url: GATEWAY_URL,
		displayName: "mcp-local.t3.zone/readonly/mcp",
		normalizedName: "mcp-local.t3.zone/readonly/mcp",
		type: "mcp-gateway",
		addedAt: new Date(0).toISOString(),
		lastSyncedAt: new Date(1000).toISOString(),
		mcpProviderCount: PROVIDERS.length,
	});
	const jiraProvider = () => PROVIDERS.find((p) => p.id === JIRA_REF)!;
	const browsePack = () => providerPack(jiraProvider());
	const installedPack = () => ({
		scope: "server",
		packName: JIRA_PACK,
		manifest: browsePack(),
		meta: { sourceUrl: source().url, sourceRef: "", commit: "gateway", packName: JIRA_PACK, version: "2025.1.1", installedAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), scope: "server", sourceKey: "gateway-1", gatewayProviderId: JIRA_REF },
		status: "ok",
		updateAvailable: false,
		sourceStatus: "ok",
	});
	const activation = () => ({
		scope: "server",
		packName: JIRA_PACK,
		catalogue: {
			roles: [],
			tools: [],
			skills: [],
			entrypoints: [],
			mcp: [{
				ref: JIRA_REF,
				contributionId: JIRA_REF,
				listName: JIRA_REF,
				serverName: RUNTIME_SERVER,
				subNamespace: JIRA_REF,
				label: "Jira",
				transport: "http",
				status: disabled.mcp?.includes(JIRA_REF) ? "disabled" : "active-owner",
				totalOperationCount: jiraProvider().ops.length,
				selectedOperationCount: jiraProvider().ops.filter((op) => !(disabled.mcpOperations?.[JIRA_REF] ?? []).includes(op.op)).length,
				operations: jiraProvider().ops.map((op) => ({
					name: op.op,
					description: op.description,
					policyKey: `mcp__${RUNTIME_SERVER}__${JIRA_REF}__${op.op}`,
					selected: !(disabled.mcpOperations?.[JIRA_REF] ?? []).includes(op.op),
					disabledByActivation: (disabled.mcpOperations?.[JIRA_REF] ?? []).includes(op.op),
				})),
				disabledOperations: disabled.mcpOperations?.[JIRA_REF] ?? [],
				staleDisabledOperations: (disabled.mcpOperations?.[JIRA_REF] ?? []).filter((op) => !jiraProvider().ops.some((candidate) => candidate.op === op)),
			}],
			descriptions: { mcp: { [JIRA_REF]: "Jira issue tools" } },
		},
		disabled,
	});
	const mcpServers = () => {
		const active = installed && !(disabled.mcp ?? []).includes(JIRA_REF);
		return [{
			name: RUNTIME_SERVER,
			status: "connected",
			activeSubNamespaces: active ? [JIRA_REF] : [],
			toolCount: active ? jiraProvider().ops.length : 0,
			tools: active ? jiraProvider().ops.map((op) => ({
				name: `mcp__${RUNTIME_SERVER}__${JIRA_REF}__${op.op}`,
				description: op.description,
				subNamespace: JIRA_REF,
				op: op.op,
			})) : [],
		}];
	};
	const toolList = () => ({ tools: mcpServers()[0].tools.map((op) => ({ name: op.name, description: op.description, group: `MCP: ${RUNTIME_SERVER}` })) });

	await page.route(/\/api\/marketplace\/sources(?:\?.*)?$/, async (route) => {
		const req = route.request();
		if (req.method() === "GET") return fulfillJson(route, { sources: sourceAdded ? [source()] : [] });
		if (req.method() === "POST") {
			const body = req.postDataJSON();
			posts.addSource.push(body);
			sourceAdded = true;
			return fulfillJson(route, { source: source() }, 201);
		}
		return route.fallback();
	});
	await page.route(new RegExp(`/api/marketplace/sources/${SOURCE_ID}/sync(?:\\?.*)?$`), async (route) => {
		if (route.request().method() !== "POST") return route.fallback();
		posts.syncSource.push({ id: SOURCE_ID });
		return fulfillJson(route, { source: source() });
	});
	await page.route(new RegExp(`/api/marketplace/sources/${SOURCE_ID}(?:\\?.*)?$`), async (route) => {
		if (route.request().method() !== "DELETE") return route.fallback();
		posts.removeSource.push({ id: SOURCE_ID });
		sourceAdded = false;
		return route.fulfill({ status: 204 });
	});
	await page.route(/\/api\/marketplace\/browse(?:\?.*)?$/, async (route) => {
		if (route.request().method() !== "GET") return route.fallback();
		return fulfillJson(route, {
			sources: sourceAdded ? [{ sourceId: SOURCE_ID, sourceName: source().displayName!, sourceType: "mcp-gateway", status: "ok", lastSyncedAt: source().lastSyncedAt }] : [],
			packs: sourceAdded ? PROVIDERS.map(providerPack) : [],
		});
	});
	await page.route(new RegExp(`/api/marketplace/sources/${SOURCE_ID}/packs(?:\\?.*)?$`), async (route) => {
		if (route.request().method() !== "GET") return route.fallback();
		return fulfillJson(route, { packs: sourceAdded ? PROVIDERS.map(providerPack) : [] });
	});
	await page.route(/\/api\/marketplace\/installed(?:\?.*)?$/, async (route) => {
		const req = route.request();
		if (req.method() === "GET") return fulfillJson(route, { installed: installed ? [installedPack()] : [] });
		if (req.method() === "DELETE") { installed = false; disabled = { mcp: [] }; return route.fulfill({ status: 204 }); }
		return route.fallback();
	});
	await page.route(/\/api\/marketplace\/install(?:\?.*)?$/, async (route) => {
		if (route.request().method() !== "POST") return route.fallback();
		installed = true;
		disabled = { mcp: [], mcpOperations: { [JIRA_REF]: ["retired_op"] } };
		return fulfillJson(route, { installed: installedPack() }, 201);
	});
	await page.route(/\/api\/marketplace\/pack-activation\/mcp-operation(?:\?.*)?$/, async (route) => {
		const req = route.request();
		if (req.method() !== "PATCH") return route.fallback();
		const body = req.postDataJSON();
		posts.activation.push(body);
		const current = new Set(disabled.mcpOperations?.[body.contributionId] ?? []);
		if (body.disabled) current.add(body.operationName);
		else current.delete(body.operationName);
		disabled = { ...disabled, mcpOperations: { ...(disabled.mcpOperations ?? {}), [body.contributionId]: [...current] } };
		return fulfillJson(route, activation());
	});
	await page.route(/\/api\/marketplace\/pack-activation(?:\?.*)?$/, async (route) => {
		const req = route.request();
		if (req.method() === "GET") return fulfillJson(route, activation());
		if (req.method() === "PUT") {
			const body = req.postDataJSON();
			posts.activation.push(body);
			disabled = body.disabled ?? {};
			return fulfillJson(route, activation());
		}
		return route.fallback();
	});
	await page.route(/\/api\/(?:packs\/conflicts|ext\/contributions)(?:\?.*)?$/, async (route) => fulfillJson(route, route.request().url().includes("packs/conflicts") ? { conflicts: [] } : { packs: [] }));
	await page.route(/\/api\/mcp-servers(?:\?.*)?$/, async (route) => {
		if (route.request().method() !== "GET") return route.fallback();
		return fulfillJson(route, mcpServers());
	});
	await page.route(/\/api\/tools(?:\?.*)?$/, async (route) => {
		if (route.request().method() !== "GET") return route.fallback();
		return fulfillJson(route, toolList());
	});
	await page.route(/\/api\/roles(?:\?.*)?$/, async (route) => {
		if (route.request().method() !== "GET") return route.fallback();
		return fulfillJson(route, { roles: [] });
	});
	await page.route(/\/api\/tool-group-policies(?:\?.*)?$/, async (route) => {
		if (route.request().method() !== "GET") return route.fallback();
		return fulfillJson(route, {});
	});
	return { posts };
}

async function goToTab(page: Page, tab: "installed" | "browse" | "sources"): Promise<void> {
	await expect(page.locator(`[data-testid="market-tab-${tab}"]`)).toBeVisible({ timeout: 15_000 });
	await page.locator(`[data-testid="market-tab-${tab}"]`).click();
	await expect(page.locator(`[data-testid="market-${tab}-panel"]`)).toBeVisible({ timeout: 15_000 });
}

test("add gateway source, browse/install provider pack, toggle disable/re-enable, persist across reload, show Tools hierarchy, uninstall", async ({ page }) => {
	const { posts } = await installMarketplaceMcpMocks(page);
	await openApp(page);
	await navigateToHash(page, "#/market");
	await goToTab(page, "sources");

	await page.locator('[data-testid="market-source-kind-mcp-gateway"]').click();
	await expect(page.locator('[data-testid="market-source-ref"]')).toHaveCount(0);
	await expect(page.locator('[data-testid="market-source-url"]')).toHaveAttribute("placeholder", GATEWAY_URL);
	await expect(page.locator('[data-testid="market-mcp-source-helper"]')).toContainText("discovers providers");
	await expect(page.locator('[data-testid="market-mcp-source-helper"]')).toContainText("one provider pack per namespace");
	await page.locator('[data-testid="market-source-url"]').fill(GATEWAY_URL);
	await page.locator('[data-testid="market-add-source"]').click();
	await expect.poll(() => posts.addSource.length, { timeout: 10_000 }).toBe(1);
	await expect(posts.addSource[0]).toMatchObject({ url: GATEWAY_URL, type: "mcp-gateway" });
	await expect(JSON.stringify(posts.addSource[0])).not.toContain('"ref"');
	await expect(page.locator('[data-testid="market-sources-panel"]')).toBeVisible({ timeout: 15_000 });
	let sourceRow = page.locator('[data-testid="market-source-row"]').filter({ hasText: "mcp-local.t3.zone/readonly/mcp" });
	await expect(sourceRow).toBeVisible({ timeout: 15_000 });
	await expect(sourceRow.locator('[data-testid="market-browse-source"]')).toHaveCount(0);
	await sourceRow.locator('[data-testid="market-sync-source"]').click();
	await expect.poll(() => posts.syncSource.length, { timeout: 10_000 }).toBe(1);
	await expect(page.locator('[data-testid="market-sources-panel"]')).toBeVisible({ timeout: 15_000 });

	await goToTab(page, "browse");
	const sourceMenuTrigger = page.locator('[data-testid="market-source-menu-trigger"]');
	await expect(sourceMenuTrigger).toBeVisible({ timeout: 15_000 });
	await expect(sourceMenuTrigger).toHaveAttribute("aria-haspopup", "dialog");
	await expect(page.locator('[data-testid="market-source-summary"]')).toContainText("Showing 3 packages from 1 source");
	await sourceMenuTrigger.click();
	await expect(sourceMenuTrigger).toHaveAttribute("aria-expanded", "true");
	await expect(page.locator('[data-testid="market-source-menu"]')).toBeVisible({ timeout: 15_000 });
	const sourceOption = page.locator('[data-testid="market-source-option"]').filter({ hasText: "mcp-local.t3.zone/readonly/mcp" });
	await expect(sourceOption).toBeVisible({ timeout: 15_000 });
	await expect(sourceOption.locator('[data-testid="market-source-count"]')).toContainText("3 packages");
	const sourceCheckbox = sourceOption.locator('[data-testid="market-source-checkbox"]');
	await expect(sourceCheckbox).toBeChecked();
	await page.locator('[data-testid="market-source-clear"]').click();
	await expect(page.locator('[data-testid="market-source-menu"]')).toBeVisible();
	await expect(page.locator('[data-testid="market-source-summary"]')).toContainText("No sources selected");
	await expect(page.locator('[data-testid="market-browse-pack"]')).toHaveCount(0);
	await sourceCheckbox.click();
	await expect(sourceCheckbox).toBeChecked();
	for (const provider of PROVIDERS) {
		await expect(page.locator(`[data-testid="market-browse-pack"][data-pack-name="mcp-${provider.id}-${SOURCE_ID}"]`), provider.label).toBeVisible({ timeout: 15_000 });
	}
	const browseCard = page.locator(`[data-testid="market-browse-pack"][data-pack-name="${JIRA_PACK}"]`);
	await expect(browseCard.locator('[data-kind="mcp"]')).toContainText(`mcp: ${JIRA_REF}`);
	await expect(browseCard).toContainText("Jira issue tools");
	await expect(browseCard.locator('[data-testid="market-mcp-transport"]')).toContainText("HTTP");
	await expect(browseCard.locator('[data-testid="market-mcp-transport"]')).toContainText(GATEWAY_URL);
	await browseCard.locator('[data-testid="market-install-pack"]').click();

	await goToTab(page, "sources");
	sourceRow = page.locator('[data-testid="market-source-row"]').filter({ hasText: "mcp-local.t3.zone/readonly/mcp" });
	await expect(sourceRow.locator('[data-testid="market-source-type-chip"]')).toHaveText("MCP gateway");
	await expect(sourceRow).toContainText(`Gateway URL: ${GATEWAY_URL}`);
	await expect(sourceRow).toContainText("3 providers discovered");

	await goToTab(page, "installed");
	const installedCard = page.locator(`[data-testid="market-installed-pack"][data-pack-name="${JIRA_PACK}"]`).first();
	await expect(installedCard).toBeVisible({ timeout: 15_000 });
	await expect(installedCard.locator('[data-testid="market-activation-mcp-group"]')).toBeVisible({ timeout: 15_000 });
	const toggle = installedCard.locator(`[data-testid="market-toggle-mcp-${JIRA_REF}"]`);
	await expect(toggle).toBeChecked({ timeout: 15_000 });
	await expect(installedCard.locator(`[data-testid="market-mcp-status-${JIRA_REF}"]`)).toContainText("Connected", { timeout: 15_000 });
	await expect(installedCard.locator('[data-testid="market-operation-row-retired_op"]')).toHaveCount(1, { timeout: 15_000 });
	await expect(installedCard.locator('[data-testid="market-toggle-operation-jira_search"]')).toBeChecked({ timeout: 15_000 });
	await installedCard.locator('[data-testid="market-toggle-operation-jira_search"]').click();
	await expect.poll(() => posts.activation.some((body) => JSON.stringify(body).includes('"operationName":"jira_search"') && JSON.stringify(body).includes('"disabled":true')), { timeout: 10_000 }).toBe(true);
	await expect(installedCard.locator('[data-testid="market-toggle-operation-jira_search"]')).not.toBeChecked({ timeout: 15_000 });
	await installedCard.locator('[data-testid="market-toggle-operation-jira_search"]').click();
	await expect(installedCard.locator('[data-testid="market-toggle-operation-jira_search"]')).toBeChecked({ timeout: 15_000 });

	await navigateToHash(page, "#/tools");
	const serverRow = page.locator('[data-testid="mcp-server-row"][data-server-name="gr"]');
	await expect(serverRow).toBeVisible({ timeout: 15_000 });
	await expect(serverRow.locator('[data-testid="mcp-server-status"]')).toContainText("connected");
	await serverRow.locator('[data-testid="mcp-server-toggle"]').click();
	const providerRow = serverRow.locator('[data-testid="mcp-tool-row"][data-tool-name="jira"]');
	await expect(providerRow).toBeVisible({ timeout: 15_000 });
	await expect(providerRow).toContainText("2 operations");
	await providerRow.locator('[data-testid="mcp-tool-toggle"]').click();
	await expect(serverRow.locator('[data-testid="mcp-server-ops"]')).toContainText("jira_search", { timeout: 10_000 });

	await navigateToHash(page, "#/market");
	await goToTab(page, "installed");
	const toggleAgain = page.locator(`[data-testid="market-toggle-mcp-${JIRA_REF}"]`);
	await toggleAgain.uncheck();
	await expect(toggleAgain).not.toBeChecked();
	await expect(page.locator(`[data-testid="market-mcp-status-${JIRA_REF}"]`)).toContainText("Disabled", { timeout: 15_000 });
	await expect.poll(async () => page.evaluate(() => fetch("/api/mcp-servers").then((r) => r.json()).then((rows) => rows[0]?.activeSubNamespaces ?? [])), { timeout: 10_000 }).toEqual([]);

	await page.reload();
	await expect(page.locator("button").filter({ hasText: "Settings" }).first()).toBeVisible({ timeout: 20_000 });
	await navigateToHash(page, "#/market");
	await goToTab(page, "installed");
	const toggleAfterReload = page.locator(`[data-testid="market-toggle-mcp-${JIRA_REF}"]`);
	await expect(toggleAfterReload).toBeVisible({ timeout: 15_000 });
	await expect(toggleAfterReload).not.toBeChecked();

	await toggleAfterReload.check();
	await expect(toggleAfterReload).toBeChecked();
	await expect(page.locator(`[data-testid="market-mcp-status-${JIRA_REF}"]`)).toContainText("Connected", { timeout: 15_000 });

	await page.locator(`[data-testid="market-installed-pack"][data-pack-name="${JIRA_PACK}"]`).first().locator('[data-testid="market-uninstall-pack"]').click();
	await expect(page.getByText(/disconnects its MCP server/i)).toBeVisible({ timeout: 10_000 });
	await page.keyboard.press("Enter");
	await expect(page.locator(`[data-testid="market-installed-pack"][data-pack-name="${JIRA_PACK}"]`)).toHaveCount(0, { timeout: 15_000 });

	await goToTab(page, "sources");
	sourceRow = page.locator('[data-testid="market-source-row"]').filter({ hasText: "mcp-local.t3.zone/readonly/mcp" });
	await expect(sourceRow).toBeVisible({ timeout: 15_000 });
	await sourceRow.locator('[data-testid="market-remove-source"]').click();
	await expect(page.getByText(/Remove this marketplace source/i)).toBeVisible({ timeout: 10_000 });
	await page.keyboard.press("Enter");
	await expect.poll(() => posts.removeSource.length, { timeout: 10_000 }).toBe(1);
	await expect(page.locator('[data-testid="market-sources-panel"]')).toBeVisible({ timeout: 15_000 });
	await expect(sourceRow).toHaveCount(0);
});
