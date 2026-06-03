/**
 * Marketplace MVP — mandatory browser E2E.
 *
 * Drives the full user-facing flow described in docs/design/marketplace-mvp.md
 * §11 and the goal's acceptance criteria, end to end through the real UI:
 *
 *   1. The "Market" sidebar button is present BETWEEN "Workflows" and
 *      "New Goal" and opens the marketplace surface.
 *   2. Add a local source pointing at the committed fixture source tree
 *      tests/fixtures/marketplace/source-a/.
 *   3. Browse the packs it contains — the tool-bearing pack shows the
 *      "executable code" badge, and the broken pack surfaces its error.
 *   4. Install the tool-bearing pack at PROJECT scope; the "installs
 *      executable code" confirmation gate must appear before the install runs.
 *   5. The pack's role then resolves on the Roles page with a "project"
 *      origin badge — i.e. it flows through ConfigCascade exactly like a
 *      hand-authored role.
 *   6. The install persists across a full page reload.
 *   7. Uninstalling the pack removes exactly what it installed — the role
 *      disappears from the Roles page again.
 *
 * Canonical pattern: tests/e2e/ui/workflow-page-scope.spec.ts
 *                    tests/e2e/ui/settings.spec.ts
 *
 * The server-side pack scanner / install engine are covered by unit tests
 * against the same fixture tree (tests/marketplace-*.test.ts); this spec
 * proves the wired-up UI path the user actually walks.
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch, defaultProject } from "../e2e-setup.js";
import { openApp, navigateToHash } from "./ui-helpers.js";
import type { Page, Locator } from "@playwright/test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Committed fixture source tree (also exercised by the marketplace unit tests).
// Absolute path is required: local sources must be absolute + existing dirs.
const SOURCE_A = join(__dirname, "..", "..", "fixtures", "marketplace", "source-a");

// The mini-lit Dialog modal — both confirmAction() and the add-source dialog
// render into this container. Scoping button clicks to it disambiguates the
// dialog's own action button from same-labelled buttons on the page behind it.
const DIALOG = '[class*="shadow-xl"]';

const RESEARCH_CARD = '[data-testid="market-pack-card"][data-pack-id="research-pack"]';
const INVALID_CARD = '[data-testid="market-pack-card"][data-pack-id="invalid-pack"]';

/** Click a config-scope tab (System / a project name) inside a config page. */
async function selectScopeTab(page: Page, containerSelector: string, tabName: string): Promise<void> {
	await page
		.locator(containerSelector)
		.getByRole("button", { name: tabName, exact: true })
		.first()
		.click();
}

/** The install-status badge for a pack card (data-status drives the assertion). */
function statusBadge(card: Locator): Locator {
	return card.locator('[data-testid="market-install-status"]');
}

test.describe("Marketplace MVP", () => {
	let projectName: string;
	let projectId: string;

	// The gateway is worker-scoped, so the source registry + any installed
	// provenance persist across test runs (and across Playwright retries).
	// Reset to a clean slate before each run so the test is idempotent: drop
	// every configured source and uninstall research-pack at project scope.
	async function resetMarketplace(): Promise<void> {
		try {
			const res = await apiFetch("/api/marketplace/sources");
			if (!res.ok) return;
			const { sources } = await res.json();
			for (const s of sources ?? []) {
				await apiFetch("/api/marketplace/uninstall", {
					method: "POST",
					body: JSON.stringify({ sourceId: s.id, packId: "research-pack", scope: "project", projectId }),
				}).catch(() => {});
				await apiFetch(`/api/marketplace/sources/${encodeURIComponent(s.id)}`, { method: "DELETE" }).catch(() => {});
			}
		} catch { /* best-effort */ }
	}

	test.beforeAll(async () => {
		const proj = await defaultProject();
		projectName = proj.name || "default";
		projectId = proj.id;
	});

	test.beforeEach(async () => {
		await resetMarketplace();
	});

	test.afterAll(async () => {
		await resetMarketplace();
	});

	test("Market button → add source → browse → install at project scope → role resolves → persists → uninstall @smoke", async ({ page }) => {
		await openApp(page);

		// ── 1. Sidebar Market button: present and ordered between Workflows and New Goal ──
		const marketBtn = page.locator('[data-testid="sidebar-market-button"]');
		await expect(marketBtn).toBeVisible({ timeout: 15_000 });

		const order = await page.evaluate(() => {
			const buttons = Array.from(document.querySelectorAll("button"));
			const workflows = buttons.find((b) => b.title === "Manage workflows") || null;
			const market = document.querySelector('[data-testid="sidebar-market-button"]');
			const newGoal = document.querySelector("[data-new-goal-trigger]");
			if (!workflows || !market || !newGoal) return null;
			const FOLLOWING = Node.DOCUMENT_POSITION_FOLLOWING;
			return {
				workflowsBeforeMarket: !!(workflows.compareDocumentPosition(market) & FOLLOWING),
				marketBeforeNewGoal: !!(market.compareDocumentPosition(newGoal) & FOLLOWING),
			};
		});
		expect(order).toEqual({ workflowsBeforeMarket: true, marketBeforeNewGoal: true });

		// Opening the marketplace surface.
		await marketBtn.click();
		await expect(page.locator(".market-container")).toBeVisible({ timeout: 10_000 });
		await expect(page.locator(".market-title").first()).toHaveText("Market");

		// ── 2. Add a local source pointing at the fixture tree ──
		await page.locator('[data-testid="market-add-source"]').click();
		await expect(page.locator('[data-testid="market-source-dialog"]')).toBeVisible({ timeout: 10_000 });
		await page.locator('[data-testid="market-kind-local"]').click();
		const pathInput = page.locator('[data-testid="market-source-path"]');
		await expect(pathInput).toBeVisible();
		await pathInput.fill(SOURCE_A);
		await page.locator(DIALOG).getByRole("button", { name: "Add source", exact: true }).click();
		await expect(page.locator('[data-testid="market-source-dialog"]')).toHaveCount(0, { timeout: 10_000 });

		// Source row appears.
		await expect(page.locator('[data-testid="market-source-row"]')).toHaveCount(1, { timeout: 10_000 });

		// ── 3. Browse packs: exec-code badge + invalid-pack error ──
		const researchCard = page.locator(RESEARCH_CARD);
		await expect(researchCard).toBeVisible({ timeout: 10_000 });
		// research-pack ships a tool → executable-code badge present.
		await expect(researchCard.locator('[data-testid="market-exec-code-badge"]')).toBeVisible();

		// invalid-pack declares a role that does not exist on disk → flagged, not installable.
		const invalidCard = page.locator(INVALID_CARD);
		await expect(invalidCard).toBeVisible();
		await expect(invalidCard).toHaveAttribute("data-valid", "false");
		await expect(invalidCard.locator('[data-testid="market-pack-invalid"]')).toBeVisible();
		await expect(invalidCard.locator('[data-testid="market-pack-error"]')).toContainText("missing-role");

		// ── 4. Install research-pack at PROJECT scope (confirm the exec-code warning) ──
		await selectScopeTab(page, ".market-container", projectName);
		// Wait for the project-scope re-render to settle (card re-rendered, not installed yet).
		await expect(researchCard).toBeVisible({ timeout: 10_000 });
		await expect(statusBadge(researchCard)).toHaveAttribute("data-status", "not-installed", { timeout: 10_000 });

		await researchCard.locator('[data-testid="market-install-btn"]').click();

		// The "installs executable code" confirmation gate must appear first.
		const confirmDialog = page.locator(DIALOG).filter({ hasText: "Install executable code" });
		await expect(confirmDialog).toBeVisible({ timeout: 10_000 });
		await expect(confirmDialog).toContainText("installs executable code");
		await confirmDialog.getByRole("button", { name: "Install", exact: true }).click();

		// Pack reports installed.
		await expect(statusBadge(researchCard)).toHaveAttribute("data-status", "installed", { timeout: 15_000 });

		// ── 5. The pack's role resolves on the Roles page with a project origin ──
		await navigateToHash(page, "#/roles");
		await expect(page.locator(".roles-container")).toBeVisible({ timeout: 10_000 });
		await selectScopeTab(page, ".roles-container", projectName);

		const researcherRow = page.locator(".role-row").filter({ hasText: "researcher" });
		await expect(researcherRow).toHaveCount(1, { timeout: 10_000 });
		await expect(researcherRow.locator(".config-origin-badge")).toHaveText("project");

		// ── 6. Persists across a full page reload ──
		await page.reload();
		await expect(page.locator("button").filter({ hasText: "Settings" }).first()).toBeVisible({ timeout: 20_000 });

		// Install + provenance survived: pack still shows installed at project scope.
		await navigateToHash(page, "#/market");
		await expect(page.locator(".market-container")).toBeVisible({ timeout: 10_000 });
		await selectScopeTab(page, ".market-container", projectName);
		const researchCardAfter = page.locator(RESEARCH_CARD);
		await expect(statusBadge(researchCardAfter)).toHaveAttribute("data-status", "installed", { timeout: 15_000 });

		// Role still resolves at project scope after reload.
		await navigateToHash(page, "#/roles");
		await expect(page.locator(".roles-container")).toBeVisible({ timeout: 10_000 });
		await selectScopeTab(page, ".roles-container", projectName);
		await expect(page.locator(".role-row").filter({ hasText: "researcher" })).toHaveCount(1, { timeout: 10_000 });

		// ── 7. Uninstall removes exactly what it installed ──
		await navigateToHash(page, "#/market");
		await expect(page.locator(".market-container")).toBeVisible({ timeout: 10_000 });
		await selectScopeTab(page, ".market-container", projectName);
		await expect(statusBadge(researchCardAfter)).toHaveAttribute("data-status", "installed", { timeout: 10_000 });

		await researchCardAfter.locator('[data-testid="market-uninstall-btn"]').click();
		const uninstallDialog = page.locator(DIALOG).filter({ hasText: "Uninstall pack" });
		await expect(uninstallDialog).toBeVisible({ timeout: 10_000 });
		await uninstallDialog.getByRole("button", { name: "Uninstall", exact: true }).click();

		// Pack returns to not-installed.
		await expect(statusBadge(researchCardAfter)).toHaveAttribute("data-status", "not-installed", { timeout: 15_000 });

		// Role is gone from the Roles page at project scope.
		await navigateToHash(page, "#/roles");
		await expect(page.locator(".roles-container")).toBeVisible({ timeout: 10_000 });
		await selectScopeTab(page, ".roles-container", projectName);
		await expect(page.locator(".role-row").filter({ hasText: "researcher" })).toHaveCount(0, { timeout: 10_000 });
	});
});
