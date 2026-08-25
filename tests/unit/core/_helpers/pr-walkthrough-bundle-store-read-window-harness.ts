import fs from "node:fs";
import path from "node:path";
import { vi } from "vitest";

const MEMORY_ROOT = path.resolve(".test-memory", "pr-walkthrough-bundle-store-read-window");

export type PrWalkthroughBundleStoreHarness = {
	readonly stateDir: string;
	readonly files: ReadonlyMap<string, string>;
	advance(ms?: number): void;
	restore(): void;
};

/**
 * Keeps this suite on the production store implementation while moving its
 * Defender-sensitive state directory into a tiny, synchronous in-memory FS.
 * Calls outside the suite-owned root still use the real node:fs methods.
 */
export function installPrWalkthroughBundleStoreHarness(startMs = Date.parse("2026-06-01T00:00:00.000Z")): PrWalkthroughBundleStoreHarness {
	const files = new Map<string, string>();
	const directories = new Set<string>();
	let now = startMs;
	const normalize = (value: fs.PathLike | number): string => path.resolve(String(value));
	const inMemoryRoot = (value: fs.PathLike | number): boolean => {
		const normalized = normalize(value);
		return normalized === MEMORY_ROOT || normalized.startsWith(`${MEMORY_ROOT}${path.sep}`);
	};
	const addParents = (filePath: string): void => {
		let directory = path.dirname(filePath);
		while (directory.startsWith(MEMORY_ROOT)) {
			directories.add(directory);
			if (directory === MEMORY_ROOT) break;
			directory = path.dirname(directory);
		}
	};
	const toText = (value: string | NodeJS.ArrayBufferView): string => typeof value === "string"
		? value
		: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("utf8");
	const missing = (filePath: string): Error => Object.assign(new Error(`ENOENT: no such file or directory, open '${filePath}'`), {
		code: "ENOENT",
		path: filePath,
	});

	const realMkdirSync = fs.mkdirSync.bind(fs);
	const realWriteFileSync = fs.writeFileSync.bind(fs);
	const realReadFileSync = fs.readFileSync.bind(fs);
	const mkdirSpy = vi.spyOn(fs, "mkdirSync").mockImplementation(((directory: fs.PathLike, options?: fs.MakeDirectoryOptions) => {
		if (!inMemoryRoot(directory)) return realMkdirSync(directory, options as any) as any;
		const normalized = normalize(directory);
		directories.add(normalized);
		addParents(normalized);
		return undefined;
	}) as typeof fs.mkdirSync);
	const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(((filePath: fs.PathLike | number, data: string | NodeJS.ArrayBufferView, options?: fs.WriteFileOptions) => {
		if (!inMemoryRoot(filePath)) return realWriteFileSync(filePath, data, options as any);
		const normalized = normalize(filePath);
		addParents(normalized);
		// Map#set publishes the complete new value in one synchronous operation,
		// preserving the store's overwrite/atomic-read behavior for concurrent reads.
		files.set(normalized, toText(data));
	}) as typeof fs.writeFileSync);
	const readSpy = vi.spyOn(fs, "readFileSync").mockImplementation(((filePath: fs.PathLike | number, options?: unknown) => {
		if (!inMemoryRoot(filePath)) return realReadFileSync(filePath, options as any);
		const normalized = normalize(filePath);
		const value = files.get(normalized);
		if (value === undefined) throw missing(normalized);
		return options === undefined || options === null ? Buffer.from(value, "utf8") : value;
	}) as typeof fs.readFileSync);
	const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);

	return {
		stateDir: MEMORY_ROOT,
		files,
		advance(ms = 1) { now += Math.max(0, ms); },
		restore() {
			nowSpy.mockRestore();
			readSpy.mockRestore();
			writeSpy.mockRestore();
			mkdirSpy.mockRestore();
		},
	};
}
