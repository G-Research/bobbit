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
const SNAPSHOT_MAX_DEPTH = 64;
const SNAPSHOT_MAX_NODES = 16384;
const SNAPSHOT_MAX_IDENTITIES = 4096;
const SNAPSHOT_MAX_ARRAY_LENGTH = 4096;
const SNAPSHOT_MAX_OBJECT_KEYS = 4096;
const SNAPSHOT_MAX_STRING_UNITS = 2 * 1024 * 1024;
const SNAPSHOT_MAX_WORK_UNITS = 4 * 1024 * 1024;
const TOOL_CALL_ID_MAX_UNITS = 128;
const CORRELATION_HASH_CHUNK_UNITS = 64 * 1024;
const CALL_MAP_MAX_ENTRIES = 256;
const CORRELATION_DIGEST_HEX_UNITS = 40;
const CORRELATION_KEY_UNITS = 5 + CORRELATION_DIGEST_HEX_UNITS;
const SHARED_RUNNER_BOUNDARY_MARKER = Symbol.for("bobbit.tool-result.shared-runner-boundary.v7");
const SHARED_AGENT_SESSION_BOUNDARY_MARKER = Symbol.for("bobbit.tool-result.shared-agent-session-boundary.v3");
const CALL_MAP_DIAGNOSTICS = Symbol.for("bobbit.tool-result.read-session-call-map-diagnostics.v1");
const SNAPSHOT_OMITTED = Symbol("snapshot-omitted");
const SNAPSHOT_REJECTED = Symbol("snapshot-rejected");
const runnerReadSessionCalls = new WeakMap();
const boundaryOwnedSnapshots = new WeakSet();

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

/**
 * Consume untrusted extension values exactly once into ordinary JSON data.
 * Traversal is iterative and admits only arrays and ordinary objects. Accessors
 * and toJSON are never invoked. Global identity/work caps prevent cycles,
 * shared-DAG expansion, sparse-array walks, and deep inputs from monopolizing
 * the event loop or overflowing the stack.
 */
function consumeSnapshot(value, options) {
  const root = { value: undefined };
  const seen = new WeakSet();
  const stack = [{ source: value, parent: root, key: "value", arraySlot: false, depth: 0 }];
  let nodes = 0;
  let identities = 0;
  let workUnits = 0;

  while (stack.length > 0) {
    const job = stack.pop();
    nodes += 1;
    if (nodes > SNAPSHOT_MAX_NODES || job.depth > SNAPSHOT_MAX_DEPTH) return SNAPSHOT_REJECTED;
    const source = job.source;
    if (source === null || typeof source === "boolean") {
      job.parent[job.key] = source;
      continue;
    }
    if (typeof source === "number") {
      job.parent[job.key] = Number.isFinite(source) ? source : null;
      continue;
    }
    if (typeof source === "string") {
      if (source.length > SNAPSHOT_MAX_STRING_UNITS) return SNAPSHOT_REJECTED;
      workUnits += source.length;
      if (workUnits > SNAPSHOT_MAX_WORK_UNITS) return SNAPSHOT_REJECTED;
      job.parent[job.key] = source;
      continue;
    }
    if (!source || typeof source !== "object") {
      if (job.arraySlot) job.parent[job.key] = null;
      continue;
    }
    if (seen.has(source)) {
      if (job.arraySlot) job.parent[job.key] = null;
      continue;
    }
    identities += 1;
    if (identities > SNAPSHOT_MAX_IDENTITIES) return SNAPSHOT_REJECTED;
    seen.add(source);

    if (Array.isArray(source)) {
      let lengthDescriptor;
      try { lengthDescriptor = Object.getOwnPropertyDescriptor(source, "length"); } catch { return SNAPSHOT_REJECTED; }
      if (!lengthDescriptor || !("value" in lengthDescriptor)) return SNAPSHOT_REJECTED;
      const length = lengthDescriptor.value;
      if (!isSafeInteger(length) || length < 0 || length > SNAPSHOT_MAX_ARRAY_LENGTH) return SNAPSHOT_REJECTED;
      workUnits += length;
      if (workUnits > SNAPSHOT_MAX_WORK_UNITS) return SNAPSHOT_REJECTED;
      const out = new Array(length).fill(null);
      job.parent[job.key] = out;
      for (let index = length - 1; index >= 0; index -= 1) {
        let descriptor;
        try { descriptor = Object.getOwnPropertyDescriptor(source, String(index)); } catch { return SNAPSHOT_REJECTED; }
        if (!descriptor) continue;
        if (!("value" in descriptor)) {
          if (options?.rejectAccessors) return SNAPSHOT_REJECTED;
          continue;
        }
        stack.push({ source: descriptor.value, parent: out, key: index, arraySlot: true, depth: job.depth + 1 });
      }
      continue;
    }

    let prototype;
    try { prototype = Object.getPrototypeOf(source); } catch { return SNAPSHOT_REJECTED; }
    if (prototype !== Object.prototype && prototype !== null) {
      if (job.arraySlot) job.parent[job.key] = null;
      continue;
    }
    let keys;
    try { keys = Object.keys(source); } catch { return SNAPSHOT_REJECTED; }
    if (keys.length > SNAPSHOT_MAX_OBJECT_KEYS) return SNAPSHOT_REJECTED;
    workUnits += keys.length;
    if (workUnits > SNAPSHOT_MAX_WORK_UNITS) return SNAPSHOT_REJECTED;
    const out = {};
    job.parent[job.key] = out;
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index];
      workUnits += key.length;
      if (workUnits > SNAPSHOT_MAX_WORK_UNITS) return SNAPSHOT_REJECTED;
      let descriptor;
      try { descriptor = Object.getOwnPropertyDescriptor(source, key); } catch { return SNAPSHOT_REJECTED; }
      if (!descriptor || !("value" in descriptor)) {
        if (options?.rejectAccessors) return SNAPSHOT_REJECTED;
        continue;
      }
      // JSON.stringify calls this hook instead of serializing measured data.
      if (key === "toJSON") continue;
      const replacements = options?.dataReplacements?.get(source);
      const child = replacements?.has(key) ? replacements.get(key) : descriptor.value;
      stack.push({ source: child, parent: out, key, arraySlot: false, depth: job.depth + 1 });
    }
  }
  return root.value === undefined ? SNAPSHOT_OMITTED : root.value;
}

function freezeSnapshot(root) {
  const stack = [root];
  const seen = new WeakSet();
  while (stack.length > 0) {
    const candidate = stack.pop();
    if (!candidate || typeof candidate !== "object" || seen.has(candidate)) continue;
    seen.add(candidate);
    for (const child of Object.values(candidate)) {
      if (child && typeof child === "object") stack.push(child);
    }
    Object.freeze(candidate);
  }
  return root;
}

function ownImmutableSnapshot(value) {
  const root = freezeSnapshot(value);
  if (root && typeof root === "object") boundaryOwnedSnapshots.add(root);
  return root;
}

function immutableSnapshot(value) {
  const consumed = consumeSnapshot(value);
  const root = consumed === SNAPSHOT_OMITTED || consumed === SNAPSHOT_REJECTED ? {} : consumed;
  return ownImmutableSnapshot(root);
}

function serializedByteLength(value) {
  try {
    const json = JSON.stringify(value);
    return typeof json === "string" ? Buffer.byteLength(json, "utf8") : 0;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function correlationDigest(value) {
  const hash = createHash("sha256").update("bobbit-read-session-tool-call-id-v2\\0", "utf8");
  if (typeof value === "string") {
    hash.update("string\\0", "utf8");
    for (let start = 0; start < value.length;) {
      let end = Math.min(value.length, start + CORRELATION_HASH_CHUNK_UNITS);
      if (end < value.length) {
        const high = value.charCodeAt(end - 1);
        const low = value.charCodeAt(end);
        if (high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff) end -= 1;
      }
      hash.update(value.slice(start, end), "utf8");
      start = end;
    }
  } else if (typeof value === "number" && Number.isFinite(value)) hash.update("number\\0" + value, "utf8");
  else if (typeof value === "boolean") hash.update("boolean\\0", "utf8").update(value ? "1" : "0", "utf8");
  else if (value === null) hash.update("null", "utf8");
  else if (value === undefined) hash.update("undefined", "utf8");
  else hash.update("invalid:" + typeof value, "utf8");
  return hash.digest("hex").slice(0, CORRELATION_DIGEST_HEX_UNITS);
}

function correlationIdentity(value) {
  const digest = correlationDigest(value);
  const alreadyNormalized = typeof value === "string" && /^brs1:[0-9a-f]{40}$/.test(value);
  const retainProviderId = typeof value === "string" && value.length > 0
    && value.length <= TOOL_CALL_ID_MAX_UNITS && isWellFormed(value)
    && (!value.startsWith("brs1:") || alreadyNormalized);
  const toolCallId = retainProviderId ? value : "brs1:" + digest;
  const key = "brk1:" + digest;
  // Oversized inputs are normalized before later Pi phases. Retain a second
  // fixed digest key for that bounded output, never the raw provider ID.
  const outputKey = toolCallId === value ? key : "brk1:" + correlationDigest(toolCallId);
  return { key, outputKey, toolCallId };
}

function normalizedProviderCorrelationId(value) {
  return correlationIdentity(value).toolCallId;
}

function boundedCallParams(input) {
  const params = consumeParams(input);
  const out = {};
  for (const key of ["session_id", "result_handle"]) {
    const bounded = boundedString(params[key], 64);
    if (bounded) out[key] = bounded.text;
  }
  for (const key of ["offset", "limit", "context", "result_cursor", "result_limit"]) {
    if (isSafeInteger(params[key])) out[key] = params[key];
  }
  for (const key of ["case_sensitive", "verbose", "include_tool_results"]) {
    if (typeof params[key] === "boolean") out[key] = params[key];
  }
  if (hasOwn(params, "pattern")) out.pattern = typeof params.pattern === "string" ? "" : null;
  return out;
}

function inspectCallMap(runner) {
  const calls = runnerReadSessionCalls.get(runner);
  let maxKeyUnits = 0;
  let maxValueStringUnits = 0;
  let totalRetainedStringUnits = 0;
  if (calls) {
    for (const [key, record] of calls) {
      maxKeyUnits = Math.max(maxKeyUnits, key.length);
      totalRetainedStringUnits += key.length;
      const retained = [record.toolCallId, ...Object.values(record.params).filter((value) => typeof value === "string")];
      for (const value of retained) {
        maxValueStringUnits = Math.max(maxValueStringUnits, value.length);
        totalRetainedStringUnits += value.length;
      }
    }
  }
  return Object.freeze({
    entries: calls?.size || 0,
    maxEntries: CALL_MAP_MAX_ENTRIES,
    correlationKeyUnits: CORRELATION_KEY_UNITS,
    maxKeyUnits,
    maxValueStringUnits,
    totalRetainedStringUnits,
  });
}

function callMap(runner) {
  if (!runner || (typeof runner !== "object" && typeof runner !== "function")) return undefined;
  let calls = runnerReadSessionCalls.get(runner);
  if (!calls) {
    calls = new Map();
    runnerReadSessionCalls.set(runner, calls);
    try {
      if (typeof runner[CALL_MAP_DIAGNOSTICS] !== "function") {
        Object.defineProperty(runner, CALL_MAP_DIAGNOSTICS, {
          value: function bobbitReadSessionCallMapDiagnostics() { return inspectCallMap(this); },
        });
      }
    } catch { /* diagnostics are best-effort and never weaken enforcement */ }
  }
  return calls;
}

function knownReadSessionCall(runner, identity) {
  const calls = callMap(runner);
  if (!calls) return undefined;
  return calls.get(identity.key) || calls.get(identity.outputKey);
}

function rememberReadSessionCall(runner, toolCallId, input, resolvedIdentity) {
  const identity = resolvedIdentity || correlationIdentity(toolCallId);
  const calls = callMap(runner);
  if (!calls) return identity.toolCallId;
  const existing = calls.get(identity.key) || calls.get(identity.outputKey);
  if (existing) {
    const params = boundedCallParams(input);
    if (Object.keys(params).length > 0) existing.params = params;
    calls.set(identity.key, existing);
    calls.set(identity.outputKey, existing);
    while (calls.size > CALL_MAP_MAX_ENTRIES) calls.delete(calls.keys().next().value);
    return existing.toolCallId;
  }
  const record = { toolCallId: identity.toolCallId, params: boundedCallParams(input) };
  calls.set(identity.key, record);
  calls.set(identity.outputKey, record);
  // One model turn cannot legitimately need an unbounded correlation table.
  while (calls.size > CALL_MAP_MAX_ENTRIES) calls.delete(calls.keys().next().value);
  return identity.toolCallId;
}

function normalizedExplicitToolName(value) {
  return typeof value === "string" && value.length > 0 ? value.toLowerCase() : undefined;
}

function readSessionContext(runner, toolCallId, toolName, input) {
  const explicitToolName = normalizedExplicitToolName(toolName);
  // An explicit non-read name is authoritative. ID-only correlation is reserved
  // for provider phases that genuinely omit the tool name.
  if (explicitToolName !== undefined && explicitToolName !== "read_session") return undefined;
  const identity = correlationIdentity(toolCallId);
  const known = knownReadSessionCall(runner, identity);
  if (known) {
    if (input !== undefined && explicitToolName === "read_session") {
      rememberReadSessionCall(runner, toolCallId, input, identity);
    }
    return known;
  }
  if (explicitToolName !== "read_session") return undefined;
  const normalized = rememberReadSessionCall(runner, toolCallId, input, identity);
  return knownReadSessionCall(runner, identity) || { toolCallId: normalized, params: boundedCallParams(input) };
}

function transportProfile(toolCallId, isError) {
  return {
    // Final message/state seams persist this same normalized correlation ID.
    toolCallId: normalizedProviderCorrelationId(toolCallId),
    isError: isError === true,
  };
}

/** Measure the exact current-Pi message/JSONL wrappers, not only inner details. */
function finalSerializedByteLengths(value, profile = transportProfile("", false)) {
  const message = {
    role: "toolResult",
    toolCallId: profile.toolCallId,
    toolName: "read_session",
    content: value.content,
    details: value.details,
    isError: profile.isError,
    timestamp: Number.MAX_SAFE_INTEGER,
  };
  // SessionManager IDs are 8 hex characters with a 36-character UUID fallback.
  // Use the fallback length for both IDs and include the trailing JSONL newline.
  const line = {
    type: "message",
    id: "0".repeat(36),
    parentId: "0".repeat(36),
    timestamp: "+999999-12-31T23:59:59.999Z",
    message,
  };
  return {
    value: serializedByteLength(value),
    message: serializedByteLength(message),
    line: serializedByteLength(line) + 1,
  };
}

function fits(value, profile) {
  const sizes = finalSerializedByteLengths(value, profile);
  return sizes.value <= READ_SESSION_FINAL_RESULT_MAX_BYTES
    && sizes.message <= READ_SESSION_FINAL_RESULT_MAX_BYTES
    && sizes.line <= READ_SESSION_FINAL_RESULT_MAX_BYTES;
}

function isErroredToolResult(value) {
  if (!isObject(value)) return false;
  for (const key of ["isError", "is_error"]) {
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(value, key); } catch { return false; }
    if (descriptor && "value" in descriptor && descriptor.value === true) return true;
  }
  return false;
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
  return {
    content: [{ type: "text", text: JSON.stringify(envelope) }],
    details: actualDetails(envelope, params),
  };
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

function unrecognizedResult(result, params, actualBytesOverride) {
  const measuredBytes = isNonNegativeInteger(actualBytesOverride)
    ? actualBytesOverride : serializedByteLength(result);
  const envelope = {
    total: 0,
    returned: 0,
    offsetStart: -1,
    offsetEnd: -1,
    messages: [],
    partial: true,
    truncatedBy: "extension_return_unrecognized",
    continuationRequest: retryRequest(params),
    wrapperDiagnostics: { omitted: true, actualBytes: measuredBytes },
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

function fitTargetedEnvelope(envelope, params, requestedLimit, profile) {
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
    if (fits(value, profile)) {
      best = value;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  if (best) return best;
  const progress = withTargetExcerpt(envelope, 1, requestedLimit);
  const progressValue = actualValue(progress, params);
  return fits(progressValue, profile) ? progressValue : undefined;
}

function fitPage(candidate, projection, params, profile) {
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
    if (!fits(attempt.value, profile)) attempt = tryEnvelope(minimizedMessage(source));
    if (fits(attempt.value, profile)) {
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
    if (fits(summaryValue, profile)) return summaryValue;
    return undefined;
  }
  const empty = preserveUpstreamCompletion(candidate, [], projection);
  const value = actualValue(empty, params);
  return fits(value, profile) ? value : undefined;
}

function boundReadSessionResult(result, params, profile = transportProfile("", false)) {
  const snapshot = consumeSnapshot(result);
  if (snapshot === SNAPSHOT_REJECTED) {
    return unrecognizedResult({}, params, Number.MAX_SAFE_INTEGER);
  }
  const safeResult = snapshot === SNAPSHOT_OMITTED ? {} : snapshot;
  const envelope = recoverEnvelope(safeResult, params);
  if (!envelope) return unrecognizedResult(safeResult, params);

  const projection = sanitizeProjection(envelope, params);
  const canonical = preserveUpstreamCompletion(envelope, projection.messages, projection);
  const direct = actualValue(canonical, params);
  if (fits(direct, profile)) return direct;

  if (projection.targeted) {
    const targeted = fitTargetedEnvelope(canonical, params, projection.excerptLimit, profile);
    if (targeted && fits(targeted, profile)) return targeted;
  }

  const paged = fitPage(envelope, projection, params, profile);
  if (paged && fits(paged, profile)) return paged;
  return unrecognizedResult(safeResult, params);
}

function invocationParams(args) {
  if (isObject(args[1])) return args[1];
  if (isObject(args[0])) return args[0];
  return {};
}

function consumeParams(value) {
  if (!isObject(value)) return {};
  const out = {};
  for (const key of [
    "session_id", "offset", "limit", "case_sensitive", "verbose", "include_tool_results",
    "context", "result_handle", "result_cursor", "result_limit",
  ]) {
    if (!hasOwn(value, key)) continue;
    let item;
    try { item = value[key]; } catch { continue; }
    const consumed = consumeSnapshot(item);
    if (consumed !== SNAPSHOT_OMITTED && consumed !== SNAPSHOT_REJECTED) out[key] = consumed;
  }
  // Only presence/type affects continuations and filtered-tail positioning. Never
  // copy a potentially multi-megabyte regex into the boundary snapshot.
  if (hasOwn(value, "pattern")) {
    let pattern;
    try { pattern = value.pattern; } catch { pattern = undefined; }
    out.pattern = typeof pattern === "string" ? "" : null;
  }
  return out;
}

function diagnosticString(value, maxUnits) {
  const bounded = boundedString(value, maxUnits);
  return bounded && bounded.text.length > 0 ? bounded.text : undefined;
}

function diagnosticStatus(value) {
  if (isSafeInteger(value)) return value;
  return diagnosticString(value, 64);
}

function parsedErrorContent(result) {
  if (!isObject(result) || !Array.isArray(result.content)) return { parsed: undefined, fallback: undefined };
  for (const block of result.content) {
    const text = typeof block === "string" ? block : (isObject(block) && typeof block.text === "string" ? block.text : undefined);
    if (typeof text !== "string" || text.length === 0) continue;
    try {
      const parsed = JSON.parse(text);
      if (isObject(parsed)) return { parsed, fallback: undefined };
    } catch { /* ordinary text is retained as a bounded message below */ }
    return { parsed: undefined, fallback: text };
  }
  return { parsed: undefined, fallback: undefined };
}

function firstDiagnosticString(sources, keys, maxUnits) {
  for (const source of sources) {
    if (!isObject(source)) continue;
    for (const key of keys) {
      const value = diagnosticString(source[key], maxUnits);
      if (value !== undefined) return value;
    }
  }
  return undefined;
}

function firstDiagnosticStatus(sources) {
  for (const source of sources) {
    if (!isObject(source)) continue;
    for (const key of ["status", "statusCode", "httpStatus"]) {
      const value = diagnosticStatus(source[key]);
      if (value !== undefined) return value;
    }
  }
  return undefined;
}

function boundReadSessionError(result, profile = transportProfile("", true)) {
  const consumed = consumeSnapshot(result);
  const safeResult = isObject(consumed) ? consumed : {};
  const details = isObject(safeResult.details) ? safeResult.details : undefined;
  const { parsed, fallback } = parsedErrorContent(safeResult);
  const sources = [parsed, safeResult, details];
  const error = firstDiagnosticString(sources, ["error"], 128);
  const code = firstDiagnosticString(sources, ["code"], 128);
  const status = firstDiagnosticStatus(sources);
  const detail = firstDiagnosticString(sources, ["detail"], 1024);
  const message = firstDiagnosticString(sources, ["message"], 1024)
    || diagnosticString(fallback, 1024);
  const payload = {};
  if (error !== undefined) payload.error = error;
  if (code !== undefined) payload.code = code;
  if (status !== undefined) payload.status = status;
  if (detail !== undefined) payload.detail = detail;
  if (message !== undefined) payload.message = message;
  if (Object.keys(payload).length === 0) payload.error = "read_session_failed";
  const canonicalDetails = {};
  if (code !== undefined) canonicalDetails.code = code;
  if (status !== undefined) canonicalDetails.status = status;
  const bounded = {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    details: canonicalDetails,
    isError: true,
  };
  // Fixed field caps make this path comfortably fit, but retain a fail-closed
  // last resort if a future key changes its serialized cost.
  if (fits(bounded, profile)) return bounded;
  return {
    content: [{ type: "text", text: '{"error":"read_session_failed"}' }],
    details: {},
    isError: true,
  };
}

function eventResultSnapshot(event, transformed) {
  if (isObject(transformed)) {
    const consumed = consumeSnapshot(transformed);
    return consumed === SNAPSHOT_REJECTED ? SNAPSHOT_REJECTED : (isObject(consumed) ? consumed : {});
  }
  const source = {};
  for (const key of ["content", "details", "usage", "isError", "is_error", "error", "message", "code", "status", "statusCode", "httpStatus"]) {
    if (!hasOwn(event, key)) continue;
    let item;
    try { item = event[key]; } catch { continue; }
    const consumed = consumeSnapshot(item);
    if (consumed === SNAPSHOT_REJECTED) return SNAPSHOT_REJECTED;
    if (consumed !== SNAPSHOT_OMITTED) source[key] = consumed;
  }
  return source;
}

function boundFinalReadSessionEvent(event, transformed, context) {
  if (!isObject(event) || (!context && String(event.toolName || "").toLowerCase() !== "read_session")) return transformed;
  const source = eventResultSnapshot(event, transformed);
  const params = context?.params || consumeParams(event.input);
  const rejected = source === SNAPSHOT_REJECTED;
  const safeSource = rejected ? {} : source;
  const isError = safeSource.isError === true || safeSource.is_error === true || event.isError === true;
  const toolCallId = context?.toolCallId || normalizedProviderCorrelationId(event.toolCallId);
  const profile = transportProfile(toolCallId, isError);
  const bounded = isError
    ? boundReadSessionError(safeSource, profile)
    : (rejected
      ? unrecognizedResult({}, params, Number.MAX_SAFE_INTEGER)
      : boundReadSessionResult(safeSource, params, profile));
  // Measure and return this exact accessor-free immutable snapshot. No digest,
  // marker, accessor or toJSON hook from an extension remains authoritative.
  const finalSnapshot = immutableSnapshot({
    content: bounded.content,
    details: bounded.details,
    isError,
  });
  if (fits(finalSnapshot, profile)) return finalSnapshot;
  const fallback = isError
    ? boundReadSessionError({}, profile)
    : unrecognizedResult(safeSource, params, rejected ? Number.MAX_SAFE_INTEGER : undefined);
  return immutableSnapshot({
    content: fallback.content,
    details: fallback.details,
    isError,
  });
}

function wrapHandler(handler, toolName) {
  if (typeof handler !== "function" || handler.__bobbitErrorBridgeWrapped) return handler;
  async function bobbitToolResultErrorBridgeHandler(...args) {
    const readSession = String(toolName || "").toLowerCase() === "read_session";
    const rawResult = await handler.apply(this, args);
    let result;
    if (readSession) {
      const params = consumeParams(invocationParams(args));
      const callId = typeof args[0] === "string" ? args[0] : "";
      const snapshot = consumeSnapshot(rawResult);
      const rejected = snapshot === SNAPSHOT_REJECTED;
      const safeResult = snapshot === SNAPSHOT_OMITTED || rejected ? {} : snapshot;
      const errored = isErroredToolResult(safeResult) || (rejected && isErroredToolResult(rawResult));
      result = errored
        ? boundReadSessionError(safeResult, transportProfile(callId, true))
        : (rejected
          ? unrecognizedResult({}, params, Number.MAX_SAFE_INTEGER)
          : boundReadSessionResult(safeResult, params, transportProfile(callId, false)));
    } else {
      result = rawResult;
    }
    if (isErroredToolResult(result)) {
      const err = new Error(messageFromToolResult(result));
      err.name = "BobbitToolResultError";
      err.isError = true;
      err.is_error = true;
      err.bobbitToolResult = immutableSnapshot(result);
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

function replaceObjectInPlace(target, replacement, freeze) {
  if (!isObject(target) || !isObject(replacement) || !boundaryOwnedSnapshots.has(replacement)) return false;
  if (target === replacement) return true;
  let frozen;
  try { frozen = Object.isFrozen(target); } catch { return false; }
  if (frozen) {
    // Never serialize or compare a frozen listener-owned target: accessors and
    // toJSON are still executable. A different boundary snapshot must replace
    // the owning slot even when the current frozen target is boundary-owned.
    return false;
  }
  try {
    const prototype = Object.getPrototypeOf(target);
    if (prototype !== Object.prototype && prototype !== null) return false;
    for (const key of Reflect.ownKeys(target)) {
      if (!Reflect.deleteProperty(target, key)) return false;
    }
    Object.defineProperties(target, Object.getOwnPropertyDescriptors(replacement));
  } catch {
    return false;
  }
  if (freeze) ownImmutableSnapshot(target);
  return true;
}

function ownDataField(source, key) {
  if (!isObject(source)) return { valid: false, present: false, value: undefined };
  let descriptor;
  try { descriptor = Object.getOwnPropertyDescriptor(source, key); } catch {
    return { valid: false, present: false, value: undefined };
  }
  if (!descriptor) return { valid: true, present: false, value: undefined };
  if (!("value" in descriptor)) return { valid: false, present: true, value: undefined };
  return { valid: true, present: true, value: descriptor.value };
}

function inspectAssistantReadSessionCalls(message) {
  const role = ownDataField(message, "role");
  if (!role.valid) return SNAPSHOT_REJECTED;
  if (role.value !== "assistant") return [];
  const content = ownDataField(message, "content");
  if (!content.valid || !Array.isArray(content.value)) return SNAPSHOT_REJECTED;
  let lengthDescriptor;
  try { lengthDescriptor = Object.getOwnPropertyDescriptor(content.value, "length"); } catch {
    return SNAPSHOT_REJECTED;
  }
  const length = lengthDescriptor && "value" in lengthDescriptor ? lengthDescriptor.value : undefined;
  if (!isSafeInteger(length) || length < 0 || length > SNAPSHOT_MAX_ARRAY_LENGTH) return SNAPSHOT_REJECTED;
  const calls = [];
  for (let index = 0; index < length; index += 1) {
    let blockDescriptor;
    try { blockDescriptor = Object.getOwnPropertyDescriptor(content.value, String(index)); } catch {
      return SNAPSHOT_REJECTED;
    }
    if (!blockDescriptor) continue;
    if (!("value" in blockDescriptor) || !isObject(blockDescriptor.value)) return SNAPSHOT_REJECTED;
    const block = blockDescriptor.value;
    const type = ownDataField(block, "type");
    if (!type.valid) return SNAPSHOT_REJECTED;
    if (type.value !== "toolCall") continue;
    const name = ownDataField(block, "name");
    if (!name.valid) return SNAPSHOT_REJECTED;
    if (typeof name.value !== "string" || name.value.length > 64 || name.value.toLowerCase() !== "read_session") continue;
    const id = ownDataField(block, "id");
    if (!id.valid) return SNAPSHOT_REJECTED;
    calls.push({ block, index, identity: correlationIdentity(id.value) });
  }
  return calls;
}

function assistantFallbackMessage(message, calls) {
  const content = calls.map((call) => {
    const argumentsField = ownDataField(call.block, "arguments");
    const inputField = ownDataField(call.block, "input");
    const input = argumentsField.valid && isObject(argumentsField.value)
      ? argumentsField.value : (inputField.valid && isObject(inputField.value) ? inputField.value : {});
    return {
      type: "toolCall",
      id: call.identity.toolCallId,
      name: "read_session",
      arguments: boundedCallParams(input),
    };
  });
  const out = {
    role: "assistant",
    content,
    usage: {},
    stopReason: "toolUse",
    timestamp: 0,
  };
  for (const key of ["api", "provider", "model"]) {
    const field = ownDataField(message, key);
    const bounded = field.valid ? boundedString(field.value, 128) : undefined;
    if (bounded) out[key] = bounded.text;
  }
  const timestamp = ownDataField(message, "timestamp");
  if (timestamp.valid && typeof timestamp.value === "number" && Number.isFinite(timestamp.value)) {
    out.timestamp = timestamp.value;
  }
  return out;
}

function normalizeAssistantReadSessionCalls(message, runner, inspectedCalls) {
  const calls = inspectedCalls || inspectAssistantReadSessionCalls(message);
  if (calls === SNAPSHOT_REJECTED || calls.length === 0) return undefined;
  const dataReplacements = new WeakMap();
  for (const call of calls) dataReplacements.set(call.block, new Map([["id", call.identity.toolCallId]]));
  let snapshot = consumeSnapshot(message, { rejectAccessors: true, dataReplacements });
  const usedFallback = !isObject(snapshot);
  if (usedFallback) snapshot = assistantFallbackMessage(message, calls);
  for (let index = 0; index < calls.length; index += 1) {
    const call = calls[index];
    const blockIndex = usedFallback ? index : call.index;
    const block = Array.isArray(snapshot.content) ? snapshot.content[blockIndex] : undefined;
    if (!isObject(block)) continue;
    const input = isObject(block.arguments) ? block.arguments : (isObject(block.input) ? block.input : {});
    block.id = rememberReadSessionCall(runner, call.identity.toolCallId, input, call.identity);
  }
  return ownImmutableSnapshot(snapshot);
}

function toolResultMessageContext(runner, message) {
  const role = ownDataField(message, "role");
  const toolCallId = ownDataField(message, "toolCallId");
  const toolName = ownDataField(message, "toolName");
  if (!role.valid || !toolCallId.valid || !toolName.valid || role.value !== "toolResult") return undefined;
  return readSessionContext(runner, toolCallId.value, toolName.value);
}

function fallbackReadSessionResult(context) {
  const fallback = unrecognizedResult({}, context.params, Number.MAX_SAFE_INTEGER);
  return immutableSnapshot({
    content: fallback.content,
    details: fallback.details,
    isError: false,
  });
}

function canonicalReadSessionMessage(message, runner, forcedContext) {
  const snapshot = consumeSnapshot(message, { rejectAccessors: true });
  const context = forcedContext || (isObject(snapshot) ? toolResultMessageContext(runner, snapshot) : undefined);
  if (!context) return undefined;
  const safeMessage = isObject(snapshot) ? snapshot : {};
  const bounded = isObject(snapshot) ? boundFinalReadSessionEvent({
    type: "tool_result",
    toolCallId: context.toolCallId,
    toolName: "read_session",
    input: context.params,
    content: safeMessage.content,
    details: safeMessage.details,
    isError: safeMessage.isError === true,
  }, undefined, context) : fallbackReadSessionResult(context);
  const timestamp = typeof safeMessage.timestamp === "number" && Number.isFinite(safeMessage.timestamp)
    ? safeMessage.timestamp : 0;
  return immutableSnapshot({
    role: "toolResult",
    toolCallId: context.toolCallId,
    toolName: "read_session",
    content: bounded.content,
    details: bounded.details,
    isError: bounded.isError === true,
    timestamp,
  });
}

function replaceBoundarySlot(target, key, replacement, freeze) {
  if (!isObject(target)) return false;
  let descriptor;
  try { descriptor = Object.getOwnPropertyDescriptor(target, key); } catch { return false; }
  if (descriptor && "value" in descriptor && isObject(descriptor.value)
    && replaceObjectInPlace(descriptor.value, replacement, freeze)) return true;
  const next = descriptor
    ? { ...descriptor, value: replacement }
    : { value: replacement, writable: true, enumerable: true, configurable: true };
  delete next.get;
  delete next.set;
  try { return Reflect.defineProperty(target, key, next); } catch { return false; }
}

function replaceBoundaryScalar(target, key, replacement) {
  if (!isObject(target)) return false;
  let descriptor;
  try { descriptor = Object.getOwnPropertyDescriptor(target, key); } catch { return false; }
  const next = descriptor
    ? { ...descriptor, value: replacement }
    : { value: replacement, writable: true, enumerable: true, configurable: true };
  delete next.get;
  delete next.set;
  try { return Reflect.defineProperty(target, key, next); } catch { return false; }
}

function enforceResultTarget(event, context, safeFallback) {
  const snapshot = consumeSnapshot(event, { rejectAccessors: true });
  const bounded = isObject(snapshot) && isObject(snapshot.result)
    ? boundFinalReadSessionEvent({
      type: "tool_result",
      toolCallId: context.toolCallId,
      toolName: "read_session",
      input: context.params,
      isError: snapshot.isError === true,
    }, snapshot.result, context)
    : (safeFallback || fallbackReadSessionResult(context));
  replaceBoundarySlot(event, "result", bounded, true);
  replaceBoundaryScalar(event, "isError", bounded.isError === true);
  return bounded;
}

function installAgentSessionBoundary(imported) {
  const prototype = imported && imported.AgentSession && imported.AgentSession.prototype;
  if (!prototype || prototype[SHARED_AGENT_SESSION_BOUNDARY_MARKER] === true
    || typeof prototype._emitExtensionEvent !== "function") return;
  const originalEmitExtensionEvent = prototype._emitExtensionEvent;
  prototype._emitExtensionEvent = async function bobbitBoundAgentSessionEvent(event, ...args) {
    const runner = this._extensionRunner;
    const typeField = ownDataField(event, "type");
    const eventType = typeField.valid ? typeField.value : undefined;
    const toolCallId = ownDataField(event, "toolCallId");
    const toolName = ownDataField(event, "toolName");
    const messageField = ownDataField(event, "message");
    const toolEndContext = eventType === "tool_execution_end" && toolCallId.valid && toolName.valid
      ? readSessionContext(runner, toolCallId.value, toolName.value) : undefined;
    const messageContext = eventType === "message_end" && messageField.valid
      ? toolResultMessageContext(runner, messageField.value) : undefined;
    const assistantCalls = eventType === "message_end" && messageField.valid
      ? inspectAssistantReadSessionCalls(messageField.value) : [];
    const safeToolFallback = toolEndContext ? enforceResultTarget(event, toolEndContext) : undefined;
    const safeMessageFallback = messageContext
      ? canonicalReadSessionMessage(messageField.value, runner, messageContext)
      : (assistantCalls !== SNAPSHOT_REJECTED && assistantCalls.length > 0
        ? normalizeAssistantReadSessionCalls(messageField.value, runner, assistantCalls) : undefined);
    await originalEmitExtensionEvent.call(this, event, ...args);

    if (toolEndContext) enforceResultTarget(event, toolEndContext, safeToolFallback);
    if (eventType === "message_end" && safeMessageFallback) {
      const postEvent = consumeSnapshot(event, { rejectAccessors: true });
      const postMessage = isObject(postEvent) ? postEvent.message : undefined;
      const canonical = messageContext
        ? canonicalReadSessionMessage(postMessage, runner, messageContext)
        : normalizeAssistantReadSessionCalls(postMessage, runner);
      replaceBoundarySlot(event, "message", canonical || safeMessageFallback, true);
    }
    if (eventType === "agent_end") callMap(runner)?.clear();
  };
  Object.defineProperty(prototype, SHARED_AGENT_SESSION_BOUNDARY_MARKER, { value: true });
}

async function installSharedRunnerBoundary() {
  try {
    const imported = await import("@earendil-works/pi-coding-agent");
    const prototype = imported && imported.ExtensionRunner && imported.ExtensionRunner.prototype;
    if (!prototype) return;
    installAgentSessionBoundary(imported);
    if (prototype[SHARED_RUNNER_BOUNDARY_MARKER] === true
      || typeof prototype.getAllRegisteredTools !== "function"
      || typeof prototype.emitToolResult !== "function"
      || typeof prototype.emitMessageEnd !== "function"
      || typeof prototype.emit !== "function") return;
    const originalGetAllRegisteredTools = prototype.getAllRegisteredTools;
    const originalEmitToolResult = prototype.emitToolResult;
    const originalEmitMessageEnd = prototype.emitMessageEnd;
    const originalEmit = prototype.emit;
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
      const context = readSessionContext(this, event?.toolCallId, event?.toolName, event?.input);
      const transformed = await originalEmitToolResult.call(this, event, ...args);
      return context ? boundFinalReadSessionEvent(event, transformed, context) : transformed;
    };
    prototype.emit = async function bobbitBoundLaterExtensionEvent(event, ...args) {
      const type = ownDataField(event, "type");
      const toolCallId = ownDataField(event, "toolCallId");
      const toolName = ownDataField(event, "toolName");
      const context = type.valid && type.value === "tool_execution_end" && toolCallId.valid && toolName.valid
        ? readSessionContext(this, toolCallId.value, toolName.value) : undefined;
      const safeFallback = context ? enforceResultTarget(event, context) : undefined;
      const result = await originalEmit.call(this, event, ...args);
      if (context) {
        enforceResultTarget(event, context, safeFallback);
        const resultSnapshot = consumeSnapshot(result, { rejectAccessors: true });
        return resultSnapshot === SNAPSHOT_OMITTED || resultSnapshot === SNAPSHOT_REJECTED
          ? undefined : ownImmutableSnapshot(resultSnapshot);
      }
      return result;
    };
    prototype.emitMessageEnd = async function bobbitBoundFinalMessageEnd(event, ...args) {
      const message = ownDataField(event, "message");
      const resultContext = message.valid ? toolResultMessageContext(this, message.value) : undefined;
      const assistantCalls = message.valid ? inspectAssistantReadSessionCalls(message.value) : SNAPSHOT_REJECTED;
      const hasAssistantCall = assistantCalls !== SNAPSHOT_REJECTED && assistantCalls.length > 0;
      if (!resultContext && !hasAssistantCall) return originalEmitMessageEnd.call(this, event, ...args);
      const working = resultContext
        ? canonicalReadSessionMessage(message.value, this, resultContext)
        : normalizeAssistantReadSessionCalls(message.value, this, assistantCalls);
      if (!working) {
        return resultContext ? canonicalReadSessionMessage({}, this, resultContext) : undefined;
      }
      const transformed = await originalEmitMessageEnd.call(this, { type: "message_end", message: working }, ...args);
      if (resultContext) {
        const transformedSnapshot = consumeSnapshot(transformed, { rejectAccessors: true });
        return canonicalReadSessionMessage(isObject(transformedSnapshot) ? transformedSnapshot : working, this, resultContext);
      }
      const transformedCalls = inspectAssistantReadSessionCalls(transformed);
      if (transformedCalls !== SNAPSHOT_REJECTED && transformedCalls.length > 0) {
        return normalizeAssistantReadSessionCalls(transformed, this, transformedCalls);
      }
      return normalizeAssistantReadSessionCalls(working, this);
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
