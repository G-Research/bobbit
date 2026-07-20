/**
 * FIFO async command chains keyed by session. A rejected command is returned to
 * its caller but converted to a fulfilled tail, so later commands always run.
 * Idle keys are removed without disturbing a newer tail for the same session.
 */
export class SessionCommandSerialiser {
	private readonly tails = new Map<string, Promise<void>>();

	serialise<T>(key: string, command: () => Promise<T> | T): Promise<T> {
		const previous = this.tails.get(key) ?? Promise.resolve();
		const result = previous.then(command);
		const tail = result.then(
			() => undefined,
			() => undefined,
		);
		this.tails.set(key, tail);
		void tail.then(() => {
			if (this.tails.get(key) === tail) this.tails.delete(key);
		});
		return result;
	}
}
