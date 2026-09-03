import { test, expect } from "../../../tests/support/harnesses/browser/gateway-harness.js";
import type { Page } from "@playwright/test";
import { openApp, sendMessage, createGoalAssistantViaUI } from "../../../tests/support/helpers/browser/e2e/ui-helpers.js";

/**
 * E2E coverage for the complete proposal-comment integration path.
 *
 * The expensive goal-assistant and proposal lifecycle is shared within two
 * compatible journeys. Pure store formatting/keying remains covered by
 * proposal-annotations.unit.test.ts; these journeys retain the real rendered
 * proposal, annotator/highlight, popover, feedback submission, proposal update,
 * and reload boundaries.
 */
async function openGoalAssistantProposal(page: Page) {
	test.setTimeout(90_000);
	await openApp(page);
	await createGoalAssistantViaUI(page, { timeout: 60_000 });
	const textarea = page.locator("textarea").first();
	await expect(textarea).toBeVisible({ timeout: 10_000 });
	await sendMessage(page, "Please create a GOAL_PROPOSAL for testing");
	const titleInput = page.locator("input[placeholder='Goal title']").first();
	await expect(titleInput).toBeVisible({ timeout: 20_000 });
	await expect(titleInput).toHaveValue("E2E Test Goal", { timeout: 15_000 });
	const goalPanel = page.locator('[data-panel="goal-proposal"]').first();
	await expect(goalPanel).toBeVisible({ timeout: 10_000 });
	await findProposalQuote(page);
	return goalPanel;
}

async function findProposalQuote(
	page: Page,
	preferredQuotes: string[] = [
		"test goal",
		"goal creation",
		"validates",
		"assistant flow",
		"proposal",
	],
): Promise<string> {
	const handle = await page.waitForFunction(
		(preferred) => {
			const content = document.querySelector(
				"commentable-markdown review-document .review-document-content",
			);
			const text = content?.textContent ?? "";
			if (!text.trim() || /no spec content yet/i.test(text)) return null;
			const lower = text.toLowerCase();
			for (const quote of preferred) {
				const idx = lower.indexOf(quote.toLowerCase());
				if (idx >= 0) return text.slice(idx, idx + quote.length);
			}
			return text.match(/[A-Za-z0-9][A-Za-z0-9'’_-]{2,}(?:\s+[A-Za-z0-9][A-Za-z0-9'’_-]{2,}){0,3}/)?.[0] ?? null;
		},
		preferredQuotes,
		{ timeout: 10_000 },
	);
	const quote = await handle.jsonValue();
	if (typeof quote !== "string" || !quote) throw new Error("No usable proposal quote found");
	return quote;
}

/** Inject the post-popover state used to exercise update/reload boundaries. */
async function injectAnnotation(
	page: Page,
	opts: { quote: string; comment: string; bucket?: string },
): Promise<void> {
	const { quote, comment, bucket = "proposal:goal" } = opts;
	await page.evaluate(
		({ quote, comment, bucket }) => {
			const sid = (window as any).bobbitState?.selectedSessionId as string;
			if (!sid) throw new Error("no active session id");
			const cm: any = document.querySelector("commentable-markdown");
			if (!cm) throw new Error("no <commentable-markdown> in DOM");
			const rd: any = cm.querySelector("review-document");
			if (!rd?.backend) throw new Error("review-document.backend missing");
			const md = (window as any).bobbitState?.activeProposals?.goal?.fields?.spec ?? "";
			const start = md.indexOf(quote);
			rd.backend.add(
				{ sessionId: sid, bucket },
				{
					id: `e2e-ann-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
					quote,
					comment,
					start: start >= 0 ? start : 0,
					end: start >= 0 ? start + quote.length : quote.length,
				},
			);
			cm.dispatchEvent(new CustomEvent("annotation-change", {
				detail: { count: rd.backend.count({ sessionId: sid, bucket }) },
				bubbles: true,
				composed: true,
			}));
		},
		{ quote, comment, bucket },
	);
}

/**
 * Select rendered proposal text and enter ReviewDocument's production
 * selection handler. Keeping the real DOM Range makes popover positioning,
 * overlap detection, and keyboard handling observable without relying on the
 * browser-specific Recogito mouseup event bridge.
 */
async function openSelectionPopover(page: Page, quote: string): Promise<void> {
	await page.evaluate((selectedQuote) => {
		const rd: any = document
			.querySelector("commentable-markdown")
			?.querySelector("review-document");
		if (!rd) throw new Error("no <review-document>");
		const content: HTMLElement | null = rd.querySelector(".review-document-content");
		const fullText = content?.textContent ?? "";
		const start = fullText.indexOf(selectedQuote);
		if (start < 0) throw new Error(`could not find ${selectedQuote} in document`);
		const end = start + selectedQuote.length;
		const walker = document.createTreeWalker(content!, NodeFilter.SHOW_TEXT);
		let node: Node | null = walker.nextNode();
		let offset = 0;
		let startNode: Text | null = null;
		let startOffset = 0;
		let endNode: Text | null = null;
		let endOffset = 0;
		while (node) {
			const text = node as Text;
			if (!startNode && offset + text.data.length >= start) {
				startNode = text;
				startOffset = start - offset;
			}
			if (offset + text.data.length >= end) {
				endNode = text;
				endOffset = end - offset;
				break;
			}
			offset += text.data.length;
			node = walker.nextNode();
		}
		if (!startNode || !endNode) throw new Error("could not build proposal selection range");
		const range = document.createRange();
		range.setStart(startNode, startOffset);
		range.setEnd(endNode, endOffset);
		const selection = window.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);
		rd._handleSelection({
			id: `e2e-selection-${Date.now()}`,
			target: { selector: [{ quote: selectedQuote, start, end }] },
		});
	}, quote);
}

async function clickFirstRenderedHighlight(page: Page): Promise<void> {
	const pointHandle = await page.waitForFunction(() => {
		const annotations = Array.from(document.querySelectorAll<HTMLElement>(".r6o-annotation"));
		for (const annotation of annotations) {
			if (!annotation.isConnected) continue;
			annotation.scrollIntoView({ block: "center", inline: "nearest" });
			const style = window.getComputedStyle(annotation);
			if (style.display === "none" || style.visibility === "hidden") continue;
			const rect = Array.from(annotation.getClientRects()).find((entry) => entry.width > 0 && entry.height > 0);
			if (!rect) continue;
			return {
				x: Math.min(window.innerWidth - 1, Math.max(1, rect.left + rect.width / 2)),
				y: Math.min(window.innerHeight - 1, Math.max(1, rect.top + rect.height / 2)),
			};
		}
		return null;
	}, { timeout: 5_000 });
	const point = await pointHandle.jsonValue() as { x: number; y: number };
	await page.mouse.click(point.x, point.y);
}

async function showHoverChip(page: Page): Promise<void> {
	await page.waitForFunction(() => {
		const annotation = document.querySelector(".r6o-annotation") as HTMLElement | null;
		if (!annotation) return false;
		const rect = annotation.getBoundingClientRect();
		return rect.width > 0 && rect.height > 0;
	}, { timeout: 5_000 });
	await page.evaluate(() => {
		const rd: any = document
			.querySelector("commentable-markdown")
			?.querySelector("review-document");
		const annotation = rd?.querySelector(".r6o-annotation");
		const id = annotation?.getAttribute("data-annotation");
		if (!rd || !annotation || !id) throw new Error("no rendered annotation to hover");
		rd._showHoverChip(id, annotation);
	});
}

async function addComment(page: Page, quote: string, comment: string): Promise<void> {
	await openSelectionPopover(page, quote);
	const popover = page.locator("annotation-popover[open]");
	await expect(popover).toBeVisible({ timeout: 5_000 });
	await popover.locator("textarea").fill(comment);
	await popover.getByRole("button", { name: "Add", exact: true }).click();
	await expect(popover).toHaveCount(0, { timeout: 3_000 });
}

test.describe("Inline comments on goal proposal panel", () => {
	test("comment lifecycle — create, edit, delete, and submit feedback", async ({ page }) => {
		const panel = await openGoalAssistantProposal(page);
		const quote = await findProposalQuote(page);
		const badge = panel.locator('[data-testid="proposal-comment-count"]');
		const popover = page.locator("annotation-popover[open]");

		await test.step("new-comment popover exposes accessible controls and keyboard cancellation", async () => {
			await expect(badge).toHaveCount(0);
			await openSelectionPopover(page, quote);
			await expect(popover).toBeVisible({ timeout: 5_000 });
			const commentBox = popover.getByRole("textbox", { name: "Add your comment..." });
			await expect(commentBox).toBeFocused({ timeout: 3_000 });
			await expect(popover.getByRole("button", { name: "Copy", exact: true })).toBeVisible();
			await expect(popover.getByRole("button", { name: "Cancel", exact: true })).toBeVisible();
			await expect(popover.getByRole("button", { name: "Add", exact: true })).toBeVisible();
			await expect(popover.getByRole("button", { name: "Delete", exact: true })).toHaveCount(0);
			await commentBox.press("Escape");
			await expect(popover).toHaveCount(0, { timeout: 3_000 });
			await expect(page.locator("message-editor textarea")).toBeFocused({ timeout: 3_000 });
		});

		await test.step("create a comment through the real popover and rendered anchor", async () => {
			await openSelectionPopover(page, quote);
			await expect(popover).toBeVisible({ timeout: 5_000 });
			await popover.locator("textarea").fill("Make this clearer");
			await popover.locator("textarea").press("Enter");
			await expect(popover).toHaveCount(0, { timeout: 3_000 });
			await expect(badge).toContainText("1 comment", { timeout: 5_000 });
			await expect(page.locator(".r6o-annotation").first()).toBeVisible({ timeout: 5_000 });
		});

		await test.step("clicking the highlight opens edit mode with Save and Delete", async () => {
			await clickFirstRenderedHighlight(page);
			await expect(popover).toBeVisible({ timeout: 5_000 });
			await expect(popover.locator("textarea")).toHaveValue("Make this clearer");
			await expect(popover.getByRole("button", { name: "Save", exact: true })).toBeVisible();
			await expect(popover.getByRole("button", { name: "Delete", exact: true })).toBeVisible();
			await popover.locator("textarea").fill("Edited comment");
			await popover.locator("textarea").press("Enter");
			await expect(popover).toHaveCount(0, { timeout: 3_000 });
			await expect(badge).toContainText("1 comment");
		});

		await test.step("overlapping selection edits instead of stacking", async () => {
			await openSelectionPopover(page, quote);
			await expect(popover).toBeVisible({ timeout: 3_000 });
			await expect(popover.locator("textarea")).toHaveValue("Edited comment");
			await popover.locator("textarea").fill("Overlap-updated comment");
			await popover.getByRole("button", { name: "Save", exact: true }).click();
			await expect(badge, "overlapping re-selection must keep exactly one annotation").toContainText("1 comment");
		});

		await test.step("edit-mode Delete removes the anchored comment", async () => {
			await clickFirstRenderedHighlight(page);
			await expect(popover).toBeVisible({ timeout: 3_000 });
			await popover.getByRole("button", { name: "Delete", exact: true }).click();
			await expect(badge).toHaveCount(0, { timeout: 3_000 });
			await expect(page.locator(".r6o-annotation")).toHaveCount(0, { timeout: 3_000 });
		});

		await test.step("hover actions expose Edit and delete the comment", async () => {
			await addComment(page, quote, "Delete from hover actions");
			await expect(badge).toContainText("1 comment", { timeout: 5_000 });
			await showHoverChip(page);
			const hoverChip = page.locator(".review-hover-chip");
			await expect(hoverChip.getByRole("button", { name: "Edit", exact: true })).toBeVisible();
			const deleteButton = hoverChip.getByRole("button", { name: "Delete", exact: true });
			await expect(deleteButton).toBeVisible();
			await deleteButton.click();
			await expect(badge).toHaveCount(0, { timeout: 3_000 });
			await expect(page.locator(".r6o-annotation")).toHaveCount(0, { timeout: 3_000 });
		});

		await test.step("Send feedback crosses the agent submission boundary and clears the badge", async () => {
			await addComment(page, quote, "Final feedback comment");
			await expect(badge).toContainText("1 comment", { timeout: 5_000 });
			const sendButton = panel.locator('[data-testid="proposal-send-feedback"]');
			await expect(sendButton).toBeVisible();
			await page.evaluate(() => {
				const remoteAgent = (window as any).bobbitState?.remoteAgent;
				if (!remoteAgent) throw new Error("remote agent missing");
				(window as any).__capturedPrompts = [];
				const originalPrompt = remoteAgent.prompt.bind(remoteAgent);
				remoteAgent.prompt = (text: string, ...rest: any[]) => {
					(window as any).__capturedPrompts.push(text);
					return originalPrompt(text, ...rest);
				};
			});
			await sendButton.click();
			const captured = await page.evaluate(() => (window as any).__capturedPrompts as string[]);
			expect(captured).toHaveLength(1);
			expect(captured[0]).toContain("Feedback on proposal");
			expect(captured[0]).toContain(`"${quote}"`);
			expect(captured[0]).toContain("Final feedback comment");
			await expect(badge).toHaveCount(0);
		});
	});

	test("comment durability — proposal rewrite and reload clear ephemeral annotations", async ({ page }) => {
		const panel = await openGoalAssistantProposal(page);
		const initialQuote = await findProposalQuote(page);
		const badge = panel.locator('[data-testid="proposal-comment-count"]');

		await test.step("a real proposal update clears stale offsets and announces the change", async () => {
			await injectAnnotation(page, { quote: initialQuote, comment: "Clear on rewrite" });
			await expect(badge).toContainText("1 comment", { timeout: 5_000 });
			await page.evaluate(() => {
				const remoteAgent = (window as any).bobbitState?.remoteAgent;
				if (!remoteAgent || typeof remoteAgent.onProposal !== "function") {
					throw new Error("remoteAgent.onProposal handler missing");
				}
				const state = (window as any).bobbitState;
				const previous = state?.activeProposals?.goal?.fields ?? {};
				const nextRevision = (state?.activeProposals?.goal?.rev ?? 0) + 1;
				remoteAgent.onProposal(
					"goal",
					{ ...previous, spec: "Completely rewritten spec body for the proposal." },
					false,
					nextRevision,
				);
			});
			const toast = page.locator('[data-testid="proposal-toast"]');
			await expect(toast).toBeVisible({ timeout: 5_000 });
			await expect(toast).toContainText("comments cleared");
			await expect(badge).toHaveCount(0);
		});

		await test.step("reload creates a fresh annotation cache for the reattached session", async () => {
			await injectAnnotation(page, {
				quote: "Completely rewritten spec body",
				comment: "Ephemeral before reload",
			});
			await expect(badge).toContainText("1 comment", { timeout: 5_000 });
			await page.reload();
			await expect(page.locator("button").filter({ hasText: "Settings" }).first()).toBeVisible({ timeout: 20_000 });
			await page.waitForFunction(
				() => !!(window as any).bobbitState?.selectedSessionId,
				null,
				{ timeout: 15_000 },
			);
			const panelAfter = page.locator('[data-panel="goal-proposal"]').first();
			await expect(panelAfter.locator('[data-testid="proposal-comment-count"]')).toHaveCount(0, { timeout: 10_000 });
		});
	});
});
