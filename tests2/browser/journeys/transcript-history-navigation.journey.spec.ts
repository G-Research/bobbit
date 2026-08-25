import type { Locator, Page } from "@playwright/test";
import {
	createSession,
	deleteSession,
	expect,
	navigateToHash,
	openApp,
	sendMessage,
	test,
	waitForAgentResponse,
	waitForSessionStatus,
} from "../_helpers/journey-fixture.js";

const DESKTOP = { width: 1280, height: 800 };
const MOBILE = { width: 360, height: 720 };

function previousButton(page: Page): Locator {
	return page.getByTestId("jump-to-previous-prompt");
}

function unansweredButton(page: Page): Locator {
	return page.getByTestId("jump-to-unanswered-question");
}

function historyButton(page: Page): Locator {
	return page.getByTestId("jump-to-transcript-history");
}

function dialog(page: Page): Locator {
	return page.locator("transcript-history-popover [role='dialog']");
}

function rows(page: Page): Locator {
	return dialog(page).locator(".transcript-history-row");
}

async function openHistory(page: Page): Promise<void> {
	await historyButton(page).click();
	await expect(dialog(page)).toBeVisible();
	await expect(historyButton(page)).toHaveAttribute("aria-expanded", "true");
	await expect(dialog(page).locator(".transcript-history-search")).toBeFocused();
}

async function completeQuestion(page: Page): Promise<void> {
	const widget = page.locator("ask-user-choices-widget").first();
	await widget.locator('label:has(input[value="red"])').click();
	await expect(widget.locator('[role="tab"][data-tab-index="1"]')).toHaveAttribute("aria-selected", "true");
	await widget.locator('label:has(input[value="small"])').click();
	await widget.locator(".ask-submit").click();
	await expect(widget.locator(".ask-widget")).toHaveClass(/ask-answered/, { timeout: 20_000 });
}

test.describe("Journey: Transcript history navigation", () => {
	test("searches, filters, jumps, resolves unanswered questions, reloads, and stays usable on narrow screens", async ({ page }) => {
		test.setTimeout(120_000);
		const sessionId = await createSession();
		try {
			await page.setViewportSize(DESKTOP);
			await Promise.all([openApp(page), waitForSessionStatus(sessionId, "idle")]);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 20_000 });

			const firstMarker = "TRANSCRIPT_HISTORY_OLDEST_MARKER";
			const longPrompt = [firstMarker, ...Array.from({ length: 45 }, (_, index) => `History setup line ${index + 1}`)].join("\n\n");
			await sendMessage(page, longPrompt);
			await waitForAgentResponse(page);
			await waitForSessionStatus(sessionId, "idle");
			await sendMessage(page, "ask_user_choices transcript navigation journey");
			const widget = page.locator("ask-user-choices-widget").first();
			await expect(widget).toBeVisible({ timeout: 20_000 });
			await waitForSessionStatus(sessionId, "idle");

			const navigation = page.locator("[role='group'][aria-label='Transcript navigation']");
			await expect(navigation).toBeVisible();
			await expect(previousButton(page)).toHaveCount(1);
			await expect(unansweredButton(page)).toHaveAttribute("aria-label", /1 unanswered question/);
			await expect(unansweredButton(page).locator(".transcript-unanswered-count")).toHaveText("1");
			await expect(historyButton(page)).toHaveAttribute("aria-haspopup", "dialog");

			await openHistory(page);
			const rowTexts = await rows(page).allTextContents();
			const oldestIndex = rowTexts.findIndex((text) => text.includes(firstMarker));
			const askPromptIndex = rowTexts.findIndex((text) => text.includes("ask_user_choices transcript navigation journey"));
			const questionIndex = rowTexts.findIndex((text) => text.includes("Favorite color?") && text.includes("Team size?"));
			expect(oldestIndex).toBeGreaterThanOrEqual(0);
			expect(askPromptIndex).toBeGreaterThan(oldestIndex);
			expect(questionIndex).toBeGreaterThan(askPromptIndex);
			await expect(dialog(page)).not.toContainText("Recent");
			await expect(dialog(page)).not.toContainText("Earlier today");
			await expect(dialog(page).locator("kbd")).toHaveCount(0);
			expect(await dialog(page).locator(".transcript-history-list").evaluate((list) =>
				list.scrollTop + list.clientHeight >= list.scrollHeight - 4)).toBe(true);

			// Search and filter compose, including the explicit empty state.
			const search = dialog(page).locator(".transcript-history-search");
			await search.fill("Favorite color");
			await expect(rows(page)).toHaveCount(1);
			await expect(rows(page).first()).toContainText("Unanswered");
			await dialog(page).getByRole("button", { name: "User", exact: true }).click();
			await expect(dialog(page).getByRole("status")).toHaveText("No matching prompts");
			await dialog(page).getByRole("button", { name: "Questions", exact: true }).click();
			await expect(rows(page)).toHaveCount(1);
			await search.fill("");
			await expect(rows(page)).toHaveCount(1);

			// Selecting an entry closes the dialog, escapes tail-following, and highlights its transcript target.
			await rows(page).first().click();
			await expect(dialog(page)).toHaveCount(0);
			await expect(historyButton(page)).toBeFocused();
			await expect(page.locator(".transcript-navigation-highlight")).toHaveCount(1);
			await expect(page.locator("agent-interface [role='status'][aria-live='polite']")).toContainText("Jumped to unanswered question");

			// Standard Escape and outside-pointer dismissal restore focus without shortcut UI.
			await openHistory(page);
			await page.keyboard.press("Escape");
			await expect(dialog(page)).toHaveCount(0);
			await expect(historyButton(page)).toBeFocused();
			await openHistory(page);
			await page.locator("message-editor textarea").first().click({ position: { x: 4, y: 4 } });
			await expect(dialog(page)).toHaveCount(0);

			// Reload must rederive the unresolved ask from the authoritative transcript.
			await page.reload({ waitUntil: "domcontentloaded" });
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 20_000 });
			await expect(unansweredButton(page)).toHaveAttribute("aria-label", /1 unanswered question/, { timeout: 20_000 });

			// Narrow layout keeps the segmented controls and popover inside viewport gutters.
			await page.setViewportSize(MOBILE);
			await expect(navigation).toBeVisible();
			const groupBox = await navigation.boundingBox();
			expect(groupBox).not.toBeNull();
			expect(groupBox!.x).toBeGreaterThanOrEqual(0);
			expect(groupBox!.x + groupBox!.width).toBeLessThanOrEqual(MOBILE.width);
			await expect(previousButton(page).locator("span").first()).toHaveClass(/sr-only/);
			await openHistory(page);
			const dialogBox = await dialog(page).boundingBox();
			expect(dialogBox).not.toBeNull();
			expect(dialogBox!.x).toBeGreaterThanOrEqual(12);
			expect(dialogBox!.x + dialogBox!.width).toBeLessThanOrEqual(MOBILE.width - 12);
			await page.keyboard.press("Escape");
			expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

			// Direct unanswered navigation remains available and answering removes it immediately.
			await unansweredButton(page).click();
			await expect(page.locator(".transcript-navigation-highlight")).toHaveCount(1);
			await completeQuestion(page);
			await expect(unansweredButton(page)).toHaveCount(0, { timeout: 20_000 });

			await page.reload({ waitUntil: "domcontentloaded" });
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 20_000 });
			await expect(page.locator(".ask-answered-badge").first()).toHaveText("Answered", { timeout: 20_000 });
			await expect(unansweredButton(page)).toHaveCount(0);
		} finally {
			await deleteSession(sessionId).catch(() => {});
		}
	});
});
