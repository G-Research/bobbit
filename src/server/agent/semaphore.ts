/**
 * Async counting semaphore for limiting concurrent operations.
 * Used by VerificationHarness to prevent resource exhaustion when
 * multiple goals verify simultaneously.
 */
export class Semaphore {
	private _value: number;
	private _capacity: number;
	private _waiters: Array<() => void> = [];
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
			while (delta > 0 && this._waiters.length > 0) {
				const w = this._waiters.shift();
				if (w) w();
				delta--;
			}
			this._value += delta;
		} else {
			let toRemove = -delta;
			const fromValue = Math.min(toRemove, this._value);
			this._value -= fromValue;
			this._debt += toRemove - fromValue;
		}
	}

	async acquire(): Promise<void> {
		if (this._value > 0) {
			this._value--;
			return;
		}
		return new Promise<void>(resolve => {
			this._waiters.push(resolve);
		});
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
		const next = this._waiters.shift();
		if (next) {
			next();
			return;
		}
		if (this._value >= this._capacity) {
			throw new Error(`Semaphore over-release: value would exceed capacity (${this._capacity})`);
		}
		this._value++;
	}
}
