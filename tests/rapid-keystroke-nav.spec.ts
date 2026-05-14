/**
 * Regression test for the dropped-keystroke bug surfaced in
 * docs/perf/sidebar-nav-baseline.md §5.6.
 *
 * Rapid Ctrl+↓ keystrokes landing on a live session row (whose
 * `connectToSession` is slow to commit the URL hash) used to drop
 * 3–4 keystrokes during the ~200 ms attach. Root cause: the buggy
 * `getActiveNavId` discarded `state.keyboardNavActiveId` whenever the
 * URL hash hadn't yet caught up to the override's expected hash, so
 * `navigateSidebar` re-derived the SAME source row across consecutive
 * presses and `openForNavItem` was invoked with the same id repeatedly.
 *
 * The fix trusts the override unconditionally in `getActiveNavId`;
 * the existing `installKeyboardNavOverrideClearListener` continues to
 * clear stale overrides whenever the URL ends up incompatible.
 *
 * This test pins the fix two ways:
 *   1. A behavioural mirror in `rapid-keystroke-nav.html` driven with
 *      both buggy and fixed `getActiveNavId` logic — the buggy variant
 *      must drop keystrokes; the fixed variant must not.
 *   2. A source-level assertion that `src/app/sidebar-nav.ts`'s
 *      `getActiveNavId` no longer gates the override on
 *      `window.location.hash === expected`.
 */
import { test, expect } from "@playwright/test";
import path from "node:path";
import { readFileSync } from "node:fs";

const FIXTURE = `file://${path.resolve("tests/rapid-keystroke-nav.html")}`;

test.describe("rapid Ctrl+↓ keystroke navigation", () => {
	test("buggy getActiveNavId drops keystrokes during slow attach (sanity)", async ({ page }) => {
		await page.goto(FIXTURE);
		const result = await page.evaluate(() =>
			(window as any).__runScenario(false, 6, 50)
		);
		// With the buggy gate, the first keystroke selects L (the live row
		// at the top, attach=200ms). While L's attach is in flight neither
		// the URL hash nor `selectedSessionId` reflect it, so `getActiveNavId`
		// discards the override and falls back to a cold start — every press
		// re-selects L until L's hash finally commits ~200ms later.
		expect(result.droppedKeystrokes).toBeGreaterThanOrEqual(2);
		expect(result.opened.filter((id: string) => id === "session:L").length)
			.toBeGreaterThanOrEqual(3);
	});

	test("fixed getActiveNavId advances one row per keystroke even mid-attach", async ({ page }) => {
		await page.goto(FIXTURE);
		const result = await page.evaluate(() =>
			(window as any).__runScenario(true, 6, 50)
		);
		// Six presses, six distinct rows opened in order: L is the first
		// (cold-start, top of sidebar) and A…E follow even though L's
		// 200ms attach is still in flight at every subsequent keystroke.
		expect(result.droppedKeystrokes).toBe(0);
		expect(result.distinctCount).toBe(6);
		expect(result.opened).toEqual([
			"session:L", "session:A", "session:B",
			"session:C", "session:D", "session:E",
		]);
	});

	test("fixed getActiveNavId holds up at aggressive cadence and deeper walks", async ({ page }) => {
		await page.goto(FIXTURE);
		const result = await page.evaluate(() =>
			(window as any).__runScenario(true, 10, 20)
		);
		expect(result.droppedKeystrokes).toBe(0);
		expect(result.distinctCount).toBe(10);
		// First keystroke must land on L (cold-start, top of sidebar), the
		// row whose slow attach used to break navigation entirely.
		expect(result.opened[0]).toBe("session:L");
	});

	test("src/app/sidebar-nav.ts pins the override-trust fix", () => {
		const src = readFileSync(
			path.resolve("src/app/sidebar-nav.ts"),
			"utf8",
		);
		// Pull the body of getActiveNavId — everything up to the next
		// top-level export — and assert it doesn't reinstate the
		// hash-equality gate. A future refactor that reintroduces the
		// buggy guard will fail this test.
		const match = src.match(
			/export function getActiveNavId\(\)[\s\S]*?\n\}\n/,
		);
		expect(match, "getActiveNavId not found in src/app/sidebar-nav.ts").not.toBeNull();
		const body = match![0];
		expect(
			body,
			"getActiveNavId must not gate the override on `window.location.hash === expected` — see docs/perf/sidebar-nav-baseline.md §5.6",
		).not.toMatch(/window\.location\.hash\s*===\s*expected/);
	});
});
