/**
 * Browser coverage for the real review_open tool path and arbitrary markdown
 * review decisions. Pure review-pane tab management/rendering is covered by
 * tests/ui-fixtures/proposal-review-fixture.spec.ts; this file keeps browser
 * E2E focused on the gateway + mock-agent integration flow.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "../gateway-harness.js";
import { apiFetch, createSession, deleteSession, waitForSessionStatus } from "../e2e-setup.js";
import { openApp, sendMessage, waitForAgentResponse, navigateToHash } from "./ui-helpers.js";

const REVIEW_PANEL_TAB_SELECTOR = ".goal-preview-panel .goal-tab-pill[data-panel-tab-kind='review']";
const DOC_TITLE = "Test Document";

async function addAnnotationViaAPI(sessionId: string, docTitle: string, annotation: Record<string, unknown>) {
	const resp = await apiFetch(`/api/sessions/${sessionId}/review/annotations`, {
		method: "POST",
		body: JSON.stringify({ docTitle, annotation }),
	});
	expect(resp.status).toBe(200);
}

async function getReviewAnnotations(sessionId: string): Promise<Record<string, unknown[]>> {
	const resp = await apiFetch(`/api/sessions/${sessionId}/review/annotations`);
	expect(resp.status).toBe(200);
	const data = await resp.json();
	return data.annotations || {};
}

function reviewTab(page: Page) {
	return page.locator(REVIEW_PANEL_TAB_SELECTOR).filter({ hasText: /^Review:\s*Test Document$/ });
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
	await tab.click();

	const pane = page.locator("review-pane");
	await expect(pane).toBeVisible({ timeout: 5_000 });
	await expect(page.locator("review-document").getByText("Section One").first()).toBeVisible({ timeout: 5_000 });
	return pane;
}

async function setupSessionWithReview(page: Page) {
	const sessionId = await createSession();
	await waitForSessionStatus(sessionId, "idle");
	await openApp(page);
	await goToSession(page, sessionId);
	const pane = await openReviewDocument(page);
	return { sessionId, pane };
}

test.describe("Review Pane", () => {
	test("opens review pane with inline markdown via review_open @smoke", async ({ page }) => {
		const { sessionId } = await setupSessionWithReview(page);
		try {
			await expect(page.locator("review-document").getByText("Section One").first()).toBeVisible({ timeout: 5_000 });
		} finally {
			await deleteSession(sessionId);
		}
	});

	test("arbitrary markdown review can be approved with no comments and routes to agent chat", async ({ page }) => {
		const { sessionId, pane } = await setupSessionWithReview(page);
		try {
			await expect(pane.getByRole("textbox", { name: /final comment/i })).toBeVisible({ timeout: 5_000 });
			await expect(pane.getByRole("button", { name: "Approve" })).toBeVisible();
			await expect(pane.getByRole("button", { name: "Reject" })).toBeVisible();

			await pane.getByRole("button", { name: "Approve" }).click();

			await expect(
				page.locator("user-message").filter({ hasText: /approv/i }).last(),
				"Approve with no comments should still send a concise approval prompt through the existing agent chat flow",
			).toBeVisible({ timeout: 10_000 });
			await waitForAgentResponse(page, { text: "OK", timeout: 15_000 });
			await expect(reviewTab(page), "submitted arbitrary markdown review should close its review tab").toHaveCount(0, { timeout: 5_000 });

			await page.reload();
			await goToSession(page, sessionId);
			await expect(reviewTab(page), "submitted review_open documents should stay suppressed after reload").toHaveCount(0, { timeout: 5_000 });
		} finally {
			await deleteSession(sessionId);
		}
	});

	test("arbitrary markdown reject requires a comment and routes final comment to agent chat", async ({ page }) => {
		const { sessionId, pane } = await setupSessionWithReview(page);
		const finalComment = `reject-final-comment-${Date.now()}`;
		try {
			await pane.getByRole("button", { name: "Reject" }).click();

			await expect(
				pane.getByRole("alert").filter({ hasText: /final comment|inline comment/i }),
				"Rejecting an arbitrary markdown review without inline or final comments should show validation and not submit",
			).toBeVisible({ timeout: 5_000 });
			await expect(page.locator("user-message").filter({ hasText: finalComment })).toHaveCount(0);

			await pane.getByRole("textbox", { name: /final comment/i }).fill(finalComment);
			await pane.getByRole("button", { name: "Reject" }).click();

			await expect(
				page.locator("user-message").filter({ hasText: finalComment }).last(),
				"Reject final comments should be sent through the existing agent chat/review prompt path",
			).toBeVisible({ timeout: 10_000 });
			await waitForAgentResponse(page, { text: "OK", timeout: 15_000 });
		} finally {
			await deleteSession(sessionId);
		}
	});

	test("arbitrary markdown reject includes persisted inline comments in agent chat feedback", async ({ page }) => {
		const sessionId = await createSession();
		const inlineComment = `inline-review-comment-${Date.now()}`;
		try {
			await addAnnotationViaAPI(sessionId, DOC_TITLE, {
				id: `inline-${Date.now()}`,
				quote: "Some important text",
				comment: inlineComment,
				start: 86,
				end: 105,
			});
			await waitForSessionStatus(sessionId, "idle");
			await openApp(page);
			await goToSession(page, sessionId);
			const pane = await openReviewDocument(page);

			await expect(page.locator(".review-tab-badge")).toHaveText("1", { timeout: 5_000 });
			await pane.getByRole("button", { name: "Reject" }).click();

			const routedFeedback = page.locator("user-message").filter({ hasText: inlineComment }).last();
			await expect(routedFeedback).toBeVisible({ timeout: 10_000 });
			await expect(routedFeedback).toContainText("Some important text");
			await waitForAgentResponse(page, { text: "OK", timeout: 15_000 });
			await expect(reviewTab(page), "submitted arbitrary markdown review should close its review tab").toHaveCount(0, { timeout: 5_000 });
			await expect.poll(async () => (await getReviewAnnotations(sessionId))[DOC_TITLE]?.length || 0, {
				timeout: 5_000,
				message: "submitted arbitrary markdown review should clear persisted inline comments for the document",
			}).toBe(0);
		} finally {
			await deleteSession(sessionId);
		}
	});
});
