/**
 * Browser E2E coverage for review annotation hydration across the real app
 * session/reload path.
 *
 * Pure REST persistence assertions for RP-05/RP-16/RP-18 live in
 * tests/e2e/review-annotations-api.spec.ts. This browser file keeps only the
 * UI behaviours that require a spawned gateway and message replay.
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch, createSession, deleteSession } from "../e2e-setup.js";
import { openApp, sendMessage, waitForAgentResponse, navigateToHash } from "./ui-helpers.js";

function makeAnnotation(id: string, overrides: Record<string, unknown> = {}) {
	return {
		id,
		quote: "Some important text",
		comment: `comment for ${id}`,
		start: 10,
		end: 29,
		...overrides,
	};
}

async function addAnnotationViaAPI(sessionId: string, docTitle: string, annotation: Record<string, unknown>) {
	const resp = await apiFetch(`/api/sessions/${sessionId}/review/annotations`, {
		method: "POST",
		body: JSON.stringify({ docTitle, annotation }),
	});
	expect(resp.status).toBe(200);
}

async function setSubmittedViaAPI(sessionId: string, submitted: boolean) {
	const resp = await apiFetch(`/api/sessions/${sessionId}/review/submitted`, {
		method: "PUT",
		body: JSON.stringify({ submitted }),
	});
	expect(resp.status).toBe(200);
}

async function goToSession(page: import("@playwright/test").Page, sessionId: string) {
	await navigateToHash(page, `#/session/${sessionId}`);
	await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });
}

async function openReviewTab(page: import("@playwright/test").Page) {
	await sendMessage(page, "REVIEW_OPEN");
	await waitForAgentResponse(page, { text: "Done. Used review_open tool." });

	const reviewTab = page.locator(".goal-tab-pill", { hasText: "Review" });
	await expect(reviewTab).toBeVisible({ timeout: 10_000 });
	await reviewTab.click();

	await expect(page.locator("review-document")).toBeVisible({ timeout: 5_000 });
}

test.describe("Review annotation persistence", () => {
	test("RP-08: annotations survive page reload", async ({ page }) => {
		const sessionId = await createSession();
		try {
			await addAnnotationViaAPI(sessionId, "Test Document", makeAnnotation("persist-1"));

			await openApp(page);
			await goToSession(page, sessionId);
			await openReviewTab(page);

			const badge = page.locator(".review-tab-badge");
			await expect(badge).toHaveText("1", { timeout: 5_000 });

			await page.reload();
			await expect(
				page.locator("button").filter({ hasText: "Settings" }).first(),
			).toBeVisible({ timeout: 20_000 });

			await goToSession(page, sessionId);
			const reviewTab = page.locator(".goal-tab-pill", { hasText: "Review" });
			await expect(reviewTab).toBeVisible({ timeout: 15_000 });
			await reviewTab.click();

			await expect(badge).toHaveText("1", { timeout: 5_000 });
		} finally {
			await deleteSession(sessionId);
		}
	});

	test("RP-09: submitted review does not reopen after reload", async ({ page }) => {
		const sessionId = await createSession();
		try {
			await openApp(page);
			await goToSession(page, sessionId);
			await openReviewTab(page);

			await setSubmittedViaAPI(sessionId, true);

			await page.reload();
			await expect(
				page.locator("button").filter({ hasText: "Settings" }).first(),
			).toBeVisible({ timeout: 20_000 });

			await goToSession(page, sessionId);

			// There is no explicit "message replay finished" signal; give replay a
			// short window, then assert the submitted flag suppressed reopening.
			await page.waitForTimeout(3_000);
			await expect(page.locator(".goal-tab-pill", { hasText: "Review" })).not.toBeVisible({ timeout: 5_000 });
		} finally {
			await deleteSession(sessionId);
		}
	});
});
