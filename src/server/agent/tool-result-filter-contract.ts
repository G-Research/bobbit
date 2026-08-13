import { randomUUID } from "node:crypto";
import { isSafeExtensionGrantIdentifier } from "./project-config-store.js";

/** The only hook event that may inspect a completed tool result before fan-out. */
export type ToolResultFilterEvent = "afterToolResult";
export type ToolResultFilterAction = "pass" | "replace" | "redact" | "reject";
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export interface SafeUsage {
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	cost?: number;
}

export type SafeToolResultContent =
	| { readonly type: "text"; readonly text: string }
	| { readonly type: "image"; readonly mediaType: "image/png" | "image/jpeg" | "image/webp"; readonly data: string };

export interface CanonicalToolResult {
	content: readonly SafeToolResultContent[];
	details?: JsonValue;
	isError: boolean;
	usage?: SafeUsage;
}

export interface ToolResultInspection {
	event: ToolResultFilterEvent;
	sessionId: string;
	projectId: string;
	toolCallId: string;
	toolName: string;
	result: Readonly<CanonicalToolResult>;
}

export interface ToolResultReplacement {
	content: readonly SafeToolResultContent[];
	isError?: boolean;
}

export interface ToolResultFilterProposal {
	kind: "tool-result-filter";
	version: 1;
	action: ToolResultFilterAction;
	ruleId: string;
	reasonCode: string;
	replacement?: ToolResultReplacement;
}

export interface ToolResultFilterSource {
	packId: string;
	hookId: string;
	priority: number;
}

export interface ToolResultFilterCandidate {
	source: ToolResultFilterSource;
	proposal: ToolResultFilterProposal;
}

export interface ToolResultFilterReduction {
	action: ToolResultFilterAction;
	source?: ToolResultFilterSource;
	proposal?: ToolResultFilterProposal;
}

export const MAX_TOOL_RESULT_INPUT_BYTES = 256 * 1024;
export const MAX_TOOL_RESULT_TEXT_BYTES = 64 * 1024;
export const MAX_TOOL_RESULT_IMAGE_BYTES = 128 * 1024;
export const MAX_TOOL_RESULT_BLOCKS = 32;
export const MAX_TOOL_RESULT_DETAILS_BYTES = 16 * 1024;
export const MAX_TOOL_RESULT_REPLACEMENT_BYTES = 64 * 1024;
export const MAX_TOOL_RESULT_FILTER_HOOKS = 16;
export const MAX_TOOL_RESULT_IDENTIFIER_BYTES = 128;
export const MAX_TOOL_RESULT_JSON_DEPTH = 8;
export const MAX_TOOL_RESULT_JSON_PROPERTIES = 64;
export const MAX_TOOL_RESULT_JSON_ARRAY_LENGTH = 64;

const FILTER_IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RESULT_KEYS = new Set(["content", "details", "isError", "usage"]);
const INSPECTION_KEYS = new Set(["event", "sessionId", "projectId", "toolCallId", "toolName", "result"]);
const TEXT_CONTENT_KEYS = new Set(["type", "text"]);
const IMAGE_CONTENT_KEYS = new Set(["type", "mediaType", "data"]);
const USAGE_KEYS = new Set(["inputTokens", "outputTokens", "totalTokens", "cacheReadTokens", "cacheWriteTokens", "cost"]);
const PROPOSAL_KEYS = new Set(["kind", "version", "action", "ruleId", "reasonCode", "replacement"]);
const REPLACEMENT_KEYS = new Set(["content", "isError"]);
const IMAGE_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const ACTIONS = new Set<ToolResultFilterAction>(["pass", "replace", "redact", "reject"]);

export class ToolResultFilterContractError extends Error {
	constructor(public readonly code: string) {
		super(code);
		this.name = "ToolResultFilterContractError";
	}
}

function fail(code: string): never { throw new ToolResultFilterContractError(code); }
function isRecord(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}
function record(value: unknown, code: string): Record<string, unknown> {
	if (!isRecord(value)) fail(code);
	return value;
}
function onlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, code: string): void {
	for (const key of Object.keys(value)) if (!allowed.has(key)) fail(code);
}
function isWellFormedText(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const unit = value.charCodeAt(index);
		if (unit >= 0xd800 && unit <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
			index++;
		} else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
	}
	return true;
}
function unsafeText(value: string): boolean {
	return !isWellFormedText(value)
		|| /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)
		|| /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/i.test(value);
}
function text(value: unknown, maxBytes: number, code: string): string {
	if (typeof value !== "string" || value.length === 0 || unsafeText(value) || Buffer.byteLength(value, "utf8") > maxBytes) fail(code);
	return value;
}
function identifier(value: unknown, code: string): string {
	const result = text(value, MAX_TOOL_RESULT_IDENTIFIER_BYTES, code);
	if (!FILTER_IDENTIFIER_RE.test(result)) fail(code);
	return result;
}
function serializedBytes(value: unknown): number {
	try { return Buffer.byteLength(JSON.stringify(value), "utf8"); } catch { return Number.POSITIVE_INFINITY; }
}
function base64(value: unknown, code: string): string {
	if (typeof value !== "string" || value.length === 0 || unsafeText(value) || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) fail(code);
	const decoded = Buffer.from(value, "base64");
	if (decoded.length === 0 || decoded.length > MAX_TOOL_RESULT_IMAGE_BYTES || decoded.toString("base64") !== value) fail(code);
	return value;
}
function freezeContent(value: SafeToolResultContent): SafeToolResultContent { return Object.freeze(value); }

function validateContent(raw: unknown, maxTotalBytes: number, code: string): readonly SafeToolResultContent[] {
	if (!Array.isArray(raw) || raw.length > MAX_TOOL_RESULT_BLOCKS) fail(code);
	const content: SafeToolResultContent[] = raw.map(blockRaw => {
		const block = record(blockRaw, code);
		if (block.type === "text") {
			onlyKeys(block, TEXT_CONTENT_KEYS, code);
			if (typeof block.text !== "string" || unsafeText(block.text) || Buffer.byteLength(block.text, "utf8") > MAX_TOOL_RESULT_TEXT_BYTES) fail(code);
			return freezeContent({ type: "text", text: block.text });
		}
		if (block.type === "image") {
			onlyKeys(block, IMAGE_CONTENT_KEYS, code);
			if (typeof block.mediaType !== "string" || !IMAGE_MEDIA_TYPES.has(block.mediaType)) fail(code);
			return freezeContent({ type: "image", mediaType: block.mediaType as "image/png" | "image/jpeg" | "image/webp", data: base64(block.data, code) });
		}
		fail(code);
	});
	if (serializedBytes(content) > maxTotalBytes) fail(code);
	return Object.freeze(content);
}

function validateJson(value: unknown, depth = 0): JsonValue {
	if (depth > MAX_TOOL_RESULT_JSON_DEPTH || value === undefined || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") fail("INVALID_DETAILS");
	if (value === null || typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) fail("INVALID_DETAILS");
		return value;
	}
	// JSON details are structured data, not an identifier or result message: an
	// empty string is a valid JSON leaf. Keep every other text safety bound.
	if (typeof value === "string") {
		if (unsafeText(value) || Buffer.byteLength(value, "utf8") > MAX_TOOL_RESULT_DETAILS_BYTES) fail("INVALID_DETAILS");
		return value;
	}
	if (Array.isArray(value)) {
		if (value.length > MAX_TOOL_RESULT_JSON_ARRAY_LENGTH) fail("INVALID_DETAILS");
		return Object.freeze(value.map(entry => validateJson(entry, depth + 1)));
	}
	const object = record(value, "INVALID_DETAILS");
	const entries = Object.entries(object);
	if (entries.length > MAX_TOOL_RESULT_JSON_PROPERTIES) fail("INVALID_DETAILS");
	const output: Record<string, JsonValue> = {};
	for (const [key, entry] of entries) {
		if (key.length === 0 || key === "__proto__" || key === "constructor" || key === "prototype" || unsafeText(key)) fail("INVALID_DETAILS");
		output[key] = validateJson(entry, depth + 1);
	}
	return Object.freeze(output);
}

function validateUsage(raw: unknown): SafeUsage {
	const usage = record(raw, "INVALID_USAGE");
	onlyKeys(usage, USAGE_KEYS, "INVALID_USAGE");
	const output: SafeUsage = {};
	for (const key of USAGE_KEYS) {
		const value = usage[key];
		if (value === undefined) continue;
		if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (key !== "cost" && !Number.isSafeInteger(value))) fail("INVALID_USAGE");
		(output as Record<string, number>)[key] = value;
	}
	if (Object.keys(output).length === 0) fail("INVALID_USAGE");
	return Object.freeze(output);
}

/** Strict normal form accepted by the pre-fan-out gate and never by a hook return. */
export function validateCanonicalToolResult(raw: unknown): CanonicalToolResult {
	const result = record(raw, "INVALID_TOOL_RESULT");
	onlyKeys(result, RESULT_KEYS, "INVALID_TOOL_RESULT");
	if (typeof result.isError !== "boolean") fail("INVALID_TOOL_RESULT");
	const content = validateContent(result.content, MAX_TOOL_RESULT_INPUT_BYTES, "INVALID_TOOL_RESULT");
	const details = result.details === undefined ? undefined : validateJson(result.details);
	if (details !== undefined && serializedBytes(details) > MAX_TOOL_RESULT_DETAILS_BYTES) fail("INVALID_DETAILS");
	const usage = result.usage === undefined ? undefined : validateUsage(result.usage);
	const output: CanonicalToolResult = Object.freeze({ content, ...(details === undefined ? {} : { details }), isError: result.isError, ...(usage === undefined ? {} : { usage }) });
	if (serializedBytes(output) > MAX_TOOL_RESULT_INPUT_BYTES) fail("TOOL_RESULT_TOO_LARGE");
	return output;
}

export function validateToolResultInspection(raw: unknown): ToolResultInspection {
	const inspection = record(raw, "INVALID_INSPECTION");
	onlyKeys(inspection, INSPECTION_KEYS, "INVALID_INSPECTION");
	if (inspection.event !== "afterToolResult") fail("INVALID_INSPECTION");
	return Object.freeze({
		event: "afterToolResult",
		sessionId: identifier(inspection.sessionId, "INVALID_INSPECTION"),
		projectId: identifier(inspection.projectId, "INVALID_INSPECTION"),
		toolCallId: identifier(inspection.toolCallId, "INVALID_INSPECTION"),
		toolName: identifier(inspection.toolName, "INVALID_INSPECTION"),
		result: validateCanonicalToolResult(inspection.result),
	});
}

function validateReplacement(raw: unknown): ToolResultReplacement {
	const replacement = record(raw, "INVALID_REPLACEMENT");
	onlyKeys(replacement, REPLACEMENT_KEYS, "INVALID_REPLACEMENT");
	const content = validateContent(replacement.content, MAX_TOOL_RESULT_REPLACEMENT_BYTES, "INVALID_REPLACEMENT");
	if (replacement.isError !== undefined && typeof replacement.isError !== "boolean") fail("INVALID_REPLACEMENT");
	const output: ToolResultReplacement = Object.freeze({ content, ...(replacement.isError === undefined ? {} : { isError: replacement.isError }) });
	if (serializedBytes(output) > MAX_TOOL_RESULT_REPLACEMENT_BYTES) fail("REPLACEMENT_TOO_LARGE");
	return output;
}

/** Validate one complete, closed proposal returned by a filter worker. */
export function validateToolResultFilterProposal(raw: unknown): ToolResultFilterProposal {
	if (serializedBytes(raw) > MAX_TOOL_RESULT_REPLACEMENT_BYTES + 1024) fail("PROPOSAL_TOO_LARGE");
	const proposal = record(raw, "INVALID_PROPOSAL");
	onlyKeys(proposal, PROPOSAL_KEYS, "UNKNOWN_PROPOSAL_FIELD");
	if (proposal.kind !== "tool-result-filter" || proposal.version !== 1 || typeof proposal.action !== "string" || !ACTIONS.has(proposal.action as ToolResultFilterAction)) fail("INVALID_PROPOSAL");
	const action = proposal.action as ToolResultFilterAction;
	const ruleId = identifier(proposal.ruleId, "INVALID_PROPOSAL");
	const reasonCode = identifier(proposal.reasonCode, "INVALID_PROPOSAL");
	if (ruleId === reasonCode) fail("INVALID_PROPOSAL");
	const hasReplacement = Object.hasOwn(proposal, "replacement");
	if ((action === "replace" || action === "redact") !== hasReplacement) fail("INVALID_PROPOSAL");
	const replacement = hasReplacement ? validateReplacement(proposal.replacement) : undefined;
	return Object.freeze({ kind: "tool-result-filter", version: 1, action, ruleId, reasonCode, ...(replacement === undefined ? {} : { replacement }) });
}

function validSource(raw: unknown): raw is ToolResultFilterSource {
	return isRecord(raw) && isSafeExtensionGrantIdentifier(raw.packId) && isSafeExtensionGrantIdentifier(raw.hookId)
		&& typeof raw.priority === "number" && Number.isFinite(raw.priority);
}
function sourceKey(source: ToolResultFilterSource): string { return `extension:${source.packId}:${source.hookId}`; }
function compareCodeUnits(a: string, b: string): number {
	return a === b ? 0 : a < b ? -1 : 1;
}
function compareSource(a: ToolResultFilterSource, b: ToolResultFilterSource): number {
	return b.priority - a.priority || compareCodeUnits(sourceKey(a), sourceKey(b));
}
function severity(action: ToolResultFilterAction): number {
	return action === "reject" ? 3 : action === "redact" ? 2 : action === "replace" ? 1 : 0;
}

/** Reject wins; priority and stable core-generated identity select attribution within a severity. */
export function reduceToolResultFilters(candidates: readonly ToolResultFilterCandidate[]): ToolResultFilterReduction {
	const valid = candidates.filter((candidate): candidate is ToolResultFilterCandidate => {
		if (!candidate || !validSource(candidate.source)) return false;
		try { validateToolResultFilterProposal(candidate.proposal); return true; } catch { return false; }
	});
	const winner = [...valid].sort((a, b) => severity(b.proposal.action) - severity(a.proposal.action) || compareSource(a.source, b.source))[0];
	if (!winner) return Object.freeze({ action: "pass" as const });
	return Object.freeze({ action: winner.proposal.action, source: Object.freeze({ ...winner.source }), proposal: winner.proposal });
}

/** Return only core-selected bytes. Replace/redact deliberately drop details and usage. */
export function applyToolResultFilterReduction(original: CanonicalToolResult, reduction: ToolResultFilterReduction, referenceId?: string): CanonicalToolResult {
	const input = validateCanonicalToolResult(original);
	if (reduction.action === "pass") return input;
	if (reduction.action === "reject") return createSyntheticRejectedToolResult(referenceId);
	const replacement = reduction.proposal?.replacement;
	if (!replacement) return createSyntheticRejectedToolResult(referenceId);
	return Object.freeze({ content: replacement.content, isError: replacement.isError ?? input.isError });
}

/** Fixed core-owned output for every reject/fail-closed path. */
export function createSyntheticRejectedToolResult(referenceId: string = randomUUID()): CanonicalToolResult {
	const reference = identifier(referenceId, "INVALID_REFERENCE_ID");
	return Object.freeze({
		content: Object.freeze([Object.freeze({ type: "text" as const, text: `Tool result withheld by project result policy [ref: ${reference}].` })]),
		isError: true,
	});
}
