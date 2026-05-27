/**
 * Add Project — multi-repo subset handoff to the project assistant.
 *
 * This is the bug fix the V2 dialog promotion shipped: the user-confirmed
 * scan subset must reach the project assistant's first turn. Today both an
 * English bullet summary AND a fenced ```json``` block containing
 * `{ rootPath, items, selectedIds }` are sent as the autoPrompt — pinned by
 * `tests/project-assistant-autoprompt.test.ts` at the formatter level and
 * here at the WebSocket-frame level.
 */
import { test, expect } from "../gateway-harness.js";
import { rmSync } from "node:fs";
import { basename } from "node:path";
import {
	ADD_PROJECT,
	openAddProjectDialog,
	makeMultiRepoFixture,
	clearProjects,
	captureAssistantPrompts,
	preflightAvailable,
} from "./add-project-helpers.js";

test.describe("Add Project — multi-repo subset handoff", () => {
	test.afterEach(async () => {
		await clearProjects();
	});

	test("deselect one sibling repo → assistant first prompt carries the subset (English + JSON)", async ({ page }, testInfo) => {
		if (!(await preflightAvailable())) testInfo.skip(true, "preflight endpoint unavailable");
		testInfo.setTimeout(90_000);

		// Build a root with two sibling git repos. scanRepos should return one
		// entry per child with hasGit:true → buildScanItems produces two items
		// `repo:<folder>`.
		const fixture = makeMultiRepoFixture("subset", ["alpha-svc", "beta-svc"]);

		// Install the WS capture BEFORE opening the dialog so we never miss
		// the first connection's `framesent` events.
		const captured = captureAssistantPrompts(page);

		try {
			await openAddProjectDialog(page);

			const input = page.locator(ADD_PROJECT.pickerInput);
			await input.fill(fixture.root);

			// Wait for preflight to settle (no fail expected for a clean dir).
			const panel = page.locator(ADD_PROJECT.preflightPanel);
			await expect(panel).toBeVisible({ timeout: 8_000 });
			await expect.poll(
				async () => (await panel.getAttribute("data-has-fail")) ?? "loading",
				{ timeout: 8_000 },
			).toBe("0");

			// Click Continue → routes to the scan step (path → scan).
			await page.locator("button").filter({ hasText: "Continue" }).first().click();
			await expect(page.locator(ADD_PROJECT.scanChecklist)).toBeVisible({ timeout: 10_000 });
			await expect(page.locator(ADD_PROJECT.step)).toHaveText("scan");

			// Both rows present and pre-checked.
			const alphaCheckbox = page.locator(ADD_PROJECT.scanCheckboxFor("repo:alpha-svc"));
			const betaCheckbox = page.locator(ADD_PROJECT.scanCheckboxFor("repo:beta-svc"));
			await expect(alphaCheckbox).toBeChecked();
			await expect(betaCheckbox).toBeChecked();
			await expect(page.locator(ADD_PROJECT.selectedCount)).toHaveText("Selected 2 of 2");

			// Uncheck beta — selection drops to 1 of 2.
			await betaCheckbox.uncheck();
			await expect(betaCheckbox).not.toBeChecked();
			await expect(page.locator(ADD_PROJECT.selectedCount)).toHaveText("Selected 1 of 2");

			// Click "Continue with assistant" → confirmScanAndContinue() →
			// createProjectAssistantSession(rootPath, false, { initialScanContext })
			// → connectToSession → remote.prompt(autoPrompt) over WS.
			await page.locator(ADD_PROJECT.continue).click();

			// Wait until the URL hash flips to the new assistant session, then
			// poll the captured prompts for the one containing our root path.
			await expect.poll(
				() => page.evaluate(() => window.location.hash),
				{ timeout: 15_000, intervals: [100, 200, 500] },
			).toMatch(/^#\/session\//);

			const rootBase = basename(fixture.root);
			await expect.poll(
				() => captured.prompts.find((p) => p.text.includes(rootBase))?.text ?? null,
				{ timeout: 15_000, intervals: [100, 200, 500] },
			).not.toBeNull();

			const promptText = captured.prompts.find((p) => p.text.includes(rootBase))!.text;

			// English summary present.
			expect(promptText).toContain(
				"User-confirmed initial repo/subdirectory selection from Add Project",
			);
			expect(promptText).toContain("Selected 1 of 2 repo/subdirectory candidates");
			expect(promptText).toContain("`alpha-svc`");
			expect(promptText).toContain("`beta-svc`");
			// "Not selected" bullet must surface the de-selected repo.
			expect(promptText).toMatch(/Not selected:.*beta-svc/);

			// Machine-readable JSON block round-trips and reflects the subset.
			const jsonMatch = promptText.match(/```json\n([\s\S]*?)\n```/);
			expect(jsonMatch, "autoprompt must contain a ```json block").not.toBeNull();
			const parsed = JSON.parse(jsonMatch![1]!);
			expect(parsed).toMatchObject({
				rootPath: fixture.root,
			});
			expect(Array.isArray(parsed.items)).toBe(true);
			expect(parsed.items).toHaveLength(2);
			expect(Array.isArray(parsed.selectedIds)).toBe(true);
			expect(parsed.selectedIds).toEqual(["repo:alpha-svc"]);
		} finally {
			captured.stop();
			try { rmSync(fixture.root, { recursive: true, force: true }); } catch { /* best-effort */ }
		}
	});
});
