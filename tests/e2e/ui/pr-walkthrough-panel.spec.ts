import type { Locator, Page } from "@playwright/test";
import { test, expect } from "../gateway-harness.js";
import { openApp, createSessionViaUI, sendMessage } from "./ui-helpers.js";

const WALKTHROUGH_COMMAND = "/walkthrough-pr 123";
const WALKTHROUGH_URL = "https://github.com/SuuBro/bobbit/pull/637";
const WALKTHROUGH_URL_COMMAND = `/walkthrough-pr ${WALKTHROUGH_URL}`;
const PANEL_TAB_SELECTOR = ".goal-preview-panel .goal-tab-pill[data-panel-tab-kind='walkthrough']";

const tid = (id: string) => `[data-testid="${id}"]`;

function resolvedWalkthroughPayload(prNumber: string | number, title = "Resolved Walkthrough PR") {
	return {
		changesetId: `github:SuuBro/bobbit#${prNumber}:abc1234`,
		changeset: {
			baseSha: "base1234",
			headSha: "abc1234",
			provider: "github",
			externalUrl: `https://github.com/SuuBro/bobbit/pull/${prNumber}`,
			prUrl: `https://github.com/SuuBro/bobbit/pull/${prNumber}`,
			prNumber,
			prTitle: title,
			title: `PR #${prNumber}: ${title}`,
			filesChanged: 1,
			additions: 2,
			deletions: 1,
		},
		cards: [{
			id: "resolved-card",
			phaseId: "orientation",
			title: "Resolved logical card",
			summary: "This card came from the resolver API, not the fixture fallback.",
			diffBlocks: [{
				id: "resolved-block",
				filePath: "src/app/pr-walkthrough.ts",
				hunks: [{
					id: "resolved-hunk",
					header: "@@ -1,1 +1,2 @@",
					lines: [
						{ id: "resolved-line-1", side: "context", oldLine: 1, newLine: 1, kind: "context", text: "export const existing = true;" },
						{ id: "resolved-line-2", side: "new", newLine: 2, kind: "add", text: "export const resolved = true;" },
					],
				}],
			}],
		}],
		warnings: [{ code: "test-warning", severity: "info", message: "Resolver warning surfaced." }],
		export: { provider: "github", available: true },
	};
}

function walkthroughPanel(page: Page): Locator {
	return page.getByTestId("pr-walkthrough-panel");
}

function activeCard(page: Page): Locator {
	return walkthroughPanel(page).locator(`${tid("pr-walkthrough-card")}[data-active="true"]`).first();
}

async function expectWalkthroughOpened(page: Page) {
	const tab = page.locator(PANEL_TAB_SELECTOR).first();
	await expect(tab, "walkthrough should open a side-panel tab").toBeVisible({ timeout: 15_000 });
	await expect(tab, "walkthrough tab id should use the canonical walkthrough:<id> shape").toHaveAttribute("data-panel-tab-id", /^walkthrough:/);
	await expect(tab).toHaveClass(/goal-tab-pill--active/);

	const panel = walkthroughPanel(page);
	await expect(panel, "walkthrough panel should render as side-panel content, not chat cards").toBeVisible({ timeout: 10_000 });
	await expect(activeCard(page), "fixture should render an active logical review card").toBeVisible({ timeout: 10_000 });
	return { tab, panel };
}

async function setupWalkthrough(
	page: Page,
	viewport: { width: number; height: number } = { width: 1920, height: 1080 },
	command = WALKTHROUGH_COMMAND,
) {
	await page.setViewportSize(viewport);
	await openApp(page);
	await createSessionViaUI(page);
	await sendMessage(page, command);
	return expectWalkthroughOpened(page);
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

async function expectSplitDiffColumnsAligned(page: Page) {
	const diff = activeCard(page).getByTestId("pr-walkthrough-diff-block").first();
	await expect(diff).toBeVisible();
	await expect.poll(async () => diff.evaluate((root) => {
		const rows = Array.from(root.querySelectorAll(".split-row")) as HTMLElement[];
		const measurements = rows.map((row) => {
			const [left, right] = Array.from(row.querySelectorAll(":scope > .diff-line")) as HTMLElement[];
			if (!left || !right) return null;
			const leftBox = left.getBoundingClientRect();
			const rightBox = right.getBoundingClientRect();
			const leftTextBox = left.querySelector(".line-text")?.getBoundingClientRect();
			const rightTextBox = right.querySelector(".line-text")?.getBoundingClientRect();
			return { leftX: leftBox.x, rightX: rightBox.x, leftWidth: leftBox.width, rightWidth: rightBox.width, leftTextRight: leftTextBox?.right ?? leftBox.right, rightTextLeft: rightTextBox?.left ?? rightBox.left };
		}).filter(Boolean) as Array<{ leftX: number; rightX: number; leftWidth: number; rightWidth: number; leftTextRight: number; rightTextLeft: number }>;
		if (measurements.length < 2) return false;
		const first = measurements[0]!;
		return measurements.every((item) =>
			Math.abs(item.leftX - first.leftX) <= 1
			&& Math.abs(item.rightX - first.rightX) <= 1
			&& Math.abs(item.leftWidth - first.leftWidth) <= 1
			&& Math.abs(item.rightWidth - first.rightWidth) <= 1
			&& item.leftTextRight <= item.rightX + 1
			&& item.rightTextLeft >= item.rightX - 1,
		);
	}), {
		timeout: 5_000,
		message: "split diff old/new columns should stay vertically aligned across rows",
	}).toBe(true);
}

async function expectPrototypeHeader(panel: Locator, expected: { pr?: RegExp; title?: RegExp; href?: string | RegExp } = {}) {
	const header = panel.getByTestId("pr-walkthrough-header");
	await expect(header, "walkthrough should use the prominent prototype-style review header").toBeVisible({ timeout: 10_000 });
	await expect(header.getByTestId("pr-walkthrough-pr-title"), "header should expose the PR/title block").toBeVisible();
	if (expected.pr) await expect(header).toContainText(expected.pr);
	if (expected.title) await expect(header).toContainText(expected.title);

	const fileStat = header.getByTestId("pr-walkthrough-stat-files");
	const addStat = header.getByTestId("pr-walkthrough-stat-additions");
	await expect(fileStat, "header should show changed file count").toContainText(/\d+\s+files?/i);
	await expect(addStat, "header should show green additions stat").toContainText(/\+\s*[\d,]+/);
	await expect(header.getByTestId("pr-walkthrough-stat-deletions"), "header should show red deletions stat").toContainText(/-\s*[\d,]+/);
	await expect.poll(async () => {
		const [filesBox, additionsBox] = await Promise.all([fileStat.boundingBox(), addStat.boundingBox()]);
		return filesBox && additionsBox ? additionsBox.x > filesBox.x && Math.abs(additionsBox.y - filesBox.y) < 6 : false;
	}, { message: "line-change counts should sit to the right of the file count" }).toBe(true);
	const progress = header.getByTestId("pr-walkthrough-progress");
	await expect(progress, "header should show review progress").toContainText(/\d+\s*\/\s*\d+\s+reviewed/i);
	await expect.poll(async () => {
		const [trackBox, labelBox] = await Promise.all([progress.locator(".progress-track").boundingBox(), progress.locator(".progress-label").boundingBox()]);
		return trackBox && labelBox ? labelBox.y > trackBox.y : false;
	}, { message: "reviewed count should sit beneath the progress bar" }).toBe(true);
	const submit = header.getByRole("button", { name: /^submit$/i });
	await expect(submit, "header should reserve the final draft submit control").toBeVisible();
	await expect(submit.locator("svg"), "submit control should include an icon").toBeVisible();

	if (expected.href) {
		const link = header.getByTestId("pr-walkthrough-pr-link");
		await expect(link, "header should expose a compact external PR/GitHub link").toBeVisible();
		await expect(link).toHaveAttribute("href", expected.href);
		await expect(link).toHaveAttribute("target", "_blank");
		await expect(link.locator("svg"), "GitHub links should include the GitHub mark").toBeVisible();
		await expect(link, "GitHub links should always use compact action text").toContainText(/^Open on GitHub$/i);
		await expect.poll(async () => {
			const [titleBox, linkBox] = await Promise.all([header.locator(".title").boundingBox(), link.boundingBox()]);
			return titleBox && linkBox ? linkBox.y - (titleBox.y + titleBox.height) : -1;
		}, { message: "GitHub link row should have breathing room beneath the PR title" }).toBeGreaterThanOrEqual(3);
	}
}

async function expectPrototypeCardHierarchy(page: Page) {
	const card = activeCard(page);
	await expect(card.getByTestId("pr-walkthrough-card-phase-tag"), "card should show a compact phase tag above the title").toBeVisible();
	await expect(card.getByTestId("pr-walkthrough-card-title"), "card should show the logical change title prominently").toBeVisible();
	await expect(card.getByTestId("pr-walkthrough-card-summary"), "card should include the senior-reviewer narrative summary").toBeVisible();
	await expect(card, "card should not spend space on redundant ordinal metadata").not.toContainText(/Card \d+ of \d+ · logical change set/i);
	const chooser = card.getByTestId("pr-walkthrough-diff-mode-chooser");
	if (await chooser.count()) {
		await expect(chooser, "diff mode chooser should sit in the card header").toBeVisible();
		await expect(chooser.getByTestId("diff-mode-split"), "split mode should be icon-only with tooltip").toHaveAttribute("title", "Split diff");
		await expect(chooser.getByTestId("diff-mode-inline"), "inline mode should be icon-only with tooltip").toHaveAttribute("title", "Inline diff");
		await expect(chooser, "diff mode chooser should not render text labels").not.toContainText(/Split|Inline|Diff display/i);
		await expect.poll(async () => {
			const [phaseBox, chooserBox] = await Promise.all([card.getByTestId("pr-walkthrough-card-phase-tag").boundingBox(), chooser.boundingBox()]);
			return phaseBox && chooserBox ? chooserBox.x > phaseBox.x + phaseBox.width : false;
		}, { message: "diff mode chooser should sit to the far right of the phase pill row" }).toBe(true);
	}
	await expect(card.getByTestId("pr-walkthrough-card-comments"), "card should include card-level concern/comment affordances").toBeVisible();
	await expect(card.getByText(/write your own/i), "card-level comments should always allow a custom concern").toBeVisible();
}

async function expectCollapsedRailPipsAndDots(panel: Locator) {
	const collapsedRail = panel.getByTestId("pr-walkthrough-collapsed-rail");
	await expect(collapsedRail, "narrow panel should show the thin collapsed rail").toBeVisible({ timeout: 10_000 });
	const pips = collapsedRail.getByTestId("pr-walkthrough-phase-pip");
	await expect(pips.first(), "collapsed rail should show visible phase pips").toBeVisible();
	await expect(pips.first(), "phase pips should expose native tooltip text").toHaveAttribute("title", /orientation|phase/i);
	const unreviewedPip = pips.nth(1);
	await expect(unreviewedPip, "collapsed rail phases should render as compact muted headers").toBeVisible();
	await expect.poll(() => unreviewedPip.evaluate(el => {
		const style = getComputedStyle(el as HTMLElement);
		const divider = getComputedStyle(el.parentElement as HTMLElement, "::before");
		return { borderWidth: style.borderTopWidth, background: style.backgroundColor, dividerHeight: divider.height };
	}), { message: "phase headers should use dividers instead of status-filled pips" }).toMatchObject({ borderWidth: "0px", background: /rgba\(0, 0, 0, 0\)|transparent/i, dividerHeight: /[1-9]/ });

	const dot = collapsedRail.getByTestId("pr-walkthrough-card-dot").nth(1);
	await expect(dot, "collapsed rail should expose clickable card-dot substeps").toBeVisible();
	await expect(dot, "card dots should have aria labels for narrow navigation").toHaveAttribute("aria-label", /card|orientation|design|significant|audit/i);
	await expect(dot, "card dots should expose tooltip text").toHaveAttribute("title", /\S+/);
	await expect.poll(() => dot.evaluate(el => {
		const style = getComputedStyle(el as HTMLElement);
		return { borderWidth: style.borderTopWidth, border: style.borderTopColor, background: style.backgroundColor, text: (el.textContent || "").trim() };
	}), { message: "unreviewed collapsed rail card dots should render as visible hollow circles" }).toMatchObject({ borderWidth: /[1-9]/, border: /^(?!rgba\(0, 0, 0, 0\))/i, background: /rgba\(0, 0, 0, 0\)|transparent/i, text: "" });
	return dot;
}

async function expectDiffExpandCollapseIfExposed(page: Page) {
	const diff = activeCard(page).getByTestId("pr-walkthrough-diff-block").first();
	await expect(diff).toBeVisible();
	const toggle = diff.getByTestId("pr-walkthrough-diff-toggle").first();
	if (await toggle.count() === 0) return;

	await expect(toggle, "diff blocks should expose an expand/collapse control when collapsible").toBeVisible();
	await expect(diff, "collapsible diff blocks should reflect their expanded state for tests and a11y").toHaveAttribute("data-expanded", /true|false/);
	const before = await diff.getAttribute("data-expanded");
	await toggle.click();
	await expect.poll(() => diff.getAttribute("data-expanded"), {
		timeout: 5_000,
		message: "clicking the diff header toggle should collapse/expand the diff block",
	}).not.toBe(before);
	await toggle.click();
}

async function activeCardId(page: Page): Promise<string> {
	await expect(activeCard(page)).toBeVisible();
	return (await activeCard(page).getAttribute("data-card-id")) || "";
}

async function selectCardById(page: Page, cardId: string) {
	const step = walkthroughPanel(page).locator(`${tid("pr-walkthrough-card-step")}[data-card-id="${cardId}"]`).first();
	await expect(step, `card step ${cardId} should be available`).toBeVisible({ timeout: 10_000 });
	await step.click();
	await expect.poll(() => activeCardId(page), {
		timeout: 5_000,
		message: `card ${cardId} should become active`,
	}).toBe(cardId);
}

async function openLineCommentEditor(page: Page) {
	const line = activeCard(page).getByTestId("pr-walkthrough-diff-line").first();
	await expect(line, "diff lines should be commentable").toBeVisible({ timeout: 10_000 });
	await line.hover();
	const add = line.getByTestId("pr-walkthrough-line-comment-button").first();
	await expect(add, "hovering a diff line should reveal an inline + comment affordance").toBeVisible({ timeout: 5_000 });
	await expect.poll(async () => add.evaluate((el) => [
		el.textContent,
		el.getAttribute("aria-label"),
		el.getAttribute("title"),
	].filter(Boolean).join(" ").trim()), {
		timeout: 5_000,
		message: "line comment affordance should be visually/textually identifiable as +",
	}).toMatch(/\+/);
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

async function createCommentOnDiffLine(page: Page, lineId: string, body: string) {
	const line = activeCard(page).locator(`${tid("pr-walkthrough-diff-line")}[data-line-id="${lineId}"]`).first();
	await expect(line, `diff line ${lineId} should be visible and commentable`).toBeVisible({ timeout: 10_000 });
	await line.hover();
	await line.getByTestId("pr-walkthrough-line-comment-button").click();
	await expect(page.getByTestId("pr-walkthrough-comment-editor")).toHaveAttribute("data-line-id", lineId, { timeout: 5_000 });
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
	test("launches from slash command with prototype header, labelled full-width rail, and split diff default", async ({ page }) => {
		const { panel, tab } = await setupWalkthrough(page, { width: 1920, height: 1080 });

		await expect(tab.locator(".goal-tab-pill-label"), "walkthrough tab should use the compact PR label").toHaveText("PR: #123");
		await expectPrototypeHeader(panel, { pr: /PR\s*#123/i, title: /walkthrough/i });
		await expectPrototypeCardHierarchy(page);
		const labelledRail = panel.getByTestId("pr-walkthrough-labelled-rail");
		await expect(labelledRail, "wide panel should show labelled phase/card navigation").toBeVisible();
		await expect(labelledRail, "sidebar should not duplicate the header PR headline").not.toContainText(/PR\s*#123/i);
		await expect(panel.getByTestId("pr-walkthrough-collapsed-rail"), "wide panel should not use the thin collapsed rail").toBeHidden();
		const orientationPhase = panel.getByTestId("pr-walkthrough-phase-button").filter({ hasText: "Orientation" });
		await expect(orientationPhase).toBeVisible();
		await expect(panel.getByTestId("pr-walkthrough-phase-button").filter({ hasText: "Key design choices" })).toBeVisible();
		await expect.poll(() => orientationPhase.evaluate(el => {
			const style = getComputedStyle(el as HTMLElement);
			const rule = getComputedStyle(el as HTMLElement, "::after");
			return { textTransform: style.textTransform, ruleHeight: rule.height, background: style.backgroundColor };
		}), { message: "phase navigation should use dense muted section headers with divider rules, not selection fills" }).toMatchObject({ textTransform: "uppercase", ruleHeight: /[1-9]/, background: /rgba\(0, 0, 0, 0\)|transparent/i });
		await expect.poll(async () => {
			const [contentBox, innerBox] = await Promise.all([panel.locator(".content").boundingBox(), panel.locator(".inner").boundingBox()]);
			if (!contentBox || !innerBox) return false;
			const leftGutter = innerBox.x - contentBox.x;
			const rightGutter = contentBox.x + contentBox.width - (innerBox.x + innerBox.width);
			return leftGutter <= 30 && rightGutter <= 30;
		}, { message: "walkthrough content should use the available panel width without oversized gutters" }).toBe(true);
		await expect.poll(async () => {
			const [contentBox, actionsBox] = await Promise.all([panel.locator(".content").boundingBox(), activeCard(page).locator(".actions").boundingBox()]);
			return contentBox && actionsBox ? Math.abs(contentBox.y + contentBox.height - (actionsBox.y + actionsBox.height)) <= 1 : false;
		}, { message: "interaction bar should be pinned flush to the bottom of the walkthrough content panel" }).toBe(true);
		await expect(activeCard(page).getByTestId("pr-walkthrough-like").locator(".decision-icon"), "like action should include a thumbs-up icon").toBeVisible();
		await expect(activeCard(page).getByTestId("pr-walkthrough-dislike").locator(".decision-icon"), "dislike action should include a thumbs-down icon").toBeVisible();
		await expect(activeCard(page).getByTestId("pr-walkthrough-like"), "like action label should stay stable even when comments exist").toContainText(/^Like$/);
		await expect(activeCard(page).getByTestId("pr-walkthrough-like"), "like button should start at the compact action height").toHaveCSS("min-height", "32px");
		await expect(activeCard(page).getByTestId("pr-walkthrough-like").locator(".next-icon"), "like action should use an icon instead of an arrow character").toBeVisible();
		await expect(activeCard(page).getByTestId("pr-walkthrough-dislike").locator(".next-icon"), "dislike action should also use a forward chevron icon").toBeVisible();
		await expect(activeCard(page).getByTestId("pr-walkthrough-prev").locator(".prev-icon"), "prev action should use an icon instead of an arrow character").toBeVisible();
		await expect(activeCard(page).getByTestId("pr-walkthrough-like"), "like action should never say Like anyway").not.toContainText(/Like anyway|→/i);
		await expect(activeCard(page).getByTestId("pr-walkthrough-prev"), "prev action should not render a literal arrow").not.toContainText(/←/);
		await expect.poll(async () => {
			const [thumbBox, nextBox] = await Promise.all([
				activeCard(page).getByTestId("pr-walkthrough-like").locator(".decision-icon").boundingBox(),
				activeCard(page).getByTestId("pr-walkthrough-like").locator(".next-icon").boundingBox(),
			]);
			return thumbBox && nextBox ? Math.abs((thumbBox.y + thumbBox.height / 2) - (nextBox.y + nextBox.height / 2)) <= 1 : false;
		}, { message: "like chevron should align vertically with the thumbs-up icon" }).toBe(true);
		await expectActiveDiffMode(page, "split");
		await expect(activeCard(page).locator(".line-text .tok-keyword").first(), "diff lines should include lightweight syntax highlighting").toBeVisible();
		await expect(activeCard(page).getByTestId("pr-walkthrough-diff-additions").first(), "diff headers should show line addition counts").toContainText(/\+\d+/);
		await expectOneHorizontalScrollerPerDiff(page);
		await expectSplitDiffColumnsAligned(page);
		await expectDiffExpandCollapseIfExposed(page);
	});

	test("narrow rail collapses to pips and clickable card dots, defaults inline, and can switch back to split", async ({ page }) => {
		const { panel } = await setupWalkthrough(page, { width: 1100, height: 820 });

		await expect(panel.getByTestId("pr-walkthrough-labelled-rail"), "narrow panel should hide labelled rail").toBeHidden();
		await expectActiveDiffMode(page, "inline");

		const dot = await expectCollapsedRailPipsAndDots(panel);
		const before = await activeCardId(page);
		await dot.click();
		await expect.poll(() => activeCardId(page), {
			timeout: 5_000,
			message: "clicking a collapsed card dot should change the active card",
		}).not.toBe(before);

		await panel.getByTestId("diff-mode-split").click();
		await expectActiveDiffMode(page, "split");
		await expectOneHorizontalScrollerPerDiff(page);
		await expectSplitDiffColumnsAligned(page);
	});

	test("collapsed rail card dots encode liked and disliked review decisions", async ({ page }) => {
		const { panel } = await setupWalkthrough(page, { width: 1100, height: 820 });
		await panel.getByTestId("pr-walkthrough-like").first().click();
		const likedDot = panel.getByTestId("pr-walkthrough-card-dot").first();
		await expect(likedDot.locator("svg"), "liked cards should show a thumbs-up icon").toBeVisible();
		await expect(likedDot.locator("svg path").first()).toHaveAttribute("d", "M7 10v12");
		await expect(likedDot, "liked cards should use primary filled-circle styling").toHaveClass(/liked/);
		await expect.poll(() => likedDot.evaluate(el => getComputedStyle(el as HTMLElement).backgroundColor), { message: "liked sidebar dots should use a filled status circle" }).not.toMatch(/rgba\(0, 0, 0, 0\)|transparent/i);
		await likedDot.click();
		await expect.poll(() => likedDot.evaluate(el => getComputedStyle(el as HTMLElement).boxShadow), { message: "selected liked dots should keep the active glow" }).not.toBe("none");

		const secondDot = panel.getByTestId("pr-walkthrough-card-dot").nth(1);
		await secondDot.click();
		await createCardComment(page, `collapsed-dislike-${Date.now()}`);
		await panel.getByTestId("pr-walkthrough-dislike").first().click();
		const dislikedDot = panel.getByTestId("pr-walkthrough-card-dot").nth(1);
		await expect(dislikedDot.locator("svg"), "disliked cards should show a thumbs-down icon").toBeVisible();
		await expect(dislikedDot.locator("svg path").first()).toHaveAttribute("d", "M17 14V2");
		await expect(dislikedDot, "disliked cards should use danger filled-circle styling").toHaveClass(/disliked/);
		await expect.poll(() => dislikedDot.evaluate(el => getComputedStyle(el as HTMLElement).backgroundColor), { message: "disliked sidebar dots should use a filled status circle" }).not.toMatch(/rgba\(0, 0, 0, 0\)|transparent/i);
		await dislikedDot.click();
		await expect.poll(() => dislikedDot.evaluate(el => getComputedStyle(el as HTMLElement).boxShadow), { message: "selected disliked dots should keep the active glow" }).not.toBe("none");

		const pendingDot = panel.getByTestId("pr-walkthrough-card-dot").nth(2);
		await expect(pendingDot, "pending cards should stay hollow").toHaveText("");
		await expect(pendingDot).not.toHaveClass(/liked|disliked/);
	});

	test("diff hunks default to compact GitHub-like context and can expand on demand", async ({ page }) => {
		const { panel } = await setupWalkthrough(page, { width: 1100, height: 820 });
		await page.evaluate(async () => {
			const walkthrough = document.querySelector("pr-walkthrough-panel") as any;
			const focalIndex = 27;
			const lines = Array.from({ length: 55 }, (_, index) => ({
				id: `ctx-${index + 1}`,
				side: index === focalIndex ? "new" : "context",
				oldLine: index === focalIndex ? undefined : index + 1,
				newLine: index + 1,
				kind: index === focalIndex ? "add" : "context",
				text: index === focalIndex ? "added focal line" : index === 23 ? "function contextFixture() {" : `context ${index + 1}`,
			}));
			walkthrough.changeset = { baseSha: "base", headSha: "head", provider: "github", title: "Long context fixture", filesChanged: 1, additions: 1, deletions: 0 };
			walkthrough.cards = [{
				id: "long-context-card",
				phaseId: "significant",
				title: "Long context hunk",
				summary: "This card verifies compact diff context.",
				diffBlocks: [{ id: "long-context-block", filePath: "src/context.ts", hunks: [{ id: "long-context-hunk", header: "@@ -1,55 +1,55 @@ function fallbackSignature() {", lines }] }],
			}];
			walkthrough.status = "ready";
			await walkthrough.updateComplete;
		});
		await expect(activeCard(page).getByTestId("pr-walkthrough-card-title")).toContainText("Long context hunk");
		await expect(activeCard(page).locator(`${tid("pr-walkthrough-diff-line")}[data-line-id="ctx-1"]`), "far context should be hidden by default").toBeHidden();
		await expect(activeCard(page).locator(`${tid("pr-walkthrough-diff-line")}[data-line-id="ctx-25"]`), "near context should remain visible by default").toBeVisible();
		await expect(activeCard(page).locator(`${tid("pr-walkthrough-diff-line")}[data-line-id="ctx-31"]`), "near trailing context should remain visible by default").toBeVisible();
		const hunkHeaders = activeCard(page).getByTestId("pr-walkthrough-hunk-header");
		await expect(hunkHeaders, "context controls should bracket the visible diff context instead of stacking above it").toHaveCount(2);
		const hunkHeader = hunkHeaders.first();
		const trailingContextHeader = hunkHeaders.nth(1);
		const hunkSignature = hunkHeader.locator(".hunk-signature");
		await expect(hunkSignature, "context controls should show the signature that will be revealed next, not the fallback hunk header").toContainText("function contextFixture() {");
		await expect(hunkSignature, "hunk range counts should be hidden from the visible signature").not.toContainText("@@");
		await expect(hunkHeader, "hunk range counts should not appear in the blue-row tooltip").not.toHaveAttribute("title", /@@/);
		const toggles = activeCard(page).getByTestId("pr-walkthrough-context-toggle");
		await expect(toggles.first(), "context controls should be icon-only").toHaveText("");
		await expect(toggles.first()).toHaveAttribute("data-context-direction", "above");
		await expect(toggles.first()).toHaveAttribute("title", /Show 20 more lines above/i);
		await expect(toggles.nth(1)).toHaveAttribute("data-context-direction", "below");
		await expect(toggles.nth(1)).toHaveAttribute("title", /Show 20 more lines below/i);
		await expect(trailingContextHeader.locator(".hunk-signature"), "the trailing context control row should not show duplicate code/signature text").toHaveText("");
		await expect.poll(async () => {
			const [headerBox, toggleBox] = await Promise.all([hunkHeader.boundingBox(), toggles.first().boundingBox()]);
			return headerBox && toggleBox ? toggleBox.y >= headerBox.y && toggleBox.y + toggleBox.height <= headerBox.y + headerBox.height : false;
		}, { message: "context buttons should sit inside the hunk signature contrast bar" }).toBe(true);
		await expect.poll(async () => {
			const [aboveBox, firstLineBox, lastLineBox, belowBox] = await Promise.all([
				toggles.first().boundingBox(),
				activeCard(page).locator(`${tid("pr-walkthrough-diff-line")}[data-line-id="ctx-25"]`).boundingBox(),
				activeCard(page).locator(`${tid("pr-walkthrough-diff-line")}[data-line-id="ctx-31"]`).boundingBox(),
				toggles.nth(1).boundingBox(),
			]);
			return aboveBox && firstLineBox && lastLineBox && belowBox ? aboveBox.y < firstLineBox.y && belowBox.y > lastLineBox.y : false;
		}, { message: "above/below context controls should bracket the visible diff context" }).toBe(true);
		await expect.poll(async () => {
			const [headerBox, lineBox] = await Promise.all([
				hunkHeader.boundingBox(),
				activeCard(page).locator(`${tid("pr-walkthrough-diff-line")}[data-line-id="ctx-25"]`).boundingBox(),
			]);
			return headerBox && lineBox ? Math.abs(headerBox.height - lineBox.height) <= 1 : false;
		}, { message: "blue context rows should match normal diff row height" }).toBe(true);
		await expect.poll(async () => {
			const [cellBox, toggleBox] = await Promise.all([hunkHeader.locator(".hunk-context-cell").boundingBox(), toggles.first().boundingBox()]);
			return cellBox && toggleBox ? toggleBox.width >= cellBox.width - 8 && toggleBox.width < cellBox.width : false;
		}, { message: "context buttons should span the line-number/sign gutter with a small margin" }).toBe(true);
		await expect.poll(async () => {
			const [signatureBox, textBox] = await Promise.all([
				hunkSignature.boundingBox(),
				activeCard(page).locator(`${tid("pr-walkthrough-diff-line")}[data-line-id="ctx-25"] .line-text`).boundingBox(),
			]);
			return signatureBox && textBox ? Math.abs(signatureBox.x - textBox.x) <= 1 : false;
		}, { message: "hunk signature should align with diff code text, not line numbers" }).toBe(true);
		await toggles.first().click();
		await expect(activeCard(page).locator(`${tid("pr-walkthrough-diff-line")}[data-line-id="ctx-5"]`), "expanding above context should reveal the next 20 leading lines").toBeVisible();
		await expect(activeCard(page).locator(`${tid("pr-walkthrough-diff-line")}[data-line-id="ctx-1"]`), "remaining leading context should stay hidden until expanded again").toBeHidden();
		await activeCard(page).locator(`${tid("pr-walkthrough-context-toggle")}[data-context-direction="above"]`).click();
		await expect(activeCard(page).locator(`${tid("pr-walkthrough-diff-line")}[data-line-id="ctx-1"]`), "repeated expansion should reveal context back to the start of the file hunk").toBeVisible();
		await expect(activeCard(page).locator(`${tid("pr-walkthrough-diff-line")}[data-line-id="ctx-55"]`), "trailing context should remain hidden until expanded below").toBeHidden();
		await activeCard(page).locator(`${tid("pr-walkthrough-context-toggle")}[data-context-direction="below"]`).click();
		await expect(activeCard(page).locator(`${tid("pr-walkthrough-diff-line")}[data-line-id="ctx-51"]`), "expanding below context should reveal the next 20 trailing lines").toBeVisible();
		await activeCard(page).locator(`${tid("pr-walkthrough-context-toggle")}[data-context-direction="below"]`).click();
		await expect(activeCard(page).locator(`${tid("pr-walkthrough-diff-line")}[data-line-id="ctx-55"]`), "repeated expansion should reveal context through the end of the file hunk").toBeVisible();
		await expect(activeCard(page).getByTestId("pr-walkthrough-hunk-header"), "top/bottom file edges without controls should not render empty blue bars").toHaveCount(1);
	});

	test("diff hunk headers prefer the containing declaration scope over later visible symbols", async ({ page }) => {
		await setupWalkthrough(page, { width: 1100, height: 820 });
		await page.evaluate(async () => {
			const walkthrough = document.querySelector("pr-walkthrough-panel") as any;
			const focalIndex = 27;
			const lines = Array.from({ length: 55 }, (_, index) => ({
				id: `visible-sig-${index + 1}`,
				side: index === focalIndex ? "new" : "context",
				oldLine: index === focalIndex ? undefined : index + 1,
				newLine: index + 1,
				kind: index === focalIndex ? "add" : "context",
				text: index === focalIndex
					? "const DEFAULT_DIFF_CONTEXT_LINES = 3;"
					: index === 7
						? "const PHASES: Array<{ id: PrWalkthroughPhaseId; label: string }> = ["
						: index === 30
							? "interface SideBySidePair {"
							: `context ${index + 1}`,
			}));
			walkthrough.changeset = { baseSha: "base", headSha: "head", provider: "github", title: "Visible context fixture", filesChanged: 1, additions: 1, deletions: 0 };
			walkthrough.cards = [{
				id: "visible-signature-card",
				phaseId: "significant",
				title: "Visible signature hunk",
				summary: "This card verifies containing scope context.",
				diffBlocks: [{ id: "visible-signature-block", filePath: "src/context.ts", hunks: [{ id: "visible-signature-hunk", header: "@@ -1,55 +1,55 @@", lines }] }],
			}];
			walkthrough.status = "ready";
			await walkthrough.updateComplete;
		});

		const hunkHeader = activeCard(page).getByTestId("pr-walkthrough-hunk-header").first();
		await expect(hunkHeader.locator(".hunk-signature"), "containing declaration scope should label the blue row instead of the next visible interface").toContainText("const PHASES: Array<{ id: PrWalkthroughPhaseId; label: string }> = [");
		await expect(hunkHeader, "raw hunk ranges should still be absent from the tooltip").not.toHaveAttribute("title", /@@/);
	});

	test("diff hunk headers hide empty top-of-file context labels", async ({ page }) => {
		await setupWalkthrough(page, { width: 1100, height: 820 });
		await page.evaluate(async () => {
			const walkthrough = document.querySelector("pr-walkthrough-panel") as any;
			const focalIndex = 2;
			const lines = Array.from({ length: 35 }, (_, index) => ({
				id: `top-file-${index + 1}`,
				side: index === focalIndex ? "new" : "context",
				oldLine: index === focalIndex ? undefined : index + 1,
				newLine: index + 1,
				kind: index === focalIndex ? "add" : "context",
				text: index === focalIndex ? "const topLevelChange = true;" : `context ${index + 1}`,
			}));
			walkthrough.changeset = { baseSha: "base", headSha: "head", provider: "github", title: "Top of file fixture", filesChanged: 1, additions: 1, deletions: 0 };
			walkthrough.cards = [{
				id: "top-file-card",
				phaseId: "significant",
				title: "Top file hunk",
				summary: "This card verifies empty top-of-file context labels.",
				diffBlocks: [{ id: "top-file-block", filePath: "src/top.ts", hunks: [{ id: "top-file-hunk", header: "@@ -1,35 +1,35 @@", lines }] }],
			}];
			walkthrough.status = "ready";
			await walkthrough.updateComplete;
		});

		const firstLine = activeCard(page).locator(`${tid("pr-walkthrough-diff-line")}[data-line-id="top-file-1"]`);
		const firstHeader = activeCard(page).getByTestId("pr-walkthrough-hunk-header").first();
		await expect.poll(async () => {
			const [lineBox, headerBox] = await Promise.all([firstLine.boundingBox(), firstHeader.boundingBox()]);
			return lineBox && headerBox ? lineBox.y < headerBox.y : false;
		}, { message: "empty top-of-file context labels should be hidden instead of borrowing later symbols" }).toBe(true);
		await expect(firstHeader, "top-of-file hunk rows should not expose raw hunk ranges as tooltips").not.toHaveAttribute("title", /@@/);
	});

	test("renders right-side split comments for paired replacement rows", async ({ page }) => {
		const body = `right-side-split-comment-${Date.now()}`;
		await setupWalkthrough(page, { width: 1920, height: 1080 });
		await selectCardById(page, "significant-diff");
		await expectActiveDiffMode(page, "split");

		const rightLine = activeCard(page).locator(`${tid("pr-walkthrough-diff-line")}[data-line-id="dr-4"][data-line-side="new"]`).first();
		await expect(rightLine, "paired new-side replacement line should render in split mode").toBeVisible();
		await createCommentOnDiffLine(page, "dr-4", body);
		await expect(activeCard(page).getByTestId("pr-walkthrough-comment").filter({ hasText: body }), "right-side split line comment should render below the paired row").toBeVisible({ timeout: 5_000 });
		await expect(activeCard(page).locator(`${tid("pr-walkthrough-comment")}[data-line-id="dr-4"]`).filter({ hasText: body })).toBeVisible();
	});

	test("audit phase includes normal diff/comment behavior while keeping the final draft visible", async ({ page }) => {
		const auditLineComment = `audit-line-comment-${Date.now()}`;
		const auditCardComment = `audit-card-comment-${Date.now()}`;
		const { panel } = await setupWalkthrough(page, { width: 1920, height: 1080 });

		await completeRemainingCardsWithLikes(page);
		await expect(activeCard(page)).toHaveAttribute("data-phase-id", "audit");
		await expect(activeCard(page).getByTestId("pr-walkthrough-diff-block").first(), "audit should expose remaining-line diff blocks like other cards").toBeVisible({ timeout: 10_000 });
		await expect(activeCard(page).getByTestId("pr-walkthrough-card-comments"), "audit should keep card-level comment support").toBeVisible();
		await expect(panel.getByTestId("pr-walkthrough-audit"), "audit should preserve the final draft review surface").toBeVisible();
		await expect(panel.getByTestId("pr-walkthrough-draft")).toBeVisible();

		await createCommentOnDiffLine(page, "ar-3", auditLineComment);
		await createCardComment(page, auditCardComment);
		await expect(panel.getByTestId("pr-walkthrough-draft"), "audit line comments should feed the final draft").toContainText(auditLineComment);
		await expect(panel.getByTestId("pr-walkthrough-draft"), "audit card comments should feed the final draft").toContainText(auditCardComment);
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

		await panel.getByTestId("pr-walkthrough-prev").click();
		await expect.poll(() => activeCardId(page), {
			timeout: 5_000,
			message: "Prev should return to the disliked card so its concerns can be revised",
		}).toBe(firstCard);
		await deleteComment(page, broadConcern);
		await expect(dislike, "Deleting the last supporting comment should clear the disliked decision and disable Dislike").toBeDisabled();
		await expect(activeCard(page).locator(".decision-note"), "decision status text should not be used for selected actions").not.toContainText(/Current:/);
		await createCardComment(page, broadConcern);
		await expect(dislike).toBeEnabled();
		await dislike.click();
		await expect.poll(() => activeCardId(page), {
			timeout: 5_000,
			message: "Dislike should be available again after adding a replacement concern",
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
		await expect(panel.getByTestId("pr-walkthrough-like"), "selected decisions should be indicated by button styling").toHaveClass(/decision-selected/);
		await expect(panel.getByTestId("pr-walkthrough-like")).toHaveAttribute("aria-pressed", "true");
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

	test("fullscreen toolbar control promotes the active walkthrough tab to the wide review surface", async ({ page }) => {
		await setupWalkthrough(page, { width: 1600, height: 900 }, WALKTHROUGH_URL_COMMAND);

		const fullscreen = page.locator(`${tid("side-panel-fullscreen")}, ${tid("pr-walkthrough-fullscreen")}, button[title*="Fullscreen"]`).first();
		await expect(fullscreen, "active walkthrough tabs should expose the same fullscreen toolbar affordance as preview panes").toBeVisible({ timeout: 10_000 });
		await fullscreen.click();

		const fullscreenRoot = page.locator(`${tid("side-panel-fullscreen-root")}, ${tid("pr-walkthrough-fullscreen-root")}, .preview-fullscreen-prompt`).first();
		await expect(fullscreenRoot, "fullscreen walkthrough should render inside the preview-pane fullscreen shell").toBeVisible({ timeout: 10_000 });
		await expect(walkthroughPanel(page), "walkthrough content should remain mounted in fullscreen mode").toBeVisible();
		await expect(walkthroughPanel(page).getByTestId("pr-walkthrough-pr-link").locator("svg"), "fullscreen walkthrough GitHub button should include the GitHub mark").toBeVisible();
		await expectActiveDiffMode(page, "split");

		const collapse = page.locator(`${tid("side-panel-collapse-fullscreen")}, button[title*="Collapse preview"], button[title*="Collapse walkthrough"]`).first();
		await expect(collapse).toBeVisible();
		await collapse.click();
		await expect(page.locator(".goal-split-layout"), "collapsing fullscreen should return to chat + side-panel split layout").toBeVisible({ timeout: 10_000 });
	});

	test("open-in-new-tab toolbar control renders the same walkthrough in a standalone wide route", async ({ page, context }) => {
		const { tab } = await setupWalkthrough(page, { width: 1600, height: 900 });
		const tabId = await tab.getAttribute("data-panel-tab-id");

		const openStandalone = page.locator(`${tid("side-panel-open-in-new-tab")}, ${tid("pr-walkthrough-open-in-new-tab")}, a[title*="Open walkthrough"], button[title*="Open walkthrough"]`).first();
		await expect(openStandalone, "active walkthrough tabs should expose an open-in-new-tab toolbar affordance").toBeVisible({ timeout: 10_000 });
		const [standalone] = await Promise.all([
			context.waitForEvent("page"),
			openStandalone.click(),
		]);
		await standalone.setViewportSize({ width: 1700, height: 1000 });
		await standalone.waitForLoadState("domcontentloaded");
		await expect(standalone, "standalone URL should preserve walkthrough/tab identity").toHaveURL(/walkthrough|pr-walkthrough/);
		if (tabId) await expect(standalone.locator(`${tid("pr-walkthrough-panel-root")}[data-panel-tab-id="${tabId}"]`)).toBeVisible({ timeout: 15_000 });
		await expect(standalone.getByTestId("pr-walkthrough-standalone-topbar"), "standalone route should use PR Walkthrough chrome").toContainText("PR Walkthrough");
		await expect(standalone.getByTestId("pr-walkthrough-standalone-topbar"), "standalone route should not expose the old standalone label").not.toContainText("Standalone walkthrough");
		await expect(standalone.getByTestId("pr-walkthrough-standalone").locator(":scope > .border-b"), "standalone route should not add a duplicate title bar above the walkthrough header").toHaveCount(0);
		await expect(walkthroughPanel(standalone), "standalone tab should render the same walkthrough component").toBeVisible({ timeout: 15_000 });
		await expectActiveDiffMode(standalone, "split");
		await standalone.close();
	});

	test("slash command opens immediately, calls resolver, and applies resolved cards", async ({ page }) => {
		let releaseResolve!: () => void;
		const waitForRelease = new Promise<void>((resolve) => { releaseResolve = resolve; });
		let requestBody: Record<string, unknown> | undefined;
		await page.route("**/api/pr-walkthrough/resolve", async (route) => {
			requestBody = JSON.parse(route.request().postData() || "{}") as Record<string, unknown>;
			await waitForRelease;
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify(resolvedWalkthroughPayload("789", "Resolved Real PR")),
			});
		});

		await page.setViewportSize({ width: 1920, height: 1080 });
		await openApp(page);
		await createSessionViaUI(page);
		await sendMessage(page, "/walkthrough-pr 789");

		const root = page.getByTestId("pr-walkthrough-panel-root");
		await expect(page.locator(PANEL_TAB_SELECTOR).first(), "walkthrough tab should open before the resolver returns").toBeVisible({ timeout: 15_000 });
		await expect(root, "new resolver-backed tabs should expose loading state while resolving").toHaveAttribute("data-walkthrough-status", "loading");
		await expect.poll(() => requestBody?.prNumber, { timeout: 5_000 }).toBe("789");

		releaseResolve();
		await expect(root, "resolved payload should update the existing walkthrough render path").toHaveAttribute("data-walkthrough-status", "ready", { timeout: 10_000 });
		await expect(page.locator(".goal-preview-panel .goal-tab-pill.goal-tab-pill--active[data-panel-tab-kind='walkthrough']").first()).toHaveAttribute("data-panel-tab-id", /github%3ASuuBro%2Fbobbit%23789%3Aabc1234/);
		await expect(walkthroughPanel(page).locator(".title"), "header should switch from launch placeholder to resolved PR metadata").toContainText("PR #789: Resolved Real PR");
		await expect(activeCard(page).getByTestId("pr-walkthrough-card-title"), "cards should come from the resolver response").toContainText("Resolved logical card");
	});

	test("URL launches expose an external GitHub/PR link in the walkthrough header", async ({ page }) => {
		const { panel } = await setupWalkthrough(page, { width: 1920, height: 1080 }, WALKTHROUGH_URL_COMMAND);

		await expectPrototypeHeader(panel, {
			pr: /#637|PR\s*637/i,
			title: /bobbit|walkthrough|shrink initial bundle/i,
			href: WALKTHROUGH_URL,
		});
	});

	test("Git Status Widget walkthrough metadata opens a tab with PR title and GitHub link", async ({ page }) => {
		let requestBody: Record<string, unknown> | undefined;
		await page.route("**/api/pr-walkthrough/resolve", async (route) => {
			requestBody = JSON.parse(route.request().postData() || "{}") as Record<string, unknown>;
			const payload = resolvedWalkthroughPayload("638", "Widget Launched Walkthrough");
			payload.changeset.filesChanged = 2;
			payload.changeset.additions = 17;
			payload.changeset.deletions = 9;
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify(payload),
			});
		});

		await page.setViewportSize({ width: 1920, height: 1080 });
		await openApp(page);
		await createSessionViaUI(page);

		await page.evaluate(() => {
			document.dispatchEvent(new CustomEvent("open-pr-walkthrough", {
				bubbles: true,
				composed: true,
				detail: {
					prNumber: 638,
					prUrl: "https://github.com/SuuBro/bobbit/pull/638",
					prTitle: "Widget Launched Walkthrough",
					baseSha: "fixture-base",
					headSha: "fixture-head",
					insertionsVsPrimary: 17,
					deletionsVsPrimary: 9,
					statusFiles: [{ file: "src/app/pr-walkthrough.ts", status: "M" }, { file: "src/ui/components/pr-walkthrough/fixtures.ts", status: "M" }],
				},
			}));
		});

		const { panel } = await expectWalkthroughOpened(page);
		await expect(page.locator(PANEL_TAB_SELECTOR).first().locator(".goal-tab-pill-label"), "walkthrough tab should use a compact PR label").toHaveText("PR: #638");
		await expectPrototypeHeader(panel, {
			pr: /PR\s*#?638/i,
			title: /Widget Launched Walkthrough/i,
			href: "https://github.com/SuuBro/bobbit/pull/638",
		});
		await expect(page.getByTestId("pr-walkthrough-pr-link"), "GitHub PR link should only appear in the walkthrough header, not the tab strip").toHaveCount(1);
		await expect(panel.getByTestId("pr-walkthrough-stat-files"), "Git Status launches should thread available file counts into walkthrough stats").toContainText("2 files");
		await expect(panel.getByTestId("pr-walkthrough-stat-additions"), "Git Status insertionsVsPrimary should become walkthrough additions").toContainText("+17");
		await expect(panel.getByTestId("pr-walkthrough-stat-deletions"), "Git Status deletionsVsPrimary should become walkthrough deletions").toContainText("-9");
		await expect.poll(() => requestBody?.prNumber, { timeout: 5_000 }).toBe("638");
		expect(requestBody?.baseSha, "PR walkthroughs should use GitHub's PR diff by default, not locally supplied base refs").toBeUndefined();
		expect(requestBody?.headSha, "PR walkthroughs should use GitHub's PR diff by default, not locally supplied head refs").toBeUndefined();
	});

	test("switching walkthrough tabs with no persisted state resets per-card UI state", async ({ page }) => {
		const leakedConcern = `should-not-leak-${Date.now()}`;
		const { panel } = await setupWalkthrough(page, { width: 1920, height: 1080 });
		const firstCard = await activeCardId(page);

		await createCardComment(page, leakedConcern);
		await panel.getByTestId("pr-walkthrough-like").click();
		await expect.poll(() => activeCardId(page), {
			timeout: 5_000,
			message: "first walkthrough should move away from the initial card before opening another PR",
		}).not.toBe(firstCard);

		await sendMessage(page, "/walkthrough-pr 456");
		const activeTab = page.locator(".goal-preview-panel .goal-tab-pill.goal-tab-pill--active[data-panel-tab-kind='walkthrough']").first();
		await expect(activeTab, "second walkthrough tab should become active").toHaveAttribute("data-panel-tab-id", /456/, { timeout: 10_000 });
		await expect(walkthroughPanel(page).locator(".title"), "second tab should render its own changeset metadata").toContainText("PR #456");
		await expect.poll(() => activeCardId(page), {
			timeout: 5_000,
			message: "new walkthrough tab without localStorage should start at the first card",
		}).toBe(firstCard);
		await expect(walkthroughPanel(page).getByTestId("pr-walkthrough-comment").filter({ hasText: leakedConcern }), "comments from PR #123 must not leak into PR #456").toBeHidden();
		await expect(walkthroughPanel(page).getByTestId("pr-walkthrough-dislike").first(), "leaked comments must not enable Dislike on the new tab").toBeDisabled();
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
