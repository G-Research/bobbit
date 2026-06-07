/**
 * Browser E2E coverage for the Subgoals (Experimental) toggle.
 *
 * Four scenarios per AGENTS.md "E2E coverage requirement":
 *   1. Navigation — toggle visible in Settings → System → General with the
 *      Experimental pill rendered.
 *   2. Happy path — flip ON, the synchronous dataset flag flips, and the
 *      flag persists in /api/preferences.
 *   3. Persistence across reload — flip OFF, reload, still OFF.
 *   4. Cleanup/undo — flip back ON, dataset and checkbox state agree.
 *
 * The harness defaults `subgoalsEnabled: true`. Each test resets via the
 * REST PUT it exercises, so cross-test interference is avoided.
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch } from "../e2e-setup.js";
import { openApp, navigateToHash } from "./ui-helpers.js";

/** Reset the flag at the API layer so each test starts deterministically. */
async function resetFlag(value: boolean): Promise<void> {
	const resp = await apiFetch("/api/preferences", {
		method: "PUT",
		body: JSON.stringify({ subgoalsEnabled: value }),
	});
	expect(resp.status).toBe(200);
}

/**
 * Remove the stored pref entirely (PUT null deletes the key) so the UI sees an
 * unset/missing value — the production default path.
 */
async function unsetFlag(): Promise<void> {
	const resp = await apiFetch("/api/preferences", {
		method: "PUT",
		body: JSON.stringify({ subgoalsEnabled: null }),
	});
	expect(resp.status).toBe(200);
}

test.describe("Subgoals (Experimental) toggle", () => {
	test("defaults ON when the pref is unset, and persists across reload", async ({ page }) => {
		// Production default: unset/missing reads as enabled (mirrors the server's
		// `subgoalsEnabled !== false` gate). G1 fix — UI must not default OFF.
		await unsetFlag();
		await openApp(page);
		await navigateToHash(page, "#/settings/system/general");

		const checkbox = page.locator("[data-testid='general-subgoals-enabled']");
		await expect(checkbox).toBeVisible({ timeout: 10_000 });
		await expect(checkbox).toBeChecked();
		await expect.poll(
			() => page.evaluate(() => document.documentElement.dataset.subgoalsEnabled),
		).toBe("true");

		// Reload — still ON (pref still unset, default holds).
		await page.reload();
		await expect(
			page.locator("button").filter({ hasText: "Settings" }).first(),
		).toBeVisible({ timeout: 15_000 });
		await navigateToHash(page, "#/settings/system/general");
		const afterReload = page.locator("[data-testid='general-subgoals-enabled']");
		await expect(afterReload).toBeVisible({ timeout: 5_000 });
		await expect(afterReload).toBeChecked();
		await expect.poll(
			() => page.evaluate(() => document.documentElement.dataset.subgoalsEnabled),
		).toBe("true");

		// Restore the harness default for subsequent specs/tests.
		await resetFlag(true);
	});

	test("renders in Settings → System → General with Experimental pill @smoke", async ({ page }) => {
		await resetFlag(true);
		await openApp(page);
		await navigateToHash(page, "#/settings/system/general");

		await expect(page.getByText("Show message timestamps")).toBeVisible({ timeout: 10_000 });
		const checkbox = page.locator("[data-testid='general-subgoals-enabled']");
		await expect(checkbox).toBeVisible({ timeout: 5_000 });
		const pill = page.locator("[data-testid='experimental-pill']").first();
		await expect(pill).toBeVisible();
		await expect(pill).toHaveText(/experimental/i);
	});

	test("toggle ON path: dataset flips synchronously and PUT /api/preferences fires", async ({ page }) => {
		await resetFlag(false);
		await openApp(page);
		await navigateToHash(page, "#/settings/system/general");

		const checkbox = page.locator("[data-testid='general-subgoals-enabled']");
		await expect(checkbox).toBeVisible({ timeout: 10_000 });
		await expect(checkbox).not.toBeChecked();
		await expect.poll(
			() => page.evaluate(() => document.documentElement.dataset.subgoalsEnabled),
		).toBe("false");

		const responsePromise = page.waitForResponse(
			resp => resp.url().includes("/api/preferences")
				&& resp.request().method() === "PUT"
				&& resp.status() === 200,
		);
		await checkbox.click();
		await expect(checkbox).toBeChecked();
		await expect.poll(
			() => page.evaluate(() => document.documentElement.dataset.subgoalsEnabled),
		).toBe("true");
		await responsePromise;
	});

	test("persists OFF state across reload", async ({ page }) => {
		await resetFlag(false);
		await openApp(page);
		await navigateToHash(page, "#/settings/system/general");

		const checkbox = page.locator("[data-testid='general-subgoals-enabled']");
		await expect(checkbox).toBeVisible({ timeout: 10_000 });
		await expect(checkbox).not.toBeChecked();

		await page.reload();
		await expect(
			page.locator("button").filter({ hasText: "Settings" }).first(),
		).toBeVisible({ timeout: 15_000 });
		await navigateToHash(page, "#/settings/system/general");
		const afterReload = page.locator("[data-testid='general-subgoals-enabled']");
		await expect(afterReload).toBeVisible({ timeout: 5_000 });
		await expect(afterReload).not.toBeChecked();
		await expect.poll(
			() => page.evaluate(() => document.documentElement.dataset.subgoalsEnabled),
		).toBe("false");
	});

	test("cleanup/undo: flip back ON and the dataset / checkbox agree", async ({ page }) => {
		await resetFlag(false);
		await openApp(page);
		await navigateToHash(page, "#/settings/system/general");

		const checkbox = page.locator("[data-testid='general-subgoals-enabled']");
		await expect(checkbox).toBeVisible({ timeout: 10_000 });
		await expect(checkbox).not.toBeChecked();

		const onResp = page.waitForResponse(
			r => r.url().includes("/api/preferences") && r.request().method() === "PUT" && r.status() === 200,
		);
		await checkbox.click();
		await expect(checkbox).toBeChecked();
		await onResp;
		await expect.poll(
			() => page.evaluate(() => document.documentElement.dataset.subgoalsEnabled),
		).toBe("true");

		// Reload — still ON.
		await page.reload();
		await expect(
			page.locator("button").filter({ hasText: "Settings" }).first(),
		).toBeVisible({ timeout: 15_000 });
		await navigateToHash(page, "#/settings/system/general");
		const final = page.locator("[data-testid='general-subgoals-enabled']");
		await expect(final).toBeChecked();
	});
});
