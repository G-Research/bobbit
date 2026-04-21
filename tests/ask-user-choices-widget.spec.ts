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
				{ question: "Q1", options: ["a", "b"], tab_label: "First" },
				{ question: "Q2", options: ["c", "d"], tab_label: "Second" },
				{ question: "Q3", options: ["e", "f"], tab_label: "Third" },
			],
		}));
		await expect(page.locator('[role="tab"]')).toHaveCount(3);
	});

	test("selecting a non-Other option auto-advances to the next tab", async ({ page }) => {
		await page.evaluate(() => (window as any).mountWidget({
			questions: [
				{ question: "Q1", options: ["a", "b"], tab_label: "First" },
				{ question: "Q2", options: ["c", "d"], tab_label: "Second" },
			],
		}));
		// Click first option on tab 0.
		await page.locator('[role="tabpanel"] input[type=radio]').first().click({ force: true });
		// Active tab should now be 1 (async re-render).
		await expect(page.locator('[role="tab"][data-tab-index="1"]')).toHaveAttribute("aria-selected", "true");
	});

	test("clicking a tab manually jumps without reordering", async ({ page }) => {
		await page.evaluate(() => (window as any).mountWidget({
			questions: [
				{ question: "Q1", options: ["a", "b"], tab_label: "First" },
				{ question: "Q2", options: ["c", "d"], tab_label: "Second" },
				{ question: "Q3", options: ["e", "f"], tab_label: "Third" },
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
				{ question: "Q1", options: ["a", "b"], tab_label: "First" },
				{ question: "Q2", options: ["c", "d"], tab_label: "Second" },
			],
		}));
		// Initially disabled
		await expect(page.locator(".ask-submit")).toBeDisabled();
		// Answer Q1 → auto-advance → still missing Q2 → disabled
		await page.locator('[role="tabpanel"] input[type=radio][value="a"]').click({ force: true });
		await expect(page.locator(".ask-submit")).toBeDisabled();
		// Answer Q2 → enabled
		await page.locator('[role="tabpanel"] input[type=radio][value="c"]').click({ force: true });
		// Second-tab selection → Submit button on last tab. Active tab is still Q2 after picking 'c' (last tab).
		await expect(page.locator(".ask-submit")).toBeEnabled();
		await expect(page.locator(".ask-submit")).toHaveText(/Submit/);
	});

	test("allow_other: selecting Other does NOT auto-advance; Submit requires other_text", async ({ page }) => {
		await page.evaluate(() => (window as any).mountWidget({
			questions: [
				{ question: "Q1", options: ["a", "b"], allow_other: true, tab_label: "First" },
				{ question: "Q2", options: ["c", "d"], tab_label: "Second" },
			],
		}));
		// Select Other on Q1
		await page.locator('[role="tabpanel"] input[type=radio][value="__OTHER__"]').click({ force: true });
		// Active tab must still be 0
		const active = await page.locator('[role="tab"][aria-selected="true"]').getAttribute("data-tab-index");
		expect(active).toBe("0");
		// Text input revealed
		await expect(page.locator(".ask-other-input")).toBeVisible();
		// Answer Q2 manually via tab nav
		await page.locator('[role="tab"][data-tab-index="1"]').click();
		await page.locator('[role="tabpanel"] input[type=radio][value="c"]').click({ force: true });
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
				{ question: "Q1", options: ["a", "b"], tab_label: "First" },
				{ question: "Q2", options: ["c", "d"], tab_label: "Second" },
			],
			submitFetch: async (_url: string, init: any) => {
				(window as any)._lastSubmitBody = JSON.parse(init.body);
				return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
			},
		}));
		await page.locator('[role="tabpanel"] input[type=radio][value="a"]').click({ force: true });
		await page.locator('[role="tabpanel"] input[type=radio][value="c"]').click({ force: true });
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
		await page.locator('input[type=radio][value="__OTHER__"]').click({ force: true });
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
				{ question: "Q1", options: ["a", "b"], tab_label: "First" },
				{ question: "Q2", options: ["c", "d"], allow_other: true, tab_label: "Second" },
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

	test("visual polish: input is sr-only; selected card has .checked", async ({ page }) => {
		await page.evaluate(() => (window as any).mountWidget({
			questions: [{ question: "Q1", options: ["a", "b"] }],
		}));
		// Native radio input carries the sr-only class.
		const radio = page.locator('input[type=radio][value="a"]');
		await expect(radio).toHaveClass(/sr-only/);
		// The radio is effectively invisible (<=1px box).
		const box = await radio.boundingBox();
		expect(box && Math.max(box.width, box.height)).toBeLessThanOrEqual(1);
		// Before selection, card not .checked
		const card = page.locator('.ask-option').first();
		await expect(card).not.toHaveClass(/checked/);
		await radio.click({ force: true });
		await expect(card).toHaveClass(/checked/);
		// A visible checkmark indicator renders inside the selected card.
		await expect(card.locator('.ask-option-check')).toContainText('✓');
	});

	test("multi:true renders checkboxes (not radios) and drops the name attribute", async ({ page }) => {
		await page.evaluate(() => (window as any).mountWidget({
			questions: [{ question: "Pick all", options: ["a", "b", "c"], multi: true }],
		}));
		await expect(page.locator('input[type=checkbox]')).toHaveCount(3);
		await expect(page.locator('input[type=radio]')).toHaveCount(0);
		// Checkboxes should not share a name attribute.
		const names = await page.locator('input[type=checkbox]').evaluateAll(
			(els) => els.map(e => (e as HTMLInputElement).getAttribute('name')),
		);
		for (const n of names) expect(n).toBeFalsy();
		// Checkboxes are sr-only.
		await expect(page.locator('input[type=checkbox]').first()).toHaveClass(/sr-only/);
	});

	test("multi: clicking multiple checkboxes persists all selections; unchecking removes", async ({ page }) => {
		await page.evaluate(() => (window as any).mountWidget({
			questions: [{ question: "Pick all", options: ["a", "b", "c"], multi: true }],
			submitFetch: async (_u: string, init: any) => {
				(window as any)._lastSubmitBody = JSON.parse(init.body);
				return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
			},
		}));
		await page.locator('label:has(input[value="a"])').click();
		await page.locator('label:has(input[value="c"])').click();
		// Both cards appear checked.
		await expect(page.locator('.ask-option').nth(0)).toHaveClass(/checked/);
		await expect(page.locator('.ask-option').nth(2)).toHaveClass(/checked/);
		await expect(page.locator('.ask-option').nth(1)).not.toHaveClass(/checked/);
		// Uncheck a.
		await page.locator('label:has(input[value="a"])').click();
		await expect(page.locator('.ask-option').nth(0)).not.toHaveClass(/checked/);
		await expect(page.locator('.ask-option').nth(2)).toHaveClass(/checked/);
		// Submit only c.
		await page.locator('.ask-submit').click();
		const body = await page.evaluate(() => (window as any)._lastSubmitBody);
		expect(body.answers[0].selected).toEqual(["c"]);
		expect(body.answers[0].other_text).toBeNull();
	});

	test("multi: auto-advance is suppressed", async ({ page }) => {
		await page.evaluate(() => (window as any).mountWidget({
			questions: [
				{ question: "Q1", options: ["a", "b"], multi: true, tab_label: "First" },
				{ question: "Q2", options: ["c", "d"], tab_label: "Second" },
			],
		}));
		await page.locator('label:has(input[value="a"])').click();
		// Active tab must still be 0.
		const active = await page.locator('[role="tab"][aria-selected="true"]').getAttribute("data-tab-index");
		expect(active).toBe("0");
	});

	test("multi: Submit disabled at 0 selections, enabled at ≥1 (default min=1)", async ({ page }) => {
		await page.evaluate(() => (window as any).mountWidget({
			questions: [{ question: "Pick", options: ["a", "b"], multi: true }],
		}));
		await expect(page.locator(".ask-submit")).toBeDisabled();
		await page.locator('label:has(input[value="a"])').click();
		await expect(page.locator(".ask-submit")).toBeEnabled();
		await page.locator('label:has(input[value="a"])').click();
		await expect(page.locator(".ask-submit")).toBeDisabled();
	});

	test("multi: min=2 requires at least two selections", async ({ page }) => {
		await page.evaluate(() => (window as any).mountWidget({
			questions: [{ question: "Pick ≥2", options: ["a", "b", "c"], multi: true, min: 2 }],
		}));
		await page.locator('label:has(input[value="a"])').click();
		await expect(page.locator(".ask-submit")).toBeDisabled();
		await page.locator('label:has(input[value="b"])').click();
		await expect(page.locator(".ask-submit")).toBeEnabled();
	});

	test("multi + Other: submits selected array with 'Other' and other_text", async ({ page }) => {
		await page.evaluate(() => (window as any).mountWidget({
			questions: [{ question: "Pick", options: ["a", "b"], allow_other: true, multi: true }],
			submitFetch: async (_u: string, init: any) => {
				(window as any)._lastSubmitBody = JSON.parse(init.body);
				return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
			},
		}));
		await page.locator('label:has(input[value="a"])').click();
		await page.locator('label:has(input[value="__OTHER__"])').click();
		// Submit disabled while other_text empty.
		await expect(page.locator(".ask-submit")).toBeDisabled();
		await page.locator('.ask-other-input').fill('  my custom  ');
		await expect(page.locator(".ask-submit")).toBeEnabled();
		await page.locator('.ask-submit').click();
		const body = await page.evaluate(() => (window as any)._lastSubmitBody);
		expect(body.answers[0].selected).toEqual(["a", "Other"]);
		expect(body.answers[0].other_text).toBe("my custom");
	});

	test("multi: read-only answers with array selected restore checkboxes", async ({ page }) => {
		await page.evaluate(() => (window as any).mountWidget({
			questions: [{ question: "Pick", options: ["a", "b", "c"], allow_other: true, multi: true }],
			answers: [{ question: "Pick", selected: ["a", "c", "Other"], other_text: "zed" }],
		}));
		await expect(page.locator(".ask-submit")).toHaveCount(0);
		await expect(page.locator('input[type=checkbox][value="a"]')).toBeChecked();
		await expect(page.locator('input[type=checkbox][value="b"]')).not.toBeChecked();
		await expect(page.locator('input[type=checkbox][value="c"]')).toBeChecked();
		await expect(page.locator('input[type=checkbox][value="__OTHER__"]')).toBeChecked();
		await expect(page.locator('.ask-other-input')).toHaveValue("zed");
	});

	test("single question: tabs are hidden and picking an option auto-submits", async ({ page }) => {
		await page.evaluate(() => (window as any).mountWidget({
			questions: [{ question: "Q1", options: ["a", "b"] }],
			submitFetch: async (_u: string, init: any) => {
				(window as any)._lastSubmitBody = JSON.parse(init.body);
				return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
			},
		}));
		// No tablist rendered for a single question.
		await expect(page.locator('[role="tab"]')).toHaveCount(0);
		// No Submit button before selection either.
		await expect(page.locator(".ask-submit")).toHaveCount(0);
		// Picking an option auto-submits.
		await page.locator('input[type=radio][value="a"]').click({ force: true });
		await expect.poll(() => page.evaluate(() => (window as any)._lastSubmitBody)).toBeTruthy();
		const body = await page.evaluate(() => (window as any)._lastSubmitBody);
		expect(body.answers[0]).toEqual({ question: "Q1", selected: "a", other_text: null });
		// Widget is read-only; no Submit button.
		await expect(page.locator(".ask-submit")).toHaveCount(0);
	});

	test("single question + Other: Submit is shown and auto-submit suppressed", async ({ page }) => {
		await page.evaluate(() => (window as any).mountWidget({
			questions: [{ question: "Q1", options: ["a", "b"], allow_other: true }],
		}));
		await expect(page.locator('[role="tab"]')).toHaveCount(0);
		// No Submit until something is picked.
		await expect(page.locator(".ask-submit")).toHaveCount(0);
		// Selecting Other reveals the text input and a Submit button (disabled until text).
		await page.locator('input[type=radio][value="__OTHER__"]').click({ force: true });
		await expect(page.locator(".ask-other-input")).toBeVisible();
		await expect(page.locator(".ask-submit")).toBeDisabled();
		await page.locator(".ask-other-input").fill("custom");
		await expect(page.locator(".ask-submit")).toBeEnabled();
	});

	test("single question multi-select: tabs hidden but Submit button remains", async ({ page }) => {
		await page.evaluate(() => (window as any).mountWidget({
			questions: [{ question: "Pick all", options: ["a", "b"], multi: true }],
		}));
		await expect(page.locator('[role="tab"]')).toHaveCount(0);
		// Multi-select always needs explicit confirmation.
		await expect(page.locator(".ask-submit")).toBeDisabled();
		await page.locator('label:has(input[value="a"])').click();
		await expect(page.locator(".ask-submit")).toBeEnabled();
	});

	test("failed submit surfaces server error message", async ({ page }) => {
		// Use two questions so the Submit button is rendered and the flow is explicit
		// (single-question mode auto-submits, which is covered separately).
		await page.evaluate(() => (window as any).mountWidget({
			questions: [
				{ question: "Q1", options: ["a", "b"], tab_label: "First" },
				{ question: "Q2", options: ["c", "d"], tab_label: "Second" },
			],
			submitFetch: async () =>
				new Response(JSON.stringify({ error: "No pending question for this session/toolUseId" }), { status: 404, headers: { "Content-Type": "application/json" } }),
		}));
		await page.locator('input[type=radio][value="a"]').click({ force: true });
		await page.locator('input[type=radio][value="c"]').click({ force: true });
		await page.locator(".ask-submit").click();
		// Submit button remains visible (not read-only); error surfaces.
		await expect(page.locator(".ask-submit-error")).toHaveText(/No pending question/);
		await expect(page.locator(".ask-submit")).toBeVisible();
	});

	// ── Label polish ───────────────────────────────────────────────────────

	test("multi-question: tabs render as 'A. <tab_label>', 'B. <tab_label>'", async ({ page }) => {
		await page.evaluate(() => (window as any).mountWidget({
			questions: [
				{ question: "How often?",    options: ["rare", "often"], tab_label: "User behavior" },
				{ question: "Which scope?",  options: ["small", "big"],   tab_label: "Design scope" },
				{ question: "When to follow up?", options: ["now", "later"], tab_label: "Follow-up" },
			],
		}));
		const letters = await page.locator('[role="tab"] .ask-tab-letter').allTextContents();
		expect(letters).toEqual(["A.", "B.", "C."]);
		const labels = await page.locator('[role="tab"] .ask-tab-label').allTextContents();
		expect(labels).toEqual(["User behavior", "Design scope", "Follow-up"]);
	});

	test("options render with 1-based numeric prefix, including Other", async ({ page }) => {
		await page.evaluate(() => (window as any).mountWidget({
			questions: [{ question: "Pick", options: ["red", "green", "blue"], allow_other: true }],
		}));
		const idxs = await page.locator(".ask-option-index").allTextContents();
		expect(idxs).toEqual(["1.", "2.", "3.", "4."]);
	});

	// ── Next / Submit ────────────────────────────────────────────────

	test("multi-question: non-last tab shows Next (disabled until valid), last tab shows Submit", async ({ page }) => {
		await page.evaluate(() => (window as any).mountWidget({
			questions: [
				{ question: "Q1", options: ["a", "b"], allow_other: true, tab_label: "First" },
				{ question: "Q2", options: ["c", "d"], tab_label: "Second" },
			],
		}));
		// On tab 0 without selection: Next disabled.
		await expect(page.locator(".ask-submit")).toHaveText("Next");
		await expect(page.locator(".ask-submit")).toBeDisabled();
		// Select 'Other' (no auto-advance) and then type text → Next enables.
		await page.locator('input[type=radio][value="__OTHER__"]').click({ force: true });
		await expect(page.locator(".ask-submit")).toBeDisabled();
		await page.locator('.ask-other-input').fill('freeform');
		await expect(page.locator(".ask-submit")).toBeEnabled();
		// Click Next → goes to tab 1.
		await page.locator('.ask-submit').click();
		await expect(page.locator('[role="tab"][data-tab-index="1"]')).toHaveAttribute("aria-selected", "true");
		// Last tab → button is Submit.
		await expect(page.locator(".ask-submit")).toHaveText("Submit");
	});

	// ── Keyboard ─────────────────────────────────────────────────────────────

	test("ArrowDown/Up move focused option with wrap", async ({ page }) => {
		await page.evaluate(() => (window as any).mountWidget({
			questions: [{ question: "Pick", options: ["a", "b", "c"] }],
		}));
		await page.locator('.ask-option').first().focus();
		await page.keyboard.press("ArrowDown");
		await expect(page.locator('.ask-option[data-option-index="1"]')).toHaveClass(/ask-option-focused/);
		await page.keyboard.press("ArrowDown");
		await expect(page.locator('.ask-option[data-option-index="2"]')).toHaveClass(/ask-option-focused/);
		// Wrap forward.
		await page.keyboard.press("ArrowDown");
		await expect(page.locator('.ask-option[data-option-index="0"]')).toHaveClass(/ask-option-focused/);
		// Wrap backward.
		await page.keyboard.press("ArrowUp");
		await expect(page.locator('.ask-option[data-option-index="2"]')).toHaveClass(/ask-option-focused/);
	});

	test("ArrowLeft/Right on a tab button moves between tabs", async ({ page }) => {
		await page.evaluate(() => (window as any).mountWidget({
			questions: [
				{ question: "Q1", options: ["a", "b"], tab_label: "First" },
				{ question: "Q2", options: ["c", "d"], tab_label: "Second" },
				{ question: "Q3", options: ["e", "f"], tab_label: "Third" },
			],
		}));
		const tab0 = page.locator('[role="tab"][data-tab-index="0"]');
		await tab0.focus();
		await tab0.press("ArrowRight");
		await expect(page.locator('[role="tab"][data-tab-index="1"]')).toHaveAttribute("aria-selected", "true");
		await page.locator('[role="tab"][data-tab-index="1"]').press("ArrowRight");
		await expect(page.locator('[role="tab"][data-tab-index="2"]')).toHaveAttribute("aria-selected", "true");
		// Wraps.
		await page.locator('[role="tab"][data-tab-index="2"]').press("ArrowRight");
		await expect(page.locator('[role="tab"][data-tab-index="0"]')).toHaveAttribute("aria-selected", "true");
	});

	test("Enter on focused option (single-question single-select) selects + auto-submits", async ({ page }) => {
		await page.evaluate(() => (window as any).mountWidget({
			questions: [{ question: "Q1", options: ["a", "b", "c"] }],
			submitFetch: async (_u: string, init: any) => {
				(window as any)._lastSubmitBody = JSON.parse(init.body);
				return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
			},
		}));
		await page.locator('.ask-option').first().focus();
		await page.keyboard.press("ArrowDown"); // focus option 1 ('b')
		await page.keyboard.press("Enter");
		await expect.poll(() => page.evaluate(() => (window as any)._lastSubmitBody)).toBeTruthy();
		const body = await page.evaluate(() => (window as any)._lastSubmitBody);
		expect(body.answers[0].selected).toBe("b");
	});

	test("Enter on primary button clicks Next/Submit", async ({ page }) => {
		await page.evaluate(() => (window as any).mountWidget({
			questions: [
				{ question: "Q1", options: ["a", "b"], tab_label: "First" },
				{ question: "Q2", options: ["c", "d"], tab_label: "Second" },
			],
		}));
		// Select 'a' by number key on Q1 → auto-advance to Q2.
		await page.locator('.ask-option').first().focus();
		await page.keyboard.press("1");
		await expect(page.locator('[role="tab"][data-tab-index="1"]')).toHaveAttribute("aria-selected", "true");
		// On Q2, pick 'c' with number key.
		await page.locator('.ask-option').first().focus();
		await page.keyboard.press("1");
		// Submit enabled.
		await expect(page.locator(".ask-submit")).toBeEnabled();
		await expect(page.locator(".ask-submit")).toHaveText("Submit");
	});

	test("Escape clears the active question (single-select → null; multi-select → [])", async ({ page }) => {
		await page.evaluate(() => (window as any).mountWidget({
			questions: [
				{ question: "Q1", options: ["a", "b"], allow_other: true, tab_label: "First" },
				{ question: "Q2", options: ["c", "d", "e"], multi: true, tab_label: "Second" },
			],
		}));
		// Q1 single-select + Other with text.
		await page.locator('input[type=radio][value="__OTHER__"]').click({ force: true });
		await page.locator('.ask-other-input').fill('typed');
		await expect(page.locator('.ask-other-input')).toHaveValue('typed');
		// Escape outside the text input → clears.
		await page.locator('[role="tab"][data-tab-index="0"]').focus();
		await page.keyboard.press("Escape");
		await expect(page.locator('.ask-other-input')).toHaveCount(0);
		await expect(page.locator('input[type=radio][value="__OTHER__"]')).not.toBeChecked();
		// Q2 multi-select → clears array.
		await page.locator('[role="tab"][data-tab-index="1"]').click();
		await page.locator('label:has(input[value="c"])').click();
		await page.locator('label:has(input[value="d"])').click();
		await expect(page.locator('input[value="c"]')).toBeChecked();
		await page.locator('[role="tab"][data-tab-index="1"]').focus();
		await page.keyboard.press("Escape");
		await expect(page.locator('input[value="c"]')).not.toBeChecked();
		await expect(page.locator('input[value="d"]')).not.toBeChecked();
	});

	test("Number keys: auto-advance on non-last, toggle on multi, no-op on out-of-range", async ({ page }) => {
		await page.evaluate(() => (window as any).mountWidget({
			questions: [
				{ question: "Q1", options: ["a", "b"], tab_label: "First" },
				{ question: "Q2", options: ["c", "d", "e"], multi: true, tab_label: "Second" },
			],
		}));
		await page.locator('[role="tab"][data-tab-index="0"]').focus();
		// '9' on Q1 (only 2 options) → no-op.
		await page.keyboard.press("9");
		await expect(page.locator('[role="tab"][data-tab-index="0"]')).toHaveAttribute("aria-selected", "true");
		// '2' → picks 'b' and auto-advances to Q2.
		await page.keyboard.press("2");
		await expect(page.locator('[role="tab"][data-tab-index="1"]')).toHaveAttribute("aria-selected", "true");
		// On Q2 (multi): '1' toggles 'c' on; '3' toggles 'e' on; '1' again toggles 'c' off.
		await page.keyboard.press("1");
		await page.keyboard.press("3");
		await expect(page.locator('input[value="c"]')).toBeChecked();
		await expect(page.locator('input[value="e"]')).toBeChecked();
		await page.keyboard.press("1");
		await expect(page.locator('input[value="c"]')).not.toBeChecked();
		await expect(page.locator('input[value="e"]')).toBeChecked();
		// Still on Q2 (no auto-advance for multi).
		await expect(page.locator('[role="tab"][data-tab-index="1"]')).toHaveAttribute("aria-selected", "true");
	});

	test("Letter keys jump tabs; out-of-range and single-question ignored", async ({ page }) => {
		await page.evaluate(() => (window as any).mountWidget({
			questions: [
				{ question: "Q1", options: ["a", "b"], tab_label: "First" },
				{ question: "Q2", options: ["c", "d"], tab_label: "Second" },
				{ question: "Q3", options: ["e", "f"], tab_label: "Third" },
			],
		}));
		await page.locator('[role="tab"][data-tab-index="0"]').focus();
		await page.keyboard.press("c"); // lowercase works
		await expect(page.locator('[role="tab"][data-tab-index="2"]')).toHaveAttribute("aria-selected", "true");
		await page.keyboard.press("A");
		await expect(page.locator('[role="tab"][data-tab-index="0"]')).toHaveAttribute("aria-selected", "true");
		// Out-of-range (e.g. 'Z') → no-op.
		await page.keyboard.press("Z");
		await expect(page.locator('[role="tab"][data-tab-index="0"]')).toHaveAttribute("aria-selected", "true");
	});

	test("single-question: letter keys are ignored (no tabs)", async ({ page }) => {
		await page.evaluate(() => (window as any).mountWidget({
			questions: [{ question: "Only", options: ["a", "b"] }],
		}));
		await page.locator('.ask-option').first().focus();
		await page.keyboard.press("B");
		await expect(page.locator('[role="tab"]')).toHaveCount(0);
		// No option selected by letter key.
		await expect(page.locator('input[type=radio][value="b"]')).not.toBeChecked();
	});

	test("No hijack while typing in Other: digits/letters reach the input; Enter still submits", async ({ page }) => {
		await page.evaluate(() => (window as any).mountWidget({
			questions: [{ question: "Only", options: ["a", "b"], allow_other: true }],
			submitFetch: async (_u: string, init: any) => {
				(window as any)._lastSubmitBody = JSON.parse(init.body);
				return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
			},
		}));
		await page.locator('input[type=radio][value="__OTHER__"]').click({ force: true });
		const input = page.locator('.ask-other-input');
		// fill() sets value directly (no per-key re-render focus loss in the fixture).
		await input.fill("3b");
		await expect(input).toHaveValue("3b");
		// Verify that while the text input has focus, shortcuts are NOT hijacked:
		// typing more chars would be intercepted if the widget were listening.
		await input.focus();
		// With focus in Other, letter keys must not switch tabs or clear selection.
		await input.press("a"); // should append 'a'
		await expect(input).toHaveValue("3ba");
		// Enter while focused in Other submits (valid).
		await input.press("Enter");
		await expect.poll(() => page.evaluate(() => (window as any)._lastSubmitBody)).toBeTruthy();
	});

	test("Other numbering = options.length + 1; number key selects Other", async ({ page }) => {
		await page.evaluate(() => (window as any).mountWidget({
			questions: [{ question: "Pick", options: ["a", "b"], allow_other: true }],
		}));
		// Other's prefix should be '3.'
		const idxs = await page.locator(".ask-option-index").allTextContents();
		expect(idxs).toEqual(["1.", "2.", "3."]);
		// Press '3' → selects Other (single-question, Other → does NOT auto-submit).
		await page.locator('.ask-option').first().focus();
		await page.keyboard.press("3");
		await expect(page.locator('input[type=radio][value="__OTHER__"]')).toBeChecked();
		await expect(page.locator('.ask-other-input')).toBeVisible();
	});
});
