import { type Locator, type Page } from "@playwright/test";
import {
	apiFetch,
	createSession,
	deleteSession,
	expect,
	navigateToHash,
	openApp,
	sendMessage,
	test,
	waitForSessionStatus,
} from "../_helpers/journey-fixture.js";
import {
	LARGE_REVIEW_DELAYED_TRIGGER,
	LARGE_REVIEW_ID,
	LARGE_REVIEW_TITLE,
	LARGE_REVIEW_TOTAL_BYTES,
	LARGE_REVIEW_TRIGGER,
	REVIEW_RENDERER_SELECTORS,
	assertBoundedReceipt,
	assertLargeReviewFixture,
	failNextReviewOpen,
	largeReviewFiles,
	largeReviewPane,
	largeReviewPrimaryTab,
	reviewToolCard,
	waitForLargeReviewReceipt,
	selectedReviewModel,
	workspaceReviewSource,
} from "../fixtures/large-review-payload-fixture.js";

const REVIEW_TABS = '.goal-tab-pill[data-panel-tab-kind="review"]';
const REGRESSION = "LARGE_REVIEW_DURABLE_REOPEN";
const SIBLING_TITLES = [
	"Alpha Review",
	"Overflow Review With A Very Long Primary Workspace Tab Title That Must Truncate",
];

function reviewTab(page: Page, title: string): Locator {
	return page.locator(REVIEW_TABS).filter({ hasText: title }).first();
}

async function navigateToSession(page: Page, sessionId: string): Promise<void> {
	await navigateToHash(page, `#/session/${sessionId}`);
	await expect(page).toHaveURL(new RegExp(`#\\/session\\/${sessionId}$`), { timeout: 20_000 });
	await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 20_000 });
	await expect.poll(
		() => page.evaluate(() => ((window as any).bobbitState ?? (window as any).__bobbitState)?.selectedSessionId ?? null),
		{ timeout: 20_000, message: `session ${sessionId} must own the visible workspace before assertions` },
	).toBe(sessionId);
}

async function sendAndWait(page: Page, sessionId: string, prompt: string): Promise<void> {
	await sendMessage(page, prompt);
	await waitForSessionStatus(sessionId, "idle", 45_000);
}

async function expectSiblingReviews(page: Page): Promise<void> {
	for (const title of SIBLING_TITLES) {
		await expect(reviewTab(page, title), `${REGRESSION}: sibling ${title} must survive`).toBeVisible();
	}
}

async function expectLargeReviewSelected(page: Page): Promise<void> {
	const tab = largeReviewPrimaryTab(page);
	await expect(tab, `${REGRESSION}: exact large-review primary must exist`).toHaveCount(1, { timeout: 30_000 });
	await tab.click();
	await expect(tab).toHaveClass(/goal-tab-pill--active/, { timeout: 20_000 });
	await expect(largeReviewPane(page)).toBeVisible({ timeout: 20_000 });
}

async function selectLastFile(page: Page): Promise<void> {
	const files = largeReviewFiles();
	const pane = largeReviewPane(page);
	const more = pane.getByRole("button", { name: "More tabs", exact: true });
	await expect(more).toBeVisible();
	await more.click();
	const menu = page.getByRole("menu", { name: `More files in ${LARGE_REVIEW_TITLE}`, exact: true });
	await expect(menu).toBeVisible();
	await menu.getByRole("menuitem", { name: files.at(-1)!.title, exact: true }).click();
	await expect(pane.locator("review-document").getByText(files.at(-1)!.marker, { exact: true })).toBeVisible({ timeout: 20_000 });
}

async function expectActiveLargeReviewFile(page: Page, fileId: string): Promise<void> {
	await expect.poll(() => selectedReviewModel(page).then((model) => model.activeFileId), {
		timeout: 20_000,
		message: `${REGRESSION}: selected file identity must settle to ${fileId}`,
	}).toBe(fileId);
}

async function closeLargeReview(page: Page): Promise<void> {
	const tab = largeReviewPrimaryTab(page);
	await tab.locator(".goal-tab-close, [data-testid='side-panel-close']").click();
	await expect(tab, `${REGRESSION}: explicit close must remove the exact large review`).toHaveCount(0, { timeout: 20_000 });
}

async function sessionStatus(sessionId: string): Promise<string> {
	const response = await apiFetch(`/api/sessions/${sessionId}`);
	if (!response.ok) return "missing";
	return ((await response.json()) as { status?: string }).status ?? "unknown";
}

async function waitForAutomaticReviewOpen(page: Page, sessionId: string, receipt: { toolCallId: string; payloadId: string; hash: string }): Promise<Locator> {
	const card = reviewToolCard(page);
	await expect(card, `${REGRESSION}: originating review_open card must render`).toBeVisible({ timeout: 30_000 });
	await expect(card.getByTestId(REVIEW_RENDERER_SELECTORS.button)).toBeVisible({ timeout: 30_000 });
	await expect(card.getByTestId(REVIEW_RENDERER_SELECTORS.status)).toHaveText("Review opened.", { timeout: 30_000 });
	await expect.poll(async () => {
		const tab = await workspaceReviewSource(page, sessionId);
		return tab?.source?.toolCallId === receipt.toolCallId
			&& tab?.source?.payloadId === receipt.payloadId
			&& tab?.source?.contentHash === receipt.hash;
	}, {
		timeout: 30_000,
		message: `${REGRESSION}: automatic-open coordinator must commit the exact receipt before review assertions`,
	}).toBe(true);
	return card;
}

test.describe("Journey: durable large review recovery", () => {
	test("20-file 485 KiB receipt opens automatically, preserves identity/order and selection, stays closed on replay, and retries atomically", async ({ page, gateway }) => {
		test.setTimeout(210_000);
		const files = largeReviewFiles();
		assertLargeReviewFixture(files);
		const sessionId = await createSession();
		let injectedFailure: Awaited<ReturnType<typeof failNextReviewOpen>> | undefined;

		try {
			await Promise.all([openApp(page), waitForSessionStatus(sessionId, "idle", 45_000)]);
			await navigateToSession(page, sessionId);

			// Existing small reviews are deliberate siblings. Every large-review close,
			// failure, retry, and submission below must leave both untouched.
			await sendAndWait(page, sessionId, "REVIEW_GROUPS_TWO");
			await expect(page.locator(REVIEW_TABS)).toHaveCount(2, { timeout: 30_000 });
			await expectSiblingReviews(page);

			await sendAndWait(page, sessionId, LARGE_REVIEW_TRIGGER);
			const receipt = await waitForLargeReviewReceipt(gateway, sessionId);
			assertBoundedReceipt(receipt, files);
			expect(receipt.totalBytes).toBe(LARGE_REVIEW_TOTAL_BYTES);

			const card = await waitForAutomaticReviewOpen(page, sessionId, receipt);
			const openButton = card.getByTestId(REVIEW_RENDERER_SELECTORS.button);
			await expect(openButton).toHaveText("Re-open review", { timeout: 30_000 });
			await expect(openButton).toBeEnabled();
			await expect(card.getByTestId(REVIEW_RENDERER_SELECTORS.status)).toHaveText("Review opened.");

			await expectLargeReviewSelected(page);
			await expect(page.locator(REVIEW_TABS)).toHaveCount(3);
			await expectSiblingReviews(page);
			let model = await selectedReviewModel(page);
			expect(model).toMatchObject({
				reviewId: LARGE_REVIEW_ID,
				title: LARGE_REVIEW_TITLE,
				activeFileId: files[0].fileId,
				files: files.map(({ fileId, title }) => ({ fileId, title })),
			});
			const workspace = await workspaceReviewSource(page, sessionId);
			expect(workspace).toMatchObject({
				id: `review:${encodeURIComponent(LARGE_REVIEW_ID)}`,
				source: {
					sessionId,
					reviewId: LARGE_REVIEW_ID,
					toolCallId: receipt.toolCallId,
					payloadId: receipt.payloadId,
					contentHash: receipt.hash,
				},
			});

			// Exercise both an ordinary visible file and an overflow file. The model
			// assertion above proves the duplicate-title entries retained distinct IDs.
			const pane = largeReviewPane(page);
			await pane.getByRole("tab", { name: files[2].title, exact: true }).click();
			await expect(pane.locator("review-document").getByText(files[2].marker, { exact: true })).toBeVisible();
			await selectLastFile(page);
			model = await selectedReviewModel(page);
			expect(model.activeFileId).toBe(files.at(-1)!.fileId);

			// The selected opaque file identity is stored on the authoritative tab,
			// not inferred from title or lost when the 485 KiB body is re-fetched.
			await page.reload({ waitUntil: "domcontentloaded" });
			await navigateToSession(page, sessionId);
			await expectLargeReviewSelected(page);
			model = await selectedReviewModel(page);
			expect(model.activeFileId).toBe(files.at(-1)!.fileId);
			await expect(page.locator("review-document").getByText(files.at(-1)!.marker, { exact: true })).toBeVisible({ timeout: 30_000 });

			await closeLargeReview(page);
			await expectSiblingReviews(page);
			await page.reload({ waitUntil: "domcontentloaded" });
			await navigateToSession(page, sessionId);
			await expect(largeReviewPrimaryTab(page), `${REGRESSION}: passive historical hydration must respect the close tombstone`).toHaveCount(0);
			await expectSiblingReviews(page);
			const restoredCard = reviewToolCard(page);
			await expect(restoredCard).toBeVisible({ timeout: 30_000 });
			const restoredButton = restoredCard.getByTestId(REVIEW_RENDERER_SELECTORS.button);
			await expect(restoredButton).toBeVisible({ timeout: 30_000 });
			await expect(restoredButton).toHaveText("Re-open review", { timeout: 30_000 });
			await restoredButton.focus();
			await expect(restoredButton).toBeFocused();
			await restoredButton.press("Enter");
			await expectLargeReviewSelected(page);
			await expectActiveLargeReviewFile(page, files.at(-1)!.fileId);
			await expect(page.locator(REVIEW_TABS)).toHaveCount(3);

			// A retryable server failure must be sanitized, leave no partial primary,
			// retain both siblings and the recovery action, then succeed exactly once.
			await closeLargeReview(page);
			injectedFailure = await failNextReviewOpen(page);
			await restoredCard.getByTestId(REVIEW_RENDERER_SELECTORS.button).click();
			await expect.poll(() => injectedFailure!.attempts(), { timeout: 20_000 }).toBe(1);
			const alert = restoredCard.getByTestId(REVIEW_RENDERER_SELECTORS.error);
			await expect(alert).toBeVisible({ timeout: 20_000 });
			await expect(alert).toHaveAttribute("role", "alert");
			await expect(alert).toContainText(/couldn.t|could not|retry/i);
			await expect(alert).not.toContainText("C:\\private");
			await expect(alert).not.toContainText("bearer-secret");
			await expect(alert).not.toContainText("stack trace");
			const retry = restoredCard.getByTestId(REVIEW_RENDERER_SELECTORS.button);
			await expect(retry).toHaveText("Retry open");
			await expect(retry).toBeEnabled();
			await expect(largeReviewPrimaryTab(page), `${REGRESSION}: failed transaction must not partially recreate the review`).toHaveCount(0);
			await expectSiblingReviews(page);

			await injectedFailure.remove();
			injectedFailure = undefined;
			await retry.click();
			await expectLargeReviewSelected(page);
			await expectActiveLargeReviewFile(page, files.at(-1)!.fileId);
			await expect(restoredCard.getByTestId(REVIEW_RENDERER_SELECTORS.error)).toHaveCount(0);
			await expect(restoredCard.getByTestId(REVIEW_RENDERER_SELECTORS.status)).toHaveText("Review opened.");
			await expect(retry).toHaveText("Re-open review");
			await expect(page.locator(REVIEW_TABS)).toHaveCount(3);
			await expectSiblingReviews(page);

			// Submission is another exact-key close and must not consume the card's
			// recovery path or remove either sibling review.
			await largeReviewPane(page).getByRole("button", { name: "Approve", exact: true }).click();
			await expect(largeReviewPrimaryTab(page)).toHaveCount(0, { timeout: 20_000 });
			await expectSiblingReviews(page);
			await expect(restoredCard.getByTestId(REVIEW_RENDERER_SELECTORS.button)).toBeEnabled();
		} finally {
			await injectedFailure?.remove().catch(() => {});
			await deleteSession(sessionId).catch(() => {});
		}
	});

	test("a delayed large-review open stays owned by its background session and never steals foreground review selection", async ({ page, gateway }) => {
		test.setTimeout(150_000);
		const foregroundId = await createSession();
		const ownerId = await createSession();
		try {
			await Promise.all([
				openApp(page),
				waitForSessionStatus(foregroundId, "idle", 45_000),
				waitForSessionStatus(ownerId, "idle", 45_000),
			]);

			await navigateToSession(page, foregroundId);
			await sendAndWait(page, foregroundId, "REVIEW_GROUP_BACKGROUND_OPEN");
			const foregroundTab = reviewTab(page, "Background Session Review");
			await expect(foregroundTab).toBeVisible({ timeout: 30_000 });
			await foregroundTab.click();
			const foregroundPane = page.locator("review-pane").first();
			await foregroundPane.getByRole("tab", { name: "Background B.md", exact: true }).click();
			await expect(foregroundPane.locator("review-document").getByText("Background owner content B.", { exact: true })).toBeVisible();

			await navigateToSession(page, ownerId);
			await sendMessage(page, LARGE_REVIEW_DELAYED_TRIGGER);
			await expect.poll(() => sessionStatus(ownerId), {
				timeout: 15_000,
				message: "delayed large-review fixture must enter streaming before the foreground switch",
			}).toBe("streaming");
			await navigateToSession(page, foregroundId);
			await waitForSessionStatus(ownerId, "idle", 45_000);

			expect(page.url(), `${REGRESSION}: background automatic open must not navigate`).toContain(`/session/${foregroundId}`);
			await expect(largeReviewPrimaryTab(page), `${REGRESSION}: owner review must not render in foreground workspace`).toHaveCount(0);
			await expect(reviewToolCard(page), `${REGRESSION}: owner tool card must not leak into foreground transcript`).toHaveCount(0);
			await expect(reviewTab(page, "Background Session Review")).toHaveClass(/goal-tab-pill--active/);
			await expect(page.locator("review-document").getByText("Background owner content B.", { exact: true })).toBeVisible();
			await expect.poll(
				() => page.evaluate(() => ((window as any).bobbitState ?? (window as any).__bobbitState)?.selectedSessionId ?? null),
			).toBe(foregroundId);

			const receipt = await waitForLargeReviewReceipt(gateway, ownerId);
			assertBoundedReceipt(receipt);
			await navigateToSession(page, ownerId);
			await waitForAutomaticReviewOpen(page, ownerId, receipt);
			await expectLargeReviewSelected(page);
			await expect(reviewToolCard(page).getByTestId(REVIEW_RENDERER_SELECTORS.status)).toHaveText("Review opened.");
			const ownerModel = await selectedReviewModel(page);
			expect(ownerModel.reviewId).toBe(LARGE_REVIEW_ID);
			expect(ownerModel.files).toEqual(largeReviewFiles().map(({ fileId, title }) => ({ fileId, title })));
			expect((await workspaceReviewSource(page, ownerId)).source.sessionId).toBe(ownerId);

			await navigateToSession(page, foregroundId);
			await expect(reviewTab(page, "Background Session Review")).toHaveClass(/goal-tab-pill--active/);
			await expect(page.locator("review-document").getByText("Background owner content B.", { exact: true })).toBeVisible();
		} finally {
			await deleteSession(ownerId).catch(() => {});
			await deleteSession(foregroundId).catch(() => {});
		}
	});
});
