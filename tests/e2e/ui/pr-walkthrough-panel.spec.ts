import type { Locator, Page } from "@playwright/test";
import { test, expect } from "../gateway-harness.js";
import { openApp, createSessionViaUI, sendMessage } from "./ui-helpers.js";

const WALKTHROUGH_COMMAND = "/walkthrough-pr 123";
const PANEL_TAB_SELECTOR = ".goal-preview-panel .goal-tab-pill[data-panel-tab-kind='walkthrough']";

const tid = (id: string) => `[data-testid="${id}"]`;

function walkthroughPanel(page: Page): Locator {
	return page.getByTestId("pr-walkthrough-panel");
}

function activeCard(page: Page): Locator {
	return walkthroughPanel(page).locator(`${tid("pr-walkthrough-card")}[data-active="true"]`).first();
}

async function setupWalkthrough(page: Page, viewport: { width: number; height: number } = { width: 1920, height: 1080 }) {
	await page.setViewportSize(viewport);
	await openApp(page);
	await createSessionViaUI(page);
	await sendMessage(page, WALKTHROUGH_COMMAND);

	const tab = page.locator(PANEL_TAB_SELECTOR).first();
	await expect(tab, "slash command should open a walkthrough side-panel tab").toBeVisible({ timeout: 15_000 });
	await expect(tab, "walkthrough tab id should use the canonical walkthrough:<id> shape").toHaveAttribute("data-panel-tab-id", /^walkthrough:/);
	await expect(tab).toHaveClass(/goal-tab-pill--active/);

	const panel = walkthroughPanel(page);
	await expect(panel, "walkthrough panel should render as side-panel content, not chat cards").toBeVisible({ timeout: 10_000 });
	await expect(activeCard(page), "fixture should render an active logical review card").toBeVisible({ timeout: 10_000 });
	return { tab, panel };
}

async function expectActiveDiffMode(page: Page, mode: "split" | "inline") {
	const diff = activeCard(page).getByTestId("pr-walkthrough-diff-block").first();
	await expect(diff, `active diff should be in ${mode} mode`).toHaveAttribute("data-diff-mode", mode, { timeout: 10_000 });
}

async function expectOneHorizontalScrollerPerDiff(page: Page) {
	const diff = activeCard(page).getByTestId("pr-walkthrough-diff-block").first();
	await expect(diff).toBeVisible();
	await expect.poll(async () => diff.evaluate((root) => {
		const scrollContainers = Array.from(root.querySelectorAll('[data-testid="pr-walkthrough-diff-scroll"]')) as HTMLElement[];
		return scrollContainers.filter((el) => {
			const style = window.getComputedStyle(el);
			return /(auto|scroll|overlay)/.test(style.overflowX);
		}).length;
	}), {
		timeout: 5_000,
		message: "split diff should wrap both sides in one shared horizontal scroll container",
	}).toBe(1);
}

async function activeCardId(page: Page): Promise<string> {
	await expect(activeCard(page)).toBeVisible();
	return (await activeCard(page).getAttribute("data-card-id")) || "";
}

async function openLineCommentEditor(page: Page) {
	const line = activeCard(page).getByTestId("pr-walkthrough-diff-line").first();
	await expect(line, "diff lines should be commentable").toBeVisible({ timeout: 10_000 });
	await line.hover();
	await line.click();
	const add = line.getByTestId("pr-walkthrough-line-comment-button").first();
	await expect(add, "clicking/hovering a diff line should reveal a line comment affordance").toBeVisible({ timeout: 5_000 });
	await add.click();
	await expect(page.getByTestId("pr-walkthrough-comment-editor")).toBeVisible({ timeout: 5_000 });
}

async function saveOpenComment(page: Page, body: string) {
	const editor = page.getByTestId("pr-walkthrough-comment-editor");
	await editor.getByTestId("pr-walkthrough-comment-input").fill(body);
	await editor.getByTestId("pr-walkthrough-comment-save").click();
	await expect(editor).toBeHidden({ timeout: 5_000 });
	await expect(walkthroughPanel(page).getByTestId("pr-walkthrough-comment").filter({ hasText: body })).toBeVisible({ timeout: 5_000 });
}

async function createLineComment(page: Page, body: string) {
	await openLineCommentEditor(page);
	await saveOpenComment(page, body);
}

async function editComment(page: Page, fromBody: string, toBody: string) {
	const comment = walkthroughPanel(page).getByTestId("pr-walkthrough-comment").filter({ hasText: fromBody }).first();
	await expect(comment).toBeVisible({ timeout: 5_000 });
	await comment.getByTestId("pr-walkthrough-comment-edit").click();
	await saveOpenComment(page, toBody);
	await expect(walkthroughPanel(page).getByTestId("pr-walkthrough-comment").filter({ hasText: fromBody })).toBeHidden();
}

async function deleteComment(page: Page, body: string) {
	const comment = walkthroughPanel(page).getByTestId("pr-walkthrough-comment").filter({ hasText: body }).first();
	await expect(comment).toBeVisible({ timeout: 5_000 });
	await comment.getByTestId("pr-walkthrough-comment-delete").click();
	await expect(walkthroughPanel(page).getByTestId("pr-walkthrough-comment").filter({ hasText: body })).toBeHidden({ timeout: 5_000 });
}

async function createCardComment(page: Page, body: string) {
	await activeCard(page).getByTestId("pr-walkthrough-add-card-comment").click();
	await saveOpenComment(page, body);
}

async function completeRemainingCardsWithLikes(page: Page) {
	const panel = walkthroughPanel(page);
	const visibleSteps = await panel.locator(`${tid("pr-walkthrough-card-dot")}, ${tid("pr-walkthrough-card-step")}`).count();
	const maxClicks = Math.max(visibleSteps + 2, 8);

	for (let i = 0; i < maxClicks; i++) {
		if (await panel.getByTestId("pr-walkthrough-audit").isVisible().catch(() => false)) return;
		const like = panel.getByTestId("pr-walkthrough-like").first();
		await expect(like, "Like should always be available to advance through cards").toBeVisible({ timeout: 5_000 });
		await like.click();
	}

	await expect(panel.getByTestId("pr-walkthrough-audit"), "walkthrough should enter Audit after all cards are decided").toBeVisible({ timeout: 10_000 });
}

test.describe("PR walkthrough panel", () => {
	test("launches from slash command with labelled full-width rail and split diff default", async ({ page }) => {
		const { panel } = await setupWalkthrough(page, { width: 1920, height: 1080 });

		await expect(panel.getByTestId("pr-walkthrough-labelled-rail"), "wide panel should show labelled phase/card navigation").toBeVisible();
		await expect(panel.getByTestId("pr-walkthrough-collapsed-rail"), "wide panel should not use the thin collapsed rail").toBeHidden();
		await expect(panel.getByTestId("pr-walkthrough-phase-button").filter({ hasText: "Orientation" })).toBeVisible();
		await expect(panel.getByTestId("pr-walkthrough-phase-button").filter({ hasText: "Key design choices" })).toBeVisible();
		await expectActiveDiffMode(page, "split");
		await expectOneHorizontalScrollerPerDiff(page);
	});

	test("narrow rail collapses to clickable card dots, defaults inline, and can switch back to split", async ({ page }) => {
		const { panel } = await setupWalkthrough(page, { width: 1100, height: 820 });

		await expect(panel.getByTestId("pr-walkthrough-collapsed-rail"), "narrow panel should show thin phase/card-dot rail").toBeVisible({ timeout: 10_000 });
		await expect(panel.getByTestId("pr-walkthrough-labelled-rail"), "narrow panel should hide labelled rail").toBeHidden();
		await expectActiveDiffMode(page, "inline");

		const dot = panel.getByTestId("pr-walkthrough-card-dot").nth(1);
		await expect(dot, "collapsed rail should expose clickable card-dot substeps").toBeVisible();
		await expect(dot, "card dots should have aria labels for narrow navigation").toHaveAttribute("aria-label", /card|orientation|design|significant|audit/i);
		await expect(dot, "card dots should expose tooltip text").toHaveAttribute("title", /\S+/);

		const before = await activeCardId(page);
		await dot.click();
		await expect.poll(() => activeCardId(page), {
			timeout: 5_000,
			message: "clicking a collapsed card dot should change the active card",
		}).not.toBe(before);

		await panel.getByRole("button", { name: /^Split$/ }).click();
		await expectActiveDiffMode(page, "split");
		await expectOneHorizontalScrollerPerDiff(page);
	});

	test("supports line comments, dislike gating, revisions, audit draft, and reload persistence", async ({ page }) => {
		const timestamp = Date.now();
		const firstLineComment = `line-comment-${timestamp}`;
		const editedLineComment = `edited-line-comment-${timestamp + 1}`;
		const broadConcern = `broad-concern-${Date.now()}`;
		const revisedConcern = `revised-concern-${Date.now()}`;

		const { panel, tab } = await setupWalkthrough(page, { width: 1920, height: 1080 });

		const dislike = panel.getByTestId("pr-walkthrough-dislike").first();
		await expect(dislike, "Dislike should be disabled until the active card has a comment").toBeDisabled();

		await createLineComment(page, firstLineComment);
		await editComment(page, firstLineComment, editedLineComment);
		await deleteComment(page, editedLineComment);
		await expect(dislike, "Dislike should become disabled again after deleting the only comment").toBeDisabled();

		await createCardComment(page, broadConcern);
		await expect(dislike, "Dislike should enable once a custom card or line comment exists").toBeEnabled();
		const firstCard = await activeCardId(page);
		await dislike.click();
		await expect.poll(() => activeCardId(page), {
			timeout: 5_000,
			message: "Dislike should record the concern and advance to the next card",
		}).not.toBe(firstCard);

		const secondCard = await activeCardId(page);
		await panel.getByTestId("pr-walkthrough-like").click();
		await expect.poll(() => activeCardId(page), {
			timeout: 5_000,
			message: "Like should advance to the next card",
		}).not.toBe(secondCard);

		await panel.getByTestId("pr-walkthrough-prev").click();
		await expect.poll(() => activeCardId(page), {
			timeout: 5_000,
			message: "Prev should backtrack to the liked card for revision",
		}).toBe(secondCard);
		await createCardComment(page, revisedConcern);
		await panel.getByTestId("pr-walkthrough-dislike").click();

		await completeRemainingCardsWithLikes(page);

		const audit = panel.getByTestId("pr-walkthrough-audit");
		const draft = panel.getByTestId("pr-walkthrough-draft");
		await expect(audit).toBeVisible();
		await expect(draft, "Audit draft should include broad concerns for disliked cards").toContainText(broadConcern);
		await expect(draft, "Audit draft should include revised concerns after using Prev").toContainText(revisedConcern);
		await expect(draft, "Audit draft should group accepted/liked context").toContainText(/approved|liked|accepted/i);
		await expect(draft, "Audit draft should group concerns for disliked cards").toContainText(/concern|disliked|changes requested/i);
		await expect(tab).toHaveClass(/goal-tab-pill--active/);

		await page.reload();
		await expect(page.locator(PANEL_TAB_SELECTOR).first(), "walkthrough tab should persist across reload when persistence is implemented").toBeVisible({ timeout: 15_000 });
		await expect(walkthroughPanel(page).getByTestId("pr-walkthrough-audit"), "active walkthrough audit state should restore after reload").toBeVisible({ timeout: 10_000 });
		await expect(walkthroughPanel(page).getByTestId("pr-walkthrough-draft")).toContainText(broadConcern);
		await expect(walkthroughPanel(page).getByTestId("pr-walkthrough-draft")).toContainText(revisedConcern);
	});

	test("accepts, edits, and deletes suggested line comments when fixture suggestions are present", async ({ page }) => {
		const editedSuggestion = `edited-suggested-comment-${Date.now()}`;
		const { panel } = await setupWalkthrough(page, { width: 1920, height: 1080 });

		const suggestion = panel.getByTestId("pr-walkthrough-suggested-comment").first();
		if (await suggestion.count() === 0) {
			test.skip(true, "fixture data does not include a suggested line comment");
		}

		await expect(suggestion, "fixture suggested comments should render as queued line comment chips/markers").toBeVisible();
		await suggestion.getByTestId("pr-walkthrough-suggested-comment-accept").click();

		const accepted = panel.getByTestId("pr-walkthrough-comment").filter({ hasText: /.+/ }).first();
		await expect(accepted, "accepted suggested comment should become a queued line comment").toBeVisible({ timeout: 5_000 });
		await accepted.getByTestId("pr-walkthrough-comment-edit").click();
		await saveOpenComment(page, editedSuggestion);
		await expect(panel.getByTestId("pr-walkthrough-comment").filter({ hasText: editedSuggestion })).toBeVisible();

		await deleteComment(page, editedSuggestion);
	});
});
