export type TimerHandle = ReturnType<typeof globalThis.setTimeout>;

export interface Clock {
	now(): number;
	setTimeout(handler: () => void, ms: number): TimerHandle;
	setInterval(handler: () => void, ms: number): TimerHandle;
	clearTimeout(handle: TimerHandle): void;
	clearInterval(handle: TimerHandle): void;
}

export const realClock: Clock = {
	now: () => Date.now(),
	setTimeout: (handler, ms) => globalThis.setTimeout(handler, ms),
	setInterval: (handler, ms) => globalThis.setInterval(handler, ms),
	clearTimeout: handle => globalThis.clearTimeout(handle),
	clearInterval: handle => globalThis.clearInterval(handle),
};
