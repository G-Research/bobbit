/**
 * Browser E2E — Market UI activation controls (pack schema V1 §9 + §11.2).
 *
 * Proves the SINGLE-SOURCE RULE that fixes the "disable → reload → entity
 * vanishes → cannot re-enable" hazard: the Market activation toggles render
 * SOLELY from the UNFILTERED `catalogue` returned by
 * GET /api/marketplace/pack-activation (read from the installed pack manifest's
 * `contents`), NEVER from the runtime-filtered /api/tools or
 * /api/ext/contributions. So a DISABLED entity stays VISIBLE + re-enableable
 * across reloads, while the runtime registries DO drop it (a disabled entrypoint
 * disappears from launchers/deep-links; the underlying panel stays available to
 * an enabled tool).
 *
 * §11.2 explicit assertions for the entrypoint toggle:
 *   (1) disable an entrypoint → it is removed from /api/ext/contributions
 *       (launcher + deep-link registration), while the pack's PANEL stays present;
 *   (2) RELOAD the Market page → the disabled entrypoint toggle is STILL VISIBLE
 *       and UNCHECKED (proves the unfiltered catalogue source);
 *   (3) re-enable it → reload → it is checked again and the entrypoint is back in
 *       /api/ext/contributions.
 *
 * Uses the shipped `artifacts` pack at SERVER scope (it declares both a tool that
 * opens the `artifacts.viewer` panel AND the `artifacts-deeplink` entrypoint), so
 * disabling the entrypoint while the tool stays enabled is the exact "launcher
 * gone, panel stays" case §9 describes.
 *
 * Pattern: mirrors tests/e2e/ui/artifacts-pack.spec.ts (server-scope install +
 * afterEach cleanup) and tests/e2e/ui/marketplace.spec.ts (Market navigation).
 */
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { test, expect } from "../gateway-harness.js";
import { apiFetch } from "../e2e-setup.js";
import { openApp, navigateToHash } from "./ui-helpers.js";

// A single end-to-end lifecycle; explicit serial so a failed run never leaks a
// half-installed server-scope pack into a retry.
test.describe.configure({ mode: "serial" });

const SOURCE_DIR = fileURLToPath(new URL("../../../market-packs", import.meta.url));
const PACK = "artifacts";
// contents.entrypoints[] basename — the SINGLE activation toggle key (listName).
const ENTRYPOINT_LIST_NAME = "artifacts-deeplink";
const TOGGLE = `[data-testid="market-toggle-entrypoint-${ENTRYPOINT_LIST_NAME}"]`;
const ACTIVATION = `[data-testid="market-activation-${PACK}"]`;

async function installArtifactsPack(): Promise<void> {
	const addRes = await apiFetch("/api/marketplace/sources", { method: "POST", body: JSON.stringify({ url: SOURCE_DIR }) });
	const addBody = await addRes.text();
	expect(addRes.status, addBody).toBe(201);
	const sourceId = (JSON.parse(addBody) as { source: { id: string } }).source.id;
	const instRes = await apiFetch("/api/marketplace/install", {
		method: "POST",
		body: JSON.stringify({ sourceId, dirName: PACK, scope: "server" }),
	});
	const instBody = await instRes.text();
	expect(instRes.status, instBody).toBe(201);
}

async function cleanup(): Promise<void> {
	await apiFetch("/api/marketplace/installed", {
		method: "DELETE",
		body: JSON.stringify({ scope: "server", packName: PACK }),
	}).catch(() => {});
	// Reset the activation override so a retry starts from the default-enabled state.
	await apiFetch("/api/marketplace/pack-activation", {
		method: "PUT",
		body: JSON.stringify({ scope: "server", packName: PACK, disabled: {} }),
	}).catch(() => {});
	try {
		const res = await apiFetch("/api/marketplace/sources");
		for (const s of ((await res.json()).sources ?? []) as Array<{ id: string }>) {
			await apiFetch(`/api/marketplace/sources/${encodeURIComponent(s.id)}`, { method: "DELETE" }).catch(() => {});
		}
	} catch { /* ignore */ }
}

/** Does /api/ext/contributions (the runtime-filtered endpoint) currently list the
 *  artifacts deep-link entrypoint? */
async function entrypointRegistered(): Promise<boolean> {
	const res = await apiFetch("/api/ext/contributions");
	if (!res.ok) return false;
	const packs = (await res.json()).packs as Array<{ packId: string; panels: Array<{ id: string }>; entrypoints: Array<{ listName: string }> }>;
	const pack = packs.find((p) => p.packId === PACK);
	return !!pack?.entrypoints?.some((e) => e.listName === ENTRYPOINT_LIST_NAME);
}

/** Does the pack still expose its panel (support surface stays available)? */
async function panelRegistered(): Promise<boolean> {
	const res = await apiFetch("/api/ext/contributions");
	if (!res.ok) return false;
	const packs = (await res.json()).packs as Array<{ packId: string; panels: Array<{ id: string }> }>;
	const pack = packs.find((p) => p.packId === PACK);
	return !!pack?.panels?.some((p) => p.id === "artifacts.viewer");
}

async function openMarketInstalled(page: Page): Promise<void> {
	await navigateToHash(page, "#/market");
	await expect(page.locator(`[data-testid="market-tab-installed"]`)).toBeVisible({ timeout: 15_000 });
	await page.locator(`[data-testid="market-tab-installed"]`).click();
	await expect(page.locator(`[data-testid="market-installed-panel"]`)).toBeVisible({ timeout: 15_000 });
	// The activation controls load in the background (one GET per installed pack).
	await expect(page.locator(ACTIVATION)).toBeVisible({ timeout: 15_000 });
}

test.afterEach(async () => {
	await cleanup();
});

test.describe("Market UI activation controls — disable-entrypoint (pack schema V1 §9/§11.2)", () => {
	test("disable an entrypoint → removed from runtime registry, panel stays; reload → toggle STILL VISIBLE + UNCHECKED; re-enable → restored", async ({ page }) => {
		await page.setViewportSize({ width: 1400, height: 900 });
		await installArtifactsPack();

		// Sanity: the entrypoint + panel are both registered before any toggle.
		expect(await entrypointRegistered(), "the deep-link entrypoint is registered after install").toBe(true);
		expect(await panelRegistered(), "the panel is registered after install").toBe(true);

		await openApp(page);
		await openMarketInstalled(page);

		// The entrypoint toggle is visible and CHECKED (enabled by default).
		const toggle = page.locator(TOGGLE);
		await expect(toggle, "the entrypoint toggle must render from the catalogue").toBeVisible({ timeout: 15_000 });
		await expect(toggle).toBeChecked();
		// Marketplace UI polish R1: the standalone activation-help copy was removed —
		// the activation toggles now stand on their own — so it must NOT render.
		await expect(page.locator(`[data-testid="market-activation-help"]`)).toHaveCount(0);

		// ── (1) Disable the entrypoint → PUT + reconcile. It must disappear from the
		// runtime /api/ext/contributions, while the PANEL stays available. ──
		await toggle.uncheck();
		await expect(toggle).not.toBeChecked();
		await expect
			.poll(async () => entrypointRegistered(), { timeout: 15_000 })
			.toBe(false);
		expect(await panelRegistered(), "the panel stays available when only the entrypoint is disabled").toBe(true);

		// ── (2) RELOAD → the disabled entrypoint toggle is STILL VISIBLE + UNCHECKED.
		// (The unfiltered catalogue source: the entity did NOT vanish with the
		// filtered runtime endpoint.) ──
		await page.reload();
		await expect(page.locator("button").filter({ hasText: "Settings" }).first()).toBeVisible({ timeout: 20_000 });
		await openMarketInstalled(page);
		const toggleAfterReload = page.locator(TOGGLE);
		await expect(toggleAfterReload, "the disabled entrypoint toggle must STILL be visible after reload").toBeVisible({ timeout: 15_000 });
		await expect(toggleAfterReload, "the disabled entrypoint toggle must be UNCHECKED after reload").not.toBeChecked();

		// ── (3) Re-enable → reload → checked again + the entrypoint is back in the
		// runtime registry. ──
		await toggleAfterReload.check();
		await expect(toggleAfterReload).toBeChecked();
		await expect
			.poll(async () => entrypointRegistered(), { timeout: 15_000 })
			.toBe(true);

		await page.reload();
		await expect(page.locator("button").filter({ hasText: "Settings" }).first()).toBeVisible({ timeout: 20_000 });
		await openMarketInstalled(page);
		await expect(page.locator(TOGGLE), "the re-enabled entrypoint toggle must be checked after reload").toBeChecked({ timeout: 15_000 });
	});
});
