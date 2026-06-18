/**
 * Retained spawned-gateway smokes for CostPopover cache-hit display.
 * Boundary formatting and component fetch behavior live in tests/context-cost-stats.spec.ts.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "../gateway-harness.js";
import type { GatewayInfo } from "../gateway-harness.js";
import { createGoal, deleteGoal, createSession, deleteSession, waitForSessionStatus } from "../e2e-setup.js";
import { openApp, navigateToGoalDashboard, navigateToHash } from "./ui-helpers.js";

interface CostAggregate {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalCost: number;
	cacheHitRate?: number | null;
}

const BASE_AGGREGATE: CostAggregate = {
	inputTokens: 100,
	outputTokens: 50,
	cacheReadTokens: 300,
	cacheWriteTokens: 0,
	totalCost: 0.01,
	cacheHitRate: 0.75,
};

async function routeGoalCost(page: Page, aggregate: CostAggregate): Promise<void> {
	await page.route(/\/api\/goals\/[^/]+\/cost(?:\?.*)?$/, async (route, req) => {
		if (req.method() !== "GET") return route.fallback();
		await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(aggregate) });
	});
	await page.route(/\/api\/goals\/[^/]+\/cost\/breakdown(?:\?.*)?$/, async (route, req) => {
		if (req.method() !== "GET") return route.fallback();
		await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ aggregate, sessions: [] }) });
	});
}

async function seedSessionCost(gateway: GatewayInfo, sessionId: string): Promise<CostAggregate> {
	const session = gateway.sessionManager?.getSession(sessionId);
	if (!session?.projectId) throw new Error(`session ${sessionId} missing projectId`);
	return gateway.sessionManager.getCostTracker(session.projectId).recordUsage(sessionId, {
		inputTokens: 100,
		outputTokens: 50,
		cacheReadTokens: 300,
		cacheWriteTokens: 0,
		cost: 0.2,
	}) as CostAggregate;
}

test.describe("CostPopover cache-hit row", () => {
	test("goal-dashboard cost popover shows cacheHitRate and survives reload @smoke", async ({ page }) => {
		const goal = await createGoal({ title: `Cache-hit popover ${Date.now()}` });
		try {
			await routeGoalCost(page, BASE_AGGREGATE);
			await openApp(page);
			await navigateToGoalDashboard(page, goal.id);

			await page.locator(".cost-tag").first().click();
			await expect(page.locator('[data-testid="cost-cache-hit"]').first()).toContainText("75%", { timeout: 10_000 });

			await page.reload();
			await navigateToGoalDashboard(page, goal.id);
			await page.locator(".cost-tag").first().click();
			await expect(page.locator('[data-testid="cost-cache-hit"]').first()).toContainText("75%", { timeout: 10_000 });
		} finally {
			await deleteGoal(goal.id).catch(() => {});
		}
	});

	test("session stats-bar cost popover shows server-derived cacheHitRate @smoke", async ({ page, gateway }) => {
		const sessionId = await createSession();
		try {
			await waitForSessionStatus(sessionId, "idle");
			const seeded = await seedSessionCost(gateway, sessionId);
			expect(seeded.cacheHitRate).toBe(0.75);

			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });

			const costTrigger = page.locator("agent-interface").getByText("$0.2", { exact: true }).first();
			await expect(costTrigger).toBeVisible({ timeout: 10_000 });
			await costTrigger.click();

			const cacheHitRow = page.locator('agent-interface cost-popover [data-testid="cost-cache-hit"]').first();
			await expect(cacheHitRow).toBeVisible({ timeout: 10_000 });
			await expect(cacheHitRow).toContainText("75%");
		} finally {
			await deleteSession(sessionId).catch(() => {});
		}
	});
});
