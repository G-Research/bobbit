/**
 * Async counting semaphore for limiting concurrent operations.
 * Used by VerificationHarness to prevent resource exhaustion when
 * multiple goals verify simultaneously.
 */
export class Semaphore {
	private _value: number;
	private _waiters: Array<() => void> = [];

	constructor(initial: number) {
		this._value = initial;
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
			this._value++;
		}
	}
}
