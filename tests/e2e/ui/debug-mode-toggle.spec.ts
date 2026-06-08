import { test, expect, type Page } from "../gateway-harness.js";
import { openApp, navigateToHash } from "./ui-helpers.js";

// The Debug-mode toggle lives next to Restart Server and is gated to dev-harness
// mode, so opt the worker into harness mode like the restart spec. It's the
// unified switch: it shows the floating DBG client-debug button AND arms
// boot-timing perf instrumentation (both localStorage-backed).
const devHarnessTest = test.extend<{}, { enableDevHarnessRestart: boolean }>({
	enableDevHarnessRestart: [true, { scope: "worker", option: true }],
});

async function openSettings(page: Page): Promise<void> {
	await openApp(page);
	await navigateToHash(page, "#/settings/system/general");
	await expect(page.locator("h1").filter({ hasText: "Settings" })).toBeVisible({ timeout: 10_000 });
}

const toggle = (page: Page) => page.getByTestId("debug-mode-toggle");

test.describe("Debug mode toggle without dev harness", () => {
	test("is hidden when the dev harness is not active", async ({ page }) => {
		await openSettings(page);
		await expect(toggle(page)).toHaveCount(0);
	});
});

devHarnessTest.describe("Debug mode toggle with dev harness", () => {
	devHarnessTest("appears, toggles on (DBG flag + perf), persists across reload, arms instrumentation", async ({ page }) => {
		// Spy on the sink POST without blocking it — passthrough to the real
		// harness-gated endpoint so the file actually gets written.
		let bootTimingPosts = 0;
		await page.route("**/api/dev/boot-timing", async (route) => {
			if (route.request().method() === "POST") bootTimingPosts += 1;
			await route.continue();
		});

		await openSettings(page);

		// Default off.
		await expect(toggle(page)).toBeVisible({ timeout: 10_000 });
		await expect(toggle(page)).toHaveAttribute("aria-checked", "false");
		await expect(toggle(page)).toContainText("Debug Off");

		// Turn on → button reflects state; BOTH localStorage flags are armed
		// (client-debug shows the DBG button, perf arms the next reload).
		await toggle(page).click();
		await expect(toggle(page)).toHaveAttribute("aria-checked", "true");
		await expect(toggle(page)).toContainText("Debug On");
		await expect
			.poll(() => page.evaluate(() => localStorage.getItem("bobbit-client-debug")))
			.toBe("1");
		await expect
			.poll(() => page.evaluate(() => localStorage.getItem("bobbit-perf-instrumentation")))
			.toBe("1");

		// Persists across reload (localStorage mirror + server preference) …
		await page.reload();
		await expect(page.locator("button").filter({ hasText: "Settings" }).first()).toBeVisible({ timeout: 15_000 });
		await navigateToHash(page, "#/settings/system/general");
		await expect(toggle(page)).toHaveAttribute("aria-checked", "true", { timeout: 10_000 });

		// … and the armed reload actually recorded + reported a timing sample
		// (the boot waterfall the client-debug Performance section surfaces).
		await expect
			.poll(() => page.evaluate(() => (window as unknown as { __bobbitBootTimings?: { marks?: unknown[] } }).__bobbitBootTimings?.marks?.length ?? 0), { timeout: 10_000 })
			.toBeGreaterThan(0);
		await expect.poll(() => bootTimingPosts, { timeout: 10_000 }).toBeGreaterThan(0);

		// Turn back off → both mirrors cleared.
		await toggle(page).click();
		await expect(toggle(page)).toHaveAttribute("aria-checked", "false");
		await expect
			.poll(() => page.evaluate(() => localStorage.getItem("bobbit-client-debug")))
			.toBeNull();
		await expect
			.poll(() => page.evaluate(() => localStorage.getItem("bobbit-perf-instrumentation")))
			.toBeNull();
	});
});
