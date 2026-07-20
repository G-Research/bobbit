/**
 * Pure resolver for `@path` file-mention references in user prompt text.
 *
 * Parallels `resolve-skill-expansions.ts` layer-for-layer (see design §2):
 *
 *   - **Markdown-aware inline scan** — `@path` candidates are found only
 *     outside fenced code blocks and matched inline backtick spans. Source
 *     indices are never rewritten during scanning. There is no prefix-only
 *     special case (a bare `@path` whole-message still works through the
 *     inline scan). Trailing punctuation (`.`, `,`, `)`, `:`, `;`) is trimmed
 *     off the token end and excluded from the chip range.
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
 *       • `unresolved` → an existing target that cannot be delivered because
 *                   it is unreadable / too-large / outside-cwd / over the
 *                   aggregate cap / beyond the mention-count cap. Literal
 *                   `@path` is left in `modelText`, with `reason` set.
 *       • genuinely missing targets are ordinary text and are omitted from
 *                   mentions and warnings. **Never throws** — every failure
 *                   path degrades gracefully.
 *
 *   - **Snapshot at resolve time** — text content and image/binary base64
 *     bytes are captured now so replaying a `.jsonl` later renders the same
 *     content the model originally saw, even if the file changed on disk.
 *     (Same guarantee as skill expansions.)
 *
 *   - **Path safety** — after a metadata-only existence classification, the
 *     target is canonicalized with `fs.realpathSync` and a `path.relative`
 *     containment check is applied to the CANONICAL paths BEFORE any stat/read,
 *     so a symlink inside `cwd` that points outside `cwd` cannot leak host files.
 *
 * Text inlining splices **right-to-left** by range to preserve indices.
 *
 * Pure function: the only side effect is reading the referenced files.
 */

import fs from "node:fs";
import path from "node:path";
import { marked, type Token, type Tokens } from "marked";

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
/** Max existing `@path` targets resolved per send. Extra existing targets → unresolved (too-many-mentions). */
export const MAX_MENTIONS_PER_SEND = 50;
/** Max UTF-16 code units admitted to synchronous Markdown mention scanning. Oversized prompts stay plain. */
export const MAX_MENTION_SCAN_CHARS = 256 * 1024;
/** Max distinct lexical targets synchronously probed for existence per send. Unseen overflow candidates stay plain. */
export const MAX_UNIQUE_MENTION_PROBES = 100;

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

interface SourceRange {
	start: number;
	end: number;
}

interface SourceMapSegment {
	/** Half-open offsets in the current mapped source. */
	sourceStart: number;
	sourceEnd: number;
	/** Half-open offsets in the untouched prompt. */
	originalStart: number;
	originalEnd: number;
}

interface MappedSource {
	/** Markdown source after Marked's CR/CRLF-to-LF normalization. */
	text: string;
	/** Ordered mapping runs. Ordinary text is one linear run; only normalized
	 *  CRLFs and syntax skipped while aligning descendants split runs. */
	segments: SourceMapSegment[];
}

interface SourceAlignment {
	/** Cursor immediately after the aligned text in the parent source. */
	next: number;
	/** Present only when the caller needs to inspect descendants. */
	source?: MappedSource;
}

function appendSourceSegment(
	segments: SourceMapSegment[],
	sourceStart: number,
	sourceEnd: number,
	originalStart: number,
	originalEnd: number,
): void {
	if (sourceStart === sourceEnd) return;
	const previous = segments[segments.length - 1];
	const sourceLength = sourceEnd - sourceStart;
	const originalLength = originalEnd - originalStart;
	if (
		previous &&
		previous.sourceEnd === sourceStart &&
		previous.originalEnd === originalStart &&
		previous.sourceEnd - previous.sourceStart ===
			previous.originalEnd - previous.originalStart &&
		sourceLength === originalLength
	) {
		previous.sourceEnd = sourceEnd;
		previous.originalEnd = originalEnd;
		return;
	}
	segments.push({ sourceStart, sourceEnd, originalStart, originalEnd });
}

function sourceSegmentIndexAt(source: MappedSource, offset: number): number {
	let low = 0;
	let high = source.segments.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if (source.segments[middle].sourceEnd <= offset) low = middle + 1;
		else high = middle;
	}
	return low;
}

function originalBoundary(segment: SourceMapSegment, offset: number): number {
	const sourceLength = segment.sourceEnd - segment.sourceStart;
	const originalLength = segment.originalEnd - segment.originalStart;
	if (sourceLength === originalLength) {
		return segment.originalStart + offset - segment.sourceStart;
	}
	// The only non-linear base mapping is one normalized LF for a CRLF pair.
	return offset === segment.sourceStart
		? segment.originalStart
		: segment.originalEnd;
}

function mappedUnitRange(source: MappedSource, offset: number): SourceRange {
	const segment = source.segments[sourceSegmentIndexAt(source, offset)];
	return {
		start: originalBoundary(segment, offset),
		end: originalBoundary(segment, offset + 1),
	};
}

/**
 * Marked normalizes CR and CRLF to LF before lexing. Mirror that operation
 * with sparse mapping runs rather than three arrays per UTF-16 code unit.
 * Ordinary text stays in one run; each CRLF contributes only one exceptional
 * boundary whose normalized LF covers both original code units.
 */
function normalizeMarkdownSource(text: string): MappedSource {
	if (!text.includes("\r")) {
		return {
			text,
			segments: text.length === 0
				? []
				: [{ sourceStart: 0, sourceEnd: text.length, originalStart: 0, originalEnd: text.length }],
		};
	}

	const segments: SourceMapSegment[] = [];
	const carriageReturn = /\r\n?/g;
	let originalCursor = 0;
	let sourceCursor = 0;
	let match: RegExpExecArray | null;
	while ((match = carriageReturn.exec(text)) !== null) {
		if (match.index > originalCursor) {
			const chunkLength = match.index - originalCursor;
			appendSourceSegment(
				segments,
				sourceCursor,
				sourceCursor + chunkLength,
				originalCursor,
				match.index,
			);
			sourceCursor += chunkLength;
		}
		appendSourceSegment(
			segments,
			sourceCursor,
			sourceCursor + 1,
			match.index,
			match.index + match[0].length,
		);
		sourceCursor++;
		originalCursor = match.index + match[0].length;
	}
	if (originalCursor < text.length) {
		appendSourceSegment(
			segments,
			sourceCursor,
			sourceCursor + text.length - originalCursor,
			originalCursor,
			text.length,
		);
	}
	return { text: text.replace(/\r\n?/g, "\n"), segments };
}

/**
 * Align a child token's `raw` text with its containing token. Marked retains
 * exact raw source for leaf blocks, but removes list/blockquote container
 * prefixes before recursively tokenizing their children. Those removals make
 * child raw text an ordered subsequence rather than necessarily a substring.
 * A monotonic cursor makes alignment linear within each token level and keeps
 * every mapped offset tied to the original prompt.
 */
function alignRawSource(
	raw: string,
	parent: MappedSource,
	start: number,
	map: boolean,
): SourceAlignment | undefined {
	let cursor = start;
	let segmentIndex = map ? sourceSegmentIndexAt(parent, cursor) : 0;
	const segments = map ? ([] as SourceMapSegment[]) : undefined;
	for (let rawIndex = 0; rawIndex < raw.length; rawIndex++) {
		while (
			cursor < parent.text.length &&
			parent.text[cursor] !== raw[rawIndex]
		) {
			cursor++;
		}
		if (cursor === parent.text.length) return undefined;
		if (segments) {
			while (parent.segments[segmentIndex].sourceEnd <= cursor) segmentIndex++;
			const parentSegment = parent.segments[segmentIndex];
			appendSourceSegment(
				segments,
				rawIndex,
				rawIndex + 1,
				originalBoundary(parentSegment, cursor),
				originalBoundary(parentSegment, cursor + 1),
			);
		}
		cursor++;
	}
	return {
		next: cursor,
		source: map ? { text: raw, segments: segments! } : undefined,
	};
}

function mappedRange(source: MappedSource): SourceRange | undefined {
	if (source.text.length === 0) return undefined;
	return {
		start: source.segments[0].originalStart,
		end: source.segments[source.segments.length - 1].originalEnd,
	};
}

/** Append or merge a range; parser traversal already emits source order. */
function appendRange(ranges: SourceRange[], range: SourceRange): void {
	let start = range.start;
	let end = range.end;
	while (ranges.length > 0) {
		const previous = ranges[ranges.length - 1];
		if (start > previous.end) break;
		start = Math.min(start, previous.start);
		end = Math.max(end, previous.end);
		ranges.pop();
	}
	ranges.push({ start, end });
}

function appendMappedRange(
	ranges: SourceRange[],
	source: MappedSource,
): void {
	const range = mappedRange(source);
	if (range) appendRange(ranges, range);
}

function isListToken(token: Token): token is Tokens.List {
	return token.type === "list" && "items" in token;
}

function isBlockquoteToken(token: Token): token is Tokens.Blockquote {
	return token.type === "blockquote" && "tokens" in token;
}

function isTableToken(token: Token): token is Tokens.Table {
	return token.type === "table" && "header" in token && "rows" in token;
}

function tokenChildren(token: Token): readonly Token[] {
	return "tokens" in token && token.tokens ? token.tokens : [];
}

/**
 * Flatten only Markdown block containers. Each leaf's raw text is aligned once
 * against the normalized prompt, so deeply nested same-line list markers do
 * not trigger a raw-prefix rescan at every container depth.
 */
function collectBlockLeaves(tokens: readonly Token[]): Token[] {
	const leaves: Token[] = [];
	const pending = [...tokens].reverse();
	while (pending.length > 0) {
		const token = pending.pop()!;
		if (isListToken(token)) {
			for (let itemIndex = token.items.length - 1; itemIndex >= 0; itemIndex--) {
				const itemTokens = token.items[itemIndex].tokens;
				for (let tokenIndex = itemTokens.length - 1; tokenIndex >= 0; tokenIndex--) {
					pending.push(itemTokens[tokenIndex]);
				}
			}
		} else if (isBlockquoteToken(token)) {
			for (let index = token.tokens.length - 1; index >= 0; index--) {
				pending.push(token.tokens[index]);
			}
		} else {
			leaves.push(token);
		}
	}
	return leaves;
}

function inlineTokensForLeaf(token: Token): Token[] {
	if (isTableToken(token)) {
		return [token.header, ...token.rows]
			.flat()
			.flatMap((cell) => cell.tokens);
	}
	return [...tokenChildren(token)];
}

/** Mark code spans and all inline ancestors without recursive call-stack use. */
function findInlineCodeBranches(tokens: readonly Token[]): WeakSet<object> {
	const codeBranches = new WeakSet<object>();
	const pending: Array<{ token: Token; visited: boolean }> = [];
	for (let index = tokens.length - 1; index >= 0; index--) {
		pending.push({ token: tokens[index], visited: false });
	}
	while (pending.length > 0) {
		const entry = pending.pop()!;
		const children = tokenChildren(entry.token);
		if (!entry.visited && children.length > 0) {
			pending.push({ token: entry.token, visited: true });
			for (let index = children.length - 1; index >= 0; index--) {
				pending.push({ token: children[index], visited: false });
			}
			continue;
		}
		if (
			entry.token.type === "codespan" ||
			children.some((child) => codeBranches.has(child))
		) {
			codeBranches.add(entry.token);
		}
	}
	return codeBranches;
}

interface InlineSequenceFrame {
	tokens: readonly Token[];
	parent: MappedSource;
	cursor: number;
	index: number;
}

/** Align inline descendants with explicit frames, preserving wrapper scopes. */
function collectInlineCodeRanges(
	tokens: readonly Token[],
	branches: WeakSet<object>,
	parent: MappedSource,
	ranges: SourceRange[],
): boolean {
	const frames: InlineSequenceFrame[] = [
		{ tokens, parent, cursor: 0, index: 0 },
	];
	while (frames.length > 0) {
		const frame = frames[frames.length - 1];
		if (frame.index === frame.tokens.length) {
			frames.pop();
			continue;
		}
		const token = frame.tokens[frame.index++];
		const containsCode = branches.has(token);
		const alignment = alignRawSource(
			token.raw,
			frame.parent,
			frame.cursor,
			containsCode,
		);
		if (!alignment) return false;
		frame.cursor = alignment.next;
		if (!containsCode) continue;
		if (token.type === "codespan") {
			appendMappedRange(ranges, alignment.source!);
			continue;
		}
		const children = tokenChildren(token);
		frames.push({
			tokens: children,
			parent: alignment.source!,
			cursor: 0,
			index: 0,
		});
	}
	return true;
}

interface BlockLeafCodeInfo {
	token: Token;
	inlineTokens: Token[];
	inlineBranches: WeakSet<object>;
	containsCode: boolean;
}

function blockLeafCodeInfo(token: Token): BlockLeafCodeInfo {
	const inlineTokens = inlineTokensForLeaf(token);
	const inlineBranches = findInlineCodeBranches(inlineTokens);
	return {
		token,
		inlineTokens,
		inlineBranches,
		containsCode:
			token.type === "code" ||
			inlineTokens.some((inlineToken) => inlineBranches.has(inlineToken)),
	};
}

function collectCodeRangesFromLeaves(
	leaves: readonly BlockLeafCodeInfo[],
	source: MappedSource,
	ranges: SourceRange[],
): boolean {
	let cursor = 0;
	for (const leaf of leaves) {
		const alignment = alignRawSource(
			leaf.token.raw,
			source,
			cursor,
			leaf.containsCode,
		);
		if (!alignment) return false;
		cursor = alignment.next;
		if (!leaf.containsCode) continue;
		if (leaf.token.type === "code") {
			appendMappedRange(ranges, alignment.source!);
		} else if (
			!collectInlineCodeRanges(
				leaf.inlineTokens,
				leaf.inlineBranches,
				alignment.source!,
				ranges,
			)
		) {
			return false;
		}
	}
	return true;
}

function scanMarkedCodeRanges(source: MappedSource): SourceRange[] {
	const leaves = collectBlockLeaves(
		marked.lexer(source.text, { async: false }),
	).map(blockLeafCodeInfo);
	if (!leaves.some((leaf) => leaf.containsCode)) return [];
	const ranges: SourceRange[] = [];
	if (!collectCodeRangesFromLeaves(leaves, source, ranges)) {
		appendMappedRange(ranges, source);
	}
	return ranges;
}

interface NormalizedRange extends SourceRange {
	original: SourceRange;
}

interface DeepListPrefix {
	contentOffset: number;
	indentColumns: number;
	markerOffsets: number[];
}

interface DeepListRecovery {
	source: MappedSource;
	fences: NormalizedRange[];
	found: boolean;
}

function lineEnd(text: string, start: number): { contentEnd: number; end: number } {
	const newline = text.indexOf("\n", start);
	return newline === -1
		? { contentEnd: text.length, end: text.length }
		: { contentEnd: newline, end: newline + 1 };
}

function indentationEnd(
	text: string,
	start: number,
	end: number,
	requiredColumns: number,
): number | undefined {
	let offset = start;
	let columns = 0;
	while (offset < end && columns < requiredColumns) {
		if (text[offset] === " ") columns++;
		else if (text[offset] === "\t") columns += 4 - (columns % 4);
		else return undefined;
		offset++;
	}
	return columns >= requiredColumns ? offset : undefined;
}

function originalRange(
	source: MappedSource,
	start: number,
	end: number,
): SourceRange {
	return {
		start: mappedUnitRange(source, start).start,
		end: mappedUnitRange(source, end - 1).end,
	};
}

/** Iteratively recognize the same-line list nesting that overflows Marked. */
function deepListPrefix(
	text: string,
	start: number,
	end: number,
): DeepListPrefix | undefined {
	const markerOffsets: number[] = [];
	let offset = start;
	let columns = 0;
	while (offset < end) {
		const markerStart = offset;
		const markerColumns = columns;
		let leadingSpaces = 0;
		while (leadingSpaces < 3 && text[offset] === " ") {
			offset++;
			columns++;
			leadingSpaces++;
		}

		let markerOffset = offset;
		if (text[offset] === "*" || text[offset] === "+" || text[offset] === "-") {
			offset++;
			columns++;
		} else {
			let digits = 0;
			while (digits < 9 && /[0-9]/.test(text[offset] ?? "")) {
				offset++;
				columns++;
				digits++;
			}
			if (
				digits === 0 ||
				(text[offset] !== "." && text[offset] !== ")")
			) {
				offset = markerStart;
				columns = markerColumns;
				break;
			}
			markerOffset = offset;
			offset++;
			columns++;
		}
		if (text[offset] !== " " && text[offset] !== "\t") {
			offset = markerStart;
			columns = markerColumns;
			break;
		}
		while (text[offset] === " " || text[offset] === "\t") {
			if (text[offset] === " ") columns++;
			else columns += 4 - (columns % 4);
			offset++;
		}
		markerOffsets.push(markerOffset);
	}
	if (markerOffsets.length < 256) return undefined;
	return { contentOffset: offset, indentColumns: columns, markerOffsets };
}

/**
 * Marked recursively tokenizes list items and can exhaust the JS stack on an
 * adversarial same-line list depth. Recovery replaces only list-marker syntax
 * with same-length, non-Markdown characters, leaving prose and inline code at
 * their original offsets for a normal Marked pass. Deep fenced blocks are
 * additionally recorded and masked as complete ranges so their container
 * semantics remain explicit after the list structure is neutralized.
 */
function recoverDeepLists(source: MappedSource): DeepListRecovery {
	const masked = source.text.split("");
	const fences: NormalizedRange[] = [];
	let found = false;
	let open:
		| { start: number; char: string; length: number; indentColumns: number }
		| undefined;

	const closeFence = (start: number, end: number) => {
		fences.push({
			start,
			end,
			original: originalRange(source, start, end),
		});
		for (let index = start; index < end; index++) {
			if (masked[index] !== "\n") masked[index] = " ";
		}
	};

	let lineStart = 0;
	while (lineStart < source.text.length) {
		const line = lineEnd(source.text, lineStart);
		if (open) {
			const contentOffset = indentationEnd(
				source.text,
				lineStart,
				line.contentEnd,
				open.indentColumns,
			);
			if (contentOffset !== undefined) {
				let offset = contentOffset;
				let spaces = 0;
				while (spaces < 3 && source.text[offset] === " ") {
					offset++;
					spaces++;
				}
				const delimiterStart = offset;
				while (source.text[offset] === open.char) offset++;
				if (
					offset - delimiterStart >= open.length &&
					/^[ \t]*$/.test(source.text.slice(offset, line.contentEnd))
				) {
					closeFence(open.start, line.end);
					open = undefined;
				}
			}
			lineStart = line.end;
			continue;
		}

		const prefix = deepListPrefix(source.text, lineStart, line.contentEnd);
		if (prefix) {
			found = true;
			// Changing one code unit per marker is enough to stop recursive list
			// construction without turning the long prefix into indented code.
			for (const markerOffset of prefix.markerOffsets) {
				masked[markerOffset] = "x";
			}

			let fenceOffset = prefix.contentOffset;
			let spaces = 0;
			while (spaces < 3 && source.text[fenceOffset] === " ") {
				fenceOffset++;
				spaces++;
			}
			const char = source.text[fenceOffset];
			if (char === "`" || char === "~") {
				let delimiterEnd = fenceOffset;
				while (source.text[delimiterEnd] === char) delimiterEnd++;
				const length = delimiterEnd - fenceOffset;
				const info = source.text.slice(delimiterEnd, line.contentEnd);
				if (length >= 3 && (char !== "`" || !info.includes("`"))) {
					open = {
						start: lineStart,
						char,
						length,
						indentColumns: prefix.indentColumns,
					};
				}
			}
		}
		lineStart = line.end;
	}
	if (open) closeFence(open.start, source.text.length);

	return {
		source: {
			text: masked.join(""),
			segments: source.segments,
		},
		fences,
		found,
	};
}

function mergeOrderedRanges(
	left: readonly SourceRange[],
	right: readonly SourceRange[],
): SourceRange[] {
	const merged: SourceRange[] = [];
	let leftIndex = 0;
	let rightIndex = 0;
	while (leftIndex < left.length || rightIndex < right.length) {
		const next =
			rightIndex >= right.length ||
			(leftIndex < left.length && left[leftIndex].start <= right[rightIndex].start)
				? left[leftIndex++]
				: right[rightIndex++];
		appendRange(merged, next);
	}
	return merged;
}

function mappedSlice(
	source: MappedSource,
	start: number,
	end: number,
): MappedSource {
	const segments: SourceMapSegment[] = [];
	let segmentIndex = sourceSegmentIndexAt(source, start);
	while (
		segmentIndex < source.segments.length &&
		source.segments[segmentIndex].sourceStart < end
	) {
		const segment = source.segments[segmentIndex++];
		const overlapStart = Math.max(start, segment.sourceStart);
		const overlapEnd = Math.min(end, segment.sourceEnd);
		appendSourceSegment(
			segments,
			overlapStart - start,
			overlapEnd - start,
			originalBoundary(segment, overlapStart),
			originalBoundary(segment, overlapEnd),
		);
	}
	return { text: source.text.slice(start, end), segments };
}

/**
 * Last-resort isolation for a parser failure after structural recovery. Blank
 * lines delimit Markdown blocks, except while a conservative fence run is
 * open. A failing block is excluded in full, while every parseable block still
 * contributes its normal code ranges. This cannot fail open and does not make
 * an unrelated prose block disappear because another block exhausted Marked.
 */
function scanMarkedCodeRangesByBlock(source: MappedSource): SourceRange[] {
	const blocks: MappedSource[] = [];
	let blockStart = 0;
	let openFence: { char: string; length: number } | undefined;
	let lineStart = 0;
	while (lineStart < source.text.length) {
		const line = lineEnd(source.text, lineStart);
		const content = source.text.slice(lineStart, line.contentEnd);
		const fenceRuns = [...content.matchAll(/`{3,}|~{3,}/g)];
		if (!openFence && fenceRuns.length > 0) {
			const run = fenceRuns[0][0];
			openFence = { char: run[0], length: run.length };
		} else if (openFence) {
			for (const match of fenceRuns) {
				const run = match[0];
				const before = content.slice(0, match.index);
				const after = content.slice(match.index! + run.length);
				if (
					run[0] === openFence.char &&
					run.length >= openFence.length &&
					/^[ \t>0-9.*+\-)()]*$/.test(before) &&
					/^[ \t]*$/.test(after)
				) {
					openFence = undefined;
					break;
				}
			}
		}
		if (!openFence && /^[ \t]*$/.test(content)) {
			blocks.push(mappedSlice(source, blockStart, line.end));
			blockStart = line.end;
		}
		lineStart = line.end;
	}
	if (blockStart < source.text.length) {
		blocks.push(mappedSlice(source, blockStart, source.text.length));
	}

	const ranges: SourceRange[] = [];
	for (const block of blocks) {
		try {
			for (const range of scanMarkedCodeRanges(block)) appendRange(ranges, range);
		} catch {
			appendMappedRange(ranges, block);
		}
	}
	return ranges;
}

/**
 * Find Markdown code ranges using Marked's maintained block/inline lexer.
 * Marked supplies faithful fence-container, leaf-block, ordered-list
 * interruption, and code-span semantics; raw-token alignment preserves exact
 * indices without rewriting the prompt or sorting the resulting ranges.
 */
function scanMarkdownCodeRanges(text: string): SourceRange[] {
	if (text.length === 0) return [];
	const source = normalizeMarkdownSource(text);
	try {
		return scanMarkedCodeRanges(source);
	} catch (error) {
		if (error instanceof RangeError) {
			const recovery = recoverDeepLists(source);
			if (recovery.found) {
				let parsedRanges: SourceRange[];
				try {
					parsedRanges = scanMarkedCodeRanges(recovery.source);
				} catch {
					parsedRanges = scanMarkedCodeRangesByBlock(recovery.source);
				}
				return mergeOrderedRanges(
					recovery.fences.map((range) => range.original),
					parsedRanges,
				);
			}
		}
		// The resolver must never throw. Isolate parser failures by Markdown
		// block and fail closed only for blocks that still cannot be parsed.
		return scanMarkedCodeRangesByBlock(source);
	}
}

/** Scan prose for `@path` tokens while preserving original UTF-16 indices. */
function scanTokens(text: string): ScannedToken[] {
	const re = /(^|\s)@([^\s@]+)/g;
	const excluded = scanMarkdownCodeRanges(text);
	const out: ScannedToken[] = [];
	let excludedIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		const prefixLen = m[1].length; // 0 at string start, 1 after whitespace
		const tokenStart = m.index + prefixLen; // position of "@"
		const untrimmedEnd = tokenStart + 1 + m[2].length;
		while (
			excludedIndex < excluded.length &&
			excluded[excludedIndex].end <= tokenStart
		) {
			excludedIndex++;
		}
		const codeRange = excluded[excludedIndex];
		if (codeRange && codeRange.start < untrimmedEnd && codeRange.end > tokenStart) {
			continue;
		}

		let token = m[2];
		// Trim trailing punctuation that is unlikely to be part of a path.
		while (token.length > 0 && TRAILING_PUNCT.has(token[token.length - 1])) {
			token = token.slice(0, -1);
		}
		if (token.length === 0) continue;
		const tokenEnd = tokenStart + 1 + token.length; // covers "@" + path
		out.push({ rawPath: token, range: [tokenStart, tokenEnd] });
	}
	return out;
}

function isMissingPathError(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return code === "ENOENT" || code === "ENOTDIR";
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
	const plainResult = (): ResolvedMentions => ({
		originalText,
		modelText: originalText,
		mentions: [],
		warnings: [],
	});
	// Avoid Markdown/parser setup for the overwhelmingly common plain prompt,
	// and keep the synchronous send path bounded for mention-bearing payloads.
	if (!text.includes("@")) return plainResult();
	if (text.length > MAX_MENTION_SCAN_CHARS) return plainResult();

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
	type CandidateClassification = "exists" | "missing" | "unreadable";
	const classificationCache = new Map<string, CandidateClassification>();
	let uniqueProbeCount = 0;

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

		const lexicalAbs = path.resolve(resolvedCwd, normRel);

		// Existence classification is deliberately metadata-only and separate from
		// canonicalization/delivery. Bound probes by distinct lexical target and
		// reuse classifications for repeats; unseen overflow candidates stay plain.
		let classification = classificationCache.get(lexicalAbs);
		if (!classification) {
			if (uniqueProbeCount >= MAX_UNIQUE_MENTION_PROBES) continue;
			uniqueProbeCount++;
			try {
				fs.lstatSync(lexicalAbs);
				classification = "exists";
			} catch (error) {
				classification = isMissingPathError(error) ? "missing" : "unreadable";
			}
			classificationCache.set(lexicalAbs, classification);
		}
		if (classification === "missing") continue;

		// Missing candidates do not consume this cap. Extra existing candidates
		// require only the metadata classification above, never realpath/stat/read.
		if (resolvedCount >= MAX_MENTIONS_PER_SEND) {
			markUnresolved("too-many-mentions");
			continue;
		}
		resolvedCount++;

		// Path safety, step 1: cheap lexical reject of obvious `..` / absolute
		// escapes. Existence was checked first so a missing traversal stays text,
		// while an existing outside target remains a failed reference.
		if (escapesDir(resolvedCwd, lexicalAbs)) {
			markUnresolved("outside-cwd");
			continue;
		}

		if (classification === "unreadable") {
			markUnresolved("unreadable");
			continue;
		}

		let absPath: string;
		try {
			absPath = fs.realpathSync.native(lexicalAbs);
		} catch (error) {
			markUnresolved(isMissingPathError(error) ? "missing" : "unreadable");
			continue;
		}

		// Path safety, step 2: canonical containment defeats symlink escapes before
		// any stat/read, so an inside-cwd link cannot leak outside file bytes.
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
		} catch (error) {
			markUnresolved(isMissingPathError(error) ? "missing" : "unreadable");
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
