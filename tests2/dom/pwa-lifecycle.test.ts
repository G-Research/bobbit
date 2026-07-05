import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/pwa-lifecycle.spec.ts (v2-dom tier).
// The legacy Playwright fixture inlined a hand-copied shouldReloadOnResume() and
// had a drift guard asserting the copy matched source. Here we import and drive
// the REAL shouldReloadOnResume() from src/app/pwa-lifecycle.ts directly (higher
// fidelity — the source IS the single source of truth), so the fixture/source
// drift guard is obsolete and omitted. All behavioral cases are preserved.
import { describe, expect, it } from "vitest";
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
