/**
 * Add Project — footer bounding-box stability invariant.
 *
 * Pins the design-doc requirement: `add-project-footer` must occupy the same
 * screen rectangle across every state transition the dialog can be in —
 * empty input, typed path triggering preflight, suggestion overlay open,
 * browse modal open, scan step (multi-repo), and the error-row state.
 *
 * Failure prints the offending transition + which axis shifted by how many
 * pixels so the regression source is obvious.
 */
import { test, expect, type Page } from "../gateway-harness.js";
import { rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
	ADD_PROJECT,
	openAddProjectDialog,
	uniqueDir,
	makeMultiRepoFixture,
	clearProjects,
	waitForPreflight,
	preflightAvailable,
} from "./add-project-helpers.js";

interface Rect { x: number; y: number; width: number; height: number }
const TOL = 1; // sub-pixel rendering tolerance

async function footerRect(page: Page): Promise<Rect> {
	const handle = await page.locator(ADD_PROJECT.footer).first().elementHandle();
	if (!handle) throw new Error("footer not found");
	const box = await handle.boundingBox();
	if (!box) throw new Error("footer has no bounding box");
	return {
		x: Math.round(box.x),
		y: Math.round(box.y),
		width: Math.round(box.width),
		height: Math.round(box.height),
	};
}

function shifted(a: Rect, b: Rect): string | null {
	const dx = Math.abs(a.x - b.x);
	const dy = Math.abs(a.y - b.y);
	const dw = Math.abs(a.width - b.width);
	const dh = Math.abs(a.height - b.height);
	if (dx > TOL || dy > TOL || dw > TOL || dh > TOL) {
		return `Δx=${dx} Δy=${dy} Δw=${dw} Δh=${dh} (tolerance=${TOL}). before=${JSON.stringify(a)} after=${JSON.stringify(b)}`;
	}
	return null;
}

test.describe("Add Project — footer position invariant", () => {
	test.afterEach(async () => {
		await clearProjects();
	});

	test("footer bounding box stays put across every state transition", async ({ page }, testInfo) => {
		if (!(await preflightAvailable())) testInfo.skip(true, "preflight endpoint unavailable");
		testInfo.setTimeout(60_000);

		// Build fixtures used by individual transitions.
		const parent = uniqueDir("footer-parent");
		mkdirSync(join(parent, "alpha"), { recursive: true });
		mkdirSync(join(parent, "alpha-two"), { recursive: true });
		const empty = uniqueDir("footer-empty");
		const multi = makeMultiRepoFixture("footer-multi");

		try {
			await openAddProjectDialog(page);
			const input = page.locator(ADD_PROJECT.pickerInput);

			// Reference snapshot: empty input, no suggestions, no preflight.
			const baseline = await footerRect(page);

			const assertNoShift = async (label: string) => {
				const next = await footerRect(page);
				const drift = shifted(baseline, next);
				if (drift) {
					throw new Error(`Footer shifted at transition "${label}": ${drift}`);
				}
			};

			// 1. Type into the picker so the suggestion overlay opens.
			await input.fill(join(parent, "alpha"));
			await expect(page.locator(ADD_PROJECT.pickerSuggestions)).toBeVisible({ timeout: 5_000 });
			await assertNoShift("suggestion overlay open");

			// 2. Replace with an empty dir to force preflight to a 'Ready' state.
			await input.fill(empty);
			const rendered = await waitForPreflight(page);
			expect(rendered).toBe(true);
			await expect(page.locator(ADD_PROJECT.preflightPanel)).toBeVisible();
			await assertNoShift("preflight panel populated");

			// 3. Open the browse modal — separate overlay; the parent footer
			// must not move beneath it.
			await page.locator(ADD_PROJECT.pickerBrowse).click();
			await expect(page.locator(ADD_PROJECT.browseDialog)).toBeVisible({ timeout: 5_000 });
			await assertNoShift("browse modal open");

			// Close the browse modal (Cancel).
			await page
				.locator(ADD_PROJECT.browseDialog)
				.locator("button")
				.filter({ hasText: "Cancel" })
				.first()
				.click();
			await expect(page.locator(ADD_PROJECT.browseDialog)).toHaveCount(0, { timeout: 5_000 });
			await assertNoShift("browse modal closed");

			// 4. Trigger an error-ish status by typing a path that doesn't
			// exist. The status slot has reserved height and the preflight
			// pane scrolls — the footer must stay put.
			await input.fill("/this/path/definitely/does/not/exist/x");
			// Let preflight finish (one way or another) for that path.
			await expect.poll(
				async () => {
					const panel = page.locator(ADD_PROJECT.preflightPanel);
					if (await panel.count() === 0) return "missing";
					return await panel.getAttribute("data-has-fail");
				},
				{ timeout: 8_000 },
			).not.toBeNull();
			await assertNoShift("nonexistent path / preflight error state");

			// 5. Drive to the scan step via the multi-repo fixture. Continue
			// must transition us from path → scan without footer movement.
			await input.fill(multi.root);
			await expect(page.locator(ADD_PROJECT.preflightPanel)).toBeVisible({ timeout: 8_000 });
			// Wait for preflight to finish so Continue is enabled.
			await expect.poll(
				async () =>
					(await page.locator(ADD_PROJECT.preflightPanel).getAttribute("data-has-fail")) ?? "loading",
				{ timeout: 8_000 },
			).toBe("0");
			await assertNoShift("multi-repo path typed, preflight ready");

			// Click Continue → moves to scan step (the multi-repo fixture
			// produces 2 detected repos so this is the path → scan branch).
			await page.locator("button").filter({ hasText: "Continue" }).first().click();
			await expect(page.locator(ADD_PROJECT.scanChecklist)).toBeVisible({ timeout: 10_000 });
			await expect(page.locator(ADD_PROJECT.step)).toHaveText("scan");
			await assertNoShift("scan step displayed");
		} finally {
			for (const dir of [parent, empty, multi.root]) {
				try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
			}
		}
	});
});
