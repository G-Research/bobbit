/**
 * Pure resolver for `@path` file-mention references in user prompt text.
 *
 * Parallels `resolve-skill-expansions.ts` layer-for-layer (see design §2):
 *
 *   - **Inline scan only** — regex `(^|\s)@([^\s@]+)`. There is no
 *     prefix-only special case (a bare `@path` whole-message still works
 *     through the inline scan). Trailing punctuation (`.`, `,`, `)`, `:`,
 *     `;`) is trimmed off the token end and excluded from the chip range.
 *
 *   - **Hybrid resolution** — each `@path` is classified:
 *       • `text`  → file content is inlined into `modelText` inside a
 *                   `<file-reference path="…">…</file-reference>` block.
 *       • `image` → base64 snapshot in `data`; `modelText` left untouched
 *                   (the literal `@path` stays so the model has the
 *                   filename, and the handler routes the bytes through the
 *                   image attachment frame).
 *       • `binary`→ non-image, non-text files (e.g. `.zip`, `.bin`): base64
 *                   snapshot in `data`, ext-derived (or octet-stream) mimeType;
 *                   `modelText` left untouched (literal `@path` kept). The
 *                   handler routes these to the attachment pipeline as a
 *                   document — for UI chip + snapshot parity with
 *                   user-uploaded documents. (See handler note: model-side
 *                   delivery of document bytes is an existing platform concern,
 *                   not a regression of this feature.)
 *       • `unresolved` → missing / unreadable / too-large / outside-cwd /
 *                   aggregate-cap / too-many-mentions. Literal `@path` left in
 *                   `modelText`, `reason` set. **Never throws** — every failure
 *                   path degrades gracefully.
 *
 *   - **Snapshot at resolve time** — text content and image/binary base64
 *     bytes are captured now so replaying a `.jsonl` later renders the same
 *     content the model originally saw, even if the file changed on disk.
 *     (Same guarantee as skill expansions.)
 *
 *   - **Path safety** — the target is canonicalized with `fs.realpathSync`
 *     and a `path.relative` containment check is applied to the CANONICAL
 *     paths BEFORE any stat/read, so a symlink inside `cwd` that points
 *     outside `cwd` cannot leak host files.
 *
 * Text inlining splices **right-to-left** by range to preserve indices.
 *
 * Pure function: the only side effect is reading the referenced files.
 */

import fs from "node:fs";
import path from "node:path";

/** Char range, in UTF-16 code units (matches `String.prototype.slice`). */
export type MentionRange = [number, number];

export type MentionKind = "text" | "image" | "binary" | "unresolved";

export interface FileMention {
	/** Relative path exactly as typed (after the `@`), trailing punctuation trimmed. */
	path: string;
	/** Resolved (canonical) absolute host path. Internal to the resolver — the
	 *  handler strips this before the mention crosses the wire / is persisted. */
	absPath?: string;
	/** UTF-16 char range in `originalText` that the chip replaces (`@path` span). */
	range: MentionRange;
	kind: MentionKind;
	/** text kind: snapshotted file content (verbatim). */
	content?: string;
	/** image/binary kind: base64 (no data-URL prefix) snapshot. */
	data?: string;
	/** image/binary kind: detected MIME type. */
	mimeType?: string;
	/** Resolved file size in bytes. */
	bytes?: number;
	/** unresolved kind: human-readable reason. */
	reason?: string;
}

export interface ResolvedMentions {
	/** The user's original verbatim text. */
	originalText: string;
	/** Text after inlining text-file content — what the model sees. Equals `originalText` when no text mentions. */
	modelText: string;
	/** Recorded mentions of ALL kinds, in original-text order. Drives chips. */
	mentions: FileMention[];
	/** Non-fatal warnings, surfaced via `console.warn` by the handler. */
	warnings: string[];
}

/** Per-file cap for **text** inlining. Oversized text → unresolved (too-large). */
export const MAX_INLINE_TEXT_BYTES = 256 * 1024; // 256 KiB
/** Per-file cap for image/binary snapshots. Over → unresolved (too-large). */
export const MAX_MENTION_FILE_BYTES = 10 * 1024 * 1024; // 10 MiB
/** Aggregate cap across all resolved mentions in one send. */
export const MAX_MENTION_AGGREGATE_BYTES = 20 * 1024 * 1024; // 20 MiB
/** Max `@path` tokens resolved per send. Extra tokens → unresolved (too-many-mentions), no fs work. */
export const MAX_MENTIONS_PER_SEND = 50;

/** Image extensions → MIME type. */
const IMAGE_MIME: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".bmp": "image/bmp",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
	".avif": "image/avif",
};

/** A few common binary extensions → MIME type. Falls back to octet-stream. */
const BINARY_MIME: Record<string, string> = {
	".pdf": "application/pdf",
	".zip": "application/zip",
	".gz": "application/gzip",
	".tar": "application/x-tar",
	".wasm": "application/wasm",
	".doc": "application/msword",
	".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	".xls": "application/vnd.ms-excel",
	".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	".ppt": "application/vnd.ms-powerpoint",
	".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

function binaryMimeForExt(ext: string): string {
	return BINARY_MIME[ext] ?? "application/octet-stream";
}

/** Trailing punctuation trimmed off a token end (unlikely to be part of a path). */
const TRAILING_PUNCT = new Set([".", ",", ")", ":", ";"]);

/** Escape the five XML attribute-significant chars so a quote / angle bracket
 *  in a filename cannot break out of the `path="…"` delimiter. */
function escapeXmlAttr(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

/**
 * Build the model-facing inline block for a text mention. Exported so the
 * handler can re-splice text mentions and skill expansions onto the same
 * original string in one merged right-to-left pass (disjoint ranges). The path
 * is XML-attribute-escaped so a hostile filename cannot break the delimiter.
 */
export function buildFileReferenceBlock(relPath: string, content: string): string {
	return `<file-reference path="${escapeXmlAttr(relPath.replace(/\\/g, "/"))}">\n${content}\n</file-reference>`;
}

/**
 * Strip resolver-internal fields (`absPath`) from a mention before it crosses
 * the wire / is persisted to the sidecar. The UI never needs `absPath` and
 * exposing it would leak the host filesystem layout (FOLLOW-UP-D).
 */
export function toWireMention(m: FileMention): FileMention {
	const { absPath: _absPath, ...rest } = m;
	return rest;
}

export interface ResolveFileMentionsOptions {
	/** Text inlining cap (default {@link MAX_INLINE_TEXT_BYTES}). */
	maxFileBytes?: number;
	/** Image/binary per-file cap (default {@link MAX_MENTION_FILE_BYTES}). */
	maxMentionFileBytes?: number;
	/** Aggregate cap across one send (default {@link MAX_MENTION_AGGREGATE_BYTES}). */
	maxAggregateBytes?: number;
}

interface ScannedToken {
	/** Trimmed path exactly as typed (forward or back slashes preserved). */
	rawPath: string;
	/** UTF-16 range covering `@path` in the original text. */
	range: MentionRange;
}

/** Scan the text for `@path` tokens (inline, word-boundary anchored). */
function scanTokens(text: string): ScannedToken[] {
	const re = /(^|\s)@([^\s@]+)/g;
	const out: ScannedToken[] = [];
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		let token = m[2];
		// Trim trailing punctuation that is unlikely to be part of a path.
		while (token.length > 0 && TRAILING_PUNCT.has(token[token.length - 1])) {
			token = token.slice(0, -1);
		}
		if (token.length === 0) continue;
		const prefixLen = m[1].length; // 0 at string start, 1 after whitespace
		const tokenStart = m.index + prefixLen; // position of "@"
		const tokenEnd = tokenStart + 1 + token.length; // covers "@" + path
		out.push({ rawPath: token, range: [tokenStart, tokenEnd] });
	}
	return out;
}

/** True when `target` is not contained within `baseDir` (escape via `..` / absolute). */
function escapesDir(baseDir: string, target: string): boolean {
	const rel = path.relative(baseDir, target);
	return rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel);
}

/** Heuristic: is this buffer likely UTF-8 text (not binary)? */
function isLikelyText(buf: Buffer): boolean {
	if (buf.length === 0) return true;
	if (buf.includes(0)) return false; // NUL byte ⇒ binary
	// Reject content that is not valid UTF-8 (e.g. stray high bytes from a
	// binary blob without NULs). A fatal TextDecoder throws on malformed input.
	try {
		new TextDecoder("utf-8", { fatal: true }).decode(buf);
	} catch {
		return false;
	}
	const sample = buf.subarray(0, Math.min(buf.length, 8192));
	let control = 0;
	for (const b of sample) {
		if (b === 9 || b === 10 || b === 13) continue; // tab / LF / CR
		if (b < 32 || b === 127) control++;
	}
	return control / sample.length < 0.3;
}

/**
 * Resolve all `@path` file mentions in `text`, relative to `cwd`.
 * See module doc for semantics. Pure — only reads the referenced files.
 */
export function resolveFileMentions(
	text: string,
	cwd: string,
	opts?: ResolveFileMentionsOptions,
): ResolvedMentions {
	const originalText = text;
	const maxTextBytes = opts?.maxFileBytes ?? MAX_INLINE_TEXT_BYTES;
	const maxFileBytes = opts?.maxMentionFileBytes ?? MAX_MENTION_FILE_BYTES;
	const maxAggregate = opts?.maxAggregateBytes ?? MAX_MENTION_AGGREGATE_BYTES;

	const tokens = scanTokens(text);
	const mentions: FileMention[] = [];
	const warnings: string[] = [];
	const replacements: Array<{ start: number; end: number; expanded: string }> = [];

	// Canonicalize cwd once for symlink-safe containment checks. Fall back to
	// the lexically-resolved cwd if it cannot be realpath'd (e.g. missing).
	const resolvedCwd = path.resolve(cwd);
	let canonicalCwd: string;
	try {
		canonicalCwd = fs.realpathSync.native(resolvedCwd);
	} catch {
		canonicalCwd = resolvedCwd;
	}

	let aggregateUsed = 0;
	let resolvedCount = 0;

	for (const tok of tokens) {
		const rawPath = tok.rawPath;
		const normRel = rawPath.replace(/\\/g, "/");
		const base: FileMention = { path: rawPath, range: tok.range, kind: "unresolved" };

		const markUnresolved = (reason: string) => {
			base.kind = "unresolved";
			base.reason = reason;
			mentions.push(base);
			warnings.push(`@${rawPath}: ${reason}`);
		};

		// Mention-count cap: beyond the cap, degrade without any filesystem work.
		if (resolvedCount >= MAX_MENTIONS_PER_SEND) {
			markUnresolved("too-many-mentions");
			continue;
		}
		resolvedCount++;

		// Path safety, step 1: cheap lexical reject of obvious `..` / absolute
		// escapes (also handles non-existent traversal paths).
		const lexicalAbs = path.resolve(resolvedCwd, normRel);
		if (escapesDir(resolvedCwd, lexicalAbs)) {
			markUnresolved("outside-cwd");
			continue;
		}

		// Path safety, step 2: canonicalize to defeat symlink escapes. realpath
		// throws when the target does not exist → treat as missing. The
		// containment check runs on the CANONICAL paths BEFORE any stat/read,
		// so a symlink inside cwd pointing outside cwd is rejected.
		let absPath: string;
		try {
			absPath = fs.realpathSync.native(lexicalAbs);
		} catch {
			markUnresolved("missing");
			continue;
		}
		if (escapesDir(canonicalCwd, absPath)) {
			markUnresolved("outside-cwd");
			continue;
		}

		// Stat the (canonical) file.
		let size: number;
		try {
			const st = fs.statSync(absPath);
			if (!st.isFile()) {
				markUnresolved("missing");
				continue;
			}
			size = st.size;
		} catch {
			markUnresolved("missing");
			continue;
		}

		base.absPath = absPath;
		base.bytes = size;
		const ext = path.extname(normRel).toLowerCase();

		// Per-file cap, checked against the STAT size before any read so a giant
		// file is never loaded. (Text has a smaller cap, applied post-read on
		// the decoded content below.)
		if (size > maxFileBytes) {
			markUnresolved("too-large");
			continue;
		}
		// Aggregate gate BEFORE reading/encoding: with up to 50 mentions × 10 MiB
		// each, unconditional reads would block the WS handler with hundreds of
		// MiB despite the 20 MiB cap. Pre-check using the known stat size; only
		// read when it fits, then account the actual bytes.
		if (aggregateUsed + size > maxAggregate) {
			markUnresolved("aggregate-cap");
			continue;
		}

		let buf: Buffer;
		try {
			buf = fs.readFileSync(absPath);
		} catch {
			markUnresolved("unreadable");
			continue;
		}
		// TOCTOU: the file may have grown between stat and read. Re-validate the
		// per-file cap and remaining aggregate budget against the bytes we
		// actually got; never emit oversized content.
		if (buf.length > maxFileBytes) {
			markUnresolved("too-large");
			continue;
		}
		if (aggregateUsed + buf.length > maxAggregate) {
			markUnresolved("aggregate-cap");
			continue;
		}

		// ── Image (by extension) ──────────────────────────────────────
		if (IMAGE_MIME[ext]) {
			aggregateUsed += buf.length;
			base.kind = "image";
			base.data = buf.toString("base64");
			base.mimeType = IMAGE_MIME[ext];
			base.bytes = buf.length;
			mentions.push(base);
			continue;
		}

		// ── Non-image: sniff text vs binary ──────────────────────────
		if (isLikelyText(buf)) {
			const content = buf.toString("utf-8");
			const contentBytes = Buffer.byteLength(content, "utf-8");
			// Text has a smaller per-file cap, applied to the decoded content.
			if (contentBytes > maxTextBytes) {
				markUnresolved("too-large");
				continue;
			}
			// Re-check aggregate against the actual content bytes (TOCTOU).
			if (aggregateUsed + contentBytes > maxAggregate) {
				markUnresolved("aggregate-cap");
				continue;
			}
			aggregateUsed += contentBytes;
			base.kind = "text";
			base.content = content;
			base.bytes = buf.length;
			mentions.push(base);
			replacements.push({
				start: tok.range[0],
				end: tok.range[1],
				expanded: buildFileReferenceBlock(normRel, content),
			});
			continue;
		}

		// Non-image binary (per frozen design §2): snapshot base64 in `data`,
		// ext-derived mimeType. The handler routes this to attachments[] as a
		// document for UI chip + snapshot parity. `modelText` is left untouched
		// (literal `@path` kept). Caps already enforced above.
		aggregateUsed += buf.length;
		base.kind = "binary";
		base.data = buf.toString("base64");
		base.mimeType = binaryMimeForExt(ext);
		base.bytes = buf.length;
		mentions.push(base);
	}

	// Build modelText by splicing text mentions right-to-left.
	let modelText = text;
	if (replacements.length > 0) {
		replacements.sort((a, b) => a.start - b.start);
		for (let i = replacements.length - 1; i >= 0; i--) {
			const r = replacements[i];
			modelText = modelText.slice(0, r.start) + r.expanded + modelText.slice(r.end);
		}
	}

	return { originalText, modelText, mentions, warnings };
}
