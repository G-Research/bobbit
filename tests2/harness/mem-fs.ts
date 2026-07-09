/**
 * In-memory `FsLike` for Test Suite v2 store/config unit tests.
 *
 * Exercises the production `fsImpl` seam (see src/server/gateway-deps.ts) so a
 * store's persistence logic runs entirely in RAM — no Defender-scanned NTFS, no
 * teardown races, fully deterministic. This is the D4 rationale: fs was never
 * the CPU driver, but memfs earns its keep on determinism for the store classes
 * that already accept a `fsImpl` constructor arg.
 *
 * Why hand-rolled instead of the `memfs` package: keys are produced with the
 * real `path.resolve`, so Windows drive-letter paths (`C:\…`) round-trip
 * correctly — the npm `memfs` Volume assumes POSIX paths and mangles them.
 *
 * Only the FsLike surface is implemented; anything a store doesn't call is
 * intentionally absent. Sizes are byte-accurate (Buffer.byteLength) so tests
 * that assert file-size caps behave like real fs.
 */
import fs from "node:fs";
import path from "node:path";

export interface MemFs extends FsLikeShape {
	/** Live view of file contents keyed by resolved absolute path. */
	readonly files: Map<string, string>;
	/** Live set of known directory paths (resolved absolute). */
	readonly dirs: Set<string>;
}

// Local structural copy of the production FsLike so this helper has no runtime
// import of gateway-deps (keeps the DOM/happy-dom projects free of server code).
type FsLikeShape = Pick<typeof fs,
	| "existsSync" | "mkdirSync" | "readFileSync" | "writeFileSync" | "appendFileSync"
	| "readdirSync" | "statSync" | "lstatSync" | "renameSync" | "rmSync" | "unlinkSync" | "copyFileSync"
> & {
	promises: Pick<typeof fs.promises,
		| "access" | "mkdir" | "readFile" | "writeFile" | "appendFile"
		| "readdir" | "stat" | "lstat" | "rename" | "rm" | "unlink" | "copyFile">;
};

const enoent = (op: string, p: string): Error =>
	Object.assign(new Error(`ENOENT: no such file or directory, ${op} '${p}'`), { code: "ENOENT", path: p });

export function createMemFs(): MemFs {
	const files = new Map<string, string>();
	const dirs = new Set<string>();
	const norm = (p: fs.PathLike): string => path.resolve(String(p));
	const toText = (data: string | NodeJS.ArrayBufferView): string =>
		typeof data === "string" ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf-8");
	const ensureParents = (p: string): void => {
		let dir = path.dirname(p);
		let prev = "";
		while (dir && dir !== prev) { dirs.add(dir); prev = dir; dir = path.dirname(dir); }
	};

	// Built untyped then cast: node's fs method types are heavily overloaded
	// (e.g. statSync's BigInt variant) and not worth reproducing for a test double.
	const api = {
		files,
		dirs,
		existsSync(p: fs.PathLike) { const n = norm(p); return files.has(n) || dirs.has(n); },
		mkdirSync(p: fs.PathLike) { const n = norm(p); dirs.add(n); ensureParents(n); return undefined as any; },
		readFileSync(p: fs.PathLike | number) {
			const n = norm(p as fs.PathLike);
			if (!files.has(n)) throw enoent("open", n);
			return files.get(n)! as any;
		},
		writeFileSync(p: fs.PathLike | number, data: string | NodeJS.ArrayBufferView) { const n = norm(p as fs.PathLike); ensureParents(n); files.set(n, toText(data)); },
		appendFileSync(p: fs.PathLike | number, data: string | NodeJS.ArrayBufferView) { const n = norm(p as fs.PathLike); ensureParents(n); files.set(n, (files.get(n) ?? "") + toText(data)); },
		readdirSync(p: fs.PathLike, _opts?: any) {
			const n = norm(p);
			const prefix = n.endsWith(path.sep) ? n : n + path.sep;
			const children = new Set<string>();
			for (const key of [...files.keys(), ...dirs]) {
				if (key.startsWith(prefix)) {
					const rest = key.slice(prefix.length);
					if (rest.length) children.add(rest.split(path.sep)[0]);
				}
			}
			return [...children] as any;
		},
		statSync(p: fs.PathLike, _opts?: any) {
			const n = norm(p);
			const isFile = files.has(n);
			const isDir = dirs.has(n);
			if (!isFile && !isDir) throw enoent("stat", n);
			const size = isFile ? Buffer.byteLength(files.get(n)!, "utf-8") : 0;
			return { isDirectory: () => isDir, isFile: () => isFile, size, mtimeMs: Date.now(), mtime: new Date() } as fs.Stats;
		},
		lstatSync(p: fs.PathLike, _opts?: any) { return api.statSync(p) as any; },
		renameSync(from: fs.PathLike, to: fs.PathLike) {
			const a = norm(from); const b = norm(to);
			if (!files.has(a) && !dirs.has(a)) throw enoent("rename", a);
			if (files.has(a)) { files.set(b, files.get(a)!); files.delete(a); ensureParents(b); }
			if (dirs.has(a)) { dirs.delete(a); dirs.add(b); }
		},
		rmSync(p: fs.PathLike, opts?: any) {
			const n = norm(p);
			files.delete(n);
			dirs.delete(n);
			if (opts?.recursive) {
				const prefix = n + path.sep;
				for (const k of [...files.keys()]) if (k.startsWith(prefix)) files.delete(k);
				for (const d of [...dirs]) if (d.startsWith(prefix)) dirs.delete(d);
			}
		},
		unlinkSync(p: fs.PathLike) { files.delete(norm(p)); },
		copyFileSync(from: fs.PathLike, to: fs.PathLike) {
			const a = norm(from); const b = norm(to);
			if (!files.has(a)) throw enoent("copyfile", a);
			ensureParents(b); files.set(b, files.get(a)!);
		},
		promises: {
			access: async (p: fs.PathLike) => { if (!api.existsSync(p)) throw enoent("access", norm(p)); },
			mkdir: async (p: fs.PathLike) => { api.mkdirSync(p); return undefined as any; },
			readFile: async (p: fs.PathLike) => api.readFileSync(p as fs.PathLike) as any,
			writeFile: async (p: fs.PathLike, data: string | NodeJS.ArrayBufferView) => { api.writeFileSync(p as fs.PathLike, data as any); },
			appendFile: async (p: fs.PathLike, data: string | NodeJS.ArrayBufferView) => { api.appendFileSync(p as fs.PathLike, data as any); },
			readdir: async (p: fs.PathLike) => api.readdirSync(p) as any,
			stat: async (p: fs.PathLike) => api.statSync(p) as any,
			lstat: async (p: fs.PathLike) => api.lstatSync(p) as any,
			rename: async (from: fs.PathLike, to: fs.PathLike) => { api.renameSync(from, to); },
			rm: async (p: fs.PathLike, opts?: any) => { api.rmSync(p as fs.PathLike, opts); },
			unlink: async (p: fs.PathLike) => { api.unlinkSync(p as fs.PathLike); },
			copyFile: async (from: fs.PathLike, to: fs.PathLike) => { api.copyFileSync(from, to); },
		},
	} as unknown as MemFs;
	return api;
}
