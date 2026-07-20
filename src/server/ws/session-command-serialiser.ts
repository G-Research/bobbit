/**
 * FIFO async command chains keyed by session. A rejected command is returned to
 * its caller but handled internally, so later commands always run. Idle keys are
 * removed without disturbing a newer tail for the same session.
 */
export class SessionCommandSerialiser {
	private readonly tails = new Map<string, Promise<unknown>>();

	get size(): number {
		return this.tails.size;
	}

	run<T>(key: string, command: () => Promise<T> | T): Promise<T> {
		const previous = this.tails.get(key);
		let commandResult: Promise<T>;
		if (previous) {
			commandResult = previous.then(command, command);
		} else {
			try {
				commandResult = Promise.resolve(command());
			} catch (err) {
				commandResult = Promise.reject(err);
			}
		}

		this.tails.set(key, commandResult);
		const removeIdleKey = () => {
			if (this.tails.get(key) === commandResult) this.tails.delete(key);
		};
		void commandResult.then(removeIdleKey, removeIdleKey);
		return commandResult;
	}

	serialise<T>(key: string, command: () => Promise<T> | T): Promise<T> {
		return this.run(key, command);
	}
}
