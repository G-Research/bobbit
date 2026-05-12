/**
 * E2E — Inline comments on goal proposal panels.
 *
 * Covers (per docs/design/proposal-inline-comments.md §8):
 *   1. Happy path — add an annotation, badge appears, click Send feedback,
 *      chat input receives a composed message containing the quote+comment.
 *   2. proposal_update clearing — when a new proposal body arrives, the
 *      annotation cache is cleared and the "comments cleared" toast appears.
 *   3. Reload ephemerality — annotations do NOT survive a page reload.
 *
 * We can't reliably drive selection → text-annotator → popover from
 * Playwright across all browsers (the annotator uses native Selection API
 * + custom events). So we simulate the post-popover state by injecting
 * directly into `proposalBackend` and dispatching `annotation-change`,
 * which is exactly what the popover does on submit.
 */
import { test, expect } from "../gateway-harness.js";
import type { Page } from "@playwright/test";
import { openApp, sendMessage } from "./ui-helpers.js";

/**
 * Open the goal-assistant panel (which is the commentable goal preview
 * — the regular-session goal-proposal panel doesn't pass commentable:true).
 */
async function openGoalAssistantProposal(page: Page) {
	test.setTimeout(90_000);
	await openApp(page);
	const newGoalBtn = page.locator("button[title='New goal (Alt+G)']").first();
	await expect(newGoalBtn).toBeVisible({ timeout: 10_000 });
	await expect(newGoalBtn).toBeEnabled({ timeout: 10_000 });
	const sessionCreated = page.waitForResponse(
		(resp) =>
			resp.url().includes("/api/sessions") &&
			resp.request().method() === "POST" &&
			resp.ok(),
		{ timeout: 60_000 },
	);
	await newGoalBtn.click();
	await sessionCreated;
	await page.waitForURL(/#\/session\//, { timeout: 10_000 });
	const textarea = page.locator("textarea").first();
	await expect(textarea).toBeVisible({ timeout: 10_000 });
	await sendMessage(page, "Please create a GOAL_PROPOSAL for testing");
	const titleInput = page.locator("input[placeholder='Goal title']").first();
	await expect(titleInput).toBeVisible({ timeout: 20_000 });
	await expect(titleInput).toHaveValue("E2E Test Goal", { timeout: 15_000 });
	const goalPanel = page.locator('[data-panel="goal-proposal"]').first();
	await expect(goalPanel).toBeVisible({ timeout: 10_000 });
	return goalPanel;
}

/**
 * Inject an annotation via the proposalBackend module and fire the
 * `annotation-change` event so the panel updates `_goalAnnCount`.
 */
async function injectAnnotation(
	page: Page,
	opts: { quote: string; comment: string; bucket?: string } = {
		quote: "test goal created",
		comment: "Make it clearer",
	},
): Promise<void> {
	const { quote, comment, bucket = "proposal:goal" } = opts;
	await page.evaluate(
		({ quote, comment, bucket }) => {
			const sid = (window as any).bobbitState?.selectedSessionId as string;
			if (!sid) throw new Error("no active session id");
			// Reach the proposalBackend through the live <commentable-markdown>
			// element's <review-document> child (its `backend` prop).
			const cm: any = document.querySelector("commentable-markdown");
			if (!cm) throw new Error("no <commentable-markdown> in DOM");
			const rd: any = cm.querySelector("review-document");
			if (!rd) throw new Error("no <review-document> inside <commentable-markdown>");
			const backend = rd.backend;
			if (!backend) throw new Error("review-document.backend missing");
			const md =
				(window as any).bobbitState?.activeProposals?.goal?.fields?.spec ?? "";
			const start = md.indexOf(quote);
			const ann = {
				id: `e2e-ann-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
				quote,
				comment,
				start: start >= 0 ? start : 0,
				end: start >= 0 ? start + quote.length : quote.length,
			};
			backend.add({ sessionId: sid, bucket }, ann);
			// Fire the same event the popover-submit path emits.
			cm.dispatchEvent(
				new CustomEvent("annotation-change", {
					detail: { count: backend.count({ sessionId: sid, bucket }) },
					bubbles: true,
					composed: true,
				}),
			);
		},
		{ quote, comment, bucket },
	);
}

test.describe("Inline comments on goal proposal panel", () => {
	test("happy path — annotate, send feedback, chat receives composed message", async ({
		page,
	}) => {
		const panel = await openGoalAssistantProposal(page);

		// Sanity: badge absent before any annotation.
		await expect(panel.locator('[data-testid="proposal-comment-count"]')).toHaveCount(
			0,
		);

		// Inject an annotation as if the user had completed the popover flow.
		await injectAnnotation(page, {
			quote: "test goal",
			comment: "Make this clearer",
		});

		// Badge appears (count == 1).
		const badge = panel.locator('[data-testid="proposal-comment-count"]');
		await expect(badge).toBeVisible({ timeout: 5_000 });
		await expect(badge).toContainText("1 comment");

		// Send-feedback button visible (only when count > 0).
		const sendBtn = panel.locator('[data-testid="proposal-send-feedback"]');
		await expect(sendBtn).toBeVisible({ timeout: 5_000 });

		// Capture the agent prompt that's about to fire by stubbing the
		// remoteAgent.prompt method, since the mock agent will not reply
		// in a way that we can assert structurally on transcript content.
		await page.evaluate(() => {
			const ra = (window as any).bobbitState?.remoteAgent;
			if (!ra) return;
			(window as any).__capturedPrompts = [];
			const orig = ra.prompt.bind(ra);
			ra.prompt = (text: string, ...rest: any[]) => {
				(window as any).__capturedPrompts.push(text);
				return orig(text, ...rest);
			};
		});

		await sendBtn.click();

		// Composed feedback flowed through remoteAgent.prompt with the
		// quote and comment present.
		const captured = await page.evaluate(
			() => (window as any).__capturedPrompts as string[],
		);
		expect(captured.length).toBeGreaterThanOrEqual(1);
		expect(captured[0]).toContain("Feedback on proposal");
		expect(captured[0]).toContain('"test goal"');
		expect(captured[0]).toContain("Make this clearer");

		// Badge cleared after send.
		await expect(panel.locator('[data-testid="proposal-comment-count"]')).toHaveCount(
			0,
		);
	});

	test("proposal_update clears annotations and shows toast", async ({ page }) => {
		const panel = await openGoalAssistantProposal(page);
		await injectAnnotation(page);
		await expect(panel.locator('[data-testid="proposal-comment-count"]')).toBeVisible(
			{ timeout: 5_000 },
		);

		// Drive the unified onProposal callback with a rewritten spec body.
		// This exercises the same path a real proposal_update WS frame takes.
		await page.evaluate(() => {
			const ra = (window as any).bobbitState?.remoteAgent;
			if (!ra || typeof ra.onProposal !== "function") {
				throw new Error("remoteAgent.onProposal handler missing");
			}
			const prev = (window as any).bobbitState?.activeProposals?.goal?.fields ?? {};
			const nextRev = ((window as any).bobbitState?.activeProposals?.goal?.rev ?? 0) + 1;
			ra.onProposal(
				"goal",
				{ ...prev, spec: "Completely rewritten spec body for the proposal." },
				false,
				nextRev,
			);
		});

		// Toast shows.
		const toast = page.locator('[data-testid="proposal-toast"]');
		await expect(toast).toBeVisible({ timeout: 5_000 });
		await expect(toast).toContainText("comments cleared");

		// Badge gone.
		await expect(panel.locator('[data-testid="proposal-comment-count"]')).toHaveCount(
			0,
		);
	});

	// ------------------------------------------------------------------
	// Bug-repro tests (see goal: fix-propos-190338d6).
	//
	// These EXPECT TO FAIL on current HEAD — they pin the lifecycle UX
	// regressions called out in the Issue Analysis gate:
	//   1. Clicking an existing highlight does NOT reopen the popover in
	//      edit mode with the existing comment prefilled.
	//   2. Re-selecting text that overlaps an existing annotation stacks a
	//      new annotation on top instead of editing the existing one.
	//   3. Primary action label is hard-coded "Submit" — should read "Add"
	//      for new comments and "Save" when editing.
	//   4. Popover in edit mode lacks an in-place delete affordance.
	//
	// They drive the lifecycle programmatically by reaching into the live
	// <review-document> internals (`backend`, `_annotator`, `_handleSelection`,
	// `_annotations`) — same approach as `injectAnnotation` above. Driving
	// real text-annotator selection across browsers is too flaky for E2E.
	// ------------------------------------------------------------------

	/**
	 * Seed an annotation through both the backend AND the underlying
	 * text-annotator so a real `.r6o-annotation` span appears in the DOM
	 * and is clickable. Returns the annotation id used.
	 */
	async function seedAnnotationWithHighlight(
		page: Page,
		opts: { quote: string; comment: string; bucket?: string },
	): Promise<string> {
		return page.evaluate(
			({ quote, comment, bucket }) => {
				const sid = (window as any).bobbitState?.selectedSessionId as string;
				if (!sid) throw new Error("no active session id");
				const cm: any = document.querySelector("commentable-markdown");
				if (!cm) throw new Error("no <commentable-markdown> in DOM");
				const rd: any = cm.querySelector("review-document");
				if (!rd) throw new Error("no <review-document>");
				const backend = rd.backend;
				const content: HTMLElement | null = rd.querySelector(
					".review-document-content",
				);
				const fullText = content?.textContent ?? "";
				const start = fullText.indexOf(quote);
				if (start < 0) throw new Error(`quote not found in document: ${quote}`);
				const end = start + quote.length;
				const id = `e2e-seeded-${Date.now()}-${Math.random()
					.toString(36)
					.slice(2, 6)}`;
				const ann = { id, quote, comment, start, end, prefix: "", suffix: "" };
				backend.add({ sessionId: sid, bucket }, ann);
				rd._annotations = backend.get({ sessionId: sid, bucket });
				// Build a real Range that actually covers the quote in the rendered
				// DOM — text-annotator's SPANS renderer needs this to wrap the text
				// nodes. Passing an empty `document.createRange()` produces an
				// invisible 0-width overlay span the user can never click.
				const walker = document.createTreeWalker(
					content!,
					NodeFilter.SHOW_TEXT,
				);
				let node: Node | null = walker.nextNode();
				let acc = 0;
				let sn: Text | null = null;
				let so = 0;
				let en: Text | null = null;
				let eo = 0;
				while (node) {
					const t = node as Text;
					const len = t.data.length;
					if (!sn && acc + len >= start) {
						sn = t;
						so = start - acc;
					}
					if (acc + len >= end) {
						en = t;
						eo = end - acc;
						break;
					}
					acc += len;
					node = walker.nextNode();
				}
				const realRange = document.createRange();
				if (sn && en) {
					realRange.setStart(sn, so);
					realRange.setEnd(en, eo);
				}
				try {
					rd._annotator?.addAnnotation({
						id,
						bodies: [
							{
								id: `${id}-body`,
								annotation: id,
								purpose: "commenting",
								value: comment,
							},
						],
						target: {
							annotation: id,
							selector: [{ quote, start, end, range: realRange }],
						},
					});
				} catch (e) {
					throw new Error(
						"annotator.addAnnotation failed: " + (e as Error).message,
					);
				}
				cm.dispatchEvent(
					new CustomEvent("annotation-change", {
						detail: { count: backend.count({ sessionId: sid, bucket }) },
						bubbles: true,
						composed: true,
					}),
				);
				return id;
			},
			{ quote: opts.quote, comment: opts.comment, bucket: opts.bucket ?? "proposal:goal" },
		);
	}

	test("BUG: clicking an existing highlight reopens popover prefilled", async ({
		page,
	}) => {
		await openGoalAssistantProposal(page);

		// Seed a real annotation + highlight span.
		await seedAnnotationWithHighlight(page, {
			quote: "test goal",
			comment: "Make this clearer",
		});

		const highlight = page.locator(".r6o-annotation").first();
		await expect(highlight).toBeVisible({ timeout: 5_000 });

		// User clicks the visible position of the highlighted text. This
		// dispatches a real mouse click at those screen coords — which is
		// what a user actually does, vs. dispatchEvent which bypasses any
		// pointer-event layering the bug would otherwise mask.
		// Wait for the annotator-rendered span to have a real layout box.
		// `toBeVisible` can resolve before the highlight overlay has been
		// positioned, leaving boundingBox() returning null.
		await page.waitForFunction(() => {
			const el = document.querySelector(".r6o-annotation") as HTMLElement | null;
			if (!el) return false;
			const r = el.getBoundingClientRect();
			return r.width > 0 && r.height > 0;
		}, { timeout: 5_000 });
		const box = await highlight.boundingBox();
		if (!box) throw new Error(".r6o-annotation has no bounding box");
		await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

		// Popover must open with the existing comment prefilled in the textarea.
		const popover = page.locator("annotation-popover[open]");
		await expect(
			popover,
			"clicking a highlight must open the annotation popover",
		).toBeVisible({ timeout: 5_000 });
		const textareaValue = await popover
			.locator("textarea")
			.inputValue();
		expect(
			textareaValue,
			"clicking highlight must prefill textarea with existing comment",
		).toBe("Make this clearer");
	});

	test("BUG: re-selecting overlapping text edits the existing annotation, does not stack", async ({
		page,
	}) => {
		const panel = await openGoalAssistantProposal(page);

		// Seed: an annotation on "test goal" with comment "original".
		await seedAnnotationWithHighlight(page, {
			quote: "test goal",
			comment: "original comment",
		});

		await expect(
			panel.locator('[data-testid="proposal-comment-count"]'),
		).toContainText("1 comment", { timeout: 5_000 });

		// Now simulate the user re-selecting OVERLAPPING text ("test")
		// and hitting the popover. This routes through `_handleSelection`,
		// which is the same entry point Recogito's `createAnnotation`
		// event hits on mouseup.
		await page.evaluate(() => {
			const rd: any = document
				.querySelector("commentable-markdown")
				?.querySelector("review-document");
			if (!rd) throw new Error("no <review-document>");
			const content: HTMLElement | null = rd.querySelector(
				".review-document-content",
			);
			const fullText = content?.textContent ?? "";
			const start = fullText.indexOf("test");
			if (start < 0) throw new Error("could not find 'test' in document");
			const end = start + "test".length;
			// Place a real selection so `_handleSelection` can read a range
			// rect from window.getSelection() (it reads `sel.getRangeAt(0)`).
			const walker = document.createTreeWalker(content!, NodeFilter.SHOW_TEXT);
			let node: Node | null = walker.nextNode();
			let acc = 0;
			let startNode: Text | null = null;
			let startOffset = 0;
			let endNode: Text | null = null;
			let endOffset = 0;
			while (node) {
				const t = node as Text;
				const len = t.data.length;
				if (!startNode && acc + len >= start) {
					startNode = t;
					startOffset = start - acc;
				}
				if (acc + len >= end) {
					endNode = t;
					endOffset = end - acc;
					break;
				}
				acc += len;
				node = walker.nextNode();
			}
			if (startNode && endNode) {
				const range = document.createRange();
				range.setStart(startNode, startOffset);
				range.setEnd(endNode, endOffset);
				const sel = window.getSelection();
				sel?.removeAllRanges();
				sel?.addRange(range);
			}
			rd._handleSelection({
				id: `overlap-${Date.now()}`,
				target: {
					selector: [{ quote: "test", start, end }],
				},
			});
		});

		// Popover must open prefilled with the EXISTING comment — the
		// overlap must be recognised as an edit, not a brand-new annotation.
		const popover = page.locator("annotation-popover[open]");
		await expect(popover).toBeVisible({ timeout: 3_000 });
		const prefilled = await popover.locator("textarea").inputValue();
		expect(
			prefilled,
			"overlapping re-selection must prefill textarea with existing comment",
		).toBe("original comment");

		// Save through the popover with new text.
		await popover.locator("textarea").fill("updated comment");
		await popover.locator(".review-popover-submit").click();

		// Count must NOT have stacked — still exactly 1 annotation.
		await expect(
			panel.locator('[data-testid="proposal-comment-count"]'),
			"overlapping re-selection must NOT add a second annotation",
		).toContainText("1 comment", { timeout: 3_000 });
	});

	test("BUG: new-comment popover primary action reads 'Add', edit-mode reads 'Save'", async ({
		page,
	}) => {
		await openGoalAssistantProposal(page);

		// 1. Drive a brand-new selection — popover opens in create mode.
		await page.evaluate(() => {
			const rd: any = document
				.querySelector("commentable-markdown")
				?.querySelector("review-document");
			if (!rd) throw new Error("no <review-document>");
			const content: HTMLElement | null = rd.querySelector(
				".review-document-content",
			);
			const fullText = content?.textContent ?? "";
			const start = fullText.indexOf("validates");
			const end = start + "validates".length;
			rd._handleSelection({
				id: `new-${Date.now()}`,
				target: { selector: [{ quote: "validates", start, end }] },
			});
		});
		const popover = page.locator("annotation-popover[open]");
		await expect(popover).toBeVisible({ timeout: 3_000 });
		const createLabel = await popover
			.locator(".review-popover-submit")
			.textContent();
		expect(
			createLabel?.trim(),
			"new-comment popover primary action should read 'Add'",
		).toBe("Add");

		// Cancel to close.
		await popover.locator(".review-popover-cancel").click();
		await expect(popover).toHaveCount(0, { timeout: 3_000 });

		// 2. Seed + click highlight — popover opens in edit mode.
		await seedAnnotationWithHighlight(page, {
			quote: "test goal",
			comment: "existing",
		});
		await page.locator(".r6o-annotation").first().dispatchEvent("click");
		await expect(popover).toBeVisible({ timeout: 3_000 });
		const editLabel = await popover
			.locator(".review-popover-submit")
			.textContent();
		expect(
			editLabel?.trim(),
			"edit-mode popover primary action should read 'Save'",
		).toBe("Save");
	});

	test("BUG: popover in edit mode shows a delete button", async ({ page }) => {
		await openGoalAssistantProposal(page);

		await seedAnnotationWithHighlight(page, {
			quote: "test goal",
			comment: "to be deleted",
		});
		await page.locator(".r6o-annotation").first().dispatchEvent("click");

		const popover = page.locator("annotation-popover[open]");
		await expect(popover).toBeVisible({ timeout: 3_000 });

		// Expect a destructive delete affordance inside the popover when editing.
		const deleteBtn = popover.locator(
			'[data-testid="annotation-delete"], .review-popover-delete',
		);
		await expect(
			deleteBtn,
			"edit-mode popover must expose a delete button",
		).toBeVisible({ timeout: 3_000 });
	});

	test("BUG: hover chip exposes Edit + Delete; Delete removes the annotation and updates the badge", async ({ page }) => {
		const panel = await openGoalAssistantProposal(page);

		await seedAnnotationWithHighlight(page, {
			quote: "test goal",
			comment: "to be deleted via hover",
		});

		await expect(
			panel.locator('[data-testid="proposal-comment-count"]'),
		).toContainText("1 comment", { timeout: 5_000 });

		// Wait for the annotator-rendered span to have real layout before we
		// reach into the live component to fire the hover-chip path.
		await page.waitForFunction(() => {
			const el = document.querySelector(".r6o-annotation") as HTMLElement | null;
			if (!el) return false;
			const r = el.getBoundingClientRect();
			return r.width > 0 && r.height > 0;
		}, { timeout: 5_000 });

		// Drive the hover-chip directly via the same code path Recogito would
		// invoke on real mouseenter. This avoids dispatching a synthetic
		// hover event whose plumbing into text-annotator is browser-specific.
		await page.evaluate(() => {
			const rd: any = document
				.querySelector("commentable-markdown")
				?.querySelector("review-document");
			if (!rd) throw new Error("no <review-document>");
			const span = rd.querySelector(".r6o-annotation");
			if (!span) throw new Error("no .r6o-annotation span to hover");
			const id = span.getAttribute("data-annotation");
			if (!id) throw new Error(".r6o-annotation missing data-annotation");
			rd._showHoverChip(id, span);
		});

		const editBtn = page.locator('[data-testid="annotation-hover-edit"]');
		const deleteBtn = page.locator('[data-testid="annotation-hover-delete"]');
		await expect(
			editBtn,
			"hover chip must expose an Edit button",
		).toBeVisible({ timeout: 3_000 });
		await expect(
			deleteBtn,
			"hover chip must expose a Delete button",
		).toBeVisible({ timeout: 3_000 });

		await deleteBtn.click();

		// Badge must drop back to zero — `annotation-change` must have fired
		// with the post-removal count. When the count is 0 the badge element
		// is removed from the DOM, so assert it is no longer present.
		await expect(
			panel.locator('[data-testid="proposal-comment-count"]'),
			"hover-chip delete must update the comment badge",
		).toHaveCount(0, { timeout: 3_000 });
		await expect(
			page.locator(".r6o-annotation"),
			"hover-chip delete must remove the highlight span",
		).toHaveCount(0, { timeout: 3_000 });
	});

	test("annotations are ephemeral across reload", async ({ page }) => {
		const panel = await openGoalAssistantProposal(page);
		await injectAnnotation(page);
		await expect(panel.locator('[data-testid="proposal-comment-count"]')).toBeVisible(
			{ timeout: 5_000 },
		);

		await page.reload();
		await expect(
			page.locator("button").filter({ hasText: "Settings" }).first(),
		).toBeVisible({ timeout: 20_000 });

		// Wait for the active session to be re-attached (post-reload
		// session subscription has fired and the WS auth is complete).
		await page.waitForFunction(
			() => !!(window as any).bobbitState?.selectedSessionId,
			null,
			{ timeout: 15_000 },
		);
		// The proposal may be auto-restored or not depending on session
		// mode — either way the badge MUST NOT be visible: the in-memory
		// cache started empty.
		const panelAfter = page.locator('[data-panel="goal-proposal"]').first();
		await expect(panelAfter.locator('[data-testid="proposal-comment-count"]')).toHaveCount(
			0,
			{ timeout: 10_000 },
		);
	});
});
