import { test, expect } from "@playwright/test";
import path from "node:path";

const TEST_PAGE = `file://${path.resolve("tests/fixtures/stale-session-selection.html")}`;

test.describe("Stale selectedSessionId bug", () => {

	test("activeSessionId should be undefined after navigating to goal view", async ({ page }) => {
		await page.goto(TEST_PAGE);

		// Connect to session-123
		await page.evaluate(() => (window as any).__test.simulateConnectToSession("session-123"));

		// Verify session is active
		let active = await page.evaluate(() => (window as any).__test.activeSessionId());
		expect(active).toBe("session-123");

		// Navigate to goal view (disconnects remoteAgent but current code does NOT clear selectedSessionId)
		await page.evaluate(() => (window as any).__test.simulateNavigateToGoalView("goal-abc"));

		// remoteAgent should be null
		const agent = await page.evaluate(() => (window as any).__test.state.remoteAgent);
		expect(agent).toBeNull();

		// BUG: activeSessionId() still returns "session-123" because selectedSessionId was not cleared.
		// The DESIRED behavior is that it returns undefined after navigating away.
		active = await page.evaluate(() => (window as any).__test.activeSessionId());
		expect(active, "expected activeSessionId to be undefined after navigating to goal view").toBeUndefined();
	});

	test("activeSessionId should be undefined after navigating to goal dashboard", async ({ page }) => {
		await page.goto(TEST_PAGE);

		await page.evaluate(() => (window as any).__test.simulateConnectToSession("session-456"));
		let active = await page.evaluate(() => (window as any).__test.activeSessionId());
		expect(active).toBe("session-456");

		// Navigate to goal dashboard
		await page.evaluate(() => (window as any).__test.simulateNavigateToGoalDashboard("goal-xyz"));

		const agent = await page.evaluate(() => (window as any).__test.state.remoteAgent);
		expect(agent).toBeNull();

		active = await page.evaluate(() => (window as any).__test.activeSessionId());
		expect(active, "expected activeSessionId to be undefined after navigating to goal dashboard").toBeUndefined();
	});

	test("activeSessionId should be undefined after navigating to landing", async ({ page }) => {
		await page.goto(TEST_PAGE);

		await page.evaluate(() => (window as any).__test.simulateConnectToSession("session-789"));
		let active = await page.evaluate(() => (window as any).__test.activeSessionId());
		expect(active).toBe("session-789");

		// Navigate to landing page
		await page.evaluate(() => (window as any).__test.simulateNavigateToLanding());

		const agent = await page.evaluate(() => (window as any).__test.state.remoteAgent);
		expect(agent).toBeNull();

		active = await page.evaluate(() => (window as any).__test.activeSessionId());
		expect(active, "expected activeSessionId to be undefined after navigating to landing").toBeUndefined();
	});

	test("backToSessions correctly clears selectedSessionId (reference behavior)", async ({ page }) => {
		await page.goto(TEST_PAGE);

		await page.evaluate(() => (window as any).__test.simulateConnectToSession("session-aaa"));
		let active = await page.evaluate(() => (window as any).__test.activeSessionId());
		expect(active).toBe("session-aaa");

		// backToSessions correctly clears selectedSessionId
		await page.evaluate(() => (window as any).__test.simulateBackToSessions());

		active = await page.evaluate(() => (window as any).__test.activeSessionId());
		expect(active).toBeUndefined();
	});

	test("config page navigation returns undefined (already working)", async ({ page }) => {
		await page.goto(TEST_PAGE);

		await page.evaluate(() => (window as any).__test.simulateConnectToSession("session-bbb"));
		let active = await page.evaluate(() => (window as any).__test.activeSessionId());
		expect(active).toBe("session-bbb");

		// Navigate to a config page — isConfigPageRoute() override makes activeSessionId return undefined
		await page.evaluate(() => (window as any).__test.simulateNavigateToConfigPage("roles"));

		active = await page.evaluate(() => (window as any).__test.activeSessionId());
		expect(active).toBeUndefined();
	});

	test("normal session switching works correctly", async ({ page }) => {
		await page.goto(TEST_PAGE);

		// Connect to session A
		await page.evaluate(() => (window as any).__test.simulateConnectToSession("session-A"));
		let active = await page.evaluate(() => (window as any).__test.activeSessionId());
		expect(active).toBe("session-A");

		// Switch to session B
		await page.evaluate(() => (window as any).__test.simulateConnectToSession("session-B"));
		active = await page.evaluate(() => (window as any).__test.activeSessionId());
		expect(active).toBe("session-B");

		// Switch back to session A
		await page.evaluate(() => (window as any).__test.simulateConnectToSession("session-A"));
		active = await page.evaluate(() => (window as any).__test.activeSessionId());
		expect(active).toBe("session-A");
	});
});
