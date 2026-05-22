/**
 * Browser E2E coverage for review annotation hydration across the real app
 * session/reload path.
 *
 * Story coverage pinned here:
 *   RP-05: deleted annotation reload hydration
 *   RP-08: review pane survives page reload with annotations intact
 *   RP-09: submitted review does not reopen after reload
 *   RP-16: second browser context sees shared annotations after reload
 *   RP-18: session switch keeps annotation badges isolated per session
 *
 * Pure REST persistence assertions also live in
 * tests/e2e/review-annotations-api.spec.ts; this browser file keeps the UI
 * behaviours that require a spawned gateway and message replay.
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

async function deleteAnnotationViaAPI(sessionId: string, docTitle: string, annotationId: string) {
	const resp = await apiFetch(
		`/api/sessions/${sessionId}/review/annotations/${annotationId}?docTitle=${encodeURIComponent(docTitle)}`,
		{ method: "DELETE" },
	);
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

	test("RP-05/RP-16/RP-18: deleted annotations hydrate on reload, share across browser contexts, and stay session-isolated", async ({ page, browser }) => {
		const docTitle = "Test Document";
		const sessionA = await createSession();
		const sessionB = await createSession();
		let secondContext: import("@playwright/test").BrowserContext | undefined;

		try {
			await addAnnotationViaAPI(sessionA, docTitle, makeAnnotation("del-1"));
			await addAnnotationViaAPI(sessionA, docTitle, makeAnnotation("del-2"));
			await deleteAnnotationViaAPI(sessionA, docTitle, "del-1");

			await openApp(page);
			await goToSession(page, sessionA);
			await openReviewTab(page);

			const badge = page.locator(".review-tab-badge");
			await expect(badge, "RP-05 pre-reload UI hydrates only the remaining annotation").toHaveText("1", { timeout: 5_000 });

			await page.reload();
			await expect(
				page.locator("button").filter({ hasText: "Settings" }).first(),
			).toBeVisible({ timeout: 20_000 });
			await goToSession(page, sessionA);
			const reviewTab = page.locator(".goal-tab-pill", { hasText: "Review" });
			await expect(reviewTab).toBeVisible({ timeout: 15_000 });
			await reviewTab.click();
			await expect(badge, "RP-05 deleted annotation stays deleted after reload hydration").toHaveText("1", { timeout: 5_000 });

			secondContext = await browser.newContext();
			const secondPage = await secondContext.newPage();
			await openApp(secondPage);
			await goToSession(secondPage, sessionA);
			await openReviewTab(secondPage);
			const secondBadge = secondPage.locator(".review-tab-badge");
			await expect(secondBadge, "RP-16 second browser context hydrates shared annotation state").toHaveText("1", { timeout: 5_000 });

			await secondPage.reload();
			await expect(
				secondPage.locator("button").filter({ hasText: "Settings" }).first(),
			).toBeVisible({ timeout: 20_000 });
			await goToSession(secondPage, sessionA);
			const secondReviewTab = secondPage.locator(".goal-tab-pill", { hasText: "Review" });
			await expect(secondReviewTab).toBeVisible({ timeout: 15_000 });
			await secondReviewTab.click();
			await expect(secondBadge, "RP-16 second browser context preserves shared annotation state after reload").toHaveText("1", { timeout: 5_000 });

			await goToSession(page, sessionB);
			await openReviewTab(page);
			await expect(
				page.locator(".review-tab-badge"),
				"RP-18 switching to an empty session does not leak annotations from the previous session",
			).not.toBeVisible({ timeout: 3_000 });
		} finally {
			await secondContext?.close().catch(() => {});
			await deleteSession(sessionA);
			await deleteSession(sessionB);
		}
	});
});
