/**
 * Reproducing test: per-project "None (use global)" palette card has no effect.
 *
 * Bug:
 *   In Settings → <project> → Appearance, clicking the "None (use global)" card
 *   after a named palette is already selected does NOT clear the override:
 *     - the previously-selected card stays Active,
 *     - the "None" card never gains the Active indicator,
 *     - `<html data-palette>` does not revert to the global default.
 *
 * Root cause is documented in the Issue Analysis gate for goal
 * "Fix project None palette" — a client-side state-merge bug in
 * settings-page.ts::savePaletteAndColors() plus a missing
 * applyProjectPalette() call after the PUT.
 *
 * This test MUST FAIL on master and pass once the fix lands. Do not touch
 * production code from this commit.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, expect } from "../gateway-harness.js";
import { apiFetch } from "../e2e-setup.js";
import { openApp, navigateToHash } from "./ui-helpers.js";
import {
	DEFAULT_PROJECT_COLOR_LIGHT,
	DEFAULT_PROJECT_COLOR_DARK,
	PALETTE_PRIMARY_COLORS,
} from "../../../src/shared/palette-colors.js";

test.describe('Per-project palette "None (use global)" card', () => {
	let projectId: string | undefined;
	let projectDir: string | undefined;

	test.afterEach(async () => {
		if (projectId) {
			await apiFetch(`/api/projects/${projectId}`, { method: "DELETE" }).catch(() => {});
		}
		if (projectDir) {
			try { rmSync(projectDir, { recursive: true, force: true }); } catch { /* Windows EPERM */ }
		}
		projectId = undefined;
		projectDir = undefined;
	});

	test("clicking None clears the per-project palette override", async ({ page }) => {
		projectDir = mkdtempSync(join(tmpdir(), "bobbit-palette-none-"));

		// Create a project with no palette override.
		const createResp = await apiFetch("/api/projects", {
			method: "POST",
			body: JSON.stringify({ name: "palette-none-test", rootPath: projectDir }),
		});
		expect(createResp.status).toBe(201);
		const project = await createResp.json();
		projectId = project.id;

		await openApp(page);

		// Snapshot the *global* palette so we know what to revert to.
		// Settings page (no session active) reflects the user's global palette.
		const globalPalette = await page.evaluate(
			() => document.documentElement.dataset.palette || "",
		);

		await navigateToHash(page, `#/settings/${projectId}/appearance`);

		// Appearance tab content should load — wait for the "Color Palette" heading
		// inside the per-project appearance pane.
		await expect(
			page.locator("h3").filter({ hasText: "Color Palette" }),
		).toBeVisible({ timeout: 10_000 });

		// Locate the named palette cards by their title attribute, and the
		// "None (use global)" card by its label text.
		const oceanBtn = page.locator('button[title="Select Ocean palette"]');
		const noneBtn = page.locator("button").filter({ hasText: "None (use global)" });

		await expect(oceanBtn).toBeVisible({ timeout: 5_000 });
		await expect(noneBtn).toBeVisible({ timeout: 5_000 });

		// Initially "None" is active (project has no palette override).
		await expect(noneBtn.locator("text=Active")).toBeVisible({ timeout: 5_000 });
		await expect(oceanBtn.locator("text=Active")).toHaveCount(0);

		// --- Step 1: click "Ocean". Expect Active indicator + data-palette === "ocean".
		let putResponse = page.waitForResponse(
			(resp) =>
				resp.url().includes(`/api/projects/${projectId}`) &&
				resp.request().method() === "PUT" &&
				resp.status() === 200,
		);
		await oceanBtn.click();
		await putResponse;

		// After picking Ocean, the server should have auto-seeded accent colors
		// from the Ocean palette primaries.
		const afterOcean = await (await apiFetch(`/api/projects/${projectId}`)).json();
		expect(afterOcean.palette).toBe("ocean");
		expect(afterOcean.colorLight).toBe(PALETTE_PRIMARY_COLORS.ocean.light);
		expect(afterOcean.colorDark).toBe(PALETTE_PRIMARY_COLORS.ocean.dark);

		await expect(
			oceanBtn.locator("text=Active"),
			'expected the "Ocean" palette card to show Active after clicking it',
		).toBeVisible({ timeout: 5_000 });
		await expect(
			noneBtn.locator("text=Active"),
			'expected the "None (use global)" card to NOT show Active after picking Ocean',
		).toHaveCount(0);

		await expect
			.poll(
				() => page.evaluate(() => document.documentElement.dataset.palette ?? null),
				{
					message:
						'expected <html data-palette> to be "ocean" after clicking the Ocean palette card',
					timeout: 5_000,
				},
			)
			.toBe("ocean");

		// --- Step 2: click "None (use global)". Reproduces the bug.
		putResponse = page.waitForResponse(
			(resp) =>
				resp.url().includes(`/api/projects/${projectId}`) &&
				resp.request().method() === "PUT" &&
				resp.status() === 200,
		);
		await noneBtn.click();
		await putResponse;

		// Bug repro: previously the "Ocean" card stayed Active and "None" never lit
		// up. After the fix, "None" gains Active and "Ocean" loses it.
		await expect(
			noneBtn.locator("text=Active"),
			'expected the "None (use global)" card to show Active after clicking it',
		).toBeVisible({ timeout: 5_000 });
		await expect(
			oceanBtn.locator("text=Active"),
			'expected the "Ocean" card to no longer show Active after clicking None',
		).toHaveCount(0);

		// `<html data-palette>` should revert to the global default. When the
		// global palette is "forest" the attribute is removed entirely; otherwise
		// it equals the global palette value.
		await expect
			.poll(
				() => page.evaluate(() => document.documentElement.dataset.palette ?? ""),
				{
					message:
						"expected <html data-palette> to revert to the global default after clicking None (attribute cleared when global is forest, else equal to global)",
					timeout: 5_000,
				},
			)
			.toBe(globalPalette);

		// Server should report the project with no palette override AND
		// accent colors reset to defaults (since the caller didn't supply
		// explicit colorLight/colorDark in the PUT).
		const after = await (await apiFetch(`/api/projects/${projectId}`)).json();
		expect(
			after.palette === undefined || after.palette === null || after.palette === "",
			`expected GET /api/projects/${projectId} to return no palette field after clearing override, got ${JSON.stringify(after.palette)}`,
		).toBe(true);
		expect(
			after.colorLight,
			"expected colorLight to reset to default after clearing palette",
		).toBe(DEFAULT_PROJECT_COLOR_LIGHT);
		expect(
			after.colorDark,
			"expected colorDark to reset to default after clearing palette",
		).toBe(DEFAULT_PROJECT_COLOR_DARK);

		// The visible oklch swatch labels next to the color pickers should
		// reflect the defaults too.
		await expect
			.poll(
				() =>
					page.evaluate(() =>
						Array.from(document.querySelectorAll('input[type="color"]')).map(
							(el) => (el.nextElementSibling?.textContent || "").trim(),
						),
					),
				{
					message:
						"expected the oklch labels next to the color pickers to reflect the default accent colors after clicking None",
					timeout: 5_000,
				},
			)
			.toEqual([DEFAULT_PROJECT_COLOR_LIGHT, DEFAULT_PROJECT_COLOR_DARK]);

		// --- Step 3: reload — "None" should still be Active and DOM still global.
		await page.reload();
		await expect(
			page.locator("button").filter({ hasText: "Settings" }).first(),
		).toBeVisible({ timeout: 20_000 });
		await navigateToHash(page, `#/settings/${projectId}/appearance`);
		await expect(
			page.locator("h3").filter({ hasText: "Color Palette" }),
		).toBeVisible({ timeout: 10_000 });

		const noneBtnAfter = page.locator("button").filter({ hasText: "None (use global)" });
		const oceanBtnAfter = page.locator('button[title="Select Ocean palette"]');
		await expect(
			noneBtnAfter.locator("text=Active"),
			'expected the "None (use global)" card to still be Active after reload',
		).toBeVisible({ timeout: 5_000 });
		await expect(oceanBtnAfter.locator("text=Active")).toHaveCount(0);

		await expect
			.poll(
				() => page.evaluate(() => document.documentElement.dataset.palette ?? ""),
				{
					message:
						"expected <html data-palette> to still reflect the global default after reload",
					timeout: 5_000,
				},
			)
			.toBe(globalPalette);

		// Default accent colors should also persist across reload.
		const afterReload = await (await apiFetch(`/api/projects/${projectId}`)).json();
		expect(afterReload.colorLight).toBe(DEFAULT_PROJECT_COLOR_LIGHT);
		expect(afterReload.colorDark).toBe(DEFAULT_PROJECT_COLOR_DARK);
		await expect
			.poll(
				() =>
					page.evaluate(() =>
						Array.from(document.querySelectorAll('input[type="color"]')).map(
							(el) => (el.nextElementSibling?.textContent || "").trim(),
						),
					),
				{
					message:
						"expected default accent colors to persist across reload",
					timeout: 5_000,
				},
			)
			.toEqual([DEFAULT_PROJECT_COLOR_LIGHT, DEFAULT_PROJECT_COLOR_DARK]);
	});
});
