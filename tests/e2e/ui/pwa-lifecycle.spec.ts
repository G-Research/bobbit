/**
 * Browser E2E — iOS PWA grey-screen recovery wiring (src/app/pwa-lifecycle.ts).
 *
 * True iOS standalone freeze/kill cannot be reproduced in a headless browser,
 * so this does NOT attempt that. It covers the automatable browser journey for
 * the recovery wiring:
 *   - standalone-gated `pageshow` (persisted) forces exactly one reload,
 *   - the cooldown / module guard prevents reload loops,
 *   - non-standalone pages never reload,
 *   - a live page survives a quick hidden→visible cycle without reloading
 *     (guards against regressing the existing visibility resync), and
 *   - the inline boot watchdog is cleared on a healthy boot.
 *
 * Standalone is injected before app scripts run (matchMedia override +
 * navigator.standalone). Forced reloads are observed via the production test
 * seam `window.__bobbitReloadHook` (see pwa-lifecycle.ts), which avoids real
 * navigation and the read-only Location object.
 */
import { test, expect, type Page } from "../gateway-harness.js";
import { openApp } from "./ui-helpers.js";

/** Inject a standalone-display signal + a reload observer before any app JS. */
async function injectStandaloneAndReloadSeam(page: Page): Promise<void> {
	await page.addInitScript(() => {
		// Observe forced reloads without navigating away.
		(window as any).__reloadCount = 0;
		(window as any).__bobbitReloadHook = () => {
			(window as any).__reloadCount = ((window as any).__reloadCount || 0) + 1;
		};
		// Report standalone display-mode true, preserving other media queries
		// (the theme bootstrap relies on prefers-color-scheme).
		const orig = window.matchMedia.bind(window);
		window.matchMedia = (q: string): MediaQueryList => {
			if (q === "(display-mode: standalone)") {
				return {
					matches: true,
					media: q,
					onchange: null,
					addEventListener() {},
					removeEventListener() {},
					addListener() {},
					removeListener() {},
					dispatchEvent() { return false; },
				} as unknown as MediaQueryList;
			}
			return orig(q);
		};
		try {
			Object.defineProperty(navigator, "standalone", { configurable: true, value: true });
		} catch { /* ignore */ }
	});
}

/** Reload observer only (no standalone) — for the negative case. */
async function injectReloadSeamOnly(page: Page): Promise<void> {
	await page.addInitScript(() => {
		(window as any).__reloadCount = 0;
		(window as any).__bobbitReloadHook = () => {
			(window as any).__reloadCount = ((window as any).__reloadCount || 0) + 1;
		};
	});
}

const reloadCount = (page: Page): Promise<number> =>
	page.evaluate(() => (window as any).__reloadCount || 0);

test.describe("PWA lifecycle recovery", () => {
	test("pageshow persisted forces exactly one reload in standalone, and writes the cooldown guard", async ({ page }) => {
		await injectStandaloneAndReloadSeam(page);
		await openApp(page);

		await page.evaluate(() => {
			window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
		});

		await expect.poll(() => reloadCount(page)).toBe(1);
		const guard = await page.evaluate(() => sessionStorage.getItem("bobbit-pwa-reload-at"));
		expect(guard).not.toBeNull();
		expect(Number(guard)).toBeGreaterThan(0);
	});

	test("cooldown / module guard prevents a second reload on a repeat persisted pageshow", async ({ page }) => {
		await injectStandaloneAndReloadSeam(page);
		await openApp(page);

		await page.evaluate(() => {
			window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
		});
		await expect.poll(() => reloadCount(page)).toBe(1);

		// Immediately fire a second persisted pageshow — still within cooldown
		// and the module `reloaded` flag is set → no second reload. The pageshow
		// handler runs synchronously inside dispatchEvent, so the count is final
		// the moment the evaluate resolves — no settle wait needed.
		await page.evaluate(() => {
			window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
		});
		expect(await reloadCount(page)).toBe(1);
	});

	test("non-standalone page never reloads on persisted pageshow", async ({ page }) => {
		await injectReloadSeamOnly(page);
		await openApp(page);

		// pageshow handling is synchronous; the count is final once evaluate resolves.
		await page.evaluate(() => {
			window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
		});
		expect(await reloadCount(page)).toBe(0);
	});

	test("live page survives a quick hidden→visible cycle without reloading", async ({ page }) => {
		await injectStandaloneAndReloadSeam(page);
		await openApp(page);

		// #app is mounted (Settings button visible via openApp).
		const mountedBefore = await page.evaluate(
			() => !!document.getElementById("app")?.children.length,
		);
		expect(mountedBefore).toBe(true);

		const probesBefore = await page.evaluate(() => (window as any).__bobbitResumeProbes ?? 0);

		// Simulate a quick background→foreground: hidden then visible.
		await page.evaluate(() => {
			const setVis = (v: string) =>
				Object.defineProperty(document, "visibilityState", { configurable: true, get: () => v });
			setVis("hidden");
			document.dispatchEvent(new Event("visibilitychange"));
			setVis("visible");
			document.dispatchEvent(new Event("visibilitychange"));
		});

		// Wait until the async resume probe has actually run (event-driven, not a
		// fixed sleep). Short gap + live heartbeat → the probe must NOT reload.
		await page.waitForFunction(
			(before) => ((window as any).__bobbitResumeProbes ?? 0) > before,
			probesBefore,
			{ timeout: 10_000 },
		);
		expect(await reloadCount(page)).toBe(0);
		const mountedAfter = await page.evaluate(
			() => !!document.getElementById("app")?.children.length,
		);
		expect(mountedAfter).toBe(true);
	});

	test("healthy boot clears the inline boot watchdog", async ({ page }) => {
		await injectStandaloneAndReloadSeam(page);
		await openApp(page);

		// markAppBooted() runs right after the first renderApp() and clears the
		// index.html boot watchdog. No reload should have been requested.
		await expect
			.poll(() => page.evaluate(() => (window as any).__bobbitBootWatchdog ?? null))
			.toBeNull();
		expect(await reloadCount(page)).toBe(0);
	});
});
