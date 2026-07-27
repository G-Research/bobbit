import { createHash } from "node:crypto";

const RESULT_BODY_KEYS = ["content", "output", "result"] as const;
const OPAQUE_BLOCK_TYPES = new Set(["image", "audio", "video", "file", "attachment", "binary"]);

export type CanonicalResultOuterType = "string" | "array" | "object" | "null" | "missing" | "other";

export class CanonicalTranscriptValueError extends Error {
	readonly code = "INVALID_RESULT_BODY" as const;

	constructor(message: string) {
		super(message);
		this.name = "CanonicalTranscriptValueError";
	}
}

function invalid(message: string): never {
	throw new CanonicalTranscriptValueError(message);
}

export function isWellFormedUnicode(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const unit = value.charCodeAt(index);
		if (unit >= 0xd800 && unit <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
			index++;
		} else if (unit >= 0xdc00 && unit <= 0xdfff) {
			return false;
		}
	}
	return true;
}

export function requireWellFormedUnicode(value: string, label = "string"): string {
	if (!isWellFormedUnicode(value)) invalid(`${label} contains an unpaired UTF-16 surrogate`);
	return value;
}

export function scalarSafePrefix(value: string, limit: number): string {
	if (value.length <= limit) return value;
	let end = Math.max(0, limit);
	if (end > 0 && end < value.length) {
		const previous = value.charCodeAt(end - 1);
		const next = value.charCodeAt(end);
		if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
	}
	return value.slice(0, end);
}

function stableJsonInner(value: unknown, ancestors: Set<object>): string {
	if (value === null) return "null";
	switch (typeof value) {
		case "string":
			requireWellFormedUnicode(value);
			return JSON.stringify(value);
		case "boolean":
			return value ? "true" : "false";
		case "number":
			if (!Number.isFinite(value)) invalid("non-finite number is not valid transcript JSON");
			return JSON.stringify(value);
		case "undefined":
		case "function":
		case "symbol":
		case "bigint":
			return invalid(`unsupported transcript JSON value: ${typeof value}`);
		case "object":
			break;
		default:
			return invalid("unsupported transcript JSON value");
	}

	const object = value as object;
	if (ancestors.has(object)) invalid("cyclic transcript JSON value");
	ancestors.add(object);
	try {
		if (Array.isArray(value)) {
			const parts: string[] = [];
			for (let index = 0; index < value.length; index++) {
				if (!Object.prototype.hasOwnProperty.call(value, index)) invalid("sparse transcript JSON array");
				parts.push(stableJsonInner(value[index], ancestors));
			}
			return `[${parts.join(",")}]`;
		}

		const source = value as Record<string, unknown>;
		const keys = Object.keys(source).sort();
		return `{${keys.map((key) => {
			requireWellFormedUnicode(key, "object key");
			return `${JSON.stringify(key)}:${stableJsonInner(source[key], ancestors)}`;
		}).join(",")}}`;
	} finally {
		ancestors.delete(object);
	}
}

/** Deterministic JSON encoding that does not reorder integer-like object keys. */
export function stableTranscriptJson(value: unknown): string {
	return stableJsonInner(value, new Set<object>());
}

function firstOwnDefined(source: Record<string, unknown>, keys: readonly string[]): {
	found: boolean;
	value: unknown;
	key?: string;
} {
	for (const key of keys) {
		if (Object.prototype.hasOwnProperty.call(source, key) && source[key] !== undefined) {
			return { found: true, value: source[key], key };
		}
	}
	return { found: false, value: undefined };
}

function opaqueSummary(block: Record<string, unknown>, type: string): string {
	const payload = firstOwnDefined(block, ["data", "base64", "bytes", "content"]);
	let representation = "";
	if (payload.found) {
		representation = typeof payload.value === "string"
			? requireWellFormedUnicode(payload.value, "opaque result payload")
			: stableTranscriptJson(payload.value);
	}
	const digest = createHash("sha256").update(representation, "utf8").digest("hex");
	const summary: Record<string, unknown> = {
		type,
		encodedChars: representation.length,
		digest: `sha256:${digest}`,
		omitted: true,
	};
	if (Object.prototype.hasOwnProperty.call(block, "mimeType") && typeof block.mimeType === "string"
		&& isWellFormedUnicode(block.mimeType)) {
		summary.mimeType = scalarSafePrefix(block.mimeType, 128);
	}
	return stableTranscriptJson(summary);
}

function appendCanonicalLeaves(value: unknown, leaves: string[]): void {
	if (value === null) return;
	if (typeof value === "string") {
		leaves.push(requireWellFormedUnicode(value, "tool result text"));
		return;
	}
	if (Array.isArray(value)) {
		for (let index = 0; index < value.length; index++) {
			if (!Object.prototype.hasOwnProperty.call(value, index)) invalid("sparse tool result array");
			appendCanonicalLeaves(value[index], leaves);
		}
		return;
	}
	if (typeof value !== "object") {
		leaves.push(stableTranscriptJson(value));
		return;
	}

	const block = value as Record<string, unknown>;
	if (block.type === "text" && typeof block.text === "string") {
		leaves.push(requireWellFormedUnicode(block.text, "tool result text block"));
		return;
	}
	if (typeof block.type === "string" && OPAQUE_BLOCK_TYPES.has(block.type)) {
		leaves.push(opaqueSummary(block, block.type));
		return;
	}
	const carrier = firstOwnDefined(block, RESULT_BODY_KEYS);
	if (carrier.found) {
		appendCanonicalLeaves(carrier.value, leaves);
		return;
	}
	leaves.push(stableTranscriptJson(block));
}

export interface CanonicalToolResultBody {
	text: string;
	type: CanonicalResultOuterType;
	blocks?: number;
	bodyKey?: typeof RESULT_BODY_KEYS[number];
}

function outerType(value: unknown, found: boolean): CanonicalResultOuterType {
	if (!found) return "missing";
	if (value === null) return "null";
	if (typeof value === "string") return "string";
	if (Array.isArray(value)) return "array";
	if (typeof value === "object") return "object";
	return "other";
}

/**
 * Select and flatten a tool result exactly once. Metrics, search, digests, and
 * excerpts must all consume the returned `text` rather than re-traversing raw
 * provider blocks.
 */
export function canonicalToolResultBody(result: Record<string, unknown>): CanonicalToolResultBody {
	const selected = firstOwnDefined(result, RESULT_BODY_KEYS);
	const leaves: string[] = [];
	if (selected.found) appendCanonicalLeaves(selected.value, leaves);
	const text = requireWellFormedUnicode(leaves.join(""), "canonical tool result body");
	const type = outerType(selected.value, selected.found);
	return {
		text,
		type,
		...(type === "array" ? { blocks: (selected.value as unknown[]).length } : {}),
		...(selected.key ? { bodyKey: selected.key as typeof RESULT_BODY_KEYS[number] } : {}),
	};
}

function validSemanticString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && isWellFormedUnicode(value);
}

export function canonicalToolCallName(call: Record<string, unknown>): string {
	for (const key of ["name", "toolName"] as const) {
		if (Object.prototype.hasOwnProperty.call(call, key) && validSemanticString(call[key])) return call[key];
	}
	return "unknown";
}

export interface CanonicalToolCallArguments {
	present: boolean;
	text: string;
}

export function canonicalToolCallArguments(call: Record<string, unknown>): CanonicalToolCallArguments {
	const selected = firstOwnDefined(call, ["arguments", "input"]);
	if (!selected.found) return { present: false, text: "" };
	if (typeof selected.value === "string") {
		return { present: true, text: requireWellFormedUnicode(selected.value, "tool call arguments") };
	}
	return { present: true, text: stableTranscriptJson(selected.value) };
}
