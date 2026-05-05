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
