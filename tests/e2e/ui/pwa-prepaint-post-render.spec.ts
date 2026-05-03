/**
 * Regression test for "skeleton bleed-through + duplicate Reconnecting… pill
 * after Lit has rendered".
 *
 * Bug (introduced by PR #450 — Production-grade PWA resume):
 *   `__bobbitPrepaint()` in index.html re-runs on every same-tab
 *   `localStorage.setItem("bobbit.ui-snapshot.v1", …)` via a monkey-patched
 *   `Storage.prototype.setItem`. `scheduleSave()` writes that key on every
 *   state mutation. Each re-run un-hides the boot skeleton
 *   (`sk.classList.remove("--hide")`) and appends a fresh `.bobbit-skeleton__pill`
 *   "Reconnecting…" element. The cleanup MutationObserver disconnects after
 *   the first `data-rendered` flip, so nothing tears them back down.
 *
 * Symptoms in the wild:
 *   - Different background bleeding through near the title (skeleton sidebar/main panels).
 *   - "Reconnecting…" pill in the bottom-right of an otherwise-rendered app.
 *
 * Fix:
 *   `__bobbitPrepaint()` early-returns when `#app[data-rendered="true"]` —
 *   after Lit has rendered, the prepaint has no job to do.
 *
 * This test exercises the failure path directly:
 *   1. Open the app and wait for `#app[data-rendered="true"]`.
 *   2. Write to `bobbit.ui-snapshot.v1` to trigger the patched `setItem` →
 *      `__bobbitPrepaint()` re-run.
 *   3. Assert the skeleton stays `.--hide` and no `.bobbit-skeleton__pill`
 *      element is in the DOM.
 */
import { test, expect } from "../gateway-harness.js";
import { openApp } from "./ui-helpers.js";

test.describe("PWA prepaint must no-op after Lit has rendered", () => {
	test("snapshot writes after data-rendered must not reveal skeleton or append Reconnecting pill", async ({ page }) => {
		await openApp(page);

		// Wait for Lit to flip data-rendered. main.ts sets this immediately
		// after the first renderApp() call, before any awaits.
		await page.waitForFunction(
			() => document.getElementById("app")?.getAttribute("data-rendered") === "true",
			null,
			{ timeout: 10_000 },
		);

		// Confirm the watchdog/observer cleanup ran: skeleton has --hide and
		// no pill is present. (If this baseline already fails, the bug is
		// even broader than the post-render bleed-through.)
		const baseline = await page.evaluate(() => {
			const sk = document.querySelector("[data-bobbit-skeleton]") as HTMLElement | null;
			return {
				skeletonHidden: !!sk && sk.classList.contains("--hide"),
				pillCount: document.querySelectorAll("[data-bobbit-pill]").length,
			};
		});
		expect(baseline.skeletonHidden, "skeleton must be hidden once Lit rendered").toBe(true);
		expect(baseline.pillCount, "no Reconnecting pill should exist post-render").toBe(0);

		// Trigger the bug path: write to the snapshot key. In the buggy
		// version the patched Storage.prototype.setItem re-runs
		// __bobbitPrepaint(), which un-hides the skeleton AND appends a
		// fresh .bobbit-skeleton__pill on every write.
		//
		// We simulate what scheduleSave() does mid-session. Use an existing
		// payload shape (last-message text "OK") so the prepaint code path
		// would actually emit DOM if the guard wasn't in place.
		await page.evaluate(() => {
			const payload = {
				v: 1,
				buildId: "regression-test",
				selectedSessionId: "s1",
				activeSession: {
					id: "s1",
					title: "Regression session",
					messages: [
						{ id: "m1", role: "user", content: [{ type: "text", text: "ping" }] },
						{ id: "m2", role: "assistant", content: [{ type: "text", text: "OK" }] },
					],
				},
			};
			// Multiple writes — the bug appends a new pill on EACH one.
			for (let i = 0; i < 5; i++) {
				localStorage.setItem("bobbit.ui-snapshot.v1", JSON.stringify({ ...payload, _n: i }));
			}
		});

		// Yield a couple of paint frames so any synchronous DOM mutations
		// from the patched setItem chain have settled.
		await page.evaluate(() => new Promise<void>((resolve) => {
			requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
		}));

		const after = await page.evaluate(() => {
			const sk = document.querySelector("[data-bobbit-skeleton]") as HTMLElement | null;
			return {
				skeletonHidden: !!sk && sk.classList.contains("--hide"),
				skeletonComputedOpacity: sk ? getComputedStyle(sk).opacity : null,
				pillCount: document.querySelectorAll("[data-bobbit-pill]").length,
				pillTexts: Array.from(document.querySelectorAll("[data-bobbit-pill]")).map(
					(el) => (el.textContent ?? "").trim(),
				),
			};
		});

		expect(
			after.skeletonHidden,
			`boot skeleton was un-hidden by post-render prepaint (--hide class removed). ` +
			`Skeleton's fixed-position panels are now bleeding through behind the real UI. ` +
			`Computed opacity: ${after.skeletonComputedOpacity}.`,
		).toBe(true);

		expect(
			after.pillCount,
			`post-render prepaint appended ${after.pillCount} "Reconnecting…" pill(s). ` +
			`Pill texts: ${JSON.stringify(after.pillTexts)}. ` +
			`__bobbitPrepaint() must no-op once #app[data-rendered=true].`,
		).toBe(0);
	});
});
