import { test, expect } from "@playwright/test";
import path from "node:path";

const TEST_PAGE = `file://${path.resolve("tests/hashchange-greeting-race.html")}`;

test.describe("Hashchange greeting race condition", () => {
	test("greeting fires when connectToSession races with hashchange", async ({ page }) => {
		await page.goto(TEST_PAGE);
		await expect(page.locator("#status")).toHaveText("loaded");

		// Simulate the race: connectToSession("sess-1", false, { assistantType: "goal" })
		// This triggers:
		//   1. selectSession sets selectedSessionId="sess-1", sets hash → queues async hashchange
		//   2. connectToSession sets connectingSessionId="sess-1"
		//   3. await remote.connect() yields → hashchange fires
		//   4. handleHashChange sees session route, checks state.remoteAgent (null) → calls connectToSession("sess-1", true)
		//   5. Second call bumps switchGeneration → first call becomes stale, skips greeting
		//   6. Second call has isExisting=true, no assistantType → no greeting
		// Result: greeting is SUPPRESSED (bug)
		const result = await page.evaluate(() => (window as any).__simulateRace("sess-1", "goal"));

		// The greeting SHOULD have fired. With the buggy code, it doesn't.
		// This assertion will FAIL until the fix is applied.
		expect(result.greetingSent).toBe(true);
		expect(result.greetingMessage).toContain("goal");
	});

	test("handleHashChange fires duplicate connectToSession during connecting", async ({ page }) => {
		await page.goto(TEST_PAGE);
		await expect(page.locator("#status")).toHaveText("loaded");

		const result = await page.evaluate(() => (window as any).__simulateRace("sess-1", "goal"));

		// With the bug: handleHashChange fires and calls connectToSession a second time.
		// The buggy guard (state.remoteAgent?.gatewaySessionId) doesn't catch in-flight connections.
		// This proves the race exists: handleHashChange should NOT have called connectToSession,
		// but with the buggy guard it does.
		//
		// After the fix, handleHashChange will bail out (selectedSessionId matches),
		// so handleHashChangeCalls will be 0 and total connectCalls will be 1.
		expect(result.handleHashChangeCalls).toBe(0);
	});
});
