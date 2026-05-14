/**
 * Browser E2E tests for the ask_user_choices widget.
 *
 * Covers:
 *  - Agent fires ask_user_choices → widget renders inline.
 *  - User clicks options across tabs (auto-advance verified).
 *  - "Other" is always rendered (no allow_other knob) with an always-visible
 *    text input; selecting Other does not auto-advance.
 *  - Submit enables only when every question answered.
 *  - After Submit, widget is read-only and the tool result lands in chat.
 *  - Cross-client finalization: a second tab showing the same session flips
 *    to read-only when the first tab submits (via the envelope user message
 *    arriving through the normal message_end stream).
 */
import { test, expect } from "./fixtures.js";
import { openApp, createSessionViaUI, sendMessage } from "./ui-helpers.js";

test.describe("ask_user_choices widget (full-stack UI)", () => {
	test("happy path — pick answers, submit, widget flips to read-only", async ({ page, rec }) => {
		await openApp(page);
		await createSessionViaUI(page);
		await rec.capture("Empty session ready");

		// Trigger the mock agent's ask_user_choices branch.
		await sendMessage(page, "please use ask_user_choices");

		// Widget appears.
		const widget = page.locator("ask-user-choices-widget").first();
		await expect(widget).toBeVisible({ timeout: 20_000 });
		await rec.capture("Widget rendered");

		// Two tabs.
		const tabs = widget.locator('[role="tab"]');
		await expect(tabs).toHaveCount(2, { timeout: 10_000 });

		// Tab 1 is active.
		await expect(widget.locator('[role="tab"][data-tab-index="0"]'))
			.toHaveAttribute("aria-selected", "true");

		// Pick "blue" on Q1 — should auto-advance to Q2.
		await widget.locator('label:has(input[value="blue"])').click();
		await expect(widget.locator('[role="tab"][data-tab-index="1"]'))
			.toHaveAttribute("aria-selected", "true", { timeout: 5_000 });
		await rec.capture("Q1 answered — auto-advanced to Q2");

		// "Other" is rendered for the active panel; the free-text input is always
		// visible — even before Other is checked. (Only the active panel is in DOM.)
		await expect(widget.locator("label:has(input[value=\"__OTHER__\"])")).toHaveCount(1);
		await expect(widget.locator(".ask-other-input")).toBeVisible();
		// Pick "Other" on Q2 — last tab, no advance, input already visible.
		await widget.locator('label:has(input[value="__OTHER__"])').click();
		await expect(widget.locator(".ask-other-input")).toBeVisible({ timeout: 5_000 });

		// Submit is still disabled until text is typed.
		const submit = widget.locator(".ask-submit");
		await expect(submit).toBeDisabled();

		await widget.locator(".ask-other-input").fill("tiny");
		await expect(submit).toBeEnabled({ timeout: 5_000 });
		await rec.capture("Other text typed — Submit enabled");

		// Click Submit — widget should go read-only (no Submit button).
		await submit.click();
		await expect(widget.locator(".ask-submit")).toHaveCount(0, { timeout: 10_000 });
		await rec.capture("Submitted — widget read-only");

		// Radio inputs are disabled in read-only mode.
		await expect(widget.locator('input[type="radio"]').first()).toBeDisabled();

		// Switch back to Q1 tab, confirm "blue" is shown as the final answer.
		await widget.locator('[role="tab"][data-tab-index="0"]').click();
		await expect(widget.locator('input[type="radio"][value="blue"]')).toBeChecked();
		await rec.capture("Q1 tab — blue retained");
	});

	test("persistence across reload — Other still rendered with always-visible input", async ({ page }) => {
		await openApp(page);
		await createSessionViaUI(page);
		await sendMessage(page, "please use ask_user_choices");

		const widget = page.locator("ask-user-choices-widget").first();
		await expect(widget).toBeVisible({ timeout: 20_000 });
		// Pre-submit: Other rendered on the active panel; text input visible.
		await expect(widget.locator("label:has(input[value=\"__OTHER__\"])")).toHaveCount(1);
		await expect(widget.locator(".ask-other-input")).toBeVisible();
		// Switch to Q2; Other still rendered, input still visible.
		await widget.locator('[role="tab"][data-tab-index="1"]').click();
		await expect(widget.locator("label:has(input[value=\"__OTHER__\"])")).toHaveCount(1);
		await expect(widget.locator(".ask-other-input")).toBeVisible();

		// Reload the page mid-flow.
		await page.reload();
		await expect(
			page.locator("button").filter({ hasText: "Settings" }).first(),
		).toBeVisible({ timeout: 20_000 });

		// Widget re-renders; Other row + always-visible text input survive on the active panel.
		const restored = page.locator("ask-user-choices-widget").first();
		await expect(restored).toBeVisible({ timeout: 20_000 });
		await expect(restored.locator("label:has(input[value=\"__OTHER__\"])")).toHaveCount(1);
		await expect(restored.locator(".ask-other-input")).toBeVisible();
	});

	test("cleanup — Escape clears the always-visible Other text input", async ({ page }) => {
		await openApp(page);
		await createSessionViaUI(page);
		await sendMessage(page, "please use ask_user_choices");

		const widget = page.locator("ask-user-choices-widget").first();
		await expect(widget).toBeVisible({ timeout: 20_000 });

		// Type into Other input speculatively (without selecting Other).
		const input = widget.locator(".ask-other-input");
		await input.fill("abc");
		await expect(input).toHaveValue("abc");
		// Other radio not yet checked.
		await expect(widget.locator('input[type="radio"][value="__OTHER__"]').first())
			.not.toBeChecked();

		// Click Other to check it, then press Escape on the active tab to clear.
		await widget.locator('label:has(input[value="__OTHER__"])').first().click();
		await expect(widget.locator('input[type="radio"][value="__OTHER__"]').first()).toBeChecked();
		await widget.locator('[role="tab"][data-tab-index="0"]').focus();
		await page.keyboard.press("Escape");

		// After Escape: text empty, Other unchecked, input still rendered.
		await expect(input).toHaveValue("");
		await expect(widget.locator('input[type="radio"][value="__OTHER__"]').first())
			.not.toBeChecked();
		await expect(input).toBeVisible();
	});

	test("reload → widget restored read-only from persisted tool result", async ({ page }) => {
		await openApp(page);
		await createSessionViaUI(page);

		await sendMessage(page, "please use ask_user_choices");
		const widget = page.locator("ask-user-choices-widget").first();
		await expect(widget).toBeVisible({ timeout: 20_000 });

		// Answer Q1 (auto-advance), then answer Q2 non-Other, then submit.
		await widget.locator('label:has(input[value="red"])').click();
		await expect(widget.locator('[role="tab"][data-tab-index="1"]'))
			.toHaveAttribute("aria-selected", "true", { timeout: 5_000 });
		await widget.locator('label:has(input[value="medium"])').click();
		await widget.locator(".ask-submit").click();
		await expect(widget.locator(".ask-submit")).toHaveCount(0, { timeout: 10_000 });

		// Reload the page.
		await page.reload();

		// App is ready again.
		await expect(
			page.locator("button").filter({ hasText: "Settings" }).first(),
		).toBeVisible({ timeout: 20_000 });

		// Widget renders from persisted tool result, no Submit button.
		const restored = page.locator("ask-user-choices-widget").first();
		await expect(restored).toBeVisible({ timeout: 20_000 });
		await expect(restored.locator(".ask-submit")).toHaveCount(0);
	});

	test("cross-client finalization — second tab flips to read-only", async ({ page, context, rec }) => {
		await openApp(page);
		await createSessionViaUI(page);
		await sendMessage(page, "please use ask_user_choices");

		const widget = page.locator("ask-user-choices-widget").first();
		await expect(widget).toBeVisible({ timeout: 20_000 });
		await rec.capture("Tab 1 — widget rendered");
		const pendingUrl = page.url();

		// Open a second tab pointed at the same session.
		const page2 = await context.newPage();
		await page2.goto(pendingUrl);
		const widget2 = page2.locator("ask-user-choices-widget").first();
		await expect(widget2).toBeVisible({ timeout: 20_000 });
		// Second tab still has the Submit button (not yet answered).
		await expect(widget2.locator(".ask-submit")).toBeVisible();
		await rec.capture("Tab 2 — widget mirrors pending state");

		// Submit from the first tab.
		await widget.locator('label:has(input[value="blue"])').click();
		await expect(widget.locator('[role="tab"][data-tab-index="1"]'))
			.toHaveAttribute("aria-selected", "true", { timeout: 5_000 });
		await widget.locator('label:has(input[value="large"])').click();
		await widget.locator(".ask-submit").click();
		await expect(widget.locator(".ask-submit")).toHaveCount(0, { timeout: 10_000 });
		await rec.capture("Tab 1 submitted — read-only");

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

		// Focus the first tab so keyboard input targets the widget.
		const tab0 = widget.locator('[role="tab"][data-tab-index="0"]');
		await tab0.focus();
		// Wait for focus to settle before pressing keys — under load, focus()
		// returns before the browser has actually given focus to the element.
		await expect.poll(
			() => page.evaluate(() => {
				const el = document.querySelector('[role="tab"][data-tab-index="0"]');
				return el && document.activeElement === el;
			}),
			{ timeout: 5_000 },
		).toBe(true);

		// Press '1' → picks option 1 on Q1 ("red") and auto-advances to Q2.
		// Use locator.press() to dispatch directly on the focused element —
		// more robust than page.keyboard.press() under load.
		await tab0.press("1");
		await expect(widget.locator('[role="tab"][data-tab-index="1"]'))
			.toHaveAttribute("aria-selected", "true", { timeout: 12_000 });

		// Re-focus for keyboard targeting on the new tab panel.
		const tab1 = widget.locator('[role="tab"][data-tab-index="1"]');
		await tab1.focus();
		// Wait for focus to settle.
		await expect.poll(
			() => page.evaluate(() => {
				const el = document.querySelector('[role="tab"][data-tab-index="1"]');
				return el && document.activeElement === el;
			}),
			{ timeout: 5_000 },
		).toBe(true);

		// Press '2' → picks option 2 on Q2 ("medium"). Last tab → no advance.
		await tab1.press("2");
		await expect(widget.locator('input[type="radio"][value="medium"]')).toBeChecked();

		// Primary button should now be Submit (last tab) and enabled.
		const submit = widget.locator(".ask-submit");
		await expect(submit).toHaveText("Submit");
		await expect(submit).toBeEnabled();

		// Press Enter → submits. Focus the Submit button first so Enter targets it.
		await submit.focus();
		await page.keyboard.press("Enter");
		await expect(widget.locator(".ask-submit")).toHaveCount(0, { timeout: 10_000 });
		await expect(widget.locator('input[type="radio"]').first()).toBeDisabled();

		// Confirm Q1 "red" survived as the recorded answer.
		await widget.locator('[role="tab"][data-tab-index="0"]').click();
		await expect(widget.locator('input[type="radio"][value="red"]')).toBeChecked();
	});
});
