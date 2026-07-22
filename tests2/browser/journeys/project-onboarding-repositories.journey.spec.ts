/**
 * Journey: Project Onboarding — repository selection and post-archive
 * Covers: journey-project-onboarding
 * Consolidated from: add-project-multi-repo-subset, add-project-post-archive,
 *   and add-project-select-all.
 */
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { test, expect, openApp } from "../_helpers/journey-fixture.js";
import {
	ADD_PROJECT,
	clearAddedProjects,
	makeMultiRepoFixture,
	openAddProjectDialog,
	preflightAvailable,
	uniqueDir,
} from "./project-onboarding.helpers.js";

test.describe("Journey: Project Onboarding — repositories and post-archive", () => {
	test.afterEach(async () => {
		await clearAddedProjects();
	});

	// Ported from add-project-select-all.spec.ts (audit: project-onboarding GAP,
	// mutant BR55): a multi-repo scan renders the checklist with a selected-count
	// readout; Deselect all / Select all drive the count text and Continue state.
	test("multi-repo scan selected-count reflects deselect-all / select-all", async ({ page }, testInfo) => {
		test.setTimeout(90_000);
		if (!(await preflightAvailable())) { testInfo.skip(true, "preflight endpoint unavailable"); return; }
		const root = makeMultiRepoFixture("selectall", ["one", "two", "three"]);
		try {
			await openApp(page);
			await page.evaluate(() => { window.location.hash = "#/settings/projects"; });
			await page.waitForFunction(() => window.location.hash.includes("settings"), null, { timeout: 20_000 });
			await openAddProjectDialog(page);

			await page.locator(ADD_PROJECT.pickerInput).fill(root);
			const preflight = page.locator(ADD_PROJECT.preflightPanel);
			await expect(preflight).toBeVisible({ timeout: 15_000 });
			await expect.poll(
				async () => (await preflight.getAttribute("data-has-fail")) ?? "loading",
				{ timeout: 15_000 },
			).toBe("0");

			// Path → scan.
			await page.locator("button").filter({ hasText: "Continue" }).first().click();
			await expect(page.locator(ADD_PROJECT.scanChecklist)).toBeVisible({ timeout: 15_000 });
			await expect(page.locator(ADD_PROJECT.step)).toHaveText("scan", { timeout: 10_000 });

			const items = ["repo:one", "repo:two", "repo:three"] as const;
			for (const id of items) {
				await expect(page.locator(ADD_PROJECT.scanCheckboxFor(id))).toBeChecked({ timeout: 10_000 });
			}
			// selected-count readout (mutant target) starts at all-selected.
			await expect(page.locator(ADD_PROJECT.selectedCount)).toHaveText("Selected 3 of 3", { timeout: 10_000 });

			// Deselect all → count drops to 0 of 3.
			await page.locator(ADD_PROJECT.deselectAll).click();
			await expect(page.locator(ADD_PROJECT.selectedCount)).toHaveText("Selected 0 of 3", { timeout: 10_000 });

			// Select all → count returns to 3 of 3.
			await page.locator(ADD_PROJECT.selectAll).click();
			await expect(page.locator(ADD_PROJECT.selectedCount)).toHaveText("Selected 3 of 3", { timeout: 10_000 });
		} finally {
			try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
		}
	});

	// Ported from add-project-post-archive.spec.ts (audit: project-onboarding GAP,
	// mutant BR52): a directory with a ghost .bobbit/ (dir present, no
	// project.yaml) surfaces the preflight archive CTA so the user can archive it.
	test("ghost .bobbit/ directory surfaces the preflight archive CTA", async ({ page }, testInfo) => {
		test.setTimeout(90_000);
		if (!(await preflightAvailable())) { testInfo.skip(true, "preflight endpoint unavailable"); return; }
		const dir = uniqueDir("ghost-bobbit");
		mkdirSync(join(dir, ".bobbit"), { recursive: true });
		writeFileSync(join(dir, ".bobbit", "some-file.txt"), "leftover from a previous install\n");
		writeFileSync(join(dir, "README.md"), "# Test\n");
		try {
			await openApp(page);
			await page.evaluate(() => { window.location.hash = "#/settings/projects"; });
			await page.waitForFunction(() => window.location.hash.includes("settings"), null, { timeout: 20_000 });
			await openAddProjectDialog(page);

			await page.locator('input[placeholder="/path/to/project"]').fill(dir);
			await expect(page.locator(ADD_PROJECT.preflightPanel)).toBeVisible({ timeout: 15_000 });
			// The ghost-.bobbit existing check row + its archive CTA (mutant target).
			await expect(
				page.locator('[data-testid="preflight-check"][data-check-id="bobbit.existing"]').first(),
			).toBeVisible({ timeout: 10_000 });
			await expect(page.locator('[data-testid="preflight-archive-cta"]').first()).toBeVisible({ timeout: 10_000 });
		} finally {
			try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
		}
	});

	// Ported from add-project-multi-repo-subset.spec.ts (audit: project-onboarding
	// GAP, mutant BR64): after deselecting one repo, Continue-with-assistant must
	// route to a session AND the WS autoPrompt must carry ONLY the selected repo
	// subset in its machine-readable JSON block.
	test("multi-repo subset: Continue autoPrompt carries only the selected repo id", async ({ page }, testInfo) => {
		test.setTimeout(120_000);
		if (!(await preflightAvailable())) { testInfo.skip(true, "preflight endpoint unavailable"); return; }
		const root = makeMultiRepoFixture("subset", ["alpha-svc", "beta-svc"]);

		// Capture WS prompt frames (must be attached before the session connects).
		const prompts: string[] = [];
		page.on("websocket", (ws) => {
			ws.on("framesent", (event) => {
				try {
					const payload = typeof event.payload === "string" ? event.payload : event.payload.toString("utf-8");
					const data = JSON.parse(payload);
					if (data?.type === "prompt" && typeof data.text === "string") prompts.push(data.text);
				} catch { /* non-JSON frame */ }
			});
		});

		try {
			await openApp(page);
			await page.evaluate(() => { window.location.hash = "#/settings/projects"; });
			await page.waitForFunction(() => window.location.hash.includes("settings"), null, { timeout: 20_000 });
			await openAddProjectDialog(page);

			await page.locator(ADD_PROJECT.pickerInput).fill(root);
			const preflight = page.locator(ADD_PROJECT.preflightPanel);
			await expect(preflight).toBeVisible({ timeout: 15_000 });
			await expect.poll(async () => (await preflight.getAttribute("data-has-fail")) ?? "loading", { timeout: 15_000 }).toBe("0");

			await page.locator("button").filter({ hasText: "Continue" }).first().click();
			await expect(page.locator(ADD_PROJECT.scanChecklist)).toBeVisible({ timeout: 15_000 });
			await expect(page.locator(ADD_PROJECT.step)).toHaveText("scan", { timeout: 10_000 });
			await expect(page.locator(ADD_PROJECT.selectedCount)).toHaveText("Selected 2 of 2", { timeout: 10_000 });

			// Deselect beta-svc → subset of one.
			await page.locator(ADD_PROJECT.scanCheckboxFor("repo:beta-svc")).click();
			await expect(page.locator(ADD_PROJECT.selectedCount)).toHaveText("Selected 1 of 2", { timeout: 10_000 });

			// Continue with assistant → routes to a session.
			await page.locator(ADD_PROJECT.continue).click();
			await expect.poll(() => page.evaluate(() => window.location.hash), { timeout: 15_000 }).toMatch(/^#\/session\//);

			// The autoPrompt JSON block must reflect ONLY the selected subset.
			const rootBase = basename(root);
			await expect.poll(
				() => prompts.find((t) => t.includes(rootBase)) ?? null,
				{ timeout: 15_000 },
			).not.toBeNull();
			const promptText = prompts.find((t) => t.includes(rootBase))!;
			const jsonMatch = promptText.match(/```json\n([\s\S]*?)\n```/);
			expect(jsonMatch, "autoprompt must contain a ```json block").not.toBeNull();
			const parsed = JSON.parse(jsonMatch![1]!);
			expect(parsed.selectedIds).toEqual(["repo:alpha-svc"]);
		} finally {
			try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
		}
	});
});
