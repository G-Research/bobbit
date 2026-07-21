/**
 * Maximum number of commands retained behind the active command for one
 * session. The active command is deliberately excluded: a single accepted
 * prompt may run while this many later frames wait.
 */
export const MAX_PENDING_SESSION_COMMANDS = 64;

/**
 * Maximum raw WebSocket bytes retained by pending commands for one session.
 * The active command is excluded, so the composer's 200 MiB aggregate send can
 * still start normally. 64 MiB retains several ordinary attachment sends while
 * bounding a flood to at most eight pending 8 MiB prompt frames by bytes.
 */
export const MAX_PENDING_SESSION_COMMAND_BYTES = 64 * 1024 * 1024;

export const SESSION_COMMAND_QUEUE_FULL = "SESSION_COMMAND_QUEUE_FULL";

export type SessionCommandQueueLimit = "count" | "bytes";

export class SessionCommandQueueFullError extends Error {
	readonly code = SESSION_COMMAND_QUEUE_FULL;
	readonly limit: SessionCommandQueueLimit;

	constructor(limit: SessionCommandQueueLimit) {
		super(`Pending session command queue ${limit} limit exceeded`);
		this.name = "SessionCommandQueueFullError";
		this.limit = limit;
	}
}

export interface SessionCommandSerialiserOptions {
	maxPendingCommands?: number;
	maxPendingBytes?: number;
}

interface PendingUsage {
	count: number;
	bytes: number;
}

export interface SessionCommandControlReservation {
	/** Shared completion for this key's reserved control callback. */
	promise: Promise<void>;
	/** True only for the caller whose callback was retained. */
	created: boolean;
}

/**
 * FIFO async command chains keyed by session. A rejected command is returned to
 * its caller but handled internally, so later commands always run. Idle keys are
 * removed without disturbing a newer tail for the same session.
 *
 * Only ordinary commands waiting behind an active command count toward ordinary
 * admission. This lets the first command start regardless of frame size while
 * placing a hard bound on parsed-message closures retained by the FIFO. Each
 * running ordinary command receives an advisory cancellation signal; Stop can
 * cancel preprocessing while also performing its immediate out-of-band abort.
 *
 * Stop's ordered fallback uses a separate one-entry-per-key control reservation.
 * It never competes with ordinary count/byte limits, and repeated control calls
 * for that key share the same promise until the reserved callback settles.
 */
export class SessionCommandSerialiser {
	private readonly tails = new Map<string, Promise<unknown>>();
	private readonly active = new Map<string, AbortController>();
	private readonly pending = new Map<string, PendingUsage>();
	private readonly controls = new Map<string, Promise<void>>();
	private readonly maxPendingCommands: number;
	private readonly maxPendingBytes: number;

	constructor(options: SessionCommandSerialiserOptions = {}) {
		this.maxPendingCommands = options.maxPendingCommands ?? MAX_PENDING_SESSION_COMMANDS;
		this.maxPendingBytes = options.maxPendingBytes ?? MAX_PENDING_SESSION_COMMAND_BYTES;
		if (!Number.isSafeInteger(this.maxPendingCommands) || this.maxPendingCommands < 0) {
			throw new RangeError("maxPendingCommands must be a non-negative safe integer");
		}
		if (!Number.isSafeInteger(this.maxPendingBytes) || this.maxPendingBytes < 0) {
			throw new RangeError("maxPendingBytes must be a non-negative safe integer");
		}
	}

	get size(): number {
		return this.tails.size;
	}

	/** Aggregate pending usage across session keys; exposed for diagnostics/tests. */
	get pendingCount(): number {
		let count = 0;
		for (const usage of this.pending.values()) count += usage.count;
		return count;
	}

	/** Aggregate retained ordinary-frame bytes across session keys. */
	get pendingBytes(): number {
		let bytes = 0;
		for (const usage of this.pending.values()) bytes += usage.bytes;
		return bytes;
	}

	/** Reserved control callbacks, including a callback that is currently running. */
	get controlCount(): number {
		return this.controls.size;
	}

	cancelActive(key: string): boolean {
		const controller = this.active.get(key);
		if (!controller || controller.signal.aborted) return false;
		controller.abort();
		return true;
	}

	run<T>(
		key: string,
		command: (signal: AbortSignal) => Promise<T> | T,
		frameBytes = 0,
	): Promise<T> {
		if (!Number.isSafeInteger(frameBytes) || frameBytes < 0) {
			throw new RangeError("frameBytes must be a non-negative safe integer");
		}

		const previous = this.tails.get(key);
		let pendingReserved = false;
		if (previous) {
			const usage = this.pending.get(key) ?? { count: 0, bytes: 0 };
			if (usage.count >= this.maxPendingCommands) {
				return Promise.reject(new SessionCommandQueueFullError("count"));
			}
			if (frameBytes > this.maxPendingBytes - usage.bytes) {
				return Promise.reject(new SessionCommandQueueFullError("bytes"));
			}
			usage.count += 1;
			usage.bytes += frameBytes;
			this.pending.set(key, usage);
			pendingReserved = true;
		}

		const controller = new AbortController();
		const invoke = (): Promise<T> => {
			if (pendingReserved) {
				const usage = this.pending.get(key);
				if (usage) {
					usage.count -= 1;
					usage.bytes -= frameBytes;
					if (usage.count === 0) this.pending.delete(key);
				}
				pendingReserved = false;
			}
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

	serialise<T>(
		key: string,
		command: (signal: AbortSignal) => Promise<T> | T,
		frameBytes = 0,
	): Promise<T> {
		return this.run(key, command, frameBytes);
	}

	/**
	 * Append one ordered control callback without consuming ordinary queue
	 * capacity. A key can retain at most one such callback (queued or running),
	 * so repeated Stop frames receive its reservation without retaining their
	 * callbacks. Callers use `created` to start/observe side effects only once.
	 */
	serialiseControl(
		key: string,
		command: () => Promise<void> | void,
	): SessionCommandControlReservation {
		const existing = this.controls.get(key);
		if (existing) return { promise: existing, created: false };

		const previous = this.tails.get(key);
		const invoke = (): Promise<void> => {
			try {
				return Promise.resolve(command());
			} catch (err) {
				return Promise.reject(err);
			}
		};

		// Always cross a microtask, including on an idle key, so the reservation
		// is visible before user code can run or synchronously enqueue more work.
		const commandResult = previous
			? previous.then(invoke, invoke)
			: Promise.resolve().then(invoke);
		this.controls.set(key, commandResult);
		this.tails.set(key, commandResult);

		const releaseControl = () => {
			if (this.controls.get(key) === commandResult) this.controls.delete(key);
			if (this.tails.get(key) === commandResult) this.tails.delete(key);
		};
		void commandResult.then(releaseControl, releaseControl);
		return { promise: commandResult, created: true };
	}
}
