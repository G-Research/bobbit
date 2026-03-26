import { test, expect } from "@playwright/test";
import path from "node:path";

const TEST_PAGE = `file://${path.resolve("tests/fixtures/stale-session-selection.html")}`;

test.describe("Stale selectedSessionId bug", () => {

	test.beforeEach(async ({ page }) => {
		await page.goto(TEST_PAGE);
		await page.evaluate(() => (window as any).__resetState());
	});

	test("selectedSessionId should be null after navigating to goal-dashboard", async ({ page }) => {
		await page.evaluate(() => {
			const w = window as any;
			w.__navigateToSession("session-A");
			w.__navigateToGoalDashboard();
		});
		const selectedId = await page.evaluate(() => (window as any).__state.selectedSessionId);
		expect(selectedId, "stale selectedSessionId not cleared after navigating to goal-dashboard").toBeNull();
	});

	test("selectedSessionId should be null after navigating to goal view", async ({ page }) => {
		await page.evaluate(() => {
			const w = window as any;
			w.__navigateToSession("session-A");
			w.__navigateToGoal();
		});
		const selectedId = await page.evaluate(() => (window as any).__state.selectedSessionId);
		expect(selectedId, "stale selectedSessionId not cleared after navigating to goal view").toBeNull();
	});

	test("selectedSessionId should be null after navigating to config page", async ({ page }) => {
		await page.evaluate(() => {
			const w = window as any;
			w.__navigateToSession("session-A");
			w.__navigateToConfigPage("roles");
		});
		const selectedId = await page.evaluate(() => (window as any).__state.selectedSessionId);
		expect(selectedId, "stale selectedSessionId not cleared after navigating to config page").toBeNull();
	});

	test("activeSessionId should return undefined on goal-dashboard with stale selectedSessionId", async ({ page }) => {
		const activeId = await page.evaluate(() => {
			const w = window as any;
			w.__navigateToSession("session-A");
			w.__navigateToGoalDashboard();
			return w.__activeSessionId();
		});
		expect(activeId, "stale activeSessionId returned on goal-dashboard — sidebar shows wrong highlight").toBeUndefined();
	});

	test("activeSessionId should return undefined on goal view with stale selectedSessionId", async ({ page }) => {
		const activeId = await page.evaluate(() => {
			const w = window as any;
			w.__navigateToSession("session-A");
			w.__navigateToGoal();
			return w.__activeSessionId();
		});
		expect(activeId, "stale activeSessionId returned on goal view — sidebar shows wrong highlight").toBeUndefined();
	});

	test("session guard should NOT short-circuit when only stale selectedSessionId matches", async ({ page }) => {
		const shouldSkip = await page.evaluate(() => {
			const w = window as any;
			w.__navigateToSession("session-A");
			w.__navigateToGoalDashboard();
			// Now: selectedSessionId="session-A", remoteAgent=null
			// Simulating browser Back to #/session/session-A
			return w.__sessionGuardShouldSkip("session-A");
		});
		expect(shouldSkip, "stale selectedSessionId causes session guard to skip reconnection on browser Back").toBe(false);
	});

	test("click handler should fire for session with stale active highlight on goal-dashboard", async ({ page }) => {
		const clickWouldFire = await page.evaluate(() => {
			const w = window as any;
			w.__navigateToSession("session-A");
			w.__navigateToGoalDashboard();
			// activeSessionId() still returns "session-A" due to stale selectedSessionId
			return w.__sessionClickWouldFire("session-A");
		});
		expect(clickWouldFire, "stale active state prevents click handler from firing — session click is a no-op").toBe(true);
	});

	test("click handler should fire for session with stale active highlight on goal view", async ({ page }) => {
		const clickWouldFire = await page.evaluate(() => {
			const w = window as any;
			w.__navigateToSession("session-A");
			w.__navigateToGoal();
			return w.__sessionClickWouldFire("session-A");
		});
		expect(clickWouldFire, "stale active state on goal view prevents click — session appears selected but is not").toBe(true);
	});
});
