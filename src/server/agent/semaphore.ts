/**
 * Async counting semaphore for limiting concurrent operations.
 * Used by VerificationHarness to prevent resource exhaustion when
 * multiple goals verify simultaneously.
 */
type WaiterState = "queued" | "granted" | "aborted";

interface SemaphoreWaiter {
	resolve: () => void;
	reject: (reason?: unknown) => void;
	signal?: AbortSignal;
	onAbort?: () => void;
	state: WaiterState;
}

function abortReason(signal: AbortSignal): unknown {
	return signal.reason === undefined
		? new DOMException("The operation was aborted", "AbortError")
		: signal.reason;
}

export class Semaphore {
	private _value: number;
	private _capacity: number;
	private _waiters: SemaphoreWaiter[] = [];
	/**
	 * C2: "over-subscription debt". When the capacity is shrunk below the
	 * number of permits currently held, the surplus held permits cannot be
	 * revoked in-flight — instead they are recorded as debt and absorbed (one
	 * per `release()`) as holders finish, so `available` never goes negative
	 * and `release()` never throws a spurious over-release. Always `>= 0`.
	 */
	private _debt = 0;

	constructor(initial: number) {
		this._value = initial;
		this._capacity = initial;
	}

	get available(): number { return this._value; }
	get waiting(): number { return this._waiters.length; }
	get capacity(): number { return this._capacity; }

	/**
	 * Resize the live capacity (C2 — `PATCH /policy` lowering/raising the
	 * per-root subgoal concurrency cap must take effect on the already-cached
	 * semaphore, not just after a restart).
	 *
	 * Growing: pays down any outstanding debt first, then wakes blocked
	 * waiters, then adds the remainder to `available`.
	 *
	 * Shrinking: removes slots from `available` first; any shortfall (because
	 * permits are currently held) becomes debt that is paid down as holders
	 * `release()`. In-flight work is never interrupted — the cap only governs
	 * how many NEW permits may be acquired.
	 *
	 * `newCapacity` is floored to an integer and to a minimum of 1.
	 */
	resize(newCapacity: number): void {
		const next = Math.max(1, Math.floor(Number(newCapacity)));
		if (!Number.isFinite(next) || next === this._capacity) {
			if (Number.isFinite(next)) this._capacity = next;
			return;
		}
		let delta = next - this._capacity;
		this._capacity = next;
		if (delta > 0) {
			// Pay down debt first — those slots were already "owed".
			while (delta > 0 && this._debt > 0) { this._debt--; delta--; }
			// Hand the rest to blocked waiters before freeing slots.
			while (delta > 0 && this._grantNextWaiter()) delta--;
			this._value += delta;
		} else {
			let toRemove = -delta;
			const fromValue = Math.min(toRemove, this._value);
			this._value -= fromValue;
			this._debt += toRemove - fromValue;
		}
	}

	async acquire(signal?: AbortSignal): Promise<void> {
		// An already-cancelled request never observes or consumes capacity.
		if (signal?.aborted) throw abortReason(signal);
		if (this._value > 0) {
			this._value--;
			return;
		}
		return new Promise<void>((resolve, reject) => {
			const waiter: SemaphoreWaiter = {
				resolve,
				reject,
				signal,
				state: "queued",
			};
			this._waiters.push(waiter);

			if (signal) {
				waiter.onAbort = () => this._abortWaiter(waiter);
				signal.addEventListener("abort", waiter.onAbort, { once: true });
				// Covers an abort that happened after the entry check but before the
				// listener was installed. The state transition makes this idempotent.
				if (signal.aborted) waiter.onAbort();
			}
		});
	}

	/**
	 * Non-blocking acquire. Takes a permit and returns `true` iff one is
	 * immediately available; otherwise returns `false` WITHOUT queueing a
	 * waiter. Used by the unified child-team scheduler so a REST/POST spawn
	 * path can decide synchronously whether to start a child now or park it
	 * capacity-blocked. An over-subscribed semaphore (outstanding debt from a
	 * live shrink, so `_value === 0`) correctly returns `false`.
	 */
	tryAcquire(): boolean {
		if (this._value > 0) {
			this._value--;
			return true;
		}
		return false;
	}

	release(): void {
		// Absorb over-subscription debt from a prior shrink BEFORE waking any
		// waiter (C2). A live shrink (e.g. cap 3, 3 held, 1 waiting, resize→1)
		// records debt; the released permit must pay that debt down first, or
		// handing it to a queued waiter would keep the root over-subscribed
		// above the new cap. Only once `_debt === 0` may a waiter be woken.
		if (this._debt > 0) {
			this._debt--;
			return;
		}
		if (this._grantNextWaiter()) return;
		if (this._value >= this._capacity) {
			throw new Error(`Semaphore over-release: value would exceed capacity (${this._capacity})`);
		}
		this._value++;
	}

	private _abortWaiter(waiter: SemaphoreWaiter): void {
		if (waiter.state !== "queued") return;
		const index = this._waiters.indexOf(waiter);
		if (index < 0) return;

		// Remove by identity, not position captured at enqueue time: earlier
		// grants and cancellations may already have shifted the FIFO.
		this._waiters.splice(index, 1);
		waiter.state = "aborted";
		this._removeAbortListener(waiter);
		waiter.reject(abortReason(waiter.signal!));
	}

	private _grantNextWaiter(): boolean {
		let waiter: SemaphoreWaiter | undefined;
		while ((waiter = this._waiters.shift())) {
			// Cancelled waiters are removed eagerly, but the state guard keeps a
			// grant safe if cancellation and release/resize meet at the boundary.
			if (waiter.state !== "queued") continue;
			waiter.state = "granted";
			this._removeAbortListener(waiter);
			waiter.resolve();
			return true;
		}
		return false;
	}

	private _removeAbortListener(waiter: SemaphoreWaiter): void {
		if (!waiter.signal || !waiter.onAbort) return;
		waiter.signal.removeEventListener("abort", waiter.onAbort);
		waiter.onAbort = undefined;
	}
}
