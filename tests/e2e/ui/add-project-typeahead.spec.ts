/**
 * Add Project — directory-picker typeahead (V2 default flow).
 *
 * Pins:
 *   - Typing a parent path with multiple children renders the absolutely
 *     positioned suggestion overlay populated by `/api/browse-directory`.
 *   - ArrowDown highlights the first suggestion; Enter selects it; the picker
 *     input updates and detection/preflight re-runs against the new path.
 *   - Escape closes the open suggestion list without cancelling the dialog;
 *     a second Escape closes the dialog.
 */
import { test, expect } from "../gateway-harness.js";
import { rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
	ADD_PROJECT,
	openAddProjectDialog,
	uniqueDir,
	clearProjects,
	waitForPreflight,
	preflightAvailable,
} from "./add-project-helpers.js";

test.describe("Add Project — directory picker typeahead", () => {
	test.afterEach(async () => {
		await clearProjects();
	});

	test("type prefix → ArrowDown → Enter selects suggestion and runs preflight", async ({ page }, testInfo) => {
		if (!(await preflightAvailable())) testInfo.skip(true, "preflight endpoint unavailable");

		// Build a parent dir with a couple of named children that the suggestion
		// query (filtered by typed basename) will hit.
		const parent = uniqueDir("typeahead-parent");
		mkdirSync(join(parent, "alpha-child"), { recursive: true });
		mkdirSync(join(parent, "alpha-other"), { recursive: true });
		mkdirSync(join(parent, "beta"), { recursive: true });
		writeFileSync(join(parent, "alpha-child", "README.md"), "hello\n");

		try {
			await openAddProjectDialog(page);
			const input = page.locator(ADD_PROJECT.pickerInput);
			await expect(input).toBeFocused();

			// Type the parent path + "/alpha" so the picker queries the parent
			// and filters by basename "alpha".
			await input.fill(join(parent, "alpha"));

			// Wait for the absolutely-positioned suggestion overlay to render with
			// at least one suggestion whose data-path comes from our fixture parent.
			// The picker can briefly show a recents-derived list during the 200ms
			// debounce; poll until the basename-filtered browse result lands so the
			// arrow-down assertion isn't racing the lookup.
			const overlay = page.locator(ADD_PROJECT.pickerSuggestions);
			await expect(overlay).toBeVisible({ timeout: 5_000 });
			await expect.poll(
				async () => {
					const paths = await overlay
						.locator(ADD_PROJECT.pickerSuggestion)
						.evaluateAll((els) => els.map((el) => el.getAttribute("data-path") ?? ""));
					return paths.filter((p) => p.includes("alpha-")).length;
				},
				{ timeout: 8_000 },
			).toBeGreaterThanOrEqual(1);

			// ArrowDown moves to the next suggestion. The picker auto-highlights
			// index 0 after a successful lookup, so ArrowDown bumps to index 1 if
			// it exists. We don't care which alpha-* matches — just that the
			// highlighted suggestion is one of our fixture children.
			await input.press("ArrowDown");
			const highlighted = overlay.locator('[role="option"][aria-selected="true"]').first();
			await expect(highlighted).toBeVisible();
			const pickedPath = await highlighted.getAttribute("data-path");
			expect(pickedPath).toBeTruthy();
			expect(pickedPath!).toContain("alpha-");

			// Press Enter — picker should fire directory-select; input value
			// updates to the chosen suggestion and the overlay closes.
			await input.press("Enter");
			await expect(overlay).toHaveCount(0, { timeout: 2_000 });
			await expect(input).toHaveValue(pickedPath!);

			// Preflight re-runs against the new path (source = "suggestion" runs
			// immediate detection/preflight; not debounced).
			const rendered = await waitForPreflight(page);
			expect(rendered).toBe(true);
			const panel = page.locator(ADD_PROJECT.preflightPanel);
			await expect(panel).toBeVisible();
			// The path.absolute / path.exists checks should be present for the
			// chosen path.
			await expect(
				page.locator('[data-testid="preflight-check"][data-check-id="path.exists"]'),
			).toBeVisible({ timeout: 5_000 });

			// Re-open the suggestion list by typing a single character so we can
			// exercise the Esc-closes-suggestions-then-Esc-closes-dialog branch.
			await input.focus();
			// Use keyboard so the picker re-runs its lookup. Re-fill to a
			// prefix that still matches.
			await input.fill(join(parent, "alpha"));
			await expect(overlay).toBeVisible({ timeout: 5_000 });

			// First Escape closes the suggestion overlay only.
			await input.press("Escape");
			await expect(overlay).toHaveCount(0, { timeout: 2_000 });
			// Dialog still open.
			await expect(page.locator(ADD_PROJECT.dialog)).toBeVisible();

			// Second Escape bubbles directory-cancel → cleanup() closes dialog.
			await input.press("Escape");
			await expect(page.locator(ADD_PROJECT.dialog)).toHaveCount(0, { timeout: 5_000 });
		} finally {
			try { rmSync(parent, { recursive: true, force: true }); } catch { /* best-effort */ }
		}
	});
});
