/**
 * Browser E2E scaffold — Marketplace MCP UI.
 *
 * This is intentionally client-focused: the server-side registry/materialisation
 * implementation lands in sibling tasks, so this spec mocks the Marketplace MCP
 * REST contract and drives the real Market page UI end-to-end.
 */
import type { Page, Route } from "@playwright/test";
import { test, expect } from "../gateway-harness.js";
import { openApp, navigateToHash } from "./ui-helpers.js";

test.describe.configure({ mode: "serial" });

type Source = { id: string; url: string; type?: "pack" | "mcp-registry"; addedAt: string; lastSyncedAt?: string; mcpServerCount?: number };
type Disabled = { roles?: string[]; tools?: string[]; skills?: string[]; entrypoints?: string[]; mcp?: string[] };

const OFFICIAL_REGISTRY_URL = "https://registry.modelcontextprotocol.io/v0/servers";
const SOURCE_ID = "mcp-registry-1";
const INSTALL_ID = "io-modelcontextprotocol-everything-2025-01-01-remote-1-r4f8c2b9a";
const PACK = `mcp-${INSTALL_ID}`;
const MCP_REF = INSTALL_ID;
const RUNTIME_SERVER = "io-modelcontextprotocol-everything-r4f8c2b9a";

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
	await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function installMarketplaceMcpMocks(page: Page): Promise<{ posts: { addSource: unknown[]; activation: unknown[] } }> {
	let sourceAdded = false;
	let installed = false;
	let disabled: Disabled = { mcp: [] };
	const posts = { addSource: [] as unknown[], activation: [] as unknown[] };

	const source = (): Source => ({
		id: SOURCE_ID,
		url: OFFICIAL_REGISTRY_URL,
		type: "mcp-registry",
		addedAt: new Date(0).toISOString(),
		lastSyncedAt: new Date(1000).toISOString(),
		mcpServerCount: 2,
	});
	const browsePack = () => ({
		name: PACK,
		dirName: PACK,
		description: "Everything MCP Server from the official MCP Registry",
		version: "2025.1.1",
		hasTools: false,
		contents: { roles: [], tools: [], skills: [], mcp: [MCP_REF] },
		descriptions: { mcp: { [MCP_REF]: "Official streamable HTTP demo server" } },
		mcp: [{
			ref: MCP_REF,
			serverName: RUNTIME_SERVER,
			label: "Everything MCP Server",
			transport: "http",
			url: "https://mcp.example.test/mcp",
		}],
	});
	const installedPack = () => ({
		scope: "server",
		packName: PACK,
		manifest: browsePack(),
		meta: { sourceUrl: source().url, sourceRef: "", commit: "registry", packName: PACK, version: "2025.1.1", installedAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), scope: "server", sourceKey: "r4f8c2b9a", officialName: "io.modelcontextprotocol/everything" },
		status: "ok",
		updateAvailable: false,
		sourceStatus: "ok",
	});
	const activation = () => ({
		scope: "server",
		packName: PACK,
		catalogue: {
			roles: [],
			tools: [],
			skills: [],
			entrypoints: [],
			mcp: [{ ref: MCP_REF, serverName: RUNTIME_SERVER, label: "Everything MCP Server", transport: "http", status: disabled.mcp?.includes(MCP_REF) ? "disabled" : "active-owner" }],
			descriptions: { mcp: { [MCP_REF]: "Official streamable HTTP demo server" } },
		},
		disabled,
	});

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
	await page.route(new RegExp(`/api/marketplace/sources/${SOURCE_ID}/packs(?:\\?.*)?$`), async (route) => {
		if (route.request().method() !== "GET") return route.fallback();
		return fulfillJson(route, { packs: sourceAdded ? [browsePack()] : [] });
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
		disabled = { mcp: [] };
		return fulfillJson(route, { installed: installedPack() }, 201);
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
		const active = installed && !(disabled.mcp ?? []).includes(MCP_REF);
		return fulfillJson(route, active ? [{ name: RUNTIME_SERVER, status: "connected", toolCount: 12, tools: [] }] : []);
	});
	return { posts };
}

async function goToTab(page: Page, tab: "installed" | "browse" | "sources"): Promise<void> {
	await expect(page.locator(`[data-testid="market-tab-${tab}"]`)).toBeVisible({ timeout: 15_000 });
	await page.locator(`[data-testid="market-tab-${tab}"]`).click();
	await expect(page.locator(`[data-testid="market-${tab}-panel"]`)).toBeVisible({ timeout: 15_000 });
}

test("add registry source, browse/install MCP server, toggle disable/re-enable, persist across reload, uninstall", async ({ page }) => {
	const { posts } = await installMarketplaceMcpMocks(page);
	await openApp(page);
	await navigateToHash(page, "#/market");
	await goToTab(page, "sources");

	await page.locator('[data-testid="market-source-kind-mcp-registry"]').click();
	await expect(page.locator('[data-testid="market-source-ref"]')).toBeDisabled();
	await expect(page.locator('[data-testid="market-source-url"]')).toHaveAttribute("placeholder", OFFICIAL_REGISTRY_URL);
	await expect(page.locator('[data-testid="market-mcp-source-helper"]')).toContainText("servers[].server");
	await expect(page.locator('[data-testid="market-mcp-source-helper"]')).toContainText("skips unsupported transports or packages");
	await page.locator('[data-testid="market-source-url"]').fill(OFFICIAL_REGISTRY_URL);
	await page.locator('[data-testid="market-add-source"]').click();
	await expect.poll(() => posts.addSource.length, { timeout: 10_000 }).toBe(1);
	await expect(JSON.stringify(posts.addSource[0])).toContain('"type":"mcp-registry"');

	await expect(page.locator('[data-testid="market-browse-panel"]')).toBeVisible({ timeout: 15_000 });
	const browseCard = page.locator(`[data-testid="market-browse-pack"][data-pack-name="${PACK}"]`);
	await expect(browseCard).toBeVisible({ timeout: 15_000 });
	await expect(browseCard.locator('[data-kind="mcp"]')).toContainText(`mcp: ${MCP_REF}`);
	await expect(browseCard).toContainText("Everything MCP Server from the official MCP Registry");
	await expect(browseCard.locator('[data-testid="market-mcp-transport"]').first()).toContainText(/HTTP|Endpoint:/i);
	await browseCard.locator('[data-testid="market-install-pack"]').click();

	await goToTab(page, "installed");
	const installedCard = page.locator(`[data-testid="market-installed-pack"][data-pack-name="${PACK}"]`).first();
	await expect(installedCard).toBeVisible({ timeout: 15_000 });
	await expect(installedCard.locator('[data-testid="market-activation-mcp-group"]')).toBeVisible({ timeout: 15_000 });
	const toggle = installedCard.locator(`[data-testid="market-toggle-mcp-${MCP_REF}"]`);
	await expect(toggle).toBeChecked({ timeout: 15_000 });
	await expect(installedCard.locator(`[data-testid="market-mcp-status-${MCP_REF}"]`)).toContainText("Connected", { timeout: 15_000 });

	await toggle.uncheck();
	await expect(toggle).not.toBeChecked();
	await expect(installedCard.locator(`[data-testid="market-mcp-status-${MCP_REF}"]`)).toContainText("Disabled", { timeout: 15_000 });
	await expect.poll(async () => page.evaluate(() => fetch("/api/mcp-servers").then((r) => r.json()).then((rows) => rows.length)), { timeout: 10_000 }).toBe(0);

	await page.reload();
	await expect(page.locator("button").filter({ hasText: "Settings" }).first()).toBeVisible({ timeout: 20_000 });
	await navigateToHash(page, "#/market");
	await goToTab(page, "installed");
	const toggleAfterReload = page.locator(`[data-testid="market-toggle-mcp-${MCP_REF}"]`);
	await expect(toggleAfterReload).toBeVisible({ timeout: 15_000 });
	await expect(toggleAfterReload).not.toBeChecked();

	await toggleAfterReload.check();
	await expect(toggleAfterReload).toBeChecked();
	await expect(page.locator(`[data-testid="market-mcp-status-${MCP_REF}"]`)).toContainText("Connected", { timeout: 15_000 });

	await page.locator(`[data-testid="market-installed-pack"][data-pack-name="${PACK}"]`).first().locator('[data-testid="market-uninstall-pack"]').click();
	await expect(page.getByText(/disconnects its MCP server/i)).toBeVisible({ timeout: 10_000 });
	await page.keyboard.press("Enter");
	await expect(page.locator(`[data-testid="market-installed-pack"][data-pack-name="${PACK}"]`)).toHaveCount(0, { timeout: 15_000 });
});
