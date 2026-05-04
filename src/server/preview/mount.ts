/**
 * Per-session preview mount lifecycle.
 *
 * Single source of truth for `<bobbitStateDir>/preview/<sid>/`. Owned by
 * the gateway: agent extension POSTs HTML / file paths to a mount endpoint
 * (WP-D), the route handler calls `writeInline` / `copyFileTree` here, and
 * the content-origin route (WP-B) serves files back out of `mountDir(sid)`.
 *
 * Public API:
 *   mountDir(sid)                               → host directory
 *   writeInline(sid, html, entry?)              → write inline.html (or chosen entry)
 *   copyFileTree(sid, srcFile)                  → copy srcFile + sibling tree
 *   removeMount(sid)                            → recursive delete (idempotent)
 *   watchMount(sid, onChange)                   → debounced fs watch + unsubscribe
 *
 * All errors are `PreviewMountError` with a `statusCode` so the route handler
 * can map directly to HTTP. Codes: 400 / 403 / 404 / 413.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { bobbitStateDir } from "../bobbit-dir.js";

/** Same shape as `VALID_SESSION_ID` in `server.ts` (UUID v4-style). */
const VALID_SESSION_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

/** 100 MiB ceiling per session mount. */
export const MAX_MOUNT_BYTES = 100 * 1024 * 1024;

/** 25 MiB cap per copyFileTree call (mirrors path-guard MAX_ASSET_SIZE). */
export const MAX_COPY_BYTES = 25 * 1024 * 1024;

/** Default entry filename when only inline HTML is supplied. */
export const DEFAULT_INLINE_ENTRY = "inline.html";

export interface MountResult {
	/** Public content-origin URL the renderer should open. */
	url: string;
	/** Host-absolute path to the entry file (debug parity with v2 markers). */
	path: string;
	/** Relative entry filename inside the mount. */
	entry: string;
	/** mtime of the entry file in ms since epoch. */
	mtime: number;
}

/** Typed error so the route handler can map directly to HTTP. */
export class PreviewMountError extends Error {
	statusCode: number;
	constructor(statusCode: number, message: string) {
		super(message);
		this.name = "PreviewMountError";
		this.statusCode = statusCode;
	}
}

// ──────────────────────────────────────────────────────────────────────────
// stateDir resolution
// ──────────────────────────────────────────────────────────────────────────

/**
 * Resolve the preview parent directory `<stateDir>/preview/`. Allows tests
 * to override via `setPreviewRootForTesting`.
 */
let _previewRootOverride: string | undefined;
export function setPreviewRootForTesting(dir: string | undefined): void {
	_previewRootOverride = dir;
}
function previewRoot(): string {
	return _previewRootOverride ?? path.join(bobbitStateDir(), "preview");
}

// ──────────────────────────────────────────────────────────────────────────
// Validation helpers
// ──────────────────────────────────────────────────────────────────────────

function validateSessionId(sessionId: string): void {
	if (!sessionId || !VALID_SESSION_ID.test(sessionId)) {
		throw new PreviewMountError(400, "Invalid sessionId");
	}
}

/**
 * Entry must be a single path segment (no separators, no traversal, no NUL).
 * Forbidding `/` and `\\` keeps the entry confined to the mount root — sub-
 * directories are populated only via `copyFileTree`.
 */
function validateEntry(entry: string): string {
	if (!entry || typeof entry !== "string") {
		throw new PreviewMountError(400, "Invalid entry");
	}
	if (entry.indexOf("\0") >= 0) throw new PreviewMountError(400, "Invalid entry");
	if (entry === "." || entry === "..") throw new PreviewMountError(400, "Invalid entry");
	if (entry.indexOf("/") >= 0 || entry.indexOf("\\") >= 0) {
		throw new PreviewMountError(400, "Invalid entry");
	}
	if (entry.indexOf("..") >= 0 && (entry.startsWith("..") || entry.endsWith(".."))) {
		throw new PreviewMountError(400, "Invalid entry");
	}
	return entry;
}

// ──────────────────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────────────────

export function mountDir(sessionId: string): string {
	validateSessionId(sessionId);
	const dir = path.join(previewRoot(), sessionId);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

export function writeInline(sessionId: string, html: string, entry?: string): MountResult {
	validateSessionId(sessionId);
	const safeEntry = validateEntry(entry ?? DEFAULT_INLINE_ENTRY);
	if (typeof html !== "string") {
		throw new PreviewMountError(400, "html must be a string");
	}

	const dir = mountDir(sessionId);
	const target = path.join(dir, safeEntry);
	const incoming = Buffer.byteLength(html, "utf-8");

	// Mount-total ceiling: existing bytes (excluding the file we're about to
	// overwrite) + incoming bytes ≤ MAX_MOUNT_BYTES.
	let existing = walkSize(dir);
	if (fs.existsSync(target)) {
		try { existing -= fs.statSync(target).size; } catch { /* ignore */ }
	}
	if (existing + incoming > MAX_MOUNT_BYTES) {
		throw new PreviewMountError(413, "Preview mount exceeds 100 MiB ceiling");
	}

	// Atomic write: temp file + rename within the same directory.
	const tmp = path.join(dir, `.${safeEntry}.tmp-${process.pid}-${Date.now()}`);
	fs.writeFileSync(tmp, html, "utf-8");
	try {
		fs.renameSync(tmp, target);
	} catch (err) {
		try { fs.unlinkSync(tmp); } catch { /* ignore */ }
		throw err;
	}

	return {
		url: `/preview/${sessionId}/${safeEntry}`,
		path: target,
		entry: safeEntry,
		mtime: fs.statSync(target).mtimeMs,
	};
}

export function copyFileTree(sessionId: string, srcFile: string): MountResult {
	validateSessionId(sessionId);
	if (!srcFile || typeof srcFile !== "string") {
		throw new PreviewMountError(400, "srcFile required");
	}
	if (!path.isAbsolute(srcFile)) {
		throw new PreviewMountError(400, "srcFile must be absolute");
	}

	// Realpath the source root (parity with path-guard.ts) so symlink escapes
	// from any descendant can be detected against the same base.
	const srcDir = path.dirname(srcFile);
	let srcRoot: string;
	try {
		srcRoot = fs.realpathSync(srcDir);
	} catch {
		throw new PreviewMountError(404, "srcFile parent not found");
	}

	let entryStat: fs.Stats;
	try {
		entryStat = fs.statSync(srcFile);
	} catch {
		throw new PreviewMountError(404, "srcFile not found");
	}
	if (!entryStat.isFile()) {
		throw new PreviewMountError(404, "srcFile not a regular file");
	}

	const entry = path.basename(srcFile);
	validateEntry(entry); // basename should already be a single segment

	const destRoot = mountDir(sessionId);

	// Wipe the existing mount before copy so we mirror the source tree
	// exactly. Idempotent — caller may invoke `copyFileTree` repeatedly.
	wipeContents(destRoot);

	// BFS walk srcRoot, copying regular files only. Reject any entry whose
	// realpath escapes srcRoot (symlinks pointing outside the source tree).
	let copiedBytes = 0;
	const queue: string[] = [srcRoot];
	while (queue.length > 0) {
		const dir = queue.shift()!;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const ent of entries) {
			const abs = path.join(dir, ent.name);
			let real: string;
			try {
				real = fs.realpathSync(abs);
			} catch {
				continue;
			}
			if (!isContained(real, srcRoot)) {
				// Symlink escape — refuse the entire copy. The mount is now
				// empty (we wiped) which is fine: the caller saw a 403.
				throw new PreviewMountError(403, "Symlink escapes source tree");
			}
			let st: fs.Stats;
			try { st = fs.statSync(real); } catch { continue; }
			const rel = path.relative(srcRoot, real);
			if (st.isDirectory()) {
				if (rel) fs.mkdirSync(path.join(destRoot, rel), { recursive: true });
				queue.push(real);
				continue;
			}
			if (!st.isFile()) continue;
			copiedBytes += st.size;
			if (copiedBytes > MAX_COPY_BYTES) {
				throw new PreviewMountError(413, "Source tree exceeds 25 MiB cap");
			}
			const dst = path.join(destRoot, rel);
			fs.mkdirSync(path.dirname(dst), { recursive: true });
			// Hardlink-where-supported, fall back to copyFile.
			try {
				// If a file already exists at dst (shouldn't after wipe, but
				// be defensive), unlink first so link() doesn't EEXIST.
				try { fs.unlinkSync(dst); } catch { /* ignore */ }
				fs.linkSync(real, dst);
			} catch {
				try {
					fs.copyFileSync(real, dst);
				} catch (err) {
					throw new PreviewMountError(500, `Copy failed: ${(err as Error).message}`);
				}
			}
		}
	}

	// Mount ceiling check after copy.
	if (walkSize(destRoot) > MAX_MOUNT_BYTES) {
		throw new PreviewMountError(413, "Preview mount exceeds 100 MiB ceiling");
	}

	const target = path.join(destRoot, entry);
	if (!fs.existsSync(target)) {
		// Source file was a symlink that resolved outside, or vanished mid-walk.
		throw new PreviewMountError(404, "Entry file missing after copy");
	}

	return {
		url: `/preview/${sessionId}/${entry}`,
		path: target,
		entry,
		mtime: fs.statSync(target).mtimeMs,
	};
}

export function removeMount(sessionId: string): void {
	if (!sessionId || !VALID_SESSION_ID.test(sessionId)) return; // idempotent on bad input
	const dir = path.join(previewRoot(), sessionId);
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		/* idempotent */
	}
}

// ──────────────────────────────────────────────────────────────────────────
// Watcher
// ──────────────────────────────────────────────────────────────────────────

interface WatcherEntry {
	subscribers: Set<() => void>;
	close: () => void;
}
const _watchers = new Map<string, WatcherEntry>();

export function watchMount(sessionId: string, onChange: () => void): () => void {
	validateSessionId(sessionId);
	const dir = mountDir(sessionId); // ensures it exists

	let entry = _watchers.get(sessionId);
	if (!entry) {
		const subscribers = new Set<() => void>();
		let timer: NodeJS.Timeout | null = null;
		const fire = () => {
			timer = null;
			for (const fn of subscribers) {
				try { fn(); } catch (err) { console.error("[preview/mount] subscriber threw", err); }
			}
		};
		const debounced = () => {
			if (timer) return;
			timer = setTimeout(fire, 50);
		};
		// `recursive: true` is supported on Win/macOS and modern Linux (Node 20+).
		// It silently degrades to top-level on older Linux — acceptable: most
		// preview interactions write through the entry file at the top level.
		const watcher = fs.watch(dir, { recursive: true }, debounced);
		watcher.on("error", err => {
			console.warn(`[preview/mount] watch error for ${sessionId}: ${err}`);
		});
		entry = {
			subscribers,
			close: () => {
				try { watcher.close(); } catch { /* ignore */ }
				if (timer) { clearTimeout(timer); timer = null; }
			},
		};
		_watchers.set(sessionId, entry);
	}

	entry.subscribers.add(onChange);
	const unsubscribe = () => {
		const e = _watchers.get(sessionId);
		if (!e) return;
		e.subscribers.delete(onChange);
		if (e.subscribers.size === 0) {
			e.close();
			_watchers.delete(sessionId);
		}
	};
	return unsubscribe;
}

// ──────────────────────────────────────────────────────────────────────────
// Internals
// ──────────────────────────────────────────────────────────────────────────

function walkSize(dir: string): number {
	let total = 0;
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return 0;
	}
	for (const ent of entries) {
		const abs = path.join(dir, ent.name);
		try {
			if (ent.isDirectory()) {
				total += walkSize(abs);
			} else if (ent.isFile()) {
				total += fs.statSync(abs).size;
			}
		} catch { /* ignore */ }
	}
	return total;
}

function wipeContents(dir: string): void {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const ent of entries) {
		const abs = path.join(dir, ent.name);
		try {
			fs.rmSync(abs, { recursive: true, force: true });
		} catch { /* ignore */ }
	}
}

function isContained(child: string, parent: string): boolean {
	if (child === parent) return true;
	const sep = path.sep;
	const parentWithSep = parent.endsWith(sep) ? parent : parent + sep;
	return child.startsWith(parentWithSep);
}
