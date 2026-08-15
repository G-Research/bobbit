/**
 * Journey: Graph Extension Runtime
 *
 * The code-intelligence pack ships disabled. This journey drives its Marketplace
 * opt-in, verifies the status panel's read-only rebuild/status contract, reloads
 * it, then restores the disabled golden path so server-scope activation cannot
 * leak into another browser worker.
 */
import { test, expect, apiFetch, createSessionViaUI, openApp, navigateToHash } from "../_helpers/journey-fixture.js";

const PACK = "code-intelligence";
const GRAPH_TOOLS = [
	"graph_affected",
	"graph_explain",
	"graph_path",
	"graph_neighbors",
	"graph_query",
	"graph_status",
] as const;

interface Contribution {
	packId: string;
	packName: string;
	panels: Array<{ id: string; title?: string }>;
	routeNames: string[];
	entrypoints: Array<{
		id: string;
		kind: string;
		routeId?: string;
		target?: { panelId?: string };
	}>;
}

async function contributions(): Promise<Contribution[]> {
	const response = await apiFetch("/api/ext/contributions");
	expect(response.ok).toBe(true);
	return (await response.json()).packs as Contribution[];
}

async function graphContribution(): Promise<Contribution | undefined> {
	return (await contributions()).find((pack) => pack.packId === PACK);
}

async function toolNames(): Promise<Set<string>> {
	const response = await apiFetch("/api/tools");
	expect(response.ok).toBe(true);
	return new Set(((await response.json()).tools as Array<{ name: string }>).map((tool) => tool.name));
}

/** Clear the explicit-enable sentinel so the manifest's default-disabled state
 * is authoritative. This is deliberately best-effort in hooks: a failed test
 * must never leave a provider running for later tests on this gateway. */
async function disableGraphPack(): Promise<void> {
	await apiFetch("/api/marketplace/pack-activation", {
		method: "PUT",
		body: JSON.stringify({ scope: "server", packName: PACK, disabled: {} }),
	});
}

async function expectDisabledGoldenPath(): Promise<void> {
	await expect.poll(async () => (await graphContribution()) ? "present" : "absent", { timeout: 15_000 }).toBe("absent");
	await expect.poll(async () => {
		const names = await toolNames();
		return GRAPH_TOOLS.every((name) => !names.has(name)) ? "absent" : "present";
	}, { timeout: 15_000 }).toBe("absent");
}

async function expectEnabledRuntime(): Promise<Contribution> {
	let graph: Contribution | undefined;
	await expect.poll(async () => {
		graph = await graphContribution();
		if (!graph) return "absent";
		const hasStatusPanel = graph.panels.some((panel) => panel.id === "code-intelligence-status");
		const hasRoute = graph.entrypoints.some((entry) => entry.kind === "route" && entry.routeId === "code-intelligence");
		const hasHostRoutes = ["status", "config", "rebuild"].every((route) => graph?.routeNames.includes(route));
		return hasStatusPanel && hasRoute && hasHostRoutes ? "ready" : "partial";
	}, { timeout: 15_000 }).toBe("ready");

	await expect.poll(async () => {
		const names = await toolNames();
		return GRAPH_TOOLS.every((name) => names.has(name)) ? "ready" : "partial";
	}, { timeout: 15_000 }).toBe("ready");

	return graph!;
}

// This journey changes a server-scoped activation override and intentionally
// qualifies its first attempt: a retry could conceal reload reconciliation bugs.
test.describe.configure({ mode: "serial", retries: 0 });

test.beforeEach(async () => {
	await disableGraphPack().catch(() => {});
});

test.afterEach(async () => {
	await disableGraphPack().catch(() => {});
});

test.describe("Journey: Graph Extension Runtime", () => {
	test("disabled → enable/status/rebuild/stale warning → reload → disabled cleanup", async ({ page }) => {
		test.setTimeout(55_000);

		// Default-off is a true golden path: no provider contribution, graph tools,
		// panel, or deep-link route should resolve merely because the pack is built in.
		await expectDisabledGoldenPath();
		await openApp(page);
		await navigateToHash(page, "#/ext/code-intelligence");
		await expect(page.getByTestId("ext-route-unavailable")).toBeVisible({ timeout: 15_000 });
		await expect(page.getByTestId("code-intelligence-status-panel")).toHaveCount(0);

		// The raw Marketplace catalogue still exposes the disabled built-in pack and
		// its master toggle so an operator can explicitly enable it.
		await navigateToHash(page, "#/market");
		const card = page
			.locator(`[data-testid="market-installed-pack"][data-builtin="true"][data-pack-name="${PACK}"]`)
			.first();
		await expect(card).toBeVisible({ timeout: 20_000 });
		const toggle = card.getByTestId(`market-toggle-pack-${PACK}`);
		await expect(toggle).not.toBeChecked();
		const activation = page.waitForResponse((response) =>
			response.url().includes("/api/marketplace/pack-activation")
			&& response.request().method() === "PUT",
		);
		await toggle.click();
		await activation;
		await expect(toggle).toBeChecked();
		await expectEnabledRuntime();

		// Use the declared route to load the actual panel in a selected session.
		// The panel is a host-side status/rebuild surface: it never exposes a graph
		// path, but it always makes freshness and the v1 fan-out limitation explicit.
		const sessionId = await createSessionViaUI(page);
		await navigateToHash(page, "#/ext/code-intelligence");
		const panel = page.getByTestId("code-intelligence-status-panel");
		await expect(panel).toBeVisible({ timeout: 20_000 });
		await expect(panel.getByTestId("code-intelligence-no-cross-repo-warning"))
			.toContainText("v1 has no cross-repo edges");
		await expect(panel.getByTestId("code-intelligence-freshness"))
			.toContainText(/STALE|BASE FALLBACK/i);
		// Real host route envelopes must render; a JSON `{ ok: false }` is surfaced
		// as an alert by the panel rather than being mistaken for an empty status.
		await panel.getByTestId("graph-status-load").click();
		await expect(panel.getByTestId("graph-status-empty")).toBeVisible({ timeout: 15_000 });
		await expect(panel.getByRole("alert")).toHaveCount(0);
		await panel.getByTestId("graph-status-config").click();
		await expect(panel.getByTestId("graph-status-config-value")).toContainText("host-only", { timeout: 15_000 });
		await expect(panel.getByRole("alert")).toHaveCount(0);

		// The direct manual route remains visible, but automatic lifecycle work is
		// explicitly unavailable until EP-8. Clicking it must not claim a queue or
		// detached Graphify worker was started.
		const rebuild = panel.getByTestId("code-intelligence-rebuild");
		await expect(rebuild).toBeEnabled();
		await rebuild.click();
		await expect(panel.getByTestId("code-intelligence-rebuild-status"))
			.toContainText(/unavailable pending EP-8|route-only/i, { timeout: 15_000 });
		await expect(panel.getByTestId("code-intelligence-freshness"))
			.toContainText(/STALE|BASE FALLBACK/i);

		// A pack panel belongs to a session workspace. A reload at the bare `#/ext`
		// route restores the route and activation registry, but has no selected
		// workspace to mount into. Follow the existing extension-host panel journey:
		// restore the actual session first, wait for its reconciliation, then re-enter
		// the preserved deep-link. This is a real user navigation, not an E2E hook or
		// an inflated panel timeout.
		await page.reload({ waitUntil: "domcontentloaded" });
		await expect(page.locator("body[data-shortcuts-ready='1']")).toBeVisible({ timeout: 20_000 });
		await expect.poll(async () => (await graphContribution()) ? "present" : "absent", { timeout: 15_000 }).toBe("present");
		await expect(page).toHaveURL(/#\/ext\/code-intelligence$/);
		await navigateToHash(page, `#/session/${sessionId}`);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });
		await navigateToHash(page, "#/ext/code-intelligence");
		const reloadedPanel = page.getByTestId("code-intelligence-status-panel");
		await expect(reloadedPanel).toBeVisible({ timeout: 15_000 });
		await expect(reloadedPanel.getByTestId("code-intelligence-no-cross-repo-warning"))
			.toContainText("v1 has no cross-repo edges");

		// Disable through the user-facing master toggle, then prove cleanup reaches
		// both runtime registry surfaces and the client deep-link.
		await navigateToHash(page, "#/market");
		const reloadedCard = page
			.locator(`[data-testid="market-installed-pack"][data-builtin="true"][data-pack-name="${PACK}"]`)
			.first();
		const reloadedToggle = reloadedCard.getByTestId(`market-toggle-pack-${PACK}`);
		await expect(reloadedToggle).toBeChecked({ timeout: 15_000 });
		const deactivation = page.waitForResponse((response) =>
			response.url().includes("/api/marketplace/pack-activation")
			&& response.request().method() === "PUT",
		);
		await reloadedToggle.click();
		await deactivation;
		await expect(reloadedToggle).not.toBeChecked();
		await expectDisabledGoldenPath();
		await navigateToHash(page, "#/ext/code-intelligence");
		await expect(page.getByTestId("ext-route-unavailable")).toBeVisible({ timeout: 15_000 });
		await expect(page.getByTestId("code-intelligence-status-panel")).toHaveCount(0);
	});
});
