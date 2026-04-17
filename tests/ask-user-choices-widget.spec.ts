/**
 * Unit fixture tests for the `ask_user_choices` widget.
 *
 * Covers:
 *  - Renders N tabs for N questions.
 *  - Clicking a non-"Other" option auto-advances to the next tab.
 *  - Clicking a tab manually jumps without reordering.
 *  - Submit button disabled until every question has a selection.
 *  - allow_other=true: selecting "Other" does NOT auto-advance; Submit requires non-empty other_text.
 *  - After successful submit(), widget is read-only (no Submit button).
 *  - Setting `answers` prop initially renders read-only.
 *  - Setting `errored=true` renders the error branch only.
 *
 * NOTE: The fixture at tests/ask-user-choices-widget.html reimplements the
 * widget's DOM/state logic in plain JS (mirroring
 * src/ui/components/AskUserChoicesWidget.ts). Behaviour parity must be kept
 * manually when the source changes.
 */
import { test, expect } from "@playwright/test";
import path from "node:path";

const FIXTURE = `file://${path.resolve("tests/ask-user-choices-widget.html").replace(/\\/g, "/")}`;

test.describe("ask_user_choices widget", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(FIXTURE);
		await page.waitForFunction(() => (window as any)._testReady === true);
	});

	test("renders N tabs for N questions", async ({ page }) => {
		await page.evaluate(() => (window as any).mountWidget({
			questions: [
				{ question: "Q1", options: ["a", "b"] },
				{ question: "Q2", options: ["c", "d"] },
				{ question: "Q3", options: ["e", "f"] },
			],
		}));
		await expect(page.locator('[role="tab"]')).toHaveCount(3);
	});

	test("selecting a non-Other option auto-advances to the next tab", async ({ page }) => {
		await page.evaluate(() => (window as any).mountWidget({
			questions: [
				{ question: "Q1", options: ["a", "b"] },
				{ question: "Q2", options: ["c", "d"] },
			],
		}));
		// Click first option on tab 0.
		await page.locator('[role="tabpanel"] input[type=radio]').first().check();
		// Active tab should now be 1 (async re-render).
		await expect(page.locator('[role="tab"][data-tab-index="1"]')).toHaveAttribute("aria-selected", "true");
	});

	test("clicking a tab manually jumps without reordering", async ({ page }) => {
		await page.evaluate(() => (window as any).mountWidget({
			questions: [
				{ question: "Q1", options: ["a", "b"] },
				{ question: "Q2", options: ["c", "d"] },
				{ question: "Q3", options: ["e", "f"] },
			],
		}));
		await page.locator('[role="tab"][data-tab-index="2"]').click();
		const active = await page.locator('[role="tab"][aria-selected="true"]').getAttribute("data-tab-index");
		expect(active).toBe("2");
		// Panel should show Q3
		await expect(page.locator('[role="tabpanel"] .ask-question')).toHaveText("Q3");
	});

	test("Submit button disabled until every question has a selection", async ({ page }) => {
		await page.evaluate(() => (window as any).mountWidget({
			questions: [
				{ question: "Q1", options: ["a", "b"] },
				{ question: "Q2", options: ["c", "d"] },
			],
		}));
		// Initially disabled
		await expect(page.locator(".ask-submit")).toBeDisabled();
		// Answer Q1 → auto-advance → still missing Q2 → disabled
		await page.locator('[role="tabpanel"] input[type=radio][value="a"]').check();
		await expect(page.locator(".ask-submit")).toBeDisabled();
		// Answer Q2 → enabled
		await page.locator('[role="tabpanel"] input[type=radio][value="c"]').check();
		await expect(page.locator(".ask-submit")).toBeEnabled();
	});

	test("allow_other: selecting Other does NOT auto-advance; Submit requires other_text", async ({ page }) => {
		await page.evaluate(() => (window as any).mountWidget({
			questions: [
				{ question: "Q1", options: ["a", "b"], allow_other: true },
				{ question: "Q2", options: ["c", "d"] },
			],
		}));
		// Select Other on Q1
		await page.locator('[role="tabpanel"] input[type=radio][value="__OTHER__"]').check();
		// Active tab must still be 0
		const active = await page.locator('[role="tab"][aria-selected="true"]').getAttribute("data-tab-index");
		expect(active).toBe("0");
		// Text input revealed
		await expect(page.locator(".ask-other-input")).toBeVisible();
		// Answer Q2 manually via tab nav
		await page.locator('[role="tab"][data-tab-index="1"]').click();
		await page.locator('[role="tabpanel"] input[type=radio][value="c"]').check();
		// Submit still disabled because Q1 other_text is empty — auto-advance took us to Q2
		// We must be on Q2 now after checking 'c' on last question no advance — still 1
		await page.locator('[role="tab"][data-tab-index="1"]').click();
		await expect(page.locator(".ask-submit")).toBeDisabled();
		// Fill other_text for Q1
		await page.locator('[role="tab"][data-tab-index="0"]').click();
		await page.locator(".ask-other-input").fill("my custom answer");
		await expect(page.locator(".ask-submit")).toBeEnabled();
	});

	test("successful submit() → widget becomes read-only (no Submit button)", async ({ page }) => {
		// Install a submitFetch mock that returns 200.
		await page.evaluate(() => (window as any).mountWidget({
			questions: [
				{ question: "Q1", options: ["a", "b"] },
				{ question: "Q2", options: ["c", "d"] },
			],
			submitFetch: async (_url: string, init: any) => {
				(window as any)._lastSubmitBody = JSON.parse(init.body);
				return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
			},
		}));
		await page.locator('[role="tabpanel"] input[type=radio][value="a"]').check();
		await page.locator('[role="tabpanel"] input[type=radio][value="c"]').check();
		await page.locator(".ask-submit").click();
		// Wait for the Submit button to disappear (read-only state).
		await expect(page.locator(".ask-submit")).toHaveCount(0);

		// The body POSTed should contain the answers in canonical shape.
		const body = await page.evaluate(() => (window as any)._lastSubmitBody);
		expect(body.answers).toEqual([
			{ question: "Q1", selected: "a", other_text: null },
			{ question: "Q2", selected: "c", other_text: null },
		]);
	});

	test("submit() with Other → selected='Other', other_text=trimmed", async ({ page }) => {
		await page.evaluate(() => (window as any).mountWidget({
			questions: [
				{ question: "Q1", options: ["a", "b"], allow_other: true },
			],
			submitFetch: async (_url: string, init: any) => {
				(window as any)._lastSubmitBody = JSON.parse(init.body);
				return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
			},
		}));
		await page.locator('input[type=radio][value="__OTHER__"]').check();
		await page.locator(".ask-other-input").fill("  my typed answer  ");
		await page.locator(".ask-submit").click();
		await expect(page.locator(".ask-submit")).toHaveCount(0);
		const body = await page.evaluate(() => (window as any)._lastSubmitBody);
		expect(body.answers[0]).toEqual({
			question: "Q1",
			selected: "Other",
			other_text: "my typed answer",
		});
	});

	test("initial answers prop renders read-only (replay scenario)", async ({ page }) => {
		await page.evaluate(() => (window as any).mountWidget({
			questions: [
				{ question: "Q1", options: ["a", "b"] },
				{ question: "Q2", options: ["c", "d"], allow_other: true },
			],
			answers: [
				{ question: "Q1", selected: "b", other_text: null },
				{ question: "Q2", selected: "Other", other_text: "custom" },
			],
		}));
		// No Submit button
		await expect(page.locator(".ask-submit")).toHaveCount(0);
		// Q1 option "b" should be checked on tab 0
		await expect(page.locator('input[type=radio][value="b"]')).toBeChecked();
		// Switch to tab 1 — Other radio checked, text shows "custom"
		await page.locator('[role="tab"][data-tab-index="1"]').click();
		await expect(page.locator('input[type=radio][value="__OTHER__"]')).toBeChecked();
		await expect(page.locator(".ask-other-input")).toHaveValue("custom");
		// Both text inputs & radios disabled
		await expect(page.locator('input[type=radio][value="__OTHER__"]')).toBeDisabled();
	});

	test("errored=true renders the error branch only", async ({ page }) => {
		await page.evaluate(() => (window as any).mountWidget({
			questions: [{ question: "Q1", options: ["a", "b"] }],
			errored: true,
			errorText: "Session terminated",
		}));
		await expect(page.locator(".ask-error")).toHaveText("Session terminated");
		await expect(page.locator('[role="tab"]')).toHaveCount(0);
		await expect(page.locator(".ask-submit")).toHaveCount(0);
	});

	test("failed submit surfaces server error message", async ({ page }) => {
		await page.evaluate(() => (window as any).mountWidget({
			questions: [{ question: "Q1", options: ["a", "b"] }],
			submitFetch: async () =>
				new Response(JSON.stringify({ error: "No pending question for this session/toolUseId" }), { status: 404, headers: { "Content-Type": "application/json" } }),
		}));
		await page.locator('input[type=radio][value="a"]').check();
		await page.locator(".ask-submit").click();
		// Submit button remains visible (not read-only); error surfaces.
		await expect(page.locator(".ask-submit-error")).toHaveText(/No pending question/);
		await expect(page.locator(".ask-submit")).toBeVisible();
	});
});
