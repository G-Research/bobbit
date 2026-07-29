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

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { Worker, type WorkerOptions } from "node:worker_threads";
import type { MessageAuthor } from "../../shared/message-author.js";
import {
	isToolResultOnlyMessage,
	normalizeVisibleMessage,
	type NormalizeVisibleMessageContext,
} from "./message-author.js";
import {
	canonicalToolCallArgumentDetails,
	canonicalToolResultBodyDetails,
	CanonicalTranscriptValueError,
	isWellFormedUnicode,
} from "./canonical-tool-result-body.js";
import {
	mergeAuthorSidecarIntoMessages,
	readAuthorSidecar,
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
	/** Agent-only stable handle for one targeted result excerpt. */
	resultHandle?: string;
	/** Agent-only UTF-16 cursor into the canonical result body. */
	resultCursor?: number;
	/** Agent-only maximum UTF-16 units for a result excerpt. */
	resultLimit?: number;
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

export interface ProjectedToolCall {
	ref: string;
	name: string;
	argumentsPreview: string;
	argumentsTruncated: boolean;
}

export interface ProjectedToolResult {
	ref: string;
	name: string;
	status: ToolResultStatus;
	size: ToolResultSize;
	omitted: boolean;
	handle: string;
	excerpt?: ProjectedToolResultExcerpt;
}

export interface ProjectedToolResultExcerpt {
	start: number;
	end: number;
	text: string;
	nextCursor: number | null;
	complete: boolean;
}

/** @deprecated Targeted slices now retain the complete canonical result metadata. */
export type ReducedProjectedToolResult = ProjectedToolResult;

export interface AgentTranscriptMessage {
	index: number;
	role: string;
	roleTruncated?: boolean;
	/** Omitted only by the deterministic minimum-budget slice fallback. */
	ts?: string | null;
	/** The persisted timestamp exceeded the agent projection cap. */
	tsTruncated?: boolean;
	/** The persisted timestamp contained an unpaired UTF-16 surrogate and was omitted. */
	tsInvalid?: boolean;
	/** Omitted only by the deterministic minimum-budget slice fallback. */
	text?: string;
	textTruncated?: boolean;
	thinking?: string;
	thinkingTruncated?: boolean;
	stopReason?: string;
	stopReasonTruncated?: boolean;
	errorSummary?: string;
	errorSummaryTruncated?: boolean;
	/** Legacy type compatibility only; canonical agent rows use authorRef. */
	author?: MessageAuthor;
	authorRef?: string;
	toolCalls?: ProjectedToolCall[];
	toolResults?: ProjectedToolResult[];
	projectionOmitted?: true;
	toolCallCount?: number;
	toolResultCount?: number;
}

export type TranscriptMessage = CompactMessage | VerboseMessage | AgentTranscriptMessage;

export interface ReadTranscriptEnvelope {
	total: number;
	matchCount?: number;
	/** Resolved position of this window in the raw or context-expanded sequence. */
	pageStart?: number;
	/** Total pageable rows in that raw or context-expanded sequence. */
	pageCount?: number;
	returned: number;
	offsetStart: number;
	offsetEnd: number;
	nextOffset?: number | null;
	messages: TranscriptMessage[];
	authors?: Record<string, MessageAuthor>;
	correlations?: Record<string, Record<string, unknown>>;
	partial?: boolean;
	truncatedBy?: "transport_budget";
	continuationRequest?:
		| { kind: "page"; offset: number }
		| { kind: "result_slice"; result_handle: string; result_cursor: number; result_limit: number };
}

export type ReadTranscriptError =
	| "transcript_unavailable"
	| "invalid_regex"
	| "invalid_params"
	| "compaction_not_found"
	| "INVALID_RESULT_BODY"
	| "INVALID_RESULT_HANDLE"
	| "RESULT_NOT_FOUND"
	| "STALE_RESULT_HANDLE"
	| "INVALID_RESULT_CURSOR"
	| "INVALID_RESULT_LIMIT"
	| "TRANSCRIPT_WORK_LIMIT_EXCEEDED";

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

const RE2_WASM_MODULE_PATH = createRequire(import.meta.url).resolve("re2-wasm");
const SAFE_REGEX_PATTERN_MAX_UNITS = 4096;
const SAFE_REGEX_CHUNK_UNITS = 32 * 1024;
const SAFE_REGEX_MAX_ACTIVE_WORKERS = 2;
const SAFE_REGEX_MAX_QUEUED_JOBS = 4;
const SAFE_REGEX_MAX_QUEUED_CORPUS_UNITS = 32 * 1024 * 1024;
const SAFE_REGEX_WALL_TIMEOUT_MS = 10_000;
const SAFE_REGEX_RESOURCE_LIMITS = {
	maxOldGenerationSizeMb: 64,
	maxYoungGenerationSizeMb: 16,
	stackSizeMb: 4,
} as const;

const SAFE_REGEX_WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const { RE2 } = require(workerData.modulePath);

let matcher;
let segmentChunks;
let segmentMessageIndex;

function post(kind, extra = {}) {
	parentPort.postMessage({ kind, ...extra });
}

parentPort.on("message", (message) => {
	try {
		switch (message && message.kind) {
			case "init":
				try {
					// RE2-WASM requires Unicode mode and rejects lookarounds and
					// backreferences rather than falling back to native RegExp.
					matcher = new RE2(message.pattern, message.caseSensitive ? "u" : "iu");
					post("ready");
				} catch (error) {
					post("invalid_regex", { message: error instanceof Error ? error.message : String(error) });
				}
				break;
			case "segment_start":
				if (!matcher || segmentChunks) throw new Error("invalid segment start");
				segmentMessageIndex = message.messageIndex;
				segmentChunks = [];
				post("segment_started");
				break;
			case "segment_chunk":
				if (!segmentChunks || typeof message.text !== "string") throw new Error("invalid segment chunk");
				segmentChunks.push(message.text);
				post("chunk_accepted");
				break;
			case "segment_end": {
				if (!matcher || !segmentChunks) throw new Error("invalid segment end");
				// Chunking is transport-only: reassemble the exact semantic segment
				// before matching so anchors and repetitions cross chunk boundaries.
				const segment = segmentChunks.join("");
				segmentChunks = undefined;
				matcher.lastIndex = 0;
				const matched = matcher.test(segment);
				post("segment_result", { messageIndex: segmentMessageIndex, matched });
				segmentMessageIndex = undefined;
				break;
			}
			case "finish":
				if (segmentChunks) throw new Error("cannot finish an incomplete segment");
				post("done");
				break;
			default:
				throw new Error("unknown safe regex command");
		}
	} catch (error) {
		segmentChunks = undefined;
		post("worker_error", { message: error instanceof Error ? error.message : String(error) });
	}
});
`;

interface SafeRegexWorkerMessage {
	kind: "ready" | "segment_started" | "chunk_accepted" | "segment_result" | "done" | "invalid_regex" | "worker_error";
	message?: string;
	messageIndex?: number;
	matched?: boolean;
}

export interface SafeRegexWorkerLike {
	postMessage(value: unknown): void;
	on(event: "message", listener: (value: unknown) => void): this;
	on(event: "error", listener: (error: Error) => void): this;
	on(event: "exit", listener: (code: number) => void): this;
	off(event: "message", listener: (value: unknown) => void): this;
	off(event: "error", listener: (error: Error) => void): this;
	off(event: "exit", listener: (code: number) => void): this;
	terminate(): Promise<number>;
}

export type SafeRegexWorkerFactory = (source: string, options: WorkerOptions) => SafeRegexWorkerLike;

export interface SafeRegexClock {
	now(): number;
	setTimer(callback: () => void, delayMs: number): unknown;
	clearTimer(handle: unknown): void;
}

interface SafeRegexSegmentSource {
	messageCount: number;
	/** Conservative UTF-16 corpus retention charged while this job is queued. */
	retainedUnits: number;
	segmentsForMessage(messageIndex: number): Iterable<string>;
}

interface SafeRegexPoolOptions {
	maxActiveWorkers: number;
	maxQueuedJobs: number;
	maxQueuedCorpusUnits: number;
	wallTimeoutMs: number;
	chunkUnits: number;
	resourceLimits: WorkerOptions["resourceLimits"];
	workerFactory: SafeRegexWorkerFactory;
	yieldToEventLoop: () => Promise<void>;
	clock: SafeRegexClock;
}

export type TranscriptRegexSearchFailureCode =
	| "REGEX_SEARCH_OVERLOADED"
	| "REGEX_SEARCH_TIMEOUT"
	| "REGEX_WORKER_FAILED"
	| "REGEX_SEARCH_STOPPED";

/** Stable internal failure codes keep worker isolation faults deterministic. */
export class TranscriptRegexSearchError extends Error {
	readonly code: TranscriptRegexSearchFailureCode;
	constructor(code: TranscriptRegexSearchFailureCode, message: string) {
		super(message);
		this.code = code;
	}
}

function defaultSafeRegexWorkerFactory(source: string, options: WorkerOptions): SafeRegexWorkerLike {
	return new Worker(source, options) as SafeRegexWorkerLike;
}

function defaultYieldToEventLoop(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

const DEFAULT_SAFE_REGEX_CLOCK: SafeRegexClock = {
	now: () => Date.now(),
	setTimer: (callback, delayMs) => {
		const timer = setTimeout(callback, delayMs);
		timer.unref?.();
		return timer;
	},
	clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function isSafeRegexWorkerMessage(value: unknown): value is SafeRegexWorkerMessage {
	if (!value || typeof value !== "object") return false;
	const kind = (value as Record<string, unknown>).kind;
	return kind === "ready" || kind === "segment_started" || kind === "chunk_accepted"
		|| kind === "segment_result" || kind === "done" || kind === "invalid_regex" || kind === "worker_error";
}

interface SafeRegexExecution {
	promise: Promise<number[]>;
	cancel(error: Error): void;
}

/**
 * Start one isolated scan. Only the module path is cloned by the Worker
 * constructor. The parent sends one bounded chunk and waits for its ack before
 * sending another; the worker releases each assembled segment after testing.
 */
function startSafeRegexExecution(
	source: SafeRegexSegmentSource,
	pattern: string,
	caseSensitive: boolean,
	options: SafeRegexPoolOptions,
	wallTimeoutMs: number,
): SafeRegexExecution {
	let cancel = (_error: Error): void => undefined;
	const promise = new Promise<number[]>((resolve, reject) => {
		let worker: SafeRegexWorkerLike;
		try {
			worker = options.workerFactory(SAFE_REGEX_WORKER_SOURCE, {
				eval: true,
				workerData: { modulePath: RE2_WASM_MODULE_PATH },
				resourceLimits: options.resourceLimits,
			});
		} catch (error) {
			reject(new TranscriptRegexSearchError(
				"REGEX_WORKER_FAILED",
				`safe regex worker could not start: ${error instanceof Error ? error.message : String(error)}`,
			));
			return;
		}

		let settled = false;
		let awaiting: { resolve: (message: SafeRegexWorkerMessage) => void; reject: (error: Error) => void } | undefined;
		const matches: number[] = [];
		const timer = options.clock.setTimer(() => {
			finish(new TranscriptRegexSearchError("REGEX_SEARCH_TIMEOUT", "safe regex search exceeded its wall timeout"));
		}, Math.max(1, wallTimeoutMs));

		const onMessage = (value: unknown): void => {
			if (settled) return;
			if (!isSafeRegexWorkerMessage(value)) {
				finish(new TranscriptRegexSearchError("REGEX_WORKER_FAILED", "safe regex worker returned an invalid message"));
				return;
			}
			const waiter = awaiting;
			awaiting = undefined;
			if (!waiter) {
				finish(new TranscriptRegexSearchError("REGEX_WORKER_FAILED", "safe regex worker sent an unexpected message"));
				return;
			}
			waiter.resolve(value);
		};
		const onError = (error: Error): void => {
			finish(new TranscriptRegexSearchError("REGEX_WORKER_FAILED", `safe regex worker failed: ${error.message}`));
		};
		const onExit = (code: number): void => {
			finish(new TranscriptRegexSearchError(
				"REGEX_WORKER_FAILED",
				`safe regex worker exited before completing (code ${code})`,
			));
		};

		const removeProtocolListeners = (): void => {
			worker.off("message", onMessage);
			worker.off("exit", onExit);
		};
		const removeLifecycleErrorSink = (): void => {
			worker.off("error", onError);
		};

		function finish(error?: Error): void {
			if (settled) return;
			settled = true;
			options.clock.clearTimer(timer);
			removeProtocolListeners();
			if (awaiting) {
				const waiter = awaiting;
				awaiting = undefined;
				waiter.reject(error ?? new TranscriptRegexSearchError("REGEX_SEARCH_STOPPED", "safe regex search stopped"));
			}
			let termination: Promise<number>;
			try {
				termination = Promise.resolve(worker.terminate());
			} catch (terminationError) {
				termination = Promise.reject(terminationError);
			}
			// terminate() can race a late OOM/uncaught worker failure. Keep the
			// now-no-op onError listener as a sink until termination fully settles;
			// otherwise EventEmitter would treat that late error as unhandled.
			void termination.then(
				() => {
					removeLifecycleErrorSink();
					error ? reject(error) : resolve(matches);
				},
				(terminationError) => {
					removeLifecycleErrorSink();
					reject(error ?? new TranscriptRegexSearchError(
						"REGEX_WORKER_FAILED",
						`safe regex worker termination failed: ${terminationError instanceof Error ? terminationError.message : String(terminationError)}`,
					));
				},
			);
		}

		cancel = (error: Error): void => finish(error);
		worker.on("message", onMessage);
		worker.on("error", onError);
		worker.on("exit", onExit);

		const exchange = (message: unknown): Promise<SafeRegexWorkerMessage> => {
			if (settled) return Promise.reject(new TranscriptRegexSearchError("REGEX_SEARCH_STOPPED", "safe regex search stopped"));
			if (awaiting) return Promise.reject(new TranscriptRegexSearchError("REGEX_WORKER_FAILED", "safe regex protocol overlapped requests"));
			return new Promise<SafeRegexWorkerMessage>((exchangeResolve, exchangeReject) => {
				awaiting = { resolve: exchangeResolve, reject: exchangeReject };
				try {
					worker.postMessage(message);
				} catch (error) {
					awaiting = undefined;
					exchangeReject(new TranscriptRegexSearchError(
						"REGEX_WORKER_FAILED",
						`safe regex worker transfer failed: ${error instanceof Error ? error.message : String(error)}`,
					));
				}
			});
		};
		const expect = async (message: unknown, expectedKind: SafeRegexWorkerMessage["kind"]): Promise<SafeRegexWorkerMessage> => {
			const response = await exchange(message);
			if (response.kind === "invalid_regex") {
				throw new TranscriptReaderError("invalid_regex", response.message);
			}
			if (response.kind === "worker_error") {
				throw new TranscriptRegexSearchError("REGEX_WORKER_FAILED", response.message ?? "safe regex worker failed");
			}
			if (response.kind !== expectedKind) {
				throw new TranscriptRegexSearchError(
					"REGEX_WORKER_FAILED",
					`safe regex worker protocol expected ${expectedKind}, received ${response.kind}`,
				);
			}
			return response;
		};

		void (async () => {
			try {
				await expect({ kind: "init", pattern, caseSensitive }, "ready");
				for (let messageIndex = 0; messageIndex < source.messageCount; messageIndex++) {
					const segments = source.segmentsForMessage(messageIndex);
					let messageMatched = false;
					for (const segment of segments) {
						await expect({ kind: "segment_start", messageIndex }, "segment_started");
						for (let start = 0; start < segment.length; start += options.chunkUnits) {
							const text = segment.slice(start, start + options.chunkUnits);
							await expect({ kind: "segment_chunk", text }, "chunk_accepted");
							// Yield after every bounded transfer. At most one chunk can be
							// queued in the worker channel at any time.
							await options.yieldToEventLoop();
						}
						const response = await expect({ kind: "segment_end" }, "segment_result");
						if (response.messageIndex !== messageIndex || typeof response.matched !== "boolean") {
							throw new TranscriptRegexSearchError("REGEX_WORKER_FAILED", "safe regex worker returned an invalid segment result");
						}
						if (response.matched) {
							matches.push(messageIndex);
							messageMatched = true;
							break;
						}
					}
					// Empty messages and many tiny segments must also cooperate.
					if (!messageMatched) await options.yieldToEventLoop();
				}
				await expect({ kind: "finish" }, "done");
				finish();
			} catch (error) {
				finish(error instanceof Error ? error : new Error(String(error)));
			}
		})();
	});
	return { promise, cancel: (error) => cancel(error) };
}

interface QueuedSafeRegexJob {
	source: SafeRegexSegmentSource;
	pattern: string;
	caseSensitive: boolean;
	deadline: number;
	queueTimer?: unknown;
	resolve(matches: number[]): void;
	reject(error: Error): void;
}

class SafeRegexWorkerPool {
	private activeWorkers = 0;
	private queuedCorpusUnits = 0;
	private readonly queue: QueuedSafeRegexJob[] = [];
	private readonly active = new Set<{ cancel(error: Error): void }>();
	private stopped = false;

	constructor(private readonly options: SafeRegexPoolOptions) {}

	match(source: SafeRegexSegmentSource, pattern: string, caseSensitive: boolean): Promise<number[]> {
		if (this.stopped) {
			return Promise.reject(new TranscriptRegexSearchError("REGEX_SEARCH_STOPPED", "safe regex worker pool is stopped"));
		}
		if (pattern.length > SAFE_REGEX_PATTERN_MAX_UNITS) {
			return Promise.reject(new TranscriptReaderError(
				"invalid_params",
				`pattern must contain at most ${SAFE_REGEX_PATTERN_MAX_UNITS} UTF-16 units`,
			));
		}
		if (this.activeWorkers >= this.options.maxActiveWorkers
			&& (this.queue.length >= this.options.maxQueuedJobs
				|| source.retainedUnits > this.options.maxQueuedCorpusUnits - this.queuedCorpusUnits)) {
			return Promise.reject(new TranscriptRegexSearchError(
				"REGEX_SEARCH_OVERLOADED",
				"safe regex search capacity is exhausted",
			));
		}
		return new Promise<number[]>((resolve, reject) => {
			const job: QueuedSafeRegexJob = {
				source,
				pattern,
				caseSensitive,
				deadline: this.options.clock.now() + this.options.wallTimeoutMs,
				resolve,
				reject,
			};
			if (this.activeWorkers < this.options.maxActiveWorkers) {
				this.start(job);
				return;
			}
			this.queuedCorpusUnits += source.retainedUnits;
			job.queueTimer = this.options.clock.setTimer(() => this.expireQueued(job), this.options.wallTimeoutMs);
			this.queue.push(job);
		});
	}

	stats(): { activeWorkers: number; queuedJobs: number; queuedCorpusUnits: number } {
		return {
			activeWorkers: this.activeWorkers,
			queuedJobs: this.queue.length,
			queuedCorpusUnits: this.queuedCorpusUnits,
		};
	}

	stop(): void {
		if (this.stopped) return;
		this.stopped = true;
		const error = new TranscriptRegexSearchError("REGEX_SEARCH_STOPPED", "safe regex worker pool stopped");
		for (const job of this.queue.splice(0)) {
			if (job.queueTimer !== undefined) this.options.clock.clearTimer(job.queueTimer);
			job.reject(error);
		}
		this.queuedCorpusUnits = 0;
		for (const execution of this.active) execution.cancel(error);
	}

	private expireQueued(job: QueuedSafeRegexJob): void {
		const position = this.queue.indexOf(job);
		if (position < 0) return;
		this.queue.splice(position, 1);
		this.queuedCorpusUnits -= job.source.retainedUnits;
		job.reject(new TranscriptRegexSearchError("REGEX_SEARCH_TIMEOUT", "safe regex search timed out while queued"));
	}

	private start(job: QueuedSafeRegexJob): void {
		if (job.queueTimer !== undefined) this.options.clock.clearTimer(job.queueTimer);
		this.activeWorkers++;
		const remaining = job.deadline - this.options.clock.now();
		if (remaining <= 0) {
			this.activeWorkers--;
			job.reject(new TranscriptRegexSearchError("REGEX_SEARCH_TIMEOUT", "safe regex search exceeded its wall timeout"));
			this.drain();
			return;
		}
		const execution = startSafeRegexExecution(job.source, job.pattern, job.caseSensitive, this.options, remaining);
		this.active.add(execution);
		void (async () => {
			try {
				job.resolve(await execution.promise);
			} catch (error) {
				job.reject(error instanceof Error ? error : new Error(String(error)));
			} finally {
				this.active.delete(execution);
				this.activeWorkers--;
				this.drain();
			}
		})();
	}

	private drain(): void {
		while (!this.stopped && this.activeWorkers < this.options.maxActiveWorkers && this.queue.length > 0) {
			const job = this.queue.shift()!;
			this.queuedCorpusUnits -= job.source.retainedUnits;
			this.start(job);
		}
	}
}

function safeRegexPoolOptions(overrides: Partial<SafeRegexPoolOptions> = {}): SafeRegexPoolOptions {
	return {
		maxActiveWorkers: SAFE_REGEX_MAX_ACTIVE_WORKERS,
		maxQueuedJobs: SAFE_REGEX_MAX_QUEUED_JOBS,
		maxQueuedCorpusUnits: SAFE_REGEX_MAX_QUEUED_CORPUS_UNITS,
		wallTimeoutMs: SAFE_REGEX_WALL_TIMEOUT_MS,
		chunkUnits: SAFE_REGEX_CHUNK_UNITS,
		resourceLimits: SAFE_REGEX_RESOURCE_LIMITS,
		workerFactory: defaultSafeRegexWorkerFactory,
		yieldToEventLoop: defaultYieldToEventLoop,
		clock: DEFAULT_SAFE_REGEX_CLOCK,
		...overrides,
	};
}

/**
 * readTranscript has no AbortSignal today. If its caller abandons a promise,
 * the global concurrency/queue/resource caps and wall deadline still terminate
 * the work and release its retained corpus without spawning replacement work.
 */
const SAFE_REGEX_POOL = new SafeRegexWorkerPool(safeRegexPoolOptions());

/** Narrow deterministic seam for worker lifecycle and backpressure tests. */
export interface TranscriptRegexPoolTestHarness {
	search(segmentsByMessage: readonly (readonly string[])[], pattern: string, caseSensitive?: boolean, retainedUnits?: number): Promise<number[]>;
	stats(): { activeWorkers: number; queuedJobs: number; queuedCorpusUnits: number };
	stop(): void;
}

export interface TranscriptRegexPoolTestOptions {
	maxActiveWorkers?: number;
	maxQueuedJobs?: number;
	maxQueuedCorpusUnits?: number;
	wallTimeoutMs?: number;
	chunkUnits?: number;
	resourceLimits?: WorkerOptions["resourceLimits"];
	workerFactory?: SafeRegexWorkerFactory;
	yieldToEventLoop?: () => Promise<void>;
	clock?: SafeRegexClock;
}

export function createTranscriptRegexPoolForTests(options: TranscriptRegexPoolTestOptions = {}): TranscriptRegexPoolTestHarness {
	const pool = new SafeRegexWorkerPool(safeRegexPoolOptions(options));
	return {
		search: (segmentsByMessage, pattern, caseSensitive = false, retainedUnits) => pool.match({
			messageCount: segmentsByMessage.length,
			retainedUnits: retainedUnits ?? segmentsByMessage.reduce(
				(total, segments) => total + segments.reduce((messageTotal, segment) => messageTotal + segment.length, 0),
				0,
			),
			segmentsForMessage: (messageIndex) => segmentsByMessage[messageIndex] ?? [],
		}, pattern, caseSensitive),
		stats: () => pool.stats(),
		stop: () => pool.stop(),
	};
}

function expandMatchContext(matches: number[], messageCount: number, context: number): number[] {
	if (context <= 0) return matches.slice();
	const expanded = new Set<number>();
	for (const messageIndex of matches) {
		for (let candidate = Math.max(0, messageIndex - context);
			candidate <= Math.min(messageCount - 1, messageIndex + context);
			candidate++) expanded.add(candidate);
	}
	return [...expanded].sort((a, b) => a - b);
}

async function matchMessageSegments(
	source: SafeRegexSegmentSource,
	pattern: string,
	caseSensitive: boolean,
	context: number,
): Promise<{ matchCount: number; expanded: number[] }> {
	const matches = await SAFE_REGEX_POOL.match(source, pattern, caseSensitive);
	return {
		matchCount: matches.length,
		expanded: expandMatchContext(matches, source.messageCount, context),
	};
}

function estimatedQueuedCorpusUnits(transcriptUnits: number, projectionCopies: number): number {
	return Math.min(Number.MAX_SAFE_INTEGER, transcriptUnits * projectionCopies);
}

async function buildMatchList(
	messages: RawMessage[],
	pattern: string,
	caseSensitive: boolean,
	context: number,
	transcriptUnits: number,
): Promise<{ matchCount: number; expanded: number[] }> {
	return await matchMessageSegments({
		messageCount: messages.length,
		retainedUnits: estimatedQueuedCorpusUnits(transcriptUnits, 2),
		segmentsForMessage: (messageIndex) => {
			const message = messages[messageIndex];
			return [isMessageLevelToolResult(message)
				? flattenText([messageLevelToolResultBlock(message)])
				: flattenText(message.content)];
		},
	}, pattern, caseSensitive, context);
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
			// Compact rendering, verbose rendering, and regex filtering all read
			// RawMessage.content. Keep it synchronized with the digest-gated
			// sidecar projection performed on fullMessage above.
			content: fullMessage.content,
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

export interface TranscriptProjectionWorkMetricsForTests {
	callArgumentsCanonicalized: number;
	resultBodiesCanonicalized: number;
	resultBodiesHashed: number;
	canonicalResultUnits: number;
	/** Cumulative charged raw input, semantic scans, and bounded output-copy work. */
	canonicalTextWorkUnits: number;
	/** Raw JSONL units reserved before parsing or author projection. */
	rawTranscriptWorkUnits: number;
	canonicalInputWorkUnits: number;
	indexStringWorkUnits: number;
	projectedStringWorkUnits: number;
	operationWorkUnits: number;
	indexedResults: number;
	currentRetainedCanonicalCallUnits: number;
	currentRetainedCanonicalResultUnits: number;
	currentRetainedDetachedUnits: number;
	peakRetainedCanonicalResultUnits: number;
	peakRetainedTotalUnits: number;
	detachedArgumentPreviewUnits: number;
	detachedResultExcerptUnits: number;
	detachedVisibleTextUnits: number;
	detachedThinkingUnits: number;
	detachedMetadataUnits: number;
}

/** Deterministic instrumentation seam; production callers do not need this. */
export function createTranscriptProjectionWorkMetricsForTests(): TranscriptProjectionWorkMetricsForTests {
	return {
		callArgumentsCanonicalized: 0,
		resultBodiesCanonicalized: 0,
		resultBodiesHashed: 0,
		canonicalResultUnits: 0,
		canonicalTextWorkUnits: 0,
		rawTranscriptWorkUnits: 0,
		canonicalInputWorkUnits: 0,
		indexStringWorkUnits: 0,
		projectedStringWorkUnits: 0,
		operationWorkUnits: 0,
		indexedResults: 0,
		currentRetainedCanonicalCallUnits: 0,
		currentRetainedCanonicalResultUnits: 0,
		currentRetainedDetachedUnits: 0,
		peakRetainedCanonicalResultUnits: 0,
		peakRetainedTotalUnits: 0,
		detachedArgumentPreviewUnits: 0,
		detachedResultExcerptUnits: 0,
		detachedVisibleTextUnits: 0,
		detachedThinkingUnits: 0,
		detachedMetadataUnits: 0,
	};
}

export interface ReadTranscriptOptions {
	/** Async loader returning the raw JSONL contents. */
	readContent: () => Promise<string | null>;
	/** Optional session and sidecar context for precise agent/system attribution. */
	authorContext?: TranscriptAuthorResolutionContext;
	/** Legacy/direct projection remains the compatibility default. */
	projection?: "legacy" | "agent";
	/** Target session identity used to bind agent result handles. */
	sessionId?: string;
	/** Agent envelope ceiling. The default is the 50 KiB tool transport ceiling. */
	serializedBudgetBytes?: number;
	/** Test-only counters for proving lazy agent projection work. */
	workMetricsForTests?: TranscriptProjectionWorkMetricsForTests;
	/** Test-only request bounds; production always uses the exported defaults. */
	projectionWorkLimitsForTests?: Partial<TranscriptProjectionRequestWorkLimits>;
	/** Test-only reservation pool for deterministic concurrency coverage. */
	workReservationPoolForTests?: TranscriptProjectionReservationPool;
	/** Test-only pause/observer after raw reservation and before JSONL parsing. */
	beforeAgentParseForTests?: () => void | Promise<void>;
}

/**
 * Project a raw Pi transcript for extension-facing adapters without mutating the
 * on-disk JSONL. Correlation runs over the complete message sequence before any
 * line is rewritten, preserving duplicate-occurrence ordering. Only visible
 * content is copied back: private author metadata and correlation fields never
 * cross the extension boundary.
 */
export async function projectOwnTranscriptJsonl(
	sessionId: string,
	jsonl: string | null,
	context: Omit<TranscriptAuthorResolutionContext, "sidecarEntries"> = {},
): Promise<string | null> {
	if (jsonl === null || jsonl === "") return jsonl;

	const lines = jsonl.split(/\r?\n/);
	const parsed = new Map<number, Record<string, unknown>>();
	const rows: Array<Record<string, unknown>> = [];
	const lineIndexes: number[] = [];
	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const line = lines[lineIndex].trim();
		if (!line) continue;
		let envelope: Record<string, unknown>;
		try {
			const candidate = JSON.parse(line) as unknown;
			if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
			envelope = candidate as Record<string, unknown>;
		} catch {
			continue;
		}
		const wrapped = envelope.message;
		if (!wrapped || typeof wrapped !== "object" || Array.isArray(wrapped)) continue;
		const { author: _untrustedAuthor, ...message } = wrapped as Record<string, unknown>;
		rows.push({
			...message,
			...(typeof envelope.id === "string" ? { entryId: envelope.id } : {}),
			...(envelope.ts !== undefined ? { ts: envelope.ts } : {}),
			...(envelope.timestamp !== undefined && message.timestamp === undefined
				? { timestamp: envelope.timestamp }
				: {}),
		});
		parsed.set(lineIndex, envelope);
		lineIndexes.push(lineIndex);
	}
	if (rows.length === 0) return jsonl;

	const projected = mergeAuthorSidecarIntoMessages(
		readAuthorSidecar(sessionId),
		rows,
		{
			...context,
			session: context.session ?? { id: sessionId },
		},
	);
	for (let index = 0; index < projected.length; index++) {
		const lineIndex = lineIndexes[index];
		const envelope = parsed.get(lineIndex);
		if (!envelope) continue;
		const wrapped = envelope.message as Record<string, unknown>;
		const { author: _author, entryId: _entryId, ts: _ts, ...visible } = projected[index];
		// Keep Pi-owned message metadata byte-equivalent at the object level and
		// replace only projected content. Any transcript-supplied author is removed.
		const { author: _rawAuthor, ...rawWithoutAuthor } = wrapped;
		envelope.message = {
			...rawWithoutAuthor,
			...(Object.prototype.hasOwnProperty.call(visible, "content")
				? { content: visible.content }
				: {}),
		};
		lines[lineIndex] = JSON.stringify(envelope);
	}
	return lines.join("\n");
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

// ── Canonical agent projection ──

export const READ_SESSION_AGENT_ENVELOPE_MAX_BYTES = 50 * 1024;
/**
 * A canonical targeted-slice envelope has roughly 700 bytes of fixed schema,
 * while a 128-unit tool name can require another 768 bytes after JSON escaping.
 * 1536 bytes therefore preserves the full result identity and metrics even for
 * the adversarial all-control-character name pinned by the minimum-budget test.
 */
export const READ_SESSION_AGENT_ENVELOPE_MIN_BYTES = 1536;
const AGENT_ARGUMENT_PREVIEW_LIMIT = 512;
const AGENT_RESULT_EXCERPT_DEFAULT = 4096;
const AGENT_RESULT_EXCERPT_MAX = 8192;
const AGENT_COMPACT_TEXT_LIMIT = 800;
const AGENT_VERBOSE_TEXT_LIMIT = 4096;
const AGENT_THINKING_LIMIT = 512;
const AGENT_ROLE_LIMIT = 32;
const AGENT_TIMESTAMP_LIMIT = 64;
const AGENT_TOOL_NAME_LIMIT = 128;
const RESULT_HANDLE_DOMAIN = "bobbit.read-session.result-handle.v1\0";

export interface TranscriptProjectionRequestWorkLimits {
	maxOperations: number;
	maxResults: number;
	maxTextUnits: number;
}

export interface TranscriptProjectionReservationPoolLimits extends TranscriptProjectionRequestWorkLimits {
	maxRequests: number;
}

export interface TranscriptProjectionReservationPoolStats {
	activeRequests: number;
	reservedOperations: number;
	reservedResults: number;
	reservedTextUnits: number;
}

interface TranscriptProjectionReservationDelta {
	operations?: number;
	results?: number;
	textUnits?: number;
}

interface TranscriptProjectionReservation {
	reserve(delta: TranscriptProjectionReservationDelta): void;
	release(delta: TranscriptProjectionReservationDelta): void;
	close(): void;
}

export interface TranscriptProjectionReservationPool {
	acquire(): TranscriptProjectionReservation;
	stats(): TranscriptProjectionReservationPoolStats;
}

export const READ_SESSION_AGENT_WORK_LIMITS = Object.freeze({
	request: Object.freeze({
		maxOperations: 128 * 1024,
		maxResults: 16 * 1024,
		maxTextUnits: 32 * 1024 * 1024,
	}),
	global: Object.freeze({
		maxRequests: 8,
		maxOperations: 256 * 1024,
		maxResults: 32 * 1024,
		maxTextUnits: 64 * 1024 * 1024,
	}),
});

function checkedReservationUnits(value: number): number {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new TranscriptReaderError("TRANSCRIPT_WORK_LIMIT_EXCEEDED", "transcript work reservation is invalid");
	}
	return value;
}

class BoundedTranscriptProjectionReservationPool implements TranscriptProjectionReservationPool {
	private activeRequests = 0;
	private reservedOperations = 0;
	private reservedResults = 0;
	private reservedTextUnits = 0;

	constructor(private readonly limits: TranscriptProjectionReservationPoolLimits) {}

	acquire(): TranscriptProjectionReservation {
		if (this.activeRequests >= this.limits.maxRequests) {
			throw new TranscriptReaderError(
				"TRANSCRIPT_WORK_LIMIT_EXCEEDED",
				"concurrent transcript projection capacity is exhausted",
			);
		}
		this.activeRequests++;
		let operations = 0;
		let results = 0;
		let textUnits = 0;
		let closed = false;
		const adjust = (delta: TranscriptProjectionReservationDelta, direction: 1 | -1): void => {
			if (closed) throw new Error("transcript projection reservation is closed");
			const operationDelta = checkedReservationUnits(delta.operations ?? 0) * direction;
			const resultDelta = checkedReservationUnits(delta.results ?? 0) * direction;
			const textDelta = checkedReservationUnits(delta.textUnits ?? 0) * direction;
			if (direction === 1 && (
				operationDelta > this.limits.maxOperations - this.reservedOperations
				|| resultDelta > this.limits.maxResults - this.reservedResults
				|| textDelta > this.limits.maxTextUnits - this.reservedTextUnits
			)) {
				throw new TranscriptReaderError(
					"TRANSCRIPT_WORK_LIMIT_EXCEEDED",
					"concurrent transcript projection work exceeds the global reservation limit",
				);
			}
			if (direction === -1 && (-operationDelta > operations || -resultDelta > results || -textDelta > textUnits)) {
				throw new Error("transcript projection reservation underflow");
			}
			operations += operationDelta;
			results += resultDelta;
			textUnits += textDelta;
			this.reservedOperations += operationDelta;
			this.reservedResults += resultDelta;
			this.reservedTextUnits += textDelta;
		};
		return {
			reserve: (delta) => adjust(delta, 1),
			release: (delta) => adjust(delta, -1),
			close: () => {
				if (closed) return;
				this.reservedOperations -= operations;
				this.reservedResults -= results;
				this.reservedTextUnits -= textUnits;
				this.activeRequests--;
				closed = true;
			},
		};
	}

	stats(): TranscriptProjectionReservationPoolStats {
		return {
			activeRequests: this.activeRequests,
			reservedOperations: this.reservedOperations,
			reservedResults: this.reservedResults,
			reservedTextUnits: this.reservedTextUnits,
		};
	}
}

function validatedProjectionReservationPoolLimits(
	limits: TranscriptProjectionReservationPoolLimits,
): TranscriptProjectionReservationPoolLimits {
	for (const [name, value] of Object.entries(limits)) {
		if (!Number.isSafeInteger(value) || value < 1) {
			throw new Error(`${name} must be a positive safe integer`);
		}
	}
	return limits;
}

/** Deterministic seam for simultaneous in-flight reservation tests. */
export function createTranscriptProjectionReservationPoolForTests(
	limits: TranscriptProjectionReservationPoolLimits,
): TranscriptProjectionReservationPool {
	return new BoundedTranscriptProjectionReservationPool(validatedProjectionReservationPoolLimits(limits));
}

const AGENT_PROJECTION_RESERVATION_POOL = new BoundedTranscriptProjectionReservationPool(
	READ_SESSION_AGENT_WORK_LIMITS.global,
);

/** Lightweight call locator. Potentially large arguments remain in the raw block. */
interface IndexedCall {
	messageIndex: number;
	blockIndex: number;
	block: Record<string, unknown>;
	/** Detached, bounded display name. */
	name: string;
}

/** Lightweight result locator. The canonical body is deliberately not retained here. */
interface IndexedResult {
	messageIndex: number;
	blockIndex: number;
	direct: Record<string, unknown>;
	message: Record<string, unknown>;
	correlatedCall?: IndexedCall;
	/** Detached, bounded display name. */
	name: string;
	status: ToolResultStatus;
}

interface MaterializedResult {
	indexed: IndexedResult;
	body: string;
	size: ToolResultSize;
	handle: string;
}

interface TranscriptStructureIndex {
	callsByMessage: Map<number, IndexedCall[]>;
	resultsByMessage: Map<number, IndexedResult[]>;
	resultByLocation: Map<string, IndexedResult>;
}

const INDEX_CORRELATION_INLINE_LIMIT = 256;
const INDEX_CORRELATION_DOMAIN = "bobbit.read-session.correlation-key.v1\0";

function ownNonEmptyString(source: Record<string, unknown>, key: string): string | undefined {
	if (!Object.prototype.hasOwnProperty.call(source, key)) return undefined;
	const value = source[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function detachedIndexString(value: string, limit: number): string {
	const end = scalarPrefixEnd(value, 0, limit);
	return detachedStringSlice(value, 0, end);
}

function normalizedCorrelationKey(value: string, work?: AgentProjectionWorkTracker): string | undefined {
	if (work) return work.correlationKey(value);
	if (!isWellFormedUnicode(value)) return undefined;
	if (value.length <= INDEX_CORRELATION_INLINE_LIMIT) {
		return `i:${detachedIndexString(value, INDEX_CORRELATION_INLINE_LIMIT)}`;
	}
	return `h:${createHash("sha256").update(INDEX_CORRELATION_DOMAIN).update(value, "utf8").digest("hex")}`;
}

function boundedIndexName(value: string, work?: AgentProjectionWorkTracker): string | undefined {
	if (work) return work.indexDisplayString(value, AGENT_TOOL_NAME_LIMIT);
	if (!isWellFormedUnicode(value)) return undefined;
	return detachedIndexString(value, AGENT_TOOL_NAME_LIMIT);
}

function firstCorrelationKey(
	source: Record<string, unknown>,
	keys: readonly string[],
	work?: AgentProjectionWorkTracker,
): string | undefined {
	for (const key of keys) {
		const value = ownNonEmptyString(source, key);
		if (value === undefined) continue;
		const normalized = normalizedCorrelationKey(value, work);
		if (normalized !== undefined) return normalized;
	}
	return undefined;
}

function firstIndexName(
	source: Record<string, unknown>,
	keys: readonly string[],
	work?: AgentProjectionWorkTracker,
): string | undefined {
	for (const key of keys) {
		const value = ownNonEmptyString(source, key);
		if (value === undefined) continue;
		const bounded = boundedIndexName(value, work);
		if (bounded !== undefined) return bounded;
	}
	return undefined;
}

function canonicalCallId(call: Record<string, unknown>, work?: AgentProjectionWorkTracker): string | undefined {
	return firstCorrelationKey(call, ["id", "toolCallId", "tool_call_id", "toolUseId", "tool_use_id"], work);
}

function canonicalCallName(call: Record<string, unknown>, work?: AgentProjectionWorkTracker): string {
	return firstIndexName(call, ["name", "toolName"], work) ?? "unknown";
}

function canonicalCallSearchName(call: IndexedCall, work: AgentProjectionWorkTracker): string {
	for (const key of ["name", "toolName"] as const) {
		const value = ownNonEmptyString(call.block, key);
		if (value !== undefined && work.inspectProjectedString(value)) return value;
	}
	return "unknown";
}

function canonicalResultCorrelationId(
	direct: Record<string, unknown>,
	message: Record<string, unknown>,
	messageLevel: boolean,
	work?: AgentProjectionWorkTracker,
): string | undefined {
	const aliases = ["tool_use_id", "toolUseId", "toolCallId", "tool_call_id"] as const;
	const directAlias = firstCorrelationKey(direct, aliases, work);
	if (directAlias) return directAlias;
	if (!messageLevel) {
		const messageAlias = firstCorrelationKey(message, aliases, work);
		if (messageAlias) return messageAlias;
	}
	if ((direct.type === "tool_result" || direct.type === "toolResult")) {
		return firstCorrelationKey(direct, ["id"], work);
	}
	return undefined;
}

function canonicalResultName(
	direct: Record<string, unknown>,
	message: Record<string, unknown>,
	messageLevel: boolean,
	call?: IndexedCall,
	work?: AgentProjectionWorkTracker,
): string {
	return firstIndexName(direct, ["name", "toolName"], work)
		?? (!messageLevel ? firstIndexName(message, ["name", "toolName"], work) : undefined)
		?? call?.name
		?? "unknown";
}

function validStatusCandidate(source: Record<string, unknown>): ToolResultStatus | undefined {
	if (Object.prototype.hasOwnProperty.call(source, "status")) {
		const status = source.status;
		if (status === "ok" || status === "error" || status === "unknown") return status;
	}
	for (const key of ["isError", "is_error"] as const) {
		if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
		if (typeof source[key] === "boolean") return source[key] ? "error" : "ok";
	}
	return undefined;
}

function canonicalResultStatus(
	direct: Record<string, unknown>,
	message: Record<string, unknown>,
	messageLevel: boolean,
): ToolResultStatus {
	return validStatusCandidate(direct)
		?? (!messageLevel ? validStatusCandidate(message) : undefined)
		?? "unknown";
}

function* visibleTextSegments(message: RawMessage): Iterable<string> {
	if (isMessageLevelToolResult(message)) return;
	if (typeof message.content === "string") {
		yield message.content;
		return;
	}
	if (!Array.isArray(message.content)) return;
	for (const candidate of message.content) {
		if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
		const block = candidate as Record<string, unknown>;
		if (isToolResultBlock(block)) continue;
		if (block.type === "text" && typeof block.text === "string") yield block.text;
	}
}

function* thinkingSegments(message: RawMessage): Iterable<string> {
	if (!Array.isArray(message.content)) return;
	for (const candidate of message.content) {
		if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
		const block = candidate as Record<string, unknown>;
		if (block.type !== "thinking" && block.type !== "reasoning") continue;
		const value = typeof block.thinking === "string" ? block.thinking
			: typeof block.text === "string" ? block.text
			: undefined;
		if (value !== undefined) yield value;
	}
}

function u32(value: number): Buffer {
	const buffer = Buffer.allocUnsafe(4);
	buffer.writeUInt32BE(value, 0);
	return buffer;
}

function u64(value: number): Buffer {
	const buffer = Buffer.allocUnsafe(8);
	buffer.writeBigUInt64BE(BigInt(value), 0);
	return buffer;
}

/** Stable, content-bound handle for a canonical tool result body. */
export function createTranscriptResultHandle(
	sessionId: string,
	messageIndex: number,
	blockIndex: number,
	canonicalBody: string,
): string {
	if (!isWellFormedUnicode(sessionId) || !isWellFormedUnicode(canonicalBody)) {
		throw new TranscriptReaderError("INVALID_RESULT_BODY", "result handle input contains invalid Unicode");
	}
	if (!Number.isSafeInteger(messageIndex) || messageIndex < 0
		|| !Number.isInteger(blockIndex) || blockIndex < 0 || blockIndex > 0xffff_ffff) {
		throw new TranscriptReaderError("INVALID_RESULT_BODY", "result handle location is invalid");
	}
	const sessionBytes = Buffer.from(sessionId, "utf8");
	const bodyBytes = Buffer.from(canonicalBody, "utf8");
	const hash = createHash("sha256");
	hash.update(Buffer.from(RESULT_HANDLE_DOMAIN, "utf8"));
	hash.update(u32(sessionBytes.length));
	hash.update(sessionBytes);
	hash.update(u64(messageIndex));
	hash.update(u32(blockIndex));
	hash.update(u64(bodyBytes.length));
	hash.update(bodyBytes);
	const suffix = hash.digest().subarray(0, 20).toString("base64url");
	return `rs1:m${messageIndex.toString(36)}:b${blockIndex.toString(36)}:${suffix}`;
}

function resultLocationKey(messageIndex: number, blockIndex: number): string {
	return `${messageIndex}:${blockIndex}`;
}

export interface TranscriptCorrelationOperations {
	callUpdates: number;
	resultLookups: number;
}

function buildTranscriptStructureIndex(
	messages: RawMessage[],
	operations?: TranscriptCorrelationOperations,
	work?: AgentProjectionWorkTracker,
): TranscriptStructureIndex {
	const callsByMessage = new Map<number, IndexedCall[]>();
	const resultsByMessage = new Map<number, IndexedResult[]>();
	const resultByLocation = new Map<string, IndexedResult>();
	const latestCallById = new Map<string, IndexedCall>();

	const indexCall = (message: RawMessage, block: Record<string, unknown>, blockIndex: number): void => {
		const id = canonicalCallId(block, work);
		const call: IndexedCall = {
			messageIndex: message.index,
			blockIndex,
			block,
			name: canonicalCallName(block, work),
		};
		const messageCalls = callsByMessage.get(message.index) ?? [];
		messageCalls.push(call);
		callsByMessage.set(message.index, messageCalls);
		if (id) {
			// Hash/bound the provider ID, but retain the same forward overwrite
			// semantics so duplicate IDs still resolve to the nearest call.
			latestCallById.set(id, call);
			if (operations) operations.callUpdates++;
		}
	};

	const indexResult = (
		message: RawMessage,
		direct: Record<string, unknown>,
		blockIndex: number,
		messageLevel: boolean,
	): void => {
		work?.indexResult();
		const correlationId = canonicalResultCorrelationId(direct, message.fullMessage, messageLevel, work);
		const correlatedCall = correlationId ? latestCallById.get(correlationId) : undefined;
		if (correlationId && operations) operations.resultLookups++;
		const result: IndexedResult = {
			messageIndex: message.index,
			blockIndex,
			direct,
			message: message.fullMessage,
			...(correlatedCall ? { correlatedCall } : {}),
			name: canonicalResultName(direct, message.fullMessage, messageLevel, correlatedCall, work),
			status: canonicalResultStatus(direct, message.fullMessage, messageLevel),
		};
		const messageResults = resultsByMessage.get(message.index) ?? [];
		messageResults.push(result);
		resultsByMessage.set(message.index, messageResults);
		resultByLocation.set(resultLocationKey(message.index, blockIndex), result);
	};

	for (const message of messages) {
		work?.recordOperations();
		const messageLevelResult = isMessageLevelToolResult(message);
		// A message-level result has the synthetic location (messageIndex, 0),
		// so no content block in the same message can precede it. Index it before
		// walking content, while retaining any unusual call blocks for later rows.
		if (messageLevelResult) indexResult(message, message.fullMessage, 0, true);
		if (!Array.isArray(message.content)) continue;
		for (let blockIndex = 0; blockIndex < message.content.length; blockIndex++) {
			work?.recordOperations();
			const candidate = message.content[blockIndex];
			if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
			const block = candidate as Record<string, unknown>;
			// A malformed hybrid call/result block cannot correlate to itself: a
			// same-message call precedes a result only when its block index is lower.
			if (!messageLevelResult && isToolResultBlock(block)) indexResult(message, block, blockIndex, false);
			if (block.type === "tool_use" || block.type === "toolCall") indexCall(message, block, blockIndex);
		}
	}

	return { callsByMessage, resultsByMessage, resultByLocation };
}

/** Deterministic test-only instrumentation for correlation-index growth. */
export function measureTranscriptCorrelationOperationsForTests(jsonl: string): TranscriptCorrelationOperations {
	const operations: TranscriptCorrelationOperations = { callUpdates: 0, resultLookups: 0 };
	buildTranscriptStructureIndex(parseJsonl(jsonl), operations);
	return operations;
}

const CANONICAL_BODY_KEYS = ["content", "output", "result"] as const;
const CANONICAL_OPAQUE_BLOCK_TYPES = new Set(["image", "audio", "video", "file", "attachment", "binary"]);
const CANONICAL_INPUT_MAX_DEPTH = 512;

function firstOwnDefinedValue(source: Record<string, unknown>, keys: readonly string[]): { found: boolean; value: unknown } {
	for (const key of keys) {
		if (Object.prototype.hasOwnProperty.call(source, key) && source[key] !== undefined) {
			return { found: true, value: source[key] };
		}
	}
	return { found: false, value: undefined };
}

class CanonicalInputWorkBudget {
	private used = 0;
	private readonly ancestors = new Set<object>();

	constructor(
		private readonly limit: number,
		private readonly recordOperation: () => void,
	) {}

	get estimatedUnits(): number {
		return this.used;
	}

	private add(units: number): void {
		if (!Number.isSafeInteger(units) || units < 0 || units > this.limit - this.used) {
			throw new TranscriptReaderError(
				"TRANSCRIPT_WORK_LIMIT_EXCEEDED",
				"canonical transcript input exceeds the cumulative text work limit",
			);
		}
		this.used += units;
	}

	private enter(value: object, depth: number): void {
		if (depth > CANONICAL_INPUT_MAX_DEPTH) {
			throw new TranscriptReaderError("TRANSCRIPT_WORK_LIMIT_EXCEEDED", "canonical transcript input is nested too deeply");
		}
		if (this.ancestors.has(value)) throw new CanonicalTranscriptValueError("cyclic transcript JSON value");
		this.ancestors.add(value);
	}

	private leave(value: object): void {
		this.ancestors.delete(value);
	}

	private primitiveStableJson(value: unknown): boolean {
		if (value === null) {
			this.add(4);
			return true;
		}
		switch (typeof value) {
			case "string":
				// JSON escaping can expand one UTF-16 unit to a six-unit \\u00XX form.
				this.add(value.length * 6 + 2);
				return true;
			case "boolean":
				this.add(value ? 4 : 5);
				return true;
			case "number": {
				if (!Number.isFinite(value)) throw new CanonicalTranscriptValueError("non-finite number is not valid transcript JSON");
				const encoded = JSON.stringify(value);
				this.add(encoded.length);
				return true;
			}
			case "undefined":
			case "function":
			case "symbol":
			case "bigint":
				throw new CanonicalTranscriptValueError(`unsupported transcript JSON value: ${typeof value}`);
			default:
				return false;
		}
	}

	stableJson(value: unknown, depth = 0): void {
		this.recordOperation();
		if (this.primitiveStableJson(value)) return;
		if (value === null || typeof value !== "object") throw new CanonicalTranscriptValueError("unsupported transcript JSON value");
		this.enter(value, depth);
		try {
			if (Array.isArray(value)) {
				this.add(value.length === 0 ? 2 : value.length + 1);
				for (let index = 0; index < value.length; index++) {
					if (!Object.prototype.hasOwnProperty.call(value, index)) {
						throw new CanonicalTranscriptValueError("sparse transcript JSON array");
					}
					this.stableJson(value[index], depth + 1);
				}
				return;
			}
			const record = value as Record<string, unknown>;
			const keys = Object.keys(record);
			this.add(keys.length === 0 ? 2 : keys.length * 2 + 1);
			for (const key of keys) {
				this.add(key.length * 6 + 2);
				this.stableJson(record[key], depth + 1);
			}
		} finally {
			this.leave(value);
		}
	}

	canonicalResultValue(value: unknown, depth = 0): void {
		this.recordOperation();
		if (typeof value === "string") {
			this.add(value.length);
			return;
		}
		if (value === null) return;
		if (typeof value !== "object") {
			this.primitiveStableJson(value);
			return;
		}
		this.enter(value as object, depth);
		try {
			if (Array.isArray(value)) {
				for (let index = 0; index < value.length; index++) {
					if (!Object.prototype.hasOwnProperty.call(value, index)) {
						throw new CanonicalTranscriptValueError("sparse tool result array");
					}
					this.canonicalResultValue(value[index], depth + 1);
				}
				return;
			}
			const block = value as Record<string, unknown>;
			if (block.type === "text" && typeof block.text === "string") {
				this.add(block.text.length);
				return;
			}
			if (typeof block.type === "string" && CANONICAL_OPAQUE_BLOCK_TYPES.has(block.type)) {
				const payload = firstOwnDefinedValue(block, ["data", "base64", "bytes", "content"]);
				if (payload.found) {
					if (typeof payload.value === "string") this.add(payload.value.length);
					else this.stableJson(payload.value, depth + 1);
				}
				// opaqueSummary validates and bounds mimeType independently from the
				// payload. Charge that provider metadata scan as input work too.
				if (Object.prototype.hasOwnProperty.call(block, "mimeType") && typeof block.mimeType === "string") {
					this.add(block.mimeType.length);
				}
				this.add(512);
				return;
			}
			const carrier = firstOwnDefinedValue(block, CANONICAL_BODY_KEYS);
			if (carrier.found) {
				this.canonicalResultValue(carrier.value, depth + 1);
				return;
			}
			// stableJson owns its own ancestor scope. Leave the canonical carrier
			// scope first so an ordinary object is not mistaken for a self-cycle.
			this.leave(value);
			this.stableJson(block, depth + 1);
		} finally {
			this.leave(value);
		}
	}
}

function assertCallCanonicalizationWithinLimit(
	call: IndexedCall,
	limit: number,
	recordOperation: () => void,
): number {
	const selected = firstOwnDefinedValue(call.block, ["arguments", "input"]);
	if (!selected.found) return 0;
	const budget = new CanonicalInputWorkBudget(limit, recordOperation);
	if (typeof selected.value === "string") budget.canonicalResultValue(selected.value);
	else budget.stableJson(selected.value);
	return budget.estimatedUnits;
}

function assertResultCanonicalizationWithinLimit(
	result: IndexedResult,
	limit: number,
	recordOperation: () => void,
): number {
	const selected = firstOwnDefinedValue(result.direct, CANONICAL_BODY_KEYS);
	if (!selected.found) return 0;
	const budget = new CanonicalInputWorkBudget(limit, recordOperation);
	budget.canonicalResultValue(selected.value);
	return budget.estimatedUnits;
}

type DetachedStringKind = "argument" | "result" | "visible" | "thinking" | "metadata";
type TextWorkKind = "raw" | "canonical" | "index" | "projected";

class AgentProjectionWorkTracker {
	private operationWorkUnits = 0;
	private indexedResults = 0;
	/** Cumulative input scans and bounded copy work. Never released before close. */
	private textWorkUnits = 0;
	private retainedResultUnits = 0;
	private retainedCallUnits = 0;
	private retainedDetachedUnits = 0;
	private closed = false;
	private readonly reservation: TranscriptProjectionReservation;

	constructor(
		readonly metrics?: TranscriptProjectionWorkMetricsForTests,
		private readonly limits: TranscriptProjectionRequestWorkLimits = READ_SESSION_AGENT_WORK_LIMITS.request,
		pool: TranscriptProjectionReservationPool = AGENT_PROJECTION_RESERVATION_POOL,
	) {
		this.reservation = pool.acquire();
	}

	private assertOpen(): void {
		if (this.closed) throw new Error("transcript projection work tracker is closed");
	}

	private retainedTextUnits(): number {
		return this.retainedCallUnits + this.retainedResultUnits + this.retainedDetachedUnits;
	}

	private updateRetainedMetrics(): void {
		if (!this.metrics) return;
		this.metrics.currentRetainedCanonicalCallUnits = this.retainedCallUnits;
		this.metrics.currentRetainedCanonicalResultUnits = this.retainedResultUnits;
		this.metrics.currentRetainedDetachedUnits = this.retainedDetachedUnits;
		this.metrics.peakRetainedCanonicalResultUnits = Math.max(
			this.metrics.peakRetainedCanonicalResultUnits,
			this.retainedResultUnits,
		);
		this.metrics.peakRetainedTotalUnits = Math.max(
			this.metrics.peakRetainedTotalUnits,
			this.retainedTextUnits(),
		);
	}

	recordOperations(units = 1): void {
		this.assertOpen();
		if (!Number.isSafeInteger(units) || units < 0 || units > this.limits.maxOperations - this.operationWorkUnits) {
			throw new TranscriptReaderError(
				"TRANSCRIPT_WORK_LIMIT_EXCEEDED",
				"transcript projection exceeds the cumulative operation work limit",
			);
		}
		this.reservation.reserve({ operations: units });
		this.operationWorkUnits += units;
		if (this.metrics) this.metrics.operationWorkUnits = this.operationWorkUnits;
	}

	indexResult(): void {
		this.recordOperations();
		if (this.indexedResults >= this.limits.maxResults) {
			throw new TranscriptReaderError(
				"TRANSCRIPT_WORK_LIMIT_EXCEEDED",
				"transcript projection exceeds the cumulative result count limit",
			);
		}
		this.reservation.reserve({ results: 1 });
		this.indexedResults++;
		if (this.metrics) this.metrics.indexedResults = this.indexedResults;
	}

	private remainingTextWorkUnits(): number {
		return this.limits.maxTextUnits - this.textWorkUnits - this.retainedTextUnits();
	}

	private chargeTextWork(units: number, kind: TextWorkKind): void {
		this.assertOpen();
		if (!Number.isSafeInteger(units) || units < 0 || units > this.remainingTextWorkUnits()) {
			throw new TranscriptReaderError(
				"TRANSCRIPT_WORK_LIMIT_EXCEEDED",
				"transcript projection exceeds the cumulative text work limit",
			);
		}
		this.reservation.reserve({ textUnits: units });
		this.textWorkUnits += units;
		if (this.metrics) {
			this.metrics.canonicalTextWorkUnits = this.textWorkUnits;
			if (kind === "raw") this.metrics.rawTranscriptWorkUnits += units;
			else if (kind === "canonical") this.metrics.canonicalInputWorkUnits += units;
			else if (kind === "index") this.metrics.indexStringWorkUnits += units;
			else this.metrics.projectedStringWorkUnits += units;
		}
	}

	/** Reserve the complete provider JSONL before it is split, parsed, or cloned. */
	chargeRawTranscript(value: string): void {
		this.chargeTextWork(value.length, "raw");
	}

	private retainText(units: number, kind: "call" | "result" | "detached"): void {
		if (!Number.isSafeInteger(units) || units < 0 || units > this.remainingTextWorkUnits()) {
			throw new TranscriptReaderError(
				"TRANSCRIPT_WORK_LIMIT_EXCEEDED",
				"transcript projection retained text exceeds the request limit",
			);
		}
		this.reservation.reserve({ textUnits: units });
		if (kind === "call") this.retainedCallUnits += units;
		else if (kind === "result") this.retainedResultUnits += units;
		else this.retainedDetachedUnits += units;
		this.updateRetainedMetrics();
	}

	/** Validate and charge a provider string before it is searched or projected. */
	inspectProjectedString(value: string): boolean {
		this.chargeTextWork(value.length, "projected");
		return isWellFormedUnicode(value);
	}

	/** Bounded, content-preserving key for full-transcript call correlation. */
	correlationKey(value: string): string | undefined {
		this.chargeTextWork(value.length, "index");
		if (!isWellFormedUnicode(value)) return undefined;
		let key: string;
		if (value.length <= INDEX_CORRELATION_INLINE_LIMIT) {
			key = `i:${detachedIndexString(value, INDEX_CORRELATION_INLINE_LIMIT)}`;
		} else {
			// Unicode validation and hashing are separate linear passes.
			this.chargeTextWork(value.length, "index");
			key = `h:${createHash("sha256").update(INDEX_CORRELATION_DOMAIN).update(value, "utf8").digest("hex")}`;
		}
		this.chargeTextWork(key.length, "index");
		return key;
	}

	/** Detached bounded display metadata retained by the lightweight index. */
	indexDisplayString(value: string, limit: number): string | undefined {
		this.chargeTextWork(value.length, "index");
		if (!isWellFormedUnicode(value)) return undefined;
		const bounded = detachedIndexString(value, limit);
		this.chargeTextWork(bounded.length, "index");
		return bounded;
	}

	private canonicalize<T>(estimate: number, materialize: () => T, text: (value: T) => string): T {
		// Charge the conservative input traversal permanently for this request.
		// Opaque bodies may collapse to tiny summaries, but their scan/hash work
		// must never be replaced by the summary's retained size.
		this.chargeTextWork(estimate, "canonical");
		const value = materialize();
		const actual = text(value).length;
		if (actual > estimate) {
			throw new TranscriptReaderError(
				"TRANSCRIPT_WORK_LIMIT_EXCEEDED",
				"canonical transcript preflight underestimated materialized text",
			);
		}
		return value;
	}

	canonicalizeCall(call: IndexedCall): ReturnType<typeof canonicalToolCallArgumentDetails> {
		this.recordOperations();
		const estimate = assertCallCanonicalizationWithinLimit(
			call,
			this.remainingTextWorkUnits(),
			() => this.recordOperations(),
		);
		const details = this.canonicalize(estimate, () => canonicalToolCallArgumentDetails(call.block), (value) => value.text);
		this.retainText(details.text.length, "call");
		if (this.metrics) this.metrics.callArgumentsCanonicalized++;
		return details;
	}

	canonicalizeResult(result: IndexedResult): ReturnType<typeof canonicalToolResultBodyDetails> {
		this.recordOperations();
		const estimate = assertResultCanonicalizationWithinLimit(
			result,
			this.remainingTextWorkUnits(),
			() => this.recordOperations(),
		);
		const details = this.canonicalize(estimate, () => canonicalToolResultBodyDetails(result.direct), (value) => value.text);
		this.retainText(details.text.length, "result");
		if (this.metrics) {
			this.metrics.resultBodiesCanonicalized++;
			this.metrics.canonicalResultUnits += details.text.length;
		}
		return details;
	}

	recordHash(): void {
		this.recordOperations();
		if (this.metrics) this.metrics.resultBodiesHashed++;
	}

	recordDetached(units: number, kind: DetachedStringKind): void {
		this.recordOperations();
		this.chargeTextWork(units, "projected");
		this.retainText(units, "detached");
		if (this.metrics) {
			if (kind === "argument") this.metrics.detachedArgumentPreviewUnits += units;
			else if (kind === "result") this.metrics.detachedResultExcerptUnits += units;
			else if (kind === "visible") this.metrics.detachedVisibleTextUnits += units;
			else if (kind === "thinking") this.metrics.detachedThinkingUnits += units;
			else this.metrics.detachedMetadataUnits += units;
		}
	}

	releaseDetached(units: number): void {
		if (!Number.isSafeInteger(units) || units < 0 || units > this.retainedDetachedUnits) {
			throw new Error("detached transcript retention underflow");
		}
		this.retainedDetachedUnits -= units;
		this.reservation.release({ textUnits: units });
		this.updateRetainedMetrics();
	}

	releaseCall(units: number): void {
		if (!Number.isSafeInteger(units) || units < 0 || units > this.retainedCallUnits) {
			throw new Error("canonical call retention underflow");
		}
		this.retainedCallUnits -= units;
		this.reservation.release({ textUnits: units });
		this.updateRetainedMetrics();
	}

	releaseResult(units: number): void {
		if (!Number.isSafeInteger(units) || units < 0 || units > this.retainedResultUnits) {
			throw new Error("canonical result retention underflow");
		}
		this.retainedResultUnits -= units;
		this.reservation.release({ textUnits: units });
		this.updateRetainedMetrics();
	}

	close(): void {
		if (this.closed) return;
		this.retainedCallUnits = 0;
		this.retainedResultUnits = 0;
		this.retainedDetachedUnits = 0;
		this.updateRetainedMetrics();
		this.reservation.close();
		this.closed = true;
	}
}

function* agentSearchSegments(
	message: RawMessage,
	index: TranscriptStructureIndex,
	work: AgentProjectionWorkTracker,
): Iterable<string> {
	for (const segment of visibleTextSegments(message)) {
		if (work.inspectProjectedString(segment)) yield segment;
	}
	for (const call of index.callsByMessage.get(message.index) ?? []) {
		// Display metadata is bounded in the structure index, but regex matching
		// still sees the complete canonical provider name on demand.
		yield canonicalCallSearchName(call, work);
		const args = work.canonicalizeCall(call);
		try {
			if (args.present) yield args.text;
		} finally {
			work.releaseCall(args.text.length);
		}
	}
	for (const result of index.resultsByMessage.get(message.index) ?? []) {
		const canonical = work.canonicalizeResult(result);
		try {
			yield canonical.text;
		} finally {
			work.releaseResult(canonical.text.length);
		}
	}
}

async function buildAgentMatchList(
	messages: RawMessage[],
	index: TranscriptStructureIndex,
	pattern: string,
	caseSensitive: boolean,
	context: number,
	transcriptUnits: number,
	work: AgentProjectionWorkTracker,
): Promise<{ matchCount: number; expanded: number[] }> {
	const retainedUnits = estimatedQueuedCorpusUnits(transcriptUnits, 3);
	// Unlike direct REST matching, agent search additionally creates canonical
	// call/result segments. Reject before that work if the request would exceed
	// the existing safe-worker corpus ceiling, even when a worker is immediately free.
	if (retainedUnits > SAFE_REGEX_MAX_QUEUED_CORPUS_UNITS) {
		throw new TranscriptReaderError("TRANSCRIPT_WORK_LIMIT_EXCEEDED", "agent transcript search corpus exceeds the safe work limit");
	}
	return await matchMessageSegments({
		messageCount: messages.length,
		retainedUnits,
		segmentsForMessage: (messageIndex) => agentSearchSegments(messages[messageIndex], index, work),
	}, pattern, caseSensitive, context);
}

interface AgentProjectionState {
	callRefs: Map<IndexedCall, string>;
	resultRefs: Map<IndexedResult, string>;
	authorRefs: Map<string, string>;
	authors: Record<string, MessageAuthor>;
	correlations: Record<string, Record<string, unknown>>;
	nextToolRef: number;
	nextResultRef: number;
	nextAuthorRef: number;
}

function newAgentProjectionState(): AgentProjectionState {
	return {
		callRefs: new Map(),
		resultRefs: new Map(),
		authorRefs: new Map(),
		authors: {},
		correlations: {},
		nextToolRef: 1,
		nextResultRef: 1,
		nextAuthorRef: 1,
	};
}

function refForCall(call: IndexedCall, state: AgentProjectionState): string {
	const existing = state.callRefs.get(call);
	if (existing) return existing;
	const ref = `t${state.nextToolRef++}`;
	state.callRefs.set(call, ref);
	state.correlations[ref] = {
		name: call.name,
		messageIndex: call.messageIndex,
		blockIndex: call.blockIndex,
	};
	return ref;
}

function refForResult(result: IndexedResult, state: AgentProjectionState): string {
	if (result.correlatedCall) return refForCall(result.correlatedCall, state);
	const existing = state.resultRefs.get(result);
	if (existing) return existing;
	const ref = `r${state.nextResultRef++}`;
	state.resultRefs.set(result, ref);
	state.correlations[ref] = {
		name: result.name,
		messageIndex: result.messageIndex,
		blockIndex: result.blockIndex,
	};
	return ref;
}

function refForAuthor(
	author: MessageAuthor,
	state: AgentProjectionState,
	materializer: AgentRowMaterializer,
): string {
	const kind = materializer.projectedString(author.kind, 32, "metadata", "system").text as MessageAuthor["kind"];
	const id = materializer.projectedString(author.id, 256, "metadata", "").text;
	const label = materializer.projectedString(author.label, 128, "metadata", "").text;
	const key = `${kind}\0${id}\0${label}`;
	const existing = state.authorRefs.get(key);
	if (existing) return existing;
	const ref = `a${state.nextAuthorRef++}`;
	state.authorRefs.set(key, ref);
	state.authors[ref] = { kind, id, label };
	return ref;
}

function detachedStringSlice(text: string, start: number, end: number): string {
	if (start === end) return "";
	// Buffer round-tripping forces an independent backing store. A plain slice
	// can remain a V8 SlicedString that pins the full canonical parent.
	return Buffer.from(text.slice(start, end), "utf8").toString("utf8");
}

function scalarPrefixEnd(text: string, start: number, limit: number): number {
	let end = Math.min(text.length, start + limit);
	if (end > start && end < text.length) {
		const previous = text.charCodeAt(end - 1);
		const next = text.charCodeAt(end);
		if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
	}
	return end;
}

function canonicalSliceEnd(text: string, start: number, limit: number): number {
	const end = scalarPrefixEnd(text, start, limit);
	if (end === start && start < text.length) {
		const current = text.charCodeAt(start);
		const next = text.charCodeAt(start + 1);
		if (current >= 0xd800 && current <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) return start + 2;
		return start + 1;
	}
	return end;
}

function validateResultCursor(text: string, cursor: unknown): number {
	const value = validateResultCursorShape(cursor);
	if (value > text.length) {
		throw new TranscriptReaderError("INVALID_RESULT_CURSOR", "result_cursor must be an integer within the result body");
	}
	if (value > 0 && value < text.length) {
		const previous = text.charCodeAt(value - 1);
		const current = text.charCodeAt(value);
		if (previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff) {
			throw new TranscriptReaderError("INVALID_RESULT_CURSOR", "result_cursor splits a Unicode scalar value");
		}
	}
	return value;
}

function validateResultLimit(value: unknown): number {
	if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > AGENT_RESULT_EXCERPT_MAX) {
		throw new TranscriptReaderError("INVALID_RESULT_LIMIT", `result_limit must be an integer in [1, ${AGENT_RESULT_EXCERPT_MAX}]`);
	}
	return value as number;
}

interface BoundedProjectedString {
	text: string;
	truncated: boolean;
	valid: boolean;
}

class AgentRowMaterializer {
	private readonly calls = new Map<IndexedCall, ReturnType<typeof canonicalToolCallArgumentDetails>>();
	private readonly results = new Map<IndexedResult, MaterializedResult>();
	private pendingDetachedUnits = 0;

	constructor(
		private readonly sessionId: string,
		private readonly work: AgentProjectionWorkTracker,
	) {}

	private detachedCopy(text: string, start: number, end: number, kind: DetachedStringKind): string {
		if (start === end) return "";
		const copy = detachedStringSlice(text, start, end);
		this.work.recordDetached(copy.length, kind);
		this.pendingDetachedUnits += copy.length;
		return copy;
	}

	projectedString(
		value: string,
		limit: number,
		kind: DetachedStringKind,
		invalidFallback?: string,
	): BoundedProjectedString {
		let source = value;
		const valid = this.work.inspectProjectedString(source);
		if (!valid) {
			if (invalidFallback === undefined) return { text: "", truncated: false, valid: false };
			source = invalidFallback;
			if (!this.work.inspectProjectedString(source)) throw new Error("invalid projected-string fallback");
		}
		const end = scalarPrefixEnd(source, 0, limit);
		return {
			text: this.detachedCopy(source, 0, end, kind),
			truncated: end < source.length,
			valid,
		};
	}

	joinedPrefix(segments: Iterable<string>, limit: number, kind: "visible" | "thinking"): BoundedProjectedString {
		const parts: string[] = [];
		let accepted = 0;
		let used = 0;
		let truncated = false;
		for (const segment of segments) {
			if (!this.work.inspectProjectedString(segment)) continue;
			const separator = accepted > 0 ? "\n" : "";
			const available = limit - used;
			const contributionLength = separator.length + segment.length;
			if (contributionLength <= available) {
				if (separator) parts.push(separator);
				if (segment) parts.push(segment);
				used += contributionLength;
				accepted++;
				continue;
			}
			if (separator && available > 0) {
				parts.push(separator);
				used++;
			}
			const segmentLimit = Math.max(0, limit - used);
			const end = segmentLimit > 0 ? scalarPrefixEnd(segment, 0, segmentLimit) : 0;
			if (end > 0) {
				// This temporary slice is bounded; the final returned string is
				// copied again below so it cannot retain this segment's parent.
				parts.push(segment.slice(0, end));
				used += end;
			}
			truncated = true;
			break;
		}
		const bounded = parts.join("");
		return {
			text: this.detachedCopy(bounded, 0, bounded.length, kind),
			truncated,
			valid: true,
		};
	}

	callArguments(call: IndexedCall): ReturnType<typeof canonicalToolCallArgumentDetails> {
		const existing = this.calls.get(call);
		if (existing) return existing;
		const details = this.work.canonicalizeCall(call);
		this.calls.set(call, details);
		return details;
	}

	argumentPreview(text: string, limit: number): string {
		const end = scalarPrefixEnd(text, 0, limit);
		return this.detachedCopy(text, 0, end, "argument");
	}

	resultExcerpt(text: string, start: number, end: number): string {
		return this.detachedCopy(text, start, end, "result");
	}

	result(indexed: IndexedResult): MaterializedResult {
		const existing = this.results.get(indexed);
		if (existing) return existing;
		const canonical = this.work.canonicalizeResult(indexed);
		try {
			const size: ToolResultSize = {
				type: canonical.type,
				...(canonical.blocks !== undefined ? { blocks: canonical.blocks } : {}),
				chars: canonical.text.length,
				lines: stringLineCount(canonical.text),
				bytes: Buffer.byteLength(canonical.text, "utf8"),
			};
			const handle = createTranscriptResultHandle(
				this.sessionId,
				indexed.messageIndex,
				indexed.blockIndex,
				canonical.text,
			);
			this.work.recordHash();
			const result: MaterializedResult = {
				indexed,
				body: canonical.text,
				size,
				handle,
			};
			this.results.set(indexed, result);
			return result;
		} catch (error) {
			this.work.releaseResult(canonical.text.length);
			throw error;
		}
	}

	discardDetached(): void {
		this.work.releaseDetached(this.pendingDetachedUnits);
		this.pendingDetachedUnits = 0;
	}

	commitDetached(): void {
		this.pendingDetachedUnits = 0;
	}

	release(): void {
		this.discardDetached();
		for (const result of this.results.values()) this.work.releaseResult(result.body.length);
		for (const call of this.calls.values()) this.work.releaseCall(call.text.length);
		this.results.clear();
		this.calls.clear();
	}
}

function projectedResult(
	result: MaterializedResult,
	state: AgentProjectionState,
	includeExcerpt: boolean,
	cursor = 0,
	limit = AGENT_RESULT_EXCERPT_DEFAULT,
	detachExcerpt?: (text: string, start: number, end: number) => string,
): ProjectedToolResult {
	const projected: ProjectedToolResult = {
		ref: refForResult(result.indexed, state),
		name: result.indexed.name,
		status: result.indexed.status,
		size: result.size,
		omitted: !includeExcerpt,
		handle: result.handle,
	};
	if (includeExcerpt) {
		if (!detachExcerpt) throw new Error("result excerpts must be detached from their canonical parent");
		const end = canonicalSliceEnd(result.body, cursor, limit);
		projected.excerpt = {
			start: cursor,
			end,
			text: detachExcerpt(result.body, cursor, end),
			nextCursor: end < result.body.length ? end : null,
			complete: end === result.body.length,
		};
	}
	return projected;
}

function projectAgentTimestamp(
	timestamp: string | null,
	materializer: AgentRowMaterializer,
): Pick<AgentTranscriptMessage, "ts" | "tsTruncated" | "tsInvalid"> {
	if (timestamp === null) return { ts: null };
	const projected = materializer.projectedString(timestamp, AGENT_TIMESTAMP_LIMIT, "metadata");
	if (!projected.valid) return { ts: null, tsInvalid: true };
	return {
		ts: projected.text,
		...(projected.truncated ? { tsTruncated: true } : {}),
	};
}

function firstProjectedMetadataString(
	source: Record<string, unknown>,
	keys: readonly string[],
	limit: number,
	materializer: AgentRowMaterializer,
): BoundedProjectedString | undefined {
	for (const key of keys) {
		const value = ownNonEmptyString(source, key);
		if (value === undefined) continue;
		const projected = materializer.projectedString(value, limit, "metadata");
		if (projected.valid) return projected;
	}
	return undefined;
}

function projectAgentMessage(
	message: RawMessage,
	index: TranscriptStructureIndex,
	state: AgentProjectionState,
	materializer: AgentRowMaterializer,
	options: { verbose: boolean; includeToolResults: boolean; omitOptional?: boolean },
): AgentTranscriptMessage {
	const projectedRole = materializer.projectedString(message.role, AGENT_ROLE_LIMIT, "metadata", "unknown");
	const textLimit = options.verbose ? AGENT_VERBOSE_TEXT_LIMIT : AGENT_COMPACT_TEXT_LIMIT;
	const projectedText = materializer.joinedPrefix(visibleTextSegments(message), textLimit, "visible");
	const out: AgentTranscriptMessage = {
		index: message.index,
		role: projectedRole.text,
		...(projectedRole.truncated || (!projectedRole.valid && projectedRole.text.length < message.role.length)
			? { roleTruncated: true }
			: {}),
		...projectAgentTimestamp(message.ts, materializer),
		text: projectedText.text,
		...(projectedText.truncated ? { textTruncated: true } : {}),
	};
	if (message.author) out.authorRef = refForAuthor(message.author, state, materializer);
	const stopReason = firstProjectedMetadataString(
		message.fullMessage,
		["stopReason", "stop_reason"],
		AGENT_ROLE_LIMIT,
		materializer,
	);
	if (stopReason) {
		out.stopReason = stopReason.text;
		if (stopReason.truncated) out.stopReasonTruncated = true;
	}
	const errorSummary = firstProjectedMetadataString(
		message.fullMessage,
		["errorMessage", "error_message"],
		AGENT_THINKING_LIMIT,
		materializer,
	);
	if (errorSummary) {
		out.errorSummary = errorSummary.text;
		if (errorSummary.truncated) out.errorSummaryTruncated = true;
	}
	if (options.verbose) {
		const thinking = materializer.joinedPrefix(thinkingSegments(message), AGENT_THINKING_LIMIT, "thinking");
		if (thinking.text) {
			out.thinking = thinking.text;
			if (thinking.truncated) out.thinkingTruncated = true;
		}
	}
	const calls = index.callsByMessage.get(message.index) ?? [];
	if (calls.length > 0) {
		out.toolCalls = calls.map((call) => {
			const args = materializer.callArguments(call);
			const preview = options.omitOptional ? "" : materializer.argumentPreview(args.text, AGENT_ARGUMENT_PREVIEW_LIMIT);
			return {
				ref: refForCall(call, state),
				name: call.name,
				argumentsPreview: preview,
				argumentsTruncated: options.omitOptional
					? args.text.length > 0
					: preview.length < args.text.length,
			};
		});
	}
	const results = index.resultsByMessage.get(message.index) ?? [];
	if (results.length > 0) {
		out.toolResults = results.map((result) => projectedResult(
			materializer.result(result),
			state,
			options.includeToolResults && !options.omitOptional,
			0,
			AGENT_RESULT_EXCERPT_DEFAULT,
			(text, start, end) => materializer.resultExcerpt(text, start, end),
		));
	}
	return out;
}

function referencedDictionary<T>(
	dictionary: Record<string, T>,
	refs: Set<string>,
): Record<string, T> | undefined {
	const entries = Object.entries(dictionary).filter(([ref]) => refs.has(ref));
	return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function envelopeForAgentRows(
	total: number,
	matchCount: number | undefined,
	pageStart: number | undefined,
	pageCount: number | undefined,
	rows: AgentTranscriptMessage[],
	state: AgentProjectionState,
	nextOffset: number | undefined,
	partial = false,
	continuationRequest?: ReadTranscriptEnvelope["continuationRequest"],
): ReadTranscriptEnvelope {
	const authorRefs = new Set<string>();
	const correlationRefs = new Set<string>();
	for (const row of rows) {
		if (row.authorRef) authorRefs.add(row.authorRef);
		for (const call of row.toolCalls ?? []) correlationRefs.add(call.ref);
		for (const result of row.toolResults ?? []) {
			if ("ref" in result) correlationRefs.add(result.ref);
		}
	}
	const authors = referencedDictionary(state.authors, authorRefs);
	const correlations = referencedDictionary(state.correlations, correlationRefs);
	return {
		total,
		...(matchCount !== undefined ? { matchCount } : {}),
		...(pageStart !== undefined && pageCount !== undefined ? { pageStart, pageCount } : {}),
		returned: rows.length,
		offsetStart: rows.length > 0 ? rows[0].index : -1,
		offsetEnd: rows.length > 0 ? rows[rows.length - 1].index : -1,
		...(nextOffset !== undefined ? { nextOffset } : {}),
		messages: rows,
		...(authors ? { authors } : {}),
		...(correlations ? { correlations } : {}),
		...(partial ? {
			partial: true,
			truncatedBy: "transport_budget" as const,
			...(continuationRequest ? { continuationRequest } : {}),
		} : {}),
	};
}

function serializedBytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function summaryRow(
	message: RawMessage,
	index: TranscriptStructureIndex,
): AgentTranscriptMessage {
	// Provider metadata is deliberately excluded. With all numeric values bounded
	// by the charged raw transcript, this row plus its page continuation fits the
	// minimum accepted 512-byte envelope even when the source strings require
	// worst-case JSON escaping.
	return {
		index: message.index,
		role: "unknown",
		ts: null,
		text: "",
		projectionOmitted: true,
		toolCallCount: (index.callsByMessage.get(message.index) ?? []).length,
		toolResultCount: (index.resultsByMessage.get(message.index) ?? []).length,
	};
}

function fitAgentPage(
	all: RawMessage[],
	index: TranscriptStructureIndex,
	workingIndices: number[],
	start: number,
	limit: number,
	verbose: boolean,
	includeToolResults: boolean,
	matchCount: number | undefined,
	budget: number,
	sessionId: string,
	work: AgentProjectionWorkTracker,
): ReadTranscriptEnvelope {
	const requestedIndices = workingIndices.slice(start, Math.min(workingIndices.length, start + limit));
	const state = newAgentProjectionState();
	const rows: AgentTranscriptMessage[] = [];
	let transportStopped = false;

	for (let relative = 0; relative < requestedIndices.length; relative++) {
		const raw = all[requestedIndices[relative]];
		const materializer = new AgentRowMaterializer(sessionId, work);
		try {
			let row = projectAgentMessage(raw, index, state, materializer, { verbose, includeToolResults });
			const reserveOffset = start + relative + 1;
			let trial = envelopeForAgentRows(
				all.length,
				matchCount,
				start,
				workingIndices.length,
				[...rows, row],
				state,
				reserveOffset,
				true,
				{ kind: "page", offset: reserveOffset },
			);
			if (serializedBytes(trial) > budget) {
				materializer.discardDetached();
				row = projectAgentMessage(raw, index, state, materializer, { verbose, includeToolResults, omitOptional: true });
				trial = envelopeForAgentRows(
					all.length,
					matchCount,
					start,
					workingIndices.length,
					[...rows, row],
					state,
					reserveOffset,
					true,
					{ kind: "page", offset: reserveOffset },
				);
			}
			if (serializedBytes(trial) > budget) {
				materializer.discardDetached();
				if (rows.length === 0) {
					row = summaryRow(raw, index);
					trial = envelopeForAgentRows(
						all.length,
						matchCount,
						start,
						workingIndices.length,
						[row],
						state,
						reserveOffset,
						true,
						{ kind: "page", offset: reserveOffset },
					);
					if (serializedBytes(trial) > budget) {
						throw new Error("minimum transcript page fallback exceeded its proven serialized budget");
					}
					rows.push(row);
				}
				transportStopped = true;
				break;
			}
			rows.push(row);
			materializer.commitDetached();
		} finally {
			// The response contains only bounded excerpts and metadata. Release the
			// full canonical row bodies before considering the next page row.
			materializer.release();
		}
	}

	if (transportStopped || rows.length < requestedIndices.length) {
		const nextOffset = start + rows.length;
		return envelopeForAgentRows(
			all.length,
			matchCount,
			start,
			workingIndices.length,
			rows,
			state,
			nextOffset,
			true,
			{ kind: "page", offset: nextOffset },
		);
	}
	const endPosition = start + rows.length;
	return envelopeForAgentRows(
		all.length,
		matchCount,
		start,
		workingIndices.length,
		rows,
		state,
		endPosition < workingIndices.length ? endPosition : undefined,
	);
}

interface ParsedResultHandle {
	messageIndex: number;
	blockIndex: number;
}

function parseResultHandle(handle: unknown): ParsedResultHandle {
	if (typeof handle !== "string" || handle.length > 128 || !isWellFormedUnicode(handle)) {
		throw new TranscriptReaderError("INVALID_RESULT_HANDLE", "result_handle must be a canonical result handle");
	}
	const match = /^rs1:m([0-9a-z]+):b([0-9a-z]+):([A-Za-z0-9_-]{27})$/.exec(handle);
	if (!match) throw new TranscriptReaderError("INVALID_RESULT_HANDLE", "result_handle is malformed");
	const messageIndex = Number.parseInt(match[1], 36);
	const blockIndex = Number.parseInt(match[2], 36);
	if (!Number.isSafeInteger(messageIndex) || messageIndex < 0 || messageIndex.toString(36) !== match[1]
		|| !Number.isInteger(blockIndex) || blockIndex < 0 || blockIndex > 0xffff_ffff
		|| blockIndex.toString(36) !== match[2]) {
		throw new TranscriptReaderError("INVALID_RESULT_HANDLE", "result_handle location is malformed");
	}
	return { messageIndex, blockIndex };
}

function validateResultCursorShape(cursor: unknown): number {
	if (!Number.isSafeInteger(cursor) || (cursor as number) < 0) {
		throw new TranscriptReaderError("INVALID_RESULT_CURSOR", "result_cursor must be a non-negative safe integer");
	}
	return cursor as number;
}

function prevalidateAgentResultRequest(params: ReadTranscriptParams): void {
	if (params.resultHandle === undefined) {
		if (params.resultCursor !== undefined) {
			throw new TranscriptReaderError("INVALID_RESULT_HANDLE", "result_handle is required with result_cursor");
		}
		if (params.resultLimit !== undefined) {
			throw new TranscriptReaderError("INVALID_RESULT_HANDLE", "result_handle is required with result_limit");
		}
		return;
	}
	// Handle syntax has stable precedence over dependent cursor/limit errors.
	parseResultHandle(params.resultHandle);
	if (params.resultCursor !== undefined) validateResultCursorShape(params.resultCursor);
	if (params.resultLimit !== undefined) validateResultLimit(params.resultLimit);
}

function readTargetedResultSlice(
	all: RawMessage[],
	index: TranscriptStructureIndex,
	params: ReadTranscriptParams,
	budget: number,
	sessionId: string,
	work: AgentProjectionWorkTracker,
): ReadTranscriptEnvelope {
	const location = parseResultHandle(params.resultHandle);
	const raw = all[location.messageIndex];
	if (!raw || raw.index !== location.messageIndex) {
		throw new TranscriptReaderError("RESULT_NOT_FOUND", "result handle message does not exist");
	}
	const indexed = index.resultByLocation.get(resultLocationKey(location.messageIndex, location.blockIndex));
	if (!indexed) throw new TranscriptReaderError("RESULT_NOT_FOUND", "result handle block does not exist");
	const materializer = new AgentRowMaterializer(sessionId, work);
	try {
		const result = materializer.result(indexed);
		if (result.handle !== params.resultHandle) {
			throw new TranscriptReaderError("STALE_RESULT_HANDLE", "result body changed after this handle was issued");
		}
		const cursor = validateResultCursor(result.body, params.resultCursor ?? 0);
		const requestedLimit = validateResultLimit(params.resultLimit ?? AGENT_RESULT_EXCERPT_DEFAULT);
		const requestedEnd = canonicalSliceEnd(result.body, cursor, requestedLimit);
		const makeTargetRow = (state: AgentProjectionState, limit: number): AgentTranscriptMessage => {
			const role = materializer.projectedString(raw.role, AGENT_ROLE_LIMIT, "metadata", "unknown");
			const row: AgentTranscriptMessage = {
				index: raw.index,
				role: role.text,
				...(role.truncated || (!role.valid && role.text.length < raw.role.length)
					? { roleTruncated: true }
					: {}),
				...projectAgentTimestamp(raw.ts, materializer),
				text: "",
				toolResults: [projectedResult(
					result,
					state,
					true,
					cursor,
					limit,
					(text, start, end) => materializer.resultExcerpt(text, start, end),
				)],
			};
			if (raw.author) row.authorRef = refForAuthor(raw.author, state, materializer);
			return row;
		};
		const state = newAgentProjectionState();
		const base = makeTargetRow(state, requestedLimit);
		let envelope = envelopeForAgentRows(all.length, undefined, undefined, undefined, [base], state, undefined);
		if (serializedBytes(envelope) <= budget) {
			materializer.commitDetached();
			return envelope;
		}
		materializer.discardDetached();

		let low = 1;
		let high = Math.max(1, requestedEnd - cursor);
		let bestUnits: number | undefined;
		while (low <= high) {
			const units = Math.floor((low + high) / 2);
			const candidateState = newAgentProjectionState();
			const candidate = makeTargetRow(candidateState, units);
			const actualEnd = candidate.toolResults![0].excerpt!.end;
			const partial = actualEnd < requestedEnd;
			const projected = envelopeForAgentRows(
				all.length,
				undefined,
				undefined,
				undefined,
				[candidate],
				candidateState,
				undefined,
				partial,
				partial ? {
					kind: "result_slice",
					result_handle: result.handle,
					result_cursor: actualEnd,
					result_limit: requestedLimit,
				} : undefined,
			);
			const fits = serializedBytes(projected) <= budget;
			materializer.discardDetached();
			if (fits) {
				bestUnits = units;
				low = units + 1;
			} else {
				high = units - 1;
			}
		}
		if (bestUnits !== undefined) {
			const bestState = newAgentProjectionState();
			const best = makeTargetRow(bestState, bestUnits);
			const actualEnd = best.toolResults![0].excerpt!.end;
			const partial = actualEnd < requestedEnd;
			envelope = envelopeForAgentRows(
				all.length,
				undefined,
				undefined,
				undefined,
				[best],
				bestState,
				undefined,
				partial,
				partial ? {
					kind: "result_slice",
					result_handle: result.handle,
					result_cursor: actualEnd,
					result_limit: requestedLimit,
				} : undefined,
			);
			if (serializedBytes(envelope) <= budget) {
				materializer.commitDetached();
				return envelope;
			}
			materializer.discardDetached();
		}

		// Optional row metadata and the correlation/author dictionaries can exceed
		// the minimum budget after JSON escaping. Refit a compact canonical row:
		// omit those repeatable fields, but never the result's ref, name, status,
		// accurate size, omission state, handle, or self-describing excerpt.
		const makeCompactTargetRow = (limit: number): { row: AgentTranscriptMessage; end: number } => {
			const compactState = newAgentProjectionState();
			const compactResult = projectedResult(
				result,
				compactState,
				true,
				cursor,
				limit,
				(text, start, end) => materializer.resultExcerpt(text, start, end),
			);
			return {
				row: {
					index: raw.index,
					role: "unknown",
					toolResults: [compactResult],
				},
				end: compactResult.excerpt!.end,
			};
		};
		const compactEnvelope = (row: AgentTranscriptMessage, end: number): ReadTranscriptEnvelope => {
			const partial = end < requestedEnd;
			return envelopeForAgentRows(
				all.length,
				undefined,
				undefined,
				undefined,
				[row],
				// The result is self-describing, so do not repeat its name/location in
				// a correlation dictionary solely to explain the already-present ref.
				newAgentProjectionState(),
				undefined,
				partial,
				partial ? {
					kind: "result_slice",
					result_handle: result.handle,
					result_cursor: end,
					result_limit: requestedLimit,
				} : undefined,
			);
		};

		const requestedCompact = makeCompactTargetRow(requestedLimit);
		envelope = compactEnvelope(requestedCompact.row, requestedCompact.end);
		if (serializedBytes(envelope) <= budget) {
			materializer.commitDetached();
			return envelope;
		}
		materializer.discardDetached();

		let compactLow = 1;
		let compactHigh = Math.max(1, requestedEnd - cursor);
		let compactBestUnits: number | undefined;
		while (compactLow <= compactHigh) {
			const units = Math.floor((compactLow + compactHigh) / 2);
			const candidate = makeCompactTargetRow(units);
			const projected = compactEnvelope(candidate.row, candidate.end);
			const fits = serializedBytes(projected) <= budget;
			materializer.discardDetached();
			if (fits) {
				compactBestUnits = units;
				compactLow = units + 1;
			} else {
				compactHigh = units - 1;
			}
		}
		if (compactBestUnits === undefined) {
			throw new Error("minimum transcript result-slice envelope cannot preserve canonical metadata");
		}
		const compactBest = makeCompactTargetRow(compactBestUnits);
		envelope = compactEnvelope(compactBest.row, compactBest.end);
		if (serializedBytes(envelope) > budget) {
			throw new Error("minimum transcript result-slice fallback exceeded its proven serialized budget");
		}
		materializer.commitDetached();
		return envelope;
	} finally {
		materializer.release();
	}
}

function validatedAgentProjectionConfig(opts: ReadTranscriptOptions): {
	budget: number;
	requestLimits: TranscriptProjectionRequestWorkLimits;
} {
	const budget = opts.serializedBudgetBytes ?? READ_SESSION_AGENT_ENVELOPE_MAX_BYTES;
	if (!Number.isSafeInteger(budget) || budget < READ_SESSION_AGENT_ENVELOPE_MIN_BYTES || budget > READ_SESSION_AGENT_ENVELOPE_MAX_BYTES) {
		throw new TranscriptReaderError(
			"invalid_params",
			`serializedBudgetBytes must be an integer in [${READ_SESSION_AGENT_ENVELOPE_MIN_BYTES}, ${READ_SESSION_AGENT_ENVELOPE_MAX_BYTES}]`,
		);
	}
	const requestLimits: TranscriptProjectionRequestWorkLimits = {
		...READ_SESSION_AGENT_WORK_LIMITS.request,
		...opts.projectionWorkLimitsForTests,
	};
	for (const [name, value] of Object.entries(requestLimits)) {
		const productionMaximum = READ_SESSION_AGENT_WORK_LIMITS.request[name as keyof TranscriptProjectionRequestWorkLimits];
		if (!Number.isSafeInteger(value) || value < 1 || value > productionMaximum) {
			throw new Error(`${name} test override must be a positive safe integer no larger than production`);
		}
	}
	return { budget, requestLimits };
}

async function readAgentTranscript(
	params: ReadTranscriptParams,
	all: RawMessage[],
	opts: ReadTranscriptOptions,
	validated: { offset: number; limit: number; context: number },
	transcriptUnits: number,
	budget: number,
	work: AgentProjectionWorkTracker,
): Promise<ReadTranscriptEnvelope> {
	const sessionId = opts.sessionId ?? opts.authorContext?.session?.id ?? "unknown";
	const index = buildTranscriptStructureIndex(all, undefined, work);
	if (params.resultHandle !== undefined) {
		return readTargetedResultSlice(all, index, params, budget, sessionId, work);
	}
	let workingIndices: number[];
	let matchCount: number | undefined;
	if (params.pattern && params.pattern.length > 0) {
		const matched = await buildAgentMatchList(
			all,
			index,
			params.pattern,
			!!params.caseSensitive,
			validated.context,
			transcriptUnits,
			work,
		);
		workingIndices = matched.expanded;
		matchCount = matched.matchCount;
	} else {
		workingIndices = all.map((_, position) => position);
	}
	const start = resolveOffset(validated.offset, workingIndices.length);
	if (start >= workingIndices.length) {
		return {
			total: all.length,
			...(matchCount !== undefined ? { matchCount } : {}),
			pageStart: Math.min(start, workingIndices.length),
			pageCount: workingIndices.length,
			returned: 0,
			offsetStart: -1,
			offsetEnd: -1,
			messages: [],
		};
	}
	return fitAgentPage(
		all,
		index,
		workingIndices,
		start,
		validated.limit,
		!!params.verbose,
		params.includeToolResults === true,
		matchCount,
		budget,
		sessionId,
		work,
	);
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
	if (pattern !== undefined && typeof pattern !== "string") {
		throw new TranscriptReaderError("invalid_params", "pattern must be a string");
	}
	if (pattern !== undefined && pattern.length > SAFE_REGEX_PATTERN_MAX_UNITS) {
		throw new TranscriptReaderError(
			"invalid_params",
			`pattern must contain at most ${SAFE_REGEX_PATTERN_MAX_UNITS} UTF-16 units`,
		);
	}
	const caseSensitive = !!params.caseSensitive;
	if (opts.projection === "agent") {
		prevalidateAgentResultRequest(params);
		const { budget, requestLimits } = validatedAgentProjectionConfig(opts);
		let work: AgentProjectionWorkTracker | undefined;
		try {
			// Acquire before transcript I/O so concurrent agent reads cannot all load
			// and parse the same large provider transcript outside the global pool.
			work = new AgentProjectionWorkTracker(
				opts.workMetricsForTests,
				requestLimits,
				opts.workReservationPoolForTests ?? AGENT_PROJECTION_RESERVATION_POOL,
			);
			const content = await opts.readContent();
			if (content === null || content === undefined || content === "") {
				throw new TranscriptReaderError("transcript_unavailable", "transcript file missing or empty");
			}
			// Reserve the raw JSONL before split(), JSON.parse(), message cloning, or
			// author correlation can allocate or scan ignored provider-only fields.
			work.chargeRawTranscript(content);
			await opts.beforeAgentParseForTests?.();
			const all = resolveRawMessageAuthors(parseJsonl(content), opts.authorContext);
			return await readAgentTranscript(
				params,
				all,
				opts,
				{ offset, limit, context },
				content.length,
				budget,
				work,
			);
		} catch (error) {
			if (error instanceof TranscriptReaderError) throw error;
			if (error instanceof CanonicalTranscriptValueError) {
				throw new TranscriptReaderError("INVALID_RESULT_BODY", error.message);
			}
			throw error;
		} finally {
			work?.close();
		}
	}

	// Direct REST/UI compatibility stays on the legacy, unreserved path.
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
		const { matchCount: mc, expanded } = await buildMatchList(all, pattern, caseSensitive, context, content.length);
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
