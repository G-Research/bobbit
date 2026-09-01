import fs from "node:fs";
import path from "node:path";
import { vi } from "vitest";

/**
 * Installs a small, synchronous in-memory fs surface for one test file.
 *
 * The verification snapshot tests exercise byte-bounded reads and atomic state
 * writes, not NTFS. Keeping those fixtures in memory avoids Defender/contention
 * latency while retaining the production fs call sequence and byte semantics.
 */
export function installScopedMemoryFs(): () => void {
	const spies: Array<{ mockRestore(): void }> = [];
	const track = <T extends { mockRestore(): void }>(spy: T): T => { spies.push(spy); return spy; };
	const files = new Map<string, Buffer>();
	const dirs = new Set<string>();
	const descriptors = new Map<number, Buffer>();
	let nextFd = 100;
	let nextTemp = 1;
	const normalize = (value: fs.PathLike): string => path.resolve(String(value));
	const missing = (operation: string, value: fs.PathLike): NodeJS.ErrnoException =>
		Object.assign(new Error(`ENOENT: no such file or directory, ${operation} '${value}'`), { code: "ENOENT" });
	const ensureParents = (value: string): void => {
		let current = path.dirname(value);
		let previous = "";
		while (current && current !== previous) {
			dirs.add(current);
			previous = current;
			current = path.dirname(current);
		}
	};
	const removeTree = (value: string): void => {
		const prefix = value.endsWith(path.sep) ? value : `${value}${path.sep}`;
		files.delete(value);
		dirs.delete(value);
		for (const key of [...files.keys()]) if (key.startsWith(prefix)) files.delete(key);
		for (const key of [...dirs]) if (key.startsWith(prefix)) dirs.delete(key);
	};

	track(vi.spyOn(fs, "mkdtempSync")).mockImplementation(((prefix: string) => {
		const dir = normalize(`${prefix}${nextTemp++}`);
		dirs.add(dir);
		ensureParents(dir);
		return dir;
	}) as typeof fs.mkdtempSync);
	track(vi.spyOn(fs, "existsSync")).mockImplementation((value) => {
		const key = normalize(value);
		return files.has(key) || dirs.has(key);
	});
	track(vi.spyOn(fs, "mkdirSync")).mockImplementation(((value: fs.PathLike) => {
		const key = normalize(value);
		dirs.add(key);
		ensureParents(key);
		return undefined;
	}) as typeof fs.mkdirSync);
	track(vi.spyOn(fs, "writeFileSync")).mockImplementation(((value: fs.PathLike | number, data: string | NodeJS.ArrayBufferView) => {
		const key = normalize(value as fs.PathLike);
		ensureParents(key);
		files.set(key, typeof data === "string" ? Buffer.from(data) : Buffer.from(data.buffer, data.byteOffset, data.byteLength));
	}) as typeof fs.writeFileSync);
	track(vi.spyOn(fs, "readFileSync")).mockImplementation(((value: fs.PathLike | number, options?: unknown) => {
		const key = normalize(value as fs.PathLike);
		const data = files.get(key);
		if (!data) throw missing("open", key);
		const encoding = (typeof options === "string" ? options : (options as { encoding?: string } | undefined)?.encoding) as BufferEncoding | undefined;
		return encoding ? data.toString(encoding) : Buffer.from(data);
	}) as typeof fs.readFileSync);
	track(vi.spyOn(fs, "statSync")).mockImplementation(((value: fs.PathLike) => {
		const key = normalize(value);
		const data = files.get(key);
		if (!data && !dirs.has(key)) throw missing("stat", key);
		return {
			size: data?.byteLength ?? 0,
			mtimeMs: 1,
			mtime: new Date(1),
			isFile: () => !!data,
			isDirectory: () => !data,
		} as fs.Stats;
	}) as typeof fs.statSync);
	track(vi.spyOn(fs, "openSync")).mockImplementation(((value: fs.PathLike) => {
		const key = normalize(value);
		const data = files.get(key);
		if (!data) throw missing("open", key);
		const fd = nextFd++;
		descriptors.set(fd, data);
		return fd;
	}) as typeof fs.openSync);
	track(vi.spyOn(fs, "readSync")).mockImplementation(((fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: number | null) => {
		const data = descriptors.get(fd);
		if (!data) throw missing("read", String(fd));
		const start = position ?? 0;
		const bytes = Math.max(0, Math.min(length, data.byteLength - start));
		Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength).set(data.subarray(start, start + bytes), offset);
		return bytes;
	}) as typeof fs.readSync);
	track(vi.spyOn(fs, "closeSync")).mockImplementation((fd) => { descriptors.delete(fd); });
	track(vi.spyOn(fs, "realpathSync")).mockImplementation(((value: fs.PathLike) => {
		const key = normalize(value);
		if (!files.has(key) && !dirs.has(key)) throw missing("realpath", key);
		return key;
	}) as typeof fs.realpathSync);
	track(vi.spyOn(fs, "renameSync")).mockImplementation((from, to) => {
		const source = normalize(from);
		const target = normalize(to);
		const data = files.get(source);
		if (!data) throw missing("rename", source);
		ensureParents(target);
		files.set(target, data);
		files.delete(source);
	});
	track(vi.spyOn(fs, "unlinkSync")).mockImplementation((value) => { files.delete(normalize(value)); });
	track(vi.spyOn(fs, "rmSync")).mockImplementation(((value: fs.PathLike) => { removeTree(normalize(value)); }) as typeof fs.rmSync);

	return () => { for (const spy of spies.reverse()) spy.mockRestore(); };
}
