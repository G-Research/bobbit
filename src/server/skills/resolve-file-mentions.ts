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
 *       • `binary`→ base64 snapshot in `data`; routed as a document
 *                   attachment by the handler; `modelText` untouched.
 *       • `unresolved` → missing / unreadable / too-large / outside-cwd /
 *                   aggregate-cap. Literal `@path` left in `modelText`,
 *                   `reason` set. **Never throws** — every failure path
 *                   degrades gracefully.
 *
 *   - **Snapshot at resolve time** — file content (text) and base64 bytes
 *     (image/binary) are captured now so replaying a `.jsonl` later renders
 *     the same content the model originally saw, even if the file changed
 *     on disk. (Same guarantee as skill expansions.)
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
	/** Resolved absolute host path (omitted if unresolved). */
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

/** Trailing punctuation trimmed off a token end (unlikely to be part of a path). */
const TRAILING_PUNCT = new Set([".", ",", ")", ":", ";"]);

/**
 * Build the model-facing inline block for a text mention. Exported so the
 * handler can re-splice text mentions and skill expansions onto the same
 * original string in one merged right-to-left pass (disjoint ranges).
 */
export function buildFileReferenceBlock(relPath: string, content: string): string {
	return `<file-reference path="${relPath.replace(/\\/g, "/")}">\n${content}\n</file-reference>`;
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

/** Heuristic: is this buffer likely UTF-8 text (not binary)? */
function isLikelyText(buf: Buffer): boolean {
	if (buf.length === 0) return true;
	if (buf.includes(0)) return false; // NUL byte ⇒ binary
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

	let aggregateUsed = 0;

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

		// Path safety: resolve relative to cwd and reject escapes.
		const absPath = path.resolve(cwd, normRel);
		const relCheck = path.relative(cwd, absPath);
		if (relCheck === ".." || relCheck.startsWith(".." + path.sep) || path.isAbsolute(relCheck)) {
			markUnresolved("outside-cwd");
			continue;
		}

		// Stat the file.
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

		// ── Image (by extension) ──────────────────────────────────────
		if (IMAGE_MIME[ext]) {
			if (size > maxFileBytes) {
				markUnresolved("too-large");
				continue;
			}
			let data: string;
			try {
				data = fs.readFileSync(absPath).toString("base64");
			} catch {
				markUnresolved("unreadable");
				continue;
			}
			if (aggregateUsed + data.length > maxAggregate) {
				markUnresolved("aggregate-cap");
				continue;
			}
			aggregateUsed += data.length;
			base.kind = "image";
			base.data = data;
			base.mimeType = IMAGE_MIME[ext];
			mentions.push(base);
			continue;
		}

		// ── Non-image: read and sniff text vs binary ─────────────────
		if (size > maxFileBytes) {
			markUnresolved("too-large");
			continue;
		}
		let buf: Buffer;
		try {
			buf = fs.readFileSync(absPath);
		} catch {
			markUnresolved("unreadable");
			continue;
		}

		if (isLikelyText(buf)) {
			if (size > maxTextBytes) {
				markUnresolved("too-large");
				continue;
			}
			const content = buf.toString("utf-8");
			const contentBytes = Buffer.byteLength(content, "utf-8");
			if (aggregateUsed + contentBytes > maxAggregate) {
				markUnresolved("aggregate-cap");
				continue;
			}
			aggregateUsed += contentBytes;
			base.kind = "text";
			base.content = content;
			mentions.push(base);
			replacements.push({
				start: tok.range[0],
				end: tok.range[1],
				expanded: buildFileReferenceBlock(normRel, content),
			});
			continue;
		}

		// Binary (non-image).
		const data = buf.toString("base64");
		if (aggregateUsed + data.length > maxAggregate) {
			markUnresolved("aggregate-cap");
			continue;
		}
		aggregateUsed += data.length;
		base.kind = "binary";
		base.data = data;
		base.mimeType = "application/octet-stream";
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
