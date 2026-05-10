/**
 * Helpers for tying timers to an `AbortSignal`. Every timer registered
 * through `LifecycleTimers` is cleared automatically when the signal
 * aborts — typically when the owning `BobbitElement` is disconnected.
 *
 * See `docs/design/listener-cleanup-standardisation.md` §2.2.
 */

/** Run `fn` when `signal` aborts (or immediately if already aborted). */
export function onAbort(signal: AbortSignal, fn: () => void): void {
	if (signal.aborted) {
		fn();
		return;
	}
	signal.addEventListener("abort", fn, { once: true });
}

export class LifecycleTimers {
	constructor(private readonly signal: AbortSignal) {}

	setTimeout(fn: () => void, ms: number): number {
		const id = window.setTimeout(fn, ms);
		onAbort(this.signal, () => window.clearTimeout(id));
		return id;
	}

	setInterval(fn: () => void, ms: number): number {
		const id = window.setInterval(fn, ms);
		onAbort(this.signal, () => window.clearInterval(id));
		return id;
	}

	raf(fn: FrameRequestCallback): number {
		const id = window.requestAnimationFrame(fn);
		onAbort(this.signal, () => window.cancelAnimationFrame(id));
		return id;
	}
}
