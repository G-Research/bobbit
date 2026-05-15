/**
 * Browser E2E — CostPopover renders the derived `cacheHitRate` field on the
 * goal-dashboard cost popover, surviving a full page reload.
 *
 * The CostPopover lives in two surfaces (session stats-bar + goal-dashboard
 * meta-row); the goal-dashboard variant is the easier test bed because:
 *   - the dashboard fetches `/api/goals/<id>/cost` on entry, and only the
 *     non-zero `totalCost` branch renders the clickable `$` trigger that
 *     opens the popover.
 *   - the popover fetches `/api/goals/<id>/cost/breakdown` on open.
 * We mock both endpoints with `page.route()` so the test is independent of
 * how the server derives `cacheHitRate`. (Server derivation has its own
 * unit + API-E2E coverage.)
 *
 * UI contract under test (CostPopover.ts::_renderCacheHitRow):
 *   - The aggregate breakdown ALWAYS renders a stable "Cache hit" row
 *     (`data-testid="cost-cache-hit"`), even when the value is null/missing.
 *   - Numeric `cacheHitRate` is shown as a whole-percent (e.g. 0.75 -> "75%").
 *   - Missing / null / non-finite values render as an em dash (—),
 *     never "0%" — that's the rule the design doc pins.
 */
import { test, expect } from "../gateway-harness.js";
import { createGoal, deleteGoal } from "../e2e-setup.js";
import { openApp, navigateToGoalDashboard } from "./ui-helpers.js";

test.describe("CostPopover cache-hit row", () => {
	test("renders cacheHitRate as a percent and persists across reload @smoke", async ({ page }) => {
		const goal = await createGoal({ title: `Cache-hit popover ${Date.now()}` });
		const goalId = goal.id;

		try {
			// Mock both the polled cost summary and the on-open breakdown so the
			// dashboard sees totalCost>0 (renders the $ trigger) and the popover
			// receives a deterministic payload with cacheHitRate=0.75.
			const aggregate = {
				inputTokens: 100,
				outputTokens: 50,
				cacheReadTokens: 300,
				cacheWriteTokens: 0,
				totalCost: 0.01,
				cacheHitRate: 0.75,
			};
			await page.route(/\/api\/goals\/[^/]+\/cost(?:\?.*)?$/, async (route, req) => {
				if (req.method() !== "GET") return route.fallback();
				await route.fulfill({
					status: 200,
					contentType: "application/json",
					body: JSON.stringify(aggregate),
				});
			});
			await page.route(/\/api\/goals\/[^/]+\/cost\/breakdown(?:\?.*)?$/, async (route, req) => {
				if (req.method() !== "GET") return route.fallback();
				await route.fulfill({
					status: 200,
					contentType: "application/json",
					body: JSON.stringify({ aggregate, sessions: [] }),
				});
			});

			await openApp(page);
			await navigateToGoalDashboard(page, goalId);

			// The $ cost trigger only renders when totalCost > 0. Our mock supplies
			// 0.01, so the cost-tag must be visible. Click it to open the popover.
			const costTag = page.locator(".cost-tag").first();
			await expect(costTag).toBeVisible({ timeout: 15_000 });
			await costTag.click();

			// Popover loads /cost/breakdown asynchronously. The Cache hit row is
			// always rendered (even for null), so wait on the testid then assert
			// the percent text.
			const cacheHitRow = page.locator('[data-testid="cost-cache-hit"]').first();
			await expect(cacheHitRow).toBeVisible({ timeout: 10_000 });
			await expect(cacheHitRow).toContainText("Cache hit");
			await expect(cacheHitRow).toContainText("75%");

			// Persistence: reload, re-open the popover, re-assert. Because
			// `cacheHitRate` is derived server-side from raw counters, a
			// returning user must see the same value after refresh.
			await page.reload();
			// page.route registrations survive reload in Playwright.
			await navigateToGoalDashboard(page, goalId);

			const costTagAfter = page.locator(".cost-tag").first();
			await expect(costTagAfter).toBeVisible({ timeout: 15_000 });
			await costTagAfter.click();

			const cacheHitRowAfter = page.locator('[data-testid="cost-cache-hit"]').first();
			await expect(cacheHitRowAfter).toBeVisible({ timeout: 10_000 });
			await expect(cacheHitRowAfter).toContainText("75%");
		} finally {
			await deleteGoal(goalId);
		}
	});

	test("renders em dash when cacheHitRate is missing or null", async ({ page }) => {
		// Older servers / cold sessions report cost without `cacheHitRate`.
		// The UI must render "—", never "0%".
		const goal = await createGoal({ title: `Cache-hit popover null ${Date.now()}` });
		const goalId = goal.id;

		try {
			// No cacheHitRate field at all — simulates an older server payload.
			const aggregate = {
				inputTokens: 0,
				outputTokens: 50,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				totalCost: 0.01,
			};
			await page.route(/\/api\/goals\/[^/]+\/cost(?:\?.*)?$/, async (route, req) => {
				if (req.method() !== "GET") return route.fallback();
				await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(aggregate) });
			});
			await page.route(/\/api\/goals\/[^/]+\/cost\/breakdown(?:\?.*)?$/, async (route, req) => {
				if (req.method() !== "GET") return route.fallback();
				await route.fulfill({
					status: 200,
					contentType: "application/json",
					body: JSON.stringify({ aggregate: { ...aggregate, cacheHitRate: null }, sessions: [] }),
				});
			});

			await openApp(page);
			await navigateToGoalDashboard(page, goalId);

			const costTag = page.locator(".cost-tag").first();
			await expect(costTag).toBeVisible({ timeout: 15_000 });
			await costTag.click();

			const cacheHitRow = page.locator('[data-testid="cost-cache-hit"]').first();
			await expect(cacheHitRow).toBeVisible({ timeout: 10_000 });
			await expect(cacheHitRow).toContainText("Cache hit");
			// Em dash, NOT "0%".
			await expect(cacheHitRow).toContainText("\u2014");
			await expect(cacheHitRow).not.toContainText("0%");
		} finally {
			await deleteGoal(goalId);
		}
	});
});
