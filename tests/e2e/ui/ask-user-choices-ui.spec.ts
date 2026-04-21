/**
 * Browser E2E tests for the ask_user_choices widget.
 *
 * Covers:
 *  - Agent fires ask_user_choices → widget renders inline.
 *  - User clicks options across tabs (auto-advance verified).
 *  - allow_other: text input appears, no auto-advance.
 *  - Submit enables only when every question answered.
 *  - After Submit, widget is read-only and the tool result lands in chat.
 *  - Cross-client finalization: a second tab showing the same session flips
 *    to read-only when the first tab submits (via the envelope user message
 *    arriving through the normal message_end stream).
 */
import { test, expect } from "../gateway-harness.js";
import { openApp, createSessionViaUI, sendMessage } from "./ui-helpers.js";

test.describe("ask_user_choices widget (full-stack UI)", () => {
	test("happy path — pick answers, submit, widget flips to read-only", async ({ page }) => {
		await openApp(page);
		await createSessionViaUI(page);

		// Trigger the mock agent's ask_user_choices branch.
		await sendMessage(page, "please use ask_user_choices");

		// Widget appears.
		const widget = page.locator("ask-user-choices-widget").first();
		await expect(widget).toBeVisible({ timeout: 20_000 });

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

		// Q2 has allow_other. Pick "Other" — should NOT auto-advance off the last tab anyway,
		// and should reveal the free-text input.
		await widget.locator('label:has(input[value="__OTHER__"])').click();
		await expect(widget.locator(".ask-other-input")).toBeVisible({ timeout: 5_000 });

		// Submit is still disabled until text is typed.
		const submit = widget.locator(".ask-submit");
		await expect(submit).toBeDisabled();

		await widget.locator(".ask-other-input").fill("tiny");
		await expect(submit).toBeEnabled({ timeout: 5_000 });

		// Click Submit — widget should go read-only (no Submit button).
		await submit.click();
		await expect(widget.locator(".ask-submit")).toHaveCount(0, { timeout: 10_000 });

		// Radio inputs are disabled in read-only mode.
		await expect(widget.locator('input[type="radio"]').first()).toBeDisabled();

		// Switch back to Q1 tab, confirm "blue" is shown as the final answer.
		await widget.locator('[role="tab"][data-tab-index="0"]').click();
		await expect(widget.locator('input[type="radio"][value="blue"]')).toBeChecked();
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

	test("cross-client finalization — second tab flips to read-only", async ({ page, context }) => {
		await openApp(page);
		await createSessionViaUI(page);
		await sendMessage(page, "please use ask_user_choices");

		const widget = page.locator("ask-user-choices-widget").first();
		await expect(widget).toBeVisible({ timeout: 20_000 });
		const pendingUrl = page.url();

		// Open a second tab pointed at the same session.
		const page2 = await context.newPage();
		await page2.goto(pendingUrl);
		const widget2 = page2.locator("ask-user-choices-widget").first();
		await expect(widget2).toBeVisible({ timeout: 20_000 });
		// Second tab still has the Submit button (not yet answered).
		await expect(widget2.locator(".ask-submit")).toBeVisible();

		// Submit from the first tab.
		await widget.locator('label:has(input[value="blue"])').click();
		await expect(widget.locator('[role="tab"][data-tab-index="1"]'))
			.toHaveAttribute("aria-selected", "true", { timeout: 5_000 });
		await widget.locator('label:has(input[value="large"])').click();
		await widget.locator(".ask-submit").click();
		await expect(widget.locator(".ask-submit")).toHaveCount(0, { timeout: 10_000 });

		// Second tab should also flip to read-only — the envelope user message
		// appended by /submit is broadcast via the normal message_end stream,
		// and the tool_use card's renderer scans the transcript for it.
		await expect(widget2.locator(".ask-submit")).toHaveCount(0, { timeout: 15_000 });
		await expect(widget2.locator('input[type="radio"]').first()).toBeDisabled();

		await page2.close();
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
		await widget.locator('[role="tab"][data-tab-index="0"]').focus();

		// Press '1' → picks option 1 on Q1 ("red") and auto-advances to Q2.
		await page.keyboard.press("1");
		await expect(widget.locator('[role="tab"][data-tab-index="1"]'))
			.toHaveAttribute("aria-selected", "true", { timeout: 5_000 });

		// Re-focus for keyboard targeting on the new tab panel.
		await widget.locator('[role="tab"][data-tab-index="1"]').focus();

		// Press '2' → picks option 2 on Q2 ("medium"). Last tab → no advance.
		await page.keyboard.press("2");
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
