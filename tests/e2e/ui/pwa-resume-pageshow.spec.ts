/**
 * Reproducing test for goal "Production-grade PWA resume" §6.3 + §9.2.
 *
 * Symptom: on iOS bfcache restore the browser fires a `pageshow` event with
 * `event.persisted === true` and does NOT fire `visibilitychange`. The app
 * has no `pageshow` listener anywhere (`grep -n "pageshow\|freeze\|resume\b" src/app/`
 * returns only comment-prose and the WS protocol-level `{type:"resume"}`),
 * so the WS is never poked and the in-memory state stays hours-stale.
 *
 * Fix (Stream A + Stream D):
 *   - `src/app/main.ts` and/or `src/app/remote-agent.ts` register a
 *     `window.addEventListener("pageshow", ...)` handler that
 *       (a) does NOT call `location.reload()`, and
 *       (b) kicks an immediate `_connectWs(false)` (fresh WebSocket open)
 *          when `event.persisted === true`.
 *
 * THIS TEST FAILS TODAY: there is no listener, so dispatching a synthetic
 * `pageshow {persisted:true}` event produces NO new WebSocket open. The
 * assertion fails with the literal `pageshow handler not registered` string.
 *
 * Run: `npx playwright test tests/e2e/ui/pwa-resume-pageshow.spec.ts --reporter=list`
 *
 * Expected error today (substring): `pageshow handler not registered`
 */
import { test, expect } from "../gateway-harness.js";
import { openApp, createSessionViaUI, sendMessage, waitForAgentResponse } from "./ui-helpers.js";

test.describe("PWA pageshow {persisted:true} → no reload, fresh WS open", () => {
	test("dispatches pageshow with persisted=true and asserts WS reconnect + no location.reload", async ({ page }) => {
		await openApp(page);
		await createSessionViaUI(page);
		await sendMessage(page, "hi");
		await waitForAgentResponse(page);

		// Install spies BEFORE dispatching the event:
		//   - count fresh WebSocket constructions
		//   - count location.reload calls
		await page.evaluate(() => {
			const w = window as any;
			w.__wsOpens = [];
			w.__reloadCalls = 0;

			const OrigWS = window.WebSocket;
			// Wrap to record every `new WebSocket(...)` after this point.
			const Wrapped: any = function (url: string | URL, protocols?: string | string[]) {
				w.__wsOpens.push({ url: String(url), at: Date.now() });
				return new (OrigWS as any)(url, protocols);
			};
			Wrapped.prototype = OrigWS.prototype;
			Wrapped.CONNECTING = OrigWS.CONNECTING;
			Wrapped.OPEN = OrigWS.OPEN;
			Wrapped.CLOSING = OrigWS.CLOSING;
			Wrapped.CLOSED = OrigWS.CLOSED;
			window.WebSocket = Wrapped;

			// Spy on location.reload.
			const origReload = window.location.reload.bind(window.location);
			Object.defineProperty(window.location, "reload", {
				configurable: true,
				value: function (...args: any[]) {
					w.__reloadCalls += 1;
					// Call through so the test's own page lifecycle isn't broken.
					try { return origReload(...args); } catch { /* ignore */ }
				},
			});
		});

		// Yield to the page so any in-flight startup-time WebSocket
		// constructions are captured before we take the baseline. Event-driven:
		// wait for the next animation frame instead of wall-clock sleeping.
		await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
		const baseline = await page.evaluate(() => ({
			ws: (window as any).__wsOpens.length,
			reloads: (window as any).__reloadCalls,
		}));

		// Dispatch the synthetic bfcache-restore event.
		await page.evaluate(() => {
			let evt: Event;
			try {
				evt = new (window as any).PageTransitionEvent("pageshow", { persisted: true, bubbles: true });
			} catch {
				// Some Chromium versions reject the constructor; fall back to a
				// plain Event with a `persisted` getter patched on.
				evt = new Event("pageshow", { bubbles: true });
				Object.defineProperty(evt, "persisted", { value: true });
			}
			window.dispatchEvent(evt);
		});

		// Allow up to 1.5 s for the handler to react and open a fresh WS.
		// Event-driven via page.waitForFunction (rAF-polled). If no new WS
		// opens within the budget, fall through and let the assertion below
		// produce the canonical "pageshow handler not registered" message.
		const baselineWs = baseline.ws;
		try {
			await page.waitForFunction(
				(prev: number) => ((window as any).__wsOpens.length as number) > prev,
				baselineWs,
				{ timeout: 1500, polling: "raf" },
			);
		} catch {
			/* deliberate: we want the failing assertion below */
		}
		const observed = await page.evaluate(() => ({
			ws: (window as any).__wsOpens.length,
			reloads: (window as any).__reloadCalls,
			lastWsUrls: ((window as any).__wsOpens as any[]).map((o) => o.url),
		}));

		const newWsOpens = observed.ws - baseline.ws;
		const newReloads = observed.reloads - baseline.reloads;

		// Must NOT reload.
		expect(
			newReloads,
			`pageshow handler not registered or wrong: location.reload was called ${newReloads}x after pageshow{persisted:true} (must never reload)`,
		).toBe(0);

		// MUST open a fresh WebSocket within ~1 s.
		expect(
			newWsOpens,
			`pageshow handler not registered — no new WebSocket open observed within 1.5s after pageshow{persisted:true} (urls captured: ${JSON.stringify(observed.lastWsUrls)})`,
		).toBeGreaterThan(0);
	});
});
