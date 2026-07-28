import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { bobbitStateDir } from "../bobbit-dir.js";

/** Maximum serialized UTF-8 size of the complete value returned to Pi. */
export const READ_SESSION_FINAL_RESULT_MAX_BYTES = 50 * 1024;

/**
 * Generate the immutable Pi result boundary used by Bobbit tools.
 *
 * Pi gives every loaded extension its own registration API and private tool
 * map, so registration wrapping alone cannot see a read_session contributed by
 * another extension. A shared runner seam therefore retains the legacy error
 * bridge across private maps and canonicalizes the final result only after the
 * complete tool_result listener chain, independent of extension ordering.
 */
export function generateToolResultErrorBridgeExtension(): string {
	return `import { createHash } from "node:crypto";

const READ_SESSION_FINAL_RESULT_MAX_BYTES = ${READ_SESSION_FINAL_RESULT_MAX_BYTES};
const RESULT_EXCERPT_DEFAULT = 4096;
const RESULT_EXCERPT_MAX = 8192;
const READ_SESSION_RESULT_BOUNDARY_MARKER = Symbol.for("bobbit.read_session.result-boundary.v1");
const SHARED_RUNNER_BOUNDARY_MARKER = Symbol.for("bobbit.tool-result.shared-runner-boundary.v3");

function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value, key) {
  return isObject(value) && Object.prototype.hasOwnProperty.call(value, key);
}

function isSafeInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isNonNegativeInteger(value) {
  return isSafeInteger(value) && value >= 0;
}

function isWellFormed(value) {
  if (typeof value !== "string") return false;
  for (let i = 0; i < value.length; i += 1) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (i + 1 >= value.length) return false;
      const low = value.charCodeAt(i + 1);
      if (low < 0xdc00 || low > 0xdfff) return false;
      i += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function scalarPrefix(value, maxUnits, guaranteeProgress) {
  if (!isWellFormed(value) || maxUnits < 0) return "";
  if (value.length <= maxUnits) return value;
  let end = Math.max(0, Math.min(value.length, maxUnits));
  if (end > 0) {
    const last = value.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  }
  if (end === 0 && guaranteeProgress && value.length >= 2) {
    const high = value.charCodeAt(0);
    const low = value.charCodeAt(1);
    if (high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff) end = 2;
  }
  return value.slice(0, end);
}

function boundedString(value, maxUnits) {
  if (!isWellFormed(value)) return undefined;
  const text = scalarPrefix(value, maxUnits, false);
  return { text, truncated: text.length !== value.length };
}

function serializedByteLength(value) {
  try {
    const json = JSON.stringify(value);
    return typeof json === "string" ? Buffer.byteLength(json, "utf8") : 0;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function fits(value) {
  return serializedByteLength(value) <= READ_SESSION_FINAL_RESULT_MAX_BYTES;
}

function isErroredToolResult(value) {
  return isObject(value) && (value.isError === true || value.is_error === true);
}

function stringifyBlock(block) {
  if (typeof block === "string") return block;
  if (!isObject(block)) return String(block);
  if (typeof block.text === "string") return block.text;
  if (typeof block.content === "string") return block.content;
  try { return JSON.stringify(block); } catch { return String(block); }
}

function messageFromToolResult(result) {
  if (!isObject(result)) return String(result);
  const content = result.content;
  if (Array.isArray(content)) {
    const text = content.map(stringifyBlock).filter(Boolean).join("\\n").trim();
    if (text) return text;
  }
  if (typeof content === "string" && content.trim()) return content.trim();
  if (typeof result.error === "string" && result.error.trim()) return result.error.trim();
  if (typeof result.message === "string" && result.message.trim()) return result.message.trim();
  try { return JSON.stringify(result); } catch { return "Tool returned an errored result."; }
}

function validRetryRequest(value) {
  if (!isObject(value) || value.kind !== "retry" || value.retrySameRequest !== true) return false;
  const allowed = new Set(["kind", "retrySameRequest", "session_id", "sessionIdTruncated", "offset", "limit", "case_sensitive", "verbose", "include_tool_results", "context", "patternOmitted"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return false;
  if (hasOwn(value, "session_id") && !isWellFormed(value.session_id)) return false;
  if (hasOwn(value, "sessionIdTruncated") && typeof value.sessionIdTruncated !== "boolean") return false;
  for (const key of ["offset", "limit"]) if (hasOwn(value, key) && !isSafeInteger(value[key])) return false;
  for (const key of ["case_sensitive", "verbose", "include_tool_results", "patternOmitted"]) {
    if (hasOwn(value, key) && typeof value[key] !== "boolean") return false;
  }
  return !hasOwn(value, "context") || (isSafeInteger(value.context) && value.context >= 0 && value.context <= 5);
}

function resultSliceContinuations(messages) {
  const found = [];
  for (const message of messages) {
    if (!isObject(message) || !Array.isArray(message.toolResults)) continue;
    for (const result of message.toolResults) {
      if (isObject(result) && isObject(result.excerpt) && isNonNegativeInteger(result.excerpt.nextCursor)) {
        found.push({ result, cursor: result.excerpt.nextCursor });
      }
    }
  }
  return found;
}

function validSummaryRows(messages, allowed) {
  for (const message of messages) {
    const hasSummaryField = hasOwn(message, "projectionOmitted") || hasOwn(message, "toolCallCount") || hasOwn(message, "toolResultCount");
    if (!hasSummaryField) continue;
    if (!allowed || message.projectionOmitted !== true
      || !isNonNegativeInteger(message.toolCallCount) || !isNonNegativeInteger(message.toolResultCount)) return false;
  }
  return true;
}

function validEnvelope(value, expectedSessionId) {
  if (!isObject(value)) return false;
  if (hasOwn(value, "session_id") && (typeof value.session_id !== "string" || value.session_id !== expectedSessionId)) return false;
  if (!isNonNegativeInteger(value.total) || !isNonNegativeInteger(value.returned)) return false;
  if (!isSafeInteger(value.offsetStart) || !isSafeInteger(value.offsetEnd)) return false;
  if (!Array.isArray(value.messages) || value.returned !== value.messages.length) return false;
  if (value.messages.some((message) => !isObject(message) || !isNonNegativeInteger(message.index) || !isWellFormed(message.role))) return false;
  if (hasOwn(value, "matchCount") && !isNonNegativeInteger(value.matchCount)) return false;
  const hasPageStart = hasOwn(value, "pageStart");
  const hasPageCount = hasOwn(value, "pageCount");
  if (hasPageStart !== hasPageCount) return false;
  if (hasPageStart && (!isNonNegativeInteger(value.pageStart)
    || !isNonNegativeInteger(value.pageCount)
    || value.pageStart > value.pageCount
    || value.returned > value.pageCount - value.pageStart)) return false;
  if (hasOwn(value, "nextOffset") && value.nextOffset !== null && !isSafeInteger(value.nextOffset)) return false;
  if (hasPageStart && isSafeInteger(value.nextOffset)
    && value.nextOffset !== value.pageStart + value.returned) return false;
  if (hasOwn(value, "authors") && !isObject(value.authors)) return false;
  if (hasOwn(value, "correlations") && !isObject(value.correlations)) return false;

  if (value.partial === undefined || value.partial === false) {
    return validSummaryRows(value.messages, false)
      && !hasOwn(value, "truncatedBy") && !hasOwn(value, "continuationRequest") && !hasOwn(value, "wrapperDiagnostics");
  }
  if (value.partial !== true) return false;

  if (value.truncatedBy === "transport_budget") {
    if (!isObject(value.continuationRequest) || hasOwn(value, "wrapperDiagnostics")) return false;
    if (value.continuationRequest.kind === "page") {
      if (Object.keys(value.continuationRequest).some((key) => key !== "kind" && key !== "offset")) return false;
      return isNonNegativeInteger(value.continuationRequest.offset)
        && value.nextOffset === value.continuationRequest.offset
        && validSummaryRows(value.messages, true);
    }
    if (value.continuationRequest.kind === "result_slice") {
      const continuation = value.continuationRequest;
      const allowed = new Set(["kind", "result_handle", "result_cursor", "result_limit"]);
      if (Object.keys(continuation).some((key) => !allowed.has(key))
        || !isWellFormed(continuation.result_handle) || !isNonNegativeInteger(continuation.result_cursor)
        || !isSafeInteger(continuation.result_limit) || continuation.result_limit < 1 || continuation.result_limit > RESULT_EXCERPT_MAX
        || hasOwn(value, "nextOffset")) return false;
      const slices = resultSliceContinuations(value.messages);
      return validSummaryRows(value.messages, false)
        && slices.length === 1 && slices[0].cursor === continuation.result_cursor
        && slices[0].result.handle === continuation.result_handle;
    }
    return false;
  }

  if (value.truncatedBy === "extension_return_unrecognized") {
    return value.total === 0 && value.returned === 0 && value.offsetStart === -1 && value.offsetEnd === -1
      && value.messages.length === 0 && !hasOwn(value, "matchCount") && !hasOwn(value, "nextOffset")
      && !hasOwn(value, "pageStart") && !hasOwn(value, "pageCount")
      && !hasOwn(value, "authors") && !hasOwn(value, "correlations")
      && validRetryRequest(value.continuationRequest)
      && isObject(value.wrapperDiagnostics)
      && Object.keys(value.wrapperDiagnostics).every((key) => key === "omitted" || key === "actualBytes")
      && value.wrapperDiagnostics.omitted === true
      && isNonNegativeInteger(value.wrapperDiagnostics.actualBytes);
  }
  return false;
}

function parseEnvelopeText(text, expectedSessionId) {
  if (typeof text !== "string") return undefined;
  try {
    const candidate = JSON.parse(text);
    return validEnvelope(candidate, expectedSessionId) ? candidate : undefined;
  } catch {
    return undefined;
  }
}

function recoverEnvelope(result, params) {
  if (!isObject(result)) return undefined;
  const expectedSessionId = typeof params.session_id === "string" ? params.session_id : undefined;
  if (typeof expectedSessionId !== "string") return undefined;
  if (isObject(result.details) && hasOwn(result.details, "session_id")
    && (typeof result.details.session_id !== "string" || result.details.session_id !== expectedSessionId)) return undefined;

  if (validEnvelope(result, expectedSessionId)) return result;
  if (Array.isArray(result.content)) {
    for (const block of result.content) {
      if (!isObject(block) || block.type !== "text") continue;
      const parsed = parseEnvelopeText(block.text, expectedSessionId);
      if (parsed) return parsed;
    }
  }
  if (isObject(result.details) && validEnvelope(result.details.envelope, expectedSessionId)) return result.details.envelope;
  if (isObject(result.details)) {
    const details = result.details;
    const legacy = {
      total: details.total,
      returned: details.returned,
      offsetStart: details.offsetStart,
      offsetEnd: details.offsetEnd,
      messages: details.messages,
      ...(hasOwn(details, "matchCount") ? { matchCount: details.matchCount } : {}),
      ...(hasOwn(details, "nextOffset") ? { nextOffset: details.nextOffset } : {}),
    };
    if (validEnvelope(legacy, expectedSessionId)) return legacy;
  }
  return undefined;
}

function sanitizeSize(value) {
  const allowedTypes = new Set(["string", "array", "object", "null", "missing", "other"]);
  if (!isObject(value) || !allowedTypes.has(value.type)) return { type: "missing" };
  const out = { type: value.type };
  for (const key of ["chars", "lines", "bytes", "blocks"]) {
    if (isNonNegativeInteger(value[key])) out[key] = value[key];
  }
  return out;
}

function sanitizedRef(value, fallback, pattern) {
  const bounded = boundedString(value, 64);
  return bounded && pattern.test(bounded.text) ? bounded.text : fallback;
}

function nonEmptyBoundedString(value, maxUnits) {
  const bounded = boundedString(value, maxUnits);
  return bounded && bounded.text.length > 0 ? bounded : undefined;
}

function sanitizeToolCall(call, fallbackRef) {
  if (!isObject(call)) return undefined;
  const name = nonEmptyBoundedString(call.name, 128) || nonEmptyBoundedString(call.toolName, 128) || { text: "unknown", truncated: false };
  const previewSource = typeof call.argumentsPreview === "string" ? call.argumentsPreview : call.inputPreview;
  const preview = boundedString(previewSource, 512);
  const out = {
    ref: sanitizedRef(call.ref, fallbackRef, /^t[1-9][0-9]*$/),
    name: name.text || "unknown",
    argumentsPreview: preview ? preview.text : "",
    argumentsTruncated: call.argumentsTruncated === true || !!name.truncated || !!preview?.truncated,
  };
  return out;
}

function sanitizeExcerpt(value, size, maxUnits, guaranteeProgress) {
  if (!isObject(value) || !isNonNegativeInteger(value.start) || !isNonNegativeInteger(value.end)
    || value.end < value.start || !isWellFormed(value.text) || value.end - value.start !== value.text.length) return undefined;
  const text = scalarPrefix(value.text, maxUnits, guaranteeProgress);
  const end = value.start + text.length;
  const knownChars = isNonNegativeInteger(size.chars) ? size.chars : undefined;
  const complete = knownChars !== undefined ? end >= knownChars : (text.length === value.text.length && value.complete === true);
  return { start: value.start, end, text, nextCursor: complete ? null : end, complete };
}

function sanitizeToolResult(result, fallbackRef, includeResults, excerptLimit, targeted) {
  if (!isObject(result)) return undefined;
  const name = nonEmptyBoundedString(result.name, 128) || nonEmptyBoundedString(result.toolName, 128) || { text: "unknown", truncated: false };
  let status;
  if (result.status === "ok" || result.status === "error" || result.status === "unknown") status = result.status;
  else if (typeof result.isError === "boolean") status = result.isError ? "error" : "ok";
  else if (typeof result.is_error === "boolean") status = result.is_error ? "error" : "ok";
  else status = "unknown";
  const size = sanitizeSize(result.size || result.resultSize);
  const out = {
    ref: sanitizedRef(result.ref, fallbackRef, /^[tr][1-9][0-9]*$/),
    name: name.text || "unknown",
    status,
    size,
    omitted: true,
  };
  const handle = boundedString(result.handle, 64);
  if (handle && handle.text.length > 0) out.handle = handle.text;
  if (includeResults) {
    const excerpt = sanitizeExcerpt(result.excerpt, size, excerptLimit, targeted);
    if (excerpt) {
      out.excerpt = excerpt;
      out.omitted = false;
    }
  }
  return out;
}

function sanitizeAuthor(value) {
  if (!isObject(value)) return undefined;
  const out = {};
  for (const [key, cap] of [["kind", 32], ["id", 64], ["label", 128]]) {
    const bounded = boundedString(value[key], cap);
    if (bounded && bounded.text.length > 0) out[key] = bounded.text;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function sanitizeCorrelation(value) {
  if (!isObject(value)) return undefined;
  const out = {};
  const name = boundedString(value.name, 128);
  if (name && name.text.length > 0) out.name = name.text;
  if (isNonNegativeInteger(value.messageIndex)) out.messageIndex = value.messageIndex;
  if (isNonNegativeInteger(value.blockIndex) && value.blockIndex <= 0xffffffff) out.blockIndex = value.blockIndex;
  return Object.keys(out).length > 0 ? out : undefined;
}

function sanitizeProjection(candidate, params) {
  const sourceAuthors = new Map();
  const sourceCorrelations = new Map();
  if (isObject(candidate.authors)) {
    for (const [ref, author] of Object.entries(candidate.authors)) {
      const safeRef = sanitizedRef(ref, "", /^a[1-9][0-9]*$/);
      const safeAuthor = sanitizeAuthor(author);
      if (safeRef && safeAuthor) sourceAuthors.set(safeRef, safeAuthor);
    }
  }
  if (isObject(candidate.correlations)) {
    for (const [ref, correlation] of Object.entries(candidate.correlations)) {
      const safeRef = sanitizedRef(ref, "", /^[tr][1-9][0-9]*$/);
      const safeCorrelation = sanitizeCorrelation(correlation);
      if (safeRef && safeCorrelation) sourceCorrelations.set(safeRef, safeCorrelation);
    }
  }

  let authorCounter = 1;
  let callCounter = 1;
  let resultCounter = 1;
  const verbose = params.verbose === true;
  const targeted = typeof params.result_handle === "string";
  const includeResults = params.include_tool_results === true || targeted;
  const excerptLimit = isSafeInteger(params.result_limit) && params.result_limit >= 1 && params.result_limit <= RESULT_EXCERPT_MAX
    ? params.result_limit : RESULT_EXCERPT_DEFAULT;

  const messages = candidate.messages.map((message) => {
    const role = boundedString(message.role, 32);
    const out = { index: message.index, role: role && role.text.length > 0 ? role.text : "unknown" };
    if (message.projectionOmitted === true) {
      out.projectionOmitted = true;
      out.toolCallCount = message.toolCallCount;
      out.toolResultCount = message.toolResultCount;
      return out;
    }
    if (message.ts === null) out.ts = null;
    else {
      const ts = boundedString(message.ts, 64);
      if (ts) out.ts = ts.text;
    }
    const text = boundedString(message.text, verbose ? 4096 : 800);
    if (text) {
      out.text = text.text;
      if (text.truncated || message.textTruncated === true) out.textTruncated = true;
    }
    for (const [key, cap, truncatedKey] of [
      ["thinking", 512, "thinkingTruncated"],
      ["thinkingSummary", 512, "thinkingTruncated"],
      ["error", 512, "errorTruncated"],
      ["errorSummary", 512, "errorTruncated"],
      ["stopReason", 128, "stopReasonTruncated"],
    ]) {
      if (hasOwn(out, key)) continue;
      const bounded = boundedString(message[key], cap);
      if (bounded) {
        out[key] = bounded.text;
        if (bounded.truncated || message[truncatedKey] === true) out[truncatedKey] = true;
      }
    }
    if (message.status === "ok" || message.status === "error" || message.status === "unknown") out.status = message.status;

    const directAuthorRef = sanitizedRef(message.authorRef, "", /^a[1-9][0-9]*$/);
    if (directAuthorRef) out.authorRef = directAuthorRef;
    else {
      const author = sanitizeAuthor(message.author);
      if (author) {
        let ref;
        do { ref = "a" + authorCounter++; } while (sourceAuthors.has(ref));
        sourceAuthors.set(ref, author);
        out.authorRef = ref;
      }
    }

    const callSource = Array.isArray(message.toolCalls) ? message.toolCalls : (Array.isArray(message.toolUses) ? message.toolUses : []);
    const toolCalls = [];
    for (const call of callSource) {
      const sanitized = sanitizeToolCall(call, "t" + callCounter++);
      if (sanitized) toolCalls.push(sanitized);
    }
    if (toolCalls.length > 0) out.toolCalls = toolCalls;

    const toolResults = [];
    if (Array.isArray(message.toolResults)) {
      for (const result of message.toolResults) {
        const sanitized = sanitizeToolResult(result, "r" + resultCounter++, includeResults, excerptLimit, targeted);
        if (sanitized) toolResults.push(sanitized);
      }
    }
    if (toolResults.length > 0) out.toolResults = toolResults;
    return out;
  });

  return { messages, sourceAuthors, sourceCorrelations, targeted, excerptLimit };
}

function rebuildDictionaries(envelope, projection) {
  const authorRefs = new Set();
  const correlationRefs = new Set();
  for (const message of envelope.messages) {
    if (typeof message.authorRef === "string") authorRefs.add(message.authorRef);
    if (Array.isArray(message.toolCalls)) for (const call of message.toolCalls) correlationRefs.add(call.ref);
    if (Array.isArray(message.toolResults)) for (const result of message.toolResults) correlationRefs.add(result.ref);
  }
  const authors = {};
  for (const ref of authorRefs) {
    const value = projection.sourceAuthors.get(ref);
    if (value) authors[ref] = value;
  }
  const correlations = {};
  for (const ref of correlationRefs) {
    const value = projection.sourceCorrelations.get(ref);
    if (value) correlations[ref] = value;
  }
  if (Object.keys(authors).length > 0) envelope.authors = authors;
  else delete envelope.authors;
  if (Object.keys(correlations).length > 0) envelope.correlations = correlations;
  else delete envelope.correlations;
  return envelope;
}

function commonEnvelope(candidate, messages, projection) {
  const envelope = {
    total: candidate.total,
    returned: messages.length,
    offsetStart: messages.length > 0 ? messages[0].index : -1,
    offsetEnd: messages.length > 0 ? messages[messages.length - 1].index : -1,
    messages,
  };
  if (isNonNegativeInteger(candidate.matchCount)) envelope.matchCount = candidate.matchCount;
  if (isNonNegativeInteger(candidate.pageStart) && isNonNegativeInteger(candidate.pageCount)) {
    envelope.pageStart = candidate.pageStart;
    envelope.pageCount = candidate.pageCount;
  }
  return rebuildDictionaries(envelope, projection);
}

function preserveUpstreamCompletion(candidate, messages, projection) {
  const envelope = commonEnvelope(candidate, messages, projection);
  if (hasOwn(candidate, "nextOffset")) envelope.nextOffset = candidate.nextOffset;
  if (candidate.partial === false) envelope.partial = false;
  if (candidate.partial === true) {
    envelope.partial = true;
    envelope.truncatedBy = candidate.truncatedBy;
    const continuation = candidate.continuationRequest;
    if (continuation.kind === "page") {
      envelope.continuationRequest = { kind: "page", offset: continuation.offset };
    } else if (continuation.kind === "result_slice") {
      const target = firstExcerpt(envelope);
      const cursor = isNonNegativeInteger(target?.excerpt.nextCursor)
        ? target.excerpt.nextCursor : continuation.result_cursor;
      envelope.continuationRequest = {
        kind: "result_slice",
        result_handle: target?.result.handle || continuation.result_handle,
        result_cursor: cursor,
        result_limit: continuation.result_limit,
      };
    } else {
      envelope.continuationRequest = {};
      for (const key of ["kind", "retrySameRequest", "session_id", "sessionIdTruncated", "offset", "limit", "case_sensitive", "verbose", "include_tool_results", "context", "patternOmitted"]) {
        if (hasOwn(continuation, key)) envelope.continuationRequest[key] = continuation[key];
      }
    }
    if (candidate.truncatedBy === "extension_return_unrecognized") {
      envelope.wrapperDiagnostics = { omitted: true, actualBytes: candidate.wrapperDiagnostics.actualBytes };
    }
  }
  return envelope;
}

function resolvedPageStart(candidate, params) {
  if (isNonNegativeInteger(candidate.pageStart)) return candidate.pageStart;
  if (isSafeInteger(candidate.nextOffset)) return Math.max(0, candidate.nextOffset - candidate.returned);
  if (isSafeInteger(params.offset)) {
    if (params.offset >= 0) return params.offset;
    if (typeof params.pattern !== "string" || params.pattern.length === 0) return Math.max(0, candidate.total + params.offset);
  }
  return 0;
}

function pagePartial(candidate, messages, projection, params, returnedPositions) {
  const envelope = commonEnvelope(candidate, messages, projection);
  const nextOffset = resolvedPageStart(candidate, params) + returnedPositions;
  envelope.partial = true;
  envelope.truncatedBy = "transport_budget";
  envelope.nextOffset = nextOffset;
  envelope.continuationRequest = { kind: "page", offset: nextOffset };
  return envelope;
}

function actualDetails(envelope, params) {
  const details = {
    total: envelope.total,
    returned: envelope.returned,
    offsetStart: envelope.offsetStart,
    offsetEnd: envelope.offsetEnd,
  };
  if (isNonNegativeInteger(envelope.matchCount)) details.matchCount = envelope.matchCount;
  if (hasOwn(envelope, "nextOffset")) details.nextOffset = envelope.nextOffset;
  const sessionId = boundedString(params.session_id, 64);
  if (sessionId) {
    details.session_id = sessionId.text;
    details.sessionIdTruncated = sessionId.truncated;
  }
  return details;
}

function actualValue(envelope, params) {
  return { content: [{ type: "text", text: JSON.stringify(envelope) }], details: actualDetails(envelope, params) };
}

function retryRequest(params) {
  const retry = { kind: "retry", retrySameRequest: true };
  const sessionId = boundedString(params.session_id, 64);
  if (sessionId) {
    retry.session_id = sessionId.text;
    retry.sessionIdTruncated = sessionId.truncated;
  }
  for (const key of ["offset", "limit"]) if (isSafeInteger(params[key])) retry[key] = params[key];
  for (const key of ["case_sensitive", "verbose", "include_tool_results"]) {
    if (typeof params[key] === "boolean") retry[key] = params[key];
  }
  if (isSafeInteger(params.context)) retry.context = Math.max(0, Math.min(5, params.context));
  if (hasOwn(params, "pattern")) retry.patternOmitted = true;
  return retry;
}

function unrecognizedResult(result, params) {
  const envelope = {
    total: 0,
    returned: 0,
    offsetStart: -1,
    offsetEnd: -1,
    messages: [],
    partial: true,
    truncatedBy: "extension_return_unrecognized",
    continuationRequest: retryRequest(params),
    wrapperDiagnostics: { omitted: true, actualBytes: serializedByteLength(result) },
  };
  return actualValue(envelope, params);
}

function minimizedMessage(message) {
  const next = { ...message };
  if (Array.isArray(next.toolCalls)) {
    next.toolCalls = next.toolCalls.map((call) => ({ ...call, argumentsPreview: "", argumentsTruncated: true }));
  }
  if (Array.isArray(next.toolResults)) {
    next.toolResults = next.toolResults.map((result) => {
      const bounded = { ...result, omitted: true };
      delete bounded.excerpt;
      return bounded;
    });
  }
  return next;
}

function summaryMessage(message) {
  return {
    index: message.index,
    role: message.role,
    projectionOmitted: true,
    toolCallCount: Array.isArray(message.toolCalls) ? message.toolCalls.length : 0,
    toolResultCount: Array.isArray(message.toolResults) ? message.toolResults.length : 0,
  };
}

function firstExcerpt(envelope) {
  for (const message of envelope.messages) {
    if (!Array.isArray(message.toolResults)) continue;
    for (const result of message.toolResults) {
      if (isObject(result.excerpt)) return { result, excerpt: result.excerpt };
    }
  }
  return undefined;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function withTargetExcerpt(envelope, prefixUnits, requestedLimit) {
  const next = clone(envelope);
  delete next.nextOffset;
  delete next.wrapperDiagnostics;
  delete next.partial;
  delete next.truncatedBy;
  delete next.continuationRequest;
  const target = firstExcerpt(next);
  if (!target) return next;
  const sourceText = target.excerpt.text;
  const text = scalarPrefix(sourceText, prefixUnits, true);
  const end = target.excerpt.start + text.length;
  target.excerpt.text = text;
  target.excerpt.end = end;
  const chars = target.result.size && target.result.size.chars;
  const complete = isNonNegativeInteger(chars) ? end >= chars : end >= target.excerpt.end && target.excerpt.complete === true;
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

function fitTargetedEnvelope(envelope, params, requestedLimit) {
  const target = firstExcerpt(envelope);
  if (!target || typeof target.result.handle !== "string") return undefined;
  const sourceLength = target.excerpt.text.length;
  let low = 0;
  let high = sourceLength;
  let best;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = withTargetExcerpt(envelope, mid, requestedLimit);
    const value = actualValue(candidate, params);
    if (fits(value)) {
      best = value;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  if (best) return best;
  const progress = withTargetExcerpt(envelope, 1, requestedLimit);
  const progressValue = actualValue(progress, params);
  return fits(progressValue) ? progressValue : undefined;
}

function fitPage(candidate, projection, params) {
  const retained = [];
  let returnedPositions = 0;
  for (let index = 0; index < projection.messages.length; index += 1) {
    const source = projection.messages[index];
    const isLast = index === projection.messages.length - 1;
    const tryEnvelope = (row) => {
      const rows = [...retained, row];
      const envelope = isLast
        ? preserveUpstreamCompletion(candidate, rows, projection)
        : pagePartial(candidate, rows, projection, params, returnedPositions + 1);
      return { rows, envelope, value: actualValue(envelope, params) };
    };

    let attempt = tryEnvelope(source);
    if (!fits(attempt.value)) attempt = tryEnvelope(minimizedMessage(source));
    if (fits(attempt.value)) {
      retained.splice(0, retained.length, ...attempt.rows);
      returnedPositions += 1;
      if (isLast) return attempt.value;
      continue;
    }

    if (retained.length > 0) {
      return actualValue(pagePartial(candidate, retained, projection, params, returnedPositions), params);
    }

    const summary = summaryMessage(source);
    returnedPositions = 1;
    const summaryEnvelope = pagePartial(candidate, [summary], projection, params, returnedPositions);
    const summaryValue = actualValue(summaryEnvelope, params);
    if (fits(summaryValue)) return summaryValue;
    return undefined;
  }
  const empty = preserveUpstreamCompletion(candidate, [], projection);
  const value = actualValue(empty, params);
  return fits(value) ? value : undefined;
}

function boundReadSessionResult(result, params) {
  const envelope = recoverEnvelope(result, params);
  if (!envelope) return unrecognizedResult(result, params);

  const projection = sanitizeProjection(envelope, params);
  const canonical = preserveUpstreamCompletion(envelope, projection.messages, projection);
  const direct = actualValue(canonical, params);
  if (fits(direct)) return direct;

  if (projection.targeted) {
    const targeted = fitTargetedEnvelope(canonical, params, projection.excerptLimit);
    if (targeted && fits(targeted)) return targeted;
  }

  const paged = fitPage(envelope, projection, params);
  if (paged && fits(paged)) return paged;
  return unrecognizedResult(result, params);
}

function invocationParams(args) {
  if (isObject(args[1])) return args[1];
  if (isObject(args[0])) return args[0];
  return {};
}

function readSessionBoundaryDigest(value) {
  if (!isObject(value)) return undefined;
  try {
    const snapshot = JSON.stringify({
      content: Array.isArray(value.content) ? value.content : [],
      ...(hasOwn(value, "details") ? { details: value.details } : {}),
    });
    return typeof snapshot === "string"
      ? createHash("sha256").update(snapshot).digest("hex")
      : undefined;
  } catch {
    return undefined;
  }
}

function markReadSessionBoundaryResult(result) {
  if (isObject(result) && isObject(result.details)) {
    const digest = readSessionBoundaryDigest(result);
    if (digest !== undefined) {
      Object.defineProperty(result.details, READ_SESSION_RESULT_BOUNDARY_MARKER, { value: digest });
    }
  }
  return result;
}

function isUnchangedReadSessionBoundaryResult(value) {
  if (!isObject(value) || !isObject(value.details)) return false;
  const digest = value.details[READ_SESSION_RESULT_BOUNDARY_MARKER];
  return typeof digest === "string" && digest === readSessionBoundaryDigest(value);
}

function boundFinalReadSessionEvent(event, transformed) {
  if (!isObject(event) || String(event.toolName || "").toLowerCase() !== "read_session") return transformed;
  const current = isObject(transformed) ? transformed : event;
  const isError = typeof current.isError === "boolean" ? current.isError : event.isError;
  if (isError === true) return transformed;

  // Pi shallow-copies the event for listeners, so a listener can mutate nested
  // content/details and still return undefined. Only skip the second projection
  // when the complete serializable result still matches its immutable snapshot.
  if (transformed === undefined && isUnchangedReadSessionBoundaryResult(event)) return undefined;

  const source = {
    content: Array.isArray(current.content) ? current.content : [],
    ...(hasOwn(current, "details") ? { details: current.details } : {}),
  };
  const bounded = markReadSessionBoundaryResult(boundReadSessionResult(
    source,
    isObject(event.input) ? event.input : {},
  ));
  return {
    content: bounded.content,
    details: bounded.details,
    ...(typeof isError === "boolean" ? { isError } : {}),
  };
}

function wrapHandler(handler, toolName) {
  if (typeof handler !== "function" || handler.__bobbitErrorBridgeWrapped) return handler;
  async function bobbitToolResultErrorBridgeHandler(...args) {
    let result = await handler.apply(this, args);
    if (String(toolName || "").toLowerCase() === "read_session" && !isErroredToolResult(result)) {
      result = markReadSessionBoundaryResult(boundReadSessionResult(result, invocationParams(args)));
    }
    if (isErroredToolResult(result)) {
      const err = new Error(messageFromToolResult(result));
      err.name = "BobbitToolResultError";
      err.isError = true;
      err.is_error = true;
      err.bobbitToolResult = result;
      throw err;
    }
    return result;
  }
  Object.defineProperty(bobbitToolResultErrorBridgeHandler, "__bobbitErrorBridgeWrapped", { value: true });
  return bobbitToolResultErrorBridgeHandler;
}

function wrapRegistrationArgs(args) {
  const next = Array.from(args);
  const name = typeof next[0] === "string" ? next[0] : (isObject(next[0]) ? next[0].name : undefined);
  if (typeof next[0] === "string") {
    if (typeof next[1] === "function") {
      next[1] = wrapHandler(next[1], name);
    } else if (typeof next[2] === "function") {
      next[2] = wrapHandler(next[2], name);
    } else if (isObject(next[1])) {
      const spec = { ...next[1] };
      const resolvedName = typeof spec.name === "string" ? spec.name : name;
      if (typeof spec.handler === "function") spec.handler = wrapHandler(spec.handler, resolvedName);
      if (typeof spec.execute === "function") spec.execute = wrapHandler(spec.execute, resolvedName);
      next[1] = spec;
    }
    return next;
  }
  if (isObject(next[0])) {
    const spec = { ...next[0] };
    if (typeof next[1] === "function") {
      next[1] = wrapHandler(next[1], name);
    } else {
      if (typeof spec.handler === "function") spec.handler = wrapHandler(spec.handler, name);
      if (typeof spec.execute === "function") spec.execute = wrapHandler(spec.execute, name);
    }
    next[0] = spec;
  }
  return next;
}

async function installSharedRunnerBoundary() {
  try {
    const imported = await import("@earendil-works/pi-coding-agent");
    const prototype = imported && imported.ExtensionRunner && imported.ExtensionRunner.prototype;
    if (!prototype || prototype[SHARED_RUNNER_BOUNDARY_MARKER] === true
      || typeof prototype.getAllRegisteredTools !== "function"
      || typeof prototype.emitToolResult !== "function") return;
    const originalGetAllRegisteredTools = prototype.getAllRegisteredTools;
    const originalEmitToolResult = prototype.emitToolResult;
    prototype.getAllRegisteredTools = function bobbitBoundRegisteredTools(...args) {
      const registered = originalGetAllRegisteredTools.apply(this, args);
      if (!Array.isArray(registered)) return registered;
      return registered.map((tool) => {
        if (!isObject(tool) || !isObject(tool.definition)) return tool;
        const definition = tool.definition;
        const execute = wrapHandler(definition.execute, definition.name);
        if (execute === definition.execute) return tool;
        return { ...tool, definition: { ...definition, execute } };
      });
    };
    prototype.emitToolResult = async function bobbitBoundFinalToolResult(event, ...args) {
      const transformed = await originalEmitToolResult.call(this, event, ...args);
      return boundFinalReadSessionEvent(event, transformed);
    };
    Object.defineProperty(prototype, SHARED_RUNNER_BOUNDARY_MARKER, { value: true });
  } catch {
    // Registration wrapping still preserves returned-error semantics.
  }
}

export default function(pi) {
  if (!pi || pi.__bobbitToolResultErrorBridgeInstalled) return;
  Object.defineProperty(pi, "__bobbitToolResultErrorBridgeInstalled", { value: true });

  if (typeof pi.on === "function") {
    // Keep Pi's afterToolCall path active even when no other extension listens;
    // final enforcement belongs to the runner-owned post-chain seam above.
    pi.on("tool_result", () => undefined);
  }

  if (typeof pi.tool === "function") {
    const originalTool = pi.tool.bind(pi);
    pi.tool = (...args) => originalTool(...wrapRegistrationArgs(args));
  }

  if (typeof pi.registerTool === "function") {
    const originalRegisterTool = pi.registerTool.bind(pi);
    pi.registerTool = (...args) => originalRegisterTool(...wrapRegistrationArgs(args));
  }

  if (pi.tools && typeof pi.tools.register === "function") {
    const originalToolsRegister = pi.tools.register.bind(pi.tools);
    pi.tools.register = (...args) => originalToolsRegister(...wrapRegistrationArgs(args));
  }

  return installSharedRunnerBoundary();
}
`;
}

let cachedPath: string | undefined;

export function writeToolResultErrorBridgeExtension(): string | undefined {
	const code = generateToolResultErrorBridgeExtension();

	// Revalidate a cached path before reuse. The file lives under a shared,
	// content-addressed dir that is bind-mounted read-only into sandboxes.
	if (cachedPath) {
		try {
			if (fs.readFileSync(cachedPath, "utf-8") === code) return cachedPath;
		} catch { /* missing/unreadable — rewrite below */ }
		cachedPath = undefined;
	}

	try {
		const baseDir = path.join(bobbitStateDir(), "tool-result-error-bridge");
		const hash = createHash("sha256").update(code).digest("hex").slice(0, 12);
		const extDir = path.join(baseDir, hash);
		fs.mkdirSync(extDir, { recursive: true });
		const filePath = path.join(extDir, "bridge.ts");
		try {
			if (fs.readFileSync(filePath, "utf-8") === code) {
				cachedPath = filePath;
				return filePath;
			}
		} catch { /* file does not exist yet */ }
		fs.writeFileSync(filePath, code, "utf-8");
		// Verify the bytes that Pi will load, not merely the write call.
		if (fs.readFileSync(filePath, "utf-8") !== code) return undefined;
		cachedPath = filePath;
		return filePath;
	} catch {
		return undefined;
	}
}

/** Alias naming the read-session responsibility explicitly. */
export const writeReadSessionResultBoundaryExtension = writeToolResultErrorBridgeExtension;

/** Reset the in-memory codegen cache (test seam). */
export function resetToolResultErrorBridgeExtensionCache(): void {
	cachedPath = undefined;
}

/**
 * Prepend the immutable result boundary before resolved tool extensions.
 * When read_session is part of the runtime surface, failure to materialize the
 * boundary is fatal rather than silently starting an unsafe agent process.
 */
export function prependToolResultErrorBridge(args: string[], requireReadSessionBoundary = false): string[] {
	const bridgePath = writeToolResultErrorBridgeExtension();
	if (!bridgePath) {
		if (requireReadSessionBoundary) {
			throw new Error("read_session safety boundary could not be written or verified");
		}
		return args;
	}
	const out = [...args];
	const noExtensionsIndex = out.indexOf("--no-extensions");
	const insertAt = noExtensionsIndex >= 0 ? noExtensionsIndex + 1 : 0;
	out.splice(insertAt, 0, "--extension", bridgePath);
	return out;
}

/** Analysis/design terminology alias. */
export const prependToolResultBoundary = prependToolResultErrorBridge;
