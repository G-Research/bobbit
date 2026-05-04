/**
 * STUB — to be replaced by WP-A.
 *
 * Provides only the public API surface needed for WP-B/WP-C to type-check.
 * The real implementation lives in WP-A's branch and will overwrite this file.
 */

import fs from "node:fs";
import path from "node:path";
import { bobbitStateDir } from "../bobbit-dir.js";

export class PreviewMountError extends Error {
	statusCode: number;
	constructor(message: string, statusCode = 500) {
		super(message);
		this.name = "PreviewMountError";
		this.statusCode = statusCode;
	}
}

/** Absolute path to the per-session preview mount directory. */
export function mountDir(sessionId: string): string {
	return path.join(bobbitStateDir(), "preview", sessionId);
}

/** Write inline HTML to `<mount>/<entry>`; create mount dir if missing. */
export function writeInline(sessionId: string, html: string, entry = "inline.html"): string {
	const dir = mountDir(sessionId);
	fs.mkdirSync(dir, { recursive: true });
	const target = path.join(dir, entry);
	fs.writeFileSync(target, html, "utf-8");
	return target;
}

/** Copy `srcFile` and any siblings within its directory subtree into the mount. */
export function copyFileTree(_sessionId: string, _srcFile: string): { entry: string } {
	throw new PreviewMountError("copyFileTree stub — implemented in WP-A", 501);
}

/** Remove the per-session mount and all contents. */
export function removeMount(sessionId: string): void {
	try {
		fs.rmSync(mountDir(sessionId), { recursive: true, force: true });
	} catch { /* ignore */ }
}

type WatcherListener = () => void;
const subscribers = new Map<string, Set<WatcherListener>>();
const watchers = new Map<string, fs.FSWatcher>();

/**
 * Subscribe to changes inside the per-session mount. Returns an unsubscribe
 * function. Multiple subscribers share a single underlying `fs.watch` handle.
 */
export function watchMount(sessionId: string, onChange: WatcherListener): () => void {
	let bucket = subscribers.get(sessionId);
	if (!bucket) {
		bucket = new Set();
		subscribers.set(sessionId, bucket);
	}
	bucket.add(onChange);

	if (!watchers.has(sessionId)) {
		try {
			const dir = mountDir(sessionId);
			fs.mkdirSync(dir, { recursive: true });
			const w = fs.watch(dir, { recursive: true }, () => {
				const subs = subscribers.get(sessionId);
				if (!subs) return;
				for (const sub of subs) {
					try { sub(); } catch { /* ignore */ }
				}
			});
			w.on("error", () => { /* swallow — recursive not supported on some platforms */ });
			watchers.set(sessionId, w);
		} catch {
			/* fs.watch may throw on platforms that don't support recursive — silently degrade */
		}
	}

	return () => {
		const subs = subscribers.get(sessionId);
		if (!subs) return;
		subs.delete(onChange);
		if (subs.size === 0) {
			subscribers.delete(sessionId);
			const w = watchers.get(sessionId);
			if (w) {
				try { w.close(); } catch { /* ignore */ }
				watchers.delete(sessionId);
			}
		}
	};
}
