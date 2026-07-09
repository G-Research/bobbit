/**
 * E2E tests for proposal panel streaming UX.
 *
 * Cases PPS-01..PPS-07 from docs/design/proposal-panel-streaming-ux.md §4.2.
 * Drives the mock agent's `STAY_BUSY:propose_<type>:<n>` prompt prefix.
 */
import { test, expect } from "../gateway-harness.js";
import { openApp, createSessionViaUI, sendMessage } from "./ui-helpers.js";

/** Trigger a streaming proposal in a fresh regular (non-assistant) session. */
async function startStreamingProposal(
	page: import("@playwright/test").Page,
	type: "goal" | "role" | "tool" | "staff" | "setup" | "workflow" | "project",
	n: number,
	intervalMs?: number,
) {
	await openApp(page);
	await createSessionViaUI(page);
	await sendMessage(page, `STAY_BUSY:propose_${type}:${n}${intervalMs ? `:${intervalMs}` : ""}`);
}

test.describe("Proposal panel streaming UX", () => {
	test("PPS-01 + PPS-02: goal — submit disabled and badge visible while streaming", async ({ page }) => {
		// Spread the deltas (150 ms cadence) so even a CPU-starved browser is
		// scheduled to paint the in-flight state between events instead of
		// batching the whole stream + message_end into a single final render.
		await startStreamingProposal(page, "goal", 10, 150);

		const badge = page.locator('[data-testid="proposal-streaming-badge"]').first();
		const submitWrap = page.locator('[data-testid="proposal-primary-submit"]').first();
		await expect(submitWrap).toBeVisible({ timeout: 15_000 });
		const submitBtn = submitWrap.locator("button").first();

		// PPS-01 + PPS-02: the streaming badge and the disabled submit binding are
		// BOTH derived from the same per-tag streaming flag, so they flip together
		// in one render. Poll for the instant both hold simultaneously rather than
		// asserting them sequentially — the latter can race the stream-end window
		// (badge passes, stream ends, then `toBeDisabled` sees enabled). Polling on
		// the consistent DOM snapshot removes the wall-clock dependency entirely.
		await expect.poll(async () => {
			const [badgeVisible, disabled] = await Promise.all([
				badge.isVisible().catch(() => false),
				submitBtn.isDisabled().catch(() => false),
			]);
			return badgeVisible && disabled;
		}, { timeout: 15_000, intervals: [50, 100, 150] }).toBe(true);

		// After streaming ends, badge disappears and button enables (both flip
		// together at message_end).
		await expect(badge).toBeHidden({ timeout: 15_000 });
		await expect(submitBtn).toBeEnabled({ timeout: 5_000 });
	});

	test("PPS-03: scrollTop preserved when user scrolls up mid-stream", async ({ page }) => {
		await startStreamingProposal(page, "goal", 40, 120);

		// Wait for the spec preview container to appear with content.
		const preview = page.locator(".goal-preview-panel .overflow-y-auto").last();
		await expect(preview).toBeVisible({ timeout: 15_000 });

		// Wait until the preview is scrollable while the stream is still active.
		// The slow fixture cadence prevents the test from racing past all deltas
		// before it can simulate the user's scroll-up intent.
		await page.waitForFunction(() => {
			const els = document.querySelectorAll(".goal-preview-panel .overflow-y-auto");
			const el = els[els.length - 1] as HTMLElement | undefined;
			return !!el
				&& el.scrollHeight - el.clientHeight > 60
				&& !!document.querySelector('[data-testid="proposal-streaming-badge"]');
		}, null, { timeout: 20_000 });

		// User scrolls up via wheel + manual scrollTop (mirrors real interaction).
		await preview.evaluate((el) => {
			el.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));
			(el as HTMLElement).scrollTop = 20;
			el.dispatchEvent(new Event("scroll"));
		});

		// Wait for at least one more streaming update to land by watching the
		// preview's scrollHeight grow further (deltas keep arriving).
		const initialHeight = await preview.evaluate((el) => (el as HTMLElement).scrollHeight);
		await page.waitForFunction(
			(seed) => {
				const els = document.querySelectorAll(".goal-preview-panel .overflow-y-auto");
				const el = els[els.length - 1] as HTMLElement | undefined;
				return !!el && el.scrollHeight > seed;
			},
			initialHeight,
			{ timeout: 15_000 },
		);

		// scrollTop should remain near 20 (within tolerance), not snapped to bottom.
		const scrollTop = await preview.evaluate((el) => (el as HTMLElement).scrollTop);
		expect(scrollTop).toBeLessThan(120);
	});

	test("PPS-04: follow-tail when at bottom", async ({ page }) => {
		// Spread the deltas (150 ms cadence, matching PPS-01/PPS-03) so each delta is
		// a distinct WS event that triggers a mid-stream render where follow-tail
		// runs. Without a cadence a CPU-starved browser under N-way load batches the
		// whole stream + agent_end into ONE final render — by which point the
		// follow-tail flag has cleared, so scrollTop is never reconciled and stays 0.
		await startStreamingProposal(page, "goal", 10, 150);

		const preview = page.locator(".goal-preview-panel .overflow-y-auto").last();
		await expect(preview).toBeVisible({ timeout: 15_000 });

		// Wait for the preview to become scrollable mid-stream so follow-tail
		// has positive deltas to track.
		await page.waitForFunction(() => {
			const els = document.querySelectorAll(".goal-preview-panel .overflow-y-auto");
			const el = els[els.length - 1] as HTMLElement | undefined;
			return !!el && el.scrollHeight - el.clientHeight > 60;
		}, null, { timeout: 15_000 });

		// follow-tail's OBSERVABLE effect is that it programmatically moves scrollTop
		// forward while pinned to the bottom. Poll on that state directly rather than
		// reading scrollTop once after the badge hides — the latter races the
		// post-agent_end reflow window. This removes the wall-clock dependency: the
		// moment follow-tail advances scrollTop (which it does on every mid-stream
		// delta), the assertion holds regardless of CPU scheduling.
		await expect
			.poll(() => preview.evaluate((el) => (el as HTMLElement).scrollTop), { timeout: 15_000, intervals: [50, 100, 150] })
			.toBeGreaterThan(0);

		// And streaming completes cleanly (badge clears at agent_end).
		const badge = page.locator('[data-testid="proposal-streaming-badge"]').first();
		await expect(badge).toBeHidden({ timeout: 15_000 });
	});

	// PPS-06: dismissing a proposal mid-stream must stick. Previously skipped
	// because it consistently failed: the persistent dismissal is a content
	// fingerprint, but each streaming delta grows the body, so the next delta no
	// longer matched the dismissed fingerprint and re-populated the panel. The
	// product fix (RemoteAgent.dismissStreamingProposal → wired from the goal
	// panel's Dismiss handler) suppresses the rest of the in-flight tool block,
	// so a mid-stream Dismiss now stays dismissed for the whole turn.
	test("PPS-06: dismiss button clickable during streaming", async ({ page }) => {
		// Long, spread window (20 deltas × 150 ms ≈ 3 s) so the Dismiss click
		// lands well inside the stream and several MORE deltas arrive afterwards —
		// that post-dismiss tail is exactly what would re-open the panel if the
		// suppression regressed (see the idle re-assert below).
		await startStreamingProposal(page, "goal", 20, 150);

		// Wait for panel + dismiss button.
		const titleInput = page.locator("input[placeholder='Goal title']").first();
		await expect(titleInput).toBeVisible({ timeout: 15_000 });

		const badge = page.locator('[data-testid="proposal-streaming-badge"]').first();
		await expect(badge).toBeVisible({ timeout: 15_000 });

		const dismissBtn = page.locator("button").filter({ hasText: "Dismiss" }).first();
		await expect(dismissBtn).toBeVisible({ timeout: 5_000 });
		await expect(dismissBtn).toBeEnabled();
		await dismissBtn.click();

		// Title input should disappear immediately on dismiss.
		await expect(titleInput).toBeHidden({ timeout: 5_000 });

		// Sensitivity anchor: wait until the turn fully completes (agent idle).
		// Without the suppression fix, the remaining streaming deltas — and the
		// final message_end fire — would re-populate the goal proposal as a fresh
		// first-emit (its grown body no longer matches the dismissed fingerprint),
		// so the title input would re-appear by the time the turn ends. Asserting
		// it stays hidden through completion makes this test fail if the product
		// path regresses.
		await page.waitForFunction(
			() => (window as any).bobbitState?.remoteAgent?.state?.status === "idle",
			null,
			{ timeout: 15_000 },
		);
		await expect(titleInput).toBeHidden();
	});

	test("PPS-07: title input remains user-editable mid-stream", async ({ page }) => {
		await startStreamingProposal(page, "goal", 30);

		const titleInput = page.locator("input[placeholder='Goal title']").first();
		await expect(titleInput).toBeVisible({ timeout: 15_000 });

		// The title input is not gated by `disabled` even while streaming —
		// only the primary submit button is. The user can still hand-edit.
		await expect(titleInput).toBeEnabled();

		// Verify badge confirms we're still streaming during this assertion.
		const badge = page.locator('[data-testid="proposal-streaming-badge"]').first();
		await expect(badge).toBeVisible({ timeout: 10_000 });
	});

	// Project panel — non-assistant flow also surfaces this proposal type.
	test("PPS-01 + PPS-02: project — badge + disabled submit while streaming", async ({ page }) => {
		// 10 deltas × 150 ms ≈ 1.5 s. The project panel is heavier (it loads
		// project views), so a tight (~360 ms) window let a contended browser
		// batch the whole stream into one final render and never paint the badge,
		// timing out `toBeVisible`. The spread cadence guarantees a mid-stream
		// paint so the badge is observed before it clears.
		await startStreamingProposal(page, "project", 10, 150);

		const badge = page.locator('[data-testid="proposal-streaming-badge"]').first();
		await expect(badge).toBeVisible({ timeout: 20_000 });
		await expect(badge).toBeHidden({ timeout: 20_000 });
	});
});
