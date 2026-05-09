/**
 * Regression test surfaced by the transcript-fidelity harness.
 *
 * What the fidelity harness observed
 * ----------------------------------
 *   On a single `sendMessage` call, the user-message bubble flickers through
 *   THREE distinct DOM elements before settling:
 *     1. an initial empty <user-message> (no `data-message-id`),
 *     2. a second <user-message> with the optimistic id (`optimistic_*`),
 *     3. a third <user-message> (no id) once the server-confirmed echo
 *        arrives via message_end.
 *
 *   Each of (1) and (2) is REMOVED (full Lit element teardown) before the
 *   next is appended. The user perceives "their bubble appeared" because
 *   the swaps happen in <50 ms, but for accessibility tooling, screen
 *   readers, performance instrumentation, and any DOM-keyed test harness
 *   this is observable churn that should not exist.
 *
 *   Captured trace (representative):
 *     t=3630 append   <user-message> (no id)            slot=A
 *     t=3645 append   <user-message data-message-id="optimistic_..."> slot=B
 *     t=3646 remove   slot=A
 *     t=3649 append   <user-message> (no id)            slot=C
 *     t=3649 remove   slot=B
 *     t=3728 update   slot=C  text="fid-1"  (final)
 *
 *   See test-results/fidelity-repros/<happy-path-*> for raw observed.json.
 *
 * What this test asserts (outcome-only)
 * -------------------------------------
 *   On a single sendMessage:
 *     #1 At most ONE persistent <user-message> DOM element survives until
 *        the assistant turn completes.
 *     #2 No <user-message> element is added then removed within a turn.
 *
 *   Both are violated by the current implementation. This test FAILS on
 *   `master` and proves the bug is reproducible deterministically.
 *   Once the optimistic-echo / server-echo handoff is fixed, this test
 *   becomes a guard against regression.
 *
 * Note on flakiness: the assertions are timing-tolerant. We don't require
 * a specific ordering of mutations \u2014 only the final invariant (one
 * survivor, zero churn-removals) which is what the user actually
 * experiences as "the message appeared and stayed".
 */
import { test, expect } from "../fixtures.js";
import { openApp, createSessionViaUI, sendMessage } from "../ui-helpers.js";

test.describe("user-message render churn", () => {
	test("single sendMessage produces exactly one persistent <user-message>", async ({ page }) => {
		test.setTimeout(45_000);

		// Install a MutationObserver-based recorder BEFORE the user types.
		// We watch every <user-message> add/remove for the duration of the
		// turn and report the lifecycle counts at the end.
		await page.addInitScript(() => {
			(window as any).__userMsgChurn = { adds: [], removes: [] };
			const start = () => {
				const obs = new MutationObserver((mutations) => {
					for (const m of mutations) {
						m.addedNodes.forEach((n) => {
							if (n instanceof HTMLElement && n.tagName.toLowerCase() === "user-message") {
								(window as any).__userMsgChurn.adds.push({
									t: performance.now(),
									id: n.getAttribute("data-message-id"),
								});
							}
						});
						m.removedNodes.forEach((n) => {
							if (n instanceof HTMLElement && n.tagName.toLowerCase() === "user-message") {
								(window as any).__userMsgChurn.removes.push({
									t: performance.now(),
									id: n.getAttribute("data-message-id"),
								});
							}
						});
					}
				});
				obs.observe(document.body, { childList: true, subtree: true });
			};
			if (document.readyState === "loading") {
				document.addEventListener("DOMContentLoaded", start);
			} else {
				start();
			}
		});

		await openApp(page);
		await createSessionViaUI(page);

		// Reset counters AFTER session creation so we measure only the
		// turn under test \u2014 sidebar paints can add unrelated nodes.
		await page.evaluate(() => { (window as any).__userMsgChurn = { adds: [], removes: [] }; });

		await sendMessage(page, "fidelity-churn-test");

		// Wait until the assistant has replied (mock agent responds with
		// "OK"). This guarantees the turn is past message_end so any
		// optimistic\u2192confirmed handoff has settled.
		await expect(page.getByText("OK", { exact: true }).first()).toBeVisible({ timeout: 15_000 });

		// Allow the post-turn animation/throttle window to drain so any
		// follow-on Lit re-render is observable.
		await page.waitForFunction(() => {
			const churn = (window as any).__userMsgChurn;
			// Signal stable when no new add/remove for ~150ms.
			const now = performance.now();
			const lastEvent = Math.max(
				churn.adds[churn.adds.length - 1]?.t ?? 0,
				churn.removes[churn.removes.length - 1]?.t ?? 0,
			);
			return lastEvent > 0 && now - lastEvent > 150;
		}, undefined, { timeout: 5_000 }).catch(() => { /* fall through to assertion */ });

		const churn = await page.evaluate(() => (window as any).__userMsgChurn);
		const survivors = await page.locator("user-message").count();

		const summary = `<user-message> lifecycle for one sendMessage:\n` +
			`  adds:    ${churn.adds.length} (${JSON.stringify(churn.adds)})\n` +
			`  removes: ${churn.removes.length} (${JSON.stringify(churn.removes)})\n` +
			`  DOM survivors at end: ${survivors}`;

		// Invariant #1: exactly one <user-message> persists.
		expect(survivors, summary).toBe(1);

		// Invariant #2: no <user-message> was removed during the turn. A
		// clean implementation appends one bubble whose id may be back-
		// filled by Lit-property update, never a teardown + re-add.
		expect(churn.removes.length, summary).toBe(0);

		// Sanity: at least one add happened.
		expect(churn.adds.length, summary).toBeGreaterThanOrEqual(1);
	});
});
