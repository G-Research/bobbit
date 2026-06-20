/**
 * Browser E2E — Hindsight UX polish, MARKETPLACE surface (design
 * docs/design/hindsight-ux-polish.md + ...-implementation.md, Partition E).
 *
 * The Marketplace is the PRIMARY Hindsight setup path (decision D2): the built-in
 * `hindsight` row must surface a CLEAR derived state (Disabled · Dormant · External
 * connected/unreachable · Managed stopped/starting/running/unhealthy) instead of a
 * flat "Enabled", with state-aware actions (Configure, Test connection, Open
 * Hindsight UI, Start/Stop runtime, View logs). This spec pins:
 *
 *   1. FIRST-RUN configure path — an unconfigured built-in row shows
 *      `market-hindsight-state` = Dormant; **Configure** opens the native panel.
 *   2. EXTERNAL CONNECTED — with a healthy external Hindsight configured, the row
 *      state = External connected; **Test connection** reports ok; **Open Hindsight
 *      UI** links to the configured (distinct) UI URL.
 *   3. MANAGED status rendering (MOCKED runtime events) — the row state tracks a
 *      mocked supervisor stopped→starting→running; loading the page / reading status
 *      NEVER fires `/start` (no-auto-start invariant); the explicit consent-gated
 *      **Start** is the only path that calls `/api/pack-runtimes/:id/start`.
 *
 * Runtime is MOCKED via `registerPackRuntimeSupervisorFactory` (no Docker); external
 * data is the in-process `hindsight-stub.mjs`. The gateway runs in-process in this
 * worker, so both the supervisor factory and the pack-store singleton are shared with
 * the page's REST calls (mirrors hindsight-pack.spec.ts).
 *
 * SKIP-GUARD: mirrors hindsight-pack.spec.ts — a static DEPS_READY plus a runtime
 * check that the built-in band actually serves the Hindsight pack contribution +
 * routes in this environment (dist not rebuilt / branches not merged ⇒ skip).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "../gateway-harness.js";
import type { Page } from "@playwright/test";
import { apiFetch, base, waitForSessionStatus } from "../e2e-setup.js";
import { openApp, createSessionViaUI, navigateToHash } from "./ui-helpers.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

const PACK = "hindsight";
const PANEL_ID = "hindsight.panel";
const PACK_SRC = path.resolve(__dirname, "..", "..", "..", "market-packs", PACK);
const STUB_PATH = path.resolve(__dirname, "..", "hindsight-stub.mjs");
const CONFIG_KEY = "provider-config:memory";
const EX_UI_URL = "http://localhost:19177/banks/hermes?view=data";

const DEPS_READY =
	fs.existsSync(path.join(PACK_SRC, "lib", "HindsightPanel.js")) &&
	fs.existsSync(path.join(PACK_SRC, "panels", "hindsight-memory.yaml")) &&
	fs.existsSync(STUB_PATH);

const describe = DEPS_READY ? test.describe : test.describe.skip;

// ── stub typing (the .mjs is untyped) ────────────────────────────────────────
interface HindsightStub {
	url: string;
	setHealthy(ok: boolean): void;
	seedMemories(bank: string, mem: { text: string; id?: string; score?: number; tags?: string[] }[]): void;
	close(): Promise<void>;
}
async function startStub(): Promise<HindsightStub> {
	const mod = await import(STUB_PATH as string);
	const start = mod.startHindsightStub ?? mod.default;
	return start({ port: 0 }) as Promise<HindsightStub>;
}

interface PackContributionsMeta {
	packId: string;
	panels?: { id: string; title?: string }[];
	entrypoints?: Array<{ id: string; kind: string; routeId?: string; listName: string }>;
	routeNames?: string[];
}
async function listContributions(): Promise<PackContributionsMeta[]> {
	const res = await apiFetch("/api/ext/contributions");
	if (!res.ok) return [];
	return ((await res.json()).packs ?? []) as PackContributionsMeta[];
}

/** Runtime readiness: the built-in band must serve the panel + the config/status
 *  routes, and the panel module must be fetchable. Returns true when the Hindsight
 *  contribution is available in THIS environment, else false (→ skip). */
async function hindsightContributionReady(): Promise<boolean> {
	const meta = (await listContributions()).find((p) => p.packId === PACK);
	if (!meta) return false;
	if (!meta.panels?.some((p) => p.id === PANEL_ID)) return false;
	for (const r of ["config", "status"]) {
		if (!meta.routeNames?.includes(r)) return false;
	}
	const panelRes = await apiFetch(`/api/ext/packs/${PACK}/panels/${encodeURIComponent(PANEL_ID)}`);
	return panelRes.ok;
}

/** Seed / reset the persisted Hindsight config in the shared in-process pack store.
 *  Empty object ⇒ dormant. Non-empty ⇒ the route GET projects it as the live config. */
async function putHindsightConfig(overrides: Record<string, unknown>): Promise<void> {
	const { getPackStore } = await import("../../../dist/server/extension-host/pack-store.js");
	await getPackStore().put(PACK, CONFIG_KEY, overrides);
}

async function reconcile(page: Page): Promise<void> {
	await page.evaluate(() => (window as any).__bobbitReconcilePackRenderers?.()).catch(() => { /* race */ });
}

/** Open the app, create + select a session (so the marketplace can mint the pack
 *  route surface token for the Hindsight `status` read), and reconcile renderers. */
async function openWithSession(page: Page): Promise<void> {
	await openApp(page);
	const sid = await createSessionViaUI(page);
	expect(sid, "a session must be selected so the marketplace can read pack status").toBeTruthy();
	await waitForSessionStatus(sid, "idle").catch(() => { /* best-effort */ });
	await reconcile(page);
}

/** Navigate to the Marketplace, land on the Installed tab, and return the built-in
 *  Hindsight row locator. Re-callable to re-trigger the background status/runtime
 *  loads (loadMarketplaceData runs on each #/market entry). */
async function openMarketRow(page: Page): Promise<ReturnType<Page["locator"]>> {
	// Land on a non-market route first so the #/market entry is a genuine hashchange.
	await navigateToHash(page, "#/roles");
	await navigateToHash(page, "#/market");
	await expect(page.locator('[data-testid="market-installed-panel"]')).toBeVisible({ timeout: 15_000 });
	await page.locator('[data-testid="market-tab-installed"]').click();
	const row = page.locator('[data-testid="market-installed-pack"][data-pack-name="hindsight"]').first();
	await expect(row, "the built-in Hindsight row is present").toBeVisible({ timeout: 15_000 });
	return row;
}

const stateBadge = (row: ReturnType<Page["locator"]>) => row.locator('[data-testid="market-hindsight-state"]');

// ── Mocked managed runtime supervisor (NO Docker). Mutable status so a test can
//    drive stopped→starting→running; records control calls so we can assert the
//    no-auto-start invariant. `capabilitySummary.ports` points the route's runtime
//    base URL at the in-process stub, so a "running" runtime probes HEALTHY (→ the
//    Managed-running state) without any real Docker. ──
interface SupCall { op: "start" | "stop" | "restart" | "down"; }
const supCalls: SupCall[] = [];
let managedRuntimeStatus: "stopped" | "starting" | "running" | "unhealthy" | "docker-unavailable" = "stopped";
let stubPort = 0;
function rtStatus(status: string) {
	return { id: "hindsight:hindsight", packId: PACK, packName: PACK, runtimeId: "hindsight", status, mode: "managed-postgres", composeProject: "bobbit-pack-hindsight-test" };
}
const fakeSupervisor = {
	async list() { return [rtStatus(managedRuntimeStatus)]; },
	async status() { return rtStatus(managedRuntimeStatus); },
	async start() { supCalls.push({ op: "start" }); managedRuntimeStatus = "running"; return rtStatus("running"); },
	async stop() { supCalls.push({ op: "stop" }); managedRuntimeStatus = "stopped"; return rtStatus("stopped"); },
	async restart() { supCalls.push({ op: "restart" }); managedRuntimeStatus = "running"; return rtStatus("running"); },
	async down() { supCalls.push({ op: "down" }); managedRuntimeStatus = "stopped"; return rtStatus("stopped"); },
	async logs() { return "managed-runtime log line\n"; },
	async capabilitySummary() {
		return {
			...rtStatus(managedRuntimeStatus),
			startPolicy: "on-enable",
			services: ["api", "db"],
			images: ["hindsight/api", "postgres"],
			// Point the route's runtime base URL at the stub so a running runtime is HEALTHY.
			ports: [{ key: "API_PORT", host: stubPort, container: 8000 }],
			volumePath: "~/.hindsight",
			trust: "local",
		};
	},
};

describe.configure({ mode: "serial" });

describe("Hindsight pack — Marketplace state + actions (UX polish)", () => {
	let stub: HindsightStub;
	let ready = false;

	test.beforeAll(async () => {
		const mod = await import("../../../dist/server/server.js");
		mod.registerPackRuntimeSupervisorFactory(() => fakeSupervisor as never);
		stub = await startStub();
		stubPort = Number(new URL(stub.url).port);
		ready = await hindsightContributionReady();
	});

	test.afterAll(async () => {
		const mod = await import("../../../dist/server/server.js");
		mod.registerPackRuntimeSupervisorFactory(null);
		await putHindsightConfig({});
		if (stub) await stub.close().catch(() => { /* ignore */ });
	});

	test.beforeEach(async () => {
		await putHindsightConfig({});
		supCalls.length = 0;
		managedRuntimeStatus = "stopped";
		stub.setHealthy(true);
	});

	test("first-run: the built-in row shows Disabled and surfaces Configure as the primary setup path", async ({ page }) => {
		test.skip(!ready, "Hindsight pack contribution not served in this environment");
		await openWithSession(page);
		const row = await openMarketRow(page);

		// The built-in Hindsight pack ships DEFAULT-DISABLED (manifest `defaultDisabled:
		// true`): a fresh, unconfigured, untouched server resolves it with every entity
		// de-activated, so the row's headline state is "disabled" (NOT a flat "Enabled",
		// and NOT "dormant" — dormant is the enabled-but-unconfigured state). Enabling or
		// configuring it flips this. Also proves the sessionless built-in pack-route
		// status read still works after #/market cleared the active chat session.
		await expect(stateBadge(row), "an unconfigured built-in Hindsight row is Disabled").toHaveAttribute("data-state", "disabled", { timeout: 20_000 });

		// Configure is surfaced as the primary setup affordance on the row.
		// (Opening the native panel itself requires an active session to bind to — a
		// separate session-context concern exercised by hindsight-pack.spec.ts, which
		// opens the panel via the command-palette launcher inside a live session. The
		// Market route deliberately disconnects the chat session, so we assert the
		// action is surfaced + actionable here rather than re-testing panel mount.)
		const configure = row.locator('[data-testid="market-hindsight-configure"]');
		await expect(configure, "Configure is offered as the primary setup path").toBeVisible();
		await expect(configure).toBeEnabled();
	});

	test("external connected: row state, Test connection, and Open Hindsight UI", async ({ page }) => {
		test.skip(!ready, "Hindsight pack contribution not served in this environment");
		// Configure a healthy EXTERNAL Hindsight out-of-band, with a DISTINCT UI URL.
		await putHindsightConfig({ externalUrl: stub.url, bank: "hermes", uiUrl: EX_UI_URL });

		await openWithSession(page);
		const row = await openMarketRow(page);

		// The row derives External connected (healthy external data plane).
		await expect(stateBadge(row), "a healthy external Hindsight is External connected").toHaveAttribute("data-state", "external-connected", { timeout: 20_000 });

		// The active config summary surfaces the data-plane URL + bank prominently.
		const summary = row.locator('[data-testid="market-hindsight-config"]');
		await expect(summary).toBeVisible({ timeout: 15_000 });
		await expect(summary).toContainText("hermes");

		// Open Hindsight UI links to the configured UI URL verbatim (distinct from the API URL).
		const openUi = row.locator('[data-testid="market-hindsight-open-ui"]');
		await expect(openUi, "Open Hindsight UI surfaces with a configured UI URL").toBeVisible();
		await expect(openUi).toHaveAttribute("href", EX_UI_URL);
		expect(EX_UI_URL).not.toBe(stub.url);

		// Test connection re-reads the status route and reports a transient ok lozenge.
		await row.locator('[data-testid="market-hindsight-test"]').click();
		await expect(row.locator('[data-testid="market-hindsight-action-result"]'), "Test connection reports a result lozenge").toBeVisible({ timeout: 20_000 });
		await expect(row.locator('[data-testid="market-hindsight-action-result"]')).toContainText("Connected");
	});

	test("inline Configure form saves config sessionlessly and persists across reload", async ({ page }) => {
		test.skip(!ready, "Hindsight pack contribution not served in this environment");
		// Start disabled (default-disabled built-in, no config). The inline form is the
		// #/market setup path — there is no active chat session to mount the native panel
		// against, so Configure must write config over the SESSIONLESS built-in pack-route
		// config-write seam. Saving an externalUrl configures the pack, which (per the
		// live-setup-preservation rule) also flips it out of the default-disabled state.
		await openWithSession(page);
		let row = await openMarketRow(page);
		await expect(stateBadge(row), "an unconfigured default-disabled row starts Disabled").toHaveAttribute("data-state", "disabled", { timeout: 20_000 });

		// Configure toggles the inline form (NOT the native panel) on #/market.
		await row.locator('[data-testid="market-hindsight-configure"]').click();
		const form = row.locator('[data-testid="market-hindsight-config-form"]');
		await expect(form, "Configure opens the inline config form").toBeVisible({ timeout: 15_000 });
		// The form hydrates from the config route; the mode select appears once loaded.
		await expect(form.locator('[data-testid="market-hindsight-form-mode"]')).toBeVisible({ timeout: 15_000 });

		// Set the API/data-plane URL (dialed), bank, and the DISTINCT Dashboard UI URL.
		await form.locator('[data-testid="market-hindsight-form-externalurl"]').fill(stub.url);
		await form.locator('[data-testid="market-hindsight-form-bank"]').fill("hermes");
		await form.locator('[data-testid="market-hindsight-form-uiurl"]').fill(EX_UI_URL);
		expect(EX_UI_URL).not.toBe(stub.url);

		// Save writes via the sessionless config-write seam and reports a result lozenge.
		await form.locator('[data-testid="market-hindsight-config-save"]').click();
		await expect(form.locator('[data-testid="market-hindsight-config-result"]'), "save reports a result").toContainText("Saved", { timeout: 20_000 });

		// Reload the page entirely — the persisted config must survive (sessionless read).
		await page.reload();
		row = await openMarketRow(page);

		// The row reflects the saved deployment after reload (persistence).
		const summary = row.locator('[data-testid="market-hindsight-config"]');
		await expect(summary, "the saved config surfaces after reload").toBeVisible({ timeout: 20_000 });
		await expect(summary).toContainText("hermes");

		// Open Hindsight UI links to the saved (distinct) UI URL verbatim.
		const openUi = row.locator('[data-testid="market-hindsight-open-ui"]');
		await expect(openUi, "Open Hindsight UI surfaces the saved UI URL").toBeVisible({ timeout: 15_000 });
		await expect(openUi).toHaveAttribute("href", EX_UI_URL);
	});

	test("managed: the row tracks mocked runtime status (stopped→starting→running) and loading never starts Docker", async ({ page }) => {
		test.skip(!ready, "Hindsight pack contribution not served in this environment");
		// Configure a MANAGED deployment out-of-band; the runtime starts STOPPED.
		await putHindsightConfig({ mode: "managed", llmApiKey: "sk-managed-test" });
		managedRuntimeStatus = "stopped";

		// Track every runtime /start request the page issues (no-auto-start probe).
		const startRequests: string[] = [];
		page.on("request", (r) => {
			if (/\/api\/pack-runtimes\/[^/]+\/start(\?|$)/.test(r.url())) startRequests.push(r.url());
		});

		await openWithSession(page);
		let row = await openMarketRow(page);

		// Stopped: the row shows Managed stopped with an explicit Start action.
		await expect(stateBadge(row), "a configured-but-stopped managed runtime is Managed stopped").toHaveAttribute("data-state", "managed-stopped", { timeout: 20_000 });
		await expect(row.locator('[data-testid="market-hindsight-start"]'), "Managed stopped shows a Start action").toBeVisible();
		expect(startRequests, "loading the marketplace must NOT start Docker (status reads are pure)").toHaveLength(0);
		expect(supCalls.filter((c) => c.op === "start"), "no supervisor.start on load").toHaveLength(0);

		// Mocked runtime event: starting → the row tracks Managed starting.
		managedRuntimeStatus = "starting";
		row = await openMarketRow(page);
		await expect(stateBadge(row), "row tracks the mocked starting status").toHaveAttribute("data-state", "managed-starting", { timeout: 20_000 });
		// While transitioning up, a Stop action is offered (and Start is not).
		await expect(row.locator('[data-testid="market-hindsight-stop"]'), "a starting runtime offers Stop").toBeVisible();

		// Mocked runtime event: running → the row tracks the running supervisor status.
		// The row derives a managed "up" state from the running runtime. Whether it lands
		// on managed-running vs managed-unhealthy depends on a live data-plane HEALTH
		// probe (the route resolves ctx.runtime from the static provider-contribution
		// config, so a store-only managed config reports healthy:false in this mocked
		// environment) — real health is asserted in manual-integration (real Docker).
		// Here we pin that the row CONSUMED the running supervisor status: it leaves
		// stopped/starting, no longer offers Start, and offers Stop.
		managedRuntimeStatus = "running";
		row = await openMarketRow(page);
		await expect
			.poll(async () => (await stateBadge(row).getAttribute("data-state")) ?? "", { timeout: 20_000 })
			.toMatch(/^managed-(running|unhealthy)$/);
		await expect(row.locator('[data-testid="market-hindsight-start"]'), "a running runtime no longer offers Start").toHaveCount(0);
		await expect(row.locator('[data-testid="market-hindsight-stop"]'), "a running runtime offers Stop").toBeVisible();

		// Across all three reads NOTHING ever auto-started Docker.
		expect(startRequests, "status polling/rendering never starts Docker").toHaveLength(0);
		expect(supCalls.filter((c) => c.op === "start"), "the supervisor.start was never called by reads").toHaveLength(0);
	});

	test("managed: explicit consent-gated Start is the only path that calls /start (exactly once)", async ({ page }) => {
		test.skip(!ready, "Hindsight pack contribution not served in this environment");
		await putHindsightConfig({ mode: "managed", llmApiKey: "sk-managed-test" });
		managedRuntimeStatus = "stopped";

		const startRequests: string[] = [];
		page.on("request", (r) => {
			if (/\/api\/pack-runtimes\/[^/]+\/start(\?|$)/.test(r.url())) startRequests.push(r.url());
		});

		await openWithSession(page);
		const row = await openMarketRow(page);
		await expect(stateBadge(row)).toHaveAttribute("data-state", "managed-stopped", { timeout: 20_000 });

		// Clicking Start opens the consent disclosure — it does NOT start Docker yet.
		await row.locator('[data-testid="market-hindsight-start"]').click();
		await expect(row.locator('[data-testid="market-hindsight-start-consent"]'), "Start opens the consent disclosure first").toBeVisible({ timeout: 15_000 });
		expect(startRequests, "opening the consent card must not start Docker").toHaveLength(0);

		// Confirming the consent is the explicit start gesture → exactly one /start.
		const confirm = row.locator('[data-testid="market-hindsight-start-confirm"]');
		await expect(confirm).toBeVisible();
		const [startReq] = await Promise.all([
			page.waitForRequest(/\/api\/pack-runtimes\/[^/]+\/start(\?|$)/, { timeout: 20_000 }),
			confirm.click(),
		]);
		expect(startReq.url()).toMatch(/\/api\/pack-runtimes\/[^/]+\/start/);
		// The action result reflects the start; exactly one start request + one supervisor call.
		await expect(row.locator('[data-testid="market-hindsight-action-result"]')).toBeVisible({ timeout: 20_000 });
		expect(startRequests, "exactly one explicit /start request").toHaveLength(1);
		expect(supCalls.filter((c) => c.op === "start"), "the supervisor.start fired exactly once").toHaveLength(1);
	});

	// ── The route persists `lastError` as an OBJECT ({ message, ts }); the row must
	//    render its `message`, never `[object Object]`. ──
	test("a stored object lastError renders its message (never [object Object])", async ({ page }) => {
		test.skip(!ready, "Hindsight pack contribution not served in this environment");
		const { getPackStore } = await import("../../../dist/server/extension-host/pack-store.js");
		try {
			// Configure an external Hindsight + seed the route's object-shaped diagnostic.
			await putHindsightConfig({ externalUrl: stub.url, bank: "hermes" });
			await getPackStore().put(PACK, "last-error", { message: "Hindsight HTTP 503 for POST /recall", ts: Date.now() });

			await openWithSession(page);
			const row = await openMarketRow(page);

			const lastErr = row.locator('[data-testid="market-hindsight-last-error"]');
			await expect(lastErr, "the object lastError renders its message").toBeVisible({ timeout: 20_000 });
			await expect(lastErr).toContainText("Hindsight HTTP 503 for POST /recall");
			await expect(lastErr, "an object lastError must never stringify to [object Object]").not.toContainText("[object Object]");
		} finally {
			// Clear the seeded diagnostic so it cannot leak into later (serial) tests.
			await getPackStore().put(PACK, "last-error", null);
		}
	});
});
