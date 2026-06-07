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
 * REST PUT it exercises, so cross-test interference is avoided. A fresh
 * install (no stored pref) now reads as disabled — the default is OFF.
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch } from "../e2e-setup.js";
import { openApp, navigateToHash, sendMessage, createSessionViaUI } from "./ui-helpers.js";

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
	test("defaults OFF when the pref is unset, and persists across reload", async ({ page }) => {
		// Fresh-install default: unset/missing reads as disabled (mirrors the
		// server's `subgoalsEnabled === true` gate). The user opts in via Settings.
		await unsetFlag();
		await openApp(page);
		await navigateToHash(page, "#/settings/system/general");

		const checkbox = page.locator("[data-testid='general-subgoals-enabled']");
		await expect(checkbox).toBeVisible({ timeout: 10_000 });
		await expect(checkbox).not.toBeChecked();
		await expect.poll(
			() => page.evaluate(() => document.documentElement.dataset.subgoalsEnabled),
		).toBe("false");

		// Reload — still OFF (pref still unset, default holds).
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

	test("ON→OFF cleanup: flip OFF from ON and the dataset / checkbox agree across reload", async ({ page }) => {
		await resetFlag(true);
		await openApp(page);
		await navigateToHash(page, "#/settings/system/general");

		const checkbox = page.locator("[data-testid='general-subgoals-enabled']");
		await expect(checkbox).toBeVisible({ timeout: 10_000 });
		await expect(checkbox).toBeChecked();
		await expect.poll(
			() => page.evaluate(() => document.documentElement.dataset.subgoalsEnabled),
		).toBe("true");

		const offResp = page.waitForResponse(
			r => r.url().includes("/api/preferences") && r.request().method() === "PUT" && r.status() === 200,
		);
		await checkbox.click();
		await expect(checkbox).not.toBeChecked();
		await offResp;
		await expect.poll(
			() => page.evaluate(() => document.documentElement.dataset.subgoalsEnabled),
		).toBe("false");

		// Reload — still OFF.
		await page.reload();
		await expect(
			page.locator("button").filter({ hasText: "Settings" }).first(),
		).toBeVisible({ timeout: 15_000 });
		await navigateToHash(page, "#/settings/system/general");
		const final = page.locator("[data-testid='general-subgoals-enabled']");
		await expect(final).toBeVisible({ timeout: 5_000 });
		await expect(final).not.toBeChecked();
		await expect.poll(
			() => page.evaluate(() => document.documentElement.dataset.subgoalsEnabled),
		).toBe("false");

		// Restore the harness default for subsequent specs/tests.
		await resetFlag(true);
	});

	test("proposal panel renders the per-goal subgoal controls when subgoals are ON", async ({ page }) => {
		// The per-goal Allow-subgoals / Max-depth controls live on the
		// regular-session goal-proposal panel (renderGoalForm wired with
		// onSubgoalsAllowedChange + subgoalsEnabled), gated by isSubgoalsEnabled().
		// Set the pref BEFORE opening the app so the dataset flag is correct on
		// first paint (isSubgoalsEnabled() reads the dataset at render time).
		await resetFlag(true);
		await openApp(page);
		await createSessionViaUI(page);

		// Mock agent emits a propose_goal titled "E2E Test Goal" when the prompt
		// contains "GOAL_PROPOSAL".
		await sendMessage(page, "Please create a GOAL_PROPOSAL for testing");

		const titleInput = page.locator("input[placeholder='Goal title']").first();
		await expect(titleInput).toBeVisible({ timeout: 20_000 });
		await expect(titleInput).toHaveValue("E2E Test Goal", { timeout: 15_000 });

		// With subgoals ON, the per-goal nesting controls are collated under the
		// dedicated "Sub-goals" tab.
		const subgoalsTab = page.locator("[data-testid='goal-proposal-tab-subgoals']");
		await expect(subgoalsTab).toBeVisible({ timeout: 10_000 });
		await subgoalsTab.click();

		const subgoalsToggle = page.locator("[data-testid='goal-form-subgoals-toggle']");
		await expect(subgoalsToggle).toBeVisible({ timeout: 10_000 });
		// Enabling Allow-subgoals reveals the Max-depth input.
		await subgoalsToggle.click();
		await expect(
			page.locator("[data-testid='goal-form-max-depth']"),
		).toBeVisible({ timeout: 10_000 });

		// For a top-level (root) goal that allows subgoals, the root-only
		// orchestration controls also appear: concurrency cap + divergence policy.
		await expect(
			page.locator("[data-testid='goal-form-max-concurrent-children']"),
		).toBeVisible({ timeout: 10_000 });
		await expect(
			page.locator("[data-testid='goal-form-divergence-policy']"),
		).toBeVisible({ timeout: 10_000 });
		// Picking 'strict' marks it pressed.
		await page.locator("[data-testid='goal-form-divergence-strict']").click();
		await expect(
			page.locator("[data-testid='goal-form-divergence-strict']"),
		).toHaveAttribute("aria-pressed", "true", { timeout: 5_000 });
	});

	test("proposal panel hides the per-goal subgoal controls when subgoals are OFF/unset", async ({ page }) => {
		// Unset the pref (fresh-install default) BEFORE opening the app so the
		// dataset reads "false" on first paint.
		await unsetFlag();
		await openApp(page);
		await createSessionViaUI(page);

		await sendMessage(page, "Please create a GOAL_PROPOSAL for testing");

		const titleInput = page.locator("input[placeholder='Goal title']").first();
		await expect(titleInput).toBeVisible({ timeout: 20_000 });
		await expect(titleInput).toHaveValue("E2E Test Goal", { timeout: 15_000 });

		// With subgoals OFF, neither per-goal control is rendered.
		await expect(
			page.locator("[data-testid='goal-form-subgoals-toggle']"),
		).toHaveCount(0);
		await expect(
			page.locator("[data-testid='goal-form-max-depth']"),
		).toHaveCount(0);

		// Restore the harness default for subsequent specs/tests.
		await resetFlag(true);
	});
});
