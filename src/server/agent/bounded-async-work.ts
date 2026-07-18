import fs from "node:fs";

/** Small shared ceiling for boot-time recovery filesystem work. */
export const RECOVERY_IO_CONCURRENCY = 8;

/**
 * Map items with a fixed number of index-cursor workers. Results retain input
 * order even when individual operations complete out of order.
 */
export async function mapWithConcurrency<T, R>(
	items: readonly T[],
	limit: number,
	worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	if (!Number.isInteger(limit) || limit <= 0) {
		throw new RangeError("concurrency limit must be a positive integer");
	}

	const results = new Array<R>(items.length);
	let cursor = 0;
	const workerCount = Math.min(limit, items.length);
	const workers = Array.from({ length: workerCount }, async () => {
		while (true) {
			const index = cursor++;
			if (index >= items.length) return;
			results[index] = await worker(items[index]!, index);
		}
	});
	await Promise.all(workers);
	return results;
}

export interface RecoveryStats {
	size: number;
	mtime: Date;
	isDirectory(): boolean;
	isFile(): boolean;
}

export interface RecoveryFileHandle {
	read(
		buffer: Uint8Array,
		offset: number,
		length: number,
		position: number,
	): Promise<{ bytesRead: number }>;
	close(): Promise<void>;
}

/** Minimal injectable asynchronous filesystem used by boot recovery scans. */
export interface RecoveryFs {
	access(path: string): Promise<void>;
	readdir(path: string): Promise<string[]>;
	stat(path: string): Promise<RecoveryStats>;
	open(path: string, flags: "r"): Promise<RecoveryFileHandle>;
	readFile(path: string, encoding: "utf-8"): Promise<string>;
}

export const realRecoveryFs: RecoveryFs = {
	access: (filePath) => fs.promises.access(filePath),
	readdir: (dirPath) => fs.promises.readdir(dirPath),
	stat: (filePath) => fs.promises.stat(filePath),
	open: (filePath, flags) => fs.promises.open(filePath, flags),
	readFile: (filePath, encoding) => fs.promises.readFile(filePath, encoding),
};
