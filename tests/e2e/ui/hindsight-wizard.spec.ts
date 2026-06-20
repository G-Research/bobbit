/**
 * Browser E2E — Hindsight GUIDED SETUP WIZARD (design extension-platform §11 +
 * the G3.3 deployment-modes wire-up). Sibling of hindsight-marketplace.spec.ts.
 *
 * Clicking Enable on a DISABLED built-in `hindsight` row must NOT flip the pack
 * enabled immediately — it launches a guided wizard (mode → defaults+rationale →
 * test/start with progress → smoke test → finish). Only Finish persists config and
 * enables the pack. This spec pins:
 *
 *   1. EXTERNAL path — Enable opens the wizard (not an immediate enable); pick
 *      External, fill API URL + bank + UI URL, run the Test step (stub status →
 *      connected), Finish → the pack becomes enabled, the row shows external-connected,
 *      and Open Hindsight UI links to the configured (distinct) UI URL.
 *   2. MANAGED path — pick Managed; the wizard requires explicit consent before the
 *      Start; loading the wizard NEVER calls `/api/pack-runtimes/:id/start`, and only
 *      the explicit consent-gated Start calls it exactly once (mocked supervisor).
 *   3. CANCEL — cancelling the wizard leaves the pack disabled and persists no config.
 *
 * Runtime is MOCKED via `registerPackRuntimeSupervisorFactory` (no Docker); external
 * data is the in-process `hindsight-stub.mjs`. The gateway runs in-process in this
 * worker so the supervisor factory + pack-store singleton are shared with the page's
 * REST calls (mirrors hindsight-marketplace.spec.ts).
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
const PANEL_ID = "hindsight.panel";
const PACK_SRC = path.resolve(__dirname, "..", "..", "..", "market-packs", PACK);
const STUB_PATH = path.resolve(__dirname, "..", "hindsight-stub.mjs");
const CONFIG_KEY = "provider-config:memory";
const EX_UI_URL = "http://localhost:19177/banks/bobbit?view=data";

const DEPS_READY =
	fs.existsSync(path.join(PACK_SRC, "lib", "HindsightPanel.js")) &&
	fs.existsSync(path.join(PACK_SRC, "panels", "hindsight-memory.yaml")) &&
	fs.existsSync(STUB_PATH);

const describe = DEPS_READY ? test.describe : test.describe.skip;

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

/** Read / reset the persisted Hindsight config in the shared in-process pack store. */
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

/** Drive the row to DISABLED (the wizard precondition), regardless of whether the
 *  sibling default-disabled server change has merged. The master toggle appears once
 *  the activation catalogue resolves; if the pack is currently enabled, toggle it off. */
async function ensureDisabled(page: Page, row: ReturnType<Page["locator"]>): Promise<void> {
	const toggle = masterToggle(row);
	await expect(toggle, "the master enable toggle resolves once the activation catalogue loads").toBeVisible({ timeout: 20_000 });
	if (await toggle.isChecked()) {
		await toggle.click();
	}
	await expect(stateBadge(row), "the row is disabled before launching the wizard").toHaveAttribute("data-state", "disabled", { timeout: 20_000 });
}

/** Open the wizard by clicking Enable (the master toggle) on a disabled row. */
async function launchWizard(page: Page, row: ReturnType<Page["locator"]>): Promise<ReturnType<Page["locator"]>> {
	await masterToggle(row).click();
	const wizard = row.locator('[data-testid="market-hindsight-wizard"]');
	await expect(wizard, "Enable on a disabled Hindsight row launches the guided wizard").toBeVisible({ timeout: 15_000 });
	return wizard;
}

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

describe.configure({ mode: "serial" });

describe("Hindsight pack — guided setup wizard", () => {
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

	test("external: Enable launches the wizard; configure + Test + Finish enables the pack (external-connected)", async ({ page }) => {
		test.skip(!ready, "Hindsight pack contribution not served in this environment");
		await openWithSession(page);
		let row = await openMarketRow(page);
		await ensureDisabled(page, row);

		// Clicking Enable does NOT immediately flip the pack on (no pack-activation PUT
		// until Finish): the wizard replaces the status strip, and the master toggle stays
		// off until Finish.
		const wizard = await launchWizard(page, row);
		await expect(masterToggle(row), "Enable opens the wizard rather than enabling the pack").not.toBeChecked();

		// Step 1: choose External (it is the default; click it to be explicit) → Next.
		await wizard.locator('[data-testid="market-hindsight-wizard-mode-external"]').click();
		await wizard.locator('[data-testid="market-hindsight-wizard-next"]').click();

		// Step 2: configure with the API/data-plane URL (dialed), bank, and a DISTINCT UI URL.
		await expect(wizard.locator('[data-testid="market-hindsight-wizard-externalurl"]')).toBeVisible({ timeout: 15_000 });
		await wizard.locator('[data-testid="market-hindsight-wizard-externalurl"]').fill(stub.url);
		await wizard.locator('[data-testid="market-hindsight-wizard-bank"]').fill("hermes");
		await wizard.locator('[data-testid="market-hindsight-wizard-uiurl"]').fill(EX_UI_URL);
		expect(EX_UI_URL).not.toBe(stub.url);
		await wizard.locator('[data-testid="market-hindsight-wizard-next"]').click();

		// Step 3: Test connection → connected (persists config first, then probes status).
		await wizard.locator('[data-testid="market-hindsight-wizard-test"]').click();
		await expect(wizard.locator('[data-testid="market-hindsight-wizard-connect-result"]')).toContainText("Connected", { timeout: 20_000 });
		await wizard.locator('[data-testid="market-hindsight-wizard-next"]').click();

		// Step 4: smoke test (best-effort) then Finish → save + enable.
		await wizard.locator('[data-testid="market-hindsight-wizard-smoke"]').click();
		await expect(wizard.locator('[data-testid="market-hindsight-wizard-smoke-result"]')).toBeVisible({ timeout: 20_000 });
		await wizard.locator('[data-testid="market-hindsight-wizard-finish"]').click();

		// The wizard closes; the row derives External connected and the pack is enabled.
		await expect(row.locator('[data-testid="market-hindsight-wizard"]')).toHaveCount(0, { timeout: 20_000 });
		row = await openMarketRow(page);
		await expect(stateBadge(row), "after Finish the row is External connected").toHaveAttribute("data-state", "external-connected", { timeout: 20_000 });
		await expect(masterToggle(row), "the pack is enabled after Finish").toBeChecked();

		// Open Hindsight UI links to the configured (distinct) UI URL verbatim.
		const openUi = row.locator('[data-testid="market-hindsight-open-ui"]');
		await expect(openUi).toBeVisible({ timeout: 15_000 });
		await expect(openUi).toHaveAttribute("href", EX_UI_URL);

		// The persisted config carries the wizard's values.
		const cfg = await getStoredConfig();
		expect(cfg?.externalUrl).toBe(stub.url);
		expect(cfg?.bank).toBe("hermes");
		expect(cfg?.mode).toBe("external");
	});

	test("managed: consent-gated Start is the only path that calls /start (exactly once); loading never starts Docker", async ({ page }) => {
		test.skip(!ready, "Hindsight pack contribution not served in this environment");
		managedRuntimeStatus = "stopped";

		const startRequests: string[] = [];
		page.on("request", (r) => {
			if (/\/api\/pack-runtimes\/[^/]+\/start(\?|$)/.test(r.url())) startRequests.push(r.url());
		});

		await openWithSession(page);
		const row = await openMarketRow(page);
		await ensureDisabled(page, row);
		const wizard = await launchWizard(page, row);

		// Pick Managed → Next → configure (LLM key) → Next.
		await wizard.locator('[data-testid="market-hindsight-wizard-mode-managed"]').click();
		await wizard.locator('[data-testid="market-hindsight-wizard-next"]').click();
		await expect(wizard.locator('[data-testid="market-hindsight-wizard-llmapikey"]')).toBeVisible({ timeout: 15_000 });
		await wizard.locator('[data-testid="market-hindsight-wizard-llmapikey"]').fill("sk-managed-test");
		await wizard.locator('[data-testid="market-hindsight-wizard-next"]').click();

		// Connect step: the Start is consent-gated. Rendering it must NOT start Docker,
		// and the Start button is disabled until consent is ticked.
		const start = wizard.locator('[data-testid="market-hindsight-wizard-start"]');
		await expect(start, "Managed connect step offers an explicit Start").toBeVisible({ timeout: 15_000 });
		await expect(start, "Start is disabled until consent is given").toBeDisabled();
		expect(startRequests, "rendering the wizard must NOT start Docker").toHaveLength(0);
		expect(supCalls.filter((c) => c.op === "start"), "no supervisor.start while loading").toHaveLength(0);

		// Tick consent → Start enabled → click → exactly one /start request + one supervisor call.
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

		// The persisted config reflects the managed mode chosen in the wizard.
		const cfg = await getStoredConfig();
		expect(cfg?.mode).toBe("managed");
	});

	test("cancel leaves the pack disabled and persists no config", async ({ page }) => {
		test.skip(!ready, "Hindsight pack contribution not served in this environment");
		await openWithSession(page);
		const row = await openMarketRow(page);
		await ensureDisabled(page, row);
		const wizard = await launchWizard(page, row);

		// Advance to the configure step and type a URL — but DO NOT run Test/Start/Finish.
		await wizard.locator('[data-testid="market-hindsight-wizard-mode-external"]').click();
		await wizard.locator('[data-testid="market-hindsight-wizard-next"]').click();
		await expect(wizard.locator('[data-testid="market-hindsight-wizard-externalurl"]')).toBeVisible({ timeout: 15_000 });
		await wizard.locator('[data-testid="market-hindsight-wizard-externalurl"]').fill("http://localhost:9999");

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
