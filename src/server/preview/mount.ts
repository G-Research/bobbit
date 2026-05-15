/**
 * Per-session preview mount lifecycle.
 *
 * Single source of truth for `<bobbitStateDir>/preview/<sid>/`. Owned by
 * the gateway: agent extension POSTs HTML / file paths to a mount endpoint
 * (WP-D), the route handler calls `writeInline` / `mountFile` here, and
 * the content-origin route (WP-B) serves files back out of `mountDir(sid)`.
 *
 * Asset inclusion contract (post opt-in):
 *   - `writeInline(sid, html, entry?)` writes only the entry — no siblings.
 *   - `mountFile(sid, srcFile, assets?)` copies only `srcFile` plus the
 *     declared assets (literals or single-segment globs). Sibling files in
 *     the source dir that are NOT declared are NOT copied. There is no
 *     BFS-of-everything fallback. See docs/preview-architecture.md.
 *
 * Public API:
 *   mountDir(sid)                               → host directory
 *   writeInline(sid, html, entry?)              → write inline.html (or chosen entry)
 *   mountFile(sid, srcFile, assets?)            → copy entry + declared assets
 *   removeMount(sid)                            → recursive delete (idempotent)
 *   watchMount(sid, onChange)                   → debounced fs watch + unsubscribe
 *
 * All errors are `PreviewMountError` with a `statusCode` so the route handler
 * can map directly to HTTP. Codes: 400 / 403 / 404 / 500.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { bobbitStateDir } from "../bobbit-dir.js";

/** Same shape as `VALID_SESSION_ID` in `server.ts` (UUID v4-style). */
const VALID_SESSION_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

/**
 * @deprecated The 100 MiB mount ceiling was removed when asset inclusion
 * became explicit (agents declare what to copy via `assets[]`/`manifest`).
 * Kept as a re-export for backwards compatibility with imports that exist
 * elsewhere in-tree; the value is no longer enforced.
 */
export const MAX_MOUNT_BYTES = 100 * 1024 * 1024;

/** Default entry filename when only inline HTML is supplied. */
export const DEFAULT_INLINE_ENTRY = "inline.html";

export interface MountResult {
	/** Public content-origin URL the renderer should open. */
	url: string;
	/** Host-absolute path to the entry file (debug parity with v2 markers). */
	path: string;
	/**
	 * Project-root-relative entry identifier — always `<sessionId>/<entry>`
	 * with forward slashes (POSIX) regardless of host OS. Host-invariant, so
	 * its size is bounded by content shape, not where `bobbitStateDir()`
	 * happens to live on disk. Stamped into the v3 preview-snapshot block by
	 * the agent tool so the per-block size stays under the 250 B cap on
	 * macOS (`/private/var/folders/...`) and Windows E2E harness paths too.
	 * See `defaults/tools/html/extension.ts` and `defaults/tools/html/snapshot.ts`.
	 */
	relPath: string;
	/** Relative entry filename inside the mount. */
	entry: string;
	/** mtime of the entry file in ms since epoch. */
	mtime: number;
}

/** Extension of MountResult returned by `mountFile`: echoes resolved assets. */
export interface MountFileResult extends MountResult {
	/** Asset paths actually copied, relative to the entry file's directory.
	 *  Useful for the route handler / renderer to round-trip. */
	assets: string[];
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
	if (entry.includes("..")) {
		throw new PreviewMountError(400, "Invalid entry");
	}
	return entry;
}

/**
 * Asset path validation per the design doc:
 *   1. Must be a non-empty string after trimming.
 *   2. No NUL.
 *   3. Not absolute (incl. `C:\` Windows drives).
 *   4. No backslashes — force forward slashes for portability.
 *   5. No `..` segments after normalisation.
 *   6. For globs: only `*` and `?` allowed; reject `**`, `[abc]`, `{a,b}`.
 *
 * Returns the trimmed asset string. Throws PreviewMountError(400) on reject.
 */
function validateAssetSpec(asset: unknown): string {
	if (typeof asset !== "string") {
		throw new PreviewMountError(400, "Asset must be a string");
	}
	const trimmed = asset.trim();
	if (trimmed === "") {
		throw new PreviewMountError(400, "Asset must be a non-empty string");
	}
	if (trimmed.indexOf("\0") >= 0) {
		throw new PreviewMountError(400, `Invalid asset path: ${asset}`);
	}
	if (trimmed.indexOf("\\") >= 0) {
		throw new PreviewMountError(400, `Invalid asset path (use forward slashes): ${asset}`);
	}
	if (path.isAbsolute(trimmed) || /^[a-zA-Z]:\//.test(trimmed)) {
		throw new PreviewMountError(400, `Asset path must be relative: ${asset}`);
	}
	// Reject `..` segments.
	const segments = trimmed.split("/");
	for (const seg of segments) {
		if (seg === "..") {
			throw new PreviewMountError(400, `Asset path may not contain '..': ${asset}`);
		}
	}
	// Reject unsupported glob constructs.
	if (trimmed.indexOf("**") >= 0) {
		throw new PreviewMountError(400, `Glob '**' is not supported: ${asset}`);
	}
	if (trimmed.indexOf("[") >= 0 || trimmed.indexOf("]") >= 0) {
		throw new PreviewMountError(400, `Glob character class '[...]' is not supported: ${asset}`);
	}
	if (trimmed.indexOf("{") >= 0 || trimmed.indexOf("}") >= 0) {
		throw new PreviewMountError(400, `Glob brace expansion '{a,b}' is not supported: ${asset}`);
	}
	return trimmed;
}

function isGlob(spec: string): boolean {
	return spec.indexOf("*") >= 0 || spec.indexOf("?") >= 0;
}

/** Compile a single-path glob (no `/`) into a RegExp. */
function compileGlobSegment(segment: string): RegExp {
	let re = "^";
	for (const ch of segment) {
		if (ch === "*") re += "[^/]*";
		else if (ch === "?") re += "[^/]";
		else re += ch.replace(/[.+^${}()|\\]/g, "\\$&");
	}
	re += "$";
	return new RegExp(re);
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
		relPath: path.posix.join(sessionId, safeEntry),
		entry: safeEntry,
		mtime: Math.floor(fs.statSync(target).mtimeMs),
	};
}

/**
 * Mount the entry HTML file plus a caller-declared list of assets.
 *
 * Behaviour:
 *   - Stages the entry + resolved assets into a sibling tmp directory first,
 *     reading ALL source data before touching `destRoot`. This is what makes
 *     re-opening a path that lives inside the existing mount safe (Bug 4):
 *     sources are captured before the wipe runs.
 *   - Then wipes `destRoot`'s contents (preserving its inode so any active
 *     `watchMount()` handle stays valid) and renames each staged entry into
 *     place.
 *   - Copies only `srcFile` plus the resolved `assets` (literals + globs).
 *   - Globs may use `*` and `?` in a single path segment; `**`/`[...]`/`{a,b}`
 *     are rejected.
 *   - Symlink escape: any resolved asset whose realpath is not contained in
 *     the entry's source dir is rejected with 403.
 *   - Unmatched literal asset → 404.
 *   - On any staging error, the tmp dir is deleted and `destRoot` is left
 *     untouched (previous mount preserved).
 *
 * No size cap — the agent is responsible for declaring only what it needs.
 */
export function mountFile(
	sessionId: string,
	srcFile: string,
	assets?: string[],
): MountFileResult {
	validateSessionId(sessionId);
	if (!srcFile || typeof srcFile !== "string") {
		throw new PreviewMountError(400, "srcFile required");
	}
	if (!path.isAbsolute(srcFile)) {
		throw new PreviewMountError(400, "srcFile must be absolute");
	}

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
	validateEntry(entry);

	const destRoot = mountDir(sessionId);

	const list = Array.isArray(assets) ? assets : [];
	// Pre-validate all asset specs first so we fail fast before any extra work.
	const specs = list.map(validateAssetSpec);

	// Resolve the entry's realpath up-front so we can detect symlink escape.
	const entryReal = (() => {
		try { return fs.realpathSync(srcFile); } catch { return srcFile; }
	})();
	if (!isContained(entryReal, srcRoot) && entryReal !== path.join(srcRoot, entry)) {
		// Entry's realpath escapes its declared dir (symlink escape on the entry).
		throw new PreviewMountError(403, "Entry symlink escapes source tree");
	}

	// ── Stage into a sibling tmp dir ─────────────────────────────────────
	// Sibling of `destRoot` so the swap is same-filesystem. The randomised
	// suffix avoids collisions between concurrent mountFile() calls for the
	// same sid (we accept last-writer-wins; no cross-call locking).
	const tmpName = `.${sessionId}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`;
	const tmpRoot = path.join(previewRoot(), tmpName);
	fs.mkdirSync(tmpRoot, { recursive: true });

	const resolvedAssets: Set<string> = new Set();

	try {
		// Copy entry into tmp. Reading from `entryReal` BEFORE we touch
		// destRoot is what makes "srcFile inside destRoot" safe.
		copyOneFile(entryReal, path.join(tmpRoot, entry));

		for (const spec of specs) {
			if (isGlob(spec)) {
				const matches = expandGlob(srcRoot, spec);
				// A glob that matches nothing is OK (agent may speculatively list
				// `img/*.png` even when none exist yet). It's not a hard error —
				// matches the design doc which only specifies 404 for *literal*
				// missing assets.
				for (const rel of matches) {
					const abs = path.join(srcRoot, rel);
					let real: string;
					try { real = fs.realpathSync(abs); } catch { continue; }
					if (!isContained(real, srcRoot)) {
						throw new PreviewMountError(403, `Asset escapes source tree: ${rel}`);
					}
					let st: fs.Stats;
					try { st = fs.statSync(real); } catch { continue; }
					if (!st.isFile()) continue;
					const dst = path.join(tmpRoot, rel);
					fs.mkdirSync(path.dirname(dst), { recursive: true });
					copyOneFile(real, dst);
					resolvedAssets.add(rel.split(path.sep).join("/"));
				}
			} else {
				// Literal — must exist.
				const rel = spec; // already forward-slash, no `..`, not absolute
				const abs = path.resolve(srcRoot, rel);
				// Containment check against the unresolved path first (file may
				// not exist as a symlink yet).
				if (!isContained(abs, srcRoot)) {
					throw new PreviewMountError(400, `Asset escapes source tree: ${rel}`);
				}
				let real: string;
				try {
					real = fs.realpathSync(abs);
				} catch {
					throw new PreviewMountError(404, `Asset '${rel}' not found`);
				}
				if (!isContained(real, srcRoot)) {
					throw new PreviewMountError(403, `Asset symlink escapes source tree: ${rel}`);
				}
				let st: fs.Stats;
				try { st = fs.statSync(real); } catch {
					throw new PreviewMountError(404, `Asset '${rel}' not found`);
				}
				if (!st.isFile()) {
					throw new PreviewMountError(404, `Asset '${rel}' is not a regular file`);
				}
				const dst = path.join(tmpRoot, rel);
				fs.mkdirSync(path.dirname(dst), { recursive: true });
				copyOneFile(real, dst);
				resolvedAssets.add(rel);
			}
		}

		// ── Atomic swap ─────────────────────────────────────────────────
		// All sources are now captured under tmpRoot. Wipe destRoot's
		// contents (preserving its inode so the existing fs.watch handle in
		// `watchMount()` stays valid) and rename each staged entry into
		// place. This also fixes the half-wiped-mount race a concurrent GET
		// could otherwise hit between wipe and copy.
		wipeContents(destRoot);
		moveContents(tmpRoot, destRoot);
	} catch (err) {
		// Staging failed — destRoot is untouched if we hadn't reached the
		// swap yet. Either way, drop the tmp dir.
		try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
		throw err;
	}

	// Clean up the now-empty tmp dir.
	try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }

	const target = path.join(destRoot, entry);
	if (!fs.existsSync(target)) {
		throw new PreviewMountError(500, "Entry file missing after swap");
	}

	return {
		url: `/preview/${sessionId}/${entry}`,
		path: target,
		relPath: path.posix.join(sessionId, entry),
		entry,
		mtime: Math.floor(fs.statSync(target).mtimeMs),
		assets: Array.from(resolvedAssets).sort(),
	};
}

/**
 * Move every entry from `srcDir` into `dstDir` via `fs.renameSync`. Recurses
 * into directories so we preserve `dstDir`'s inode (renaming the staged
 * subdirectories into place rather than replacing the parent).
 *
 * Falls back to copy+unlink if rename fails (cross-device — shouldn't happen
 * for sibling tmp/dest, but be defensive).
 */
function moveContents(srcDir: string, dstDir: string): void {
	let entries: fs.Dirent[];
	try { entries = fs.readdirSync(srcDir, { withFileTypes: true }); } catch { return; }
	for (const ent of entries) {
		const from = path.join(srcDir, ent.name);
		const to = path.join(dstDir, ent.name);
		try {
			fs.renameSync(from, to);
		} catch {
			// Cross-device or destination clash — copy then remove source.
			try { fs.rmSync(to, { recursive: true, force: true }); } catch { /* ignore */ }
			if (ent.isDirectory()) {
				fs.mkdirSync(to, { recursive: true });
				moveContents(from, to);
				try { fs.rmdirSync(from); } catch { /* ignore */ }
			} else {
				copyOneFile(from, to);
				try { fs.unlinkSync(from); } catch { /* ignore */ }
			}
		}
	}
}

export function removeMount(sessionId: string): void {
	if (!sessionId || !VALID_SESSION_ID.test(sessionId)) return;
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
	const dir = mountDir(sessionId);

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

function copyOneFile(src: string, dst: string): void {
	try { fs.unlinkSync(dst); } catch { /* ignore */ }
	try {
		fs.linkSync(src, dst);
	} catch {
		try {
			fs.copyFileSync(src, dst);
		} catch (err) {
			throw new PreviewMountError(500, `Copy failed: ${(err as Error).message}`);
		}
	}
}

/**
 * Expand a single-spec glob (e.g. `img/*.png`, `*.css`, `sub/dir/*.js`)
 * against `srcRoot`. Returns relative paths (POSIX-style, with `/`).
 *
 * Implementation: split spec on `/`. For each segment, if it contains a
 * wildcard, list the directory and match. If not, descend literally. No `**`
 * support — that was rejected in `validateAssetSpec`.
 */
function expandGlob(srcRoot: string, spec: string): string[] {
	const segments = spec.split("/");
	let candidates: string[] = [""]; // relative-to-srcRoot directories so far
	const isFinalSeg = (i: number) => i === segments.length - 1;

	for (let i = 0; i < segments.length; i++) {
		const seg = segments[i];
		const next: string[] = [];
		const wildcard = seg.indexOf("*") >= 0 || seg.indexOf("?") >= 0;
		const re = wildcard ? compileGlobSegment(seg) : null;

		for (const cand of candidates) {
			const candAbs = cand === "" ? srcRoot : path.join(srcRoot, cand);
			if (wildcard) {
				let entries: fs.Dirent[];
				try { entries = fs.readdirSync(candAbs, { withFileTypes: true }); } catch { continue; }
				for (const ent of entries) {
					if (!re!.test(ent.name)) continue;
					if (isFinalSeg(i)) {
						if (ent.isFile() || ent.isSymbolicLink()) {
							next.push(cand === "" ? ent.name : `${cand}/${ent.name}`);
						}
					} else if (ent.isDirectory()) {
						next.push(cand === "" ? ent.name : `${cand}/${ent.name}`);
					}
				}
			} else {
				const childAbs = path.join(candAbs, seg);
				let st: fs.Stats;
				try { st = fs.statSync(childAbs); } catch { continue; }
				if (isFinalSeg(i)) {
					if (st.isFile()) next.push(cand === "" ? seg : `${cand}/${seg}`);
				} else if (st.isDirectory()) {
					next.push(cand === "" ? seg : `${cand}/${seg}`);
				}
			}
		}
		candidates = next;
		if (candidates.length === 0) break;
	}
	return candidates;
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
