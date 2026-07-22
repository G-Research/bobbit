/**
 * Transcript reader — pure module that parses an agent JSONL transcript and
 * returns a paginated, optionally regex-filtered envelope.
 *
 * No HTTP, no sandbox concerns: file content is provided by the caller via
 * the `readContent` argument. Path resolution + sandbox-aware reads happen
 * in the server route handler that wires this module to `sessionFileRead`.
 *
 * See `src/server/server.ts` (`GET /api/sessions/:id/transcript`) for the
 * HTTP surface and design doc for the contract.
 */

import type { MessageAuthor } from "../../shared/message-author.js";
import {
	isToolResultOnlyMessage,
	normalizeVisibleMessage,
	type NormalizeVisibleMessageContext,
} from "./message-author.js";
import {
	mergeAuthorSidecarIntoMessages,
	type PromptAuthorBinding,
} from "./author-sidecar.js";

// ── Types ──

export interface ReadTranscriptParams {
	offset?: number;
	limit?: number;
	pattern?: string;
	caseSensitive?: boolean;
	context?: number;
	verbose?: boolean;
	/**
	 * Backward-compatible default is true for direct reader/API callers.
	 * The agent-facing read_session tool passes false unless explicitly opted in.
	 */
	includeToolResults?: boolean;
}

export interface CompactToolUse {
	name: string;
	inputPreview: string;
}

export type ToolResultStatus = "ok" | "error" | "unknown";

export interface ToolResultSize {
	type: "string" | "array" | "object" | "null" | "missing" | "other";
	chars?: number;
	lines?: number;
	bytes?: number;
	blocks?: number;
}

export interface CompactToolResult {
	name?: string;
	toolUseId?: string;
	/** Present only when raw tool output is intentionally omitted. */
	omitted?: boolean;
	/** Present only when includeToolResults is true. */
	preview?: string;
	status?: ToolResultStatus;
	size?: ToolResultSize;
}

export interface CompactMessage {
	index: number;
	role: string;
	ts: string | null;
	text: string;
	author?: MessageAuthor;
	toolUses?: CompactToolUse[];
	toolResults?: CompactToolResult[];
}

export interface VerboseMessage {
	index: number;
	role: string;
	ts: string | null;
	content: unknown;
	author?: MessageAuthor;
	/** Full pi-coding-agent message object (`entry.message`). Carries
	 *  toolCallId/toolName/details/isError for toolResult rows and any
	 *  other fields the renderer-side `<message-list>` component expects.
	 *  Only populated for the orphan-history (`before-compaction`) path
	 *  where the client renders these rows via the same Lit components
	 *  that render the live transcript. `readTranscript` callers (read_session
	 *  tool) still get just `content`. */
	message?: Record<string, unknown>;
}

export type TranscriptMessage = CompactMessage | VerboseMessage;

export interface ReadTranscriptEnvelope {
	total: number;
	matchCount?: number;
	returned: number;
	offsetStart: number;
	offsetEnd: number;
	messages: TranscriptMessage[];
}

export type ReadTranscriptError =
	| "transcript_unavailable"
	| "invalid_regex"
	| "invalid_params"
	| "compaction_not_found";

export class TranscriptReaderError extends Error {
	code: ReadTranscriptError;
	constructor(code: ReadTranscriptError, message?: string) {
		super(message ?? code);
		this.code = code;
	}
}

// ── Internal types ──

interface RawMessage {
	index: number;
	role: string;
	ts: string | null;
	content: unknown;
	/** Pi-coding-agent session-entry id (`SessionEntryBase.id`). May be
	 *  null for legacy files whose entries lacked an explicit `id`. */
	entryId: string | null;
	/** Pi-coding-agent's entry `type` field (e.g. "message", "compaction").
	 *  Used by `readOrphanedBeforeCompaction` to spot the in-jsonl compaction
	 *  checkpoint when the sidecar doesn't carry firstKeptEntryId. */
	entryType: string;
	/** Full `entry.message` object — captured for the verbose orphan path
	 *  which needs toolCallId/toolName/etc. for `<message-list>` rendering.
	 *  Other paths read `content` directly. */
	fullMessage: Record<string, unknown>;
	/** Resolved Bobbit author. Kept separately so compact projections do not
	 *  need to expose transcript correlation fields. */
	author?: MessageAuthor;
}

const TEXT_LIMIT = 800;
const PREVIEW_LIMIT = 200;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;
const MAX_CONTEXT = 5;

// ── JSONL parsing ──

function flattenText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const b = block as Record<string, unknown>;
		const t = b.type;
		if (isToolResultBlock(b)) {
			const body = toolResultBody(b);
			const c = body.value;
			parts.push(`[RESULT: ${body.has ? (typeof c === "string" ? c : safeStringify(c)) : ""}]`);
		} else if (t === "text" && typeof b.text === "string") {
			parts.push(b.text);
		} else if (t === "tool_use") {
			const name = typeof b.name === "string" ? b.name : "?";
			let input = "";
			try { input = JSON.stringify(b.input ?? {}); } catch { input = ""; }
			parts.push(`[TOOL: ${name} ${input}]`);
		}
	}
	return parts.join(" ");
}

function safeStringify(v: unknown): string {
	if (v === null || v === undefined) return "";
	if (typeof v === "string") return v;
	try { return JSON.stringify(v); } catch { return String(v); }
}

const TOOL_RESULT_BODY_KEYS = ["content", "output", "result", "response", "text"] as const;
type ToolResultBodyKey = typeof TOOL_RESULT_BODY_KEYS[number];

function isToolResultBodyKey(key: string): key is ToolResultBodyKey {
	return (TOOL_RESULT_BODY_KEYS as readonly string[]).includes(key);
}

function toolResultBody(block: Record<string, unknown>): { value: unknown; has: boolean; key?: ToolResultBodyKey } {
	for (const key of TOOL_RESULT_BODY_KEYS) {
		if (Object.prototype.hasOwnProperty.call(block, key)) return { value: block[key], has: true, key };
	}
	return { value: undefined, has: false };
}

function stringLineCount(value: string): number {
	if (value.length === 0) return 0;
	if (value.indexOf("\n") === -1 && value.indexOf("\r") === -1) return 1;
	let lines = 1;
	for (let i = 0; i < value.length; i++) {
		const ch = value.charCodeAt(i);
		if (ch === 13) {
			lines++;
			if (value.charCodeAt(i + 1) === 10) i++;
		} else if (ch === 10) {
			lines++;
		}
	}
	return lines;
}

function contentSize(content: unknown, hasContent = true): ToolResultSize {
	if (!hasContent) return { type: "missing" };
	if (content === null) return { type: "null" };
	if (typeof content === "string") {
		return {
			type: "string",
			chars: content.length,
			lines: stringLineCount(content),
			bytes: Buffer.byteLength(content, "utf8"),
		};
	}
	if (Array.isArray(content)) return { type: "array", blocks: content.length };
	if (typeof content === "object") return { type: "object" };
	return { type: "other" };
}

function truthyError(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	return undefined;
}

function resultStatus(block: Record<string, unknown>, message: Record<string, unknown>): ToolResultStatus {
	const isError = truthyError(block.is_error) ?? truthyError(block.isError) ?? truthyError(message.isError);
	if (isError === true) return "error";
	if (isError === false) return "ok";
	return "unknown";
}

function blockToolUseId(block: Record<string, unknown>): string | undefined {
	for (const key of ["tool_use_id", "toolUseId", "toolCallId", "tool_call_id", "id"]) {
		const value = block[key];
		if (typeof value === "string" && value) return value;
	}
	return undefined;
}

function blockToolName(block: Record<string, unknown>): string | undefined {
	const name = block.name ?? block.toolName;
	return typeof name === "string" && name ? name : undefined;
}

function buildToolNameMap(messages: RawMessage[]): Map<string, string> {
	const map = new Map<string, string>();
	for (const m of messages) {
		if (!Array.isArray(m.content)) continue;
		for (const block of m.content) {
			if (!block || typeof block !== "object") continue;
			const b = block as Record<string, unknown>;
			const type = b.type;
			const id = blockToolUseId(b);
			const name = blockToolName(b);
			if (id && name && (type === "tool_use" || type === "toolCall" || b.toolCallId || b.toolName)) {
				map.set(id, name);
			}
		}
	}
	return map;
}

interface RenderOptions {
	includeToolResults: boolean;
	toolNameById: Map<string, string>;
}

const DEFAULT_RENDER_OPTIONS: RenderOptions = {
	includeToolResults: true,
	toolNameById: new Map<string, string>(),
};

function toolResultMeta(
	block: Record<string, unknown>,
	message: Record<string, unknown>,
	options: RenderOptions,
): { name?: string; toolUseId?: string; status: ToolResultStatus; size: ToolResultSize } {
	const toolUseId = blockToolUseId(block) ?? (typeof message.toolCallId === "string" ? message.toolCallId : undefined);
	const name = blockToolName(block)
		?? (typeof message.toolName === "string" ? message.toolName : undefined)
		?? (toolUseId ? options.toolNameById.get(toolUseId) : undefined);
	const body = toolResultBody(block);
	return {
		...(name ? { name } : {}),
		...(toolUseId ? { toolUseId } : {}),
		status: resultStatus(block, message),
		size: contentSize(body.value, body.has),
	};
}

function isToolResultRole(role: unknown): boolean {
	return role === "toolResult" || role === "tool_result" || role === "tool";
}

function isToolResultBlock(block: unknown): boolean {
	if (!block || typeof block !== "object") return false;
	const b = block as Record<string, unknown>;
	return b.type === "tool_result" || b.type === "toolResult" || isToolResultRole(b.role);
}

function firstString(source: Record<string, unknown>, keys: string[]): string | undefined {
	for (const key of keys) {
		const value = source[key];
		if (typeof value === "string" && value) return value;
	}
	return undefined;
}

function isMessageLevelToolResult(m: RawMessage): boolean {
	return isToolResultRole(m.role) || isToolResultRole(m.fullMessage.role);
}

function messageLevelToolResultBlock(m: RawMessage): Record<string, unknown> {
	const block: Record<string, unknown> = { type: "tool_result" };
	const toolUseId = firstString(m.fullMessage, ["toolCallId", "toolUseId", "tool_use_id", "tool_call_id", "id"]);
	const name = firstString(m.fullMessage, ["toolName", "name"]);
	if (toolUseId) block.toolUseId = toolUseId;
	if (name) {
		block.name = name;
		block.toolName = name;
	}
	if (typeof m.fullMessage.isError === "boolean") block.isError = m.fullMessage.isError;
	if (typeof m.fullMessage.is_error === "boolean") block.is_error = m.fullMessage.is_error;
	const body = toolResultBody(m.fullMessage);
	if (body.has) block.content = body.value;
	return block;
}

function toolResultPreview(content: unknown): string {
	return (typeof content === "string" ? content : safeStringify(content)).slice(0, PREVIEW_LIMIT);
}

const OMITTED_TOOL_RESULT_CONTENT = "[tool result omitted; pass include_tool_results:true to read_session to include it]";

export function parseJsonl(content: string): RawMessage[] {
	if (!content) return [];
	const messages: RawMessage[] = [];
	const lines = content.split(/\r?\n/);
	let idx = 0;
	for (const raw of lines) {
		const line = raw.trim();
		if (!line) continue;
		let entry: any;
		try { entry = JSON.parse(line); } catch { continue; }
		if (!entry || entry.type !== "message" || !entry.message) continue;
		const role = typeof entry.message.role === "string" ? entry.message.role : "?";
		const ts = typeof entry.ts === "string" ? entry.ts
			: typeof entry.timestamp === "string" ? entry.timestamp
			: null;
		const entryId = typeof entry.id === "string" ? entry.id : null;
		messages.push({
			index: idx++,
			role,
			ts,
			content: entry.message.content,
			entryId,
			entryType: entry.type,
			fullMessage: entry.message as Record<string, unknown>,
		});
	}
	return messages;
}

// ── Compact rendering ──

function toCompact(m: RawMessage, options: RenderOptions = DEFAULT_RENDER_OPTIONS): CompactMessage {
	const content = m.content;
	let text = "";
	const toolUses: CompactToolUse[] = [];
	const toolResults: CompactToolResult[] = [];

	if (isMessageLevelToolResult(m) && !options.includeToolResults) {
		const meta = toolResultMeta(messageLevelToolResultBlock(m), m.fullMessage, options);
		toolResults.push({ ...meta, omitted: true });
	} else if (typeof content === "string") {
		text = content;
	} else if (Array.isArray(content)) {
		const textParts: string[] = [];
		for (const block of content) {
			if (!block || typeof block !== "object") continue;
			const b = block as Record<string, unknown>;
			const t = b.type;
			if (isToolResultBlock(b)) {
				const meta = toolResultMeta(b, m.fullMessage, options);
				if (options.includeToolResults) {
					const body = toolResultBody(b);
					const preview = toolResultPreview(body.value);
					toolResults.push({ ...meta, preview });
				} else {
					toolResults.push({ ...meta, omitted: true });
				}
			} else if (t === "text" && typeof b.text === "string") {
				textParts.push(b.text);
			} else if (t === "tool_use") {
				const name = blockToolName(b) ?? "?";
				let inputPreview = "";
				try { inputPreview = JSON.stringify(b.input ?? {}).slice(0, PREVIEW_LIMIT); }
				catch { inputPreview = ""; }
				toolUses.push({ name, inputPreview });
			}
		}
		text = textParts.join("\n").trim();
	}

	if (text.length > TEXT_LIMIT) text = text.slice(0, TEXT_LIMIT) + "…";

	const out: CompactMessage = { index: m.index, role: m.role, ts: m.ts, text };
	if (m.author) out.author = m.author;
	if (toolUses.length > 0) out.toolUses = toolUses;
	if (toolResults.length > 0) out.toolResults = toolResults;
	return out;
}

function redactedToolResultBlock(
	block: Record<string, unknown>,
	message: Record<string, unknown>,
	options: RenderOptions,
): Record<string, unknown> {
	const meta = toolResultMeta(block, message, options);
	const redacted: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(block)) {
		if (isToolResultBodyKey(key)) continue;
		redacted[key] = value;
	}
	return {
		...redacted,
		...(meta.name && !redacted.name ? { name: meta.name } : {}),
		...(meta.toolUseId && !redacted.toolUseId && !redacted.tool_use_id && !redacted.tool_call_id ? { toolUseId: meta.toolUseId } : {}),
		content: OMITTED_TOOL_RESULT_CONTENT,
		contentOmitted: true,
		resultSize: meta.size,
		status: meta.status,
	};
}

function redactVerboseContent(content: unknown, m: RawMessage, options: RenderOptions): unknown {
	if (options.includeToolResults) return content;
	if (isMessageLevelToolResult(m)) {
		return [redactedToolResultBlock(messageLevelToolResultBlock(m), m.fullMessage, options)];
	}
	if (!Array.isArray(content)) return content;
	return content.map((block) => {
		if (!block || typeof block !== "object") return block;
		const b = block as Record<string, unknown>;
		if (!isToolResultBlock(b)) return block;
		return redactedToolResultBlock(b, m.fullMessage, options);
	});
}

function toVerbose(
	m: RawMessage,
	includeFullMessage = false,
	options: RenderOptions = DEFAULT_RENDER_OPTIONS,
): VerboseMessage {
	const out: VerboseMessage = { index: m.index, role: m.role, ts: m.ts, content: redactVerboseContent(m.content, m, options) };
	if (m.author) out.author = m.author;
	if (includeFullMessage) {
		out.message = m.author && m.fullMessage.author !== m.author
			? { ...m.fullMessage, author: m.author }
			: m.fullMessage;
	}
	return out;
}

// ── Filter + window ──

/**
 * Resolve an offset against `length`, allowing negative indexing (Python-style).
 *
 * - `offset >= 0` is returned as-is (may be > length, signalling out-of-range).
 * - `offset < 0` is treated as `length + offset`, clamped to 0 at the lower bound.
 *   (e.g. offset=-1 in a list of 5 → 4; offset=-20 in a list of 5 → 0.)
 */
export function resolveOffset(offset: number, length: number): number {
	if (offset >= 0) return offset;
	const resolved = length + offset;
	return resolved < 0 ? 0 : resolved;
}

function buildMatchList(
	messages: RawMessage[],
	pattern: string,
	caseSensitive: boolean,
	context: number,
): { matchCount: number; expanded: number[] } {
	let regex: RegExp;
	try {
		regex = new RegExp(pattern, caseSensitive ? "" : "i");
	} catch (err) {
		throw new TranscriptReaderError("invalid_regex", err instanceof Error ? err.message : String(err));
	}
	const matches: number[] = [];
	for (const m of messages) {
		const flat = isMessageLevelToolResult(m) ? flattenText([messageLevelToolResultBlock(m)]) : flattenText(m.content);
		if (regex.test(flat)) matches.push(m.index);
	}
	if (context <= 0) return { matchCount: matches.length, expanded: matches.slice() };

	const set = new Set<number>();
	for (const i of matches) {
		const lo = Math.max(0, i - context);
		const hi = Math.min(messages.length - 1, i + context);
		for (let k = lo; k <= hi; k++) set.add(k);
	}
	const expanded = Array.from(set).sort((a, b) => a - b);
	return { matchCount: matches.length, expanded };
}

// ── Author normalization ──

function isTranscriptSystemRow(message: Record<string, unknown>): boolean {
	if (message.customType === "bobbit:dynamic-context" || message.display === false) return true;
	if (message.role === "system-notification" || message.role === "mutation-pending" || message.role === "custom") return true;
	if (message.toolName === "__compaction_summary" || message.name === "__compaction_summary") return true;
	return Array.isArray(message.content) && message.content.some((block) => {
		if (!block || typeof block !== "object") return false;
		const candidate = block as Record<string, unknown>;
		return candidate.name === "__compaction_summary" || candidate.toolName === "__compaction_summary";
	});
}

/**
 * Attach authors before filtering/pagination so predecessor and duplicate
 * correlation follow transcript order. Correlation-only entry fields never
 * leak into compact/verbose projections.
 */
function resolveRawMessageAuthors(
	messages: RawMessage[],
	context?: TranscriptAuthorResolutionContext,
): RawMessage[] {
	if (messages.length === 0) return messages;
	const correlationRows: Array<Record<string, unknown>> = messages.map((raw) => {
		// Pi transcript author fields are not authoritative. Only a validated
		// Bobbit sidecar or read-time inference can supply the projected author.
		const { author: _untrustedAuthor, ...message } = raw.fullMessage;
		return {
			...message,
			...(raw.entryId ? { entryId: raw.entryId } : {}),
			...(raw.ts ? { ts: raw.ts } : {}),
		};
	});

	let authoredRows: Array<Record<string, unknown>>;
	if (context) {
		const { sidecarEntries = [], ...normalizationContext } = context;
		authoredRows = mergeAuthorSidecarIntoMessages(
			sidecarEntries,
			correlationRows,
			normalizationContext,
		);
	} else {
		// Direct library callers lack a target-session identity. Infer only
		// session-independent human/system rows; do not invent session:unknown
		// for assistant or orphan tool-result rows.
		let precedingAuthor: MessageAuthor | undefined;
		authoredRows = correlationRows.map((row) => {
			const toolResult = isToolResultOnlyMessage(row);
			const ordinaryUser = (row.role === "user" || row.role === "user-with-attachments")
				&& !toolResult;
			let resolved = ordinaryUser || isTranscriptSystemRow(row)
				? normalizeVisibleMessage(row)
				: row;
			if (toolResult && precedingAuthor) resolved = { ...row, author: precedingAuthor };
			if (resolved.author) precedingAuthor = resolved.author as MessageAuthor;
			return resolved;
		});
	}

	return messages.map((raw, index) => {
		const resolved = authoredRows[index];
		const author = resolved.author as MessageAuthor | undefined;
		const { entryId: _entryId, ts: _ts, ...fullMessage } = resolved;
		return {
			...raw,
			fullMessage,
			...(author ? { author } : {}),
		};
	});
}

// ── Public API ──

export interface TranscriptAuthorResolutionContext extends NormalizeVisibleMessageContext {
	/** Folded Bobbit-owned prompt bindings for this session. */
	sidecarEntries?: PromptAuthorBinding[];
}

export interface ReadTranscriptOptions {
	/** Async loader returning the raw JSONL contents. */
	readContent: () => Promise<string | null>;
	/** Optional session and sidecar context for precise agent/system attribution. */
	authorContext?: TranscriptAuthorResolutionContext;
}

/**
 * Parse the full JSONL into a flat list of ALL entries (not just `message`).
 * Returns the raw entries plus the original index in the file. Used by
 * `readOrphanedBeforeCompaction` to walk past non-message entries (the
 * `compaction` marker in particular) without skipping them.
 */
function parseJsonlAllEntries(content: string): Array<{ entry: any; lineIdx: number }> {
	if (!content) return [];
	const out: Array<{ entry: any; lineIdx: number }> = [];
	const lines = content.split(/\r?\n/);
	let i = 0;
	for (const raw of lines) {
		const line = raw.trim();
		if (!line) continue;
		let entry: any;
		try { entry = JSON.parse(line); } catch { continue; }
		if (!entry || typeof entry !== "object") continue;
		out.push({ entry, lineIdx: i++ });
	}
	return out;
}

// ── Pre-compaction (orphaned) reader ──

export interface ReadOrphanedParams {
	/** Required. Sidecar entry id whose firstKeptEntryId defines the split. */
	compactionId: string;
	/** Optional pagination cursor — entry index within the orphaned slice
	 *  of the last item returned by the previous page. Pass back
	 *  `envelope.nextCursor`. */
	cursor?: number;
	/** Default 50, range 1..200. */
	limit?: number;
	/** When true, return full `entry.message` objects (with toolCallId,
	 *  toolName, details, etc.) so the client can render rows via the
	 *  same `<message-list>` Lit component as the live transcript.
	 *  Default false — returns the compact preview shape. */
	verbose?: boolean;
}

export interface ReadOrphanedEnvelope {
	/** Total orphaned entries for this compaction (independent of pagination). */
	total: number;
	returned: number;
	/** Pass back as `cursor` for the next page. Null when no more pages. */
	nextCursor: number | null;
	messages: CompactMessage[] | VerboseMessage[];
}

export interface ReadOrphanedOptions {
	readContent: () => Promise<string | null>;
	/** First-kept entry id from the sidecar. When null or stale, prefer the
	 *  same field on the in-file compaction entry before using that entry as
	 *  the fallback checkpoint. */
	firstKeptEntryId: string | null;
	/** Optional session and sidecar context for precise agent/system attribution. */
	authorContext?: TranscriptAuthorResolutionContext;
}

/**
 * Return the orphaned (pre-compaction) entries for the named compaction.
 *
 * Branch-split rules (see docs/design/persist-compaction-history.md §4.1):
 *
 *  - If `firstKeptEntryId` is non-null: scan parsed entries for the entry
 *    whose `id` matches. Everything strictly before that index is
 *    orphaned.
 *  - If the sidecar boundary is null or stale: inspect the FIRST in-file
 *    `type:"compaction"` checkpoint. Prefer its compatibility
 *    `firstKeptEntryId` when resolvable; otherwise use the checkpoint itself.
 *    Pi 0.81 harness checkpoints may instead carry a materialized
 *    `retainedTail`, so the checkpoint remains the only reliable top-level
 *    boundary when no first-kept id was persisted.
 *  - If neither resolves: return total=0 (no fabricated history).
 */
export async function readOrphanedBeforeCompaction(
	params: ReadOrphanedParams,
	opts: ReadOrphanedOptions,
): Promise<ReadOrphanedEnvelope> {
	if (!params.compactionId || typeof params.compactionId !== "string") {
		throw new TranscriptReaderError("invalid_params", "compactionId required");
	}

	let limit = params.limit ?? 50;
	if (typeof limit !== "number" || !Number.isFinite(limit) || Math.floor(limit) !== limit) {
		throw new TranscriptReaderError("invalid_params", "limit must be an integer");
	}
	if (limit < 1 || limit > MAX_LIMIT) {
		throw new TranscriptReaderError("invalid_params", `limit must be in [1, ${MAX_LIMIT}]`);
	}

	const cursor = params.cursor ?? 0;
	if (typeof cursor !== "number" || !Number.isFinite(cursor) || Math.floor(cursor) !== cursor || cursor < 0) {
		throw new TranscriptReaderError("invalid_params", "cursor must be a non-negative integer");
	}

	const content = await opts.readContent();
	if (content === null || content === undefined || content === "") {
		throw new TranscriptReaderError("transcript_unavailable", "transcript file missing or empty");
	}

	const allEntries = parseJsonlAllEntries(content);

	// Resolve the split index in `allEntries`.
	let splitIdx = -1;
	if (opts.firstKeptEntryId) {
		splitIdx = allEntries.findIndex((e) => e.entry?.id === opts.firstKeptEntryId);
	}
	if (splitIdx < 0) {
		const compactionIdx = allEntries.findIndex((e) => e.entry?.type === "compaction");
		if (compactionIdx >= 0) {
			const inFileFirstKeptId = allEntries[compactionIdx].entry?.firstKeptEntryId;
			if (typeof inFileFirstKeptId === "string" && inFileFirstKeptId.length > 0) {
				splitIdx = allEntries.findIndex((e) => e.entry?.id === inFileFirstKeptId);
			}
			// With retainedTail-only Pi 0.81 checkpoints there is no stable id
			// for the original tail boundary. Falling back to the checkpoint is
			// conservative and preserves the existing no-fabrication behavior.
			if (splitIdx < 0) splitIdx = compactionIdx;
		}
	}
	if (splitIdx <= 0) {
		return { total: 0, returned: 0, nextCursor: null, messages: [] };
	}

	// Build the orphaned message list (entries before splitIdx, message-only).
	const orphaned: RawMessage[] = [];
	let idx = 0;
	for (let i = 0; i < splitIdx; i++) {
		const { entry } = allEntries[i];
		if (entry.type !== "message" || !entry.message) continue;
		const role = typeof entry.message.role === "string" ? entry.message.role : "?";
		const ts = typeof entry.ts === "string" ? entry.ts
			: typeof entry.timestamp === "string" ? entry.timestamp
			: null;
		orphaned.push({
			index: idx++,
			role,
			ts,
			content: entry.message.content,
			entryId: typeof entry.id === "string" ? entry.id : null,
			entryType: entry.type,
			fullMessage: entry.message as Record<string, unknown>,
		});
	}

	const authoredOrphaned = resolveRawMessageAuthors(orphaned, opts.authorContext);
	const total = authoredOrphaned.length;
	const start = Math.min(cursor, total);
	const end = Math.min(total, start + limit);
	const window = authoredOrphaned.slice(start, end);
	const messages = params.verbose
		? window.map((m) => toVerbose(m, /* includeFullMessage */ true))
		: window.map((m) => toCompact(m));
	const nextCursor = end < total ? end : null;
	return { total, returned: messages.length, nextCursor, messages };
}

export async function readTranscript(
	params: ReadTranscriptParams,
	opts: ReadTranscriptOptions,
): Promise<ReadTranscriptEnvelope> {
	// Validate params first.
	let limit = params.limit ?? DEFAULT_LIMIT;
	if (typeof limit !== "number" || !Number.isFinite(limit) || Math.floor(limit) !== limit) {
		throw new TranscriptReaderError("invalid_params", "limit must be an integer");
	}
	if (limit < 1 || limit > MAX_LIMIT) {
		throw new TranscriptReaderError("invalid_params", `limit must be in [1, ${MAX_LIMIT}]`);
	}

	const offset = params.offset ?? 0;
	if (typeof offset !== "number" || !Number.isFinite(offset) || Math.floor(offset) !== offset) {
		throw new TranscriptReaderError("invalid_params", "offset must be an integer");
	}

	const context = params.context ?? 0;
	if (typeof context !== "number" || !Number.isFinite(context) || Math.floor(context) !== context) {
		throw new TranscriptReaderError("invalid_params", "context must be an integer");
	}
	if (context < 0 || context > MAX_CONTEXT) {
		throw new TranscriptReaderError("invalid_params", `context must be in [0, ${MAX_CONTEXT}]`);
	}

	const verbose = !!params.verbose;
	const includeToolResults = params.includeToolResults ?? true;
	const pattern = params.pattern;
	const caseSensitive = !!params.caseSensitive;

	const content = await opts.readContent();
	if (content === null || content === undefined || content === "") {
		throw new TranscriptReaderError("transcript_unavailable", "transcript file missing or empty");
	}

	const all = resolveRawMessageAuthors(parseJsonl(content), opts.authorContext);
	const total = all.length;
	const renderOptions: RenderOptions = { includeToolResults, toolNameById: buildToolNameMap(all) };

	// No pattern → window over the raw transcript.
	let workingIndices: number[];
	let matchCount: number | undefined;
	if (pattern && pattern.length > 0) {
		const { matchCount: mc, expanded } = buildMatchList(all, pattern, caseSensitive, context);
		matchCount = mc;
		workingIndices = expanded;
	} else {
		workingIndices = all.map((_, i) => i);
	}

	const len = workingIndices.length;
	const start = resolveOffset(offset, len);
	const end = Math.min(len, start + limit);

	if (start >= len) {
		const env: ReadTranscriptEnvelope = {
			total,
			returned: 0,
			offsetStart: -1,
			offsetEnd: -1,
			messages: [],
		};
		if (matchCount !== undefined) env.matchCount = matchCount;
		return env;
	}

	const windowIndices = workingIndices.slice(start, end);
	const messages: TranscriptMessage[] = windowIndices.map((i) => {
		const raw = all[i];
		return verbose ? toVerbose(raw, false, renderOptions) : toCompact(raw, renderOptions);
	});

	const env: ReadTranscriptEnvelope = {
		total,
		returned: messages.length,
		offsetStart: messages.length > 0 ? messages[0].index : -1,
		offsetEnd: messages.length > 0 ? messages[messages.length - 1].index : -1,
		messages,
	};
	if (matchCount !== undefined) env.matchCount = matchCount;
	return env;
}
