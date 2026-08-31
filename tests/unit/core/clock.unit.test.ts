import { afterEach, describe, expect, it, vi } from "vitest";
import { realClock, type TimerHandle } from "../../../src/server/clock.js";

const MAX_REAL_TIMER_DELAY_MS = 2_147_483_647;

function timerHandle(): TimerHandle {
	return { unref: vi.fn() } as unknown as TimerHandle;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("realClock timer delay bounds", () => {
	it("passes ordinary and zero timeout delays through unchanged", () => {
		const handle = timerHandle();
		const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockReturnValue(handle);
		const handler = vi.fn();

		expect(realClock.setTimeout(handler, 125.5)).toBe(handle);
		realClock.setTimeout(handler, 0);

		expect(setTimeoutSpy).toHaveBeenNthCalledWith(1, handler, 125.5);
		expect(setTimeoutSpy).toHaveBeenNthCalledWith(2, handler, 0);
	});

	it.each([
		[Number.MAX_SAFE_INTEGER, MAX_REAL_TIMER_DELAY_MS],
		[Number.POSITIVE_INFINITY, MAX_REAL_TIMER_DELAY_MS],
		[Number.NaN, MAX_REAL_TIMER_DELAY_MS],
		[Number.NEGATIVE_INFINITY, MAX_REAL_TIMER_DELAY_MS],
		[-10, 0],
	])("normalizes timeout delay %s to %s", (input, expected) => {
		const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockReturnValue(timerHandle());
		const handler = vi.fn();

		realClock.setTimeout(handler, input);

		expect(setTimeoutSpy).toHaveBeenCalledWith(handler, expected);
	});

	it("applies the same bounds to intervals", () => {
		const setIntervalSpy = vi.spyOn(globalThis, "setInterval").mockReturnValue(timerHandle());
		const handler = vi.fn();

		realClock.setInterval(handler, Number.POSITIVE_INFINITY);
		realClock.setInterval(handler, -1);
		realClock.setInterval(handler, 250);

		expect(setIntervalSpy).toHaveBeenNthCalledWith(1, handler, MAX_REAL_TIMER_DELAY_MS);
		expect(setIntervalSpy).toHaveBeenNthCalledWith(2, handler, 0);
		expect(setIntervalSpy).toHaveBeenNthCalledWith(3, handler, 250);
	});

	it("forwards timer handles unchanged when clearing", () => {
		const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout").mockImplementation(() => undefined);
		const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval").mockImplementation(() => undefined);
		const handle = timerHandle();

		realClock.clearTimeout(handle);
		realClock.clearInterval(handle);

		expect(clearTimeoutSpy).toHaveBeenCalledWith(handle);
		expect(clearIntervalSpy).toHaveBeenCalledWith(handle);
	});
});
