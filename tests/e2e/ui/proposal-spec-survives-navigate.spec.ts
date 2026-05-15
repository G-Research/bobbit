/**
 * Reproducer — goal proposal panel renders empty after navigate-away/back.
 *
 * Manual repro (reported by user):
 *   1. Open a goal-assistant session; agent streams a `propose_goal`.
 *   2. Add an inline comment on the spec.
 *   3. Navigate away (sidebar click, browser back, anywhere).
 *   4. Navigate back to the same session.
 *   5. Panel is still visible (correct), but the spec body is empty (BUG)
 *      and an "orphaned annotations" UI appears because the in-memory
 *      annotation cache survived but its anchored text didn't.
 *
 * Three plausible causes (this test isolates which):
 *
 *   A) connectToSession fast-path (session-manager.ts:817) unconditionally
 *      `delete state.activeProposals.goal` on switch-back, then the WS
 *      rehydrate `proposal_update {source:"rehydrate"}` event arrives but
 *      its fields don't include the spec.
 *
 *   B) syncProposalFormState's identity-key guard (render.ts:2067) keeps
 *      `_proposalSpec` stale at "" because `_proposalInitializedFrom`
 *      matches a degenerate empty key.
 *
 *   C) The on-disk proposal draft (`proposal-drafts/<sid>/goal.md`) didn't
 *      get the spec written by `propose_goal`, so the rehydrate brings
 *      back fields with `spec=""`.
 *
 * The test asserts the user-visible contract: after navigate-away/back the
 * goal proposal panel must still show the same spec body the user
 * commented on. If it fails, the diagnostics block prints the rehydrate
 * payload, the live `state.activeProposals.goal.fields`, and the
 * `_proposalSpec` form-mirror so we can pinpoint A/B/C.
 */
import { test, expect } from "../gateway-harness.js";
import type { Page } from "@playwright/test";
import { openApp, sendMessage, navigateToHash } from "./ui-helpers.js";
import { createSession, waitForHealth } from "../e2e-setup.js";

/** Open a goal-assistant session and drive a propose_goal. */
async function openGoalAssistantWithProposal(page: Page) {
	test.setTimeout(120_000);
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

/** Read the current spec text shown inside the proposal panel's <commentable-markdown>. */
async function getRenderedSpecText(page: Page): Promise<string> {
	return page.evaluate(() => {
		const cm = document.querySelector("commentable-markdown");
		if (!cm) return "<<no commentable-markdown>>";
		// markdown is set as a property; reflect from the live DOM.
		const md = (cm as any).markdown ?? "<<no .markdown property>>";
		return md as string;
	});
}

/** Read the in-memory live state for diagnostics on failure. */
async function dumpProposalState(page: Page): Promise<Record<string, unknown>> {
	return page.evaluate(() => {
		const s = (window as any).bobbitState;
		const slot = s?.activeProposals?.goal;
		// _proposalSpec is module-scoped inside render.ts; expose via the
		// data-panel's <commentable-markdown> .markdown property which is
		// fed from `config.spec` (= `_proposalSpec`).
		const cm = document.querySelector("commentable-markdown") as any;
		return {
			selectedSessionId: s?.selectedSessionId ?? null,
			slotPresent: slot != null,
			slotFieldsKeys: slot ? Object.keys(slot.fields ?? {}) : null,
			slotSpecLen: typeof slot?.fields?.spec === "string" ? slot.fields.spec.length : null,
			slotTitle: slot?.fields?.title ?? null,
			renderedMarkdownLen: typeof cm?.markdown === "string" ? cm.markdown.length : null,
			renderedMarkdownPreview:
				typeof cm?.markdown === "string" ? cm.markdown.slice(0, 80) : null,
		};
	});
}

test.describe("Goal proposal spec survives navigate-away/back", () => {
	test.beforeAll(async () => {
		await waitForHealth();
	});

	// FIXME: after nav-away/back the rehydrated goal-proposal panel renders
	// `_No spec content yet_` instead of the spec body. Out of scope for
	// PR #599 (auto-retry); tracked in docs/design/proposal-spec-rehydrate.md.
	// Server-side rehydrate parsing is locked by
	// `tests/proposal-rehydrate.test.ts`; the bug is client-side (see the
	// linked design note for hypotheses A/B/C and the diagnostic plan).
	test.fixme("@repro spec body persists after sidebar nav + return", async ({ page }) => {
		await openGoalAssistantWithProposal(page);

		// Capture the spec body the user is about to comment on. This is
		// the rendered <commentable-markdown>'s `markdown` property which
		// reflects the LIVE form-mirror state regardless of which path
		// (assistant `state.previewSpec` or proposal-panel
		// `state.activeProposals.goal.fields.spec`) populates it.
		const originalSpec = await getRenderedSpecText(page);
		expect(originalSpec.length, "proposal spec must be non-empty before nav").toBeGreaterThan(20);

		// Capture the active session ID (target of nav-back).
		const sidA = await page.evaluate(
			() => (window as any).bobbitState?.selectedSessionId as string | null,
		);
		expect(sidA, "must have an active session id").toBeTruthy();

		// Create a second session to nav AWAY to (avoids the pure-reload
		// path; this exercises the connectToSession fast-path the manual
		// repro hits).
		const sidB = await createSession();

		// Navigate to session B.
		await navigateToHash(page, `#/session/${sidB}`);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });

		// Navigate back to session A.
		await navigateToHash(page, `#/session/${sidA}`);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });

		// Wait for the goal-proposal panel to re-render. The fast-path
		// rehydrate is fire-and-forget; we poll the rendered markdown body
		// directly until it matches the pre-nav value.
		const panelAfter = page.locator('[data-panel="goal-proposal"]').first();
		await expect(panelAfter).toBeVisible({ timeout: 15_000 });

		await expect(async () => {
			const rendered = await getRenderedSpecText(page);
			expect(rendered, `rendered markdown after nav-back`).toBe(originalSpec);
		}).toPass({ timeout: 15_000, intervals: [500, 1000, 2000] });
	});
});
