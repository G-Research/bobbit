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

/**
 * Standalone + a reload observer whose counter lives in `sessionStorage`
 * (key `__test_reload_count`) so it SURVIVES a real `page.reload()`. The
 * window-scoped `__reloadCount` used by the same-instance tests is reset to 0
 * on every navigation; the persistent counter is the only seam that can prove
 * the `sessionStorage` cooldown guard (not the in-memory `reloaded` flag)
 * blocked a second reload after the module was torn down and re-created.
 *
 * addInitScript re-runs on every navigation (incl. after `page.reload()`), so
 * the hook is re-installed on the freshly-loaded page. The hook still does NOT
 * navigate.
 */
async function injectStandaloneAndPersistentReloadSeam(page: Page): Promise<void> {
	await page.addInitScript(() => {
		(window as any).__bobbitReloadHook = () => {
			const prev = Number(sessionStorage.getItem("__test_reload_count") || "0");
			sessionStorage.setItem("__test_reload_count", String(prev + 1));
		};
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

const reloadCount = (page: Page): Promise<number> =>
	page.evaluate(() => (window as any).__reloadCount || 0);

/** Read the reload counter that persists across a real reload (sessionStorage). */
const persistentReloadCount = (page: Page): Promise<number> =>
	page.evaluate(() => Number(sessionStorage.getItem("__test_reload_count") || "0"));

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

	test("sessionStorage cooldown guard survives a real reload and blocks a second reload", async ({ page }) => {
		await injectStandaloneAndPersistentReloadSeam(page);
		await openApp(page);

		// First persisted pageshow → one reload requested; the cooldown guard is
		// written to sessionStorage (and survives the upcoming real reload).
		await page.evaluate(() => {
			window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
		});
		await expect.poll(() => persistentReloadCount(page)).toBe(1);
		const guard = await page.evaluate(() => sessionStorage.getItem("bobbit-pwa-reload-at"));
		expect(guard).not.toBeNull();
		expect(Number(guard)).toBeGreaterThan(0);

		// Perform a REAL reload: the JS module is torn down and re-created, so the
		// in-memory `reloaded` flag resets to false. sessionStorage (the cooldown
		// guard AND our counter) survives. A Playwright reload + openApp completes
		// well within the 10s cooldown, so the guard is still active.
		await page.reload();
		await openApp(page);

		// Fire a persisted pageshow on the freshly-loaded page. The module flag is
		// false now, so only the persisted sessionStorage cooldown guard can block
		// the reload. Assert the count is STILL 1 — proving the guard, not the
		// module flag, prevented the second reload.
		await page.evaluate(() => {
			window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
		});
		// pageshow handling is synchronous, but poll briefly to rule out any race
		// before asserting no additional reload occurred.
		await expect.poll(() => persistentReloadCount(page)).toBe(1);
		expect(await persistentReloadCount(page)).toBe(1);
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

	test("document freeze/resume events drive the resume probe (listeners are on document, not window)", async ({ page }) => {
		await injectStandaloneAndReloadSeam(page);
		await openApp(page);

		const probesBefore = await page.evaluate(() => (window as any).__bobbitResumeProbes ?? 0);

		// Per the Page Lifecycle spec, `freeze`/`resume` are dispatched AT
		// `document` and do NOT bubble — so the handlers must be registered on
		// `document`. Dispatching here on `document` must reach them: freeze marks
		// hidden, resume schedules the liveness probe. If the listeners were on
		// `window` (the bug) these dispatches would never reach a handler and the
		// resume probe counter would never advance → this test FAILS.
		await page.evaluate(() => {
			document.dispatchEvent(new Event("freeze"));
			document.dispatchEvent(new Event("resume"));
		});

		// Event-driven wait: the resume path ran iff the probe counter advances.
		await page.waitForFunction(
			(before) => ((window as any).__bobbitResumeProbes ?? 0) > before,
			probesBefore,
			{ timeout: 10_000 },
		);
		// Short gap + live heartbeat → the probe must NOT reload a live page.
		expect(await reloadCount(page)).toBe(0);
	});

	test("healthy boot clears the inline boot watchdog", async ({ page }) => {
		await injectStandaloneAndReloadSeam(page);
		await openApp(page);

		// markAppBooted() defers clearing the index.html boot watchdog until #app
		// actually receives child content (a MutationObserver fires once Lit mounts
		// real content), so the watchdog clears shortly after the first paint. No
		// reload should have been requested.
		await expect
			.poll(() => page.evaluate(() => (window as any).__bobbitBootWatchdog ?? null))
			.toBeNull();
		expect(await reloadCount(page)).toBe(0);
	});
});
