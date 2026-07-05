/**
 * Manual (virtual) Clock for Test Suite v2.
 *
 * Implements the production `Clock` interface (see src/server/gateway-deps.ts)
 * but never schedules real host timers. Callbacks fire only when a test calls
 * `advance(ms)` (or `runAll()`), giving deterministic, wall-clock-free control
 * over every timer-driven subsystem the gateway injects a clock into
 * (nudgers, sweepers, heartbeats, backoff, bg-wait timeouts, …).
 *
 * This handle is TEST-ONLY. Production always resolves to `realClock`; the
 * gateway-deps default wiring never returns a manual clock.
 */
import type { Clock, TimerHandle } from "../../src/server/gateway-deps.js";

interface ScheduledTimer {
	id: number;
	due: number;
	interval?: number;
	handler: () => void;
	cleared: boolean;
}

export interface ManualClock extends Clock {
	/** Current virtual time in ms. */
	now(): number;
	/**
	 * Advance virtual time by `ms`, firing every timer whose due time falls at
	 * or before the new time, in strictly ascending (due, insertion) order.
	 * Intervals re-arm and re-fire while still within the advanced window.
	 */
	advance(ms: number): void;
	/**
	 * Drain all currently-pending timers regardless of due time, bounded by
	 * `maxIterations` so a self-rescheduling interval cannot spin forever.
	 */
	runAll(maxIterations?: number): void;
	/** Number of live (not cleared) timers. */
	pending(): number;
}

const MAX_ADVANCE_ITERATIONS = 100_000;

export function createManualClock(startMs: number = Date.now()): ManualClock {
	let virtualNow = startMs;
	let seq = 1;
	const timers = new Map<number, ScheduledTimer>();

	function schedule(handler: () => void, ms: number, interval?: number): TimerHandle {
		const id = seq++;
		const delay = Number.isFinite(ms) ? Math.max(0, ms) : 0;
		timers.set(id, { id, due: virtualNow + delay, interval, handler, cleared: false });
		// The production Clock signature returns an opaque TimerHandle. We encode
		// the numeric id and decode it in clear*; consumers only ever round-trip it.
		return id as unknown as TimerHandle;
	}

	function clear(handle: TimerHandle | undefined): void {
		if (handle === undefined || handle === null) return;
		const id = handle as unknown as number;
		const timer = timers.get(id);
		if (timer) timer.cleared = true;
		timers.delete(id);
	}

	function nextDueTimer(atOrBefore: number): ScheduledTimer | undefined {
		let best: ScheduledTimer | undefined;
		for (const timer of timers.values()) {
			if (timer.cleared || timer.due > atOrBefore) continue;
			if (!best || timer.due < best.due || (timer.due === best.due && timer.id < best.id)) {
				best = timer;
			}
		}
		return best;
	}

	return {
		now: () => virtualNow,
		setTimeout: (handler, ms) => schedule(handler, ms),
		setInterval: (handler, ms) => schedule(handler, ms, Number.isFinite(ms) ? Math.max(0, ms) : 0),
		clearTimeout: clear,
		clearInterval: clear,
		pending: () => {
			let count = 0;
			for (const timer of timers.values()) if (!timer.cleared) count++;
			return count;
		},
		advance(ms: number): void {
			const target = virtualNow + Math.max(0, ms);
			let guard = 0;
			for (;;) {
				const timer = nextDueTimer(target);
				if (!timer) break;
				virtualNow = timer.due;
				if (timer.interval !== undefined) {
					timer.due = virtualNow + timer.interval;
				} else {
					timers.delete(timer.id);
				}
				timer.handler();
				if (++guard > MAX_ADVANCE_ITERATIONS) {
					throw new Error("[manual-clock] advance exceeded iteration cap (runaway interval?)");
				}
			}
			virtualNow = target;
		},
		runAll(maxIterations = 10_000): void {
			let iterations = 0;
			while (timers.size > 0) {
				let earliest: ScheduledTimer | undefined;
				for (const timer of timers.values()) {
					if (timer.cleared) continue;
					if (!earliest || timer.due < earliest.due || (timer.due === earliest.due && timer.id < earliest.id)) {
						earliest = timer;
					}
				}
				if (!earliest) break;
				this.advance(Math.max(0, earliest.due - virtualNow));
				if (++iterations > maxIterations) {
					throw new Error("[manual-clock] runAll exceeded iteration cap (runaway interval?)");
				}
			}
		},
	};
}
