import { test, expect, type Page } from "@playwright/test";
import path from "node:path";

/**
 * Unit tests for the PURE shouldReloadOnResume() decision function from
 * src/app/pwa-lifecycle.ts (the iOS PWA grey-screen recovery logic).
 *
 * Uses a file:// fixture that inlines the function (kept in sync with source).
 *
 * Run with:
 *   npx playwright test tests/pwa-lifecycle.spec.ts --config tests/playwright.config.ts
 */

const FIXTURE = "file://" + path.resolve("tests/fixtures/pwa-lifecycle.html").replace(/\\/g, "/");

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

test.describe("shouldReloadOnResume", () => {
	let page: Page;

	test.beforeAll(async ({ browser }) => {
		page = await browser.newPage();
		await page.goto(FIXTURE);
	});

	test.afterAll(async () => {
		await page.close();
	});

	const decide = (a: Args): Promise<boolean> =>
		page.evaluate((x) => (window as any).shouldReloadOnResume(x), a);

	test("loop guard overrides all — within cooldown never reloads, even when unmounted", async () => {
		// Not mounted (would otherwise reload) but within cooldown → false.
		const a = args({ appMounted: false, lastReloadAtMs: T0 + 1000, nowMs: T0 + 1500 });
		expect(await decide(a)).toBe(false);
	});

	test("loop guard does NOT block once the cooldown has elapsed", async () => {
		const a = args({ appMounted: false, lastReloadAtMs: T0, nowMs: T0 + COOLDOWN });
		expect(await decide(a)).toBe(true);
	});

	test("dead bootstrap — !appMounted reloads", async () => {
		expect(await decide(args({ appMounted: false }))).toBe(true);
	});

	test("live mounted page — heartbeat advanced after resume never reloads, regardless of gap", async () => {
		// Very long suspend, but heartbeat advanced past resume → alive → no reload.
		const a = args({
			appMounted: true,
			hiddenAtMs: T0 - 10 * STALE,
			resumeAtMs: T0,
			lastAliveMs: T0 + 16, // ticked ~one frame after resume
			nowMs: T0 + 1500,
		});
		expect(await decide(a)).toBe(false);
	});

	test("mounted-but-frozen — long gap + stale (null) heartbeat reloads", async () => {
		const a = args({
			appMounted: true,
			hiddenAtMs: T0 - STALE,
			resumeAtMs: T0,
			lastAliveMs: null,
			nowMs: T0 + 1500,
		});
		expect(await decide(a)).toBe(true);
	});

	test("mounted-but-frozen — long gap + heartbeat not advanced (<= resume) reloads", async () => {
		const a = args({
			appMounted: true,
			hiddenAtMs: T0 - STALE,
			resumeAtMs: T0,
			lastAliveMs: T0, // exactly at resume — not advanced
			nowMs: T0 + 1500,
		});
		expect(await decide(a)).toBe(true);
	});

	test("short suspend — stale heartbeat but gap below threshold never reloads (quick switch)", async () => {
		const a = args({
			appMounted: true,
			hiddenAtMs: T0 - 1000, // 1s suspend
			resumeAtMs: T0,
			lastAliveMs: null,
			nowMs: T0 + 1500,
		});
		expect(await decide(a)).toBe(false);
	});

	test("boundary — gap exactly at staleThreshold counts as long (reloads with stale heartbeat)", async () => {
		const a = args({
			appMounted: true,
			hiddenAtMs: T0 - STALE, // gap === threshold at nowMs = resume; use nowMs = hiddenAt + STALE
			resumeAtMs: T0,
			lastAliveMs: null,
			nowMs: T0, // nowMs - hiddenAtMs === STALE exactly
		});
		expect(await decide(a)).toBe(true);
	});

	test("boundary — gap one ms below threshold does not reload", async () => {
		const a = args({
			appMounted: true,
			hiddenAtMs: T0 - (STALE - 1),
			resumeAtMs: T0,
			lastAliveMs: null,
			nowMs: T0,
		});
		expect(await decide(a)).toBe(false);
	});

	test("boundary — hiddenAtMs null never qualifies as a long suspend", async () => {
		const a = args({
			appMounted: true,
			hiddenAtMs: null,
			resumeAtMs: T0,
			lastAliveMs: null,
			nowMs: T0 + 10 * STALE,
		});
		expect(await decide(a)).toBe(false);
	});

	test("loop guard at the exact cooldown boundary does not block (>= cooldown allowed)", async () => {
		// nowMs - lastReloadAtMs === reloadCooldownMs → NOT within cooldown → may reload.
		const a = args({ appMounted: false, lastReloadAtMs: T0, nowMs: T0 + COOLDOWN });
		expect(await decide(a)).toBe(true);
	});
});
