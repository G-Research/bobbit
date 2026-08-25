import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_helpers/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/pwa-lifecycle.spec.ts (v2-dom tier).
// The legacy Playwright fixture inlined a hand-copied shouldReloadOnResume() and
// had a drift guard asserting the copy matched source. Here we import and drive
// the REAL shouldReloadOnResume() from src/app/pwa-lifecycle.ts directly (higher
// fidelity — the source IS the single source of truth), so the fixture/source
// drift guard is obsolete and omitted. All behavioral cases are preserved.
import { describe, expect, it, vi } from "vitest";
import { shouldReloadOnResume } from "../../src/app/pwa-lifecycle.js";

const STALE = 30 * 60 * 1000; // 30 min
const COOLDOWN = 10_000; // 10 s
const T0 = 1_000_000_000_000; // arbitrary epoch base

type Args = {
	appMounted: boolean;
	hiddenAtMs: number | null;
	resumeAtMs: number;
	lastAliveMs: number | null;
	nowMs: number;
	lastReloadAtMs: number | null;
	staleThresholdMs: number;
	reloadCooldownMs: number;
};

function args(overrides: Partial<Args> = {}): Args {
	return {
		appMounted: true,
		hiddenAtMs: null,
		resumeAtMs: T0,
		lastAliveMs: null,
		nowMs: T0 + 1500,
		lastReloadAtMs: null,
		staleThresholdMs: STALE,
		reloadCooldownMs: COOLDOWN,
		...overrides,
	};
}

describe("shouldReloadOnResume", () => {
	const decide = (a: Args): boolean => shouldReloadOnResume(a);

	it("loop guard overrides all — within cooldown never reloads, even when unmounted", () => {
		// Not mounted (would otherwise reload) but within cooldown → false.
		const a = args({ appMounted: false, lastReloadAtMs: T0 + 1000, nowMs: T0 + 1500 });
		expect(decide(a)).toBe(false);
	});

	it("loop guard does NOT block once the cooldown has elapsed", () => {
		const a = args({ appMounted: false, lastReloadAtMs: T0, nowMs: T0 + COOLDOWN });
		expect(decide(a)).toBe(true);
	});

	it("dead bootstrap — !appMounted reloads", () => {
		expect(decide(args({ appMounted: false }))).toBe(true);
	});

	it("live mounted page — heartbeat advanced after resume never reloads, regardless of gap", () => {
		// Very long suspend, but heartbeat advanced past resume → alive → no reload.
		const a = args({
			appMounted: true,
			hiddenAtMs: T0 - 10 * STALE,
			resumeAtMs: T0,
			lastAliveMs: T0 + 16, // ticked ~one frame after resume
			nowMs: T0 + 1500,
		});
		expect(decide(a)).toBe(false);
	});

	it("mounted-but-frozen — long gap + stale (null) heartbeat reloads", () => {
		const a = args({
			appMounted: true,
			hiddenAtMs: T0 - STALE,
			resumeAtMs: T0,
			lastAliveMs: null,
			nowMs: T0 + 1500,
		});
		expect(decide(a)).toBe(true);
	});

	it("mounted-but-frozen — long gap + heartbeat not advanced (<= resume) reloads", () => {
		const a = args({
			appMounted: true,
			hiddenAtMs: T0 - STALE,
			resumeAtMs: T0,
			lastAliveMs: T0, // exactly at resume — not advanced
			nowMs: T0 + 1500,
		});
		expect(decide(a)).toBe(true);
	});

	it("short suspend — stale heartbeat but gap below threshold never reloads (quick switch)", () => {
		const a = args({
			appMounted: true,
			hiddenAtMs: T0 - 1000, // 1s suspend
			resumeAtMs: T0,
			lastAliveMs: null,
			nowMs: T0 + 1500,
		});
		expect(decide(a)).toBe(false);
	});

	it("boundary — gap exactly at staleThreshold counts as long (reloads with stale heartbeat)", () => {
		const a = args({
			appMounted: true,
			hiddenAtMs: T0 - STALE, // gap === threshold at nowMs = resume; use nowMs = hiddenAt + STALE
			resumeAtMs: T0,
			lastAliveMs: null,
			nowMs: T0, // nowMs - hiddenAtMs === STALE exactly
		});
		expect(decide(a)).toBe(true);
	});

	it("boundary — gap one ms below threshold does not reload", () => {
		const a = args({
			appMounted: true,
			hiddenAtMs: T0 - (STALE - 1),
			resumeAtMs: T0,
			lastAliveMs: null,
			nowMs: T0,
		});
		expect(decide(a)).toBe(false);
	});

	it("boundary — hiddenAtMs null never qualifies as a long suspend", () => {
		const a = args({
			appMounted: true,
			hiddenAtMs: null,
			resumeAtMs: T0,
			lastAliveMs: null,
			nowMs: T0 + 10 * STALE,
		});
		expect(decide(a)).toBe(false);
	});

	it("loop guard at the exact cooldown boundary does not block (>= cooldown allowed)", () => {
		// nowMs - lastReloadAtMs === reloadCooldownMs → NOT within cooldown → may reload.
		const a = args({ appMounted: false, lastReloadAtMs: T0, nowMs: T0 + COOLDOWN });
		expect(decide(a)).toBe(true);
	});
});

describe("installPwaLifecycleRecovery bounded resume work", () => {
	it("uses exact one-shot budgets and makes cleared competing callbacks inert", async () => {
		type RafCallback = FrameRequestCallback;
		type TimerCallback = () => void;
		const rafCallbacks = new Map<number, RafCallback>();
		const timerCallbacks = new Map<number, TimerCallback>();
		const activeRafs = new Set<number>();
		const activeTimers = new Set<number>();
		const cancelledRafs: number[] = [];
		const clearedTimers: number[] = [];
		let nextRaf = 1;
		let nextTimer = 1;
		let rafRequests = 0;
		let rafCallbackRuns = 0;
		let timerRequests = 0;
		let timerCallbackRuns = 0;
		let now = T0;

		const originalMatchMedia = Object.getOwnPropertyDescriptor(window, "matchMedia");
		const originalVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
		const originalBody = document.body.innerHTML;
		const originalReloadGuard = sessionStorage.getItem("bobbit-pwa-reload-at");
		const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
		vi.stubGlobal("requestAnimationFrame", (callback: RafCallback): number => {
			const handle = nextRaf++;
			rafRequests += 1;
			rafCallbacks.set(handle, callback);
			activeRafs.add(handle);
			return handle;
		});
		vi.stubGlobal("cancelAnimationFrame", (handle: number): void => {
			cancelledRafs.push(handle);
			activeRafs.delete(handle);
		});
		vi.stubGlobal("setTimeout", (callback: TimerHandler): number => {
			if (typeof callback !== "function") throw new Error("expected function timer");
			const handle = nextTimer++;
			timerRequests += 1;
			timerCallbacks.set(handle, callback as TimerCallback);
			activeTimers.add(handle);
			return handle;
		});
		vi.stubGlobal("clearTimeout", (handle: number): void => {
			clearedTimers.push(handle);
			activeTimers.delete(handle);
		});

		const runRaf = (handle: number): void => {
			const callback = rafCallbacks.get(handle);
			if (!callback) throw new Error(`missing rAF ${handle}`);
			activeRafs.delete(handle);
			rafCallbackRuns += 1;
			callback(now);
		};
		const runTimer = (handle: number): void => {
			const callback = timerCallbacks.get(handle);
			if (!callback) throw new Error(`missing timer ${handle}`);
			activeTimers.delete(handle);
			timerCallbackRuns += 1;
			callback();
		};
		const dispatchResume = (): void => {
			document.dispatchEvent(new Event("resume"));
		};
		const dispatchHidden = (): void => {
			window.dispatchEvent(new Event("pagehide"));
		};

		try {
			// Load a fresh real module instance so exercising its idempotent installer
			// cannot mutate the statically imported decision module's state.
			vi.resetModules();
			const { installPwaLifecycleRecovery } = await import("../../src/app/pwa-lifecycle.js");
			Object.defineProperty(window, "matchMedia", {
				configurable: true,
				value: (query: string) => ({ matches: query === "(display-mode: standalone)" }),
			});
			Object.defineProperty(document, "visibilityState", {
				configurable: true,
				value: "visible",
			});
			document.body.innerHTML = '<div id="app"><div>mounted</div></div>';
			sessionStorage.removeItem("bobbit-pwa-reload-at");
			window.__bobbitResumeProbes = 0;
			window.__bobbitHardReloads = 0;
			window.__bobbitReloadHook = () => undefined;

			installPwaLifecycleRecovery();

			// A visible standalone installation has no lifecycle frame or timer loop.
			expect({ rafRequests, timerRequests, activeRafs: activeRafs.size, activeTimers: activeTimers.size })
				.toEqual({ rafRequests: 0, timerRequests: 0, activeRafs: 0, activeTimers: 0 });

			// A long-suspended but healthy page gets exactly one frame and one timer.
			now = T0 - STALE - 2_000;
			dispatchHidden();
			now = T0;
			dispatchResume();
			expect({ rafRequests, timerRequests }).toEqual({ rafRequests: 1, timerRequests: 1 });
			runRaf(1); // Same-millisecond delivery must still count as post-resume liveness.
			now += 1_500;
			runTimer(1);
			expect({ rafCallbackRuns, timerCallbackRuns }).toEqual({ rafCallbackRuns: 1, timerCallbackRuns: 1 });
			expect(window.__bobbitResumeProbes).toBe(1);
			expect(window.__bobbitHardReloads).toBe(0);
			expect({ rafRequests, timerRequests, activeRafs: activeRafs.size, activeTimers: activeTimers.size })
				.toEqual({ rafRequests: 1, timerRequests: 1, activeRafs: 0, activeTimers: 0 });

			// A quick stalled resume remains bounded and does not qualify for reload.
			now += 10_000;
			dispatchHidden();
			now += 1_000;
			dispatchResume();
			expect({ rafRequests, timerRequests }).toEqual({ rafRequests: 2, timerRequests: 2 });
			now += 1_500;
			runTimer(2);
			expect(cancelledRafs).toContain(2);
			expect(window.__bobbitResumeProbes).toBe(2);
			expect(window.__bobbitHardReloads).toBe(0);
			expect({ rafCallbackRuns, timerCallbackRuns, activeRafs: activeRafs.size, activeTimers: activeTimers.size })
				.toEqual({ rafCallbackRuns: 1, timerCallbackRuns: 2, activeRafs: 0, activeTimers: 0 });

			// A newer resume clears the prior work. Even force-delivered stale
			// callbacks cannot satisfy, clear, or complete the newer generation.
			now += 10_000;
			dispatchHidden();
			now += 100;
			dispatchResume();
			const oldRaf = 3;
			const oldTimer = 3;
			now += 1;
			dispatchResume();
			const newRaf = 4;
			const newTimer = 4;
			expect(cancelledRafs).toContain(oldRaf);
			expect(clearedTimers).toContain(oldTimer);
			runRaf(oldRaf);
			runTimer(oldTimer);
			expect(window.__bobbitResumeProbes).toBe(2);
			expect(activeRafs.has(newRaf)).toBe(true);
			expect(activeTimers.has(newTimer)).toBe(true);
			runRaf(newRaf);
			now += 1_500;
			runTimer(newTimer);
			expect(window.__bobbitResumeProbes).toBe(3);
			expect(window.__bobbitHardReloads).toBe(0);
			expect({ rafRequests, timerRequests }).toEqual({ rafRequests: 4, timerRequests: 4 });

			// A qualifying long suspend whose one requested frame never arrives
			// completes one timer and requests exactly one guarded reload.
			now += 10_000;
			dispatchHidden();
			now += STALE;
			dispatchResume();
			expect({ rafRequests, timerRequests }).toEqual({ rafRequests: 5, timerRequests: 5 });
			now += 1_500;
			runTimer(5);
			expect(window.__bobbitResumeProbes).toBe(4);
			expect(window.__bobbitHardReloads).toBe(1);
			expect(cancelledRafs).toContain(5);
			expect({ rafRequests, rafCallbackRuns, timerRequests, timerCallbackRuns })
				.toEqual({ rafRequests: 5, rafCallbackRuns: 3, timerRequests: 5, timerCallbackRuns: 5 });
			expect({ activeRafs: activeRafs.size, activeTimers: activeTimers.size })
				.toEqual({ activeRafs: 0, activeTimers: 0 });

			// The module reload guard makes later resume signals schedule no work.
			dispatchResume();
			expect({ rafRequests, timerRequests }).toEqual({ rafRequests: 5, timerRequests: 5 });
		} finally {
			nowSpy.mockRestore();
			vi.unstubAllGlobals();
			vi.resetModules();
			if (originalMatchMedia) Object.defineProperty(window, "matchMedia", originalMatchMedia);
			else delete (window as { matchMedia?: unknown }).matchMedia;
			if (originalVisibility) Object.defineProperty(document, "visibilityState", originalVisibility);
			else delete (document as { visibilityState?: unknown }).visibilityState;
			document.body.innerHTML = originalBody;
			if (originalReloadGuard == null) sessionStorage.removeItem("bobbit-pwa-reload-at");
			else sessionStorage.setItem("bobbit-pwa-reload-at", originalReloadGuard);
			delete window.__bobbitReloadHook;
			delete window.__bobbitResumeProbes;
			delete window.__bobbitHardReloads;
			delete window.__bobbitLastReloadReason;
		}
	});
});
