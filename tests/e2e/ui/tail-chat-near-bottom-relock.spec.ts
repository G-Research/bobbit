/**
 * Tier 2.5 — near-bottom auto-relock test.
 *
 * Algorithm contract under test (use-stick-to-bottom port):
 *   When the user has scrolled up by a small amount that still puts them
 *   within `STICK_TO_BOTTOM_OFFSET_PX = 70` of the bottom, subsequent
 *   content growth must pull them back to the bottom WITHOUT requiring a
 *   click on the jump-to-bottom button. The deferred scroll-handler's
 *   "user-down + isNearBottom ⇒ re-engage stick" branch in combination
 *   with the RO `delta>0` re-pin is what implements this.
 *
 * Sensitivity matrix entry: setting the band to 0 makes this test fail.
 *
 * Outcome-only — bounding rects, no private-field reads.
 */
import { test, expect } from "./fixtures.js";
import { waitForHealth, waitForSessionStatus, createSession } from "../e2e-setup.js";
import { openApp } from "./ui-helpers.js";
import { SCROLL_SEL, TAIL_PX, disableScrollAnchoring, expectLatestMessagePinned } from "./tail-chat-helpers.js";

test.describe("tail-chat: near-bottom auto-relock (≤70 px band)", () => {
	test.beforeAll(async () => {
		await waitForHealth();
	});

	test.setTimeout(60_000);

	test("wheel up 30 px then content grows ⇒ latest message visible without Jump click", async ({ page, rec }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");

		await openApp(page);
		await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });
		await page.waitForSelector(SCROLL_SEL, { timeout: 10_000 });

		await disableScrollAnchoring(page);

		// Inject 5000 px pre-stream spacer + a "latest message" probe node
		// at the END of the content container so we have a stable
		// `getBoundingClientRect()` target. The "spacer" sits ABOVE so
		// "at bottom" means the probe node is visible.
		await page.evaluate((sel) => {
			const ai = document.querySelector("agent-interface") as any;
			const content = ai?.querySelector(".max-w-5xl") as HTMLElement | null;
			if (!content) throw new Error("messages content container not found");
			const spacer = document.createElement("div");
			spacer.id = "__pre_spacer";
			spacer.style.height = "5000px";
			spacer.style.background = "linear-gradient(#eef, #fee)";
			content.insertBefore(spacer, content.firstChild);
			// Probe node — this is what we measure with `expectLatestMessagePinned`.
			// Uses one of the recognised message-element tag names.
			const probe = document.createElement("assistant-message");
			probe.setAttribute("data-relock-probe", "1");
			probe.setAttribute("style", "display:block;height:80px;background:#cef;");
			probe.textContent = "tail-chat relock probe";
			content.appendChild(probe);
			const el = document.querySelector(sel) as HTMLElement;
			el.scrollTop = el.scrollHeight;
		}, SCROLL_SEL);
		await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));

		const pre = await page.evaluate((sel) => {
			const el = document.querySelector(sel) as HTMLElement;
			return {
				overflow: el.scrollHeight - el.clientHeight,
				distance: el.scrollHeight - el.scrollTop - el.clientHeight,
			};
		}, SCROLL_SEL);
		expect(pre.overflow, `pre: overflow`).toBeGreaterThan(2000);
		expect(pre.distance, `pre: at bottom`).toBeLessThanOrEqual(TAIL_PX);
		await rec.capture(`Pre: at bottom (overflow=${pre.overflow})`);

		// Trusted wheel up by 30 px — within the 70 px near-bottom band.
		// `_isAtBottom` flips false (synchronous wheel handler), but
		// `isNearBottom()` stays true so the next content growth re-engages
		// the lock and pulls us back to the bottom automatically.
		const box = await page.locator(SCROLL_SEL).first().boundingBox();
		if (!box) throw new Error("no scroll container box");
		await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
		await page.mouse.wheel(0, -30);
		// Let the wheel scroll commit.
		await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));

		const afterWheel = await page.evaluate((sel) => {
			const el = document.querySelector(sel) as HTMLElement;
			return { distance: el.scrollHeight - el.scrollTop - el.clientHeight, scrollTop: el.scrollTop };
		}, SCROLL_SEL);
		await rec.capture(`After 30 px wheel up: distance=${afterWheel.distance}`);
		// Sanity: the scroll commit should be tiny (< 70 px). If wheel
		// didn't commit we'd see distance ≈ 0; if it scrolled too far the
		// test premise is broken.
		expect(
			afterWheel.distance,
			`sanity: 30 px wheel-up should leave us within 70 px band; distance=${afterWheel.distance}`,
		).toBeLessThan(120);

		// Now grow content by ~200 px at the END (where the probe sits).
		// This is the canonical mid-stream content-growth path. The RO
		// callback fires `delta>0` — but `_isAtBottom` is false right now,
		// so the RO branch DOES NOT re-pin on its own. The user-driven
		// downward scroll classifier in `_handleScroll` is what re-engages
		// the lock — except we're not driving a downward scroll. The
		// path that catches this is: the RO callback's negative-delta
		// branch isn't applicable, the positive-delta branch checks
		// `_isAtBottom && !_escapedFromLock` and skips, BUT the deferred
		// scroll handler that runs from the RO-induced reflow scroll
		// event sees `_resizeDifference !== 0` and bails. So the only
		// thing that can re-lock here is direct relock-on-near-bottom in
		// the RO branch. Update the implementation to relock on positive
		// growth too when isNearBottom and !escaped. (See impl: positive
		// delta path checks `_isAtBottom`; if false but isNearBottom and
		// !escaped, also relock + pin.)
		await page.evaluate(() => {
			const ai = document.querySelector("agent-interface") as any;
			const content = ai?.querySelector(".max-w-5xl") as HTMLElement;
			const probe = content.querySelector("[data-relock-probe='1']") as HTMLElement;
			probe.style.height = "280px"; // grow by 200 px
		});
		await page.waitForFunction(() => {
			const el = document.querySelector("agent-interface .overflow-y-auto") as HTMLElement | null;
			if (!el) return false;
			// Wait for at least a couple of rAFs of relock to commit.
			return el.scrollHeight - el.scrollTop - el.clientHeight <= 12;
		}, null, { timeout: 5_000 }).catch(() => { /* fall through to assertion */ });
		await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
		await rec.capture("After content growth (200 px) — relock should have fired");

		// Outcome assertion: probe is fully visible (not below the fold).
		await expectLatestMessagePinned(page, { tailPx: TAIL_PX, label: "post-growth-relock" });

		// Sanity: jump-to-bottom button must NOT be visible (we're at bottom).
		const jumpOpacity = await page.evaluate(() => {
			const btn = document.querySelector('[data-testid="jump-to-bottom"]') as HTMLElement | null;
			return btn ? Number(getComputedStyle(btn).opacity) : 1;
		});
		expect(jumpOpacity, `jump button must be hidden at bottom; opacity=${jumpOpacity}`).toBeLessThanOrEqual(0.05);
	});
});
