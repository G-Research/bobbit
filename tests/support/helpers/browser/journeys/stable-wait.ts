/**
 * Observable-state wait helpers for tier-2 browser fixture specs.
 *
 * These replace arbitrary `page.waitForTimeout(...)` sleeps with waits on
 * real, observable conditions so tests settle deterministically under CPU
 * contention instead of racing a wall-clock guess.
 */
import type { Page } from "@playwright/test";

/**
 * Wait until a scroll container's `scrollTop` AND `scrollHeight` are stable
 * across two consecutive samples ~`sampleMs` apart.
 *
 * Use this after an action that may trigger asynchronous scroll adjustment
 * (scroll events, ResizeObserver re-pins, browser scroll clamping) — it
 * returns once the container has demonstrably settled, so a follow-up
 * "scrollTop did (not) change" assertion reads post-settle state.
 */
export async function waitForStableScroll(
	page: Page,
	selector: string,
	opts?: { timeout?: number; sampleMs?: number },
): Promise<void> {
	const timeout = opts?.timeout ?? 10_000;
	const sampleMs = opts?.sampleMs ?? 100;
	await page.waitForFunction(
		({ sel, interval }) => {
			const el = document.querySelector(sel) as HTMLElement | null;
			if (!el) return false;
			const w = window as unknown as Record<string, { top: number; height: number; since: number } | undefined>;
			const key = `__stableScroll:${sel}`;
			const now = performance.now();
			const rec = w[key];
			if (!rec || rec.top !== el.scrollTop || rec.height !== el.scrollHeight) {
				w[key] = { top: el.scrollTop, height: el.scrollHeight, since: now };
				return false;
			}
			return now - rec.since >= interval;
		},
		{ sel: selector, interval: sampleMs },
		{ timeout, polling: Math.min(sampleMs, 100) },
	);
	// Reset the sample marker so a later call re-samples from scratch instead
	// of instantly succeeding on stale state.
	await page.evaluate((sel) => {
		delete (window as unknown as Record<string, unknown>)[`__stableScroll:${sel}`];
	}, selector);
}

/**
 * Wait for `frames` requestAnimationFrame ticks in the page.
 *
 * A frame boundary guarantees that pending scroll events and ResizeObserver
 * callbacks scheduled by a preceding DOM mutation have been delivered (both
 * run in the frame's update-the-rendering steps, before rAF callbacks of the
 * following frame). Unlike a wall-clock sleep this stretches naturally with
 * CPU contention.
 */
export async function waitForFrames(page: Page, frames = 2): Promise<void> {
	await page.evaluate(
		(n) =>
			new Promise<void>((resolve) => {
				const tick = (left: number): void => {
					if (left <= 0) {
						resolve();
						return;
					}
					requestAnimationFrame(() => tick(left - 1));
				};
				tick(n);
			}),
		frames,
	);
}
