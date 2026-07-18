import type { RecoveryFs, RecoveryStats } from "../../src/server/agent/bounded-async-work.ts";

export type RecoveryFsOperation = "access" | "readdir" | "stat" | "open" | "read" | "close" | "readFile";

export interface RecoveryFsCall {
	operation: RecoveryFsOperation;
	path: string;
	length?: number;
	position?: number;
}

interface FileFixture {
	content: Buffer;
	size: number;
	mtime: Date;
	isFile: boolean;
}

interface PendingOperation {
	operation: RecoveryFsOperation;
	path: string;
	release: () => void;
}

/** In-memory async filesystem with deterministic failures, deferrals, and concurrency accounting. */
export class TeamRecoveryFsFake implements RecoveryFs {
	readonly calls: RecoveryFsCall[] = [];
	readonly directories = new Map<string, string[]>();
	readonly files = new Map<string, FileFixture>();
	readonly errors = new Map<string, Error>();
	readonly deferred = new Set<string>();
	readonly pending: PendingOperation[] = [];
	private readonly pendingWaiters: Array<{ minimum: number; resolve: () => void }> = [];
	active = 0;
	maxActive = 0;

	dir(path: string, names: readonly string[]): this {
		this.directories.set(path, [...names]);
		return this;
	}

	file(path: string, content: string | Buffer, options: { size?: number; mtime?: Date; isFile?: boolean } = {}): this {
		const bytes = Buffer.isBuffer(content) ? Buffer.from(content) : Buffer.from(content, "utf-8");
		this.files.set(path, {
			content: bytes,
			size: options.size ?? bytes.length,
			mtime: options.mtime ?? new Date("2024-01-01T00:00:00.000Z"),
			isFile: options.isFile ?? true,
		});
		return this;
	}

	fail(operation: RecoveryFsOperation, path: string, error = new Error(`${operation} failed: ${path}`)): this {
		this.errors.set(`${operation}:${path}`, error);
		return this;
	}

	defer(operation: RecoveryFsOperation, path = "*"): this {
		this.deferred.add(`${operation}:${path}`);
		return this;
	}

	release(operation?: RecoveryFsOperation, path?: string): number {
		let released = 0;
		for (let index = this.pending.length - 1; index >= 0; index--) {
			const item = this.pending[index]!;
			if (operation && item.operation !== operation) continue;
			if (path && item.path !== path) continue;
			this.pending.splice(index, 1);
			item.release();
			released++;
		}
		return released;
	}

	count(operation: RecoveryFsOperation, path?: string): number {
		return this.calls.filter((call) => call.operation === operation && (path === undefined || call.path === path)).length;
	}

	waitForPending(minimum = 1): Promise<void> {
		if (this.pending.length >= minimum) return Promise.resolve();
		return new Promise<void>((resolve) => this.pendingWaiters.push({ minimum, resolve }));
	}

	async access(path: string): Promise<void> {
		return this.run("access", path, () => {
			if (!this.directories.has(path) && !this.files.has(path)) throw new Error(`ENOENT: ${path}`);
		});
	}

	async readdir(path: string): Promise<string[]> {
		return this.run("readdir", path, () => {
			const names = this.directories.get(path);
			if (!names) throw new Error(`ENOENT: ${path}`);
			return [...names];
		});
	}

	async stat(path: string): Promise<RecoveryStats> {
		return this.run("stat", path, () => {
			const file = this.files.get(path);
			if (file) {
				return {
					size: file.size,
					mtime: new Date(file.mtime),
					isDirectory: () => false,
					isFile: () => file.isFile,
				};
			}
			if (this.directories.has(path)) {
				return {
					size: 0,
					mtime: new Date("2024-01-01T00:00:00.000Z"),
					isDirectory: () => true,
					isFile: () => false,
				};
			}
			throw new Error(`ENOENT: ${path}`);
		});
	}

	async open(path: string, flags: "r") {
		return this.run("open", path, () => {
			if (flags !== "r") throw new Error(`unexpected flags: ${flags}`);
			const file = this.files.get(path);
			if (!file) throw new Error(`ENOENT: ${path}`);
			return {
				read: async (buffer: Uint8Array, offset: number, length: number, position: number) =>
					this.run("read", path, () => {
						const available = Math.max(0, file.content.length - position);
						const bytesRead = Math.min(length, available);
						buffer.set(file.content.subarray(position, position + bytesRead), offset);
						return { bytesRead };
					}, { length, position }),
				close: async () => this.run("close", path, () => undefined),
			};
		});
	}

	async readFile(path: string, encoding: "utf-8"): Promise<string> {
		return this.run("readFile", path, () => {
			if (encoding !== "utf-8") throw new Error(`unexpected encoding: ${encoding}`);
			const file = this.files.get(path);
			if (!file) throw new Error(`ENOENT: ${path}`);
			return file.content.toString("utf-8");
		});
	}

	private async run<T>(
		operation: RecoveryFsOperation,
		path: string,
		fn: () => T,
		extra: Pick<RecoveryFsCall, "length" | "position"> = {},
	): Promise<T> {
		this.calls.push({ operation, path, ...extra });
		this.active++;
		this.maxActive = Math.max(this.maxActive, this.active);
		try {
			if (this.deferred.has(`${operation}:*`) || this.deferred.has(`${operation}:${path}`)) {
				await new Promise<void>((release) => {
					this.pending.push({ operation, path, release });
					for (let index = this.pendingWaiters.length - 1; index >= 0; index--) {
						const waiter = this.pendingWaiters[index]!;
						if (this.pending.length < waiter.minimum) continue;
						this.pendingWaiters.splice(index, 1);
						waiter.resolve();
					}
				});
			}
			const error = this.errors.get(`${operation}:${path}`);
			if (error) throw error;
			return fn();
		} finally {
			this.active--;
		}
	}
}

export const joinPosix = (...parts: string[]): string => parts.join("/").replace(/\/+/g, "/");
export const dirnamePosix = (value: string): string => value.slice(0, value.lastIndexOf("/")) || "/";
export const basenamePosix = (value: string): string => value.slice(value.lastIndexOf("/") + 1);

export function sessionHeader(cwd: string, id: string, timestamp?: string): string {
	return `${JSON.stringify({ type: "session", cwd, id, ...(timestamp ? { timestamp } : {}) })}\nignored transcript body`;
}

export async function microtaskTurns(count = 4): Promise<void> {
	for (let index = 0; index < count; index++) await Promise.resolve();
}
