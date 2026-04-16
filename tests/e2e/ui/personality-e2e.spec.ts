/**
 * Browser E2E test for PI-22: Personality selector.
 *
 * Verifies that personality chips are visible in the session settings dialog
 * and can be toggled on/off.
 */
import { test, expect } from "../gateway-harness.js";
import { waitForHealth, apiFetch } from "../e2e-setup.js";
import { openApp, createSessionViaUI, sendMessage, waitForAgentResponse } from "./ui-helpers.js";

test.describe("Personality selector E2E", () => {
	test.beforeAll(async () => {
		await waitForHealth();
	});

	test("PI-22: personality chips visible and toggleable in session settings @smoke", async ({ page }) => {
		// First verify personalities exist on server
		const res = await apiFetch("/api/personalities");
		const data = await res.json();
		expect(data.personalities.length).toBeGreaterThan(0);
		const firstPersonality = data.personalities[0];

		await openApp(page);
		await createSessionViaUI(page);

		// Send a message so session is fully active
		await sendMessage(page, "Hello personality test");
		await waitForAgentResponse(page);

		// Open the session settings dialog via the "Modify" pencil button
		// in the session header bar
		const modifyButton = page.locator("button[title='Modify session']");
		await expect(modifyButton).toBeVisible({ timeout: 5_000 });
		await modifyButton.click();

		// Wait for the dialog to appear — it contains a "Personalities" label inside the dialog
		// Use a specific selector to avoid matching the sidebar "Personalities" nav item
		const personalitiesLabel = page.locator("div.text-xs.text-muted-foreground").filter({ hasText: "Personalities" });
		await expect(personalitiesLabel).toBeVisible({ timeout: 5_000 });

		// Verify personality chips are rendered
		// Each personality is a button with the personality label text
		// Scope to the dialog to avoid matching other buttons
		const dialog = page.locator("dialog, [role='dialog'], .fixed.inset-0").first();
		const personalityChip = dialog.locator("button").filter({ hasText: firstPersonality.label });
		await expect(personalityChip).toBeVisible({ timeout: 5_000 });

		// Initially no personalities are selected (chip should not have selected styling)
		// The selected state adds "bg-primary/15" class
		const initialClasses = await personalityChip.getAttribute("class");
		expect(initialClasses).not.toContain("bg-primary");

		// Click to select the personality
		await personalityChip.click();

		// After click, the chip should have the selected styling
		await expect(async () => {
			const classes = await personalityChip.getAttribute("class");
			expect(classes).toContain("bg-primary");
		}).toPass({ timeout: 3_000 });

		// Click again to deselect
		await personalityChip.click();

		// Should return to unselected state
		await expect(async () => {
			const classes = await personalityChip.getAttribute("class");
			expect(classes).not.toContain("bg-primary");
		}).toPass({ timeout: 3_000 });
	});

	test("PI-22: personality selection persists after save", async ({ page }) => {
		// Get available personalities
		const res = await apiFetch("/api/personalities");
		const data = await res.json();
		expect(data.personalities.length).toBeGreaterThan(0);
		const firstPersonality = data.personalities[0];

		await openApp(page);
		await createSessionViaUI(page);

		await sendMessage(page, "Hello personality persist test");
		await waitForAgentResponse(page);

		// Open session settings
		const modifyButton = page.locator("button[title='Modify session']");
		await modifyButton.click();
		const personalitiesLabel = page.locator("div.text-xs.text-muted-foreground").filter({ hasText: "Personalities" });
		await expect(personalitiesLabel).toBeVisible({ timeout: 5_000 });

		// Select a personality (scoped to dialog)
		const dialog = page.locator("dialog, [role='dialog'], .fixed.inset-0").first();
		const personalityChip = dialog.locator("button").filter({ hasText: firstPersonality.label });
		await personalityChip.click();

		// Verify selected
		await expect(async () => {
			const classes = await personalityChip.getAttribute("class");
			expect(classes).toContain("bg-primary");
		}).toPass({ timeout: 3_000 });

		// Click Save
		const saveButton = page.locator("button").filter({ hasText: "Save" });
		await saveButton.click();

		// Dialog should close
		await expect(personalitiesLabel).not.toBeVisible({ timeout: 5_000 });

		// Re-open settings dialog to verify personality is still selected
		await modifyButton.click();
		const personalitiesLabel2 = page.locator("div.text-xs.text-muted-foreground").filter({ hasText: "Personalities" });
		await expect(personalitiesLabel2).toBeVisible({ timeout: 5_000 });

		// The personality chip should still be in selected state
		const dialog2 = page.locator("dialog, [role='dialog'], .fixed.inset-0").first();
		const chipAfterReopen = dialog2.locator("button").filter({ hasText: firstPersonality.label });
		await expect(async () => {
			const classes = await chipAfterReopen.getAttribute("class");
			expect(classes).toContain("bg-primary");
		}).toPass({ timeout: 5_000 });
	});
});
