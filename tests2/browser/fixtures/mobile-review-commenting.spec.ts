/**
 * Mobile review commenting E2E — full mobile annotation flow with persistence.
 */
import { test, expect } from "../gateway-harness.js";
import { openApp, sendMessage, navigateToHash } from "./ui-helpers.js";
import { apiFetch, createSession } from "../e2e-setup.js";

async function setupMobileEmulation(page: import("@playwright/test").Page) {
	await page.addInitScript(() => {
		const orig = window.matchMedia;
		window.matchMedia = function (q: string) {
			if (q === "(pointer: coarse)") {
				return {
					matches: true,
					media: q,
					addEventListener: () => {},
					removeEventListener: () => {},
					addListener: () => {},
					removeListener: () => {},
					onchange: null,
					dispatchEvent: () => true,
				} as unknown as MediaQueryList;
			}
			return orig.call(window, q);
		};
	});
}

async function openReviewTab(page: import("@playwright/test").Page) {
	const doneMessages = page.getByText("Done. Used review_open tool.", { exact: true });
	const previousDoneCount = await doneMessages.count().catch(() => 0);
	await sendMessage(page, "REVIEW_OPEN");
	await expect.poll(async () => doneMessages.count(), { timeout: 20_000 })
		.toBeGreaterThan(previousDoneCount);

	const reviewTab = page.locator(".goal-tab-pill", { hasText: "Review" });
	await expect(reviewTab).toBeVisible({ timeout: 10_000 });
	await reviewTab.click();
	await expect(page.locator("review-document")).toBeVisible({ timeout: 5_000 });
	await expect(page.locator("review-document").getByText("Some important text").first()).toBeVisible({ timeout: 5_000 });
}

async function createSessionViaAPI(page: import("@playwright/test").Page): Promise<string> {
	const sessionId = await createSession();
	await navigateToHash(page, `#/session/${sessionId}`);
	await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });
	return sessionId;
}

async function expectReviewAnnotationCount(
	page: import("@playwright/test").Page,
	count: number,
	comment: string,
) {
	await expect.poll(async () => page.evaluate(
		({ count, comment }) => {
			const pane = document.querySelector("review-pane") as any;
			const doc = document.querySelector("review-document") as any;
			const sessionId = pane?.sessionId || doc?.sessionId || (window as any).bobbitState?.selectedSessionId;
			const bucket = pane?.activeTab || doc?.docTitle || "Test Document";
			if (!sessionId || !doc?.backend?.get) return false;
			const annotations = doc.backend.get({ sessionId, bucket }) ?? [];
			return annotations.length === count && annotations.some((ann: any) => ann?.comment === comment);
		},
		{ count, comment },
	), { timeout: 10_000 }).toBe(true);
}

async function expectReviewAnnotationPersisted(sessionId: string, comment: string) {
	await expect.poll(async () => {
		const resp = await apiFetch(`/api/sessions/${sessionId}/review/annotations`);
		if (!resp.ok) return 0;
		const data = await resp.json() as { annotations?: Record<string, Array<{ comment?: string }>> };
		return Object.values(data.annotations ?? {})
			.flat()
			.filter((ann) => ann?.comment === comment).length;
	}, { timeout: 10_000 }).toBe(1);
}

async function selectReviewText(page: import("@playwright/test").Page) {
	await page.evaluate(() => {
		const content = document.querySelector(".review-document-content")!;
		const paragraphs = content.querySelectorAll("p");
		let targetP: Element | null = null;
		for (const p of paragraphs) {
			if (p.textContent?.includes("Some important text")) {
				targetP = p;
				break;
			}
		}
		if (!targetP) targetP = paragraphs[0];

		const range = document.createRange();
		range.selectNodeContents(targetP);
		const selection = window.getSelection()!;
		selection.removeAllRanges();
		selection.addRange(range);
		document.dispatchEvent(new Event("selectionchange"));
	});
}

test.describe("Mobile review commenting", () => {
	test("mobile annotation creation flow uses bottom sheet and persists after reload", async ({ page }) => {
		test.setTimeout(60_000);
		await setupMobileEmulation(page);
		await page.setViewportSize({ width: 375, height: 667 });
		await openApp(page);
		const sessionId = await createSessionViaAPI(page);
		await openReviewTab(page);

		await selectReviewText(page);
		const floatingBtn = page.locator(".review-floating-btn");
		await expect(floatingBtn).toBeVisible({ timeout: 5_000 });
		await floatingBtn.click();

		const popover = page.locator("annotation-popover");
		await expect(popover).toHaveAttribute("mode", "bottom-sheet", { timeout: 3_000 });
		await expect(popover).toHaveAttribute("open", "", { timeout: 3_000 });
		expect(await page.evaluate(() => {
			const ap = document.querySelector("annotation-popover");
			return !!ap?.shadowRoot?.querySelector(".review-popover--sheet");
		})).toBe(true);

		await page.locator("annotation-popover textarea").fill("Persisted mobile comment");
		const annotationWrite = page.waitForResponse(
			(resp) => resp.url().includes(`/api/sessions/${sessionId}/review/annotations`)
				&& resp.request().method() === "POST"
				&& resp.ok(),
			{ timeout: 10_000 },
		);
		await page.locator("annotation-popover .review-popover-submit").click();
		await annotationWrite;
		await expect(floatingBtn).not.toBeVisible({ timeout: 3_000 });
		await expectReviewAnnotationCount(page, 1, "Persisted mobile comment");

		await page.reload();
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });
		await openReviewTab(page);
		await expectReviewAnnotationPersisted(sessionId, "Persisted mobile comment");
	});
});
