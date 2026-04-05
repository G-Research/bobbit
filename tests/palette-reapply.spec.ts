import { test, expect } from "@playwright/test";
import path from "node:path";

const FIXTURE = `file:///${path.resolve("tests/fixtures/palette-reapply.html").replace(/\\/g, "/")}`;

test.describe("palette reapply after session refresh", () => {
	test("BUG: palette reverts when session missing from gatewaySessions at connect time", async ({
		page,
	}) => {
		await page.goto(FIXTURE);

		// Step 1: connect to a reviewer session not yet in gatewaySessions
		await page.evaluate(() => (window as any).__simulateInitialConnect("reviewer-1"));

		// Palette should be unset (global) because session lookup returned undefined
		const paletteAfterConnect = await page.evaluate(
			() => document.documentElement.dataset.palette
		);
		expect(paletteAfterConnect).toBeUndefined();

		// Step 2: refreshSessions brings the session with its projectId
		await page.evaluate(() => (window as any).__simulateRefresh("reviewer-1", "proj-1"));

		// Step 3: current code path after refresh — NO palette re-apply (the bug)
		await page.evaluate(() =>
			(window as any).__simulatePostRefreshCurrentBehavior("reviewer-1")
		);

		// Palette is still unset — bug confirmed
		const paletteAfterBuggyRefresh = await page.evaluate(
			() => document.documentElement.dataset.palette
		);
		expect(paletteAfterBuggyRefresh).toBeUndefined();

		// CSS confirms we're on forest (default), not ocean
		const primary = await page.evaluate(() =>
			getComputedStyle(document.documentElement).getPropertyValue("--primary").trim()
		);
		expect(primary).toContain("148"); // Forest hue, not ocean's 230

		// Step 4: assert what SHOULD happen after the fix — this FAILS before the fix
		// The fix adds applyProjectPalette(sessionForRole?.projectId) after refreshSessions
		expect(
			paletteAfterBuggyRefresh,
			"palette not reapplied after refreshSessions — expected ocean but got global"
		).toBe("ocean");
	});

	test("FIXED: palette is correctly applied after refreshSessions populates session", async ({
		page,
	}) => {
		await page.goto(FIXTURE);

		// Initial connect — session missing, palette reverts
		await page.evaluate(() => (window as any).__simulateInitialConnect("reviewer-1"));
		expect(await page.evaluate(() => document.documentElement.dataset.palette)).toBeUndefined();

		// Refresh brings in the session
		await page.evaluate(() => (window as any).__simulateRefresh("reviewer-1", "proj-1"));

		// Fixed behavior: re-apply palette after refresh
		await page.evaluate(() =>
			(window as any).__simulatePostRefreshFixedBehavior("reviewer-1")
		);

		// Palette should now be ocean
		const palette = await page.evaluate(() => document.documentElement.dataset.palette);
		expect(palette).toBe("ocean");

		// CSS confirms ocean hue
		const primary = await page.evaluate(() =>
			getComputedStyle(document.documentElement).getPropertyValue("--primary").trim()
		);
		expect(primary).toContain("230");
	});
});
