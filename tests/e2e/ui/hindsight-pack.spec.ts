/**
 * Browser E2E — P4 Hindsight native config/status PANEL + entrypoints
 * (design docs/design/hindsight-panel-p4-implementation.md §7). Proves the
 * Hindsight pack's native panel is served END-TO-END by the built-in band with
 * NO manual install, and that it replaces store-seeding as the user-facing
 * configuration path:
 *
 *   1. OPEN — the command-palette launcher (`hindsight.palette`, a bare
 *      PanelTarget) opens `hindsight.panel` in the active session via the SAME
 *      `runLauncherEntrypoint` chain a palette click drives (design §7.2 #1
 *      explicitly sanctions the `__bobbitRunPackLauncher` hook). The status badge
 *      starts `data-state="dormant"` (not configured).
 *   2. CONFIGURE — type the in-process Hindsight stub URL into
 *      `hindsight-external-url` + `bobbit` into `hindsight-bank`, click
 *      `hindsight-save`. Config persists THROUGH the `config` route (validation +
 *      redaction server-side), never a client store write.
 *   3. STATUS — with the stub healthy, Save re-fetches `status` → the badge flips
 *      to `data-state="connected"`; `setHealthy(false)` + Refresh → `unreachable`;
 *      restore → `connected` again (the panel's read-only health projection).
 *   4. SEARCH — a query through `hindsight-search-input` → the `recall` route →
 *      the stub's seeded memories render as `hindsight-memory-result` cards
 *      (escaped via the lit toolkit). The stub records a `recall` against bank
 *      `bobbit`.
 *   5. PERSISTENCE — a full reload + the deep link `#/ext/hindsight` rehydrates
 *      the SAME singleton panel: config (external URL + bank) and the connected
 *      status come back from the routes, proving config persisted server-side.
 *
 * Stub: the existing in-process `tests/e2e/hindsight-stub.mjs` backs
 * `status.healthy` + `recall` (no network, deterministic). The gateway shares the
 * in-process pack-store singleton, so the panel's `config` POST and the stub URL
 * line up exactly the way the API spec's `seedConfig` does — except here config
 * flows THROUGH the panel.
 *
 * SKIP-GUARD (design §7.4): the suite stays green before this branch's pack
 * panel/entrypoints + build entry merge. A static `DEPS_READY` gates the source
 * files; a runtime check additionally skips if the built-in band does not serve
 * the panel contribution in this environment (e.g. dist not rebuilt).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "../gateway-harness.js";
import type { Page } from "@playwright/test";
import { apiFetch, base, readE2ETokenAsync, waitForSessionStatus } from "../e2e-setup.js";
import { openApp, createSessionViaUI, sendMessage } from "./ui-helpers.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

const PACK = "hindsight";
const PANEL_ID = "hindsight.panel";
const PACK_SRC = path.resolve(__dirname, "..", "..", "..", "market-packs", PACK);
const STUB_PATH = path.resolve(__dirname, "..", "hindsight-stub.mjs");

// Static skip-guard (design §7.4): mirror hindsight-external.spec.ts. The pack
// panel source + descriptor + the stub must be present before this suite means
// anything. A runtime guard (below) additionally skips if the built-in band does
// not SERVE the contribution (dist not rebuilt with the panel entry).
const DEPS_READY =
	fs.existsSync(path.join(PACK_SRC, "lib", "HindsightPanel.js")) &&
	fs.existsSync(path.join(PACK_SRC, "panels", "hindsight-memory.yaml")) &&
	fs.existsSync(STUB_PATH);

// The pack-store config key the `config` route persists under (mirrors
// src/shared.ts::CONFIG_KEY / providerConfigStoreKey("memory")).
const CONFIG_KEY = "provider-config:memory";

const describe = DEPS_READY ? test.describe : test.describe.skip;

// ── stub typing (the .mjs is untyped; describe its shape locally) ────────────
interface RecordedCall { method: string; path: string; bank?: string; namespace?: string }
interface HindsightStub {
	url: string;
	calls: RecordedCall[];
	setHealthy(ok: boolean): void;
	seedMemories(bank: string, mem: { text: string; id?: string; score?: number; tags?: string[] }[]): void;
	close(): Promise<void>;
}

async function startStub(): Promise<HindsightStub> {
	// Indirect specifier so the typechecker does not resolve the untyped .mjs.
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

interface HindsightContribution {
	paletteEntrypointId: string;
	routeId: string;
}

/** Runtime readiness: the built-in band must serve the panel + both entrypoints +
 *  the config/status/recall routes, AND the panel module must be fetchable. Returns
 *  the discovered palette entrypoint id + deep-link routeId, or null when the
 *  contribution is unavailable in this environment (→ skip). */
async function resolveHindsightContribution(): Promise<HindsightContribution | null> {
	const meta = (await listContributions()).find((p) => p.packId === PACK);
	if (!meta) return null;
	if (!meta.panels?.some((p) => p.id === PANEL_ID)) return null;
	const palette = meta.entrypoints?.find((e) => e.kind === "command-palette");
	const route = meta.entrypoints?.find((e) => e.kind === "route" && !!e.routeId);
	if (!palette || !route?.routeId) return null;
	for (const r of ["config", "status", "recall"]) {
		if (!meta.routeNames?.includes(r)) return null;
	}
	// The lazy panel module must be servable (catches a dist that lacks the panel
	// build entry even though the source files exist on disk).
	const panelRes = await apiFetch(`/api/ext/packs/${PACK}/panels/${encodeURIComponent(PANEL_ID)}`);
	if (!panelRes.ok) return null;
	return { paletteEntrypointId: palette.id, routeId: route.routeId };
}

/** The compound launcher key `runLauncherEntrypoint` dispatches on
 *  (`packId NUL entrypointId`) — the SAME key the command palette uses per item. */
function launcherKey(entrypointId: string): string {
	return `${PACK}\u0000${entrypointId}`;
}

async function reconcile(page: Page): Promise<void> {
	await page.evaluate(() => (window as any).__bobbitReconcilePackRenderers?.()).catch(() => { /* race */ });
}

const panel = (page: Page) => page.locator('[data-testid="hindsight-panel"]').first();
const statusBadge = (page: Page) => page.locator('[data-testid="hindsight-status-badge"]').first();

/** Reset the persisted Hindsight config in the shared in-process pack store so a
 *  prior (or failed) run never leaks the stub URL into a sibling test. */
async function resetHindsightConfig(): Promise<void> {
	try {
		const { getPackStore } = await import("../../../dist/server/extension-host/pack-store.js");
		await getPackStore().put(PACK, CONFIG_KEY, {});
	} catch { /* best-effort */ }
}

describe.configure({ mode: "serial" });

describe("Hindsight pack — native config/status panel (built-in band)", () => {
	let stub: HindsightStub;

	test.beforeAll(async () => {
		await resetHindsightConfig();
		stub = await startStub();
	});

	test.afterAll(async () => {
		await resetHindsightConfig();
		if (stub) await stub.close().catch(() => { /* ignore */ });
	});

	test("open via palette → configure → status connected → search → persists across reload", async ({ page }) => {
		const contribution = await resolveHindsightContribution();
		test.skip(
			!contribution,
			"Hindsight pack panel contribution is not served in this environment (panel/entrypoints/routes not built or not merged)",
		);
		const { paletteEntrypointId, routeId } = contribution!;

		// Seed recall results on the stub for the search assertion.
		const SEEDED_MEMORY = "Risky rollouts should always go behind a feature flag.";
		stub.seedMemories("bobbit", [{ text: SEEDED_MEMORY, id: "mem-flag", score: 0.93 }]);

		// ── Step 1: OPEN via the command-palette launcher. ──
		await openApp(page);
		const sid = await createSessionViaUI(page);
		expect(sid, "a session must be selected").toBeTruthy();
		await waitForSessionStatus(sid, "idle").catch(() => { /* best-effort */ });
		await reconcile(page);

		// Run the palette launcher exactly as a command-palette click would
		// (runLauncherEntrypoint → openPackPanel; design §7.2 #1). Poll-drive the
		// reconcile + launch so a still-in-flight entrypoint registration settles.
		await expect.poll(async () => {
			await reconcile(page);
			await page.evaluate((key) => (window as any).__bobbitRunPackLauncher?.(key), launcherKey(paletteEntrypointId)).catch(() => { /* race */ });
			return panel(page).count();
		}, { timeout: 20_000 }).toBeGreaterThan(0);
		await expect(panel(page), "the Hindsight panel must mount in the active session").toBeVisible({ timeout: 15_000 });

		// Mode selector is present (tolerate either the task or design-doc testid).
		await expect(
			page.locator('[data-testid="hindsight-mode"], [data-testid="hindsight-mode-select"]').first(),
			"the deployment-mode selector must render",
		).toBeVisible({ timeout: 10_000 });

		// Dormant before any config (the mount-time status GET returns configured:false).
		await expect(statusBadge(page), "an unconfigured panel starts dormant").toHaveAttribute("data-state", "dormant", { timeout: 15_000 });

		// ── Step 2 + 3: CONFIGURE external URL + bank → Save → status connected. ──
		await page.locator('[data-testid="hindsight-external-url"]').fill(stub.url);
		const bankInput = page.locator('[data-testid="hindsight-bank"]');
		await bankInput.fill("bobbit");
		await page.locator('[data-testid="hindsight-save"]').click();

		// Save POSTs `config` then re-fetches `status`; the healthy stub flips the
		// badge to connected. Outcome-based (the route POST URL is shared by GET+POST).
		await expect(statusBadge(page), "a healthy configured Hindsight reports connected").toHaveAttribute(
			"data-state",
			"connected",
			{ timeout: 20_000 },
		);

		// Health is a read-only projection: unhealthy stub + Refresh → unreachable,
		// restore → connected again.
		stub.setHealthy(false);
		await page.locator('[data-testid="hindsight-refresh"]').click();
		await expect(statusBadge(page), "an unreachable external Hindsight reports unreachable").toHaveAttribute(
			"data-state",
			"unreachable",
			{ timeout: 20_000 },
		);
		stub.setHealthy(true);
		await page.locator('[data-testid="hindsight-refresh"]').click();
		await expect(statusBadge(page), "restored health flips back to connected").toHaveAttribute(
			"data-state",
			"connected",
			{ timeout: 20_000 },
		);

		// ── Step 4: SEARCH renders the seeded memory via the recall route. ──
		const recallBefore = stub.calls.filter((c) => /\/memories\/recall$/.test(c.path)).length;
		await page.locator('[data-testid="hindsight-search-input"]').fill("how do we roll out risky changes?");
		await page.locator('[data-testid="hindsight-search-submit"]').click();

		const result = page.locator('[data-testid="hindsight-memory-result"]').filter({ hasText: SEEDED_MEMORY }).first();
		await expect(result, "the seeded memory must render as a result card").toBeVisible({ timeout: 20_000 });

		// The recall actually hit the stub, scoped to bank `bobbit`.
		await expect.poll(() => {
			const recalls = stub.calls.filter((c) => /\/memories\/recall$/.test(c.path));
			return recalls.length > recallBefore && recalls.every((c) => c.bank === "bobbit");
		}, { timeout: 10_000 }).toBe(true);

		// ── Step 5: PERSISTENCE across reload via the deep link #/ext/<routeId>. ──
		const token = await readE2ETokenAsync();
		await page.goto(`${base()}/?token=${encodeURIComponent(token)}#/session/${sid}`);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });
		await reconcile(page);

		// Navigate the bare deep link → the singleton panel re-opens + rehydrates from
		// the routes. Poll-drive the reconcile so a cold-load registration settles.
		await expect.poll(async () => {
			await reconcile(page);
			await page.evaluate((h) => { window.location.hash = h; }, `#/ext/${routeId}`);
			return panel(page).count();
		}, { timeout: 20_000 }).toBeGreaterThan(0);
		await expect(panel(page), "the deep link must re-open the singleton panel").toBeVisible({ timeout: 15_000 });

		// Config rehydrated from the server-persisted record (external URL is NOT a
		// secret, so it is echoed; bank likewise).
		await expect(page.locator('[data-testid="hindsight-external-url"]'), "external URL persisted server-side").toHaveValue(stub.url, { timeout: 15_000 });
		await expect(page.locator('[data-testid="hindsight-bank"]'), "bank persisted server-side").toHaveValue("bobbit", { timeout: 15_000 });

		// Status rehydrates to connected (the stub is still healthy).
		await expect(statusBadge(page), "status rehydrates to connected after reload").toHaveAttribute(
			"data-state",
			"connected",
			{ timeout: 20_000 },
		);
	});
});
