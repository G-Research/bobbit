/**
 * FIFO async command chains keyed by session. A rejected command is returned to
 * its caller but converted to a fulfilled tail, so later commands always run.
 * Idle keys are removed without disturbing a newer tail for the same session.
 */
export class SessionCommandSerialiser {
	private readonly tails = new Map<string, Promise<void>>();

	get size(): number {
		return this.tails.size;
	}

	run<T>(key: string, command: () => Promise<T> | T): Promise<T> {
		const previous = this.tails.get(key) ?? Promise.resolve();
		let tail!: Promise<void>;
		const result = previous.then(command).finally(() => {
			if (this.tails.get(key) === tail) this.tails.delete(key);
		});
		tail = result.then(
			() => undefined,
			() => undefined,
		);
		this.tails.set(key, tail);
		return result;
	}

	serialise<T>(key: string, command: () => Promise<T> | T): Promise<T> {
		return this.run(key, command);
	}
}
