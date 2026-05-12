/**
 * Add Project — directory-picker → preflight panel (browser E2E).
 *
 * Reproducing test for the bug analysed in the "Issue Analysis" gate:
 * when the user picks a directory via the in-dialog directory browser
 * (Browse → Select), the preflight panel does not appear because
 * `selectBrowsed()` in `src/app/dialogs.ts` calls only `runDetection`
 * and skips `runPreflight`. Typing into the text input works (it goes
 * through `debouncedDetect`, which fans out to both), but the
 * directory-browser confirm path is the bug.
 *
 * Acceptance: this spec MUST fail on master @ c4e732da (timeout waiting
 * for the preflight panel to become visible after Select), and pass
 * after `selectBrowsed()` is fixed to also call `runPreflight(pathValue)`.
 *
 * Pattern mirrored from:
 *   - tests/e2e/ui/add-project-preflight.spec.ts (panel assertions, skip-on-404)
 *   - tests/e2e/ui/add-project-flow.spec.ts      (Browse → Select interactions)
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch } from "../e2e-setup.js";
import { openApp } from "./ui-helpers.js";
import { tmpdir } from "node:os";

async function preflightAvailable(): Promise<boolean> {
	try {
		const res = await apiFetch("/api/projects/preflight?path=" + encodeURIComponent(tmpdir()));
		return res.status !== 404;
	} catch {
		return false;
	}
}

test.describe("Add Project — preflight panel via directory picker", () => {
	test.afterEach(async () => {
		const res = await apiFetch("/api/projects");
		const data = await res.json();
		const projects = data.projects || data || [];
		for (const p of projects) {
			if (p.name === "default") continue;
			await apiFetch(`/api/projects/${p.id}?force=1`, { method: "DELETE" }).catch(() => {});
		}
	});

	test("Browse → Select triggers preflight panel (does not require typing the path)", async ({ page }, testInfo) => {
		if (!(await preflightAvailable())) testInfo.skip(true, "preflight endpoint unavailable");

		await openApp(page);

		// Open the Add Project dialog.
		await page.locator("button").filter({ hasText: "Add Project" }).first().click();
		const pathInput = page.locator('input[placeholder="/path/to/project"]');
		await expect(pathInput).toBeVisible({ timeout: 5_000 });

		// Sanity: preflight panel is NOT visible yet (nothing typed, nothing picked).
		await expect(page.locator('[data-testid="preflight-panel"]')).toHaveCount(0);

		// Open the directory browser WITHOUT typing into the text input.
		// (Typing would trigger preflight via debouncedDetect and hide the bug.)
		await page.locator("button").filter({ hasText: "Browse" }).first().click();
		await expect(page.locator('[data-testid="directory-browser"]')).toBeVisible({ timeout: 5_000 });

		// Pick the current directory (whatever default the browser opened in).
		const selectBtn = page.locator("button").filter({ hasText: "Select" }).first();
		await expect(selectBtn).toBeEnabled({ timeout: 5_000 });
		await selectBtn.click();

		// Browser closes, text input is repopulated with the chosen path.
		await expect(page.locator('[data-testid="directory-browser"]')).not.toBeVisible({ timeout: 5_000 });
		const chosen = await pathInput.inputValue();
		expect(chosen.length).toBeGreaterThan(0);

		// THE BUG: on master, selectBrowsed() does not invoke runPreflight,
		// so the panel never appears. This assertion is the reproducing
		// signal — it must fail on master and pass after the fix.
		const panel = page.locator('[data-testid="preflight-panel"]');
		await expect(panel).toBeVisible({ timeout: 8_000 });

		// And the panel should populate with at least one check row.
		await expect.poll(
			() => page.locator('[data-testid="preflight-check"]').count(),
			{ timeout: 8_000 },
		).toBeGreaterThan(0);
	});
});
