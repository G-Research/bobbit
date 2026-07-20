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
 *                   mentions and warnings. Delivery failures for existing
 *                   targets degrade gracefully without rejecting the prompt.
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
import { Semaphore } from "../agent/semaphore.js";

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
/** Fixed width of each resolver's streaming existence-classification pool. */
export const FILE_MENTION_PROBE_CONCURRENCY = 8;
/** Process-wide cap for resolver calls doing Markdown/filesystem work. */
export const FILE_MENTION_RESOLUTION_CONCURRENCY = 4;
/** Process-wide cap for in-flight lstat probes across every session. */
export const FILE_MENTION_LSTAT_CONCURRENCY = 8;
/** Max retained non-code `@path` candidates in one prompt. */
export const MAX_FILE_MENTION_RAW_CANDIDATES = 8_192;
/** Max distinct lexical filesystem targets probed in one prompt. */
export const MAX_FILE_MENTION_UNIQUE_PROBES = 4_096;

export type FileMentionBudgetErrorCode =
	| "FILE_MENTION_CANDIDATE_LIMIT"
	| "FILE_MENTION_PROBE_LIMIT";

/** Typed admission failure: callers reject the whole prompt explicitly. */
export class FileMentionBudgetError extends Error {
	readonly code: FileMentionBudgetErrorCode;

	constructor(code: FileMentionBudgetErrorCode, message: string) {
		super(message);
		this.name = "FileMentionBudgetError";
		this.code = code;
	}
}

/** Stable cancellation outcome consumed silently by command handlers. */
export class FileMentionAbortError extends Error {
	readonly code = "FILE_MENTION_ABORTED" as const;
	readonly aborted = true as const;

	constructor(reason?: unknown) {
		super("File mention resolution aborted", { cause: reason });
		this.name = "AbortError";
	}
}

function throwIfFileMentionAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new FileMentionAbortError(signal.reason);
}

/** Keep the resolver's stable public abort shape while using the semaphore's
 * native cancellable FIFO acquisition. A rejected acquisition owns no permit. */
function rethrowSemaphoreAcquireError(error: unknown, signal?: AbortSignal): never {
	if (signal?.aborted) throw new FileMentionAbortError(signal.reason ?? error);
	throw error;
}

/** Race only a caller-facing wait while continuing to observe the operation. */
async function waitForPromiseOrAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	throwIfFileMentionAborted(signal);
	if (!signal) return await promise;
	return await new Promise<T>((resolve, reject) => {
		let settled = false;
		const onAbort = () => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
			reject(new FileMentionAbortError(signal.reason));
		};
		promise.then(
			(value) => {
				if (settled) return;
				settled = true;
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				if (settled) return;
				settled = true;
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) onAbort();
	});
}

// Module-global FIFO semaphores prevent independent sessions from multiplying
// resolver/parser and metadata-probe concurrency. Each acquire is released in
// a finally block; Semaphore hands permits to waiters in arrival order.
const resolutionSemaphore = new Semaphore(FILE_MENTION_RESOLUTION_CONCURRENCY);
const lstatSemaphore = new Semaphore(FILE_MENTION_LSTAT_CONCURRENCY);

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
	/** Advisory cancellation for scanning and filesystem resolution. */
	signal?: AbortSignal;
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

interface MarkdownRootMap {
	/** Normalized offsets whose one LF represents two original CRLF code units. */
	crlfOffsets: Uint32Array;
}

type SourceUnitMap =
	| {
		/** Every source unit maps to the next normalized root unit. */
		kind: "linear";
		rootStart: number;
	}
	| {
		/** Packed normalized-root offset for each source unit. Descendant slices
		 *  retain this array with a shifted index instead of copying it. */
		kind: "indexed";
		rootOffsets: Uint32Array;
		indexStart: number;
	};

interface MappedSource {
	/** Markdown source after Marked's CR/CRLF-to-LF normalization. */
	text: string;
	/** Shared compact translation from normalized root units to the prompt. */
	root: MarkdownRootMap;
	/** Translation from this aligned source's units to normalized root units. */
	units: SourceUnitMap;
}

interface SourceAlignment {
	/** Cursor immediately after the aligned text in the parent source. */
	next: number;
	/** Present only when the caller needs to inspect descendants. */
	source?: MappedSource;
}

const EMPTY_SOURCE_OFFSETS = new Uint32Array(0);

function sourceRootOffset(source: MappedSource, offset: number): number {
	return source.units.kind === "linear"
		? source.units.rootStart + offset
		: source.units.rootOffsets[source.units.indexStart + offset];
}

function lowerBoundOffset(offsets: Uint32Array, target: number): number {
	let low = 0;
	let high = offsets.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if (offsets[middle] < target) low = middle + 1;
		else high = middle;
	}
	return low;
}

function mappedUnitRange(source: MappedSource, offset: number): SourceRange {
	const rootOffset = sourceRootOffset(source, offset);
	const crlfIndex = lowerBoundOffset(source.root.crlfOffsets, rootOffset);
	const isCrlf = source.root.crlfOffsets[crlfIndex] === rootOffset;
	const start = rootOffset + crlfIndex;
	return { start, end: start + (isCrlf ? 2 : 1) };
}

/**
 * Marked normalizes CR and CRLF to LF before lexing. A CR keeps its source
 * width, while each CRLF removes exactly one normalized code unit. Retaining
 * only the normalized CRLF offsets bounds the map to four packed bytes per
 * pair instead of one heap object (and its fields) per line ending.
 */
function normalizeMarkdownSource(text: string): MappedSource {
	if (!text.includes("\r")) {
		return {
			text,
			root: { crlfOffsets: EMPTY_SOURCE_OFFSETS },
			units: { kind: "linear", rootStart: 0 },
		};
	}

	let crlfCount = 0;
	for (let index = 0; index + 1 < text.length; index++) {
		if (text.charCodeAt(index) === 13 && text.charCodeAt(index + 1) === 10) {
			crlfCount++;
			index++;
		}
	}
	const crlfOffsets = crlfCount === 0
		? EMPTY_SOURCE_OFFSETS
		: new Uint32Array(crlfCount);
	let sourceOffset = 0;
	let crlfIndex = 0;
	for (let index = 0; index < text.length; index++) {
		if (text.charCodeAt(index) === 13) {
			if (text.charCodeAt(index + 1) === 10) {
				crlfOffsets[crlfIndex++] = sourceOffset;
				index++;
			}
			sourceOffset++;
		} else {
			sourceOffset++;
		}
	}
	return {
		text: text.replace(/\r\n?/g, "\n"),
		root: { crlfOffsets },
		units: { kind: "linear", rootStart: 0 },
	};
}

/** Return a zero-copy mapping view over one source substring. */
function mappedSlice(
	source: MappedSource,
	start: number,
	end: number,
): MappedSource {
	return {
		text: source.text.slice(start, end),
		root: source.root,
		units: source.units.kind === "linear"
			? { kind: "linear", rootStart: source.units.rootStart + start }
			: {
				kind: "indexed",
				rootOffsets: source.units.rootOffsets,
				indexStart: source.units.indexStart + start,
			},
	};
}

/**
 * Align a child token's `raw` text with its containing token. Marked retains
 * exact raw source for leaf blocks, but removes list/blockquote container
 * prefixes before recursively tokenizing their children. Those removals make
 * child raw text an ordered subsequence rather than necessarily a substring.
 * A monotonic cursor makes alignment linear within each token level and keeps
 * every mapped offset tied to the original prompt.
 *
 * Exact child substrings retain a zero-copy mapping view. Non-contiguous child
 * alignments use one packed Uint32 offset per UTF-16 unit; they never recreate
 * the former per-newline/per-segment JS object graph.
 */
function alignRawSource(
	raw: string,
	parent: MappedSource,
	start: number,
	map: boolean,
): SourceAlignment | undefined {
	if (parent.text.startsWith(raw, start)) {
		return {
			next: start + raw.length,
			source: map ? mappedSlice(parent, start, start + raw.length) : undefined,
		};
	}

	let cursor = start;
	let firstRootOffset = 0;
	let rootOffsets: Uint32Array | undefined;
	for (let rawIndex = 0; rawIndex < raw.length; rawIndex++) {
		while (
			cursor < parent.text.length &&
			parent.text[cursor] !== raw[rawIndex]
		) {
			cursor++;
		}
		if (cursor === parent.text.length) return undefined;
		if (map) {
			const rootOffset = sourceRootOffset(parent, cursor);
			if (rawIndex === 0) {
				firstRootOffset = rootOffset;
			} else if (!rootOffsets && rootOffset !== firstRootOffset + rawIndex) {
				rootOffsets = new Uint32Array(raw.length);
				for (let index = 0; index < rawIndex; index++) {
					rootOffsets[index] = firstRootOffset + index;
				}
			}
			if (rootOffsets) rootOffsets[rawIndex] = rootOffset;
		}
		cursor++;
	}
	return {
		next: cursor,
		source: map
			? {
				text: raw,
				root: parent.root,
				units: rootOffsets
					? { kind: "indexed", rootOffsets, indexStart: 0 }
					: { kind: "linear", rootStart: firstRootOffset },
			}
			: undefined,
	};
}

function mappedRange(source: MappedSource): SourceRange | undefined {
	if (source.text.length === 0) return undefined;
	return {
		start: mappedUnitRange(source, 0).start,
		end: mappedUnitRange(source, source.text.length - 1).end,
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

function scanMarkedCodeRanges(
	source: MappedSource,
	signal?: AbortSignal,
): SourceRange[] {
	throwIfFileMentionAborted(signal);
	const leaves = collectBlockLeaves(
		marked.lexer(source.text, { async: false }),
	).map(blockLeafCodeInfo);
	throwIfFileMentionAborted(signal);
	if (!leaves.some((leaf) => leaf.containsCode)) return [];
	const ranges: SourceRange[] = [];
	if (!collectCodeRangesFromLeaves(leaves, source, ranges)) {
		throw new Error("Unable to align Marked code ranges to prompt source");
	}
	return ranges;
}

interface DeepListPrefix {
	contentOffset: number;
	indentColumns: number;
	markerCount: number;
}

function indentationEnd(
	text: string,
	start: number,
	end: number,
	requiredColumns: number,
	signal?: AbortSignal,
): number | undefined {
	let offset = start;
	let columns = 0;
	let nextAbortCheck = start + SCAN_ABORT_INTERVAL;
	while (offset < end && columns < requiredColumns) {
		if (text[offset] === " ") columns++;
		else if (text[offset] === "\t") columns += 4 - (columns % 4);
		else return undefined;
		offset++;
		if (offset >= nextAbortCheck) {
			throwIfFileMentionAborted(signal);
			nextAbortCheck = offset + SCAN_ABORT_INTERVAL;
		}
	}
	return columns >= requiredColumns ? offset : undefined;
}

/**
 * Iteratively recognize same-line list nesting before invoking Marked. The
 * result is constant-size even for an 8 MiB prefix: no marker-offset array and
 * no character boxing are retained.
 */
function deepListPrefix(
	text: string,
	start: number,
	end: number,
	signal?: AbortSignal,
): DeepListPrefix | undefined {
	let markerCount = 0;
	let offset = start;
	let columns = 0;
	let nextAbortCheck = start + SCAN_ABORT_INTERVAL;
	while (offset < end) {
		if (offset >= nextAbortCheck) {
			throwIfFileMentionAborted(signal);
			nextAbortCheck = offset + SCAN_ABORT_INTERVAL;
		}
		const markerStart = offset;
		const markerColumns = columns;
		let leadingSpaces = 0;
		while (leadingSpaces < 3 && text.charCodeAt(offset) === 32) {
			offset++;
			columns++;
			leadingSpaces++;
		}

		const marker = text.charCodeAt(offset);
		if (marker === 42 || marker === 43 || marker === 45) {
			offset++;
			columns++;
		} else {
			let digits = 0;
			while (digits < 9) {
				const code = text.charCodeAt(offset);
				if (code < 48 || code > 57) break;
				offset++;
				columns++;
				digits++;
			}
			const delimiter = text.charCodeAt(offset);
			if (digits === 0 || (delimiter !== 46 && delimiter !== 41)) {
				offset = markerStart;
				columns = markerColumns;
				break;
			}
			offset++;
			columns++;
		}
		const separator = text.charCodeAt(offset);
		if (separator !== 32 && separator !== 9) {
			offset = markerStart;
			columns = markerColumns;
			break;
		}
		while (offset < end) {
			const code = text.charCodeAt(offset);
			if (code === 32) columns++;
			else if (code === 9) columns += 4 - (columns % 4);
			else break;
			offset++;
		}
		markerCount++;
	}
	if (markerCount < 256) return undefined;
	return { contentOffset: offset, indentColumns: columns, markerCount };
}

/**
 * Find Markdown code ranges using Marked's maintained block/inline lexer.
 * Marked supplies faithful fence-container, leaf-block, ordered-list
 * interruption, and code-span semantics; raw-token alignment preserves exact
 * indices without rewriting the prompt or sorting the resulting ranges.
 */
function scanMarkdownCodeRanges(text: string, signal?: AbortSignal): SourceRange[] {
	if (text.length === 0) return [];
	throwIfFileMentionAborted(signal);
	const source = normalizeMarkdownSource(text);
	throwIfFileMentionAborted(signal);
	return scanMarkedCodeRanges(source, signal);
}

const STREAMING_MARKDOWN_MIN_UNITS = 128 * 1024;
const SCAN_ABORT_INTERVAL = 16 * 1024;
const TOKEN_WHITESPACE = /\s/u;

interface StreamingFence {
	charCode: number;
	length: number;
	/** Deep same-line list fences require their accumulated list indentation
	 * before a closer; ordinary container prefixes are stripped per line. */
	indentColumns?: number;
}

interface StreamingContainerPrefix {
	contentStart: number;
	hadContainer: boolean;
}

function checkScanAbort(offset: number, signal?: AbortSignal): void {
	if (offset % SCAN_ABORT_INTERVAL === 0) throwIfFileMentionAborted(signal);
}

function originalLineContentEnd(
	text: string,
	start: number,
	signal?: AbortSignal,
): number {
	let offset = start;
	let nextAbortCheck = start + SCAN_ABORT_INTERVAL;
	while (offset < text.length) {
		const code = text.charCodeAt(offset);
		if (code === 10 || code === 13) break;
		offset++;
		if (offset >= nextAbortCheck) {
			throwIfFileMentionAborted(signal);
			nextAbortCheck = offset + SCAN_ABORT_INTERVAL;
		}
	}
	return offset;
}

function originalLineNext(text: string, contentEnd: number): number {
	if (text.charCodeAt(contentEnd) === 13 && text.charCodeAt(contentEnd + 1) === 10) {
		return contentEnd + 2;
	}
	return contentEnd < text.length ? contentEnd + 1 : contentEnd;
}

function isBlankRange(
	text: string,
	start: number,
	end: number,
	signal?: AbortSignal,
): boolean {
	let nextAbortCheck = start + SCAN_ABORT_INTERVAL;
	for (let offset = start; offset < end; offset++) {
		const code = text.charCodeAt(offset);
		if (code !== 32 && code !== 9) return false;
		if (offset >= nextAbortCheck) {
			throwIfFileMentionAborted(signal);
			nextAbortCheck = offset + SCAN_ABORT_INTERVAL;
		}
	}
	return true;
}

/** `String#indexOf` has no end bound and turns millions of tiny Markdown
 * blocks into quadratic rescans of a later delimiter. Keep every lookup inside
 * its current source range. */
function indexOfCodeUnitInRange(
	text: string,
	code: number,
	start: number,
	end: number,
	signal?: AbortSignal,
): number {
	let nextAbortCheck = start + SCAN_ABORT_INTERVAL;
	for (let offset = start; offset < end; offset++) {
		if (text.charCodeAt(offset) === code) return offset;
		if (offset >= nextAbortCheck) {
			throwIfFileMentionAborted(signal);
			nextAbortCheck = offset + SCAN_ABORT_INTERVAL;
		}
	}
	return -1;
}

/** Strip the common list/blockquote prefixes needed to recognize code in a
 * large container line. Small and structurally bounded containers still use
 * Marked for full grammar fidelity. */
function streamingContainerPrefix(
	text: string,
	start: number,
	end: number,
): StreamingContainerPrefix {
	let offset = start;
	let hadContainer = false;
	while (offset < end) {
		const prefixStart = offset;
		let marker = offset;
		let spaces = 0;
		while (spaces < 3 && text.charCodeAt(marker) === 32) {
			marker++;
			spaces++;
		}

		if (text.charCodeAt(marker) === 62) {
			offset = marker + 1;
			const following = text.charCodeAt(offset);
			if (following === 32 || following === 9) offset++;
			hadContainer = true;
			continue;
		}

		let markerEnd = marker;
		const markerCode = text.charCodeAt(markerEnd);
		if (markerCode === 42 || markerCode === 43 || markerCode === 45) {
			markerEnd++;
		} else {
			let digits = 0;
			while (digits < 9) {
				const code = text.charCodeAt(markerEnd);
				if (code < 48 || code > 57) break;
				markerEnd++;
				digits++;
			}
			const delimiter = text.charCodeAt(markerEnd);
			if (digits === 0 || (delimiter !== 46 && delimiter !== 41)) {
				markerEnd = marker;
			} else {
				markerEnd++;
			}
		}
		const separator = text.charCodeAt(markerEnd);
		if (markerEnd > marker && (separator === 32 || separator === 9)) {
			offset = markerEnd + 1;
			hadContainer = true;
			continue;
		}

		// Tentative indentation belongs to content when it did not lead to a
		// container marker (notably the four spaces after a blockquote marker).
		offset = prefixStart;
		break;
	}
	return { contentStart: offset, hadContainer };
}

function streamingFenceRun(
	text: string,
	start: number,
	end: number,
	closing?: StreamingFence,
	signal?: AbortSignal,
): StreamingFence | undefined {
	let offset = start;
	let spaces = 0;
	while (spaces < 3 && text.charCodeAt(offset) === 32) {
		offset++;
		spaces++;
	}
	const charCode = text.charCodeAt(offset);
	if (charCode !== 96 && charCode !== 126) return undefined;
	const delimiterStart = offset;
	while (text.charCodeAt(offset) === charCode) offset++;
	const length = offset - delimiterStart;
	if (length < 3) return undefined;

	if (closing) {
		if (charCode !== closing.charCode || length < closing.length) return undefined;
		return isBlankRange(text, offset, end, signal)
			? { charCode, length }
			: undefined;
	}
	// A backtick fence's info string may not itself contain a backtick.
	if (charCode === 96 && indexOfCodeUnitInRange(text, 96, offset, end, signal) !== -1) {
		return undefined;
	}
	return { charCode, length };
}

function rangeHasFourColumnIndent(text: string, start: number, end: number): boolean {
	let columns = 0;
	for (let offset = start; offset < end && columns < 4; offset++) {
		const code = text.charCodeAt(offset);
		if (code === 32) columns++;
		else if (code === 9) columns += 4 - (columns % 4);
		else return false;
	}
	return columns >= 4;
}

function isAtxHeadingLine(text: string, start: number, end: number): boolean {
	let offset = start;
	let spaces = 0;
	while (spaces < 3 && text.charCodeAt(offset) === 32) {
		offset++;
		spaces++;
	}
	let hashes = 0;
	while (hashes < 7 && text.charCodeAt(offset) === 35) {
		offset++;
		hashes++;
	}
	return hashes > 0 && hashes <= 6 && (
		offset === end || text.charCodeAt(offset) === 32 || text.charCodeAt(offset) === 9
	);
}

function pushScannedToken(
	text: string,
	start: number,
	untrimmedEnd: number,
	out: ScannedToken[],
): void {
	let end = untrimmedEnd;
	while (end > start + 1 && TRAILING_PUNCT.has(text[end - 1])) end--;
	if (end === start + 1) return;
	out.push({ rawPath: text.slice(start + 1, end), range: [start, end] });
	if (out.length > MAX_FILE_MENTION_RAW_CANDIDATES) {
		throw new FileMentionBudgetError(
			"FILE_MENTION_CANDIDATE_LIMIT",
			`Prompt contains more than ${MAX_FILE_MENTION_RAW_CANDIDATES} non-code file-mention candidates`,
		);
	}
}

/** Scan one known-prose interval. Interval boundaries may be inline-code
 * delimiters, so token parsing deliberately stops at `end`. */
function scanCandidateRange(
	text: string,
	start: number,
	end: number,
	out: ScannedToken[],
	signal?: AbortSignal,
): void {
	let cursor = start;
	while (cursor < end) {
		const tokenStart = indexOfCodeUnitInRange(text, 64, cursor, end, signal);
		if (tokenStart === -1) return;
		checkScanAbort(tokenStart, signal);
		if (tokenStart > 0 && !TOKEN_WHITESPACE.test(text[tokenStart - 1])) {
			cursor = tokenStart + 1;
			continue;
		}
		let tokenEnd = tokenStart + 1;
		while (tokenEnd < end) {
			const char = text[tokenEnd];
			if (char === "@" || TOKEN_WHITESPACE.test(char)) break;
			tokenEnd++;
			checkScanAbort(tokenEnd, signal);
		}
		pushScannedToken(text, tokenStart, tokenEnd, out);
		cursor = Math.max(tokenEnd, tokenStart + 1);
	}
}

function backtickIsEscaped(text: string, offset: number, blockStart: number): boolean {
	let slashes = 0;
	for (let index = offset - 1; index >= blockStart && text.charCodeAt(index) === 92; index--) {
		slashes++;
	}
	return (slashes & 1) === 1;
}

/**
 * Scan a single inline block with two linear passes. The first pass retains one
 * count per distinct delimiter-run length (at most O(sqrt(n)) distinct lengths
 * in n source units); the second emits candidates only from prose intervals.
 * This avoids one range object per span while preserving unmatched, escaped,
 * multi-run, adjacent, and multiline code-span semantics.
 */
function scanInlineBlockCandidates(
	text: string,
	start: number,
	end: number,
	out: ScannedToken[],
	signal?: AbortSignal,
): void {
	const firstAt = indexOfCodeUnitInRange(text, 64, start, end, signal);
	if (firstAt === -1) return;
	const firstBacktick = indexOfCodeUnitInRange(text, 96, start, end, signal);
	if (firstBacktick === -1) {
		scanCandidateRange(text, start, end, out, signal);
		return;
	}

	const remainingRuns = new Map<number, number>();
	let offset = firstBacktick;
	while (offset < end) {
		if (text.charCodeAt(offset) !== 96) {
			const next = indexOfCodeUnitInRange(text, 96, offset + 1, end, signal);
			if (next === -1) break;
			offset = next;
		}
		const runStart = offset;
		while (offset < end && text.charCodeAt(offset) === 96) {
			offset++;
			checkScanAbort(offset, signal);
		}
		const length = offset - runStart;
		remainingRuns.set(length, (remainingRuns.get(length) ?? 0) + 1);
	}

	let proseStart = start;
	let openLength = 0;
	offset = firstBacktick;
	while (offset < end) {
		if (text.charCodeAt(offset) !== 96) {
			const next = indexOfCodeUnitInRange(text, 96, offset + 1, end, signal);
			if (next === -1) break;
			offset = next;
		}
		const runStart = offset;
		while (offset < end && text.charCodeAt(offset) === 96) {
			offset++;
			checkScanAbort(offset, signal);
		}
		const rawLength = offset - runStart;
		const remaining = (remainingRuns.get(rawLength) ?? 1) - 1;
		if (remaining === 0) remainingRuns.delete(rawLength);
		else remainingRuns.set(rawLength, remaining);

		if (openLength !== 0) {
			if (rawLength === openLength) {
				openLength = 0;
				proseStart = offset;
			}
			continue;
		}

		const escaped = backtickIsEscaped(text, runStart, start);
		const openerStart = escaped ? runStart + 1 : runStart;
		const openerLength = rawLength - (escaped ? 1 : 0);
		if (openerLength > 0 && (remainingRuns.get(openerLength) ?? 0) > 0) {
			scanCandidateRange(text, proseStart, openerStart, out, signal);
			openLength = openerLength;
		}
		checkScanAbort(offset, signal);
	}
	// Every accepted opener had a later matching raw run, so this is prose.
	scanCandidateRange(text, proseStart, end, out, signal);
}

function containsDeepListPrefix(text: string, signal?: AbortSignal): boolean {
	let lineStart = 0;
	while (lineStart < text.length) {
		const contentEnd = originalLineContentEnd(text, lineStart, signal);
		if (deepListPrefix(text, lineStart, contentEnd, signal)) return true;
		lineStart = originalLineNext(text, contentEnd);
		throwIfFileMentionAborted(signal);
	}
	return false;
}

/**
 * Bounded-memory Markdown scan for large sources and ultra-deep list input.
 * It never normalizes/copies the full prompt, constructs an AST, or retains
 * code-range objects. Bounded, structurally rich sources continue to use Marked.
 */
function scanStreamingMarkdownTokens(text: string, signal?: AbortSignal): ScannedToken[] {
	const out: ScannedToken[] = [];
	let lineStart = 0;
	let paragraphStart = -1;
	let paragraphEnd = -1;
	let inIndentedCode = false;
	let openFence: StreamingFence | undefined;

	const flushParagraph = () => {
		if (paragraphStart >= 0) {
			scanInlineBlockCandidates(text, paragraphStart, paragraphEnd, out, signal);
			paragraphStart = -1;
			paragraphEnd = -1;
		}
	};

	while (lineStart < text.length) {
		throwIfFileMentionAborted(signal);
		const contentEnd = originalLineContentEnd(text, lineStart, signal);
		const lineNext = originalLineNext(text, contentEnd);

		if (openFence) {
			let closeStart: number | undefined;
			if (openFence.indentColumns !== undefined) {
				closeStart = indentationEnd(
					text,
					lineStart,
					contentEnd,
					openFence.indentColumns,
					signal,
				);
			} else {
				closeStart = streamingContainerPrefix(text, lineStart, contentEnd).contentStart;
			}
			if (
				closeStart !== undefined &&
				streamingFenceRun(text, closeStart, contentEnd, openFence, signal)
			) {
				openFence = undefined;
			}
			lineStart = lineNext;
			continue;
		}

		const deepPrefix = deepListPrefix(text, lineStart, contentEnd, signal);
		if (deepPrefix) {
			flushParagraph();
			inIndentedCode = false;
			const fence = streamingFenceRun(
				text,
				deepPrefix.contentOffset,
				contentEnd,
				undefined,
				signal,
			);
			if (fence) openFence = { ...fence, indentColumns: deepPrefix.indentColumns };
			else scanInlineBlockCandidates(
				text,
				deepPrefix.contentOffset,
				contentEnd,
				out,
				signal,
			);
			lineStart = lineNext;
			continue;
		}

		const container = streamingContainerPrefix(text, lineStart, contentEnd);
		const blank = isBlankRange(text, container.contentStart, contentEnd, signal);
		if (blank) {
			flushParagraph();
			inIndentedCode = false;
			lineStart = lineNext;
			continue;
		}

		const fence = streamingFenceRun(
			text,
			container.contentStart,
			contentEnd,
			undefined,
			signal,
		);
		if (fence) {
			flushParagraph();
			inIndentedCode = false;
			openFence = fence;
			lineStart = lineNext;
			continue;
		}

		const indented = rangeHasFourColumnIndent(
			text,
			container.contentStart,
			contentEnd,
		);
		if (container.hadContainer) {
			flushParagraph();
			inIndentedCode = false;
			if (!indented) {
				scanInlineBlockCandidates(
					text,
					container.contentStart,
					contentEnd,
					out,
					signal,
				);
			}
			lineStart = lineNext;
			continue;
		}

		if (inIndentedCode) {
			if (indented) {
				lineStart = lineNext;
				continue;
			}
			inIndentedCode = false;
		}
		if (indented && paragraphStart < 0) {
			inIndentedCode = true;
			lineStart = lineNext;
			continue;
		}

		if (isAtxHeadingLine(text, lineStart, contentEnd)) {
			flushParagraph();
			scanInlineBlockCandidates(text, lineStart, contentEnd, out, signal);
			lineStart = lineNext;
			continue;
		}

		if (paragraphStart < 0) paragraphStart = lineStart;
		paragraphEnd = lineNext;
		lineStart = lineNext;
	}
	flushParagraph();
	throwIfFileMentionAborted(signal);
	return out;
}

const WINDOWS_DOS_DEVICE_SEGMENT = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?=$|[.:])/i;

/** On Win32, network/device namespaces and reserved DOS devices are ordinary
 * text rather than filesystem mention targets. POSIX has no such namespaces:
 * double-slash absolute paths and names such as NUL must be classified there. */
function isWindowsNamespaceToken(rawPath: string): boolean {
	if (process.platform !== "win32") return false;
	const normalized = rawPath.replace(/\\/g, "/");
	if (normalized.startsWith("//") || normalized.startsWith("/??/")) return true;

	// A drive-relative path such as `C:CON.txt` addresses the same reserved
	// device as `CON.txt`. Every later component is checked too: Win32 treats a
	// reserved basename as a device even with an extension or colon suffix.
	const pathWithoutDrive = /^[a-z]:/i.test(normalized) ? normalized.slice(2) : normalized;
	return pathWithoutDrive
		.split("/")
		.some((segment) => WINDOWS_DOS_DEVICE_SEGMENT.test(segment));
}

/**
 * Scan prose for `@path` tokens while preserving original UTF-16 indices.
 * Code-contained matches are excluded before they can consume the budget.
 */
function scanTokens(text: string, signal?: AbortSignal): ScannedToken[] {
	throwIfFileMentionAborted(signal);
	const re = /(^|\s)@([^\s@]+)/g;
	// Ordinary prompts need no Markdown token tree or normalized-source copy.
	// Marked remains the fidelity oracle for bounded Markdown. Large sources and
	// same-line container depths that could amplify its recursive AST are
	// admitted through the source-index-preserving streaming path instead.
	const hasIndentedCodeLine = /(?:^|\r\n?|\n)(?: {4}| {0,3}\t)/.test(text);
	const hasMarkdownContainerLine = /(?:^|\r\n?|\n) {0,3}(?:>|[-+*](?=[ \t\r\n]|$)|\d{1,9}[.)](?=[ \t\r\n]|$))/.test(text);
	const hasMarkdownCodeSignal = text.includes("`") || /~{3,}/.test(text)
		|| hasIndentedCodeLine || hasMarkdownContainerLine;
	if (
		hasMarkdownCodeSignal &&
		(
			text.length >= STREAMING_MARKDOWN_MIN_UNITS ||
			(hasMarkdownContainerLine && containsDeepListPrefix(text, signal))
		)
	) {
		return scanStreamingMarkdownTokens(text, signal);
	}
	let excluded: SourceRange[] | undefined;
	if (hasMarkdownCodeSignal) {
		try {
			excluded = scanMarkdownCodeRanges(text, signal);
		} catch (error) {
			if (error instanceof FileMentionAbortError) throw error;
			// Parser/alignment failure must not silently exclude its prose. The
			// non-recursive scanner preserves every admitted candidate instead.
			return scanStreamingMarkdownTokens(text, signal);
		}
	}
	const out: ScannedToken[] = [];
	let excludedIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		throwIfFileMentionAborted(signal);
		const prefixLen = m[1].length; // 0 at string start, 1 after whitespace
		const tokenStart = m.index + prefixLen; // position of "@"
		let untrimmedEnd = tokenStart + 1 + m[2].length;
		if (excluded) {
			while (
				excludedIndex < excluded.length &&
				excluded[excludedIndex].end <= tokenStart
			) {
				excludedIndex++;
			}
			const codeRange = excluded[excludedIndex];
			if (codeRange && codeRange.start < untrimmedEnd && codeRange.end > tokenStart) {
				// A candidate whose `@` begins inside code is entirely literal. When
				// code starts later in the same whitespace-bound regex match, retain
				// only the outside prefix (for example `@notes.txt`code``). This keeps
				// the code bytes untouched while preserving the real mention's source
				// range in UTF-16 code units.
				if (codeRange.start <= tokenStart) continue;
				untrimmedEnd = codeRange.start;
			}
		}

		let token = text.slice(tokenStart + 1, untrimmedEnd);
		// Trim trailing punctuation that is unlikely to be part of a path.
		while (token.length > 0 && TRAILING_PUNCT.has(token[token.length - 1])) {
			token = token.slice(0, -1);
		}
		if (token.length === 0) continue;
		const tokenEnd = tokenStart + 1 + token.length; // covers "@" + path
		out.push({ rawPath: token, range: [tokenStart, tokenEnd] });
		if (out.length > MAX_FILE_MENTION_RAW_CANDIDATES) {
			throw new FileMentionBudgetError(
				"FILE_MENTION_CANDIDATE_LIMIT",
				`Prompt contains more than ${MAX_FILE_MENTION_RAW_CANDIDATES} non-code file-mention candidates`,
			);
		}
	}
	throwIfFileMentionAborted(signal);
	return out;
}

function isMissingPathError(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return code === "ENOENT" || code === "ENOTDIR";
}

type FileMentionTargetClassification =
	| { kind: "exists"; lstat: fs.Stats }
	| { kind: "missing" }
	| { kind: "unreadable" };

/** Deduplicate lexical targets before the fixed worker pool probes them. */
function collectUniqueLexicalTargets(
	tokens: readonly ScannedToken[],
	resolvedCwd: string,
	signal?: AbortSignal,
): string[] {
	const seen = new Set<string>();
	const targets: string[] = [];
	for (const token of tokens) {
		throwIfFileMentionAborted(signal);
		if (isWindowsNamespaceToken(token.rawPath)) continue;
		const target = path.resolve(
			resolvedCwd,
			token.rawPath.replace(/\\/g, "/"),
		);
		if (seen.has(target)) continue;
		seen.add(target);
		targets.push(target);
		if (targets.length > MAX_FILE_MENTION_UNIQUE_PROBES) {
			throw new FileMentionBudgetError(
				"FILE_MENTION_PROBE_LIMIT",
				`Prompt contains more than ${MAX_FILE_MENTION_UNIQUE_PROBES} distinct file-mention targets`,
			);
		}
	}
	return targets;
}

interface FileMentionAdmission {
	tokens: ScannedToken[];
	resolvedCwd: string;
	lexicalTargets: string[];
}

/** Single source of truth for pure candidate/target admission. */
function prepareFileMentionAdmission(
	text: string,
	cwd: string,
	signal?: AbortSignal,
): FileMentionAdmission {
	throwIfFileMentionAborted(signal);
	const tokens = scanTokens(text, signal);
	throwIfFileMentionAborted(signal);
	const resolvedCwd = path.resolve(cwd);
	return {
		tokens,
		resolvedCwd,
		lexicalTargets: collectUniqueLexicalTargets(tokens, resolvedCwd, signal),
	};
}

/**
 * Reject an over-budget prompt without filesystem work. The WebSocket ingress
 * runs this before slash-skill discovery; resolution repeats it as defense in
 * depth and consumes the same shared scan/target logic to prevent drift.
 */
export async function preflightFileMentionAdmission(
	text: string,
	cwd: string,
	opts?: AbortSignal | { signal?: AbortSignal },
): Promise<void> {
	const signal = opts && "aborted" in opts ? opts : opts?.signal;
	throwIfFileMentionAborted(signal);
	if (!text.includes("@")) return;
	try {
		await resolutionSemaphore.acquire(signal);
	} catch (error) {
		rethrowSemaphoreAcquireError(error, signal);
	}
	try {
		throwIfFileMentionAborted(signal);
		prepareFileMentionAdmission(text, cwd, signal);
		throwIfFileMentionAborted(signal);
	} finally {
		resolutionSemaphore.release();
	}
}

/**
 * Classify every distinct lexical target with a fixed asynchronous worker
 * pool. Workers pull directly from the source iterator, so
 * classification does not prebuild a task/promise per candidate. The result
 * map retains lstat type information, allowing direct non-regular targets to
 * be rejected before any open. Every admitted target is consumed, so a long
 * run of missing candidates cannot hide a later existing target.
 */
async function lstatWithGlobalPermit(
	target: string,
	signal?: AbortSignal,
): Promise<fs.Stats> {
	try {
		await lstatSemaphore.acquire(signal);
	} catch (error) {
		rethrowSemaphoreAcquireError(error, signal);
	}
	try {
		throwIfFileMentionAborted(signal);
	} catch (error) {
		lstatSemaphore.release();
		throw error;
	}

	let operation: Promise<fs.Stats>;
	try {
		operation = fs.promises.lstat(target);
	} catch (error) {
		lstatSemaphore.release();
		throw error;
	}
	// Observe the uncancellable OS probe to settlement and retain its global
	// permit even when only the caller-facing wait exits promptly on abort.
	const completion = operation.then(
		(value) => ({ ok: true as const, value }),
		(error: unknown) => ({ ok: false as const, error }),
	).finally(() => lstatSemaphore.release());
	const outcome = await waitForPromiseOrAbort(completion, signal);
	throwIfFileMentionAborted(signal);
	if (!outcome.ok) throw outcome.error;
	return outcome.value;
}

async function classifyFileMentionTargets(
	lexicalTargets: readonly string[],
	signal?: AbortSignal,
): Promise<ReadonlyMap<string, FileMentionTargetClassification>> {
	throwIfFileMentionAborted(signal);
	const classifications = new Map<string, FileMentionTargetClassification>();
	const targets = lexicalTargets[Symbol.iterator]();
	const workers = Array.from(
		{ length: FILE_MENTION_PROBE_CONCURRENCY },
		async () => {
			while (true) {
				throwIfFileMentionAborted(signal);
				let target: string;
				while (true) {
					const next = targets.next();
					if (next.done) return;
					target = next.value;
					if (classifications.has(target)) continue;
					classifications.set(target, { kind: "unreadable" });
					break;
				}

				try {
					const lstat = await lstatWithGlobalPermit(target, signal);
					throwIfFileMentionAborted(signal);
					classifications.set(target, { kind: "exists", lstat });
				} catch (error) {
					if (error instanceof FileMentionAbortError) throw error;
					throwIfFileMentionAborted(signal);
					classifications.set(
						target,
						isMissingPathError(error)
							? { kind: "missing" }
							: { kind: "unreadable" },
					);
				}
			}
		},
	);
	await Promise.all(workers);
	throwIfFileMentionAborted(signal);
	return classifications;
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

const FILE_READ_CHUNK_BYTES = 64 * 1024;

type DescriptorSnapshot =
	| { ok: true; buffer: Buffer; size: number; canonicalPath: string }
	| { ok: false; reason: string; size?: number };

function configuredCap(value: number | undefined, hardLimit: number): number {
	if (value === undefined) return hardLimit;
	if (!Number.isFinite(value)) return hardLimit;
	return Math.min(hardLimit, Math.max(0, Math.floor(value)));
}

/** Read no more than `limit + 1` bytes so growth races cannot allocate freely. */
function readBoundedDescriptor(fd: number, limit: number): Buffer {
	const readLimit = limit + 1;
	const chunks: Buffer[] = [];
	let total = 0;
	while (total < readLimit) {
		const chunk = Buffer.allocUnsafe(Math.min(FILE_READ_CHUNK_BYTES, readLimit - total));
		const bytesRead = fs.readSync(fd, chunk, 0, chunk.length, null);
		if (bytesRead === 0) break;
		chunks.push(bytesRead === chunk.length ? chunk : chunk.subarray(0, bytesRead));
		total += bytesRead;
	}
	if (chunks.length === 0) return Buffer.alloc(0);
	if (chunks.length === 1) return chunks[0];
	return Buffer.concat(chunks, total);
}

type DescriptorPathResult =
	| { kind: "verified"; canonicalPath: string }
	| { kind: "unsupported" }
	| { kind: "error" };

const DESCRIPTOR_PATH_UNSUPPORTED_ERRORS = new Set(["ENOENT", "ENOTDIR", "EINVAL", "ENOSYS"]);

/**
 * Resolve the kernel-bound descriptor path where the platform exposes one.
 * A descriptor namespace that merely canonicalizes back to itself is not a
 * target-path facility and therefore falls through to identity validation.
 */
function resolveDescriptorCanonicalPath(fd: number): DescriptorPathResult {
	const roots = process.platform === "win32"
		? []
		: process.platform === "linux"
			? ["/proc/self/fd", "/dev/fd"]
			: ["/dev/fd", "/proc/self/fd"];
	for (const root of roots) {
		const descriptorPath = `${root}/${fd}`;
		try {
			const canonicalPath = fs.realpathSync.native(descriptorPath);
			if (
				canonicalPath === descriptorPath ||
				canonicalPath.startsWith(`${root}/`)
			) continue;
			return { kind: "verified", canonicalPath };
		} catch (error) {
			const code = (error as NodeJS.ErrnoException | undefined)?.code;
			if (code && DESCRIPTOR_PATH_UNSUPPORTED_ERRORS.has(code)) continue;
			return { kind: "error" };
		}
	}
	return { kind: "unsupported" };
}

function boundedBigIntSize(size: bigint): number {
	return size > BigInt(Number.MAX_SAFE_INTEGER)
		? Number.MAX_SAFE_INTEGER
		: Number(size);
}

/** Stable identity comparison; unavailable identity fails closed. */
function sameStableFileIdentity(
	opened: fs.BigIntStats,
	pathname: fs.BigIntStats,
): boolean {
	// Node exposes the OS file identity as (dev, ino). inode zero is treated as
	// unavailable rather than letting metadata lookalikes pass. The safe
	// fallback for filesystems without stable IDs is explicit rejection.
	if (opened.ino === 0n || pathname.ino === 0n) return false;
	return opened.dev === pathname.dev && opened.ino === pathname.ino;
}

/**
 * Validate the object actually bound to `fd` before reading any bytes. Kernel
 * descriptor paths defeat parent-component replacement races on Unix. Where
 * unavailable, a post-open canonical containment check plus pathname/fd file
 * identity comparison fails closed if the opened object cannot be proven.
 */
function validateOpenedDescriptor(
	fd: number,
	absPath: string,
	canonicalCwd: string,
	openedStat: fs.BigIntStats,
): { ok: true; canonicalPath: string } | { ok: false; reason: string } {
	const descriptorPath = resolveDescriptorCanonicalPath(fd);
	if (descriptorPath.kind === "error") return { ok: false, reason: "unreadable" };
	if (descriptorPath.kind === "verified") {
		return escapesDir(canonicalCwd, descriptorPath.canonicalPath)
			? { ok: false, reason: "outside-cwd" }
			: { ok: true, canonicalPath: descriptorPath.canonicalPath };
	}

	try {
		const postOpenCanonicalPath = fs.realpathSync.native(absPath);
		if (escapesDir(canonicalCwd, postOpenCanonicalPath)) {
			return { ok: false, reason: "outside-cwd" };
		}
		const pathnameStat = fs.statSync(postOpenCanonicalPath, { bigint: true });
		if (!pathnameStat.isFile() || !sameStableFileIdentity(openedStat, pathnameStat)) {
			return { ok: false, reason: "unreadable" };
		}
		return { ok: true, canonicalPath: postOpenCanonicalPath };
	} catch {
		return { ok: false, reason: "unreadable" };
	}
}

/**
 * Bind validation and bounded reads to one descriptor. O_NOFOLLOW closes the
 * final-component race where available; O_NONBLOCK prevents a raced-in special
 * file from blocking the event loop; descriptor containment/identity closes
 * the parent-component race. The descriptor is always closed.
 */
function snapshotCanonicalFile(
	absPath: string,
	canonicalCwd: string,
	perFileCap: number,
	aggregateRemaining: number,
): DescriptorSnapshot {
	let fd: number | undefined;
	let result: DescriptorSnapshot = { ok: false, reason: "unreadable" };
	try {
		const noFollow = fs.constants.O_NOFOLLOW;
		const nonBlock = fs.constants.O_NONBLOCK;
		const flags = fs.constants.O_RDONLY |
			(typeof noFollow === "number" ? noFollow : 0) |
			(typeof nonBlock === "number" ? nonBlock : 0);
		fd = fs.openSync(absPath, flags);
		const stat = fs.fstatSync(fd, { bigint: true });
		const size = boundedBigIntSize(stat.size);
		if (!stat.isFile()) {
			result = { ok: false, reason: "unreadable", size };
		} else {
			const validation = validateOpenedDescriptor(fd, absPath, canonicalCwd, stat);
			if (!validation.ok) {
				result = { ok: false, reason: validation.reason, size };
			} else if (stat.size > BigInt(perFileCap)) {
				result = { ok: false, reason: "too-large", size };
			} else if (stat.size > BigInt(aggregateRemaining)) {
				result = { ok: false, reason: "aggregate-cap", size };
			} else {
				const readCap = Math.min(perFileCap, aggregateRemaining);
				const buffer = readBoundedDescriptor(fd, readCap);
				if (buffer.length > readCap) {
					result = {
						ok: false,
						reason: perFileCap <= aggregateRemaining ? "too-large" : "aggregate-cap",
						size,
					};
				} else {
					result = {
						ok: true,
						buffer,
						size: buffer.length,
						canonicalPath: validation.canonicalPath,
					};
				}
			}
		}
	} catch {
		result = { ok: false, reason: "unreadable" };
	} finally {
		if (fd !== undefined) {
			try {
				fs.closeSync(fd);
			} catch {
				result = { ok: false, reason: "unreadable" };
			}
		}
	}
	return result;
}

/** Resolve a source while holding one process-wide resolver permit. */
async function resolveFileMentionsUnderPermit(
	text: string,
	cwd: string,
	opts?: ResolveFileMentionsOptions,
): Promise<ResolvedMentions> {
	const originalText = text;
	const signal = opts?.signal;
	throwIfFileMentionAborted(signal);
	const plainResult = (): ResolvedMentions => ({
		originalText,
		modelText: originalText,
		mentions: [],
		warnings: [],
	});
	const maxTextBytes = configuredCap(opts?.maxFileBytes, MAX_INLINE_TEXT_BYTES);
	const maxFileBytes = configuredCap(opts?.maxMentionFileBytes, MAX_MENTION_FILE_BYTES);
	const maxAggregate = configuredCap(opts?.maxAggregateBytes, MAX_MENTION_AGGREGATE_BYTES);

	// Repeat whole-send admission under the resolver permit as defense in depth.
	// This is the same pure scan/target check used by the WebSocket preflight.
	const { tokens, resolvedCwd, lexicalTargets } = prepareFileMentionAdmission(text, cwd, signal);
	throwIfFileMentionAborted(signal);
	if (tokens.length === 0 || lexicalTargets.length === 0) return plainResult();

	// Win32 network/device-namespace tokens are ordinary text and are omitted
	// from lexicalTargets. On POSIX the same spellings follow the normal
	// existence-first path.
	const mentions: FileMention[] = [];
	const warnings: string[] = [];
	const replacements: Array<{ start: number; end: number; expanded: string }> = [];

	// Classify every distinct lexical target before applying delivery limits.
	// Missing candidates neither consume the existing-reference cap nor prevent
	// a later valid target from being discovered.
	const classificationCache = await classifyFileMentionTargets(lexicalTargets, signal);
	throwIfFileMentionAborted(signal);
	let hasExistingCandidate = false;
	for (const classification of classificationCache.values()) {
		if (classification.kind !== "missing") {
			hasExistingCandidate = true;
			break;
		}
	}
	if (!hasExistingCandidate) return plainResult();

	// Canonicalize cwd once for symlink-safe containment checks. Fall back to
	// the lexically-resolved cwd if it cannot be realpath'd (e.g. missing).
	let canonicalCwd: string;
	try {
		canonicalCwd = fs.realpathSync.native(resolvedCwd);
	} catch {
		canonicalCwd = resolvedCwd;
	}

	let aggregateUsed = 0;
	let resolvedCount = 0;

	for (const tok of tokens) {
		throwIfFileMentionAborted(signal);
		const rawPath = tok.rawPath;
		if (isWindowsNamespaceToken(rawPath)) continue;
		const normRel = rawPath.replace(/\\/g, "/");
		const base: FileMention = { path: rawPath, range: tok.range, kind: "unresolved" };

		const markUnresolved = (reason: string) => {
			base.kind = "unresolved";
			base.reason = reason;
			mentions.push(base);
			warnings.push(`@${rawPath}: ${reason}`);
		};

		const lexicalAbs = path.resolve(resolvedCwd, normRel);
		const classification = classificationCache.get(lexicalAbs) ?? { kind: "unreadable" as const };
		if (classification.kind === "missing") continue;

		// Missing candidates do not consume this cap. Extra existing candidates
		// require only the metadata classification above, never realpath/open/read.
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

		if (classification.kind === "unreadable") {
			markUnresolved("unreadable");
			continue;
		}

		// lstat does not follow the final component. A direct FIFO, socket,
		// device, or directory is therefore rejected without ever opening it.
		// Symlinks proceed to canonical containment and a following stat below.
		if (!classification.lstat.isFile() && !classification.lstat.isSymbolicLink()) {
			markUnresolved("unreadable");
			continue;
		}

		let absPath: string;
		try {
			absPath = fs.realpathSync.native(lexicalAbs);
		} catch {
			// lstat already proved existence. Any later canonicalization failure,
			// including ENOENT disappearance, is a delivery failure.
			markUnresolved("unreadable");
			continue;
		}

		// Path safety, step 2: canonical containment defeats symlink escapes before
		// any open/read, so an inside-cwd link cannot leak outside file bytes.
		if (escapesDir(canonicalCwd, absPath)) {
			markUnresolved("outside-cwd");
			continue;
		}

		// Following stat is metadata-only and catches symlinks to non-regular
		// targets plus type changes since lstat. O_NONBLOCK and fd-fstat below
		// remain the race-safe defense in depth between this check and open.
		try {
			if (!fs.statSync(absPath).isFile()) {
				markUnresolved("unreadable");
				continue;
			}
		} catch {
			markUnresolved("unreadable");
			continue;
		}

		const aggregateRemaining = Math.max(0, maxAggregate - aggregateUsed);
		const snapshot = snapshotCanonicalFile(
			absPath,
			canonicalCwd,
			maxFileBytes,
			aggregateRemaining,
		);
		if (snapshot.size !== undefined) base.bytes = snapshot.size;
		if (!snapshot.ok) {
			markUnresolved(snapshot.reason);
			continue;
		}

		base.absPath = snapshot.canonicalPath;
		const buf = snapshot.buffer;
		base.bytes = buf.length;
		const ext = path.extname(normRel).toLowerCase();

		// ── Image (by extension) ──────────────────────────────────────
		if (IMAGE_MIME[ext]) {
			aggregateUsed += buf.length;
			base.kind = "image";
			base.data = buf.toString("base64");
			base.mimeType = IMAGE_MIME[ext];
			mentions.push(base);
			continue;
		}

		// ── Non-image: sniff text vs binary ──────────────────────────
		if (isLikelyText(buf)) {
			const content = buf.toString("utf-8");
			const contentBytes = Buffer.byteLength(content, "utf-8");
			// Text has a smaller per-file cap, applied after type sniffing.
			if (contentBytes > maxTextBytes) {
				markUnresolved("too-large");
				continue;
			}
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

		// Non-image binary snapshot. `modelText` stays literal and the handler
		// routes the bytes through the document-attachment pipeline.
		aggregateUsed += buf.length;
		base.kind = "binary";
		base.data = buf.toString("base64");
		base.mimeType = binaryMimeForExt(ext);
		mentions.push(base);
	}

	// Build modelText by splicing text mentions right-to-left.
	throwIfFileMentionAborted(signal);
	let modelText = text;
	if (replacements.length > 0) {
		replacements.sort((a, b) => a.start - b.start);
		for (let i = replacements.length - 1; i >= 0; i--) {
			const r = replacements[i];
			modelText = modelText.slice(0, r.start) + r.expanded + modelText.slice(r.end);
		}
	}

	throwIfFileMentionAborted(signal);
	return { originalText, modelText, mentions, warnings };
}

/**
 * Resolve all `@path` file mentions relative to `cwd`. The process-wide FIFO
 * permit bounds Markdown and filesystem work across sessions; classification
 * then streams candidates through a fixed, module-global-lstat-limited pool.
 */
export async function resolveFileMentions(
	text: string,
	cwd: string,
	opts?: ResolveFileMentionsOptions,
): Promise<ResolvedMentions> {
	const signal = opts?.signal;
	throwIfFileMentionAborted(signal);
	if (!text.includes("@")) {
		return { originalText: text, modelText: text, mentions: [], warnings: [] };
	}
	try {
		await resolutionSemaphore.acquire(signal);
	} catch (error) {
		rethrowSemaphoreAcquireError(error, signal);
	}
	try {
		throwIfFileMentionAborted(signal);
		return await resolveFileMentionsUnderPermit(text, cwd, opts);
	} finally {
		resolutionSemaphore.release();
	}
}
