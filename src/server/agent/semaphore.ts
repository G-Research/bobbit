/**
 * Async counting semaphore for limiting concurrent operations.
 * Used by VerificationHarness to prevent resource exhaustion when
 * multiple goals verify simultaneously.
 */
export class Semaphore {
	private _value: number;
	private readonly _capacity: number;
	private _waiters: Array<() => void> = [];

	constructor(initial: number) {
		this._value = initial;
		this._capacity = initial;
	}

	get available(): number { return this._value; }
	get waiting(): number { return this._waiters.length; }

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
		const next = this._waiters.shift();
		if (next) {
			next();
		} else {
			if (this._value >= this._capacity) {
				throw new Error(`Semaphore over-release: value would exceed capacity (${this._capacity})`);
			}
			this._value++;
		}
	}
}
