/**
 * Browser E2E tests for server-side review annotation persistence.
 *
 * User stories covered:
 *   RP-05: Delete annotation — persists after reload
 *   RP-08: Review pane survives page reload — annotations intact
 *   RP-09: Submitted review does not reopen after reload
 *   RP-16: Annotations shared across browser contexts (refresh to see)
 *   RP-18: Session switch — annotations are per-session, isolated
 *
 * Strategy: use REST API to set up server-side annotation state BEFORE
 * navigating the browser to the session, so initAnnotationStore hydrates
 * from server on connect. This avoids flaky text-selection and timing issues.
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch, createSession, deleteSession } from "../e2e-setup.js";
import { openApp, sendMessage, waitForAgentResponse, navigateToHash } from "./ui-helpers.js";

// ── Helpers ──────────────────────────────────────────────────────

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

/** Add an annotation for a session via REST API */
async function addAnnotationViaAPI(sessionId: string, docTitle: string, annotation: Record<string, unknown>) {
	const resp = await apiFetch(`/api/sessions/${sessionId}/review/annotations`, {
		method: "POST",
		body: JSON.stringify({ docTitle, annotation }),
	});
	expect(resp.status).toBe(200);
}

/** Delete an annotation for a session via REST API */
async function deleteAnnotationViaAPI(sessionId: string, docTitle: string, annotationId: string) {
	const resp = await apiFetch(
		`/api/sessions/${sessionId}/review/annotations/${annotationId}?docTitle=${encodeURIComponent(docTitle)}`,
		{ method: "DELETE" },
	);
	expect(resp.status).toBe(200);
}

/** Set submitted flag for a session via REST API */
async function setSubmittedViaAPI(sessionId: string, submitted: boolean) {
	const resp = await apiFetch(`/api/sessions/${sessionId}/review/submitted`, {
		method: "PUT",
		body: JSON.stringify({ submitted }),
	});
	expect(resp.status).toBe(200);
}

/** Get annotations from server to verify state */
async function getAnnotationsViaAPI(sessionId: string) {
	const resp = await apiFetch(`/api/sessions/${sessionId}/review/annotations`);
	expect(resp.status).toBe(200);
	return resp.json();
}

/**
 * Navigate to a session. Uses openApp first, then hash navigation.
 */
async function goToSession(page: import("@playwright/test").Page, sessionId: string) {
	await navigateToHash(page, `#/session/${sessionId}`);
	await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });
}

/**
 * Open the review tab. Sends REVIEW_OPEN to the mock agent, waits for response,
 * then clicks the Review tab in the side panel.
 */
async function openReviewTab(page: import("@playwright/test").Page) {
	await sendMessage(page, "REVIEW_OPEN");
	await waitForAgentResponse(page, { text: "Done. Used review_open tool." });

	const reviewTab = page.locator(".goal-tab-pill", { hasText: "Review" });
	await expect(reviewTab).toBeVisible({ timeout: 10_000 });
	await reviewTab.click();

	await expect(page.locator("review-document")).toBeVisible({ timeout: 5_000 });
}

// ── Tests ────────────────────────────────────────────────────────

test.describe("Review annotation persistence", () => {

	test("RP-08: annotations survive page reload", async ({ page }) => {
		// Create session and add annotation via API BEFORE browser connects
		const sessionId = await createSession();
		try {
			await addAnnotationViaAPI(sessionId, "Test Document", makeAnnotation("persist-1"));

			// Open app, then navigate to the session
			await openApp(page);
			await goToSession(page, sessionId);

			// Open review pane — initAnnotationStore already fetched annotation from server
			await openReviewTab(page);

			// Verify the annotation badge shows count 1
			const badge = page.locator(".review-tab-badge");
			await expect(badge).toHaveText("1", { timeout: 5_000 });

			// Reload the page
			await page.reload();
			await expect(
				page.locator("button").filter({ hasText: "Settings" }).first(),
			).toBeVisible({ timeout: 20_000 });

			// Navigate back to the session after reload
			await goToSession(page, sessionId);

			// After reload, review pane reopens via message history replay
			const reviewTab = page.locator(".goal-tab-pill", { hasText: "Review" });
			await expect(reviewTab).toBeVisible({ timeout: 15_000 });
			await reviewTab.click();

			// The annotation badge should still show 1 (fetched from server on reload)
			await expect(badge).toHaveText("1", { timeout: 5_000 });
		} finally {
			await deleteSession(sessionId);
		}
	});

	test("RP-09: submitted review does not reopen after reload", async ({ page }) => {
		const sessionId = await createSession();
		try {
			// Open app, navigate to session, and open review pane (creates review_open in history)
			await openApp(page);
			await goToSession(page, sessionId);
			await openReviewTab(page);

			// Set submitted flag via API
			await setSubmittedViaAPI(sessionId, true);

			// Reload the page — initAnnotationStore fetches submitted=true
			await page.reload();
			await expect(
				page.locator("button").filter({ hasText: "Settings" }).first(),
			).toBeVisible({ timeout: 20_000 });

			// Navigate back to the session
			await goToSession(page, sessionId);

			// Wait for message replay to complete
			await page.waitForTimeout(3_000);

			// The review tab should NOT appear because submitted=true
			const reviewTab = page.locator(".goal-tab-pill", { hasText: "Review" });
			await expect(reviewTab).not.toBeVisible({ timeout: 5_000 });
		} finally {
			await deleteSession(sessionId);
		}
	});

	test("RP-16: annotations visible from second browser context", async ({ page, context }) => {
		// Create session and add annotation via API
		const sessionId = await createSession();
		try {
			await addAnnotationViaAPI(sessionId, "Test Document", makeAnnotation("cross-ctx-1"));

			// Open session in page1
			await openApp(page);
			await goToSession(page, sessionId);
			await openReviewTab(page);

			// Verify badge in page1
			const badge1 = page.locator(".review-tab-badge");
			await expect(badge1).toHaveText("1", { timeout: 5_000 });

			// Open a second page in the same browser context
			const page2 = await context.newPage();

			// Get the URL with token from page1
			const fullUrl = await page.evaluate(() => window.location.href);
			const url = new URL(fullUrl);
			const tokenParam = url.searchParams.get("token") || "";
			await page2.goto(`${url.origin}/?token=${encodeURIComponent(tokenParam)}`);
			await expect(
				page2.locator("button").filter({ hasText: "Settings" }).first(),
			).toBeVisible({ timeout: 20_000 });

			// Navigate to the same session in page2
			await navigateToHash(page2, `#/session/${sessionId}`);
			await expect(page2.locator("textarea").first()).toBeVisible({ timeout: 20_000 });

			// Open review pane in page2
			await sendMessage(page2, "REVIEW_OPEN");
			await waitForAgentResponse(page2, { text: "Done. Used review_open tool." });
			const reviewTab2 = page2.locator(".goal-tab-pill", { hasText: "Review" });
			await expect(reviewTab2).toBeVisible({ timeout: 10_000 });
			await reviewTab2.click();
			await expect(page2.locator("review-document")).toBeVisible({ timeout: 5_000 });

			// Verify badge shows 1 annotation in page2 (fetched from server)
			const badge2 = page2.locator(".review-tab-badge");
			await expect(badge2).toHaveText("1", { timeout: 5_000 });

			await page2.close();
		} finally {
			await deleteSession(sessionId);
		}
	});

	test("RP-18: session isolation — annotations are per-session", async ({ page }) => {
		// Create two sessions with different annotation states
		const sessionA = await createSession();
		const sessionB = await createSession();

		try {
			// Add annotations only to session A
			await addAnnotationViaAPI(sessionA, "Test Document", makeAnnotation("iso-1"));
			await addAnnotationViaAPI(sessionA, "Test Document", makeAnnotation("iso-2"));

			// Open app
			await openApp(page);

			// Navigate to session A and verify 2 annotations
			await goToSession(page, sessionA);
			await openReviewTab(page);

			const badgeA = page.locator(".review-tab-badge");
			await expect(badgeA).toHaveText("2", { timeout: 5_000 });

			// Navigate to session B
			await goToSession(page, sessionB);

			// Open review pane in session B
			await openReviewTab(page);

			// Session B should have NO annotation badge (no annotations)
			const badgeB = page.locator(".review-tab-badge");
			await expect(badgeB).not.toBeVisible({ timeout: 3_000 });
		} finally {
			await deleteSession(sessionA);
			await deleteSession(sessionB);
		}
	});

	test("RP-05: deleted annotation stays deleted after reload", async ({ page }) => {
		const sessionId = await createSession();
		try {
			// Add two annotations, then delete one via API
			await addAnnotationViaAPI(sessionId, "Test Document", makeAnnotation("del-1"));
			await addAnnotationViaAPI(sessionId, "Test Document", makeAnnotation("del-2"));
			await deleteAnnotationViaAPI(sessionId, "Test Document", "del-1");

			// Verify server state: only del-2 remains
			const serverData = await getAnnotationsViaAPI(sessionId);
			const docAnnotations = serverData.annotations["Test Document"] || [];
			expect(docAnnotations).toHaveLength(1);
			expect(docAnnotations[0].id).toBe("del-2");

			// Open app and navigate to session
			await openApp(page);
			await goToSession(page, sessionId);
			await openReviewTab(page);

			// Badge should show 1 (only del-2)
			const badge = page.locator(".review-tab-badge");
			await expect(badge).toHaveText("1", { timeout: 5_000 });

			// Reload the page
			await page.reload();
			await expect(
				page.locator("button").filter({ hasText: "Settings" }).first(),
			).toBeVisible({ timeout: 20_000 });

			// Navigate back to session
			await goToSession(page, sessionId);

			// Wait for review tab to reappear via message replay
			const reviewTab = page.locator(".goal-tab-pill", { hasText: "Review" });
			await expect(reviewTab).toBeVisible({ timeout: 15_000 });
			await reviewTab.click();

			// Badge should still show 1 after reload (del-1 stays deleted)
			await expect(badge).toHaveText("1", { timeout: 5_000 });
		} finally {
			await deleteSession(sessionId);
		}
	});
});
