/**
 * Team agent surface — launch and orchestrate child agents.
 *
 * Registers `team_delegate` (spawn an isolated child agent in your worktree —
 * blocking one-shot by default, `non_blocking` opt-in) plus the orchestration
 * verbs (`team_wait`, `team_prompt`, `team_dismiss`, `team_steer`,
 * `team_abort`) that operate over the caller's OWN child sessions. Also
 * registers `read_session` (transcript reader) and `session_prompt` (explicitly
 * allowed cross-session prompt/steer) for every session.
 *
 * All verbs are agent-process tools: they call the gateway over authenticated
 * REST using on-disk credentials (`agent/gateway.js`) and hit the
 * server-side `/api/sessions/:id/orchestrate/*` routes, which invoke the
 * in-process `OrchestrationCore`. There is NO inlined creds logic and NO
 * client-side spawn/wait loop — the server owns the child lifecycle.
 *
 * A spawned child agent gets full tool access (bash, read, write, etc.) but
 * sees only AGENTS.md + the instructions you provide — it does NOT see the
 * parent conversation. The child inherits the parent's current model and a
 * copy of the parent's allowed tools MINUS every spawn verb (no grandchildren).
 */

import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { contextHeavyLimitError } from "../_shared/context-heavy-guard.js";
import { readGatewayCreds, apiCall, apiCallDetailed } from "./gateway.js";

// ── Types ──

/** One child entry in the blocking-delegate response (drop-in parity). */
interface DelegateResultEntry {
	id: string;
	sessionId: string;
	status: "completed" | "failed" | "timeout" | "terminated";
	output: string;
	durationMs: number;
	error?: string;
}

interface DelegateRouteResponse {
	delegates: DelegateResultEntry[];
	summary?: string;
	/** Route-level failure surfaced AFTER the chunked 200 headers (e.g. spawn/wait
	 *  failure). The chunked response cannot change its status code, so the body
	 *  carries the error; the tool wrapper must surface it instead of an empty result. */
	error?: string;
}

/** Child status vocabulary returned by the orchestrate routes (§9). */
type ChildStatus =
	| "idle"
	| "streaming"
	| "queued"
	| "not-started"
	| "terminated"
	| "timeout"
	| "failed";

interface WaitStatusEntry {
	sessionId: string;
	status: ChildStatus;
	title?: string;
}

interface WaitRouteResponse {
	firstIdle?: string;
	statuses?: WaitStatusEntry[];
	outputTail?: string;
	remaining?: number;
	/** Server-formatted result text (§9) — the SINGLE source of truth for wording. */
	text?: string;
	/** Route-level failure surfaced AFTER the chunked 200 headers (e.g.
	 *  NOT_OWN_CHILD). Carried in the body since the status code is already 200;
	 *  the tool wrapper must surface it instead of a misleading empty-wait. */
	error?: string;
}

interface SpawnedChild {
	id?: string;
	sessionId?: string;
	childSessionId?: string;
	title?: string;
	status?: string;
}

interface SpawnRouteResponse {
	children?: SpawnedChild[];
	childSessionId?: string;
	sessionId?: string;
	title?: string;
}

/** Details shape consumed by the (shared) DelegateRenderer. */
interface DelegateDetails {
	delegates: Array<{
		id: string;
		sessionId: string;
		instructions: string;
		status: string;
		durationMs: number;
	}>;
}

// ── Helpers ──

function getCallerSessionId(): string | undefined {
	return process.env.BOBBIT_SESSION_ID || undefined;
}

function firstLine(s: string, max = 100): string {
	return (s || "").split("\n")[0].slice(0, max);
}

/** Map an orchestration ChildStatus to the renderer card status vocabulary. */
function cardStatus(status: string): string {
	switch (status) {
		case "idle":
		case "completed":
			return "completed";
		case "streaming":
			return "running";
		case "queued":
			return "running";
		case "not-started":
			return "starting";
		case "timeout":
			return "timeout";
		case "terminated":
		case "failed":
			return "failed";
		default:
			return status;
	}
}

const TERMINAL_STATUSES = new Set<ChildStatus>(["terminated", "timeout", "failed"]);
const SETTLED_STATUSES = new Set<ChildStatus>(["idle", "terminated", "timeout", "failed"]);

// ── read_session helpers ──

interface ReadSessionParams {
	session_id: string;
	offset?: number;
	limit?: number;
	pattern?: string;
	case_sensitive?: boolean;
	context?: number;
	verbose?: boolean;
	include_tool_results?: boolean;
	result_handle?: string;
	result_cursor?: number;
	result_limit?: number;
}

interface ReadSessionDetails {
	session_id: string;
	sessionIdTruncated: boolean;
	total?: number;
	matchCount?: number;
	returned?: number;
	offsetStart?: number;
	offsetEnd?: number;
	nextOffset?: number | null;
}

const READ_SESSION_DETAILS_SESSION_ID_MAX_CHARS = 64;

/** Bound renderer-only identity without splitting an astral Unicode scalar. */
function boundedSessionId(value: string): { value: string; truncated: boolean } {
	if (value.length <= READ_SESSION_DETAILS_SESSION_ID_MAX_CHARS) {
		return { value, truncated: false };
	}
	let end = READ_SESSION_DETAILS_SESSION_ID_MAX_CHARS;
	const previous = value.charCodeAt(end - 1);
	const next = value.charCodeAt(end);
	if (previous >= 0xD800 && previous <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF) {
		end -= 1;
	}
	return { value: value.slice(0, end), truncated: true };
}

/**
 * Keep renderer details intentionally small. The canonical envelope lives only
 * in content[0].text; duplicating messages here previously doubled persisted
 * tool-result size. Unknown/non-scalar envelope fields are never copied.
 */
function readSessionDetails(params: ReadSessionParams, envelope: unknown): ReadSessionDetails {
	const sessionId = boundedSessionId(params.session_id);
	const details: ReadSessionDetails = {
		session_id: sessionId.value,
		sessionIdTruncated: sessionId.truncated,
	};
	if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return details;

	const source = envelope as Record<string, unknown>;
	for (const key of ["total", "matchCount", "returned", "offsetStart", "offsetEnd"] as const) {
		const value = source[key];
		if (typeof value === "number" && Number.isSafeInteger(value)) details[key] = value;
	}
	const nextOffset = source.nextOffset;
	if (nextOffset === null || (typeof nextOffset === "number" && Number.isSafeInteger(nextOffset))) {
		details.nextOffset = nextOffset;
	}
	return details;
}

/**
 * The server pre-fits agent transcript envelopes, and the immutable registration
 * wrapper remains authoritative for stale/overridden extensions. Keep the
 * builtin safe on its own as well: its complete Pi value includes a second JSON
 * encoding plus renderer details, so fitting the route body alone is not enough.
 */
const READ_SESSION_FINAL_RESULT_MAX_BYTES = 50 * 1024;
const READ_SESSION_RESULT_EXCERPT_DEFAULT = 4096;
const READ_SESSION_RESULT_EXCERPT_MAX = 8192;
type ReadSessionRecord = Record<string, any>;
interface ReadSessionPiValue {
	content: Array<{ type: "text"; text: string }>;
	details: ReadSessionDetails;
}

function isReadSessionRecord(value: unknown): value is ReadSessionRecord {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasReadSessionKey(value: unknown, key: string): boolean {
	return isReadSessionRecord(value) && Object.prototype.hasOwnProperty.call(value, key);
}

function isSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value);
}

function isNonNegativeInteger(value: unknown): value is number {
	return isSafeInteger(value) && value >= 0;
}

function isWellFormedString(value: unknown): value is string {
	if (typeof value !== "string") return false;
	for (let index = 0; index < value.length; index += 1) {
		const unit = value.charCodeAt(index);
		if (unit >= 0xD800 && unit <= 0xDBFF) {
			const low = value.charCodeAt(index + 1);
			if (low < 0xDC00 || low > 0xDFFF) return false;
			index += 1;
		} else if (unit >= 0xDC00 && unit <= 0xDFFF) {
			return false;
		}
	}
	return true;
}

function scalarSafePrefix(value: string, maxUnits: number, guaranteeProgress = false): string {
	if (!isWellFormedString(value) || maxUnits < 0) return "";
	if (value.length <= maxUnits) return value;
	let end = Math.max(0, Math.min(value.length, maxUnits));
	if (end > 0) {
		const last = value.charCodeAt(end - 1);
		if (last >= 0xD800 && last <= 0xDBFF) end -= 1;
	}
	if (end === 0 && guaranteeProgress && value.length >= 2) {
		const high = value.charCodeAt(0);
		const low = value.charCodeAt(1);
		if (high >= 0xD800 && high <= 0xDBFF && low >= 0xDC00 && low <= 0xDFFF) end = 2;
	}
	return value.slice(0, end);
}

function boundedReadSessionString(value: unknown, maxUnits: number): { text: string; truncated: boolean } | undefined {
	if (!isWellFormedString(value)) return undefined;
	const text = scalarSafePrefix(value, maxUnits);
	return { text, truncated: text.length !== value.length };
}

function readSessionSerializedBytes(value: unknown): number {
	try {
		const serialized = JSON.stringify(value);
		return typeof serialized === "string" ? Buffer.byteLength(serialized, "utf8") : Number.MAX_SAFE_INTEGER;
	} catch {
		return Number.MAX_SAFE_INTEGER;
	}
}

function readSessionPiValue(params: ReadSessionParams, envelope: ReadSessionRecord): ReadSessionPiValue | undefined {
	try {
		return {
			content: [{ type: "text" as const, text: JSON.stringify(envelope) }],
			details: readSessionDetails(params, envelope),
		};
	} catch {
		return undefined;
	}
}

function readSessionValueFits(value: unknown): boolean {
	return readSessionSerializedBytes(value) <= READ_SESSION_FINAL_RESULT_MAX_BYTES;
}

function validRetryContinuation(value: unknown): boolean {
	if (!isReadSessionRecord(value) || value.kind !== "retry" || value.retrySameRequest !== true) return false;
	const allowed = new Set([
		"kind", "retrySameRequest", "session_id", "sessionIdTruncated", "offset", "limit",
		"case_sensitive", "verbose", "include_tool_results", "context", "patternOmitted",
	]);
	if (Object.keys(value).some((key) => !allowed.has(key))) return false;
	if (hasReadSessionKey(value, "session_id") && !isWellFormedString(value.session_id)) return false;
	if (hasReadSessionKey(value, "sessionIdTruncated") && typeof value.sessionIdTruncated !== "boolean") return false;
	for (const key of ["offset", "limit"]) {
		if (hasReadSessionKey(value, key) && !isSafeInteger(value[key])) return false;
	}
	for (const key of ["case_sensitive", "verbose", "include_tool_results", "patternOmitted"]) {
		if (hasReadSessionKey(value, key) && typeof value[key] !== "boolean") return false;
	}
	return !hasReadSessionKey(value, "context")
		|| (isSafeInteger(value.context) && value.context >= 0 && value.context <= 5);
}

function resultSliceContinuations(messages: unknown[]): Array<{ result: ReadSessionRecord; cursor: number }> {
	const found: Array<{ result: ReadSessionRecord; cursor: number }> = [];
	for (const message of messages) {
		if (!isReadSessionRecord(message) || !Array.isArray(message.toolResults)) continue;
		for (const result of message.toolResults) {
			if (isReadSessionRecord(result) && isReadSessionRecord(result.excerpt)
				&& isNonNegativeInteger(result.excerpt.nextCursor)) {
				found.push({ result, cursor: result.excerpt.nextCursor });
			}
		}
	}
	return found;
}

/** Validate the successful union before trusting its pagination semantics. */
function isCanonicalReadSessionEnvelope(value: unknown): value is ReadSessionRecord {
	if (!isReadSessionRecord(value)
		|| !isNonNegativeInteger(value.total)
		|| !isNonNegativeInteger(value.returned)
		|| !isSafeInteger(value.offsetStart)
		|| !isSafeInteger(value.offsetEnd)
		|| !Array.isArray(value.messages)
		|| value.returned !== value.messages.length) return false;
	if (value.messages.some((message: unknown) => !isReadSessionRecord(message)
		|| !isNonNegativeInteger(message.index) || !isWellFormedString(message.role))) return false;
	if (hasReadSessionKey(value, "matchCount") && !isNonNegativeInteger(value.matchCount)) return false;
	const hasPageStart = hasReadSessionKey(value, "pageStart");
	const hasPageCount = hasReadSessionKey(value, "pageCount");
	if (hasPageStart !== hasPageCount) return false;
	if (hasPageStart && (!isNonNegativeInteger(value.pageStart)
		|| !isNonNegativeInteger(value.pageCount)
		|| value.pageStart > value.pageCount
		|| value.returned > value.pageCount - value.pageStart)) return false;
	if (hasReadSessionKey(value, "nextOffset") && value.nextOffset !== null && !isSafeInteger(value.nextOffset)) return false;
	if (hasPageStart && isSafeInteger(value.nextOffset)
		&& value.nextOffset !== value.pageStart + value.returned) return false;

	if (value.partial === undefined || value.partial === false) {
		return !hasReadSessionKey(value, "truncatedBy")
			&& !hasReadSessionKey(value, "continuationRequest")
			&& !hasReadSessionKey(value, "wrapperDiagnostics");
	}
	if (value.partial !== true || !isReadSessionRecord(value.continuationRequest)) return false;
	if (value.truncatedBy === "transport_budget") {
		const continuation = value.continuationRequest;
		if (continuation.kind === "page") {
			return isNonNegativeInteger(continuation.offset) && value.nextOffset === continuation.offset;
		}
		if (continuation.kind === "result_slice") {
			if (!isWellFormedString(continuation.result_handle)
				|| !isNonNegativeInteger(continuation.result_cursor)
				|| !isSafeInteger(continuation.result_limit)
				|| continuation.result_limit < 1
				|| continuation.result_limit > READ_SESSION_RESULT_EXCERPT_MAX
				|| hasReadSessionKey(value, "nextOffset")) return false;
			const slices = resultSliceContinuations(value.messages);
			return slices.length === 1
				&& slices[0].cursor === continuation.result_cursor
				&& slices[0].result.handle === continuation.result_handle;
		}
		return false;
	}
	return value.truncatedBy === "extension_return_unrecognized"
		&& value.total === 0 && value.returned === 0
		&& value.offsetStart === -1 && value.offsetEnd === -1
		&& value.messages.length === 0
		&& !hasReadSessionKey(value, "pageStart") && !hasReadSessionKey(value, "pageCount")
		&& validRetryContinuation(value.continuationRequest)
		&& isReadSessionRecord(value.wrapperDiagnostics)
		&& value.wrapperDiagnostics.omitted === true
		&& isNonNegativeInteger(value.wrapperDiagnostics.actualBytes);
}

function sanitizeReadSessionSize(value: unknown): ReadSessionRecord {
	const allowedTypes = new Set(["string", "array", "object", "null", "missing", "other"]);
	if (!isReadSessionRecord(value) || !allowedTypes.has(value.type)) return { type: "missing" };
	const size: ReadSessionRecord = { type: value.type };
	for (const key of ["chars", "lines", "bytes", "blocks"]) {
		if (isNonNegativeInteger(value[key])) size[key] = value[key];
	}
	return size;
}

function sanitizeReadSessionExcerpt(value: unknown, size: ReadSessionRecord, limit: number, targeted: boolean): ReadSessionRecord | undefined {
	if (!isReadSessionRecord(value)
		|| !isNonNegativeInteger(value.start)
		|| !isNonNegativeInteger(value.end)
		|| value.end < value.start
		|| !isWellFormedString(value.text)
		|| value.end - value.start !== value.text.length) return undefined;
	const text = scalarSafePrefix(value.text, limit, targeted);
	const end = value.start + text.length;
	const complete = isNonNegativeInteger(size.chars)
		? end >= size.chars
		: text.length === value.text.length && value.complete === true;
	return { start: value.start, end, text, nextCursor: complete ? null : end, complete };
}

interface SanitizedReadSessionProjection {
	messages: ReadSessionRecord[];
	authors: Map<string, ReadSessionRecord>;
	correlations: Map<string, ReadSessionRecord>;
	targeted: boolean;
	excerptLimit: number;
}

function sanitizeReadSessionProjection(envelope: ReadSessionRecord, params: ReadSessionParams): SanitizedReadSessionProjection {
	const authors = new Map<string, ReadSessionRecord>();
	if (isReadSessionRecord(envelope.authors)) {
		for (const [ref, raw] of Object.entries(envelope.authors)) {
			if (!isReadSessionRecord(raw)) continue;
			const boundedRef = boundedReadSessionString(ref, 64);
			if (!boundedRef?.text) continue;
			const author: ReadSessionRecord = {};
			for (const [key, cap] of [["kind", 32], ["id", 64], ["label", 128]] as const) {
				const bounded = boundedReadSessionString(raw[key], cap);
				if (bounded?.text) author[key] = bounded.text;
			}
			if (Object.keys(author).length > 0) authors.set(boundedRef.text, author);
		}
	}
	const correlations = new Map<string, ReadSessionRecord>();
	if (isReadSessionRecord(envelope.correlations)) {
		for (const [ref, raw] of Object.entries(envelope.correlations)) {
			if (!isReadSessionRecord(raw)) continue;
			const boundedRef = boundedReadSessionString(ref, 64);
			if (!boundedRef?.text) continue;
			const correlation: ReadSessionRecord = {};
			const name = boundedReadSessionString(raw.name, 128);
			if (name?.text) correlation.name = name.text;
			if (isNonNegativeInteger(raw.messageIndex)) correlation.messageIndex = raw.messageIndex;
			if (isNonNegativeInteger(raw.blockIndex) && raw.blockIndex <= 0xFFFFFFFF) correlation.blockIndex = raw.blockIndex;
			if (Object.keys(correlation).length > 0) correlations.set(boundedRef.text, correlation);
		}
	}

	const targeted = typeof params.result_handle === "string";
	const includeResults = params.include_tool_results === true || targeted;
	const excerptLimit = isSafeInteger(params.result_limit)
		&& params.result_limit >= 1 && params.result_limit <= READ_SESSION_RESULT_EXCERPT_MAX
		? params.result_limit : READ_SESSION_RESULT_EXCERPT_DEFAULT;
	let callCounter = 1;
	let resultCounter = 1;
	const messages = envelope.messages.map((raw: ReadSessionRecord) => {
		const role = boundedReadSessionString(raw.role, 32);
		const message: ReadSessionRecord = { index: raw.index, role: role?.text || "unknown" };
		if (raw.projectionOmitted === true) {
			message.projectionOmitted = true;
			message.toolCallCount = isNonNegativeInteger(raw.toolCallCount) ? raw.toolCallCount : 0;
			message.toolResultCount = isNonNegativeInteger(raw.toolResultCount) ? raw.toolResultCount : 0;
			return message;
		}
		if (raw.ts === null) message.ts = null;
		else {
			const ts = boundedReadSessionString(raw.ts, 64);
			if (ts) message.ts = ts.text;
		}
		const text = boundedReadSessionString(raw.text, params.verbose === true ? 4096 : 800);
		if (text) {
			message.text = text.text;
			if (text.truncated || raw.textTruncated === true) message.textTruncated = true;
		}
		for (const [sourceKey, targetKey, cap, truncatedKey] of [
			["thinking", "thinking", 512, "thinkingTruncated"],
			["thinkingSummary", "thinking", 512, "thinkingTruncated"],
			["error", "error", 512, "errorTruncated"],
			["errorSummary", "error", 512, "errorTruncated"],
			["stopReason", "stopReason", 128, "stopReasonTruncated"],
		] as const) {
			if (hasReadSessionKey(message, targetKey)) continue;
			const bounded = boundedReadSessionString(raw[sourceKey], cap);
			if (bounded) {
				message[targetKey] = bounded.text;
				if (bounded.truncated || raw[truncatedKey] === true) message[truncatedKey] = true;
			}
		}
		if (raw.status === "ok" || raw.status === "error" || raw.status === "unknown") message.status = raw.status;
		const authorRef = boundedReadSessionString(raw.authorRef, 64);
		if (authorRef?.text) message.authorRef = authorRef.text;

		const rawCalls = Array.isArray(raw.toolCalls) ? raw.toolCalls : [];
		const calls: ReadSessionRecord[] = [];
		for (const rawCall of rawCalls) {
			if (!isReadSessionRecord(rawCall)) continue;
			const name = boundedReadSessionString(rawCall.name, 128);
			const preview = boundedReadSessionString(rawCall.argumentsPreview, 512);
			const ref = boundedReadSessionString(rawCall.ref, 64);
			calls.push({
				ref: ref?.text || `t${callCounter++}`,
				name: name?.text || "unknown",
				argumentsPreview: preview?.text || "",
				argumentsTruncated: rawCall.argumentsTruncated === true || !!name?.truncated || !!preview?.truncated,
			});
		}
		if (calls.length > 0) message.toolCalls = calls;

		const results: ReadSessionRecord[] = [];
		if (Array.isArray(raw.toolResults)) {
			for (const rawResult of raw.toolResults) {
				if (!isReadSessionRecord(rawResult)) continue;
				const ref = boundedReadSessionString(rawResult.ref, 64);
				const name = boundedReadSessionString(rawResult.name, 128);
				const size = sanitizeReadSessionSize(rawResult.size);
				const result: ReadSessionRecord = {
					ref: ref?.text || `r${resultCounter++}`,
					name: name?.text || "unknown",
					status: rawResult.status === "ok" || rawResult.status === "error" || rawResult.status === "unknown"
						? rawResult.status : "unknown",
					size,
					omitted: true,
				};
				const handle = boundedReadSessionString(rawResult.handle, 64);
				if (handle?.text) result.handle = handle.text;
				if (includeResults) {
					const excerpt = sanitizeReadSessionExcerpt(rawResult.excerpt, size, excerptLimit, targeted);
					if (excerpt) {
						result.excerpt = excerpt;
						result.omitted = false;
					}
				}
				results.push(result);
			}
		}
		if (results.length > 0) message.toolResults = results;
		return message;
	});
	return { messages, authors, correlations, targeted, excerptLimit };
}

function rebuildReadSessionDictionaries(envelope: ReadSessionRecord, projection: SanitizedReadSessionProjection): void {
	const authorRefs = new Set<string>();
	const correlationRefs = new Set<string>();
	for (const message of envelope.messages) {
		if (typeof message.authorRef === "string") authorRefs.add(message.authorRef);
		if (Array.isArray(message.toolCalls)) {
			for (const call of message.toolCalls) if (typeof call.ref === "string") correlationRefs.add(call.ref);
		}
		if (Array.isArray(message.toolResults)) {
			for (const result of message.toolResults) if (typeof result.ref === "string") correlationRefs.add(result.ref);
		}
	}
	const authors: ReadSessionRecord = {};
	for (const ref of authorRefs) {
		const author = projection.authors.get(ref);
		if (author) authors[ref] = author;
	}
	const correlations: ReadSessionRecord = {};
	for (const ref of correlationRefs) {
		const correlation = projection.correlations.get(ref);
		if (correlation) correlations[ref] = correlation;
	}
	if (Object.keys(authors).length > 0) envelope.authors = authors;
	if (Object.keys(correlations).length > 0) envelope.correlations = correlations;
}

function commonReadSessionEnvelope(
	source: ReadSessionRecord,
	messages: ReadSessionRecord[],
	projection: SanitizedReadSessionProjection,
): ReadSessionRecord {
	const envelope: ReadSessionRecord = {
		total: source.total,
		returned: messages.length,
		offsetStart: messages.length > 0 ? messages[0].index : -1,
		offsetEnd: messages.length > 0 ? messages[messages.length - 1].index : -1,
		messages,
	};
	if (isNonNegativeInteger(source.matchCount)) envelope.matchCount = source.matchCount;
	if (isNonNegativeInteger(source.pageStart) && isNonNegativeInteger(source.pageCount)) {
		envelope.pageStart = source.pageStart;
		envelope.pageCount = source.pageCount;
	}
	rebuildReadSessionDictionaries(envelope, projection);
	return envelope;
}

function firstReadSessionExcerpt(envelope: ReadSessionRecord): { result: ReadSessionRecord; excerpt: ReadSessionRecord } | undefined {
	for (const message of envelope.messages) {
		if (!Array.isArray(message.toolResults)) continue;
		for (const result of message.toolResults) {
			if (isReadSessionRecord(result) && isReadSessionRecord(result.excerpt)) {
				return { result, excerpt: result.excerpt };
			}
		}
	}
	return undefined;
}

function preserveReadSessionCompletion(
	source: ReadSessionRecord,
	messages: ReadSessionRecord[],
	projection: SanitizedReadSessionProjection,
): ReadSessionRecord {
	const envelope = commonReadSessionEnvelope(source, messages, projection);
	if (hasReadSessionKey(source, "nextOffset")) envelope.nextOffset = source.nextOffset;
	if (source.partial === false) envelope.partial = false;
	if (source.partial === true) {
		envelope.partial = true;
		envelope.truncatedBy = source.truncatedBy;
		if (source.continuationRequest.kind === "page") {
			envelope.continuationRequest = { kind: "page", offset: source.continuationRequest.offset };
		} else if (source.continuationRequest.kind === "result_slice") {
			const target = firstReadSessionExcerpt(envelope);
			const cursor = isNonNegativeInteger(target?.excerpt.nextCursor)
				? target.excerpt.nextCursor : source.continuationRequest.result_cursor;
			envelope.continuationRequest = {
				kind: "result_slice",
				result_handle: target?.result.handle || source.continuationRequest.result_handle,
				result_cursor: cursor,
				result_limit: source.continuationRequest.result_limit,
			};
		} else {
			envelope.continuationRequest = { ...source.continuationRequest };
			envelope.wrapperDiagnostics = {
				omitted: true,
				actualBytes: source.wrapperDiagnostics.actualBytes,
			};
		}
	} else if (projection.targeted) {
		const target = firstReadSessionExcerpt(envelope);
		if (target && isNonNegativeInteger(target.excerpt.nextCursor) && typeof target.result.handle === "string") {
			envelope.partial = true;
			envelope.truncatedBy = "transport_budget";
			envelope.continuationRequest = {
				kind: "result_slice",
				result_handle: target.result.handle,
				result_cursor: target.excerpt.nextCursor,
				result_limit: projection.excerptLimit,
			};
		}
	}
	return envelope;
}

function resolvedReadSessionPageStart(source: ReadSessionRecord, params: ReadSessionParams): number {
	if (isNonNegativeInteger(source.pageStart)) return source.pageStart;
	if (isSafeInteger(source.nextOffset)) return Math.max(0, source.nextOffset - source.returned);
	if (isSafeInteger(params.offset)) {
		if (params.offset >= 0) return params.offset;
		if (typeof params.pattern !== "string" || params.pattern.length === 0) return Math.max(0, source.total + params.offset);
	}
	return 0;
}

function readSessionPagePartial(
	source: ReadSessionRecord,
	messages: ReadSessionRecord[],
	projection: SanitizedReadSessionProjection,
	params: ReadSessionParams,
	consumed: number,
): ReadSessionRecord {
	const envelope = commonReadSessionEnvelope(source, messages, projection);
	const nextOffset = resolvedReadSessionPageStart(source, params) + consumed;
	envelope.partial = true;
	envelope.truncatedBy = "transport_budget";
	envelope.nextOffset = nextOffset;
	envelope.continuationRequest = { kind: "page", offset: nextOffset };
	return envelope;
}

function minimizedReadSessionMessage(message: ReadSessionRecord): ReadSessionRecord {
	const minimized = structuredClone(message);
	if (Array.isArray(minimized.toolCalls)) {
		minimized.toolCalls = minimized.toolCalls.map((call: ReadSessionRecord) => ({
			...call,
			argumentsPreview: "",
			argumentsTruncated: true,
		}));
	}
	if (Array.isArray(minimized.toolResults)) {
		minimized.toolResults = minimized.toolResults.map((result: ReadSessionRecord) => {
			const bounded: ReadSessionRecord = { ...result, omitted: true };
			delete bounded.excerpt;
			return bounded;
		});
	}
	return minimized;
}

function summaryReadSessionMessage(message: ReadSessionRecord): ReadSessionRecord {
	return {
		index: message.index,
		role: message.role,
		projectionOmitted: true,
		toolCallCount: Array.isArray(message.toolCalls) ? message.toolCalls.length : 0,
		toolResultCount: Array.isArray(message.toolResults) ? message.toolResults.length : 0,
	};
}

function cloneReadSessionEnvelope(envelope: ReadSessionRecord): ReadSessionRecord {
	return JSON.parse(JSON.stringify(envelope));
}

function readSessionEnvelopeWithExcerpt(
	envelope: ReadSessionRecord,
	prefixUnits: number,
	requestedLimit: number,
): ReadSessionRecord {
	const next = cloneReadSessionEnvelope(envelope);
	delete next.nextOffset;
	delete next.wrapperDiagnostics;
	delete next.partial;
	delete next.truncatedBy;
	delete next.continuationRequest;
	const target = firstReadSessionExcerpt(next);
	if (!target) return next;
	const text = scalarSafePrefix(target.excerpt.text, prefixUnits, true);
	const end = target.excerpt.start + text.length;
	target.excerpt.text = text;
	target.excerpt.end = end;
	const complete = isNonNegativeInteger(target.result.size?.chars) && end >= target.result.size.chars;
	target.excerpt.complete = complete;
	target.excerpt.nextCursor = complete ? null : end;
	if (!complete) {
		next.partial = true;
		next.truncatedBy = "transport_budget";
		next.continuationRequest = {
			kind: "result_slice",
			result_handle: target.result.handle,
			result_cursor: end,
			result_limit: requestedLimit,
		};
	}
	return next;
}

function fitTargetedReadSessionValue(
	envelope: ReadSessionRecord,
	params: ReadSessionParams,
	requestedLimit: number,
): ReadSessionPiValue | undefined {
	const target = firstReadSessionExcerpt(envelope);
	if (!target || typeof target.result.handle !== "string") return undefined;
	let low = 0;
	let high = target.excerpt.text.length;
	let best: ReadSessionPiValue | undefined;
	while (low <= high) {
		const middle = Math.floor((low + high) / 2);
		const candidateEnvelope = readSessionEnvelopeWithExcerpt(envelope, middle, requestedLimit);
		const candidateValue = readSessionPiValue(params, candidateEnvelope);
		if (candidateValue && readSessionValueFits(candidateValue)) {
			const candidateTarget = firstReadSessionExcerpt(candidateEnvelope);
			if (target.excerpt.text.length === 0
				|| (candidateTarget && candidateTarget.excerpt.end > candidateTarget.excerpt.start)) best = candidateValue;
			low = middle + 1;
		} else {
			high = middle - 1;
		}
	}
	return best;
}

function fitReadSessionPageValue(
	source: ReadSessionRecord,
	projection: SanitizedReadSessionProjection,
	params: ReadSessionParams,
): ReadSessionPiValue | undefined {
	const retained: ReadSessionRecord[] = [];
	let consumed = 0;
	for (let index = 0; index < projection.messages.length; index += 1) {
		const sourceMessage = projection.messages[index];
		const isLast = index === projection.messages.length - 1;
		const attempt = (message: ReadSessionRecord) => {
			const messages = [...retained, message];
			const envelope = isLast
				? preserveReadSessionCompletion(source, messages, projection)
				: readSessionPagePartial(source, messages, projection, params, consumed + 1);
			return { messages, value: readSessionPiValue(params, envelope) };
		};
		let candidate = attempt(sourceMessage);
		if (!candidate.value || !readSessionValueFits(candidate.value)) candidate = attempt(minimizedReadSessionMessage(sourceMessage));
		if (candidate.value && readSessionValueFits(candidate.value)) {
			retained.splice(0, retained.length, ...candidate.messages);
			consumed += 1;
			if (isLast) return candidate.value;
			continue;
		}
		if (retained.length > 0) {
			return readSessionPiValue(params, readSessionPagePartial(source, retained, projection, params, consumed));
		}
		const summary = summaryReadSessionMessage(sourceMessage);
		const summaryEnvelope = readSessionPagePartial(source, [summary], projection, params, 1);
		const summaryValue = readSessionPiValue(params, summaryEnvelope);
		return summaryValue && readSessionValueFits(summaryValue) ? summaryValue : undefined;
	}
	return readSessionPiValue(params, preserveReadSessionCompletion(source, [], projection));
}

function readSessionRetryRequest(params: ReadSessionParams): ReadSessionRecord {
	const retry: ReadSessionRecord = { kind: "retry", retrySameRequest: true };
	const sessionId = boundedReadSessionString(params.session_id, 64);
	if (sessionId) {
		retry.session_id = sessionId.text;
		retry.sessionIdTruncated = sessionId.truncated;
	}
	for (const key of ["offset", "limit"] as const) if (isSafeInteger(params[key])) retry[key] = params[key];
	for (const key of ["case_sensitive", "verbose", "include_tool_results"] as const) {
		if (typeof params[key] === "boolean") retry[key] = params[key];
	}
	if (isSafeInteger(params.context)) retry.context = Math.max(0, Math.min(5, params.context));
	if (hasReadSessionKey(params, "pattern")) retry.patternOmitted = true;
	return retry;
}

function unrecognizedReadSessionValue(params: ReadSessionParams, body: unknown): ReadSessionPiValue {
	const envelope: ReadSessionRecord = {
		total: 0,
		returned: 0,
		offsetStart: -1,
		offsetEnd: -1,
		messages: [],
		partial: true,
		truncatedBy: "extension_return_unrecognized",
		continuationRequest: readSessionRetryRequest(params),
		wrapperDiagnostics: { omitted: true, actualBytes: readSessionSerializedBytes(body) },
	};
	return readSessionPiValue(params, envelope)!;
}

/** Deterministically fit the complete successful value, including JSON escaping. */
function fitReadSessionPiValue(params: ReadSessionParams, body: unknown): ReadSessionPiValue {
	if (isReadSessionRecord(body)) {
		const direct = readSessionPiValue(params, body);
		if (direct && readSessionValueFits(direct)) return direct;
	}
	if (!isCanonicalReadSessionEnvelope(body)) return unrecognizedReadSessionValue(params, body);

	const projection = sanitizeReadSessionProjection(body, params);
	const canonical = preserveReadSessionCompletion(body, projection.messages, projection);
	const bounded = readSessionPiValue(params, canonical);
	if (bounded && readSessionValueFits(bounded)) return bounded;

	if (projection.targeted) {
		const targeted = fitTargetedReadSessionValue(canonical, params, projection.excerptLimit);
		if (targeted && readSessionValueFits(targeted)) return targeted;
	}
	const page = fitReadSessionPageValue(body, projection, params);
	if (page && readSessionValueFits(page)) return page;
	return unrecognizedReadSessionValue(params, body);
}

type SessionPromptMode = "prompt" | "steer";

interface SessionPromptParams {
	session_id: string;
	message: string;
	mode?: SessionPromptMode;
}

async function callReadSessionEndpoint(
	params: ReadSessionParams,
): Promise<{ ok: boolean; status: number; body: any }> {
	const credsResult = readGatewayCreds();
	if ("error" in credsResult) {
		throw new Error(credsResult.error);
	}
	const { token, baseUrl } = credsResult;
	const qs = new URLSearchParams();
	if (params.offset !== undefined) qs.set("offset", String(params.offset));
	if (params.limit !== undefined) qs.set("limit", String(params.limit));
	if (params.pattern !== undefined && params.pattern !== "") qs.set("pattern", params.pattern);
	if (params.case_sensitive) qs.set("case_sensitive", "1");
	if (params.context !== undefined) qs.set("context", String(params.context));
	if (params.verbose) qs.set("verbose", "1");
	qs.set("include_tool_results", params.include_tool_results ? "1" : "0");
	if (params.result_handle !== undefined) qs.set("result_handle", params.result_handle);
	if (params.result_cursor !== undefined) qs.set("result_cursor", String(params.result_cursor));
	if (params.result_limit !== undefined) qs.set("result_limit", String(params.result_limit));
	const suffix = qs.toString() ? `?${qs.toString()}` : "";
	const headers: Record<string, string> = {
		"Authorization": `Bearer ${token}`,
		"Content-Type": "application/json",
	};
	const caller = getCallerSessionId();
	if (caller) headers["x-bobbit-session-id"] = caller;
	const resp = await fetch(
		`${baseUrl}/api/sessions/${encodeURIComponent(params.session_id)}/transcript${suffix}`,
		{ method: "GET", headers },
	);
	let body: any = undefined;
	try { body = await resp.json(); } catch { body = undefined; }
	return { ok: resp.ok, status: resp.status, body };
}

async function callSessionPromptEndpoint(params: SessionPromptParams): Promise<unknown> {
	const credsResult = readGatewayCreds();
	if ("error" in credsResult) {
		throw new Error(credsResult.error);
	}
	const extraHeaders: Record<string, string> = {};
	const caller = getCallerSessionId();
	if (caller) extraHeaders["x-bobbit-session-id"] = caller;
	const sessionSecret = process.env.BOBBIT_SESSION_SECRET;
	if (sessionSecret) extraHeaders["X-Bobbit-Session-Secret"] = sessionSecret;
	const body: Record<string, unknown> = { message: params.message, mode: params.mode ?? "prompt" };
	return apiCall(
		credsResult,
		"POST",
		`/api/sessions/${encodeURIComponent(params.session_id)}/prompt`,
		body,
		{ extraHeaders },
	);
}

// ── Extension registration ──

const extension: ExtensionFactory = (pi) => {
	const ownerSessionId = getCallerSessionId();
	const isTeamLead = !!process.env.BOBBIT_GOAL_ID;
	// The unforgeable per-session capability secret. Only this session's process
	// holds it (injected as env exactly where BOBBIT_SESSION_ID is). The
	// `/orchestrate/*` routes resolve it back to the AUTHENTIC caller and require
	// the caller to BE the owner — so a token-holder cannot drive a foreign
	// owner's children. See src/server/auth/session-secret.ts.
	const sessionSecret = process.env.BOBBIT_SESSION_SECRET;

	/** POST/GET the orchestrate route family against the OWNER session. */
	async function orchestrate(method: string, verb: string, body?: unknown): Promise<unknown> {
		const credsResult = readGatewayCreds();
		if ("error" in credsResult) {
			throw new Error(credsResult.error);
		}
		const owner = ownerSessionId || "unknown";
		const extraHeaders: Record<string, string> = {};
		if (sessionSecret) extraHeaders["X-Bobbit-Session-Secret"] = sessionSecret;
		return apiCall(credsResult, method, `/api/sessions/${owner}/orchestrate/${verb}`, body, { extraHeaders });
	}

	async function orchestrateDetailed(method: string, verb: string, body?: unknown): Promise<{ ok: boolean; status: number; body: unknown }> {
		const credsResult = readGatewayCreds();
		if ("error" in credsResult) throw new Error(credsResult.error);
		const owner = ownerSessionId || "unknown";
		const extraHeaders: Record<string, string> = {};
		if (sessionSecret) extraHeaders["X-Bobbit-Session-Secret"] = sessionSecret;
		const { ok, status, body: responseBody } = await apiCallDetailed(
			credsResult,
			method,
			`/api/sessions/${owner}/orchestrate/${verb}`,
			body,
			{ extraHeaders },
		);
		return { ok, status, body: responseBody };
	}

	const dismissStatuses = new Set(["dismissed", "already-dismissed", "not-owned", "not-found", "failed"]);

	function isStructuredDismissResult(value: unknown): value is { ok: boolean; status: string; sessionId: string; message: string; retryable: boolean } {
		if (!value || typeof value !== "object") return false;
		const v = value as Record<string, unknown>;
		return typeof v.ok === "boolean"
			&& typeof v.status === "string"
			&& dismissStatuses.has(v.status)
			&& typeof v.sessionId === "string"
			&& typeof v.message === "string"
			&& typeof v.retryable === "boolean";
	}

	function responseErrorText(body: unknown, fallback: string): string {
		if (body && typeof body === "object" && "error" in body) return String((body as Record<string, unknown>).error);
		if (typeof body === "string" && body.trim()) return body;
		return fallback;
	}

	function normalizeDismissResponse(resp: { ok: boolean; status: number; body: unknown }, sessionId: string) {
		if (isStructuredDismissResult(resp.body)) return resp.body;
		const retryable = resp.status === 401 || resp.status === 408 || resp.status === 429 || resp.status >= 500;
		return {
			ok: false,
			status: "failed",
			sessionId,
			message: resp.ok
				? `team_dismiss returned an unstructured response (HTTP ${resp.status}).`
				: `team_dismiss request failed (HTTP ${resp.status}): ${responseErrorText(resp.body, "unstructured gateway response")}`,
			retryable,
			httpStatus: resp.status,
			response: resp.body,
		};
	}

	function dismissText(result: any): string {
		return [
			`team_dismiss ${result?.status ?? "unknown"} for ${result?.sessionId ?? "unknown session"}`,
			result?.message ? `message: ${result.message}` : undefined,
			`retryable: ${result?.retryable === true ? "true" : "false"}`,
			"",
			JSON.stringify(result, null, 2),
		].filter(Boolean).join("\n");
	}

	function ok(text: string, details?: unknown) {
		return { content: [{ type: "text" as const, text }], details };
	}

	function fail(msg: string) {
		return { content: [{ type: "text" as const, text: msg }], details: undefined, isError: true };
	}

	// ── read_session (registered for every session) ──
	pi.registerTool({
		name: "read_session",
		label: "Read Session",
		description: "Read another session's transcript compact-first, with regex paging and bounded result slices.",
		promptSnippet:
			"read_session - Inspect another session compact-first; narrow by regex/index, then slice one result by handle if needed.",
		promptGuidelines: [
			"Fetch session metadata once, then start with a small compact tail or regex page; compact rows include tool names, statuses, indexes, and result sizes",
			"Follow returned page offsets without overlapping prior windows, and stop as soon as the diagnostic question is answered",
			"Retrieve result text only by returned result_handle with a bounded result_cursor/result_limit slice; continue from excerpt.nextCursor only if needed",
			"verbose:true or include_tool_results:true requires an explicit integer limit <= 10; neither flag permits an unbounded result body",
		],
		parameters: Type.Object({
			session_id: Type.String(),
			offset: Type.Optional(Type.Number({ description: "Default 0. Negative indexes from end." })),
			limit: Type.Optional(Type.Number({ description: "Default 20; heavy flags require an explicit integer 1..10." })),
			pattern: Type.Optional(Type.String({ description: "Regex filter over full server-side message, call, and result search text." })),
			case_sensitive: Type.Optional(Type.Boolean()),
			context: Type.Optional(Type.Number({ description: "Expand each match by ±N neighbours (0..5)." })),
			verbose: Type.Optional(Type.Boolean({ description: "Expanded semantic blocks; requires explicit integer limit <= 10." })),
			include_tool_results: Type.Optional(Type.Boolean({ description: "Bounded result excerpts; default false. Requires explicit integer limit <= 10." })),
			result_handle: Type.Optional(Type.String({ description: "Handle from result metadata for one targeted bounded excerpt." })),
			result_cursor: Type.Optional(Type.Number({ description: "UTF-16 cursor for result_handle; default 0." })),
			result_limit: Type.Optional(Type.Number({ description: "Requested UTF-16 units for a result slice; default 4096, range 1..8192." })),
		}),

		async execute(_toolCallId, params) {
			const guardError = contextHeavyLimitError(
				"read_session",
				params as Record<string, unknown>,
				true,
			);
			if (guardError) return fail(JSON.stringify(guardError));

			let result: { ok: boolean; status: number; body: any };
			try {
				result = await callReadSessionEndpoint(params as ReadSessionParams);
			} catch (err: any) {
				return {
					isError: true,
					content: [{ type: "text", text: JSON.stringify({ error: "transcript_unavailable", detail: err?.message ?? String(err) }) }],
					details: undefined,
				};
			}
			if (!result.ok) {
				const code = (result.body && typeof result.body.error === "string") ? result.body.error : "transcript_unavailable";
				const detail = (result.body && typeof result.body.detail === "string") ? result.body.detail : undefined;
				return {
					isError: true,
					content: [{ type: "text", text: JSON.stringify(detail ? { error: code, detail } : { error: code }) }],
					details: undefined,
				};
			}
			return fitReadSessionPiValue(params as ReadSessionParams, result.body);
		},
	});

	// ── session_prompt (registered for every session; grantPolicy: never in YAML) ──
	pi.registerTool({
		name: "session_prompt",
		label: "Prompt Session",
		description: "Prompt or steer any live agent session by id. Default mode is prompt.",
		promptSnippet:
			"session_prompt - Prompt any live session by id, or set mode:'steer' to redirect a running turn. Not exposed unless explicitly allowed.",
		promptGuidelines: [
			"Default mode is prompt: starts or queues a normal user prompt for interactive sessions",
			"Use mode:'steer' to inject into a streaming session, or queue a steered prompt for non-streaming sessions",
			"Targets any live, non-archived session by id when this tool is explicitly enabled",
			"Normal prompt mode rejects non-interactive/reviewer sessions; steer mode may redirect them while streaming",
		],
		parameters: Type.Object({
			session_id: Type.String(),
			message: Type.String(),
			mode: Type.Optional(Type.Union([Type.Literal("prompt"), Type.Literal("steer")], { description: "Delivery mode. Default prompt.", default: "prompt" })),
		}),
		async execute(_toolCallId, params) {
			try {
				const response = await callSessionPromptEndpoint(params as SessionPromptParams);
				return ok(JSON.stringify(response, null, 2), response);
			} catch (e: any) { return fail(e?.message ?? String(e)); }
		},
	});

	// ── team_delegate ──
	pi.registerTool({
		name: "team_delegate",
		label: "Delegate to Agent",
		description: "Spawn a child agent in your worktree. Blocks until it finishes; non_blocking to detach.",
		promptSnippet:
			"team_delegate - Spawn a child agent in your worktree with isolated context. Blocking one-shot by default.",
		promptGuidelines: [
			"Use team_delegate when a task benefits from isolated context (e.g. code review, independent analysis)",
			"The child has full tool access but cannot spawn its own children, and cannot see this conversation",
			"Provide clear, self-contained instructions — pass file paths and requirements in context",
			"Use 'parallel' to run multiple children concurrently; blocking mode waits for all to finish",
			"non_blocking:true detaches — the child shares your worktree for an open-ended life (last-write-wins); orchestrate it with team_wait/team_prompt/team_dismiss",
		],
		parameters: Type.Object({
			instructions: Type.Optional(Type.String({ description: "Required for a single child; optional with parallel." })),
			parallel: Type.Optional(Type.Array(
				Type.Object({
					instructions: Type.String(),
					context: Type.Optional(Type.Record(Type.String(), Type.String())),
				}),
				{ description: "Run multiple children concurrently." },
			)),
			context: Type.Optional(Type.Record(Type.String(), Type.String())),
			role: Type.Optional(Type.String({ description: "Optional role to inject into the child." })),
			model: Type.Optional(Type.String({ description: "Child model. Default: inherit your current model." })),
			thinking_level: Type.Optional(Type.String({ description: "Child thinking level. Default: inherit yours." })),
			read_only: Type.Optional(Type.Boolean({ description: "Spawn a read-only child (cannot edit files)." })),
			non_blocking: Type.Optional(Type.Boolean({ description: "Detach instead of blocking; orchestrate via team_wait." })),
			timeout_minutes: Type.Optional(Type.Number({ description: "Blocking-mode timeout. Default 10." })),
		}),

		async execute(_toolCallId, params) {
			const timeoutMs = (params.timeout_minutes ?? 10) * 60_000;
			const hasParallel = Array.isArray(params.parallel) && params.parallel.length > 0;
			if (!hasParallel && !params.instructions) {
				return fail("Error: 'instructions' is required for a single child. Use 'parallel' for multiple children.");
			}

			const common: Record<string, unknown> = {};
			if (params.role) common.role = params.role;
			if (params.model) common.model = params.model;
			if (params.thinking_level) common.thinking_level = params.thinking_level;
			if (params.read_only) common.read_only = params.read_only;
			if (params.context) common.context = params.context;

			// ── Non-blocking: spawn and return immediately ──
			if (params.non_blocking) {
				const body: Record<string, unknown> = { ...common };
				if (hasParallel) body.parallel = params.parallel;
				else body.instructions = params.instructions;
				let resp: SpawnRouteResponse;
				try {
					resp = (await orchestrate("POST", "spawn", body)) as SpawnRouteResponse;
				} catch (e: any) {
					return fail(e?.message ?? String(e));
				}
				const children = normalizeSpawned(resp);
				const instrFor = (i: number) =>
					hasParallel ? firstLine(params.parallel![i].instructions) : firstLine(params.instructions || "");
				const details: DelegateDetails = {
					delegates: children.map((c, i) => ({
						id: (c.sessionId || "").slice(0, 12) || "?",
						sessionId: c.sessionId || "",
						instructions: c.title || instrFor(i),
						status: "running",
						durationMs: 0,
					})),
				};
				const lines = [
					`Spawned ${children.length} non-blocking child agent(s):`,
					...children.map((c, i) => `  • ${c.sessionId} — ${c.title || instrFor(i)}`),
					"",
					"They run in YOUR worktree (shared, last-write-wins). Call team_wait to collect results, team_prompt to follow up, or team_dismiss to stop them.",
				];
				return ok(lines.join("\n"), details);
			}

			// ── Blocking one-shot: spawn → wait(all) → auto-dismiss (server-side) ──
			const body: Record<string, unknown> = { ...common, timeout_ms: timeoutMs };
			if (hasParallel) body.parallel = params.parallel;
			else body.instructions = params.instructions;

			let resp: DelegateRouteResponse;
			try {
				resp = (await orchestrate("POST", "delegate", body)) as DelegateRouteResponse;
			} catch (e: any) {
				return fail(e?.message ?? String(e));
			}

			// A route-level failure after the chunked 200 headers (spawn/wait crash)
			// is carried in the body with no delegates collected — surface it.
			if (typeof resp?.error === "string" && resp.error && (!Array.isArray(resp?.delegates) || resp.delegates.length === 0)) {
				return fail(resp.error);
			}

			const delegates = Array.isArray(resp?.delegates) ? resp.delegates : [];
			const instrFor = (i: number) =>
				hasParallel ? firstLine(params.parallel![i].instructions) : firstLine(params.instructions || "");

			const details: DelegateDetails = {
				delegates: delegates.map((d, i) => ({
					id: d.id || (d.sessionId || "").slice(0, 12) || "?",
					sessionId: d.sessionId || "",
					instructions: instrFor(i),
					status: cardStatus(d.status),
					durationMs: d.durationMs || 0,
				})),
			};

			const lines: string[] = [];
			if (delegates.length <= 1) {
				const d = delegates[0];
				lines.push(`**Status:** ${d?.status ?? "failed"} (${Math.round((d?.durationMs ?? 0) / 1000)}s)`);
				if (d?.error) lines.push(`**Error:** ${d.error}`);
				if (d?.output) {
					const out = d.output.length > 5000 ? d.output.slice(0, 5000) + "\n...(truncated)" : d.output;
					lines.push("", out);
				}
			} else {
				delegates.forEach((d, i) => {
					const ic = d.status === "completed" ? "✓" : d.status === "timeout" ? "⏱" : "✗";
					lines.push(`### ${ic} Child ${i + 1} (${d.status}, ${Math.round((d.durationMs || 0) / 1000)}s)`);
					if (d.error) lines.push(`**Error:** ${d.error}`);
					if (d.output) {
						const out = d.output.length > 3000 ? d.output.slice(0, 3000) + "\n...(truncated)" : d.output;
						lines.push("```\n" + out + "\n```");
					}
					lines.push("");
				});
				lines.push(resp.summary ?? `**Summary:** ${delegates.filter(d => d.status === "completed").length}/${delegates.length} children completed.`);
			}
			return ok(lines.join("\n"), details);
		},
	});

	// ── team_wait ──
	pi.registerTool({
		name: "team_wait",
		label: "Wait for Child Agent",
		description: "Wait for your child agents; returns when the first becomes idle, with the status of the rest.",
		promptSnippet:
			"team_wait - Wait for your child agents; returns on the first idle child plus status of the others.",
		promptGuidelines: [
			"Returns as soon as ONE awaited child becomes idle (or settles) — process it, then call team_wait again for the rest",
			"Omit child_session_ids to await all your live children",
			"Use read_session on the returned child to read its full transcript",
		],
		parameters: Type.Object({
			child_session_ids: Type.Optional(Type.Array(Type.String(), { description: "Children to await. Default: all your live children." })),
			timeout_minutes: Type.Optional(Type.Number({ description: "Heartbeat timeout. Default 10." })),
		}),

		async execute(_toolCallId, params) {
			const body: Record<string, unknown> = {};
			if (params.child_session_ids && params.child_session_ids.length > 0) {
				body.childSessionIds = params.child_session_ids;
			}
			body.timeout_ms = (params.timeout_minutes ?? 10) * 60_000;
			let resp: WaitRouteResponse;
			try {
				resp = (await orchestrate("POST", "wait", body)) as WaitRouteResponse;
			} catch (e: any) {
				return fail(e?.message ?? String(e));
			}
			// The chunked /orchestrate/wait route returns HTTP 200 with `{error}` for a
			// post-headers failure (e.g. NOT_OWN_CHILD). Surface it as a tool error
			// rather than formatting an empty/misleading "all settled" result.
			if (typeof resp?.error === "string" && resp.error) {
				return fail(resp.error);
			}
			// Single source of truth for the wording is the SERVER (formatWaitText);
			// the extension only derives the renderer `details` from the statuses.
			// formatWaitResult.text is a defensive fallback if the server omits it.
			const built = formatWaitResult(resp);
			return ok(typeof resp.text === "string" && resp.text ? resp.text : built.text, built.details);
		},
	});

	// ── Own-children orchestration verbs ──
	// Goal/team-lead sessions get these (goal-scoped) from team/extension.ts;
	// non-team-lead sessions get them here, routed through /orchestrate/* to
	// operate over the caller's OWN child agents.
	if (!isTeamLead) {
		pi.registerTool({
			name: "team_prompt",
			label: "Prompt Child Agent",
			description: "Prompt or steer one of your child agents. Default mode is steer; use mode:'prompt' for next-turn queue semantics.",
			promptSnippet: "team_prompt - Prompt/steer your child agent. Default mode:'steer'; use mode:'prompt' to run/queue a normal next-turn prompt.",
			parameters: Type.Object({
				session_id: Type.String(),
				message: Type.String(),
				mode: Type.Optional(Type.Union([Type.Literal("prompt"), Type.Literal("steer")], { description: "Delivery mode. Default steer.", default: "steer" })),
			}),
			async execute(_id, params) {
				try {
					const body: Record<string, unknown> = { childSessionId: params.session_id, message: params.message, mode: params.mode ?? "steer" };
					return ok(JSON.stringify(await orchestrate("POST", "prompt", body), null, 2));
				} catch (e: any) { return fail(e?.message ?? String(e)); }
			},
		});

		pi.registerTool({
			name: "team_steer",
			label: "Steer Child Agent",
			description: "Backward-compatible mid-turn redirect for a streaming child. Fails if idle; prefer team_prompt(mode:'steer') for routine nudges.",
			promptSnippet: "team_steer - Legacy steer for a running child (mid-turn only); prefer team_prompt(mode:'steer') unless you need compatibility.",
			parameters: Type.Object({
				session_id: Type.String(),
				message: Type.String(),
			}),
			async execute(_id, params) {
				try {
					return ok(JSON.stringify(await orchestrate("POST", "steer", { childSessionId: params.session_id, message: params.message }), null, 2));
				} catch (e: any) { return fail(e?.message ?? String(e)); }
			},
		});

		pi.registerTool({
			name: "team_abort",
			label: "Abort Child Agent",
			description: "Force-abort a stuck child agent; kills and restarts its process.",
			promptSnippet: "team_abort - Force-abort a stuck child agent by session ID.",
			parameters: Type.Object({
				session_id: Type.String(),
			}),
			async execute(_id, params) {
				try {
					return ok(JSON.stringify(await orchestrate("POST", "abort", { childSessionId: params.session_id }), null, 2));
				} catch (e: any) { return fail(e?.message ?? String(e)); }
			},
		});

		pi.registerTool({
			name: "team_dismiss",
			label: "Dismiss Child Agent",
			description: "Dismiss your child agent by session ID; returns structured status/retryable details and treats already-dismissed as idempotent.",
			promptSnippet: "team_dismiss - Dismiss a child agent by session ID. Inspect status/retryable; already-dismissed is idempotent success and should not be retried.",
			parameters: Type.Object({
				session_id: Type.String(),
			}),
			async execute(_id, params) {
				try {
					const targetSessionId = params.session_id;
					const resp = await orchestrateDetailed("POST", "dismiss", { childSessionId: targetSessionId });
					const result = normalizeDismissResponse(resp, targetSessionId);
					return { content: [{ type: "text" as const, text: dismissText(result) }], details: result, isError: result.status === "failed" };
				} catch (e: any) { return fail(e?.message ?? String(e)); }
			},
		});
	}
};

// ── Pure formatting helpers (module scope for testability) ──

function normalizeSpawned(resp: SpawnRouteResponse): Array<{ sessionId: string; title?: string }> {
	if (Array.isArray(resp?.children)) {
		return resp.children.map((c) => ({ sessionId: c.sessionId || c.childSessionId || c.id || "", title: c.title }));
	}
	const single = resp?.childSessionId || resp?.sessionId;
	if (single) return [{ sessionId: single, title: resp?.title }];
	return [];
}

/** Build the §9 team_wait result text + renderer details from a WaitResult. */
function formatWaitResult(wr: WaitRouteResponse): { text: string; details: DelegateDetails } {
	const statuses = Array.isArray(wr?.statuses) ? wr.statuses : [];
	const byId = new Map(statuses.map((s) => [s.sessionId, s]));
	const titleOf = (id: string) => byId.get(id)?.title || id.slice(0, 12);

	const lines: string[] = [];
	const first = wr.firstIdle;
	if (first) {
		const fstatus = byId.get(first)?.status;
		const header = fstatus && TERMINAL_STATUSES.has(fstatus) ? "First settled child" : "First idle child";
		lines.push(`${header}: ${first} ("${titleOf(first)}")`);
		if (wr.outputTail) {
			lines.push("--- output tail ---");
			lines.push(wr.outputTail);
		}
		lines.push("");
	}

	lines.push(`Awaited children (${statuses.length}):`);
	for (const s of statuses) {
		lines.push(`  • ${s.sessionId} "${titleOf(s.sessionId)}" — ${s.status}`);
	}

	const remaining = typeof wr.remaining === "number"
		? wr.remaining
		: statuses.filter((s) => !SETTLED_STATUSES.has(s.status)).length;
	if (remaining > 0) {
		// Enumerate the remaining (non-settled) ids so a literal re-call awaits only
		// those — omitting child_session_ids defaults to ALL tracked children and
		// would re-return the same already-idle child.
		const remainingIds = statuses.filter((s) => !SETTLED_STATUSES.has(s.status)).map((s) => s.sessionId);
		lines.push(`Remaining: ${remaining} child(ren) not yet settled.`);
		lines.push(`➜ Process this result now, then call team_wait again to await the remaining children — pass child_session_ids: [${remainingIds.join(", ")}].`);
	} else {
		lines.push("All awaited children are settled.");
	}

	const details: DelegateDetails = {
		delegates: statuses.map((s) => ({
			id: s.sessionId.slice(0, 12),
			sessionId: s.sessionId,
			instructions: titleOf(s.sessionId),
			status: cardStatus(s.status),
			durationMs: 0,
		})),
	};
	return { text: lines.join("\n"), details };
}

export default extension;
