/**
 * Phase 3 perf budget E2E — sidebar navigation.
 *
 * Drives one warm session-nav and one warm goal-nav through the existing
 * gateway-harness fixture, reads `window.__bobbitPerf.entries()` after each,
 * and asserts that each of the five canonical gate spans has at least one
 * sample BELOW a generous regression-net budget.
 *
 * This is a regression net, not a flake trap. Budgets are derived from
 * `docs/perf/sidebar-nav-baseline.md` (commit 999bdc2e baseline, 2026-05-13)
 * but inflated well beyond p95/max so transient CI slowness never fails the
 * test. If a real regression lands, the budget will still trip.
 *
 * Test setup mirrors `tests/e2e/ui/settings.spec.ts` for boot pattern and
 * `tests/manual-integration/perf-sidebar-nav.spec.ts` for the perf-trace
 * enablement + sidebar-row click pattern.
 *
 * Scope (file ownership): this spec only. We do NOT touch `perf-trace.ts`,
 * instrumentation hooks, or `scripts/perf-report.mjs`.
 */
import { test, expect, type Page } from "../gateway-harness.js";
import {
	createSession,
	createGoal,
	deleteSession,
	deleteGoal,
	waitForSessionStatus,
	readE2ETokenAsync,
	base,
} from "../e2e-setup.js";
import { openApp } from "./ui-helpers.js";

// ---------------------------------------------------------------------------
// Budgets — derived GENEROUSLY from docs/perf/sidebar-nav-baseline.md
// (commit 999bdc2e, 2026-05-13). Each comment cites the source baseline
// number; the budget itself is ≥5× p95 (or ≥10× p50 / max) so transient
// CI slowness does not trip the assertion. Real regressions still trip.
// ---------------------------------------------------------------------------
const BUDGETS_MS: Record<string, number> = {
	// Baseline: p50 88.8, p95 193, max 310. Budget = 2000ms (≈10× p95).
	"nav.session.ready": 2000,
	// Baseline: p50 29.5, p95 30, max 45 (n=2 — sparse). Budget = 2000ms.
	"nav.goal.ready": 2000,
	// Baseline: p50 10.4, p95 31.6, max 33.1. Budget = 1500ms (≈47× p95).
	"api.session.fetch": 1500,
	// Baseline: p50 12.1, p95 12.1, max 14.9. Budget = 1500ms (≈100× p95).
	"api.goal.fetch": 1500,
	// Baseline: p50 0.1, p95 0.1 (seeded sessions have no transcript).
	// Budget = 500ms — leaves room for realistic transcripts later.
	"reducer.rehydrate": 500,
};

const CANONICAL_GATE_SPANS = Object.keys(BUDGETS_MS);

interface PerfEntry {
	name: string;
	t0: number;
	dur: number;
	detail?: Record<string, unknown>;
}

/**
 * Read all perf entries currently in the ring buffer, then clear it so the
 * next nav step's measurements are isolated.
 */
async function dumpAndClearEntries(page: Page): Promise<PerfEntry[]> {
	return page.evaluate(() => {
		const w = window as unknown as { __bobbitPerf?: {
			entries: () => PerfEntry[];
			clear: () => void;
		} };
		const entries = w.__bobbitPerf?.entries?.() ?? [];
		try { w.__bobbitPerf?.clear?.(); } catch { /* swallow */ }
		return entries as PerfEntry[];
	});
}

test.describe("Perf budgets — sidebar nav", () => {
	test("cold + warm session-nav + warm goal-nav stay under generous budgets", async ({ page }) => {
		test.setTimeout(90_000);

		// ── Seed: 1 session + 1 goal via REST helpers. We use the harness
		// default project (auto-injected by createSession/createGoal). No
		// agent spawn — we measure nav perf, not agent latency.
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		const goal = await createGoal({
			title: "Perf Budget E2E",
			worktree: false,
			team: false,
		});
		const goalId = goal.id as string;

		try {
			// Enable perf BEFORE any app script runs. perf-trace.ts caches the
			// `enabled` flag on first call, so flipping localStorage after page
			// load would be too late.
			await page.addInitScript(() => {
				try { localStorage.setItem("bobbitPerf", "1"); } catch { /* swallow */ }
			});

			// ── Cold session load (page.goto with #/session/:id) ─────
			// Captures `api.session.fetch` + `reducer.rehydrate` (warm sidebar
			// clicks skip the REST fetch because the session is already in
			// state.gatewaySessions — see session-manager.ts:891).
			const token = await readE2ETokenAsync();
			const appUrl = `${base()}/?token=${encodeURIComponent(token)}`;
			await page.goto(`${appUrl}#/session/${sessionId}`);
			// Cold load doesn't fire openForNavItem so `data-perf-ready` is never
			// set — wait for the chat-panel commit instead. The api.session.fetch
			// + reducer.rehydrate spans complete during this hydration window.
			await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });
			await page.locator("pi-chat-panel").first().waitFor({ state: "attached", timeout: 10_000 });
			// Wait for the two spans we care about (api.session.fetch +
			// reducer.rehydrate) to land in the ring buffer. Event-driven —
			// no fixed sleep — so we don't race the WS-snapshot/render cycle.
			await page.waitForFunction(() => {
				const w = window as unknown as { __bobbitPerf?: { entries: () => Array<{ name: string }> } };
				const es = w.__bobbitPerf?.entries?.() ?? [];
				return es.some((e) => e.name === "api.session.fetch")
					&& es.some((e) => e.name === "reducer.rehydrate");
			}, undefined, { timeout: 15_000 });
			const coldEntries = await dumpAndClearEntries(page);

			// Reset to landing for the warm passes; reuse openApp so we go
			// through the same auth + sidebar-load path the user sees.
			await openApp(page);

			// Sanity gate: if perf is gated off in this environment for any
			// reason (e.g. a future CI flag we don't anticipate), skip cleanly
			// with a clear reason rather than silently no-op'ing the asserts.
			const perfReady = await page.evaluate(() => {
				const w = window as unknown as { __bobbitPerf?: { isEnabled?: () => boolean } };
				return !!w.__bobbitPerf && w.__bobbitPerf.isEnabled?.() === true;
			});
			test.skip(
				!perfReady,
				"window.__bobbitPerf is unavailable or disabled — perf trace gated off in this environment",
			);

			// Wait for the sidebar to populate so the session row is clickable.
			const sessionRow = page.locator(`[data-nav-id="session:${sessionId}"]`).first();
			await expect(sessionRow).toBeVisible({ timeout: 20_000 });

			// Clear any boot-time entries so the session-nav measurement is
			// scoped to the click → ready transition only.
			await dumpAndClearEntries(page);

			// ── Warm session-nav ──────────────────────────────────────
			// Click the sidebar row (real user path — emits nav.click /
			// nav.session.ready via openForNavItem) and wait for the
			// data-perf-ready sentinel set by render.ts.
			await sessionRow.click();
			await page.waitForSelector('#app[data-perf-ready="session"]', { timeout: 15_000 });

			// Allow one more rAF so the deferred `.end()` (see render.ts
			// `requestAnimationFrame(() => pending.span.end(...))`) has fired
			// and the span is in the ring buffer.
			await page.evaluate(() => new Promise<void>((r) => {
				requestAnimationFrame(() => requestAnimationFrame(() => r()));
			}));
			const sessionEntries = await dumpAndClearEntries(page);

			// Reset the sentinel so the next nav can re-set it.
			await page.evaluate(() => {
				document.getElementById("app")?.removeAttribute("data-perf-ready");
			});

			// ── Warm goal-nav ─────────────────────────────────────────
			// Reveal + click the per-goal dashboard button (real user path —
			// emits nav.click / nav.goal.ready). Match the manual harness:
			// hover the goal row to surface the action overlay, then click.
			const goalRow = page.locator(`[data-nav-id="goal:${goalId}"]`).first();
			await expect(goalRow).toBeVisible({ timeout: 15_000 });
			await goalRow.hover();
			const dashBtn = page
				.locator(`[data-nav-action="goal-dashboard"][data-goal-id="${goalId}"]`)
				.first();
			// Force click — under headless Chromium the hover-revealed button
			// can still report as hidden by the layout engine even though it's
			// in the DOM and clickable.
			await dashBtn.click({ force: true });
			await page.waitForSelector('#app[data-perf-ready="goal"]', { timeout: 15_000 });
			await page.evaluate(() => new Promise<void>((r) => {
				requestAnimationFrame(() => requestAnimationFrame(() => r()));
			}));
			const goalEntries = await dumpAndClearEntries(page);

			// ── Assertions ────────────────────────────────────────────
			const all: PerfEntry[] = [...coldEntries, ...sessionEntries, ...goalEntries];
			const bySpan = new Map<string, number[]>();
			for (const e of all) {
				if (!bySpan.has(e.name)) bySpan.set(e.name, []);
				bySpan.get(e.name)!.push(e.dur);
			}

			// Helpful diagnostic when a budget trips — surface every span's
			// count + min so the failure message tells you what was actually
			// observed instead of just "expected … received undefined".
			const observed: Record<string, { n: number; min: number; max: number }> = {};
			for (const [name, durs] of bySpan) {
				observed[name] = {
					n: durs.length,
					min: Math.min(...durs),
					max: Math.max(...durs),
				};
			}

			for (const span of CANONICAL_GATE_SPANS) {
				const durs = bySpan.get(span) ?? [];
				expect(
					durs.length,
					`canonical span "${span}" had zero samples. observed=${JSON.stringify(observed)}`,
				).toBeGreaterThan(0);
				const fastest = Math.min(...durs);
				expect(
					fastest,
					`canonical span "${span}" fastest sample ${fastest.toFixed(1)}ms exceeds budget ${BUDGETS_MS[span]}ms. all_samples=${JSON.stringify(durs)}`,
				).toBeLessThan(BUDGETS_MS[span]);
			}
		} finally {
			await deleteGoal(goalId).catch(() => {});
			await deleteSession(sessionId).catch(() => {});
		}
	});
});
