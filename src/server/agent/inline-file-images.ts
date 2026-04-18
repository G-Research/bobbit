/**
 * Rewrite `<img src="file://...">` references in QA HTML reports to inline
 * base64 data URIs.
 *
 * Why: QA reports are rendered in the browser from a blob URL. `file://` image
 * sources are blocked cross-origin, so the server inlines them before the
 * report is stored/served. The QA agent spills screenshots to disk via
 * `browser_screenshot(includeBase64=true)` and references them by absolute
 * path — this function closes the loop.
 *
 * Security: only files under the session cwd (including `<cwd>/.bobbit-qa/`)
 * are inlined. Anything else is left unchanged.
 *
 * Cap: total inlined bytes are limited (default 20 MB). Once the cap is hit,
 * remaining references are left as-is (partial inlining is fine; the bulk
 * usually fits).
 */

import * as fs from "node:fs";
import * as path from "node:path";

const IMG_TAG_RE = /<img\s[^>]*src=["']file:\/\/([^"']+)["'][^>]*>/gi;

const MIME_BY_EXT: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
};

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024; // 20 MB

export interface InlineFileImagesOptions {
	/** Max total inlined bytes before further replacements are skipped. Default 20 MB. */
	maxBytes?: number;
	/** Logger for skipped files (missing, outside cwd, etc.). Default: console.warn. */
	logger?: (msg: string) => void;
}

/**
 * Normalise a captured file:// path to an absolute filesystem path.
 *
 * Browsers typically emit `file:///C:/Users/foo.png` on Windows and
 * `file:///home/foo.png` on Unix. The regex captures everything after
 * `file://`, so Windows paths start with `/C:/...` — we strip the leading
 * slash when followed by a drive letter.
 */
function normaliseFilePath(captured: string): string {
	let p: string;
	try {
		p = decodeURIComponent(captured);
	} catch {
		p = captured;
	}
	// Windows: /C:/... → C:/...
	if (/^\/[A-Za-z]:[\\/]/.test(p)) p = p.slice(1);
	return path.normalize(p);
}

/** Check whether `abs` is inside `root` (or equal to it). */
function isUnderRoot(abs: string, root: string): boolean {
	const rel = path.relative(root, abs);
	if (!rel || rel === "") return true;
	if (rel.startsWith("..")) return false;
	if (path.isAbsolute(rel)) return false;
	return true;
}

export function inlineFileImages(
	html: string,
	sessionCwd: string,
	opts: InlineFileImagesOptions = {},
): string {
	const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
	const log = opts.logger ?? ((msg) => console.warn(msg));
	const root = path.resolve(sessionCwd);

	let inlinedBytes = 0;

	return html.replace(IMG_TAG_RE, (fullTag, capturedPath) => {
		const abs = normaliseFilePath(capturedPath);

		// 1. Extension check
		const ext = path.extname(abs).toLowerCase();
		const mime = MIME_BY_EXT[ext];
		if (!mime) return fullTag;

		// 2. Containment check — must be under sessionCwd tree
		const absResolved = path.resolve(abs);
		if (!isUnderRoot(absResolved, root)) {
			log(`[inline-file-images] Skipping path outside session cwd: ${absResolved}`);
			return fullTag;
		}

		// 3. Existence + size check
		let buf: Buffer;
		try {
			const stat = fs.statSync(absResolved);
			if (!stat.isFile()) return fullTag;
			buf = fs.readFileSync(absResolved);
		} catch (err: any) {
			log(`[inline-file-images] Missing image file: ${absResolved} (${err?.code || err?.message || "unknown"})`);
			return fullTag;
		}

		// 4. Budget check — skip (leave unchanged) once we'd exceed the cap
		if (inlinedBytes + buf.length > maxBytes) {
			log(`[inline-file-images] 20 MB cap reached, skipping: ${absResolved}`);
			return fullTag;
		}
		inlinedBytes += buf.length;

		// 5. Rewrite the src attribute only, preserving other attributes.
		const dataUri = `data:${mime};base64,${buf.toString("base64")}`;
		return fullTag.replace(
			/src=["']file:\/\/[^"']+["']/i,
			`src="${dataUri}"`,
		);
	});
}
