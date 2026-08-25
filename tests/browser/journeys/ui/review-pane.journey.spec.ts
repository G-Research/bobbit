/**
 * Browser coverage for the real review_open gateway/tool integration path.
 * Review tab management, reload suppression, approve/reject validation, and
 * annotation feedback are covered by tests/ui-fixtures/proposal-review-fixture.spec.ts.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "../../_helpers/journey-fixture.js";
import { createSession, deleteSession, waitForSessionStatus } from "../../_helpers/e2e-setup.js";
import { openApp, sendMessage, waitForAgentResponse, navigateToHash } from "../../../support/harnesses/browser/legacy-ui/ui-helpers.js";

const REVIEW_TITLE = "Test Document";
const REVIEW_PANEL_TAB_SELECTOR = `.goal-tab-pill[data-panel-tab-kind='review'][data-panel-tab-title='Review: ${REVIEW_TITLE}']`;

function reviewTab(page: Page) {
	return page.locator(REVIEW_PANEL_TAB_SELECTOR);
}

async function reviewGroupId(page: Page): Promise<string | null> {
	return page.evaluate((title) => {
		const state = (window as any).bobbitState ?? (window as any).__bobbitState;
		const groups = state?.reviewGroups instanceof Map ? [...state.reviewGroups.values()] : [];
		return groups.find((group: any) => group?.title === title)?.reviewId ?? null;
	}, REVIEW_TITLE);
}

async function goToSession(page: Page, sessionId: string) {
	await navigateToHash(page, `#/session/${sessionId}`);
	await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });
}

async function openReviewDocument(page: Page) {
	await sendMessage(page, "REVIEW_OPEN");
	await waitForAgentResponse(page, { text: "Done. Used review_open tool." });

	const tab = reviewTab(page);
	await expect(tab).toHaveCount(1, { timeout: 10_000 });
	await expect.poll(() => reviewGroupId(page), { timeout: 10_000 }).not.toBeNull();
	const groupId = await reviewGroupId(page);
	await tab.click();
	await expect.poll(
		() => page.evaluate(() => {
			const state = (window as any).bobbitState ?? (window as any).__bobbitState;
			return state?.reviewActiveReviewId ?? null;
		}),
		{ timeout: 5_000 },
	).toBe(groupId);

	const pane = page.locator("review-pane");
	await expect(pane).toBeVisible({ timeout: 5_000 });
	await expect(page.locator("review-document").getByText("Section One").first()).toBeVisible({ timeout: 5_000 });
	return { pane, groupId: groupId! };
}

test.describe("Review Pane", () => {
	test("opens review pane via review_open and approves through agent chat @smoke", async ({ page }) => {
		const sessionId = await createSession();
		try {
			await waitForSessionStatus(sessionId, "idle");
			await openApp(page);
			await goToSession(page, sessionId);
			const { pane } = await openReviewDocument(page);

			await pane.getByRole("button", { name: "Approve", exact: true }).click();
			await expect(
				page.locator("user-message").filter({ hasText: /approv/i }).last(),
				"Approve should send review feedback through the existing agent chat flow",
			).toBeVisible({ timeout: 10_000 });
			await waitForAgentResponse(page, { text: "OK", timeout: 15_000 });
			await expect(reviewTab(page), "submitted review_open document should close its grouped review tab").toHaveCount(0, { timeout: 5_000 });
			await expect.poll(() => reviewGroupId(page), { timeout: 5_000 }).toBeNull();
		} finally {
			await deleteSession(sessionId);
		}
	});

	test("reopens review pane when active agent sends revised live review_open after rejection", async ({ page }) => {
		const sessionId = await createSession();
		try {
			await waitForSessionStatus(sessionId, "idle");
			await openApp(page);
			await goToSession(page, sessionId);
			const { pane, groupId: rejectedGroupId } = await openReviewDocument(page);

			await pane.getByRole("textbox", { name: /final comment/i }).fill("Needs revised markdown before merge.");
			await pane.getByRole("button", { name: "Reject" }).click();
			await expect(
				page.locator("user-message").filter({ hasText: /Review Rejected|Needs revised markdown before merge/i }).last(),
				"Reject should send review feedback through the existing agent chat flow",
			).toBeVisible({ timeout: 10_000 });
			await waitForAgentResponse(page, { text: "OK", timeout: 15_000 });
			await expect(reviewTab(page), "rejected review_open document should close its grouped review tab").toHaveCount(0, { timeout: 5_000 });
			await expect.poll(() => reviewGroupId(page), { timeout: 5_000 }).toBeNull();

			await sendMessage(page, "REVIEW_OPEN_REVISED");
			await expect(page.getByText("Done. Used review_open tool.", { exact: true })).toHaveCount(2, { timeout: 15_000 });

			const reopenedTab = reviewTab(page);
			await expect(
				reopenedTab,
				"fresh live review_open after rejected submission should reopen Review: Test Document tab",
			).toHaveCount(1, { timeout: 10_000 });
			await expect.poll(() => reviewGroupId(page), { timeout: 10_000 }).not.toBeNull();
			const revisedGroupId = await reviewGroupId(page);
			expect(revisedGroupId, "a revised live review_open should create a fresh grouped review identity").not.toBe(rejectedGroupId);
			await reopenedTab.click();
			await expect(page.locator("review-pane"), "reopened review pane should be visible").toBeVisible({ timeout: 5_000 });
			await expect(
				page.locator("review-document").getByText("Revised markdown after rejected feedback should reopen the review pane.").first(),
				"reopened review pane should display revised markdown",
			).toBeVisible({ timeout: 5_000 });
		} finally {
			await deleteSession(sessionId);
		}
	});
});
