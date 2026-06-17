/**
 * Browser E2E — pill strip overflow / wrap / promotion regressions.
 *
 * Pins the commit-claimed invariants from the pill-strip cleanup commit
 * ("Pill strip layout polish: fix promote-back, viewport-aware wrap,
 * sprite room"):
 *
 *   A. NARROW MODE (host <640 px, mobile portrait):
 *      - Strip wraps to AT MOST 2 rows; surplus pills go into "more".
 *      - Opening the "more" popover and dismissing visible pills lets
 *        hidden pills be promoted back into the strip. This is the
 *        original B-A1 regression: `_pillWidths` cache used to read
 *        `pillEl.parentElement.offsetWidth`, which for popover pills
 *        was the shared `.pill-more-popover` container; combined with
 *        the popover's default `align-items:stretch`, every hidden
 *        pill cached at the widest-pill width. The fix has TWO parts:
 *        cache the pill's own `offsetWidth` AND set `items-start` on
 *        the popover so flex doesn't stretch inline-flex children.
 *
 *   B. WIDE MODE (host ≥640 px, desktop/landscape):
 *      - Strip stays on a single row; overflow goes into "more".
 *
 *   C. The "X more" pill label never wraps to a second line.
 *
 * Implementation notes:
 *   - Pills are synthetic `bgProcesses` entries injected into the mounted
 *     `<agent-interface>`, because these assertions cover client-side layout
 *     and do not need real long-running subprocesses.
 *   - Pills are dismissed via the same property update path the UI's own
 *     dismiss handler uses (see `dismissBgProcess` in `src/app/session-manager.ts`).
 *   - Pill name padding (`qa-pill-xxxxxx-NN`) makes pill widths stable
 *     across host font fallbacks so the overflow precondition holds on
 *     varied CI hardware.
 *   - Settling waits use double-rAF, not `waitForTimeout` (per the
 *     "no fixed-duration sleeps" rule in `tests/e2e/ui/ui-helpers.ts`).
 */
import { test, expect } from "./fixtures.js";
import {
	createSession,
	waitForHealth,
	waitForSessionStatus,
	apiFetch,
} from "../e2e-setup.js";
import type { Page } from "@playwright/test";
import { openApp } from "./ui-helpers.js";

const padName = (i: number): string => `qa-pill-xxxxxx-${i.toString().padStart(2, "0")}`;

/** Two rAFs let Lit complete a render AND the rAF-coalesced measure. */
async function settleTwoRafs(page: Page): Promise<void> {
	await page.evaluate(
		() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
	);
}

/**
 * Seed synthetic bg-process pills directly into the mounted chat UI.
 *
 * These tests assert client-side layout/overflow behaviour. Spawning real
 * long-running subprocesses made the broad browser E2E suite spend minutes in
 * process setup/teardown and left expensive retries when a layout assertion
 * timed out, without increasing coverage of the pill layout code.
 */
async function seedPillsInUI(page: Page, count: number): Promise<string[]> {
	const startTime = Date.now();
	const processes = Array.from({ length: count }, (_, i) => ({
		id: `mock-bg-${i + 1}`,
		name: padName(i + 1),
		command: "mock long-running command",
		pid: 10_000 + i,
		status: "running" as const,
		exitCode: null,
		terminalReason: null,
		startTime: startTime + i,
		endTime: null,
	}));
	await page.evaluate(async (mockProcesses) => {
		await customElements.whenDefined("bg-process-pill");
		const ai = document.querySelector("agent-interface") as
			| (HTMLElement & { bgProcesses?: unknown[]; updateComplete?: Promise<unknown>; _measurePillOverflow?: () => void })
			| null;
		if (!ai) throw new Error("agent-interface not mounted");
		ai.bgProcesses = mockProcesses;
		await ai.updateComplete;
	}, processes);
	await page.waitForFunction(
		() => Array.from(document.querySelectorAll("bg-process-pill"))
			.every((el) => (el as HTMLElement).offsetWidth > 0),
		{ timeout: 10_000 },
	);
	await page.evaluate(async () => {
		const ai = document.querySelector("agent-interface") as
			| (HTMLElement & { _measurePillOverflow?: () => void; updateComplete?: Promise<unknown> })
			| null;
		ai?._measurePillOverflow?.();
		await ai?.updateComplete;
	});
	await settleTwoRafs(page);
	return processes.map((p) => p.id);
}

/**
 * Optimistically remove pills from the UI by filtering them out of
 * `agent-interface.bgProcesses`. Mirrors what the UI's dismiss handler
 * does (`dismissBgProcess` in `src/app/session-manager.ts`). Triggers
 * Lit's reactivity → re-render → `_measurePillOverflow` → promotion.
 */
async function dismissPillsFromUI(page: Page, idsToRemove: string[]): Promise<void> {
	await page.evaluate(async (ids) => {
		const ai = document.querySelector("agent-interface") as
			| (HTMLElement & { bgProcesses?: Array<{ id: string }>; updateComplete?: Promise<unknown> })
			| null;
		if (!ai || !Array.isArray(ai.bgProcesses)) return;
		ai.bgProcesses = ai.bgProcesses.filter((p) => !ids.includes(p.id));
		await ai.updateComplete;
	}, idsToRemove);
}

/** Sanity check that the test's viewport produced the expected mode. */
async function expectMode(page: Page, expected: "narrow" | "wide"): Promise<void> {
	const expectedNarrow = expected === "narrow";
	await page.waitForFunction(
		(narrow) => {
			const viewportNarrow = !window.matchMedia("(min-width: 640px)").matches;
			const ai = document.querySelector("agent-interface") as ({ _isNarrow?: boolean } & HTMLElement) | null;
			return viewportNarrow === narrow && (!ai || ai._isNarrow === narrow);
		},
		expectedNarrow,
		{ timeout: 5_000 },
	);
	const isNarrow = await page.evaluate(
		() => !window.matchMedia("(min-width: 640px)").matches,
	);
	if (expected === "narrow") {
		expect(isNarrow, "test viewport should put _isNarrow=true").toBe(true);
	} else {
		expect(isNarrow, "test viewport should put _isNarrow=false").toBe(false);
	}
}

test.describe("pill strip overflow — promote-back, wrap policy, label nowrap", () => {
	test.beforeAll(async () => {
		await waitForHealth();
	});

	// ─────────────────────────────────────────────────────────────────────
	// A. NARROW MODE (mobile portrait)
	// ─────────────────────────────────────────────────────────────────────
	test("narrow mode: hidden pills promote back into the strip after visible pills are dismissed (B-A1 regression)", async ({ page, rec }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");

		await openApp(page);
		await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });

		await page.setViewportSize({ width: 540, height: 800 });
		await expectMode(page, "narrow");

		const ids = await seedPillsInUI(page, 15);

		await expect(page.locator("[data-more-btn]")).toBeVisible({ timeout: 15_000 });
		await rec.capture("Narrow: strip rendered with overflow");

		const visibleBefore = await page.locator("bg-process-pill").count();
		expect(
			visibleBefore,
			"need at least 2 visible pills + a 'more' pill so the bug surface is exercised",
		).toBeGreaterThanOrEqual(2);
		expect(visibleBefore).toBeLessThan(15);

		const visiblePillIds = await page
			.locator("bg-process-pill[data-id]")
			.evaluateAll((els) => els.map((el) => el.getAttribute("data-id") ?? ""));

		// Open and close the "more" popover. Pre-fix this poisons the
		// width cache for every hidden pill — opening alone is enough.
		// We close by clicking the more button again (toggle) rather than
		// `page.mouse.click(corner)` which on narrow viewports hits the
		// sidebar's "Bobbit" home button and navigates the test away.
		const moreButton = page.locator("[data-more-btn] button").first();
		await moreButton.click();
		await expect(page.locator(".pill-more-popover")).toBeVisible({ timeout: 5_000 });
		await rec.capture("Narrow: 'more' popover open");
		await moreButton.click();
		await expect(page.locator(".pill-more-popover")).toHaveCount(0, { timeout: 5_000 });

		// Dismiss the visible pills (UI path — same as clicking X).
		await dismissPillsFromUI(page, visiblePillIds);
		await settleTwoRafs(page);

		// Promotion should fill the strip back up. Pre-fix the cache
		// holds inflated widths and the algorithm refuses to promote,
		// collapsing visibleAfter to 1 (always-at-least-1 fallback).
		await page.waitForFunction(
			(target: number) =>
				document.querySelectorAll("bg-process-pill").length >= target,
			visibleBefore,
			{ timeout: 10_000 },
		);
		const visibleAfter = await page.locator("bg-process-pill").count();
		await rec.capture(`Narrow: post-dismiss \u2014 ${visibleAfter} pills visible (was ${visibleBefore})`);

		expect(
			visibleAfter,
			`narrow-mode promote-back failed (visibleBefore=${visibleBefore}, visibleAfter=${visibleAfter}); ` +
				`pre-fix this collapses to 1 because _pillWidths cached the popover container width for every hidden pill`,
		).toBeGreaterThanOrEqual(visibleBefore);

		await teardown(sessionId);
	});

	test("narrow mode: strip never wraps to more than 2 rows even with many pills", async ({ page }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");

		await openApp(page);
		await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });
		await page.setViewportSize({ width: 540, height: 800 });
		await expectMode(page, "narrow");

		await seedPillsInUI(page, 15);

		await expect(page.locator("[data-more-btn]")).toBeVisible({ timeout: 15_000 });

		// Strip height must be ≤ (2 × pill-h + gap + small slack).
		// --pill-h is 22 px; gap-1.5 ≈ 6 px; allow a few extra px for
		// drop-shadow + sub-pixel rounding.
		const stripHeight = await page.locator("[data-pill-strip]").evaluate(
			(el) => (el as HTMLElement).offsetHeight,
		);
		expect(
			stripHeight,
			`narrow-mode strip wrapped beyond 2 rows (offsetHeight=${stripHeight}px). ` +
				`The 0.75 \u00d7 1.85 budget should cap at 2 rows worth of capacity.`,
		).toBeLessThanOrEqual(2 * 22 + 6 + 8);

		await teardown(sessionId);
	});

	// ─────────────────────────────────────────────────────────────────────
	// B. WIDE MODE (desktop / landscape) — required by AGENTS.md
	// ─────────────────────────────────────────────────────────────────────
	test("wide mode: strip stays on a single row even with many pills", async ({ page }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");

		await openApp(page);
		await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });

		// 1400 × 800 \u2014 wide enough that even with the sidebar the host
		// container is comfortably ≥640 px so `_isNarrow=false`.
		await page.setViewportSize({ width: 1400, height: 800 });
		await expectMode(page, "wide");

		await seedPillsInUI(page, 12);

		await expect(page.locator("[data-more-btn]")).toBeVisible({ timeout: 15_000 });

		// The strip MUST stay on a single pill-row in wide mode. Pre-fix
		// (flex-wrap) it would wrap onto a second row during the brief
		// Infinity-then-measured initial paint frame.
		const stripHeight = await page.locator("[data-pill-strip]").evaluate(
			(el) => (el as HTMLElement).offsetHeight,
		);
		expect(
			stripHeight,
			`wide-mode strip wrapped to multiple rows (offsetHeight=${stripHeight}px). ` +
				`flex-nowrap should hold this at one row.`,
		).toBeLessThanOrEqual(22 + 6);

		// Overflow goes into the "more" popover, not onto a second row.
		const visible = await page.locator("bg-process-pill").count();
		expect(visible).toBeLessThan(12);
		expect(visible).toBeGreaterThanOrEqual(1);

		await teardown(sessionId);
	});

	test("wide mode: hidden pills promote back into the strip after visible pills are dismissed", async ({ page }) => {
		// Same B-A1 surface as the narrow-mode test, but exercised on
		// desktop. The cache poisoning + popover-stretch interaction is
		// orthogonal to the wrap mode, so the regression can hit either.
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");

		await openApp(page);
		await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });
		await page.setViewportSize({ width: 1400, height: 800 });
		await expectMode(page, "wide");

		const ids = await seedPillsInUI(page, 14);

		await expect(page.locator("[data-more-btn]")).toBeVisible({ timeout: 15_000 });

		const visibleBefore = await page.locator("bg-process-pill").count();
		expect(visibleBefore).toBeGreaterThanOrEqual(2);
		expect(visibleBefore).toBeLessThan(14);

		const visiblePillIds = await page
			.locator("bg-process-pill[data-id]")
			.evaluateAll((els) => els.map((el) => el.getAttribute("data-id") ?? ""));

		const moreBtnWide = page.locator("[data-more-btn] button").first();
		await moreBtnWide.click();
		await expect(page.locator(".pill-more-popover")).toBeVisible({ timeout: 5_000 });
		await moreBtnWide.click();
		await expect(page.locator(".pill-more-popover")).toHaveCount(0, { timeout: 5_000 });

		await dismissPillsFromUI(page, visiblePillIds);
		await settleTwoRafs(page);

		await page.waitForFunction(
			(target: number) =>
				document.querySelectorAll("bg-process-pill").length >= target,
			visibleBefore,
			{ timeout: 10_000 },
		);
		const visibleAfter = await page.locator("bg-process-pill").count();
		expect(
			visibleAfter,
			`wide-mode promote-back failed (visibleBefore=${visibleBefore}, visibleAfter=${visibleAfter})`,
		).toBeGreaterThanOrEqual(visibleBefore);

		await teardown(sessionId);
	});

	// ─────────────────────────────────────────────────────────────────────
	// C. "X MORE" PILL LABEL
	// ─────────────────────────────────────────────────────────────────────
	test("'X more' pill label stays on a single line", async ({ page }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");

		await openApp(page);
		await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });
		await page.setViewportSize({ width: 540, height: 800 });
		await expectMode(page, "narrow");

		// Ten short synthetic pills can fit in the narrow two-row budget on some
		// font/CI combinations; use the same overflow-producing count as the
		// narrow wrap-policy tests so the label assertion's precondition is stable.
		await seedPillsInUI(page, 15);

		const moreBtn = page.locator("[data-more-btn]");
		await expect(moreBtn).toBeVisible({ timeout: 15_000 });

		// Visual outcome assertion: the more pill button stays at a
		// single line of content height. If `whitespace-nowrap`
		// regressed and the label wrapped to two lines, this doubles.
		const buttonHeight = await moreBtn.locator("button").first().evaluate(
			(el) => (el as HTMLElement).offsetHeight,
		);
		expect(
			buttonHeight,
			`'X more' label wrapped to multiple lines (offsetHeight=${buttonHeight}px). ` +
				`whitespace-nowrap should keep it on one line.`,
		).toBeLessThanOrEqual(24); // 22 px pill-h + 2 px epsilon

		await teardown(sessionId);
	});
});

async function teardown(sessionId: string): Promise<void> {
	await apiFetch(`/api/sessions/${sessionId}`, { method: "DELETE" }).catch(() => {});
}
