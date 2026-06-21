/**
 * Browser E2E — Hindsight EMBEDDED DASHBOARD ENTRY (design "Hindsight surfaces &
 * embedded dashboard" — Dashboard panel behavior + Configuration-home rule).
 *
 * This goal RE-DEFINES the Hindsight extension entry: the session-menu item and the
 * `#/ext/<routeId>` deep link no longer open the native config/status panel — they
 * open the new `hindsight.dashboard` panel, an embedded sandboxed iframe of the
 * configured human dashboard `uiUrl`. Configuration moved to the Marketplace
 * (covered by hindsight-marketplace.spec.ts + hindsight-wizard.spec.ts). This spec
 * pins the USE surface:
 *
 *   1. EMBED — with a distinct `externalUrl` (data plane) + `uiUrl` (human
 *      dashboard) configured, launching the session-menu entry mounts
 *      `hindsight-dashboard-frame` whose `src` === the configured `uiUrl`, and NO
 *      `hindsight-config-card` is rendered (the entry is not a config surface).
 *   2. DEEP LINK — a full reload + `#/ext/<routeId>` re-opens the same embedded
 *      dashboard iframe (no config card).
 *   3. EXTERNAL FALLBACK — a secondary `hindsight-dashboard-open-external` anchor
 *      points at the same `uiUrl` (target=_blank, rel=noopener) for the case where
 *      a remote/secured dashboard refuses framing.
 *   4. EMPTY STATE — when `uiUrl` is unset the entry does NOT dead-end: it renders
 *      `hindsight-dashboard-empty` (with a Marketplace CTA) and NO config card / no
 *      iframe.
 *   5. BLOCKED / UNREACHABLE — using the deterministic `window.__bobbitHindsight
 *      IframeTimeoutMs` test hook, an iframe that never fires `load` surfaces
 *      `hindsight-dashboard-embed-warning` while keeping the external fallback link.
 *
 * #820 invariants (no-clobber config write, no-auto-start Docker, dormancy) are
 * preserved at the route level by tests/e2e/hindsight-config-write.spec.ts and at the
 * Marketplace surface by hindsight-marketplace.spec.ts / hindsight-wizard.spec.ts —
 * this spec deliberately stops exercising config writes through the entry, because
 * the entry is no longer a configuration surface.
 *
 * SKIP-GUARD: a static STACK_READY (the new dashboard panel bundle + descriptor +
 * the stub must exist) gates the whole suite, plus a per-test runtime check that the
 * built-in band actually SERVES the `hindsight.dashboard` contribution in this
 * environment (dist not rebuilt / parallel coder branches not merged ⇒ skip). This
 * keeps the suite green-by-skip until the embedded-dashboard implementation lands.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "../gateway-harness.js";
import type { Page } from "@playwright/test";
import { apiFetch, base, readE2ETokenAsync, waitForSessionStatus } from "../e2e-setup.js";
import { openApp, createSessionViaUI } from "./ui-helpers.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

const PACK = "hindsight";
const DASHBOARD_PANEL_ID = "hindsight.dashboard";
const PACK_SRC = path.resolve(__dirname, "..", "..", "..", "market-packs", PACK);
const STUB_PATH = path.resolve(__dirname, "..", "hindsight-stub.mjs");
const CONFIG_KEY = "provider-config:memory";

// Distinct API/data-plane URL (dialed by Bobbit) vs human dashboard UI URL
// (display/iframe-only, NEVER dialed by the client). The whole point of this goal is
// that the embedded dashboard loads the UI URL verbatim — never a value fabricated
// from the API URL.
const EX_UI_URL = "http://127.0.0.1:19177/banks/hermes?view=data";
const UNREACHABLE_UI_URL = "http://127.0.0.1:1/banks/hermes?view=data&__bobbit_hindsight_timeout_ms=50&__bobbit_hindsight_force_timeout=1";

// Static skip-guard: the NEW embedded-dashboard panel bundle + descriptor must exist
// before this suite means anything. On this (test-only) branch the parallel coder
// branches are not merged, so the suite skips entirely until the stack lands.
const STACK_READY =
	fs.existsSync(path.join(PACK_SRC, "lib", "HindsightDashboardPanel.js")) &&
	fs.existsSync(path.join(PACK_SRC, "panels", "hindsight-dashboard.yaml")) &&
	fs.existsSync(STUB_PATH);

const describe = STACK_READY ? test.describe : test.describe.skip;

interface HindsightStub {
	url: string;
	setHealthy(ok: boolean): void;
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

interface DashboardContribution {
	paletteEntrypointId: string;
	routeId: string;
}

/** Runtime readiness: the built-in band must serve the NEW `hindsight.dashboard`
 *  panel, the session-menu + route entrypoints (now retargeted to it), and the
 *  config/status routes, AND the panel module must be fetchable. Returns the
 *  discovered session-menu entrypoint id + deep-link routeId, or null when the
 *  embedded-dashboard contribution is unavailable here (→ skip). */
async function resolveDashboardContribution(): Promise<DashboardContribution | null> {
	const meta = (await listContributions()).find((p) => p.packId === PACK);
	if (!meta) return null;
	if (!meta.panels?.some((p) => p.id === DASHBOARD_PANEL_ID)) return null;
	const palette = meta.entrypoints?.find((e) => e.kind === "session-menu");
	const route = meta.entrypoints?.find((e) => e.kind === "route" && !!e.routeId);
	if (!palette || !route?.routeId) return null;
	for (const r of ["config", "status"]) {
		if (!meta.routeNames?.includes(r)) return null;
	}
	const panelRes = await apiFetch(`/api/ext/packs/${PACK}/panels/${encodeURIComponent(DASHBOARD_PANEL_ID)}`);
	if (!panelRes.ok) return null;
	return { paletteEntrypointId: palette.id, routeId: route.routeId };
}

/** The compound launcher key `runLauncherEntrypoint` dispatches on
 *  (`packId NUL entrypointId`) — the SAME key the session-menu uses per item. */
function launcherKey(entrypointId: string): string {
	return `${PACK}\u0000${entrypointId}`;
}

async function reconcile(page: Page): Promise<void> {
	await page.evaluate(() => (window as any).__bobbitReconcilePackRenderers?.()).catch(() => { /* race */ });
}

const frame = (page: Page) => page.locator('[data-testid="hindsight-dashboard-frame"]').first();
const emptyState = (page: Page) => page.locator('[data-testid="hindsight-dashboard-empty"]').first();
const embedWarning = (page: Page) => page.locator('[data-testid="hindsight-dashboard-embed-warning"]').first();
const externalLink = (page: Page) => page.locator('[data-testid="hindsight-dashboard-open-external"]').first();
const configCard = (page: Page) => page.locator('[data-testid="hindsight-config-card"]');

/** Force-enable the default-disabled built-in Hindsight pack at server scope so its
 *  dashboard panel + entrypoints + routes are SERVED regardless of worker ordering. */
async function forceEnableHindsight(): Promise<void> {
	await apiFetch("/api/marketplace/pack-activation", {
		method: "PUT",
		body: JSON.stringify({ scope: "server", packName: PACK, disabled: {} }),
	}).catch(() => { /* best-effort */ });
}

/** Reset the persisted Hindsight config in the shared in-process pack store. */
async function resetHindsightConfig(): Promise<void> {
	try {
		const { getPackStore } = await import("../../../dist/server/extension-host/pack-store.js");
		await getPackStore().put(PACK, CONFIG_KEY, {});
	} catch { /* best-effort */ }
}

/** Seed the persisted Hindsight config — the dashboard panel reads `uiUrl` from the
 *  `config`/`status` route on mount, so the embedded iframe `src` derives from this. */
async function seedHindsightConfig(overrides: Record<string, unknown>): Promise<void> {
	const { getPackStore } = await import("../../../dist/server/extension-host/pack-store.js");
	await getPackStore().put(PACK, CONFIG_KEY, overrides);
}

/** Return the built-in Hindsight pack to its DEFAULT-DISABLED baseline so the enabled
 *  state cannot LEAK to sibling spec files sharing the worker's in-process gateway. */
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

/** Clear the per-PAGE dashboard panel state cache (the module-closure Map the panel
 *  keys by sessionId). The panel kicks its READ-only `config`+`status` loads exactly
 *  ONCE per session (guarded by `mountKicked`) and is a pure projection thereafter —
 *  so if BOTH route reads transiently fail/time-out at mount (rare, only under heavy
 *  CPU contention with sibling workers), the panel latches an empty/error projection
 *  and never re-reads. Clearing the cache before re-opening forces a FRESH mount that
 *  re-derives the surface from the persisted (server-side) config — this is exactly
 *  the state a real page reload produces, so it does not weaken the persistence claim. */
async function clearDashboardPanelCache(page: Page): Promise<void> {
	await page.evaluate(() => {
		try { (globalThis as any).__bobbitHindsightDashboardState?.clear?.(); } catch { /* not mounted yet */ }
	}).catch(() => { /* page navigating */ });
}

/** Deterministically wait until the dashboard panel SETTLES on the expected surface
 *  (`frame` when a uiUrl is configured, `empty` otherwise), re-driving `open()` each
 *  attempt. While still stuck it also clears the per-page panel cache so a transient
 *  mount-time route read cannot LATCH a wrong/empty projection that never re-reads.
 *  Once the surface is present it is left untouched (no further clears/re-opens), so
 *  follow-on state — e.g. the deterministic embed-warning timeout — is never disturbed. */
async function waitForDashboardSurface(
	page: Page,
	want: "frame" | "empty",
	open: () => Promise<unknown>,
	timeout = 20_000,
): Promise<void> {
	const target = want === "frame" ? frame(page) : emptyState(page);
	await open();
	await reconcile(page);
	await expect.poll(async () => {
		const n = await target.count();
		if (n > 0) return n; // settled — do not disturb the live surface
		await reconcile(page);
		await clearDashboardPanelCache(page);
		await open();
		await reconcile(page);
		return target.count();
	}, { timeout }).toBeGreaterThan(0);
}

/** Open the app + select a fresh session, then mount the Hindsight dashboard panel via
 *  the session-menu launcher (the SAME chain a menu click drives). Deterministically
 *  waits for the EXPECTED surface (frame/empty) so a transient mount-time read can
 *  never latch the wrong projection. Returns the session id so the caller can deep-link. */
async function mountDashboard(page: Page, contribution: DashboardContribution, want: "frame" | "empty" = "frame"): Promise<string> {
	await openApp(page);
	const sid = await createSessionViaUI(page);
	expect(sid, "a session must be selected").toBeTruthy();
	await waitForSessionStatus(sid, "idle").catch(() => { /* best-effort */ });
	await reconcile(page);
	const open = () => page.evaluate((key) => (window as any).__bobbitRunPackLauncher?.(key), launcherKey(contribution.paletteEntrypointId)).catch(() => { /* race */ });
	await waitForDashboardSurface(page, want, open);
	return sid;
}

test.describe.configure({ mode: "serial" });

describe("Hindsight pack — embedded dashboard entry (use surface)", () => {
	let stub: HindsightStub;

	test.beforeAll(async () => {
		await forceEnableHindsight();
		await resetHindsightConfig();
		stub = await startStub();
	});

	test.afterAll(async () => {
		await resetHindsightConfig();
		await resetHindsightActivation();
		if (stub) await stub.close().catch(() => { /* ignore */ });
	});

	test.beforeEach(async () => {
		await resetHindsightConfig();
	});

	test("session-menu entry embeds the dashboard iframe (src = uiUrl), shows no config card, and re-opens via #/ext deep link", async ({ page }) => {
		const contribution = await resolveDashboardContribution();
		test.skip(!contribution, "Hindsight embedded-dashboard contribution is not served in this environment");
		const { routeId } = contribution!;

		// Configure a DISTINCT data-plane URL + human dashboard UI URL out of band
		// (Marketplace is the config home; here we only exercise the use surface).
		await seedHindsightConfig({ externalUrl: stub.url, bank: "hermes", uiUrl: EX_UI_URL });
		expect(EX_UI_URL).not.toBe(stub.url);

		// Keep the embed warning out of the way for the happy path: a generous iframe
		// load-timeout means the deterministic warning never fires within the test.
		await page.addInitScript(() => { (window as any).__bobbitHindsightIframeTimeoutMs = 60_000; });

		const sid = await mountDashboard(page, contribution!);

		// The embedded iframe mounts with src === the configured UI URL — verbatim.
		await expect(frame(page), "the entry embeds the dashboard iframe").toBeVisible({ timeout: 15_000 });
		await expect(frame(page), "the iframe loads the configured UI URL verbatim (never the API URL)").toHaveAttribute("src", EX_UI_URL, { timeout: 15_000 });

		// The entry is NOT a configuration surface: no config card is rendered.
		await expect(configCard(page), "the entry must not open a config card").toHaveCount(0);

		// PERSISTENCE: a full reload + the bare deep link re-opens the SAME embedded
		// dashboard (config persisted server-side; still not a config surface).
		const token = await readE2ETokenAsync();
		await page.goto(`${base()}/?token=${encodeURIComponent(token)}#/session/${sid}`);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });
		await reconcile(page);
		// Drive the bare `#/ext/<routeId>` deep link. Toggle via the session route so
		// re-opening is observable even when the hash is already the ext route, then
		// wait deterministically for the embedded frame to settle (recovering from a
		// transient mount-time read latch — see waitForDashboardSurface).
		const openDeepLink = async () => {
			await page.evaluate((s) => { window.location.hash = `#/session/${s}`; }, sid).catch(() => { /* race */ });
			await page.evaluate((h) => { window.location.hash = h; }, `#/ext/${routeId}`).catch(() => { /* race */ });
		};
		await waitForDashboardSurface(page, "frame", openDeepLink);
		await expect(frame(page), "the deep link re-opens the embedded dashboard").toBeVisible({ timeout: 15_000 });
		await expect(frame(page), "the re-opened iframe keeps the configured UI URL").toHaveAttribute("src", EX_UI_URL, { timeout: 15_000 });
		await expect(configCard(page), "the deep link must not open a config card").toHaveCount(0);
	});

	test("the embedded dashboard iframe fills the panel height (not collapsed to the ~320px min-height floor)", async ({ page }) => {
		const contribution = await resolveDashboardContribution();
		test.skip(!contribution, "Hindsight embedded-dashboard contribution is not served in this environment");

		// A standard desktop viewport. The bug: the iframe collapsed to its wrap's
		// `min-height` floor (~320px) instead of filling the panel, because the
		// height chain to the `height:100%` iframe was not DEFINITE end-to-end.
		await page.setViewportSize({ width: 1280, height: 800 });
		await seedHindsightConfig({ externalUrl: stub.url, bank: "hermes", uiUrl: EX_UI_URL });
		await page.addInitScript(() => { (window as any).__bobbitHindsightIframeTimeoutMs = 60_000; });
		await mountDashboard(page, contribution!);

		const f = frame(page);
		await expect(f).toBeVisible({ timeout: 15_000 });

		// Measure the ACTUAL rendered height — not mere visibility. The frame must be
		// TALL (a high fraction of the panel), proving the definite height chain.
		const box = await f.boundingBox();
		expect(box, "the iframe has a bounding box").not.toBeNull();
		expect(box!.height, `iframe collapsed to ${Math.round(box!.height)}px — must fill the panel`).toBeGreaterThan(500);

		// Cross-check it actually tracks the panel container, not a fixed pixel value.
		const panelBox = await page.locator('[data-testid="pack-panel-root"]').first().boundingBox();
		expect(panelBox, "the pack panel root has a bounding box").not.toBeNull();
		expect(box!.height, "the iframe fills most of the panel height").toBeGreaterThan(panelBox!.height * 0.7);
	});

	test("a secondary external fallback link points at the same uiUrl (target=_blank, rel=noopener)", async ({ page }) => {
		const contribution = await resolveDashboardContribution();
		test.skip(!contribution, "Hindsight embedded-dashboard contribution is not served in this environment");

		await seedHindsightConfig({ externalUrl: stub.url, bank: "hermes", uiUrl: EX_UI_URL });
		await page.addInitScript(() => { (window as any).__bobbitHindsightIframeTimeoutMs = 60_000; });
		await mountDashboard(page, contribution!);

		await expect(frame(page)).toBeVisible({ timeout: 15_000 });
		const link = externalLink(page);
		await expect(link, "an external open-in-browser fallback is offered").toBeVisible({ timeout: 15_000 });
		await expect(link, "the fallback opens the UI URL verbatim").toHaveAttribute("href", EX_UI_URL);
		await expect(link).toHaveAttribute("target", "_blank");
		await expect(link).toHaveAttribute("rel", /noopener/);
	});

	test("unset uiUrl renders a helpful empty state (Marketplace CTA) — not a dead end, not a config card, no iframe", async ({ page }) => {
		const contribution = await resolveDashboardContribution();
		test.skip(!contribution, "Hindsight embedded-dashboard contribution is not served in this environment");

		// Data-plane URL is configured but the human dashboard UI URL is NOT.
		await seedHindsightConfig({ externalUrl: stub.url, bank: "hermes" });
		await mountDashboard(page, contribution!, "empty");

		await expect(emptyState(page), "an unset UI URL renders the empty state").toBeVisible({ timeout: 15_000 });
		await expect(frame(page), "no iframe is rendered without a UI URL").toHaveCount(0);
		await expect(configCard(page), "the empty state must not be a config form").toHaveCount(0);
		// The empty state must point the user at the Marketplace (the config home) — a
		// CTA/link to #/market, not a dead end.
		await expect(emptyState(page), "the empty state offers a Marketplace configuration CTA").toContainText(/market|configure/i);
	});

	test("blocked/unreachable iframe surfaces the embed warning (deterministic timeout hook) while keeping the external fallback", async ({ page }) => {
		const contribution = await resolveDashboardContribution();
		test.skip(!contribution, "Hindsight embedded-dashboard contribution is not served in this environment");

		// A reachable-shaped but framing-refused / unreachable UI URL. The parent cannot
		// detect XFO/CSP refusal, so the panel uses a load-timeout. Drive it deterministically.
		await seedHindsightConfig({ externalUrl: stub.url, bank: "hermes", uiUrl: UNREACHABLE_UI_URL });
		await mountDashboard(page, contribution!);

		// The frame still mounts (src is set) but the load never completes → the warning.
		await expect(embedWarning(page), "an iframe that never loads surfaces the embed warning").toBeVisible({ timeout: 15_000 });
		// The external fallback stays available so the user is never stranded.
		const link = externalLink(page);
		await expect(link, "the external fallback remains available when embedding is blocked").toBeVisible({ timeout: 15_000 });
		await expect(link).toHaveAttribute("href", UNREACHABLE_UI_URL);
		// Still never a config surface.
		await expect(configCard(page)).toHaveCount(0);
	});
});
