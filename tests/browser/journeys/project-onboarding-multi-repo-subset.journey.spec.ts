/**
 * Journey: Project Onboarding — selected repository subset
 * Covers: journey-project-onboarding
 * Ported from: add-project-multi-repo-subset.
 */
import { rmSync } from "node:fs";
import { basename } from "node:path";
import { test, expect, openApp } from "../_helpers/journey-fixture.js";
import {
	ADD_PROJECT,
	clearAddedProjects,
	makeMultiRepoFixture,
	openAddProjectDialog,
	preflightAvailable,
} from "../_helpers/project-onboarding.js";

test.describe("Journey: Project Onboarding — selected repository subset", () => {
	test.afterEach(async () => {
		await clearAddedProjects();
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
