/**
 * Per-session preview-mount lifecycle.
 *
 * NOTE: This module is owned by WP-A. This file is a working implementation
 * provided by WP-D so its branch typechecks in isolation; on merge, WP-A's
 * version wins. Both implement the same public API so the merge is mechanical.
 *
 * Layout: <stateDir>/preview/<sessionId>/<entry> + sibling tree.
 *
 *   mountDir(sid)    → absolute path to the per-session directory
 *   writeInline(sid, html, entry?)
 *   copyFileTree(sid, srcFile)
 *   removeMount(sid) → idempotent recursive delete
 *   watchMount(sid, onChange) → unsubscribe (50 ms debounced)
 *
 * Caps:
 *   - per-call asset cap: 25 MiB (matches MAX_ASSET_SIZE in path-guard.ts)
 *   - per-mount ceiling:  100 MiB
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { bobbitStateDir } from "../bobbit-dir.js";

const VALID_SESSION_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export const PREVIEW_MOUNT_MAX_BYTES = 100 * 1024 * 1024;
export const PREVIEW_ASSET_MAX_BYTES = 25 * 1024 * 1024;

const VALID_ENTRY = /^[A-Za-z0-9._-]+$/;

export interface MountResult {
	url: string;
	path: string;
	entry: string;
	mtime: number;
}

export class PreviewMountError extends Error {
	statusCode: 400 | 403 | 404 | 413;
	constructor(message: string, statusCode: 400 | 403 | 404 | 413) {
		super(message);
		this.statusCode = statusCode;
		this.name = "PreviewMountError";
	}
}

function assertValidSession(sessionId: string): void {
	if (!VALID_SESSION_ID.test(sessionId)) {
		throw new PreviewMountError("Invalid sessionId", 400);
	}
}

function assertValidEntry(entry: string): void {
	if (
		!entry ||
		entry === "." ||
		entry === ".." ||
		entry.includes("/") ||
		entry.includes("\\") ||
		entry.includes("\0") ||
		!VALID_ENTRY.test(entry)
	) {
		throw new PreviewMountError("Invalid entry name", 400);
	}
}

/** Resolve `<stateDir>/preview/<sid>/`. Creates parents on first use. */
export function mountDir(sessionId: string): string {
	assertValidSession(sessionId);
	const dir = path.join(bobbitStateDir(), "preview", sessionId);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

function dirSize(dir: string): number {
	let total = 0;
	let stack: string[] = [dir];
	while (stack.length) {
		const cur = stack.pop()!;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(cur, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const e of entries) {
			const full = path.join(cur, e.name);
			if (e.isDirectory()) {
				stack.push(full);
			} else if (e.isFile()) {
				try {
					total += fs.statSync(full).size;
				} catch { /* ok */ }
			}
		}
	}
	return total;
}

function buildResult(sessionId: string, dir: string, entry: string): MountResult {
	const full = path.join(dir, entry);
	let mtime = Date.now();
	try { mtime = fs.statSync(full).mtimeMs; } catch { /* ok */ }
	return {
		url: `/preview/${encodeURIComponent(sessionId)}/${encodeURIComponent(entry)}`,
		path: full,
		entry,
		mtime,
	};
}

/** Write inline HTML to <mount>/<entry> (default `inline.html`). */
export function writeInline(sessionId: string, html: string, entry?: string): MountResult {
	const e = entry ?? "inline.html";
	assertValidEntry(e);
	const dir = mountDir(sessionId);
	const target = path.join(dir, e);

	const newBytes = Buffer.byteLength(html, "utf-8");
	if (newBytes > PREVIEW_ASSET_MAX_BYTES) {
		throw new PreviewMountError("Entry exceeds 25 MiB asset cap", 413);
	}
	let existing = 0;
	try { existing = fs.statSync(target).size; } catch { /* ok */ }
	const projected = dirSize(dir) - existing + newBytes;
	if (projected > PREVIEW_MOUNT_MAX_BYTES) {
		throw new PreviewMountError("Mount exceeds 100 MiB ceiling", 413);
	}

	// Atomic write via temp + rename.
	const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
	fs.writeFileSync(tmp, html, "utf-8");
	fs.renameSync(tmp, target);

	return buildResult(sessionId, dir, e);
}

/** Copy `srcFile` + sibling tree into the mount. */
export function copyFileTree(sessionId: string, srcFile: string): MountResult {
	if (!path.isAbsolute(srcFile)) {
		throw new PreviewMountError("file path must be absolute", 400);
	}
	let stat: fs.Stats;
	try {
		stat = fs.statSync(srcFile);
	} catch {
		throw new PreviewMountError("file not found", 404);
	}
	if (!stat.isFile()) {
		throw new PreviewMountError("file is not a regular file", 404);
	}
	const base = path.basename(srcFile).toLowerCase();
	if (!base.endsWith(".html") && !base.endsWith(".htm")) {
		throw new PreviewMountError("file must end in .html or .htm", 400);
	}

	const srcDir = path.dirname(srcFile);
	let srcDirReal: string;
	try {
		srcDirReal = fs.realpathSync(srcDir);
	} catch {
		throw new PreviewMountError("source directory not found", 404);
	}

	const dir = mountDir(sessionId);
	// Wipe existing mount contents before copying — file mode is "snapshot the
	// source dir".
	wipeDirContents(dir);

	const entry = path.basename(srcFile);

	let copied = 0;
	const stack: string[] = [srcDirReal];
	const visitedDirs = new Set<string>();
	while (stack.length) {
		const curAbs = stack.pop()!;
		if (visitedDirs.has(curAbs)) continue;
		visitedDirs.add(curAbs);

		// Containment guard against symlink escape.
		let curReal: string;
		try {
			curReal = fs.realpathSync(curAbs);
		} catch {
			continue;
		}
		if (!isContained(curReal, srcDirReal)) {
			throw new PreviewMountError("symlink escape rejected", 403);
		}

		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(curReal, { withFileTypes: true });
		} catch {
			continue;
		}
		const rel = path.relative(srcDirReal, curReal);
		const destDir = rel ? path.join(dir, rel) : dir;
		fs.mkdirSync(destDir, { recursive: true });

		for (const dent of entries) {
			const childAbs = path.join(curReal, dent.name);
			if (dent.isSymbolicLink()) {
				let childReal: string;
				try {
					childReal = fs.realpathSync(childAbs);
				} catch {
					continue;
				}
				if (!isContained(childReal, srcDirReal)) {
					throw new PreviewMountError("symlink escape rejected", 403);
				}
				let s: fs.Stats;
				try { s = fs.statSync(childReal); } catch { continue; }
				if (s.isDirectory()) {
					stack.push(childReal);
				} else if (s.isFile()) {
					copied += s.size;
					if (copied > PREVIEW_ASSET_MAX_BYTES) {
						throw new PreviewMountError("source tree exceeds 25 MiB asset cap", 413);
					}
					fs.copyFileSync(childReal, path.join(destDir, dent.name));
				}
				continue;
			}
			if (dent.isDirectory()) {
				stack.push(childAbs);
			} else if (dent.isFile()) {
				let s: fs.Stats;
				try { s = fs.statSync(childAbs); } catch { continue; }
				copied += s.size;
				if (copied > PREVIEW_ASSET_MAX_BYTES) {
					throw new PreviewMountError("source tree exceeds 25 MiB asset cap", 413);
				}
				fs.copyFileSync(childAbs, path.join(destDir, dent.name));
			}
		}
	}

	const projected = dirSize(dir);
	if (projected > PREVIEW_MOUNT_MAX_BYTES) {
		throw new PreviewMountError("Mount exceeds 100 MiB ceiling", 413);
	}

	return buildResult(sessionId, dir, entry);
}

function wipeDirContents(dir: string): void {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const e of entries) {
		const full = path.join(dir, e.name);
		try {
			if (e.isDirectory()) {
				fs.rmSync(full, { recursive: true, force: true });
			} else {
				fs.unlinkSync(full);
			}
		} catch { /* ok */ }
	}
}

/** Recursively delete the per-session mount. Idempotent. */
export function removeMount(sessionId: string): void {
	if (!VALID_SESSION_ID.test(sessionId)) return;
	const dir = path.join(bobbitStateDir(), "preview", sessionId);
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch { /* ok */ }
}

/** Subscribe to fs changes for the mount. Returns an unsubscribe function. */
export function watchMount(sessionId: string, onChange: () => void): () => void {
	assertValidSession(sessionId);
	const dir = mountDir(sessionId);
	let timer: NodeJS.Timeout | null = null;
	const fire = () => {
		if (timer) return;
		timer = setTimeout(() => {
			timer = null;
			try { onChange(); } catch { /* ok */ }
		}, 50);
	};
	let watcher: fs.FSWatcher | null = null;
	try {
		watcher = fs.watch(dir, { recursive: true }, fire);
	} catch {
		// Linux without recursive support — fall back to non-recursive.
		try { watcher = fs.watch(dir, fire); } catch { /* ok */ }
	}
	return () => {
		if (timer) { clearTimeout(timer); timer = null; }
		if (watcher) { try { watcher.close(); } catch { /* ok */ } }
	};
}

function isContained(child: string, parent: string): boolean {
	if (child === parent) return true;
	const sep = path.sep;
	const parentWithSep = parent.endsWith(sep) ? parent : parent + sep;
	return child.startsWith(parentWithSep);
}
