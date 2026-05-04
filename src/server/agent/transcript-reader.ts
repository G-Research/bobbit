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

// ── Types ──

export interface ReadTranscriptParams {
	offset?: number;
	limit?: number;
	pattern?: string;
	caseSensitive?: boolean;
	context?: number;
	verbose?: boolean;
}

export interface CompactToolUse {
	name: string;
	inputPreview: string;
}

export interface CompactToolResult {
	name?: string;
	preview: string;
}

export interface CompactMessage {
	index: number;
	role: string;
	ts: string | null;
	text: string;
	toolUses?: CompactToolUse[];
	toolResults?: CompactToolResult[];
}

export interface VerboseMessage {
	index: number;
	role: string;
	ts: string | null;
	content: unknown;
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
	| "invalid_params";

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
		if (t === "text" && typeof b.text === "string") {
			parts.push(b.text);
		} else if (t === "tool_use") {
			const name = typeof b.name === "string" ? b.name : "?";
			let input = "";
			try { input = JSON.stringify(b.input ?? {}); } catch { input = ""; }
			parts.push(`[TOOL: ${name} ${input}]`);
		} else if (t === "tool_result") {
			const c = b.content;
			parts.push(`[RESULT: ${typeof c === "string" ? c : safeStringify(c)}]`);
		}
	}
	return parts.join(" ");
}

function safeStringify(v: unknown): string {
	if (v === null || v === undefined) return "";
	if (typeof v === "string") return v;
	try { return JSON.stringify(v); } catch { return String(v); }
}

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
		messages.push({
			index: idx++,
			role,
			ts,
			content: entry.message.content,
		});
	}
	return messages;
}

// ── Compact rendering ──

function toCompact(m: RawMessage): CompactMessage {
	const content = m.content;
	let text = "";
	const toolUses: CompactToolUse[] = [];
	const toolResults: CompactToolResult[] = [];

	if (typeof content === "string") {
		text = content;
	} else if (Array.isArray(content)) {
		const textParts: string[] = [];
		for (const block of content) {
			if (!block || typeof block !== "object") continue;
			const b = block as Record<string, unknown>;
			const t = b.type;
			if (t === "text" && typeof b.text === "string") {
				textParts.push(b.text);
			} else if (t === "tool_use") {
				const name = typeof b.name === "string" ? b.name : "?";
				let inputPreview = "";
				try { inputPreview = JSON.stringify(b.input ?? {}).slice(0, PREVIEW_LIMIT); }
				catch { inputPreview = ""; }
				toolUses.push({ name, inputPreview });
			} else if (t === "tool_result") {
				const c = b.content;
				const preview = (typeof c === "string" ? c : safeStringify(c)).slice(0, PREVIEW_LIMIT);
				const name = typeof b.name === "string" ? b.name : undefined;
				toolResults.push(name ? { name, preview } : { preview });
			}
		}
		text = textParts.join("\n").trim();
	}

	if (text.length > TEXT_LIMIT) text = text.slice(0, TEXT_LIMIT) + "…";

	const out: CompactMessage = { index: m.index, role: m.role, ts: m.ts, text };
	if (toolUses.length > 0) out.toolUses = toolUses;
	if (toolResults.length > 0) out.toolResults = toolResults;
	return out;
}

function toVerbose(m: RawMessage): VerboseMessage {
	return { index: m.index, role: m.role, ts: m.ts, content: m.content };
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
		const flat = flattenText(m.content);
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

// ── Public API ──

export interface ReadTranscriptOptions {
	/** Async loader returning the raw JSONL contents. */
	readContent: () => Promise<string | null>;
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
	const pattern = params.pattern;
	const caseSensitive = !!params.caseSensitive;

	const content = await opts.readContent();
	if (content === null || content === undefined || content === "") {
		throw new TranscriptReaderError("transcript_unavailable", "transcript file missing or empty");
	}

	const all = parseJsonl(content);
	const total = all.length;

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
		return verbose ? toVerbose(raw) : toCompact(raw);
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
