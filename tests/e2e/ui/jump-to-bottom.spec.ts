/**
 * E2E test for the Jump-to-bottom floating button (Change 5 from
 * the scroll-lock hardening design doc).
 *
 * Covers:
 *   1. Hidden when scrolled to the bottom.
 *   2. Visible after scrolling up by > clientHeight * 0.5.
 *   3. Hidden again when scrolled back to within clientHeight * 0.4 of bottom.
 *   4. Click jumps to bottom and re-arms stickToBottom.
 *   5. Unmount produces no console errors.
 */
import { test, expect } from "./fixtures.js";
import { openApp, createSessionViaUI } from "./ui-helpers.js";

test.describe("Jump-to-bottom button", () => {
	test("appears on scroll-up, hides at bottom, click jumps + sets stickToBottom; unmount clean", async ({ page, rec }) => {
		const consoleErrors: string[] = [];
		page.on("console", (msg) => {
			if (msg.type() === "error") consoleErrors.push(msg.text());
		});

		await openApp(page);
		await createSessionViaUI(page);
		await rec.capture("Session created — idle composer");

		// Wait for the agent-interface to mount
		const ai = page.locator("agent-interface").first();
		await expect(ai).toBeVisible({ timeout: 10_000 });

		// Find the scroll container (.overflow-y-auto inside the messages area).
		const scrollSel = "agent-interface .overflow-y-auto";
		await page.waitForSelector(scrollSel, { timeout: 10_000 });

		// Inject a tall spacer into the .max-w-5xl content container so the
		// scroll container has scrollable content. We bypass the agent because
		// we're testing pure scroll behaviour, not message rendering.
		await page.evaluate(() => {
			const ai = document.querySelector("agent-interface");
			const content = ai?.querySelector(".max-w-5xl") as HTMLElement | null;
			if (!content) throw new Error("messages content container not found");
			const spacer = document.createElement("div");
			spacer.id = "__jtb_spacer";
			spacer.style.height = "5000px";
			spacer.style.background = "linear-gradient(#eef, #fee)";
			content.appendChild(spacer);
		});

		// Snap to bottom first so the initial state is "at bottom".
		await page.evaluate((sel) => {
			const el = document.querySelector(sel) as HTMLElement;
			el.scrollTop = el.scrollHeight;
			el.dispatchEvent(new Event("scroll"));
		}, scrollSel);

		const btn = page.locator('[data-testid="jump-to-bottom"]').first();

		// 1. Button hidden when at bottom.
		// (The button is always in the DOM; we check effective visibility via
		// pointer-events / opacity.)
		await page.waitForFunction(() => {
			const b = document.querySelector('[data-testid="jump-to-bottom"]') as HTMLElement | null;
			if (!b) return false;
			return b.style.pointerEvents === "none" && b.style.opacity === "0";
		}, null, { timeout: 10_000 });
		await rec.capture("At bottom — jump-to-bottom hidden");

		// 2. Scroll up by clientHeight * 0.6 → button must become visible.
		//
		// Use a real mouse wheel via Playwright so the `wheel` listener on
		// the scroll container fires `_handleUserIntent`, which immediately
		// cancels the session-load settle window (3 s after
		// setupSessionSubscription) and the stick-to-bottom flag. Without an
		// explicit user-intent gesture, the ResizeObserver re-pin tick during
		// the settle window can race the test's scroll-up and snap us back
		// to the bottom, hiding the jump-to-bottom button — visible as a
		// Windows timeout flake.
		const clientHeight = await page.evaluate((sel) => {
			const el = document.querySelector(sel) as HTMLElement;
			const rect = el.getBoundingClientRect();
			(globalThis as any).__sclSel = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
			return el.clientHeight;
		}, scrollSel);
		expect(clientHeight).toBeGreaterThan(0);
		const pos = await page.evaluate(() => (globalThis as any).__sclSel);
		await page.mouse.move(pos.x, pos.y);
		await page.mouse.wheel(0, -Math.floor(clientHeight * 0.7));
		// Wait briefly so the wheel handler (_handleUserIntent) clears
		// _stickToBottom and the settle window BEFORE the programmatic scroll.
		// Without this, the evaluate() may run synchronously before the wheel
		// event is dispatched, leaving stickToBottom=true and allowing the
		// ResizeObserver settle-window to re-pin us to the bottom.
		await page.waitForFunction(() => {
			const ai = document.querySelector("agent-interface") as any;
			return ai && ai._stickToBottom === false;
		}, null, { timeout: 5_000 }).catch(() => { /* best-effort — proceed even if unavailable */ });
		// Belt-and-braces: also pin scrollTop programmatically in case the
		// trusted wheel event doesn't translate into the desired scroll delta
		// on this platform's scroll-step granularity. The wheel event itself
		// has already cleared _stickToBottom and the settle window via
		// _handleUserIntent.
		const scrollMetrics = await page.evaluate((sel) => {
			const el = document.querySelector(sel) as HTMLElement;
			const ch = el.clientHeight;
			el.scrollTop = el.scrollHeight - ch - Math.floor(ch * 0.6);
			el.dispatchEvent(new Event("scroll"));
			return { ch, sh: el.scrollHeight, st: el.scrollTop };
		}, scrollSel);
		expect(scrollMetrics.ch).toBeGreaterThan(0);
		expect(scrollMetrics.sh - scrollMetrics.st - scrollMetrics.ch).toBeGreaterThan(scrollMetrics.ch * 0.5);

		await page.waitForFunction(() => {
			const b = document.querySelector('[data-testid="jump-to-bottom"]') as HTMLElement | null;
			if (!b) return false;
			return b.style.opacity === "1" && b.style.pointerEvents === "auto";
		}, null, { timeout: 15_000 });
		await rec.capture("Scrolled up — jump-to-bottom visible");

		// 3. Scroll down within clientHeight * 0.4 of bottom → button hidden again.
		await page.evaluate((sel) => {
			const el = document.querySelector(sel) as HTMLElement;
			const ch = el.clientHeight;
			el.scrollTop = el.scrollHeight - ch - Math.floor(ch * 0.4) + 1;
			el.dispatchEvent(new Event("scroll"));
		}, scrollSel);
		await page.waitForFunction(() => {
			const b = document.querySelector('[data-testid="jump-to-bottom"]') as HTMLElement | null;
			if (!b) return false;
			return b.style.opacity === "0" && b.style.pointerEvents === "none";
		}, null, { timeout: 10_000 });
		await rec.capture("Scrolled near bottom — button hidden again");

		// 4. Scroll up again, click the button, assert it lands within 5 px
		//    of the bottom and stickToBottom is true.
		await page.evaluate((sel) => {
			const el = document.querySelector(sel) as HTMLElement;
			const ch = el.clientHeight;
			el.scrollTop = el.scrollHeight - ch - Math.floor(ch * 0.7);
			el.dispatchEvent(new Event("scroll"));
		}, scrollSel);
		await expect(btn).toBeVisible();
		// JS click avoids any need for the floating absolute element to be in
		// the visible viewport for Playwright's click stability heuristics.
		await page.evaluate(() => {
			const b = document.querySelector('[data-testid="jump-to-bottom"]') as HTMLElement | null;
			b?.click();
		});

		await page.waitForFunction((sel) => {
			const el = document.querySelector(sel) as HTMLElement;
			return el.scrollHeight - el.scrollTop - el.clientHeight <= 5;
		}, scrollSel, { timeout: 5_000 });
		await rec.capture("Clicked button — jumped to bottom");

		const stickAfter = await page.evaluate(() => {
			const ai = document.querySelector("agent-interface") as any;
			return ai?._stickToBottom;
		});
		expect(stickAfter, "click must re-arm _stickToBottom").toBe(true);

		// 5. Unmount the agent-interface and assert no console errors.
		await page.evaluate(() => {
			const ai = document.querySelector("agent-interface");
			ai?.parentNode?.removeChild(ai);
		});
		// Yield two animation frames to let disconnectedCallback run and surface
		// any errors. Two rAFs ≈ one paint cycle.
		await page.evaluate(() => new Promise<void>((resolve) => {
			requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
		}));

		// Filter out unrelated noise (favicon, network warnings) — only fail
		// on actual JS errors / our component's leak warnings. The git-status
		// widget hits 400 with `Not a git repository` in temp-dir fixtures; that
		// is the widget's documented contract, not an unmount leak. Also filter
		// known-benign 400 (Bad Request) responses that fire during teardown:
		// when we yank the <agent-interface> out of the DOM, in-flight session-
		// scoped requests (mark-read, git-status batch, proposal flushes) can
		// land against a session whose row was just torn down and the server
		// returns 400. The browser logs the failed fetch as a console error
		// even though it's a benign teardown race.
		const real = consoleErrors.filter((e) =>
			!/favicon|net::|404 \(Not Found\)|400 \(Bad Request\)|websocket|status of 400/i.test(e),
		);
		expect(real, `unexpected console errors after unmount: ${real.join(" | ")}`).toHaveLength(0);
		await rec.capture("Unmounted — no console errors");
	});
});
