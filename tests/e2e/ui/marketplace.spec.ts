/**
 * Browser E2E — Pack-Based Marketplace UI surface.
 * See docs/design/pack-based-marketplace.md §12.3.
 *
 * STATUS: This spec is written against the documented REST contracts (§9). The
 * backend (/api/marketplace/*, /api/packs/conflicts, originPackName on
 * /api/roles|tools|skills) is being built in parallel. Tests that only exercise
 * the UI shell (Market button position, opening the surface, graceful error
 * degradation, the add-source form) run today. Tests that need live REST are
 * marked `test.fixme` with a TODO so the REST agent can un-skip them once the
 * endpoints land — they are NOT left failing.
 *
 * Pattern: mirrors tests/e2e/ui/sidebar-navigation.spec.ts + skills-chip.spec.ts
 * and reuses config-page conventions (origin badges, scope rows).
 */
import type { Page } from "@playwright/test";
import { test, expect } from "../gateway-harness.js";
import { openApp, navigateToHash } from "./ui-helpers.js";

/** Ordinal of the named config-nav button within the expanded sidebar's nav row. */
async function navButtonOrder(page: Page): Promise<string[]> {
	return page.evaluate(() => {
		const sidebar = document.querySelector('[data-testid="sidebar-expanded"]');
		if (!sidebar) return [];
		const buttons = Array.from(sidebar.querySelectorAll<HTMLButtonElement>("button"));
		return buttons
			.map((b) => (b.textContent || "").trim())
			.filter((t) => ["Roles", "Tools", "Skills", "Workflows", "Market", "New Goal"].includes(t));
	});
}

test.describe("Marketplace UI", () => {
	// ------------------------------------------------------------------
	// §12.3 #1 — Market button visible & positioned between Workflows and
	// New Goal; opens the marketplace surface. (UI shell — runs today.)
	// ------------------------------------------------------------------
	test("Market button is between Workflows and New Goal and opens the surface @smoke", async ({ page }) => {
		await openApp(page);

		const marketBtn = page.locator('[data-testid="market-nav-button"]').first();
		await expect(marketBtn).toBeVisible({ timeout: 20_000 });

		// Position: Market appears after Workflows and before New Goal.
		const order = await navButtonOrder(page);
		const wf = order.indexOf("Workflows");
		const mk = order.indexOf("Market");
		const ng = order.indexOf("New Goal");
		expect(wf).toBeGreaterThanOrEqual(0);
		expect(mk).toBeGreaterThan(wf);
		expect(ng).toBeGreaterThan(mk);

		// Opening navigates to #/market and renders the marketplace panels.
		await marketBtn.click();
		await expect.poll(() => page.evaluate(() => window.location.hash)).toBe("#/market");
		await expect(page.locator('[data-testid="market-sources-panel"]')).toBeVisible({ timeout: 10_000 });
		await expect(page.locator('[data-testid="market-browse-panel"]')).toBeVisible();
		await expect(page.locator('[data-testid="market-installed-panel"]')).toBeVisible();
	});

	// ------------------------------------------------------------------
	// Graceful degradation — even if the REST endpoints are absent/erroring,
	// the surface renders the add-source form (so it is testable pre-REST).
	// ------------------------------------------------------------------
	test("marketplace renders the add-source form and degrades gracefully", async ({ page }) => {
		await openApp(page);
		await navigateToHash(page, "#/market");
		await expect(page.locator('[data-testid="market-sources-panel"]')).toBeVisible({ timeout: 10_000 });
		await expect(page.locator('[data-testid="market-source-url"]')).toBeVisible();
		await expect(page.locator('[data-testid="market-add-source"]')).toBeVisible();
		// Install scope picker present with the three documented scope options.
		const scope = page.locator('[data-testid="market-install-scope"]');
		await expect(scope).toBeVisible();
	});

	// ==================================================================
	// LIVE-REST TESTS — un-skip these once /api/marketplace/* lands.
	// Each follows the §12.3 acceptance flow. A local-dir source fixture
	// (a temp directory of pack subtrees) is the simplest source backend.
	// ==================================================================

	// §12.3 #2–3 — register a source and browse its packs.
	test.fixme("register a local-dir source and browse its packs", async ({ page }) => {
		// TODO(rest): create a temp dir with pack subtrees (each pack.yaml +
		// roles/tools/skills), then:
		//   1. open #/market
		//   2. fill [data-testid=market-source-url] with the temp dir path
		//   3. click [data-testid=market-add-source]
		//   4. expect a [data-testid=market-source-row]
		//   5. click it; expect [data-testid=market-browse-pack] with description +
		//      entity chips (.market-entity-chip)
		await openApp(page);
	});

	// §12.3 #4–6 — install to a scope; entities resolve on config pages tagged
	// with the specific pack (originPackName chip); persists across reload;
	// provenance shown.
	test.fixme("install a pack → entities resolve with pack origin chip + persist + provenance", async ({ page }) => {
		// TODO(rest):
		//   - register source + browse (as above)
		//   - choose scope via [data-testid=market-install-scope]
		//   - click [data-testid=market-install-pack]
		//   - expect [data-testid=market-installed-pack][data-pack-name=...]
		//   - visit #/roles, #/tools, #/skills → installed entities present with
		//     [data-testid=origin-pack-chip] text === pack name, and the scope
		//     origin badge ("user" for global-user scope, per §5.2)
		//   - reload → installed pack + chips persist
		//   - expect [data-testid=market-provenance] (source + commit + dates)
		await openApp(page);
	});

	// §12.3 #7 — update (re-sync upstream) and uninstall (entities disappear;
	// exactly what install added is removed).
	test.fixme("update re-syncs and uninstall removes exactly what was installed", async ({ page }) => {
		// TODO(rest):
		//   - install a pack, mutate the source dir, click
		//     [data-testid=market-update-pack] → provenance reflects new commit
		//   - click [data-testid=market-uninstall-pack] → confirm dialog →
		//     pack row gone AND its entities gone from #/roles|tools|skills
		await openApp(page);
	});

	// §12.3 #8 — tool-bearing packs show the executable-code warning before install.
	test.fixme("tool-bearing pack shows executable-code warning before install", async ({ page }) => {
		// TODO(rest): browse a pack whose contents.tools is non-empty (hasTools);
		// the card shows .market-exec-warning, and clicking
		// [data-testid=market-install-pack] opens a confirm dialog containing
		// "installs executable code that runs on your machine".
		await openApp(page);
	});

	// §12.3 #9 — same-name conflict warning + drag/move reorder flips the winner.
	test.fixme("conflict warning appears and reorder flips the winner (PUT pack-order)", async ({ page }) => {
		// TODO(rest):
		//   - install two packs (same scope) that define the same entity name →
		//     [data-testid=market-conflict-warning] appears; click it to expand
		//     [data-testid=market-conflict-details] (type/name/winner/shadowed)
		//   - reorder within the scope (drag, or the move up/down buttons which
		//     call PUT /api/marketplace/pack-order) → winner flips; the origin
		//     chip on #/roles|tools|skills updates; persists across reload
		await openApp(page);
	});
});
