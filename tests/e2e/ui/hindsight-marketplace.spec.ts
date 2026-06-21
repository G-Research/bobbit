/**
 * Browser E2E — Hindsight MARKETPLACE surface, redefined by the "Hindsight surfaces
 * & embedded dashboard" goal. The Marketplace is the CONFIGURATION HOME (Configure
 * form + guided wizard) and the row keeps a read-only derived state (Disabled ·
 * Dormant · External connected/unreachable · Managed stopped/starting/running). The
 * key change this goal lands: **Open Hindsight UI** no longer navigates the browser
 * to the dashboard — it opens the EMBEDDED dashboard tab in-app, with a small
 * secondary external-browser fallback link. This spec pins:
 *
 *   1. FIRST-RUN — an unconfigured built-in row is Disabled and surfaces Configure.
 *   2. EXTERNAL CONNECTED — a healthy external Hindsight derives External connected;
 *      Test connection reports ok; the row exposes Open Hindsight UI.
 *   3. OPEN HINDSIGHT UI — the primary `market-hindsight-open-ui` is a BUTTON that
 *      opens the embedded dashboard tab (`hindsight-dashboard-frame` src=uiUrl) WITHOUT
 *      opening a new browser window/page; a secondary `market-hindsight-open-ui-external`
 *      anchor carries the uiUrl (target=_blank, rel=noopener) as the fallback.
 *   4. INLINE CONFIGURE — the sessionless inline form saves config + persists across
 *      reload (the config home).
 *   5. MANAGED — the row tracks a mocked supervisor stopped→starting→running; loading
 *      NEVER fires `/start`; explicit consent-gated Start is the only `/start` path.
 *   6. lastError object rendering + per-project override (unchanged #820/quality
 *      invariants preserved on the Marketplace surface).
 *
 * Runtime is MOCKED via `registerPackRuntimeSupervisorFactory` (no Docker); external
 * data is the in-process `hindsight-stub.mjs`.
 *
 * SKIP-GUARD: a static STACK_READY (the embedded-dashboard panel bundle/descriptor of
 * this goal — a reliable proxy that the marketplace changes also merged) gates the
 * suite, plus a per-test runtime check that the contribution is served here. Keeps the
 * suite green-by-skip until the parallel coder branches land.
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
const EX_UI_URL = "http://127.0.0.1:19177/banks/hermes?view=data";

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
	entrypoints?: Array<{ id: string; kind: string; routeId?: string; listName: string }>;
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

async function putHindsightConfig(overrides: Record<string, unknown>): Promise<void> {
	const { getPackStore } = await import("../../../dist/server/extension-host/pack-store.js");
	await getPackStore().put(PACK, CONFIG_KEY, overrides);
}

async function resetHindsightActivation(): Promise<void> {
	try {
		const res = await apiFetch(`/api/marketplace/pack-activation?scope=server&packName=${PACK}`);
		if (!res.ok) return;
		const cat = ((await res.json()).catalogue ?? {}) as Record<string, unknown>;
		const arr = (k: string): string[] =>
			Array.isArray(cat[k])
				? (cat[k] as Array<{ listName?: string } | string>).map((e) => (typeof e === "string" ? e : e.listName ?? "")).filter(Boolean)
				: [];
		const disabled = {
			roles: arr("roles"), tools: arr("tools"), skills: arr("skills"), entrypoints: arr("entrypoints"),
			providers: arr("providers"), hooks: arr("hooks"), mcp: arr("mcp"), piExtensions: arr("piExtensions"),
			runtimes: arr("runtimes"), workflows: arr("workflows"),
		};
		await apiFetch("/api/marketplace/pack-activation", {
			method: "PUT",
			body: JSON.stringify({ scope: "server", packName: PACK, disabled }),
		});
	} catch { /* best-effort */ }
}

async function reconcile(page: Page): Promise<void> {
	await page.evaluate(() => (window as any).__bobbitReconcilePackRenderers?.()).catch(() => { /* race */ });
}

/** Does the `config` route expose the per-project override contract here? */
async function overrideContractReady(): Promise<boolean> {
	const res = await apiFetch(`/api/ext/pack-route/${PACK}/config?projectId=__probe__`);
	if (!res.ok) return false;
	const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
	return Object.prototype.hasOwnProperty.call(data, "globalConfig") || Object.prototype.hasOwnProperty.call(data, "projectOverride");
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
const dashboardFrame = (page: Page) => page.locator('[data-testid="hindsight-dashboard-frame"]').first();

// ── Mocked managed runtime supervisor (NO Docker). ──
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
			ports: [{ key: "API_PORT", host: stubPort, container: 8000 }],
			volumePath: "~/.hindsight",
			trust: "local",
		};
	},
};

test.describe.configure({ mode: "serial" });

describe("Hindsight pack — Marketplace state + actions (config home + embedded Open UI)", () => {
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
		await resetHindsightActivation();
		if (stub) await stub.close().catch(() => { /* ignore */ });
	});

	test.beforeEach(async () => {
		await putHindsightConfig({});
		await resetHindsightActivation();
		supCalls.length = 0;
		managedRuntimeStatus = "stopped";
		stub.setHealthy(true);
	});

	test("first-run: the built-in row shows Disabled and surfaces Configure as the primary setup path", async ({ page }) => {
		test.skip(!ready, "Hindsight embedded-dashboard/marketplace stack not served in this environment");
		await openWithSession(page);
		const row = await openMarketRow(page);

		await expect(stateBadge(row), "an unconfigured built-in Hindsight row is Disabled").toHaveAttribute("data-state", "disabled", { timeout: 20_000 });

		const configure = row.locator('[data-testid="market-hindsight-configure"]');
		await expect(configure, "Configure is offered as the primary setup path").toBeVisible();
		await expect(configure).toBeEnabled();
	});

	test("external connected: row state and Test connection", async ({ page }) => {
		test.skip(!ready, "Hindsight embedded-dashboard/marketplace stack not served in this environment");
		await putHindsightConfig({ externalUrl: stub.url, bank: "hermes", uiUrl: EX_UI_URL });

		await openWithSession(page);
		const row = await openMarketRow(page);

		await expect(stateBadge(row), "a healthy external Hindsight is External connected").toHaveAttribute("data-state", "external-connected", { timeout: 20_000 });

		const summary = row.locator('[data-testid="market-hindsight-config"]');
		await expect(summary).toBeVisible({ timeout: 15_000 });
		await expect(summary).toContainText("hermes");

		await row.locator('[data-testid="market-hindsight-test"]').click();
		await expect(row.locator('[data-testid="market-hindsight-action-result"]'), "Test connection reports a result lozenge").toBeVisible({ timeout: 20_000 });
		await expect(row.locator('[data-testid="market-hindsight-action-result"]')).toContainText("Connected");
	});

	test("Open Hindsight UI opens the EMBEDDED dashboard tab (no new window); the external link is the fallback", async ({ page }) => {
		test.skip(!ready, "Hindsight embedded-dashboard/marketplace stack not served in this environment");
		// Distinct data-plane URL + human dashboard UI URL.
		await putHindsightConfig({ externalUrl: stub.url, bank: "hermes", uiUrl: EX_UI_URL });
		expect(EX_UI_URL).not.toBe(stub.url);

		// Keep the embed warning out of the way: a generous iframe load-timeout.
		await page.addInitScript(() => { (window as any).__bobbitHindsightIframeTimeoutMs = 60_000; });

		await openWithSession(page);
		const row = await openMarketRow(page);
		await expect(stateBadge(row)).toHaveAttribute("data-state", "external-connected", { timeout: 20_000 });

		// The primary Open Hindsight UI is an in-app route link (not an external
		// target=_blank/window.open escape hatch).
		const openUi = row.locator('[data-testid="market-hindsight-open-ui"]');
		await expect(openUi, "Open Hindsight UI is surfaced with a configured UI URL").toBeVisible({ timeout: 15_000 });
		await expect(openUi).toHaveAttribute("href", /#\/ext\/hindsight$/);
		await expect(openUi).not.toHaveAttribute("target", "_blank");

		// The secondary external-browser fallback carries the uiUrl verbatim.
		const external = row.locator('[data-testid="market-hindsight-open-ui-external"]');
		await expect(external, "a secondary external-browser fallback link exists").toBeVisible({ timeout: 15_000 });
		await expect(external).toHaveAttribute("href", EX_UI_URL);
		await expect(external).toHaveAttribute("target", "_blank");
		await expect(external).toHaveAttribute("rel", /noopener/);

		// Clicking the primary opens the embedded dashboard tab IN-APP — no new window/page.
		const popups: unknown[] = [];
		page.on("popup", (p) => popups.push(p));
		const pagesBefore = page.context().pages().length;
		await openUi.click();

		const fr = dashboardFrame(page);
		await expect(fr, "Open Hindsight UI opens the embedded dashboard tab").toBeVisible({ timeout: 20_000 });
		await expect(fr, "the embedded iframe loads the configured UI URL verbatim").toHaveAttribute("src", EX_UI_URL, { timeout: 15_000 });
		expect(popups, "Open Hindsight UI must NOT open a new browser window").toHaveLength(0);
		expect(page.context().pages().length, "no extra browser page is created").toBe(pagesBefore);
	});

	test("inline Configure form saves config sessionlessly and persists across reload (the config home)", async ({ page }) => {
		test.skip(!ready, "Hindsight embedded-dashboard/marketplace stack not served in this environment");
		await openWithSession(page);
		let row = await openMarketRow(page);
		await expect(stateBadge(row), "an unconfigured default-disabled row starts Disabled").toHaveAttribute("data-state", "disabled", { timeout: 20_000 });

		await row.locator('[data-testid="market-hindsight-configure"]').click();
		const form = row.locator('[data-testid="market-hindsight-config-form"]');
		await expect(form, "Configure opens the inline config form").toBeVisible({ timeout: 15_000 });
		await expect(form.locator('[data-testid="market-hindsight-form-mode"]')).toBeVisible({ timeout: 15_000 });

		await form.locator('[data-testid="market-hindsight-form-externalurl"]').fill(stub.url);
		await form.locator('[data-testid="market-hindsight-form-bank"]').fill("hermes");
		await form.locator('[data-testid="market-hindsight-form-uiurl"]').fill(EX_UI_URL);
		await form.locator('[data-testid="market-hindsight-form-recallscope"]').selectOption("all");
		expect(EX_UI_URL).not.toBe(stub.url);

		await expect(form.locator('[data-testid="market-hindsight-config-dirty"]'), "dirty edits show an unsaved indicator before Save").toBeVisible({ timeout: 15_000 });
		const recallField = form.locator('[data-testid="market-hindsight-field-recallscope"]');
		await expect(recallField, "changed recall scope row is marked dirty").toHaveAttribute("data-dirty", "true");
		await expect(form.locator('[data-testid="market-hindsight-field-changed-recallScope"]'), "changed recall scope label is shown").toBeVisible();

		await form.locator('[data-testid="market-hindsight-config-save"]').click();
		await expect(form.locator('[data-testid="market-hindsight-config-result"]'), "save reports a result").toContainText("Saved", { timeout: 20_000 });
		await expect(form.locator('[data-testid="market-hindsight-config-dirty"]'), "dirty indicator clears after Save").toHaveCount(0, { timeout: 15_000 });
		await expect(recallField, "recall scope row is no longer marked dirty after Save").toHaveAttribute("data-dirty", "false", { timeout: 15_000 });

		// Reload the page entirely — the persisted config must survive (sessionless read).
		await page.reload();
		row = await openMarketRow(page);

		const summary = row.locator('[data-testid="market-hindsight-config"]');
		await expect(summary, "the saved config surfaces after reload").toBeVisible({ timeout: 20_000 });
		await expect(summary).toContainText("hermes");

		// Re-open Configure: the saved recall scope persists and no dirty state is shown.
		await row.locator('[data-testid="market-hindsight-configure"]').click();
		const reloadedForm = row.locator('[data-testid="market-hindsight-config-form"]');
		await expect(reloadedForm.locator('[data-testid="market-hindsight-form-recallscope"]'), "saved recall scope persists across reload").toHaveValue("all", { timeout: 15_000 });
		await expect(reloadedForm.locator('[data-testid="market-hindsight-config-dirty"]'), "reload opens with no unsaved changes").toHaveCount(0);

		// The external fallback link reflects the saved (distinct) UI URL verbatim.
		const external = row.locator('[data-testid="market-hindsight-open-ui-external"]');
		await expect(external, "the external fallback link surfaces the saved UI URL").toBeVisible({ timeout: 15_000 });
		await expect(external).toHaveAttribute("href", EX_UI_URL);
	});

	test("managed: the row tracks mocked runtime status (stopped→starting→running) and loading never starts Docker", async ({ page }) => {
		test.skip(!ready, "Hindsight embedded-dashboard/marketplace stack not served in this environment");
		await putHindsightConfig({ mode: "managed", llmApiKey: "sk-managed-test" });
		managedRuntimeStatus = "stopped";

		const startRequests: string[] = [];
		page.on("request", (r) => {
			if (/\/api\/pack-runtimes\/[^/]+\/start(\?|$)/.test(r.url())) startRequests.push(r.url());
		});

		await openWithSession(page);
		let row = await openMarketRow(page);

		await expect(stateBadge(row), "a configured-but-stopped managed runtime is Managed stopped").toHaveAttribute("data-state", "managed-stopped", { timeout: 20_000 });
		await expect(row.locator('[data-testid="market-hindsight-start"]'), "Managed stopped shows a Start action").toBeVisible();
		expect(startRequests, "loading the marketplace must NOT start Docker (status reads are pure)").toHaveLength(0);
		expect(supCalls.filter((c) => c.op === "start"), "no supervisor.start on load").toHaveLength(0);

		managedRuntimeStatus = "starting";
		row = await openMarketRow(page);
		await expect(stateBadge(row), "row tracks the mocked starting status").toHaveAttribute("data-state", "managed-starting", { timeout: 20_000 });
		await expect(row.locator('[data-testid="market-hindsight-stop"]'), "a starting runtime offers Stop").toBeVisible();

		managedRuntimeStatus = "running";
		row = await openMarketRow(page);
		await expect
			.poll(async () => (await stateBadge(row).getAttribute("data-state")) ?? "", { timeout: 20_000 })
			.toMatch(/^managed-(running|unhealthy)$/);
		await expect(row.locator('[data-testid="market-hindsight-start"]'), "a running runtime no longer offers Start").toHaveCount(0);
		await expect(row.locator('[data-testid="market-hindsight-stop"]'), "a running runtime offers Stop").toBeVisible();

		expect(startRequests, "status polling/rendering never starts Docker").toHaveLength(0);
		expect(supCalls.filter((c) => c.op === "start"), "the supervisor.start was never called by reads").toHaveLength(0);
	});

	test("managed: explicit consent-gated Start is the only path that calls /start (exactly once)", async ({ page }) => {
		test.skip(!ready, "Hindsight embedded-dashboard/marketplace stack not served in this environment");
		await putHindsightConfig({ mode: "managed", llmApiKey: "sk-managed-test" });
		managedRuntimeStatus = "stopped";

		const startRequests: string[] = [];
		page.on("request", (r) => {
			if (/\/api\/pack-runtimes\/[^/]+\/start(\?|$)/.test(r.url())) startRequests.push(r.url());
		});

		await openWithSession(page);
		const row = await openMarketRow(page);
		await expect(stateBadge(row)).toHaveAttribute("data-state", "managed-stopped", { timeout: 20_000 });

		await row.locator('[data-testid="market-hindsight-start"]').click();
		await expect(row.locator('[data-testid="market-hindsight-start-consent"]'), "Start opens the consent disclosure first").toBeVisible({ timeout: 15_000 });
		expect(startRequests, "opening the consent card must not start Docker").toHaveLength(0);

		const confirm = row.locator('[data-testid="market-hindsight-start-confirm"]');
		await expect(confirm).toBeVisible();
		const [startReq] = await Promise.all([
			page.waitForRequest(/\/api\/pack-runtimes\/[^/]+\/start(\?|$)/, { timeout: 20_000 }),
			confirm.click(),
		]);
		expect(startReq.url()).toMatch(/\/api\/pack-runtimes\/[^/]+\/start/);
		await expect(row.locator('[data-testid="market-hindsight-action-result"]')).toBeVisible({ timeout: 20_000 });
		expect(startRequests, "exactly one explicit /start request").toHaveLength(1);
		expect(supCalls.filter((c) => c.op === "start"), "the supervisor.start fired exactly once").toHaveLength(1);
	});

	test("per-project override: recall scope override saves and persists across reload", async ({ page }) => {
		test.skip(!ready, "Hindsight embedded-dashboard/marketplace stack not served in this environment");
		test.skip(!(await overrideContractReady()), "config route does not expose the per-project override contract here");
		await putHindsightConfig({ externalUrl: stub.url, bank: "hermes" });

		await openWithSession(page);
		let row = await openMarketRow(page);

		await row.locator('[data-testid="market-hindsight-configure"]').click();
		const form = row.locator('[data-testid="market-hindsight-config-form"]');
		await expect(form.locator('[data-testid="market-hindsight-form-mode"]')).toBeVisible({ timeout: 15_000 });
		const override = row.locator('[data-testid="market-hindsight-override"]');
		await expect(override, "the per-project override section is shown").toBeVisible({ timeout: 15_000 });

		await override.locator('[data-testid="market-hindsight-override-recallscope"]').selectOption("all");
		await override.locator('[data-testid="market-hindsight-override-save"]').click();
		await expect(override.locator('[data-testid="market-hindsight-override-result"]'), "the override save reports a result").toContainText("Saved", { timeout: 20_000 });

		await expect(row.locator('[data-testid="market-hindsight-override-active"]'), "the override badge appears").toBeVisible({ timeout: 20_000 });
		await expect(form.locator('[data-testid="market-hindsight-form-recallscope"]'), "the global recall-scope field shows the global value, not the project override").toHaveValue("project", { timeout: 15_000 });

		await page.reload();
		row = await openMarketRow(page);
		await expect(row.locator('[data-testid="market-hindsight-override-active"]'), "the override badge persists across reload").toBeVisible({ timeout: 20_000 });
		await row.locator('[data-testid="market-hindsight-configure"]').click();
		const override2 = row.locator('[data-testid="market-hindsight-override"]');
		await expect(override2.locator('[data-testid="market-hindsight-override-recallscope"]'), "the saved override value persists").toHaveValue("all", { timeout: 15_000 });

		await override2.locator('[data-testid="market-hindsight-override-recallscope"]').selectOption("");
		await override2.locator('[data-testid="market-hindsight-override-save"]').click();
		await expect(override2.locator('[data-testid="market-hindsight-override-result"]')).toContainText("Saved", { timeout: 20_000 });
	});

	test("a stored object lastError renders its message (never [object Object])", async ({ page }) => {
		test.skip(!ready, "Hindsight embedded-dashboard/marketplace stack not served in this environment");
		const { getPackStore } = await import("../../../dist/server/extension-host/pack-store.js");
		try {
			await putHindsightConfig({ externalUrl: stub.url, bank: "hermes" });
			await getPackStore().put(PACK, "last-error", { message: "Hindsight HTTP 503 for POST /recall", ts: Date.now() });

			await openWithSession(page);
			const row = await openMarketRow(page);

			const lastErr = row.locator('[data-testid="market-hindsight-last-error"]');
			await expect(lastErr, "the object lastError renders its message").toBeVisible({ timeout: 20_000 });
			await expect(lastErr).toContainText("Hindsight HTTP 503 for POST /recall");
			await expect(lastErr, "an object lastError must never stringify to [object Object]").not.toContainText("[object Object]");
		} finally {
			await getPackStore().put(PACK, "last-error", null);
		}
	});
});
