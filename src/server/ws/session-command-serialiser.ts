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

/**
 * FIFO async command chains keyed by session. A rejected command is returned to
 * its caller but handled internally, so later commands always run. Idle keys are
 * removed without disturbing a newer tail for the same session.
 *
 * Only commands waiting behind an active command count toward admission. This
 * lets the first command start regardless of frame size while placing a hard
 * bound on parsed-message closures retained by the FIFO. Each running command
 * receives an advisory cancellation signal; Stop can cancel preprocessing while
 * also performing its immediate out-of-band abort and ordered fallback.
 */
export class SessionCommandSerialiser {
	private readonly tails = new Map<string, Promise<unknown>>();
	private readonly active = new Map<string, AbortController>();
	private readonly pending = new Map<string, PendingUsage>();
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

	/** Aggregate retained frame bytes across session keys. */
	get pendingBytes(): number {
		let bytes = 0;
		for (const usage of this.pending.values()) bytes += usage.bytes;
		return bytes;
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
}
