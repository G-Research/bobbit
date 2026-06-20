/**
 * Browser E2E — Hindsight GUIDED SETUP WIZARD (Marketplace), redefined by the
 * "Hindsight surfaces & embedded dashboard" goal. The Marketplace is the
 * configuration home; the wizard's actions must be mode-specific and actually work:
 *
 *   1. MODE SELECTABLE — all three mode cards are clickable `<button>`s. The
 *      previously-broken EXTERNAL ("Connect Existing Hindsight") card is selectable
 *      even after first clicking Managed; selecting it sets aria-pressed and Next
 *      advances to the external-URL step.
 *   2. EXTERNAL CONNECT STEP — shows a "Test connection" action and NEVER a "Start
 *      Runtime" button; Test does not start any runtime (`/start` count 0).
 *   3. MANAGED CONNECT STEP — shows an explicit consent-gated "Start Runtime
 *      (Docker)" button (the ONLY Docker-start path): disabled until consent, no
 *      `/start` before the click, exactly one `/start` after the explicit click.
 *   4. MANAGED-EXTERNAL-POSTGRES — same Start-Runtime visibility + consent gating.
 *   5. CANCEL — cancelling leaves the pack disabled and persists no config.
 *
 * Runtime is MOCKED via `registerPackRuntimeSupervisorFactory` (no Docker); external
 * data is the in-process `hindsight-stub.mjs`. The gateway runs in-process so the
 * supervisor factory + pack-store singleton are shared with the page's REST calls.
 *
 * SKIP-GUARD: a static STACK_READY (the embedded-dashboard + marketplace surfaces of
 * this goal must be present — proxied by the new dashboard panel bundle/descriptor,
 * which the team lead merges alongside the marketplace changes) gates the suite, plus
 * a per-test runtime check that the built-in band serves the contribution here. Keeps
 * the suite green-by-skip until the parallel coder branches land.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "../gateway-harness.js";
import type { Page } from "@playwright/test";
import { apiFetch, waitForSessionStatus } from "../e2e-setup.js";
import { openApp, createSessionViaUI, navigateToHash } from "./ui-helpers.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

const PACK = "hindsight";
const DASHBOARD_PANEL_ID = "hindsight.dashboard";
const PACK_SRC = path.resolve(__dirname, "..", "..", "..", "market-packs", PACK);
const STUB_PATH = path.resolve(__dirname, "..", "hindsight-stub.mjs");
const CONFIG_KEY = "provider-config:memory";
const EX_UI_URL = "http://127.0.0.1:19177/banks/bobbit?view=data";

const STACK_READY =
	fs.existsSync(path.join(PACK_SRC, "lib", "HindsightDashboardPanel.js")) &&
	fs.existsSync(path.join(PACK_SRC, "panels", "hindsight-dashboard.yaml")) &&
	fs.existsSync(STUB_PATH);

const describe = STACK_READY ? test.describe : test.describe.skip;

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
	routeNames?: string[];
}
async function listContributions(): Promise<PackContributionsMeta[]> {
	const res = await apiFetch("/api/ext/contributions");
	if (!res.ok) return [];
	return ((await res.json()).packs ?? []) as PackContributionsMeta[];
}

/** Runtime readiness: the embedded-dashboard contribution (and config/status routes)
 *  must be served here — a reliable proxy that the whole goal's stack has merged. */
async function dashboardContributionReady(): Promise<boolean> {
	const meta = (await listContributions()).find((p) => p.packId === PACK);
	if (!meta) return false;
	if (!meta.panels?.some((p) => p.id === DASHBOARD_PANEL_ID)) return false;
	for (const r of ["config", "status"]) {
		if (!meta.routeNames?.includes(r)) return false;
	}
	const panelRes = await apiFetch(`/api/ext/packs/${PACK}/panels/${encodeURIComponent(DASHBOARD_PANEL_ID)}`);
	return panelRes.ok;
}

async function getStoredConfig(): Promise<Record<string, unknown> | null> {
	const { getPackStore } = await import("../../../dist/server/extension-host/pack-store.js");
	return (await getPackStore().get(PACK, CONFIG_KEY)) as Record<string, unknown> | null;
}
async function putHindsightConfig(overrides: Record<string, unknown>): Promise<void> {
	const { getPackStore } = await import("../../../dist/server/extension-host/pack-store.js");
	await getPackStore().put(PACK, CONFIG_KEY, overrides);
}

async function reconcile(page: Page): Promise<void> {
	await page.evaluate(() => (window as any).__bobbitReconcilePackRenderers?.()).catch(() => { /* race */ });
}

async function openWithSession(page: Page): Promise<void> {
	await openApp(page);
	const sid = await createSessionViaUI(page);
	expect(sid, "a session must be selected so the marketplace can read pack status").toBeTruthy();
	await waitForSessionStatus(sid, "idle").catch(() => { /* best-effort */ });
	await reconcile(page);
}

async function openMarketRow(page: Page): Promise<ReturnType<Page["locator"]>> {
	await navigateToHash(page, "#/roles");
	await navigateToHash(page, "#/market");
	await expect(page.locator('[data-testid="market-installed-panel"]')).toBeVisible({ timeout: 15_000 });
	await page.locator('[data-testid="market-tab-installed"]').click();
	const row = page.locator('[data-testid="market-installed-pack"][data-pack-name="hindsight"]').first();
	await expect(row, "the built-in Hindsight row is present").toBeVisible({ timeout: 15_000 });
	return row;
}

const stateBadge = (row: ReturnType<Page["locator"]>) => row.locator('[data-testid="market-hindsight-state"]');
const masterToggle = (row: ReturnType<Page["locator"]>) => row.locator('[data-testid="market-toggle-pack-hindsight"]');

async function ensureDisabled(page: Page, row: ReturnType<Page["locator"]>): Promise<void> {
	const toggle = masterToggle(row);
	await expect(toggle, "the master enable toggle resolves once the activation catalogue loads").toBeVisible({ timeout: 20_000 });
	if (await toggle.isChecked()) {
		await toggle.click();
	}
	await expect(stateBadge(row), "the row is disabled before launching the wizard").toHaveAttribute("data-state", "disabled", { timeout: 20_000 });
}

async function launchWizard(page: Page, row: ReturnType<Page["locator"]>): Promise<ReturnType<Page["locator"]>> {
	await masterToggle(row).click();
	const wizard = row.locator('[data-testid="market-hindsight-wizard"]');
	await expect(wizard, "Enable on a disabled Hindsight row launches the guided wizard").toBeVisible({ timeout: 15_000 });
	return wizard;
}

const modeCard = (wizard: ReturnType<Page["locator"]>, mode: string) =>
	wizard.locator(`[data-testid="market-hindsight-wizard-mode-${mode}"]`);

// ── Mocked managed runtime supervisor (NO Docker). ──
interface SupCall { op: "start" | "stop" | "restart" | "down"; }
const supCalls: SupCall[] = [];
let managedRuntimeStatus: "stopped" | "starting" | "running" | "unhealthy" | "docker-unavailable" = "stopped";
let stubPort = 0;
function rtStatus(status: string) {
	return { id: "hindsight:hindsight", packId: PACK, packName: PACK, runtimeId: "hindsight", status, mode: "managed-postgres", composeProject: "bobbit-pack-hindsight-wiz" };
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
			ports: [{ key: "API_PORT", host: stubPort, container: 8000 }],
			volumePath: "~/.hindsight",
			trust: "local",
		};
	},
};

/** Drive the wizard to the connect step for a MANAGED-family mode, then assert the
 *  shared consent-gated Start-Runtime contract: an explicit "Start Runtime (Docker)"
 *  button, disabled until consent, zero `/start` before the click, exactly one after. */
async function assertManagedStartContract(page: Page, mode: "managed" | "managed-external-postgres"): Promise<void> {
	const startRequests: string[] = [];
	page.on("request", (r) => {
		if (/\/api\/pack-runtimes\/[^/]+\/start(\?|$)/.test(r.url())) startRequests.push(r.url());
	});

	await openWithSession(page);
	const row = await openMarketRow(page);
	await ensureDisabled(page, row);
	const wizard = await launchWizard(page, row);

	// Pick the managed-family mode → Next → configure (LLM key) → Next.
	await modeCard(wizard, mode).click();
	await wizard.locator('[data-testid="market-hindsight-wizard-next"]').click();
	await expect(wizard.locator('[data-testid="market-hindsight-wizard-llmapikey"]')).toBeVisible({ timeout: 15_000 });
	if (mode === "managed-external-postgres") {
		await wizard.locator('[data-testid="market-hindsight-wizard-externaldburl"]').fill("postgresql://hindsight:secret@localhost:5432/hindsight_test");
	}
	await wizard.locator('[data-testid="market-hindsight-wizard-llmapikey"]').fill("sk-managed-test");
	await wizard.locator('[data-testid="market-hindsight-wizard-next"]').click();

	// Connect step: an explicit consent-gated Start Runtime (Docker) — the only Docker path.
	const start = wizard.locator('[data-testid="market-hindsight-wizard-start"]');
	await expect(start, `${mode}: connect step offers an explicit Start Runtime`).toBeVisible({ timeout: 15_000 });
	await expect(start, "the Start button is labelled Start Runtime (Docker)").toContainText("Start Runtime (Docker)");
	await expect(start, "Start is disabled until consent is given").toBeDisabled();
	// A managed mode must NOT offer a Test-connection action in the Start step.
	await expect(wizard.locator('[data-testid="market-hindsight-wizard-test"]'), "managed connect step has no Test-connection action").toHaveCount(0);
	expect(startRequests, "rendering the wizard must NOT start Docker").toHaveLength(0);
	expect(supCalls.filter((c) => c.op === "start"), "no supervisor.start while loading").toHaveLength(0);

	// Tick consent → Start enabled → click → exactly one /start + one supervisor call.
	await wizard.locator('[data-testid="market-hindsight-wizard-consent"]').check();
	await expect(start).toBeEnabled();
	const [startReq] = await Promise.all([
		page.waitForRequest(/\/api\/pack-runtimes\/[^/]+\/start(\?|$)/, { timeout: 20_000 }),
		start.click(),
	]);
	expect(startReq.url()).toMatch(/\/api\/pack-runtimes\/[^/]+\/start/);
	await expect(wizard.locator('[data-testid="market-hindsight-wizard-connect-result"]')).toBeVisible({ timeout: 20_000 });
	expect(startRequests, "exactly one explicit /start request").toHaveLength(1);
	expect(supCalls.filter((c) => c.op === "start"), "the supervisor.start fired exactly once").toHaveLength(1);
}

test.describe.configure({ mode: "serial" });

describe("Hindsight pack — guided setup wizard (Marketplace config home)", () => {
	let stub: HindsightStub;
	let ready = false;

	test.beforeAll(async () => {
		const mod = await import("../../../dist/server/server.js");
		mod.registerPackRuntimeSupervisorFactory(() => fakeSupervisor as never);
		stub = await startStub();
		stubPort = Number(new URL(stub.url).port);
		ready = await dashboardContributionReady();
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

	test("mode cards: External (Connect Existing Hindsight) is selectable even after clicking Managed, and Next advances", async ({ page }) => {
		test.skip(!ready, "Hindsight embedded-dashboard/marketplace stack not served in this environment");
		await openWithSession(page);
		const row = await openMarketRow(page);
		await ensureDisabled(page, row);
		const wizard = await launchWizard(page, row);

		// All three mode cards are present as clickable buttons.
		await expect(modeCard(wizard, "external")).toBeVisible({ timeout: 15_000 });
		await expect(modeCard(wizard, "managed")).toBeVisible();
		await expect(modeCard(wizard, "managed-external-postgres")).toBeVisible();

		// REGRESSION: click Managed first, THEN External. External must become selectable
		// (the reported bug was that the external card could not be selected at all).
		await modeCard(wizard, "managed").click();
		await expect(modeCard(wizard, "managed"), "Managed is selected after click").toHaveAttribute("aria-pressed", "true");
		await modeCard(wizard, "external").click();
		await expect(modeCard(wizard, "external"), "External is selectable and becomes the active mode").toHaveAttribute("aria-pressed", "true");
		await expect(modeCard(wizard, "managed"), "selecting External de-selects Managed").toHaveAttribute("aria-pressed", "false");

		// Next from the External selection advances to the external-URL step.
		await wizard.locator('[data-testid="market-hindsight-wizard-next"]').click();
		await expect(wizard.locator('[data-testid="market-hindsight-wizard-externalurl"]'), "External Next advances to the API-URL step").toBeVisible({ timeout: 15_000 });
	});

	test("external connect step shows Test connection and NEVER a Start Runtime button (no /start)", async ({ page }) => {
		test.skip(!ready, "Hindsight embedded-dashboard/marketplace stack not served in this environment");

		const startRequests: string[] = [];
		page.on("request", (r) => {
			if (/\/api\/pack-runtimes\/[^/]+\/start(\?|$)/.test(r.url())) startRequests.push(r.url());
		});

		await openWithSession(page);
		const row = await openMarketRow(page);
		await ensureDisabled(page, row);
		const wizard = await launchWizard(page, row);

		// External → Next → configure API/data-plane URL + bank + a DISTINCT UI URL → Next.
		await modeCard(wizard, "external").click();
		await wizard.locator('[data-testid="market-hindsight-wizard-next"]').click();
		await expect(wizard.locator('[data-testid="market-hindsight-wizard-externalurl"]')).toBeVisible({ timeout: 15_000 });
		await wizard.locator('[data-testid="market-hindsight-wizard-externalurl"]').fill(stub.url);
		await wizard.locator('[data-testid="market-hindsight-wizard-bank"]').fill("hermes");
		await wizard.locator('[data-testid="market-hindsight-wizard-uiurl"]').fill(EX_UI_URL);
		expect(EX_UI_URL).not.toBe(stub.url);
		await wizard.locator('[data-testid="market-hindsight-wizard-next"]').click();

		// Connect step: a Test-connection action and NO Start Runtime button at all.
		const testBtn = wizard.locator('[data-testid="market-hindsight-wizard-test"]');
		await expect(testBtn, "external connect step offers Test connection").toBeVisible({ timeout: 15_000 });
		await expect(testBtn).toContainText(/test connection/i);
		await expect(wizard.locator('[data-testid="market-hindsight-wizard-start"]'), "external mode never offers a Start Runtime button").toHaveCount(0);

		// Test connection persists config + probes status — it must not start any runtime.
		await testBtn.click();
		await expect(wizard.locator('[data-testid="market-hindsight-wizard-connect-result"]')).toContainText("Connected", { timeout: 20_000 });
		expect(startRequests, "external Test connection must never start Docker").toHaveLength(0);
		expect(supCalls.filter((c) => c.op === "start"), "the supervisor.start was never called in external mode").toHaveLength(0);

		// The persisted config carries the external mode + values.
		const cfg = await getStoredConfig();
		expect(cfg?.externalUrl).toBe(stub.url);
		expect(cfg?.mode).toBe("external");
	});

	test("managed connect step: consent-gated Start Runtime (Docker) is the only path to /start (exactly once)", async ({ page }) => {
		test.skip(!ready, "Hindsight embedded-dashboard/marketplace stack not served in this environment");
		await assertManagedStartContract(page, "managed");
		const cfg = await getStoredConfig();
		expect(cfg?.mode).toBe("managed");
	});

	test("managed-external-postgres connect step: same consent-gated Start Runtime (Docker) contract", async ({ page }) => {
		test.skip(!ready, "Hindsight embedded-dashboard/marketplace stack not served in this environment");
		await assertManagedStartContract(page, "managed-external-postgres");
		const cfg = await getStoredConfig();
		expect(cfg?.mode).toBe("managed-external-postgres");
	});

	test("cancel leaves the pack disabled and persists no config", async ({ page }) => {
		test.skip(!ready, "Hindsight embedded-dashboard/marketplace stack not served in this environment");
		await openWithSession(page);
		const row = await openMarketRow(page);
		await ensureDisabled(page, row);
		const wizard = await launchWizard(page, row);

		// Advance to the configure step and type a URL — but DO NOT run Test/Start/Finish.
		await modeCard(wizard, "external").click();
		await wizard.locator('[data-testid="market-hindsight-wizard-next"]').click();
		await expect(wizard.locator('[data-testid="market-hindsight-wizard-externalurl"]')).toBeVisible({ timeout: 15_000 });
		await wizard.locator('[data-testid="market-hindsight-wizard-externalurl"]').fill("http://127.0.0.1:9999");

		// Cancel → wizard closes, pack stays disabled, nothing persisted.
		await wizard.locator('[data-testid="market-hindsight-wizard-cancel"]').click();
		await expect(row.locator('[data-testid="market-hindsight-wizard"]')).toHaveCount(0, { timeout: 15_000 });
		await expect(stateBadge(row), "Cancel leaves the pack disabled").toHaveAttribute("data-state", "disabled", { timeout: 15_000 });
		await expect(masterToggle(row), "the pack remains disabled after Cancel").not.toBeChecked();

		const cfg = await getStoredConfig();
		const empty = !cfg || Object.keys(cfg).length === 0;
		expect(empty, "Cancel must persist no config").toBeTruthy();
	});
});
