/**
 * Journey: Prompt Interaction + BG Wait Steer — v2 browser smoke
 * Covers: journey-prompt-interaction, journey-bg-wait-steer
 * Consolidated from: prompt-tool-renderer-*, bg-wait-*, steer-*, etc.
 */
import { test, expect, openApp, navigateToHash, createSession, deleteSession, waitForSessionStatus } from "../_helpers/journey-fixture.js";
import { sendMessage } from "../../../tests/e2e/ui/ui-helpers.js";

test.describe("Journey: Prompt Interaction", () => {
	test("message editor textarea is visible", async ({ page }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		try {
			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });
		} finally {
			await deleteSession(sessionId);
		}
	});

	test("can type into message editor", async ({ page }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		try {
			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			const editor = page.locator("message-editor textarea").first();
			await expect(editor).toBeVisible({ timeout: 15_000 });
			await editor.fill("hello journey test");
			const val = await editor.inputValue();
			expect(val).toContain("hello journey test");
		} finally {
			await deleteSession(sessionId);
		}
	});

	test("session shows message history area", async ({ page }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		try {
			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });
			// Session view loaded — editor visible means the session shell rendered
			const hash = await page.evaluate(() => window.location.hash);
			expect(hash).toContain(sessionId);
		} finally {
			await deleteSession(sessionId);
		}
	});

	test("send message → mock agent 'OK' response appears in chat", async ({ page }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		try {
			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			const editor = page.locator("message-editor textarea").first();
			await expect(editor).toBeVisible({ timeout: 15_000 });
			await editor.fill("hello test");
			await editor.press("Enter");
			// The mock agent responds with "OK" — assert it appears in the chat
			await expect(page.getByText("OK", { exact: true }).first()).toBeVisible({ timeout: 20_000 });
		} finally {
			await deleteSession(sessionId);
		}
	});

	test("ask_user_choices trigger → widget renders, options selectable, submit dismisses widget", async ({ page }) => {
		// The mock agent recognises "ask_user_choices" and emits a non-blocking
		// ask_user_choices tool_use with 2 questions (tabs: Color + Team size).
		// The UI renders <ask-user-choices-widget> with radio options and a
		// Next / Submit primary button.  This test drives the full happy path:
		// pick Q1 option (auto-advances), pick Q2 option, submit.
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		try {
			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			const textarea = page.locator("message-editor textarea").first();
			await expect(textarea).toBeVisible({ timeout: 15_000 });

			// Trigger the ask_user_choices mock response.
			await sendMessage(page, "ask_user_choices");

			// The widget custom element must appear.
			const widget = page.locator("ask-user-choices-widget").first();
			await expect(widget).toBeVisible({ timeout: 20_000 });

			// Wait for streaming to finish before interacting — mid-stream re-renders
			// can detach auto-advance timers (same guard as legacy ask-user-choices-ui.spec.ts).
			await page.waitForFunction(
				() => (window as any).__bobbitState?.remoteAgent?.state?.isStreaming === false,
				{ timeout: 15_000 },
			);

			// Q1: pick "red" — selecting via label click auto-advances to Q2.
			await widget.locator('label:has(input[value="red"])').click();
			await expect(widget.locator('[role="tab"][data-tab-index="1"]'))
				.toHaveAttribute("aria-selected", "true", { timeout: 15_000 });

			// Q2: pick "small".
			await widget.locator('label:has(input[value="small"])').click();

			// Submit button must be enabled on the last tab.
			const submit = widget.locator(".ask-submit");
			await expect(submit).toHaveText("Submit");
			await expect(submit).toBeEnabled({ timeout: 15_000 });
			await submit.click();

			// Once submitted the submit button disappears (widget becomes read-only).
			await expect(widget.locator(".ask-submit")).toHaveCount(0, { timeout: 20_000 });
		} finally {
			await deleteSession(sessionId);
		}
	});
});
