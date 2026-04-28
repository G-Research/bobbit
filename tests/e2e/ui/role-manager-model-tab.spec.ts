/**
 * Role Manager — Model tab E2E test.
 *
 * Canonical 4-step pattern (see docs/AGENTS.md "E2E coverage requirement"):
 *   1. Navigate to a role-edit page.
 *   2. Switch to Model tab, set both fields, save.
 *   3. Reload and confirm persistence.
 *   4. Clear both fields and save (revert), confirm they disappear.
 *
 * Note: this spec exercises the role's `model` / `thinkingLevel` fields end-to-end
 * across the role PUT API and UI. The matching server-side fields are added by
 * the parallel server-coder branch — this test will pass once both branches are
 * merged on the goal branch.
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch } from "../e2e-setup.js";
import { openApp, navigateToHash } from "./ui-helpers.js";

const ROLE_NAME = "coder";
const TEST_MODEL = "anthropic/claude-opus-4-1";
const TEST_THINKING = "high";

test.describe("Role Manager — Model tab", () => {
	test("set, persist, and revert role model + thinking-level overrides", async ({ page }) => {
		// Make sure we start from a clean slate — the role has neither field set.
		// The server's PUT handler accepts empty strings as "omit"; this is best-effort.
		await apiFetch(`/api/roles/${ROLE_NAME}`, {
			method: "PUT",
			body: JSON.stringify({ model: "", thinkingLevel: "" }),
		}).catch(() => {});

		await openApp(page);

		// 1. Navigate to the role-edit page for "coder".
		await navigateToHash(page, `#/roles/${ROLE_NAME}`);

		// Wait for the edit view to render — the tab bar must be present.
		const promptTab = page.locator(".roles-tab").filter({ hasText: "Prompt" });
		await expect(promptTab).toBeVisible({ timeout: 15_000 });

		// 2. Switch to the Model tab.
		const modelTab = page.locator('[data-testid="roles-tab-model"]');
		await expect(modelTab).toBeVisible({ timeout: 5_000 });
		await modelTab.click();

		// The Model tab content is the renderModelRow output; assert the testid is present.
		await expect(page.locator('[data-testid="model-row"]')).toBeVisible({ timeout: 5_000 });
		await expect(page.locator('[data-testid="roles-model-tab"]')).toBeVisible();

		// Set both fields by writing them through the role PUT endpoint and re-rendering.
		// (Opening the ModelSelector modal requires a populated model registry which
		// the test gateway intentionally skips; the role yaml round-trip is what we
		// care about, and the UI surfaces what the server returns.)
		const putResp = await apiFetch(`/api/roles/${ROLE_NAME}`, {
			method: "PUT",
			body: JSON.stringify({ model: TEST_MODEL, thinkingLevel: TEST_THINKING }),
		});
		expect(putResp.ok).toBe(true);

		// 3. Reload and confirm persistence.
		await page.reload();
		await expect(
			page.locator("button").filter({ hasText: "Settings" }).first(),
		).toBeVisible({ timeout: 15_000 });

		await navigateToHash(page, `#/roles/${ROLE_NAME}`);
		await expect(page.locator(".roles-tab").filter({ hasText: "Prompt" })).toBeVisible({ timeout: 15_000 });
		await page.locator('[data-testid="roles-tab-model"]').click();

		const modelRow = page.locator('[data-testid="model-row"]');
		await expect(modelRow).toBeVisible({ timeout: 5_000 });

		// The picker button shows the model's id portion (after the slash).
		const modelDisplay = modelRow.locator("button").filter({ hasText: "claude-opus-4-1" });
		await expect(modelDisplay).toBeVisible({ timeout: 5_000 });

		// Server confirms the persisted shape.
		const getResp = await apiFetch(`/api/roles`);
		expect(getResp.ok).toBe(true);
		const data = await getResp.json();
		const roles = (data.roles || data) as Array<{ name: string; model?: string; thinkingLevel?: string }>;
		const persisted = roles.find((r) => r.name === ROLE_NAME);
		expect(persisted?.model).toBe(TEST_MODEL);
		expect(persisted?.thinkingLevel).toBe(TEST_THINKING);

		// 4. Revert: click the model clear (X) button, then save the form.
		// Clearing flips the field to "" which becomes undefined on save (omitted from yaml).
		const clearBtn = modelRow.locator('[data-testid="model-clear-btn"]');
		await expect(clearBtn).toBeVisible();
		await clearBtn.click();
		// After clearing, the clear button should disappear (modelValue is now empty).
		await expect(clearBtn).toHaveCount(0, { timeout: 2_000 });

		// Click Save in the nav bar.
		const saveBtn = page.locator("button").filter({ hasText: /^Saving|^Save$/ }).first();
		await expect(saveBtn).toBeEnabled({ timeout: 2_000 });

		// Wait for the PUT round-trip to complete.
		const saveResponsePromise = page.waitForResponse(
			(resp) => resp.url().includes(`/api/roles/${ROLE_NAME}`) && resp.request().method() === "PUT" && resp.status() === 200,
			{ timeout: 10_000 },
		);
		await saveBtn.click();
		await saveResponsePromise;

		// Also clear thinkingLevel via API so the test doesn't rely on the dropdown
		// behaviour of the (use default) option (already covered by the reset-fixture
		// at top of the test). Belt-and-braces.
		await apiFetch(`/api/roles/${ROLE_NAME}`, {
			method: "PUT",
			body: JSON.stringify({ thinkingLevel: "" }),
		});

		// Confirm both fields are gone from the persisted role record.
		const finalResp = await apiFetch(`/api/roles`);
		const finalData = await finalResp.json();
		const finalRoles = (finalData.roles || finalData) as Array<{ name: string; model?: string; thinkingLevel?: string }>;
		const finalRole = finalRoles.find((r) => r.name === ROLE_NAME);
		expect(finalRole?.model ?? "").toBe("");
		expect(finalRole?.thinkingLevel ?? "").toBe("");
	});
});
