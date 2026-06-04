/**
 * Browser E2E tests for the ask_user_choices widget.
 *
 * Covers:
 *  - Agent fires ask_user_choices → widget renders inline.
 *  - User clicks options across tabs (auto-advance verified).
 *  - "Other" is always rendered (no allow_other knob) with an always-visible
 *    text input; selecting Other does not auto-advance.
 *  - Escape clears the active question's selection and Other text.
 *  - Pending widgets survive reload; submitted widgets restore read-only.
 *  - After Submit, widget is read-only and the tool result lands in chat.
 *  - Cross-client finalization: a second tab showing the same session flips
 *    to read-only when the first tab submits (via the envelope user message
 *    arriving through the normal message_end stream).
 *  - Keyboard-only multi-question submission.
 */
import { test, expect } from "./fixtures.js";
import { openApp, createSessionViaUI, sendMessage } from "./ui-helpers.js";

test.describe("ask_user_choices widget (full-stack UI)", () => {
	test("composite widget lifecycle — Other cleanup, reload persistence, and read-only restore", async ({ page, rec }) => {
		await openApp(page);
		await createSessionViaUI(page);
		await rec.capture("Empty session ready");

		// Trigger the mock agent's ask_user_choices branch with a composite tool_use_id.
		await sendMessage(page, "please use ask_user_choices_composite");

		// Widget appears.
		const widget = page.locator("ask-user-choices-widget").first();
		await expect(widget).toBeVisible({ timeout: 20_000 });
		await expect.poll(
			() => widget.evaluate((el) => (el as any).toolUseId as string),
			{ timeout: 10_000 },
		).toContain("|");
		await rec.capture("Widget rendered");

		// Two tabs, with tab 1 active.
		const tabs = widget.locator('[role="tab"]');
		await expect(tabs).toHaveCount(2, { timeout: 10_000 });
		await expect(widget.locator('[role="tab"][data-tab-index="0"]'))
			.toHaveAttribute("aria-selected", "true");

		// "Other" is rendered for the active panel; the free-text input is always
		// visible — even before Other is checked. (Only the active panel is in DOM.)
		await expect(widget.locator("label:has(input[value=\"__OTHER__\"])")).toHaveCount(1);
		const input = widget.locator(".ask-other-input");
		await expect(input).toBeVisible();

		// Type into Other speculatively, select it, then Escape clears both the
		// selection and text without removing the always-visible input.
		await input.fill("abc");
		await expect(input).toHaveValue("abc");
		await expect(widget.locator('input[type="radio"][value="__OTHER__"]').first())
			.not.toBeChecked();
		await widget.locator('label:has(input[value="__OTHER__"])').first().click();
		await expect(widget.locator('[role="tab"][data-tab-index="0"]'))
			.toHaveAttribute("aria-selected", "true");
		await expect(widget.locator('input[type="radio"][value="__OTHER__"]').first()).toBeChecked();
		await widget.locator('[role="tab"][data-tab-index="0"]').focus();
		await page.keyboard.press("Escape");
		await expect(input).toHaveValue("");
		await expect(widget.locator('input[type="radio"][value="__OTHER__"]').first())
			.not.toBeChecked();
		await expect(input).toBeVisible();
		await rec.capture("Other cleared by Escape");

		// Switch to Q2; Other still renders with an always-visible text input.
		await widget.locator('[role="tab"][data-tab-index="1"]').click();
		await expect(widget.locator("label:has(input[value=\"__OTHER__\"])")).toHaveCount(1);
		await expect(widget.locator(".ask-other-input")).toBeVisible();

		// Reload mid-flow. The pending interactive widget re-renders from the transcript.
		await page.reload();
		await expect(
			page.locator("button").filter({ hasText: "Settings" }).first(),
		).toBeVisible({ timeout: 20_000 });
		const restored = page.locator("ask-user-choices-widget").first();
		await expect(restored).toBeVisible({ timeout: 20_000 });
		await expect(restored.locator("label:has(input[value=\"__OTHER__\"])")).toHaveCount(1);
		await expect(restored.locator(".ask-other-input")).toBeVisible();
		await expect(restored.locator(".ask-submit")).toBeVisible();
		await rec.capture("Pending widget restored after reload");

		// Pick "blue" on Q1 — should auto-advance to Q2.
		await restored.locator('[role="tab"][data-tab-index="0"]').click();
		await expect(restored.locator('[role="tab"][data-tab-index="0"]'))
			.toHaveAttribute("aria-selected", "true");
		await restored.locator('label:has(input[value="blue"])').click();
		await expect(restored.locator('[role="tab"][data-tab-index="1"]'))
			.toHaveAttribute("aria-selected", "true", { timeout: 5_000 });
		await rec.capture("Q1 answered — auto-advanced to Q2");

		// Pick "Other" on Q2 — last tab, no advance, input already visible.
		await restored.locator('label:has(input[value="__OTHER__"])').click();
		await expect(restored.locator(".ask-other-input")).toBeVisible({ timeout: 5_000 });

		// Submit is still disabled until text is typed.
		const submit = restored.locator(".ask-submit");
		await expect(submit).toBeDisabled();
		await restored.locator(".ask-other-input").fill("tiny");
		await expect(submit).toBeEnabled({ timeout: 5_000 });
		await rec.capture("Other text typed — Submit enabled");

		// Click Submit — widget should go read-only (no Submit button).
		await submit.click();
		await expect(restored.locator(".ask-submit")).toHaveCount(0, { timeout: 10_000 });
		await expect(page.locator("user-message").filter({ hasText: "ask_user_choices_response" })).toHaveCount(0);
		await expect(restored.locator('input[type="radio"]').first()).toBeDisabled();
		await rec.capture("Submitted — widget read-only");

		// Switch back to Q1 tab, confirm "blue" is shown as the final answer.
		await restored.locator('[role="tab"][data-tab-index="0"]').click();
		await expect(restored.locator('input[type="radio"][value="blue"]')).toBeChecked();
		await rec.capture("Q1 tab — blue retained");

		// Reload after submission. The persisted tool result restores read-only state.
		await page.reload();
		await expect(
			page.locator("button").filter({ hasText: "Settings" }).first(),
		).toBeVisible({ timeout: 20_000 });
		const readOnly = page.locator("ask-user-choices-widget").first();
		await expect(readOnly).toBeVisible({ timeout: 20_000 });
		await expect(readOnly.locator(".ask-submit")).toHaveCount(0);
		await expect(readOnly.locator('input[type="radio"]').first()).toBeDisabled();
	});

	test("indicator shape — square for multi-select, circular for single-select", async ({ page }) => {
		await openApp(page);
		await createSessionViaUI(page);

		// ask_user_choices_multi → Q1 ("Which colors?", multi:true) + Q2 ("Team size?", single).
		await sendMessage(page, "please use ask_user_choices_multi");

		const widget = page.locator("ask-user-choices-widget").first();
		await expect(widget).toBeVisible({ timeout: 20_000 });

		// Q1 is the active tab and is multi-select → indicators must be square
		// (rounded-sm) and NOT circular (rounded-full). Covers regular options.
		await expect(widget.locator('[role="tab"][data-tab-index="0"]'))
			.toHaveAttribute("aria-selected", "true");
		const multiChecks = widget.locator(".ask-option:not(.ask-option-other) .ask-option-check");
		await expect(multiChecks.first()).toBeVisible();
		const multiCount = await multiChecks.count();
		expect(multiCount).toBeGreaterThan(0);
		for (let i = 0; i < multiCount; i++) {
			await expect(multiChecks.nth(i)).toHaveClass(/rounded-sm/);
			await expect(multiChecks.nth(i)).not.toHaveClass(/rounded-full/);
		}
		// "Other" option indicator on a multi-select question is also square.
		const multiOther = widget.locator(".ask-option-other .ask-option-check");
		await expect(multiOther).toHaveClass(/rounded-sm/);
		await expect(multiOther).not.toHaveClass(/rounded-full/);

		// Switch to Q2 (single-select) → indicators must be circular (rounded-full)
		// and NOT square (rounded-sm).
		await widget.locator('[role="tab"][data-tab-index="1"]').click();
		await expect(widget.locator('[role="tab"][data-tab-index="1"]'))
			.toHaveAttribute("aria-selected", "true");
		const singleChecks = widget.locator(".ask-option:not(.ask-option-other) .ask-option-check");
		await expect(singleChecks.first()).toBeVisible();
		const singleCount = await singleChecks.count();
		expect(singleCount).toBeGreaterThan(0);
		for (let i = 0; i < singleCount; i++) {
			await expect(singleChecks.nth(i)).toHaveClass(/rounded-full/);
			await expect(singleChecks.nth(i)).not.toHaveClass(/rounded-sm/);
		}
		// "Other" option indicator on a single-select question is circular.
		const singleOther = widget.locator(".ask-option-other .ask-option-check");
		await expect(singleOther).toHaveClass(/rounded-full/);
		await expect(singleOther).not.toHaveClass(/rounded-sm/);
	});

	test("cross-client finalization via keyboard-only submission", async ({ page, context, rec }) => {
		await openApp(page);
		await createSessionViaUI(page);
		await sendMessage(page, "please use ask_user_choices");

		const widget = page.locator("ask-user-choices-widget").first();
		await expect(widget).toBeVisible({ timeout: 20_000 });
		await rec.capture("Tab 1 — widget rendered");
		const pendingUrl = page.url();

		// Tab strip uses lettered tab_label.
		const letters = widget.locator('[role="tab"] .ask-tab-letter');
		await expect(letters.first()).toHaveText("A.");
		await expect(letters.nth(1)).toHaveText("B.");

		// Open a second tab pointed at the same session.
		const page2 = await context.newPage();
		await page2.goto(pendingUrl);
		const widget2 = page2.locator("ask-user-choices-widget").first();
		await expect(widget2).toBeVisible({ timeout: 20_000 });
		// Second tab still has the Submit button (not yet answered).
		await expect(widget2.locator(".ask-submit")).toBeVisible();
		await rec.capture("Tab 2 — widget mirrors pending state");

		// Submit from the first tab using only the keyboard.
		await widget.locator('[role="tab"][data-tab-index="0"]').focus();
		await page.keyboard.press("1");
		await expect(widget.locator('[role="tab"][data-tab-index="1"]'))
			.toHaveAttribute("aria-selected", "true", { timeout: 5_000 });

		// Re-focus for keyboard targeting on the new tab panel.
		await widget.locator('[role="tab"][data-tab-index="1"]').focus();
		await page.keyboard.press("2");
		await expect(widget.locator('input[type="radio"][value="medium"]')).toBeChecked();

		// Primary button should now be Submit (last tab) and enabled.
		const submit = widget.locator(".ask-submit");
		await expect(submit).toHaveText("Submit");
		await expect(submit).toBeEnabled();
		await submit.focus();
		await page.keyboard.press("Enter");
		await expect(widget.locator(".ask-submit")).toHaveCount(0, { timeout: 10_000 });
		await expect(widget.locator('input[type="radio"]').first()).toBeDisabled();
		await rec.capture("Tab 1 submitted — read-only");

		// Confirm Q1 "red" survived as the recorded answer.
		await widget.locator('[role="tab"][data-tab-index="0"]').click();
		await expect(widget.locator('input[type="radio"][value="red"]')).toBeChecked();

		// Second tab should also flip to read-only — the envelope user message
		// appended by /submit is broadcast via the normal message_end stream,
		// and the tool_use card's renderer scans the transcript for it.
		await expect(widget2.locator(".ask-submit")).toHaveCount(0, { timeout: 15_000 });
		await expect(widget2.locator('input[type="radio"]').first()).toBeDisabled();
		await rec.capture("Tab 2 also flipped read-only");

		await page2.close();
	});

	test("error path — failed ask renders minimal chip; retry shows exactly one interactive widget", async ({ page }) => {
		// The bug: when ask_user_choices validation fails (e.g. missing tab_label
		// on a multi-question ask) the renderer used to render the FULL interactive
		// widget for the failed call, so after the agent retried the user saw two
		// clickable widgets and couldn't tell which was live.
		//
		// Fix: extension returns isError:true; renderer's `errored` derivation
		// also fires defensively when result is complete but neither posted-stub
		// nor legacy-answers. The failed call collapses to a minimal `.ask-error`
		// chip; only the retry renders an interactive widget.
		//
		// Mock-agent trigger emits both tool_uses back-to-back in the same turn:
		// see `_handleAskUserChoicesErrorThenRetry` in tests/e2e/mock-agent-core.mjs.
		await openApp(page);
		await createSessionViaUI(page);
		await sendMessage(page, "please use ask_user_choices with bad tab labels then retry");

		// Wait for the retry's interactive widget to land.
		const submit = page.locator(".ask-submit");
		await expect(submit).toHaveCount(1, { timeout: 20_000 });

		// Failed call collapsed into the minimal chip; retry rendered full chrome.
		const errorChip = page.locator(".ask-error");
		await expect(errorChip).toHaveCount(1);
		await expect(errorChip).toBeVisible();
		await expect(errorChip).toContainText("tab_label");

		// DOM order: error chip precedes the interactive widget.
		const widget = page.locator("ask-user-choices-widget").filter({ has: page.locator(".ask-submit") }).first();
		await expect(widget).toBeVisible();
		const order = await page.evaluate(() => {
			const chip = document.querySelector(".ask-error");
			const sub = document.querySelector(".ask-submit");
			if (!chip || !sub) return null;
			// DOCUMENT_POSITION_FOLLOWING (4) on `sub` means chip is before sub.
			return chip.compareDocumentPosition(sub) & 4 ? "chip-before-widget" : "chip-after-widget";
		});
		expect(order).toBe("chip-before-widget");

		// There are TWO ask-user-choices-widget elements (one per tool_use), but
		// only ONE shows interactive chrome — the failed one is collapsed.
		await expect(page.locator("[role=\"tab\"]")).toHaveCount(2); // two tabs on the live widget
		await expect(page.locator(".ask-submit")).toHaveCount(1); // exactly one Submit button
	});

	test("keyboard-only multi-question submission", async ({ page }) => {
		await openApp(page);
		await createSessionViaUI(page);

		await sendMessage(page, "please use ask_user_choices");

		const widget = page.locator("ask-user-choices-widget").first();
		await expect(widget).toBeVisible({ timeout: 20_000 });

		// Tab strip uses lettered tab_label.
		const letters = widget.locator('[role="tab"] .ask-tab-letter');
		await expect(letters.first()).toHaveText("A.");
		await expect(letters.nth(1)).toHaveText("B.");

		// Wait for streaming to complete before keyboard interaction. Two interacting
		// races affected this section:
		//   1. `focus(tab)` + `keyboard.press("1")` is non-atomic — focus can shift
		//      between the calls when agent WS events trigger re-renders. Fixed by
		//      using `locator.press()`, which atomically focuses + dispatches.
		//   2. The widget's auto-advance is a 250ms setTimeout scheduled on the widget
		//      *instance*. While the agent is still emitting message_update /
		//      tool_result events, streaming state updates can replace the widget's
		//      DOM element, detaching the timer's `this` reference and silently
		//      dropping the advance. In real usage the user can't press a key faster
		//      than streaming completes; only the test was beating the stream.
		await page.waitForFunction(
			() => (window as any).__bobbitState?.remoteAgent?.state?.isStreaming === false,
			{ timeout: 15_000 },
		);

		// Press '1' on the first tab → picks option 1 on Q1 ("red") and auto-advances to Q2.
		await widget.locator('[role="tab"][data-tab-index="0"]').press("1");
		// Confirm the keystroke landed on the widget (radio recorded), then
		// that auto-advance flipped the active tab.
		await expect(widget.locator('input[type="radio"][value="red"]')).toBeChecked({ timeout: 5_000 });
		await expect(widget.locator('[role="tab"][data-tab-index="1"]'))
			.toHaveAttribute("aria-selected", "true", { timeout: 5_000 });

		// Press '2' on the new active tab → picks option 2 on Q2 ("medium").
		// Last tab → no advance.
		await widget.locator('[role="tab"][data-tab-index="1"]').press("2");
		await expect(widget.locator('input[type="radio"][value="medium"]')).toBeChecked();

		// Primary button should now be Submit (last tab) and enabled.
		const submit = widget.locator(".ask-submit");
		await expect(submit).toHaveText("Submit");
		await expect(submit).toBeEnabled();

		// Press Enter on the Submit button → submits (atomic focus + press).
		await submit.press("Enter");
		await expect(widget.locator(".ask-submit")).toHaveCount(0, { timeout: 10_000 });
		await expect(widget.locator('input[type="radio"]').first()).toBeDisabled();

		// Confirm Q1 "red" survived as the recorded answer.
		await widget.locator('[role="tab"][data-tab-index="0"]').click();
		await expect(widget.locator('input[type="radio"][value="red"]')).toBeChecked();
	});
});
