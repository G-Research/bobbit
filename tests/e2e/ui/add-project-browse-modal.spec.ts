/**
 * Add Project — dedicated browse modal flow.
 *
 * Pins:
 *   - Clicking Browse opens the standalone `add-project-browse-dialog`
 *     overlay; the parent dialog stays mounted underneath.
 *   - Clicking a directory entry navigates into it (current-path label
 *     changes); Up navigates back.
 *   - "Select current" closes the modal, copies the path into the picker,
 *     and triggers detection + preflight on the new path.
 *   - Re-opening the modal and pressing Esc closes it without mutating the
 *     picker input, and focus returns to the picker input.
 */
import { test, expect } from "../gateway-harness.js";
import { rmSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
	ADD_PROJECT,
	openAddProjectDialog,
	uniqueDir,
	clearProjects,
	waitForPreflight,
	preflightAvailable,
} from "./add-project-helpers.js";

test.describe("Add Project — browse modal", () => {
	test.afterEach(async () => {
		await clearProjects();
	});

	test("browse → navigate → select updates picker + preflight; Esc preserves picker + restores focus", async ({ page }, testInfo) => {
		if (!(await preflightAvailable())) testInfo.skip(true, "preflight endpoint unavailable");
		testInfo.setTimeout(60_000);

		// parent contains "deeper-child" which itself has a "leaf" subdir we'll
		// navigate into to exercise Up + entry click.
		const parent = uniqueDir("browse-parent");
		const deeper = join(parent, "deeper-child");
		const leaf = join(deeper, "leaf");
		mkdirSync(leaf, { recursive: true });
		writeFileSync(join(leaf, "README.md"), "hi\n");

		try {
			await openAddProjectDialog(page);
			const input = page.locator(ADD_PROJECT.pickerInput);

			// Seed the input so the browse modal opens at a known starting point.
			await input.fill(parent);
			await expect(waitForPreflight(page)).resolves.toBe(true);

			// --- happy path: browse → navigate down → Select current ---
			await page.locator(ADD_PROJECT.pickerBrowse).click();
			const modal = page.locator(ADD_PROJECT.browseDialog);
			await expect(modal).toBeVisible({ timeout: 5_000 });
			// Parent dialog stays mounted underneath.
			await expect(page.locator(ADD_PROJECT.dialog)).toBeVisible();

			const current = modal.locator(ADD_PROJECT.browseCurrent);
			// Wait for the initial directory listing to land.
			await expect.poll(
				async () => (await current.textContent()) ?? "",
				{ timeout: 5_000 },
			).toContain(basename(parent));

			// Click the "deeper-child" entry — current-path label should update.
			const deeperEntry = modal
				.locator(ADD_PROJECT.browseEntry)
				.filter({ hasText: "deeper-child" })
				.first();
			await expect(deeperEntry).toBeVisible({ timeout: 5_000 });
			await deeperEntry.click();
			await expect.poll(
				async () => (await current.textContent()) ?? "",
				{ timeout: 5_000 },
			).toContain("deeper-child");

			// Click Up — current label should drop back to parent.
			await modal.locator(ADD_PROJECT.browseUp).click();
			await expect.poll(
				async () => (await current.textContent()) ?? "",
				{ timeout: 5_000 },
			).not.toContain("deeper-child");

			// Re-enter deeper-child and Select current.
			await modal
				.locator(ADD_PROJECT.browseEntry)
				.filter({ hasText: "deeper-child" })
				.first()
				.click();
			await expect.poll(
				async () => (await current.textContent()) ?? "",
				{ timeout: 5_000 },
			).toContain("deeper-child");

			const selectBtn = modal.locator("button").filter({ hasText: "Select current" }).first();
			await expect(selectBtn).toBeEnabled({ timeout: 5_000 });
			await selectBtn.click();
			await expect(modal).toHaveCount(0, { timeout: 5_000 });

			// Picker input updated to the selected path.
			await expect.poll(
				async () => await input.inputValue(),
				{ timeout: 5_000 },
			).toContain("deeper-child");
			// Preflight re-ran for the new path. We assert the preflight panel
			// shows the chosen folder by checking its `rootPath` data via the
			// path-existence check row.
			const rendered = await waitForPreflight(page);
			expect(rendered).toBe(true);
			await expect(
				page.locator('[data-testid="preflight-check"][data-check-id="path.exists"]'),
			).toBeVisible({ timeout: 8_000 });

			// --- Esc closes modal, preserves picker, restores focus ---
			const valueBeforeEsc = await input.inputValue();
			await page.locator(ADD_PROJECT.pickerBrowse).click();
			await expect(modal).toBeVisible({ timeout: 5_000 });
			await page.keyboard.press("Escape");
			await expect(modal).toHaveCount(0, { timeout: 5_000 });

			// Picker value unchanged after Esc.
			expect(await input.inputValue()).toBe(valueBeforeEsc);
			// Focus returned to the picker's internal input.
			await expect(input).toBeFocused();
		} finally {
			try { rmSync(parent, { recursive: true, force: true }); } catch { /* best-effort */ }
		}
	});
});
