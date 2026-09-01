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
} from "../../support/helpers/browser/journeys/journey-fixture.js";

const REVIEW_TABS = '.goal-tab-pill[data-panel-tab-kind="review"]';
const REGRESSION = "REVIEW_GROUP_PRIMARY_TAB";

function primaryReviewTab(page: Page, title: string): Locator {
	return page.locator(REVIEW_TABS).filter({
		has: page.locator(".goal-tab-pill-label", { hasText: title }),
	}).first();
}

async function sendAndWait(page: Page, sessionId: string, prompt: string): Promise<void> {
	await sendMessage(page, prompt);
	await waitForSessionStatus(sessionId, "idle");
}

async function expectReviewReady(page: Page, title: string, body: string): Promise<Locator> {
	const tab = primaryReviewTab(page, title);
	await expect(tab, `${REGRESSION}: missing primary tab for ${title}`).toBeVisible({ timeout: 20_000 });
	await tab.click();
	const pane = page.locator("review-pane").first();
	await expect(pane.locator("review-document").getByText(body).first()).toBeVisible({ timeout: 15_000 });
	return pane;
}

async function expectCloseInsideTab(tab: Locator, label: string): Promise<void> {
	await tab.scrollIntoViewIfNeeded();
	const geometry = await tab.evaluate((element) => {
		const close = element.querySelector<HTMLElement>(".goal-tab-close, [data-testid='side-panel-close']");
		const tabRect = element.getBoundingClientRect();
		const closeRect = close?.getBoundingClientRect();
		return closeRect ? {
			tabLeft: tabRect.left,
			tabRight: tabRect.right,
			tabTop: tabRect.top,
			tabBottom: tabRect.bottom,
			closeLeft: closeRect.left,
			closeRight: closeRect.right,
			closeTop: closeRect.top,
			closeBottom: closeRect.bottom,
		} : null;
	});
	expect(geometry, `${REGRESSION}: ${label} must expose a primary close control`).not.toBeNull();
	expect(geometry!.closeLeft, `${REGRESSION}: ${label} close left escaped the tab`).toBeGreaterThanOrEqual(geometry!.tabLeft - 0.5);
	expect(geometry!.closeRight, `${REGRESSION}: ${label} close right escaped the tab`).toBeLessThanOrEqual(geometry!.tabRight + 0.5);
	expect(geometry!.closeTop, `${REGRESSION}: ${label} close top escaped the tab`).toBeGreaterThanOrEqual(geometry!.tabTop - 0.5);
	expect(geometry!.closeBottom, `${REGRESSION}: ${label} close bottom escaped the tab`).toBeLessThanOrEqual(geometry!.tabBottom + 0.5);
}

async function addReviewAnnotation(sessionId: string, fileId: string, id: string, quote: string, comment: string): Promise<void> {
	const response = await apiFetch(`/api/sessions/${sessionId}/review/annotations`, {
		method: "POST",
		body: JSON.stringify({
			docTitle: fileId,
			annotation: { id, quote, comment, start: 0, end: quote.length },
		}),
	});
	expect(response.status, `annotation fixture write failed for ${fileId}: ${await response.text()}`).toBe(200);
}

async function sessionStatus(sessionId: string): Promise<string> {
	const response = await apiFetch(`/api/sessions/${sessionId}`);
	if (!response.ok) return "missing";
	const body = await response.json() as { status?: string };
	return body.status || "unknown";
}

async function navigateToSession(page: Page, sessionId: string): Promise<void> {
	await navigateToHash(page, `#/session/${sessionId}`);
	await expect(page).toHaveURL(new RegExp(`#\\/session\\/${sessionId}$`), { timeout: 15_000 });
	await expect.poll(
		() => page.evaluate(() => (window as any).bobbitState?.selectedSessionId ?? null),
		{ timeout: 15_000, message: `session ${sessionId} should be selected before continuing` },
	).toBe(sessionId);
}

async function waitForBackgroundStreaming(sessionId: string): Promise<void> {
	await expect.poll(() => sessionStatus(sessionId), {
		timeout: 10_000,
		message: "background review fixture should enter streaming before its delayed tool result",
	}).toBe("streaming");
}

test.describe("Journey: grouped Markdown reviews", () => {
	test("two reviews keep one primary each, local file navigation, overflow, close geometry, cleanup, and review-wide feedback", async ({ page }) => {
		test.setTimeout(120_000);
		const sessionId = await createSession();
		try {
			await Promise.all([openApp(page), waitForSessionStatus(sessionId, "idle")]);
			await navigateToSession(page, sessionId);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });
			await sendAndWait(page, sessionId, "REVIEW_GROUPS_TWO");

			const primaryTabs = page.locator(REVIEW_TABS);
			await expect(primaryTabs, `${REGRESSION}: two multi-file reviews must produce exactly two primary tabs`).toHaveCount(2, { timeout: 20_000 });
			await expect(primaryTabs.locator(".goal-tab-close, [data-testid='side-panel-close']"), `${REGRESSION}: every primary review must be closable`).toHaveCount(2);
			for (const fileTitle of ["Overview.md", "Details.md", "Section 1.md", "Section 7.md"]) {
				await expect(page.locator(REVIEW_TABS).filter({ hasText: fileTitle }), `${REGRESSION}: files must never duplicate as primary workspace tabs`).toHaveCount(0);
			}

			const alphaPane = await expectReviewReady(page, "Alpha Review", "Alpha overview body.");
			const alphaBar = alphaPane.locator(".review-tab-bar");
			await expect(alphaBar.getByRole("tab", { name: "Overview.md", exact: true })).toBeVisible();
			await expect(alphaBar.getByRole("tab", { name: "Details.md", exact: true })).toBeVisible();
			await expect(alphaBar.locator('[class*="close"], [aria-label*="close" i], [title*="close" i]'), `${REGRESSION}: secondary tabs are navigation only`).toHaveCount(0);
			await alphaBar.getByRole("tab", { name: "Details.md", exact: true }).click();
			await expect(alphaPane.locator("review-document").getByText("Alpha details body.").first()).toBeVisible();

			const longTitle = "Overflow Review With A Very Long Primary Workspace Tab Title That Must Truncate";
			const overflowTab = primaryReviewTab(page, longTitle);
			const overflowPane = await expectReviewReady(page, longTitle, "Overflow body 1.");
			await expectCloseInsideTab(overflowTab, "desktop long-title tab");
			const overflowBar = overflowPane.locator(".review-tab-bar");
			await expect(overflowBar.locator('[class*="close"], [aria-label*="close" i], [title*="close" i]'), `${REGRESSION}: overflow navigation must not expose file close controls`).toHaveCount(0);
			const more = overflowPane.locator('button[aria-haspopup="menu"], button[title="More tabs"], button[aria-label="More tabs"]').first();
			await expect(more, `${REGRESSION}: seven files must expose More tabs`).toBeVisible();
			await more.click();
			const menu = page.locator('[role="menu"]').filter({ hasText: "Section 7.md" }).first();
			await expect(menu, `${REGRESSION}: overflow menu must be visible and unclipped`).toBeVisible();
			expect(await menu.evaluate((element) => ({
				popover: element.hasAttribute("popover"),
				insideStrip: !!element.closest(".review-tab-bar"),
			}))).toEqual({ popover: true, insideStrip: false });
			const menuRect = await menu.boundingBox();
			expect(menuRect, `${REGRESSION}: overflow menu needs measurable visible geometry`).not.toBeNull();
			expect(menuRect!.x).toBeGreaterThanOrEqual(0);
			expect(menuRect!.x + menuRect!.width).toBeLessThanOrEqual(1280);
			await menu.getByRole("menuitem", { name: "Section 7.md", exact: true }).click();
			await expect(menu).toBeHidden();
			await expect(overflowPane.locator("review-document").getByText("Overflow body 7.").first()).toBeVisible();

			const overflowTabId = await overflowTab.getAttribute("data-panel-tab-id");
			expect(overflowTabId, `${REGRESSION}: overflow primary needs a stable workspace identity`).toBeTruthy();
			await page.setViewportSize({ width: 360, height: 740 });
			await expectCloseInsideTab(overflowTab, "360px long-title tab");
			const narrowOverflowPane = page.locator(`.side-panel-pane[data-panel-tab-id="${overflowTabId}"] review-pane`);
			const narrowMore = narrowOverflowPane.locator('button[aria-haspopup="menu"], button[title="More tabs"], button[aria-label="More tabs"]').first();
			await expect(narrowMore, `${REGRESSION}: constrained 360px file row must keep More tabs visible`).toBeVisible();
			await narrowMore.click();
			const narrowMenu = page.locator('[role="menu"]').filter({ hasText: "Section 6.md" }).first();
			await expect(narrowMenu, `${REGRESSION}: constrained overflow menu must remain visible`).toBeVisible();
			const narrowMenuRect = await narrowMenu.boundingBox();
			expect(narrowMenuRect, `${REGRESSION}: constrained overflow menu needs measurable geometry`).not.toBeNull();
			expect(narrowMenuRect!.x).toBeGreaterThanOrEqual(0);
			expect(narrowMenuRect!.x + narrowMenuRect!.width).toBeLessThanOrEqual(360);
			await narrowMenu.getByRole("menuitem", { name: "Section 6.md", exact: true }).click();
			await expect(narrowOverflowPane.locator("review-document").getByText("Overflow body 6.").first()).toBeVisible();
			await page.setViewportSize({ width: 1280, height: 800 });

			const alphaTab = primaryReviewTab(page, "Alpha Review");
			await alphaTab.locator(".goal-tab-close, [data-testid='side-panel-close']").click();
			await expect(primaryReviewTab(page, "Alpha Review"), `${REGRESSION}: closing one primary closes only that review`).toHaveCount(0);
			await expect(primaryReviewTab(page, longTitle), `${REGRESSION}: sibling review must survive primary close`).toBeVisible();

			await addReviewAnnotation(sessionId, "overflow-file-1", "comment-section-1", "Overflow body 1.", "Fix section one");
			await addReviewAnnotation(sessionId, "overflow-file-7", "comment-section-7", "Overflow body 7.", "Fix section seven");
			await page.reload();
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 20_000 });
			const reloadedPane = await expectReviewReady(page, longTitle, "Overflow body 6.");
			await reloadedPane.locator(".review-reject-btn").click();
			const feedback = page.locator("user-message").filter({ hasText: "Fix section one" }).last();
			await expect(feedback, `${REGRESSION}: rejecting must submit comments from every file`).toContainText("Fix section seven", { timeout: 15_000 });
			const feedbackText = await feedback.textContent() || "";
			expect(feedbackText.match(/Fix section one/g), `${REGRESSION}: first file comment must be submitted once`).toHaveLength(1);
			expect(feedbackText.match(/Fix section seven/g), `${REGRESSION}: overflow file comment must be submitted once`).toHaveLength(1);
			expect(feedbackText.indexOf("Section 1.md"), `${REGRESSION}: feedback must be grouped by first file`).toBeGreaterThan(-1);
			expect(feedbackText.indexOf("Section 7.md"), `${REGRESSION}: feedback must preserve file order`).toBeGreaterThan(feedbackText.indexOf("Section 1.md"));
			await expect(page.locator(REVIEW_TABS), `${REGRESSION}: a submitted decision closes only its review`).toHaveCount(0);
		} finally {
			await deleteSession(sessionId);
		}
	});

	test("mobile primary selection and unsent confirmation stay scoped to the exact review", async ({ page }) => {
		test.setTimeout(90_000);
		const sessionId = await createSession();
		try {
			await page.setViewportSize({ width: 360, height: 740 });
			await Promise.all([openApp(page), waitForSessionStatus(sessionId, "idle")]);
			await navigateToSession(page, sessionId);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });
			await sendAndWait(page, sessionId, "REVIEW_GROUPS_TWO");

			const alphaTab = primaryReviewTab(page, "Alpha Review");
			const overflowTitle = "Overflow Review With A Very Long Primary Workspace Tab Title That Must Truncate";
			const overflowTab = primaryReviewTab(page, overflowTitle);
			await expect(page.locator(REVIEW_TABS)).toHaveCount(2, { timeout: 20_000 });

			await alphaTab.click();
			const alphaTabId = await alphaTab.getAttribute("data-panel-tab-id");
			const alphaPane = page.locator(`.side-panel-pane[data-panel-tab-id="${alphaTabId}"] review-pane`);
			await expect(alphaPane.locator(".review-tab-bar").getByRole("tab", { name: "Overview.md", exact: true })).toBeVisible();
			await expect(alphaPane.locator(".review-tab-bar").getByRole("tab", { name: "Details.md", exact: true })).toBeVisible();
			await expect.poll(() => page.evaluate(() => (window as any).bobbitState?.reviewActiveReviewId), {
				message: `${REGRESSION}: eager mobile panes must not override Alpha primary selection`,
			}).toBe("alpha-review");

			await overflowTab.click();
			const overflowTabId = await overflowTab.getAttribute("data-panel-tab-id");
			const overflowPane = page.locator(`.side-panel-pane[data-panel-tab-id="${overflowTabId}"] review-pane`);
			await expect(overflowPane.locator(".review-tab-bar").getByRole("tab", { name: "Section 1.md", exact: true })).toBeVisible();
			await expect(overflowPane.locator(".review-tab-bar").getByRole("tab", { name: "Overview.md", exact: true })).toHaveCount(0);
			await overflowPane.locator(".review-final-comment-input").fill("Keep only the overflow review draft");

			// Crossing the responsive breakpoint remounts the pane; the review-level
			// draft must remain available when the narrow slider returns.
			await page.setViewportSize({ width: 900, height: 740 });
			await expect(page.locator("review-pane").first().locator(".review-final-comment-input")).toHaveValue("Keep only the overflow review draft");
			await page.setViewportSize({ width: 360, height: 740 });
			await expect(overflowPane.locator(".review-final-comment-input")).toHaveValue("Keep only the overflow review draft");

			await alphaTab.click();
			await expect.poll(() => page.evaluate(() => (window as any).bobbitState?.reviewActiveReviewId)).toBe("alpha-review");
			let cancelMessage = "";
			page.once("dialog", async (dialog) => {
				cancelMessage = dialog.message();
				await dialog.dismiss();
			});
			await overflowTab.locator(".goal-tab-close, [data-testid='side-panel-close']").click();
			expect(cancelMessage).toContain(`Close "${overflowTitle}"? 1 unsent comment will be discarded.`);
			await expect(overflowTab, `${REGRESSION}: cancel must preserve the exact review`).toBeVisible();
			await expect(alphaTab, `${REGRESSION}: cancel must preserve the selected sibling`).toBeVisible();

			await overflowTab.click();
			await expect(overflowPane.locator(".review-final-comment-input"), `${REGRESSION}: cancel must preserve the exact draft`).toHaveValue("Keep only the overflow review draft");
			await alphaTab.click();
			let confirmMessage = "";
			page.once("dialog", async (dialog) => {
				confirmMessage = dialog.message();
				await dialog.accept();
			});
			await overflowTab.locator(".goal-tab-close, [data-testid='side-panel-close']").click();
			expect(confirmMessage).toContain(`Close "${overflowTitle}"? 1 unsent comment will be discarded.`);
			await expect(overflowTab, `${REGRESSION}: confirmed close removes only its review`).toHaveCount(0, { timeout: 15_000 });
			await expect(alphaTab, `${REGRESSION}: confirmed close leaves the sibling review`).toBeVisible();
			await expect.poll(() => page.evaluate(() => (window as any).bobbitState?.reviewActiveReviewId)).toBe("alpha-review");
		} finally {
			await deleteSession(sessionId);
		}
	});

	test("failed session lookup releases foreground ownership before delayed review delivery", async ({ page }) => {
		test.setTimeout(60_000);
		const ownerId = await createSession();
		try {
			await Promise.all([openApp(page), waitForSessionStatus(ownerId, "idle")]);
			await navigateToSession(page, ownerId);
			await sendMessage(page, "REVIEW_GROUP_BACKGROUND_OPEN_DELAY:2000");
			await waitForBackgroundStreaming(ownerId);

			await page.evaluate(() => { window.location.hash = "#/session/does-not-exist-review-route"; });
			await expect(page).toHaveURL(/#\/$/, { timeout: 15_000 });
			await expect.poll(
				() => page.evaluate(() => {
					const current = (window as any).bobbitState;
					return {
						selectedSessionId: current?.selectedSessionId ?? null,
						remoteSessionId: current?.remoteAgent?.gatewaySessionId ?? null,
						hasChatPanel: !!current?.chatPanel,
					};
				}),
				{ timeout: 15_000, message: "missing target must release all outgoing foreground ownership" },
			).toEqual({ selectedSessionId: null, remoteSessionId: null, hasChatPanel: false });

			await waitForSessionStatus(ownerId, "idle");
			await expect(page.locator(REVIEW_TABS), "a delayed event from the old owner must not render on landing").toHaveCount(0);
			await expect(page.locator("review-pane"), "landing must not retain the old session panel").toHaveCount(0);

			// The released owner remains a managed background session: its live result
			// is durable and hydrates only when the user explicitly returns.
			await navigateToSession(page, ownerId);
			await expectReviewReady(page, "Background Session Review", "Background owner content A.");
		} finally {
			await deleteSession(ownerId);
		}
	});

	test("background live open and close stay owner-scoped, hydrate on switch/reload, and do not replay after close", async ({ page }) => {
		test.setTimeout(120_000);
		const foregroundId = await createSession();
		const ownerId = await createSession();
		try {
			await Promise.all([openApp(page), waitForSessionStatus(foregroundId, "idle"), waitForSessionStatus(ownerId, "idle")]);

			// Give the foreground the same review identity/title so session isolation is
			// proven rather than inferred from different labels.
			await navigateToSession(page, foregroundId);
			await sendAndWait(page, foregroundId, "REVIEW_GROUP_BACKGROUND_OPEN");
			await expectReviewReady(page, "Background Session Review", "Background owner content A.");

			await navigateToSession(page, ownerId);
			await sendMessage(page, "REVIEW_GROUP_BACKGROUND_OPEN_DELAY:2000");
			await waitForBackgroundStreaming(ownerId);
			await navigateToSession(page, foregroundId);
			await waitForSessionStatus(ownerId, "idle");
			expect(page.url(), "REVIEW_BACKGROUND_OPEN_DURABILITY: background open must not navigate away").toContain(`/session/${foregroundId}`);
			await expect(primaryReviewTab(page, "Background Session Review"), "REVIEW_BACKGROUND_OPEN_DURABILITY: foreground review state must remain intact").toHaveCount(1);
			await expect(page.locator("review-document").getByText("Background owner content A.").first()).toBeVisible();

			await navigateToSession(page, ownerId);
			const ownerPane = await expectReviewReady(page, "Background Session Review", "Background owner content A.");
			await expect(primaryReviewTab(page, "Background Session Review"), "REVIEW_BACKGROUND_OPEN_DURABILITY: owner gets one focused primary review tab").toHaveClass(/goal-tab-pill--active/);
			await ownerPane.locator(".review-tab-bar").getByRole("tab", { name: "Background B.md", exact: true }).click();
			await expect(ownerPane.locator("review-document").getByText("Background owner content B.").first()).toBeVisible();
			await page.reload();
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 20_000 });
			await expectReviewReady(page, "Background Session Review", "Background owner content B.");

			await sendMessage(page, "REVIEW_GROUP_BACKGROUND_CLOSE_DELAY:2000");
			await waitForBackgroundStreaming(ownerId);
			await navigateToSession(page, foregroundId);
			await waitForSessionStatus(ownerId, "idle");
			expect(page.url(), "REVIEW_BACKGROUND_OPEN_DURABILITY: background close must not navigate away").toContain(`/session/${foregroundId}`);
			await expectReviewReady(page, "Background Session Review", "Background owner content A.");

			await navigateToSession(page, ownerId);
			await expect(primaryReviewTab(page, "Background Session Review"), "REVIEW_BACKGROUND_OPEN_DURABILITY: close applies only to the owner session").toHaveCount(0, { timeout: 15_000 });
			await page.reload();
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 20_000 });
			await expect(primaryReviewTab(page, "Background Session Review"), "REVIEW_BACKGROUND_OPEN_DURABILITY: historical replay must not resurrect a closed review").toHaveCount(0);

			await navigateToSession(page, foregroundId);
			await expect(primaryReviewTab(page, "Background Session Review"), "REVIEW_BACKGROUND_OPEN_DURABILITY: owner close must leave foreground review untouched").toBeVisible();
		} finally {
			await deleteSession(ownerId);
			await deleteSession(foregroundId);
		}
	});
});
