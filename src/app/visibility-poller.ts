/**
 * Visibility-aware polling helper (PERF-04).
 *
 * The codebase's established pattern for a background-tab-safe poller is two
 * halves duplicated ad hoc at every call site: guard the `setInterval` body
 * with `if (document.visibilityState !== "visible") return;`, and register a
 * separate `document.addEventListener("visibilitychange", ...)` listener that
 * fires an immediate refresh the moment the tab becomes visible again (so
 * there's no staleness window up to the next natural tick). See api.ts
 * (session poll / PR poll), session-manager.ts (chat git-status poll),
 * main.ts (preferences resync), and goal-dashboard.ts's own git-status poll
 * for five independent hand-written copies of exactly this pattern.
 *
 * This factors both halves into one call so new pollers can't omit either
 * half. It intentionally does NOT change the visible-tab cadence: while
 * visible, `tick` still runs once per `intervalMs`, unchanged.
 *
 * Never reintroduce a bare `setInterval` for a dashboard/gateway poller
 * without routing it through this helper (PERF-04) — the failure mode is a
 * hidden tab sustaining ~1 request/second indefinitely.
 */

export interface VisibilityAwarePoller {
	/** Clears the interval and removes the visibilitychange listener. Idempotent. */
	stop(): void;
}

function isVisible(): boolean {
	return typeof document === "undefined" || document.visibilityState === "visible";
}

/**
 * Runs `tick` on a `setInterval(intervalMs)` cadence, but only while the tab
 * is visible — the callback is skipped (not queued) on ticks that land while
 * hidden. When the tab regains visibility, `tick` fires immediately once
 * (in addition to, not instead of, the regular cadence) so a dashboard that
 * was backgrounded for several intervals catches up right away instead of
 * waiting out a stale window.
 */
export function createVisibilityAwarePoller(
	tick: () => void | Promise<void>,
	intervalMs: number,
): VisibilityAwarePoller {
	const onTick = () => {
		if (!isVisible()) return;
		void tick();
	};
	const onVisibilityChange = () => {
		if (isVisible()) void tick();
	};

	const timer = setInterval(onTick, intervalMs);
	if (typeof document !== "undefined") {
		document.addEventListener("visibilitychange", onVisibilityChange);
	}

	return {
		stop(): void {
			clearInterval(timer);
			if (typeof document !== "undefined") {
				document.removeEventListener("visibilitychange", onVisibilityChange);
			}
		},
	};
}

/**
 * Cheap "did the payload change" check for small polling responses (a
 * handful of tasks/gates/agents). Returns true when `next` differs from
 * `prev` — i.e. the caller should apply `next` and re-render. Pure and
 * dependency-free so poll callbacks can skip `renderApp()` when the server
 * returned the same data (PERF-04's other half: gating render, not just
 * fetch).
 */
export function hasPollDiff<T>(prev: T, next: T): boolean {
	return JSON.stringify(prev) !== JSON.stringify(next);
}
