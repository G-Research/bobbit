/**
 * FIFO async command chains keyed by session. A rejected command is returned to
 * its caller but handled internally, so later commands always run. Idle keys are
 * removed without disturbing a newer tail for the same session.
 *
 * Each running command receives a cancellation signal. Cancellation is advisory:
 * the command decides which pre-dispatch work can be abandoned, while callers can
 * still perform an immediate out-of-band action (notably Stop) and queue an
 * ordered fallback behind the command.
 */
export class SessionCommandSerialiser {
	private readonly tails = new Map<string, Promise<unknown>>();
	private readonly active = new Map<string, AbortController>();

	get size(): number {
		return this.tails.size;
	}

	cancelActive(key: string): boolean {
		const controller = this.active.get(key);
		if (!controller || controller.signal.aborted) return false;
		controller.abort();
		return true;
	}

	run<T>(key: string, command: (signal: AbortSignal) => Promise<T> | T): Promise<T> {
		const controller = new AbortController();
		const invoke = (): Promise<T> => {
			this.active.set(key, controller);
			let result: Promise<T>;
			try {
				result = Promise.resolve(command(controller.signal));
			} catch (err) {
				result = Promise.reject(err);
			}
			return result.finally(() => {
				if (this.active.get(key) === controller) this.active.delete(key);
			});
		};

		const previous = this.tails.get(key);
		const commandResult = previous
			? previous.then(invoke, invoke)
			: invoke();

		this.tails.set(key, commandResult);
		const removeIdleKey = () => {
			if (this.tails.get(key) === commandResult) this.tails.delete(key);
		};
		void commandResult.then(removeIdleKey, removeIdleKey);
		return commandResult;
	}

	serialise<T>(key: string, command: (signal: AbortSignal) => Promise<T> | T): Promise<T> {
		return this.run(key, command);
	}
}
