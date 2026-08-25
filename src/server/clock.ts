export type TimerHandle = ReturnType<typeof globalThis.setTimeout>;

export interface Clock {
	now(): number;
	setTimeout(handler: () => void, ms: number): TimerHandle;
	setInterval(handler: () => void, ms: number): TimerHandle;
	clearTimeout(handle: TimerHandle): void;
	clearInterval(handle: TimerHandle): void;
}

// Node coerces non-finite and out-of-range delays to 1 ms, which can turn a
// long wait or interval into a tight loop. Keep real timers inside Node's
// signed 32-bit range; virtual test clocks retain their own delay semantics.
const MAX_REAL_TIMER_DELAY_MS = 2_147_483_647;

function normalizeRealTimerDelay(ms: number): number {
	if (!Number.isFinite(ms)) return MAX_REAL_TIMER_DELAY_MS;
	return Math.min(MAX_REAL_TIMER_DELAY_MS, Math.max(0, ms));
}

export const realClock: Clock = {
	now: () => Date.now(),
	setTimeout: (handler, ms) => {
		// codeql[js/resource-exhaustion] The generic Clock DI boundary receives internal durations, normalized to finite [0, 2^31-1] before this sink.
		return globalThis.setTimeout(handler, normalizeRealTimerDelay(ms));
	},
	setInterval: (handler, ms) => {
		// codeql[js/resource-exhaustion] The generic Clock DI boundary receives internal durations, normalized to finite [0, 2^31-1] before this sink.
		return globalThis.setInterval(handler, normalizeRealTimerDelay(ms));
	},
	clearTimeout: handle => globalThis.clearTimeout(handle),
	clearInterval: handle => globalThis.clearInterval(handle),
};
