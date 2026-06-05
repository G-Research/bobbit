import { test, expect, type Page } from "../gateway-harness.js";
import { openApp, navigateToHash } from "./ui-helpers.js";

// The Perf-instrumentation toggle lives next to Restart Server and is gated to
// dev-harness mode, so opt the worker into harness mode like the restart spec.
const devHarnessTest = test.extend<{}, { enableDevHarnessRestart: boolean }>({
	enableDevHarnessRestart: [true, { scope: "worker", option: true }],
});

async function openSettings(page: Page): Promise<void> {
	await openApp(page);
	await navigateToHash(page, "#/settings/system/general");
	await expect(page.locator("h1").filter({ hasText: "Settings" })).toBeVisible({ timeout: 10_000 });
}

const toggle = (page: Page) => page.getByTestId("perf-instrumentation-toggle");

test.describe("Perf instrumentation toggle without dev harness", () => {
	test("is hidden when the dev harness is not active", async ({ page }) => {
		await openSettings(page);
		await expect(toggle(page)).toHaveCount(0);
	});
});

devHarnessTest.describe("Perf instrumentation toggle with dev harness", () => {
	devHarnessTest("appears, toggles on, persists across reload, and arms reload instrumentation", async ({ page }) => {
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
		await expect(toggle(page)).toContainText("Perf Off");

		// Turn on → button reflects state and the localStorage mirror is armed.
		await toggle(page).click();
		await expect(toggle(page)).toHaveAttribute("aria-checked", "true");
		await expect(toggle(page)).toContainText("Perf On");
		await expect
			.poll(() => page.evaluate(() => localStorage.getItem("bobbit-perf-instrumentation")))
			.toBe("1");

		// Persists across reload (server preference + mirror) …
		await page.reload();
		await expect(page.locator("button").filter({ hasText: "Settings" }).first()).toBeVisible({ timeout: 15_000 });
		await navigateToHash(page, "#/settings/system/general");
		await expect(toggle(page)).toHaveAttribute("aria-checked", "true", { timeout: 10_000 });

		// … and the armed reload actually recorded + reported a timing sample.
		await expect
			.poll(() => page.evaluate(() => (window as unknown as { __bobbitBootTimings?: { marks?: unknown[] } }).__bobbitBootTimings?.marks?.length ?? 0), { timeout: 10_000 })
			.toBeGreaterThan(0);
		await expect.poll(() => bootTimingPosts, { timeout: 10_000 }).toBeGreaterThan(0);

		// Turn back off → mirror cleared so the next reload is not instrumented.
		await toggle(page).click();
		await expect(toggle(page)).toHaveAttribute("aria-checked", "false");
		await expect
			.poll(() => page.evaluate(() => localStorage.getItem("bobbit-perf-instrumentation")))
			.toBeNull();
	});
});
