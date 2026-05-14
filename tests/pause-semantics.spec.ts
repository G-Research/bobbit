/**
 * Pause-semantics consolidation tests.
 *
 * Covers (renderer-level, file:// fixture):
 *  - Issue 3: `goal_pause` reads count from `{ paused: N }`; `goal_resume`
 *    from `{ resumed: N }`.
 *
 * Server-side behavior (state='blocked', soft abort, caller exclusion,
 * targeted childGoalId) is exercised by API E2E in
 * `tests/e2e/pause-semantics-api.spec.ts`.
 */
import { test, expect } from "@playwright/test";
import path from "node:path";
import { buildBundle } from "./fixtures/build-bundle.js";

const FIXTURE = path.resolve("tests/fixtures/children-tool-renderers.html");
const BUNDLE = path.resolve("tests/fixtures/children-tool-renderers-bundle.js");
const ENTRY = path.resolve("tests/fixtures/children-tool-renderers-entry.ts");

const RENDERER_FILES = [
	"src/ui/tools/renderers/GoalSpawnChildRenderer.ts",
	"src/ui/tools/renderers/GoalPlanProposeRenderer.ts",
	"src/ui/tools/renderers/GoalPlanStatusRenderer.ts",
	"src/ui/tools/renderers/GoalMergeChildRenderer.ts",
	"src/ui/tools/renderers/GoalPauseResumeRenderer.ts",
	"src/ui/tools/renderers/GoalArchiveChildRenderer.ts",
	"src/ui/tools/renderers/GoalDecideMutationRenderer.ts",
	"src/ui/tools/renderers/GoalSetPolicyRenderer.ts",
	"src/ui/tools/renderers/children-renderer-helpers.ts",
	"src/ui/lazy/children-mutation-approval.ts",
	"src/ui/lazy/children-goal-state-pill.ts",
].map(f => path.resolve(f));

test.beforeAll(() => {
	buildBundle({ entry: ENTRY, outfile: BUNDLE, deps: [ENTRY, ...RENDERER_FILES] });
});

const PAGE = `file://${FIXTURE}`;

function makeResult(toolName: string, data: any) {
	return {
		role: "toolResult",
		toolCallId: "t1",
		toolName,
		isError: false,
		content: [{ type: "text", text: JSON.stringify(data) }],
		timestamp: 0,
	};
}

async function gotoAndWait(page: any) {
	await page.goto(PAGE);
	await page.waitForFunction(() => (window as any).__ready === true, null, { timeout: 10_000 });
	await page.evaluate(() => { (window as any).__setFlag(true); });
}

test("goal_pause renderer reads count from { paused: N } (Issue 3)", async ({ page }) => {
	await gotoAndWait(page);
	await page.evaluate((r) => {
		(window as any).__renderChildren("goal_pause", document.getElementById("container"),
			{ cascade: true }, r, false);
	}, makeResult("goal_pause", { paused: 3 }));
	const text = await page.locator("#container").textContent();
	expect(text).toContain("3");
	expect(text?.toLowerCase()).toContain("paused");
	expect(text).toContain("goal");
});

test("goal_resume renderer reads count from { resumed: N } (Issue 3)", async ({ page }) => {
	await gotoAndWait(page);
	await page.evaluate((r) => {
		(window as any).__renderChildren("goal_resume", document.getElementById("container"),
			{ cascade: true }, r, false);
	}, makeResult("goal_resume", { resumed: 2 }));
	const text = await page.locator("#container").textContent();
	expect(text).toContain("2");
	expect(text?.toLowerCase()).toContain("resumed");
});

test("goal_pause renderer falls back to count when paused key absent", async ({ page }) => {
	await gotoAndWait(page);
	await page.evaluate((r) => {
		(window as any).__renderChildren("goal_pause", document.getElementById("container"),
			{ cascade: false }, r, false);
	}, makeResult("goal_pause", { count: 1 }));
	const text = await page.locator("#container").textContent();
	expect(text).toContain("1");
});

test("goal_pause renderer renders 0 when count is missing entirely", async ({ page }) => {
	await gotoAndWait(page);
	await page.evaluate((r) => {
		(window as any).__renderChildren("goal_pause", document.getElementById("container"),
			{ cascade: true }, r, false);
	}, makeResult("goal_pause", { ok: true }));
	const text = await page.locator("#container").textContent();
	expect(text).toContain("0");
});

test("goal_pause result with { paused: 1 } pluralizes singular", async ({ page }) => {
	await gotoAndWait(page);
	await page.evaluate((r) => {
		(window as any).__renderChildren("goal_pause", document.getElementById("container"),
			{ cascade: false }, r, false);
	}, makeResult("goal_pause", { paused: 1 }));
	const text = await page.locator("#container").textContent();
	expect(text).toMatch(/1\s+goal\b/);
});
