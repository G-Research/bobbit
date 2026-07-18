import path from "node:path";

export type CostIoOperation = "access" | "readdir" | "stat" | "open" | "read" | "close" | "readFile";

export interface CostIoCall {
	op: CostIoOperation;
	path: string;
	length?: number;
	position?: number;
}

export class Deferred<T = void> {
	readonly promise: Promise<T>;
	private resolvePromise!: (value: T | PromiseLike<T>) => void;
	private rejectPromise!: (reason?: unknown) => void;

	constructor() {
		this.promise = new Promise<T>((resolve, reject) => {
			this.resolvePromise = resolve;
			this.rejectPromise = reject;
		});
	}

	resolve(value: T extends void ? undefined : T = undefined as T extends void ? undefined : T): void {
		this.resolvePromise(value as T);
	}

	reject(reason: unknown): void {
		this.rejectPromise(reason);
	}
}

interface FakeStatInit {
	size?: number;
	mtime?: Date;
	isDirectory?: boolean;
	isFile?: boolean;
}

interface FakeStat {
	size: number;
	mtime: Date;
	isDirectory(): boolean;
	isFile(): boolean;
}

/** Cost-recovery-only, fully in-memory async filesystem with deterministic barriers. */
export class CostRecoveryFsFake {
	readonly calls: CostIoCall[] = [];
	active = 0;
	maxActive = 0;

	private readonly directories = new Map<string, string[]>();
	private readonly files = new Map<string, string>();
	private readonly statOverrides = new Map<string, FakeStat>();
	private readonly errors = new Map<string, unknown>();
	private readonly barriers = new Map<string, Promise<unknown>>();

	directory(dirPath: string, entries: readonly string[]): this {
		this.directories.set(dirPath, [...entries]);
		return this;
	}

	file(filePath: string, contents: string): this {
		this.files.set(filePath, contents);
		return this;
	}

	statAs(targetPath: string, init: FakeStatInit): this {
		const isDirectory = init.isDirectory ?? false;
		const isFile = init.isFile ?? !isDirectory;
		this.statOverrides.set(targetPath, {
			size: init.size ?? Buffer.byteLength(this.files.get(targetPath) ?? ""),
			mtime: init.mtime ?? new Date(0),
			isDirectory: () => isDirectory,
			isFile: () => isFile,
		});
		return this;
	}

	fail(op: CostIoOperation, targetPath: string, error: unknown = new Error(`${op} failed: ${targetPath}`)): this {
		this.errors.set(this.key(op, targetPath), error);
		return this;
	}

	block(op: CostIoOperation, targetPath: string, deferred: Deferred): this {
		this.barriers.set(this.key(op, targetPath), deferred.promise);
		return this;
	}

	blockAll(op: CostIoOperation, deferred: Deferred): this {
		this.barriers.set(this.key(op, "*"), deferred.promise);
		return this;
	}

	callsFor(op: CostIoOperation, targetPath?: string): CostIoCall[] {
		return this.calls.filter((call) => call.op === op && (targetPath === undefined || call.path === targetPath));
	}

	async access(targetPath: string): Promise<void> {
		return this.run("access", targetPath, undefined, () => {
			if (!this.directories.has(targetPath) && !this.files.has(targetPath) && !this.statOverrides.has(targetPath)) {
				throw new Error(`ENOENT: ${targetPath}`);
			}
		});
	}

	async readdir(targetPath: string): Promise<string[]> {
		return this.run("readdir", targetPath, undefined, () => {
			const entries = this.directories.get(targetPath);
			if (!entries) throw new Error(`ENOENT: ${targetPath}`);
			return [...entries];
		});
	}

	async stat(targetPath: string): Promise<FakeStat> {
		return this.run("stat", targetPath, undefined, () => {
			const override = this.statOverrides.get(targetPath);
			if (override) return override;
			if (this.directories.has(targetPath)) {
				return { size: 0, mtime: new Date(0), isDirectory: () => true, isFile: () => false };
			}
			const contents = this.files.get(targetPath);
			if (contents !== undefined) {
				return {
					size: Buffer.byteLength(contents),
					mtime: new Date(0),
					isDirectory: () => false,
					isFile: () => true,
				};
			}
			throw new Error(`ENOENT: ${targetPath}`);
		});
	}

	async open(targetPath: string, flags: "r") {
		if (flags !== "r") throw new Error(`Unexpected flags: ${flags}`);
		await this.run("open", targetPath, undefined, () => {
			if (!this.files.has(targetPath)) throw new Error(`ENOENT: ${targetPath}`);
		});
		return {
			read: async (buffer: Uint8Array, offset: number, length: number, position: number) =>
				this.run("read", targetPath, { length, position }, () => {
					const source = Buffer.from(this.files.get(targetPath) ?? "", "utf8");
					const bytesRead = Math.max(0, Math.min(length, source.length - position));
					buffer.set(source.subarray(position, position + bytesRead), offset);
					return { bytesRead };
				}),
			close: async () => this.run("close", targetPath, undefined, () => undefined),
		};
	}

	async readFile(targetPath: string, encoding: "utf-8"): Promise<string> {
		if (encoding !== "utf-8") throw new Error(`Unexpected encoding: ${encoding}`);
		return this.run("readFile", targetPath, undefined, () => {
			const contents = this.files.get(targetPath);
			if (contents === undefined) throw new Error(`ENOENT: ${targetPath}`);
			return contents;
		});
	}

	private key(op: CostIoOperation, targetPath: string): string {
		return `${op}\u0000${targetPath}`;
	}

	private async run<T>(
		op: CostIoOperation,
		targetPath: string,
		extra: Pick<CostIoCall, "length" | "position"> | undefined,
		fn: () => T,
	): Promise<T> {
		this.calls.push({ op, path: targetPath, ...extra });
		this.active += 1;
		this.maxActive = Math.max(this.maxActive, this.active);
		try {
			const barrier = this.barriers.get(this.key(op, targetPath)) ?? this.barriers.get(this.key(op, "*"));
			if (barrier) await barrier;
			const error = this.errors.get(this.key(op, targetPath));
			if (error !== undefined) throw error;
			return fn();
		} finally {
			this.active -= 1;
		}
	}
}

export interface FakeCostEntry {
	goalId?: string;
}

/** Minimal ordered in-memory CostTracker surface consumed by cost backfill. */
export class FakeCostTracker {
	readonly entries = new Map<string, FakeCostEntry>();
	readonly resolverOrders: string[][] = [];
	generation = 0;

	constructor(entries: Record<string, FakeCostEntry>) {
		for (const [sessionId, entry] of Object.entries(entries)) this.entries.set(sessionId, { ...entry });
	}

	getUnstampedSessionIds(): string[] {
		return [...this.entries].filter(([, entry]) => !entry.goalId).map(([sessionId]) => sessionId);
	}

	backfillGoalIds(resolver: (sessionId: string) => string | undefined): number {
		const order: string[] = [];
		let stamped = 0;
		for (const [sessionId, entry] of this.entries) {
			if (entry.goalId) continue;
			order.push(sessionId);
			const goalId = resolver(sessionId);
			if (!goalId) continue;
			entry.goalId = goalId;
			stamped += 1;
		}
		this.resolverOrders.push(order);
		if (stamped > 0) this.generation += 1;
		return stamped;
	}

	goalMap(): Record<string, string | undefined> {
		return Object.fromEntries([...this.entries].map(([sessionId, entry]) => [sessionId, entry.goalId]));
	}
}

export function sidecarJson(sessionId: string, teamGoalId?: string, overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		version: 1,
		bobbitSessionId: sessionId,
		agentSessionId: `agent-${sessionId}`,
		role: "coder",
		teamGoalId,
		title: `session ${sessionId}`,
		createdAt: 1,
		...overrides,
	});
}

export function sidecarPath(slugDir: string, stem: string): string {
	return path.join(slugDir, `${stem}.bobbit.json`);
}

/** Drain only promise jobs; no timers or wall-clock waits. */
export async function drainMicrotasksUntil(predicate: () => boolean, maxTurns = 100): Promise<void> {
	for (let turn = 0; turn < maxTurns && !predicate(); turn += 1) await Promise.resolve();
	if (!predicate()) throw new Error("Expected deferred async work to reach the requested structural checkpoint");
}
