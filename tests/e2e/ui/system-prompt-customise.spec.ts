/**
 * Browser E2E for the Settings → General → "Customise system prompt" affordance.
 *
 * Covers (1) navigation, (2) happy-path create, (3) persistence across reload,
 * (4) repeat invocation as no-op (returns "Already exists").
 */
import { test, expect } from "../gateway-harness.js";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { openApp, navigateToHash } from "./ui-helpers.js";

function userPromptPath(): string {
	const dir = process.env.BOBBIT_DIR || "";
	return join(dir, "config", "system-prompt.md");
}

function removeUserPrompt() {
	try { unlinkSync(userPromptPath()); } catch { /* doesn't exist */ }
}

test.describe.configure({ mode: "serial" });

test.beforeAll(() => removeUserPrompt());
test.afterAll(() => removeUserPrompt());

test("Settings → General → Customise system prompt creates file then no-ops", async ({ page }) => {
	removeUserPrompt();

	await openApp(page);
	await navigateToHash(page, "#/settings/system/general");

	await expect(page.locator("h1").filter({ hasText: "Settings" })).toBeVisible({ timeout: 10_000 });

	const button = page.locator('[data-testid="general-customise-system-prompt"]');
	await expect(button).toBeVisible({ timeout: 5_000 });

	// First click — should create the file. Synchronize on the create round-trip
	// resolving before asserting the confirmation: the status text is only set in
	// customiseSystemPrompt()'s renderApp() AFTER the POST resolves (it shows
	// "Working…" in the interim), so asserting the text immediately races the
	// request and fast-fails under load.
	const createResp = page.waitForResponse(
		(r) => r.url().includes("/api/system-prompt/customise") && r.request().method() === "POST",
		{ timeout: 10_000 },
	);
	await button.click();
	await createResp;
	await expect(page.getByText(/Created /)).toBeVisible({ timeout: 5_000 });
	expect(existsSync(userPromptPath())).toBe(true);

	// Reload to ensure persistence and that the button still works after a fresh page.
	await page.reload();
	await expect(page.locator("h1").filter({ hasText: "Settings" })).toBeVisible({ timeout: 10_000 });
	const button2 = page.locator('[data-testid="general-customise-system-prompt"]');
	await expect(button2).toBeVisible({ timeout: 5_000 });

	// Second click — file already exists, expect "Already exists". Same
	// round-trip synchronization as the first click.
	const noopResp = page.waitForResponse(
		(r) => r.url().includes("/api/system-prompt/customise") && r.request().method() === "POST",
		{ timeout: 10_000 },
	);
	await button2.click();
	await noopResp;
	await expect(page.getByText(/Already exists/)).toBeVisible({ timeout: 5_000 });
});
