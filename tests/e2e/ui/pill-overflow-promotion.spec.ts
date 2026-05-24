/**
 * Browser E2E — pill overflow promote-back regression.
 *
 * Pins the bug that `_pillWidths` in `AgentInterface._measurePillOverflow`
 * was caching `pillEl.parentElement.offsetWidth` instead of the pill's own
 * width. Visible-strip pills are each wrapped in their own `<div>`, so the
 * parent's width happens to equal the pill's width. But every pill inside
 * the expanded "more" popover shares one parent (the `.pill-more-popover`
 * flex-column container), so each hidden pill cached the popover's full
 * width (~250-300 px instead of the real ~80-140 px).
 *
 * Symptom of the bug: once the user opens the popover, the cache is
 * poisoned. When visible pills are dismissed and the algorithm reconsiders
 * fit, it sees hidden pills as huge and refuses to promote them. The
 * "more" pill stays populated even though there is now room in the strip
 * for several of them. Pre-fix, only the always-at-least-1 fallback shows.
 *
 * Repro flow exercised here:
 *   1. Spawn 10 long-running bg processes via REST so the strip overflows.
 *   2. Wait for the "more" pill to render.
 *   3. Open the "more" popover (this is the manoeuvre that poisoned the
 *      cache pre-fix) and then close it.
 *   4. Dismiss every currently-visible pill via the REST DELETE endpoint.
 *   5. Assert: as many pills get promoted back into the strip as were
 *      dismissed. With the bug, the post-dismiss visible count collapses
 *      to 1; with the fix it stays roughly equal to the pre-dismiss count.
 *
 * The assertion uses "visibleAfter >= visibleBefore" so the test tolerates
 * environment-dependent pill widths and viewport sizes — what matters is
 * that the cache lets the algorithm see room when room becomes available.
 */
import { test, expect } from "./fixtures.js";
import {
	createSession,
	waitForHealth,
	waitForSessionStatus,
	apiFetch,
} from "../e2e-setup.js";
import { openApp } from "./ui-helpers.js";

// Long-running bg command — must outlive the entire test.
const SLEEP_CMD = process.platform === "win32"
	? "ping -n 600 127.0.0.1 >NUL"
	: "sleep 600";

test.describe("pill strip overflow — promotion after dismiss", () => {
	test.beforeAll(async () => {
		await waitForHealth();
	});

	// 90s test budget: the test sequences 10 REST POSTs to create bg processes,
	// opens then closes the more-popover, sequences ~3 REST DELETEs, then waits
	// for WS-driven re-renders + rAF re-measures to refill the strip. Each step
	// is small but the chain accumulates, and the assertion timeout further down
	// is intentionally generous (30s) because the cascade can stall on cold-
	// loaded UI runners. Without this override the default 30s budget is too
	// tight to leave headroom for any one step in the chain.
	test("hidden pills are promoted back into the strip after visible pills are dismissed (B-A1 regression)", { timeout: 90_000 }, async ({ page, rec }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");

		await openApp(page);
		await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });

		// Narrow viewport so a handful of pills triggers overflow even with
		// 12-px pill labels. 540px leaves ~470px of strip after the
		// `calc(100% - 4rem)` cap, fitting about three average-width pills.
		await page.setViewportSize({ width: 540, height: 800 });

		// Spawn 10 long-running bg processes. Names have varied lengths so
		// the algorithm has to track per-id widths rather than averaging.
		const ids: string[] = [];
		for (let i = 1; i <= 10; i++) {
			const r = await apiFetch(`/api/sessions/${sessionId}/bg-processes`, {
				method: "POST",
				body: JSON.stringify({ command: SLEEP_CMD, name: `qa-pill-${i}` }),
			});
			expect(r.status).toBe(201);
			const bg = await r.json();
			ids.push(bg.id);
		}

		// Wait for the strip to render with overflow — "more" pill must be
		// present, otherwise the test is not exercising the bug surface.
		await expect(page.locator("[data-more-btn]")).toBeVisible({ timeout: 15_000 });
		await rec.capture("Strip rendered with overflow — 'more' pill visible");

		// Settle: give the rAF measurement loop a moment to converge so the
		// pre-dismiss visible count is stable.
		await page.waitForTimeout(250);

		// Count visible bg-process-pill elements. Hidden pills only enter
		// the DOM when the popover is open, so this count is precisely the
		// strip's visible set.
		const visibleBefore = await page.locator("bg-process-pill").count();
		expect(
			visibleBefore,
			"need at least 2 visible pills + a 'more' pill for the bug surface to be exercised; widen the viewport or shorten the bg-widget if this fails",
		).toBeGreaterThanOrEqual(2);
		expect(visibleBefore).toBeLessThan(10); // sanity: overflow really did happen

		// Capture the data-ids of the currently-visible pills so we can
		// dismiss exactly them via REST. Reading attributes from the DOM
		// is more reliable than guessing the sort order.
		const visiblePillIds = await page
			.locator("bg-process-pill[data-id]")
			.evaluateAll((els) => els.map((el) => el.getAttribute("data-id") ?? ""));
		expect(visiblePillIds.length).toBe(visibleBefore);
		expect(visiblePillIds.every((id) => id.length > 0)).toBe(true);

		// THE BUG SURFACE: open the "more" popover and close it. Opening
		// triggers a re-measure with hidden pills momentarily in the DOM;
		// pre-fix, every hidden pill caches the popover container's
		// offsetWidth (~250-300 px). Closing doesn't clear the cache.
		await page.locator("[data-more-btn] button").first().click();
		await expect(page.locator(".pill-more-popover")).toBeVisible({ timeout: 5_000 });
		await rec.capture("'more' popover opened — cache refresh fires");

		// Close by clicking outside the popover.
		await page.mouse.click(10, 10);
		await expect(page.locator(".pill-more-popover")).toHaveCount(0, { timeout: 5_000 });
		await rec.capture("'more' popover closed");

		// Dismiss every currently-visible pill via REST. The server
		// broadcasts the removal over WS; the client updates bgProcesses
		// which triggers a re-measure. The algorithm should promote hidden
		// pills into the freed space.
		for (const pillId of visiblePillIds) {
			const r = await apiFetch(
				`/api/sessions/${sessionId}/bg-processes/${pillId}`,
				{ method: "DELETE" },
			);
			expect([200, 204]).toContain(r.status);
		}

		// Wait for the strip to settle after the cascade of dismissals.
		// The remaining set is 10 - visibleBefore, all initially in the
		// "more" popover. With the fix, the strip refills to ~visibleBefore.
		// Without the fix, it collapses to the always-at-least-1 fallback.
		// Timeout bumped to 30s because the cascade of REST DELETEs +
		// WS-driven re-renders + rAF re-measure has a long but bounded tail
		// on cold-loaded UI; the assertion below catches the actual
		// regression (visibleAfter < visibleBefore).
		await page.waitForFunction(
			(target: number) =>
				document.querySelectorAll("bg-process-pill").length >= target,
			visibleBefore,
			{ timeout: 30_000 },
		);

		const visibleAfter = await page.locator("bg-process-pill").count();
		await rec.capture(`Post-dismiss state — ${visibleAfter} pills visible (was ${visibleBefore})`);

		expect(
			visibleAfter,
			`hidden pills must be promoted back into the strip after their visible neighbours are dismissed (visibleBefore=${visibleBefore}, visibleAfter=${visibleAfter}); ` +
				`pre-fix bug collapses this to 1 because _pillWidths cached the popover container width for every hidden pill`,
		).toBeGreaterThanOrEqual(visibleBefore);

		// Cleanup — kill the remaining bg processes so the session cleanup
		// path doesn't leak children. Best-effort.
		for (const id of ids) {
			if (visiblePillIds.includes(id)) continue;
			await apiFetch(
				`/api/sessions/${sessionId}/bg-processes/${id}`,
				{ method: "DELETE" },
			).catch(() => {});
		}
		await apiFetch(`/api/sessions/${sessionId}`, { method: "DELETE" }).catch(() => {});
	});
});
